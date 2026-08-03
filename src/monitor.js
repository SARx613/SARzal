import fs from 'fs';
import { config, URLS, STORAGE_STATE, RESIDENCE_LABELS, residenceLabel } from './config.js';
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

const LABELS = Object.fromEntries(
  Object.entries(RESIDENCE_LABELS).map(([num, label]) => [`residence_${num}`, label])
);

// ── Anti-spam "session expirée" ─────────────────────────────────────────────
// Tant que la session n'est pas renouvelée (npm run login), CHAQUE cycle
// retombe sur la même erreur → sans garde-fou, ça enverrait un message
// Telegram toutes les intervalSeconds (ex: 15/3s), soit des centaines de
// notifs par nuit si on oublie de se reconnecter avant de dormir. On coupe
// donc l'envoi après SESSION_ALERT_LIMIT alertes consécutives ; le moniteur
// continue de tourner en silence (logs uniquement) et redevient bavard dès
// qu'un check réussit (= nouveau login détecté).
const SESSION_ALERT_LIMIT = 10;
let sessionAlertCount = 0;

async function notifySessionIssue(text) {
  sessionAlertCount++;
  if (sessionAlertCount > SESSION_ALERT_LIMIT) {
    console.warn(`[check] Session toujours invalide (alerte #${sessionAlertCount}) — notif Telegram coupée après ${SESSION_ALERT_LIMIT}, reconnecte-toi (npm run login).`);
    return;
  }
  if (sessionAlertCount === SESSION_ALERT_LIMIT) {
    await notify(
      `${text}\n\n🔇 <b>C'était l'alerte n°${SESSION_ALERT_LIMIT}</b> — je me tais maintenant pour ne pas te spammer. ` +
      `Je surveille toujours en silence et je redeviendrai bavard dès que tu te reconnectes.`
    );
    return;
  }
  await notify(text);
}

/** Réinitialise le compteur d'alertes dès qu'un check réussit (session valide). */
function resetSessionAlertCount() {
  if (sessionAlertCount > 0) {
    console.log('[check] Session de nouveau valide — compteur d\'alertes remis à zéro.');
  }
  sessionAlertCount = 0;
}

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
 * Résidences pour lesquelles on AUTO-RÉSERVE (les autres → notification seule).
 * Choix utilisateur par défaut : Résidence III et Résidence IV. Pilotable par
 * le secret Fly AUTO_RESERVE_RESIDENCES (ex "3,4") sans redéployer.
 */
