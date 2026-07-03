import fs from 'fs';
import { config, URLS, STORAGE_STATE } from './config.js';
import { notify, escapeHtml } from './notify.js';

/**
 * Stratégie (déduite du HAR réel) :
 *
 *   Un seul POST `action=modifier_date_arrivee` vers cesal_mon_logement_reservation.php
 *   renvoie une page dont le <script> contient, en clair, le statut de chaque
 *   noeud (résidence / bâtiment / aile / niveau) sous la forme :
 *       $("#residence_1_logements_disponibles").html("Aucun logement disponible")
 *       $("#residence_1_logements_disponibles").html("3 logements disponibles")  <- DISPO !
 *
 *   On n'a donc PAS besoin d'un navigateur pour surveiller : un simple fetch
 *   avec le cookie de session suffit. Playwright ne sert qu'au login (capture
 *   du cookie une fois, captcha résolu à la main) et à la réservation finale.
 */

const LABELS = {
  residence_1: 'Résidence I',
  residence_2: 'Résidence II',
  residence_3: 'Résidence III',
  residence_4: 'Résidence IV',
  residence_5: 'Résidence Joliot-Curie',
  residence_6: 'Résidence Le Mail',
};

/** Lit le cookie de session capturé par Playwright (config/session.json). */
function loadCookieHeader() {
  if (!fs.existsSync(STORAGE_STATE)) return null;
  const state = JSON.parse(fs.readFileSync(STORAGE_STATE, 'utf8'));
  const cookies = (state.cookies || []).filter((c) =>
    c.domain.includes('cesal.fr')
  );
  if (!cookies.length) return null;
  return cookies.map((c) => `${c.name}=${c.value}`).join('; ');
}

/**
 * Construit le corps du POST. On envoie date_arrivee + date_sortie ; les autres
 * champs `est_avec_debut_bail...` / `avec_heure_arrivee...` sont optionnels pour
 * la simple consultation, mais on peut les ajouter si besoin (cf. dates connues).
 */
function buildBody({ dateArrivee, dateSortie }) {
  const p = new URLSearchParams();
  p.set('action', 'modifier_date_arrivee');
  if (dateArrivee) p.set('date_arrivee', dateArrivee); // format YYYY-MM-DD
  p.set('date_sortie', dateSortie); // format dd/mm/yyyy
  return p.toString();
}

/** Extrait toutes les dates d'arrivée (YYYY-MM-DD) du <select date_arrivee>. */
export function parseArrivalDates(html) {
  const sel = html.match(/<select[^>]*id="date_arrivee"[^>]*>([\s\S]*?)<\/select>/i);
  if (!sel) return [];
  return [...sel[1].matchAll(/value="(\d{4}-\d{2}-\d{2})"/g)].map((m) => m[1]);
}

/** Parse tous les statuts depuis le JS inline de la réponse. */
export function parseAvailability(html) {
  const re =
    /\$\("#([a-z0-9_]+)_logements_disponibles"\)\.html\("([^"]*)"\)/g;
  const nodes = {};
  let m;
  while ((m = re.exec(html))) {
    const id = m[1];
    const text = m[2].trim();
    const available = !/aucun logement/i.test(text);
    nodes[id] = { text, available };
  }
  return nodes;
}

/** Renvoie la liste des résidences disponibles (niveau top). */
function availableResidences(nodes) {
  return Object.entries(nodes)
    .filter(([id, v]) => /^residence_\d+$/.test(id) && v.available)
    .map(([id, v]) => ({ id, label: LABELS[id] || id, text: v.text }));
}

/**
 * Construit le texte de notification hiérarchisé :
 *   🟢 Résidence I — 3 logements disponibles
 *      ↳ Aile A — 2 logements disponibles
 *         ↳ Niveau R+1 — 2 logements disponibles
 */
function buildDispoMessage(dispoResidences, nodes) {
  const lines = [];
  for (const res of dispoResidences) {
    lines.push(`🟢 <b>${res.label}</b> — ${res.text}`);
    const resNum = res.id.replace('residence_', '');

    // Ailes (batiment_N_L)
    const ailes = Object.entries(nodes)
      .filter(([id, v]) => v.available && new RegExp(`^batiment_${resNum}_[A-Z]$`).test(id));

    for (const [aileId, aileV] of ailes) {
      const aileNum = aileId.split('_')[2];
      lines.push(`   ↳ <b>Aile ${aileNum}</b> — ${aileV.text}`);

      // Cages (cage_N_L_M)
      const cages = Object.entries(nodes)
        .filter(([id, v]) => v.available && id.startsWith(`cage_${resNum}_${aileNum}_`));

      for (const [cageId] of cages) {
        const cageIdx = cageId.split('_')[3];

        // Niveaux (niveau_N_L_M_K)
        const niveaux = Object.entries(nodes)
          .filter(([id, v]) => v.available && id.startsWith(`niveau_${resNum}_${aileNum}_${cageIdx}_`));

        for (const [nivId, nivV] of niveaux) {
          const nivNum = nivId.split('_')[4];
          lines.push(`      ↳ <b>Niveau R+${nivNum}</b> — ${nivV.text}`);
        }
      }
    }
  }
  return lines.join('\n');
}

async function fetchReservationPage(cookieHeader, dateArrivee) {
  const body = buildBody({
    dateArrivee: dateArrivee || '',
    dateSortie: config.dateSortie,
  });
  const res = await fetch(URLS.reservation, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      origin: 'https://logement.cesal.fr',
      referer: URLS.reservation,
      'user-agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36',
      cookie: cookieHeader,
    },
    body,
  });
  return res;
}

export async function checkOnce() {
  const cookieHeader = loadCookieHeader();
  if (!cookieHeader) {
    await notify(
      '⚠️ Pas de session CESAL. Lance <code>npm run login</code> pour te connecter une fois (résous le captcha).'
    );
    return { error: 'NO_SESSION' };
  }

  let res;
  try {
    // 1er appel sans date imposée : on lit la liste à jour.
    res = await fetchReservationPage(cookieHeader, '');
  } catch (err) {
    console.error('[check] Erreur réseau:', err.message);
    return { error: err.message };
  }

  // Redirection vers le login => session expirée.
  if (res.status >= 300 && res.status < 400) {
    const loc = res.headers.get('location') || '';
    if (/login/i.test(loc)) {
      await notify('🔐 Session CESAL expirée. Relance <code>npm run login</code>.');
      return { error: 'SESSION_EXPIRED' };
    }
  }

  let html = await res.text();

  // Page de login renvoyée directement (autre forme d'expiration).
  if (/g-recaptcha|name="login-email"/.test(html) && !/id="residences"/.test(html)) {
    await notify('🔐 Session CESAL expirée. Relance <code>npm run login</code>.');
    return { error: 'SESSION_EXPIRED' };
  }

  // On scanne sur la DERNIÈRE date d'arrivée disponible (comportement choisi).
  // Si la réponse n'est pas déjà sur cette date, on refait l'appel avec elle.
  const dates = parseArrivalDates(html);
  const lastDate = dates[dates.length - 1];
  if (lastDate) {
    const selected = (html.match(/<option value="(\d{4}-\d{2}-\d{2})"\s+selected/) || [])[1];
    if (selected !== lastDate) {
      try {
        const res2 = await fetchReservationPage(cookieHeader, lastDate);
        html = await res2.text();
      } catch (err) {
        console.warn('[check] Re-scan avec dernière date échoué, on garde le 1er résultat:', err.message);
      }
    }
    console.log(`[check] Date d'arrivée scannée : ${lastDate}`);
  }

  const nodes = parseAvailability(html);
  if (Object.keys(nodes).length === 0) {
    console.warn('[check] Aucun statut parsé — la structure a peut-être changé. HTML dump.');
    fs.writeFileSync(
      new URL('../config/last_response.html', import.meta.url).pathname,
      html
    );
    return { error: 'NO_NODES' };
  }

  const dispoResidences = availableResidences(nodes);

  if (dispoResidences.length > 0) {
    await notify(
      `🏠 <b>LOGEMENT DISPONIBLE CHEZ CESAL !</b>\n\n` +
      buildDispoMessage(dispoResidences, nodes) +
      `\n\n🤖 Le bot tente la réservation auto (screenshots à suivre).` +
      `\n⚡ <b>EN BACKUP, réserve TOI AUSSI à la main tout de suite :</b>` +
      `\n🔗 ${URLS.reservation}`
    );
    if (config.mode === 'reserve') {
      await notify('🤖 Mode reserve activé — lancement de la réservation auto…');
      // La réservation (Playwright) est protégée par un TIMEOUT GLOBAL DUR : si
      // elle se bloque (ex. Chromium qui gèle), on abandonne au bout de 3 min et
      // on RENDS LA MAIN à la surveillance — elle ne doit jamais mourir en silence.
      const RESERVE_TIMEOUT_MS = 3 * 60_000;
      try {
        const { reserve } = await import('./reserve.js');
        await Promise.race([
          reserve(dispoResidences, nodes),
          new Promise((_, rej) =>
            setTimeout(() => rej(new Error('RESERVE_TIMEOUT (>3min, abandon)')), RESERVE_TIMEOUT_MS)
          ),
        ]);
      } catch (err) {
        await notify(
          `⚠️ Réservation auto échouée : <code>${escapeHtml(err.message)}</code>\n` +
          `👉 Réserve VITE à la main : ${URLS.reservation}`
        );
      }
    }
    return { available: true, nodes };
  }

  console.log(`[check] ${new Date().toLocaleTimeString()} — aucune dispo (${Object.keys(nodes).length} noeuds vérifiés).`);
  return { available: false, nodes };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  checkOnce().then((r) => process.exit(r?.error ? 1 : 0));
}