const AUTO_RESERVE_RESIDENCE_IDS = new Set(
  config.autoReserveResidences.map((n) => `residence_${n}`)
);
const AUTO_RESERVE_LABELS = config.autoReserveResidences.map((n) => residenceLabel(n)).join(' / ');

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
    await notifySessionIssue(
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

  // Rate-limiting / serveur en difficulté : on remonte l'info pour que la
  // boucle applique un BACKOFF (et arrête de marteler). On respecte l'en-tête
  // Retry-After si le serveur le fournit. Crucial à haute fréquence : un 429
  // ignoré peut se transformer en blocage IP.
  if (res.status === 429 || res.status === 503) {
    const ra = parseInt(res.headers.get('retry-after') || '0', 10);
    console.warn(`[check] Rate-limit CESAL (HTTP ${res.status})${ra ? `, Retry-After=${ra}s` : ''}.`);
    return { error: 'RATE_LIMITED', status: res.status, retryAfter: Number.isFinite(ra) && ra > 0 ? ra : 0 };
  }

  // Redirection vers le login => session expirée.
  if (res.status >= 300 && res.status < 400) {
    const loc = res.headers.get('location') || '';
    if (/login/i.test(loc)) {
      await notifySessionIssue('🔐 Session CESAL expirée. Relance <code>npm run login</code>.');
      return { error: 'SESSION_EXPIRED' };
    }
  }

  let html = await res.text();

  // Page de login renvoyée directement (autre forme d'expiration).
  if (/g-recaptcha|name="login-email"/.test(html) && !/id="residences"/.test(html)) {
    await notifySessionIssue('🔐 Session CESAL expirée. Relance <code>npm run login</code>.');
    return { error: 'SESSION_EXPIRED' };
  }

  // Session valide (on a dépassé toutes les détections d'expiration ci-dessus).
  resetSessionAlertCount();

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
    // ── ANTI-SPAM ────────────────────────────────────────────────────────────
    // Signature = ensemble trié des niveaux disponibles (détectés en HTTP, sans
    // navigateur). Tant qu'elle ne change pas, on a déjà traité cette situation
    // aujourd'hui : on n'envoie AUCUN message et on n'ouvre PAS le navigateur
    // (évite le spam de 15 notifs + screenshots à chaque cycle de 3 min). Une
    // nouvelle dispo (autre niveau) change la signature et relance le flux.
    const { isNewSignature, markSignatureSeen } = await import('./seen.js');
    const dispoLevels = Object.entries(nodes)
      .filter(([id, v]) => v.available && /^niveau_/.test(id))
      .map(([id]) => id)
      .sort();
    // Repli : si aucun niveau parsé (structure inattendue), on retombe sur les
    // résidences dispo pour ne pas perdre l'alerte.
    const signature = (dispoLevels.length ? dispoLevels : dispoResidences.map((r) => r.id).sort()).join('|');
    if (!isNewSignature(signature)) {
      console.log(`[check] Signature déjà traitée aujourd'hui (${signature}) — pas de nouvelle notif.`);
      return { available: true, alreadyNotified: true, nodes };
    }
    markSignatureSeen(signature);

    // On ne VALIDE réellement que si une résidence auto-réservable (III/IV par
    // défaut) est dans le lot. Sinon on récupère quand même tous les détails des
    // logements pour la notification, sans jamais valider (commit=false).
    const autoResidences = dispoResidences.filter((r) =>
      AUTO_RESERVE_RESIDENCE_IDS.has(r.id)
    );
    const isEligible = autoResidences.length > 0;

    // Message d'alerte — différent selon qu'on va réserver ou juste documenter.
    if (isEligible) {
      await notify(
        `🏠 <b>LOGEMENT DISPONIBLE CHEZ CESAL !</b>\n\n` +
        buildDispoMessage(dispoResidences, nodes) +
        `\n\n🎯 <b>${AUTO_RESERVE_LABELS} détectée → le bot analyse les logements.</b>` +
        `\n   • Il choisit le meilleur selon tes préférences (${config.preferredTypes.join(' > ')}, sans colocation) et le réserve.` +
        `\n   • Colocation solidaire (email colocataire exigé par le site) → il NE PEUT PAS,` +
        ` il t'alerte pour que tu réserves à la main.` +
        `\n⚡ <b>EN BACKUP, réserve TOI AUSSI à la main tout de suite :</b>` +
        `\n🔗 ${URLS.reservation}`
      );
    } else {
      await notify(
        `🏠 <b>LOGEMENT DISPONIBLE CHEZ CESAL !</b>\n\n` +
        buildDispoMessage(dispoResidences, nodes) +
        `\n\nℹ️ <b>Ce n'est PAS une ${AUTO_RESERVE_LABELS}</b> → je ne réserve PAS,` +
        ` je récupère juste les détails du logement (prix, surface, colocation…).` +
        `\n👉 Si ça t'intéresse, réserve à la main :` +
        `\n🔗 ${URLS.reservation}`
      );
    }

    // ── RÉSERVATION 100 % HTTP (aucun navigateur) ────────────────────────────
    // Tout le détail des logements ET le formulaire de validation sont DÉJÀ dans
    // le `html` qu'on vient de récupérer (le parcours du site est 100 % côté
    // client — cf. reserve-http.js). UN SEUL appel, même si plusieurs résidences
    // sont dispos : le HTML les contient toutes, et c'est reserve-http.js qui
    // rattache chaque logement à SA résidence puis choisit le meilleur selon les
    // préférences. commit=true seulement si une résidence auto-réservable est
    // dans le lot ; sinon → détails seuls.
    // Nécessite le mode reserve (sinon on se contente de l'alerte ci-dessus).
    if (config.mode === 'reserve') {
      const { handleAvailability } = await import('./reserve-http.js');
      const contexte = dispoResidences.map((r) => r.label).join(', ');
      try {
        await handleAvailability(html, cookieHeader, { contexte, commit: isEligible });
      } catch (err) {
        await notify(
          `⚠️ Traitement de la dispo (${contexte}) en échec : <code>${escapeHtml(err.message)}</code>\n` +
          `👉 Réserve à la main si besoin : ${URLS.reservation}`
        );
      }
    }
    return { available: true, autoReserved: isEligible, nodes };
  }

  // À haute fréquence, on ne loggue "aucune dispo" qu'une fois toutes les
  // ~5 min pour ne pas noyer les logs Fly (sinon des milliers de lignes/jour).
  const now = Date.now();
  if (now - lastNoDispoLog > 5 * 60_000) {
    console.log(`[check] ${new Date().toLocaleTimeString()} — aucune dispo (${Object.keys(nodes).length} noeuds vérifiés).`);
    lastNoDispoLog = now;
  }
  return { available: false, nodes };
}

// Horodatage du dernier log "aucune dispo" (throttling du bruit de logs).
let lastNoDispoLog = 0;

if (import.meta.url === `file://${process.argv[1]}`) {
  checkOnce().then((r) => process.exit(r?.error ? 1 : 0));
}
