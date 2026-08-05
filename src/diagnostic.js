/**
 * DIAGNOSTIC — 100 % LECTURE SEULE. Ne réserve RIEN, ne valide RIEN.
 *
 * Répond à la question « comment être sûr que la prochaine fois ça marchera ? ».
 * Les tests hors-ligne (`npm test`) prouvent que le code fait ce qu'on croit ;
 * ils ne prouvent pas que le VRAI site est bien tel qu'on l'imagine. Ce script
 * comble exactement ce trou : il interroge le vrai site avec ta vraie session et
 * vérifie, un par un, chaque maillon de la chaîne de réservation — sans jamais
 * envoyer le POST de validation.
 *
 * Les deux requêtes qu'il fait sont celles que la surveillance fait déjà toutes
 * les quelques secondes : un POST `modifier_date_arrivee` (consultation) et un
 * GET de la page. Rien de plus.
 *
 *   npm run diagnostic
 *   fly ssh console -a sarzal -C "node src/diagnostic.js"
 */
import fs from 'fs';
import { config, URLS, STORAGE_STATE } from './config.js';
import { notify, notifyDocument, escapeHtml } from './notify.js';
import { postForm, getPage, looksLikeLogin } from './http.js';
import { parseAvailability, parseArrivalDates } from './monitor.js';
import {
  parseLogements,
  parseValidationForm,
  buildValidationPayload,
  interpretAccountPage,
  isColocation,
} from './reserve-http.js';

const lignes = [];
const problemes = [];

function ok(titre, detail = '') {
  lignes.push(`✅ ${titre}${detail ? ` — ${detail}` : ''}`);
  console.log(`✅ ${titre}${detail ? ` — ${detail}` : ''}`);
}
function ko(titre, detail = '') {
  lignes.push(`❌ <b>${titre}</b>${detail ? ` — ${detail}` : ''}`);
  problemes.push(titre);
  console.log(`❌ ${titre}${detail ? ` — ${detail}` : ''}`);
}
function info(titre, detail = '') {
  lignes.push(`ℹ️ ${titre}${detail ? ` — ${detail}` : ''}`);
  console.log(`ℹ️ ${titre}${detail ? ` — ${detail}` : ''}`);
}

function loadCookieHeader() {
  if (!fs.existsSync(STORAGE_STATE)) return null;
  const state = JSON.parse(fs.readFileSync(STORAGE_STATE, 'utf8'));
  const cookies = (state.cookies || []).filter((c) => c.domain.includes('cesal.fr'));
  if (!cookies.length) return null;
  return cookies.map((c) => `${c.name}=${c.value}`).join('; ');
}

async function main() {
  console.log('\n═══ DIAGNOSTIC CESAL (lecture seule, aucune réservation) ═══\n');

  /* ── 1. Session ─────────────────────────────────────────────────────────── */
  const cookieHeader = loadCookieHeader();
  if (!cookieHeader) {
    ko('Aucune session', 'lance `npm run login` (ou vérifie SESSION_JSON_B64 sur Fly)');
    await envoyerBilan();
    return;
  }
  ok('Session présente', `${cookieHeader.split(';').length} cookie(s)`);

  /* ── 2. La page de réservation répond-elle ? ────────────────────────────── */
  // ⚠️ Tant qu'aucune date d'arrivée n'est choisie, le site n'envoie qu'un
  // squelette (~31 Ko) : « merci de nous indiquer votre date d'arrivée ». Ni
  // résidences, ni logements, ni formulaire de validation n'y figurent. Poster
  // une date VIDE faisait donc crier au loup — c'est la page normale d'avant
  // sélection. On refait ici ce que fait la surveillance : lire les dates
  // proposées, puis reposter avec la dernière (celle qui ouvre le plus loin).
  let res;
  try {
    res = await postForm(
      URLS.reservation,
      new URLSearchParams({
        action: 'modifier_date_arrivee',
        date_arrivee: '',
        date_sortie: config.dateSortie,
      }).toString(),
      cookieHeader,
      { referer: URLS.reservation }
    );
  } catch (err) {
    ko('Le site ne répond pas', err.message);
    await envoyerBilan();
    return;
  }

  if (looksLikeLogin(res.html)) {
    ko('Session expirée', 'le site renvoie la page de connexion — relance `npm run login`');
    await envoyerBilan();
    return;
  }
  ok('Page de réservation accessible', `HTTP ${res.status}, ${res.html.length} caractères`);

  const dates = parseArrivalDates(res.html);
  if (dates.length === 0) ko('Aucune date d\'arrivée lisible', 'le <select date_arrivee> a changé');
  else ok('Dates d\'arrivée lues', `${dates.length} date(s), la dernière = ${dates[dates.length - 1]}`);

  // Sélection de la date → c'est CETTE réponse qui contient tout le reste.
  if (dates.length) {
    const derniere = dates[dates.length - 1];
    try {
      const avecDate = await postForm(
        URLS.reservation,
        new URLSearchParams({
          action: 'modifier_date_arrivee',
          date_arrivee: derniere,
          date_sortie: config.dateSortie,
        }).toString(),
        cookieHeader,
        { referer: URLS.reservation }
      );
      if (!looksLikeLogin(avecDate.html) && avecDate.html.length > res.html.length) {
        res = avecDate;
        ok('Page complète après choix de la date', `${derniere} → ${res.html.length} caractères`);
      }
    } catch (err) {
      ko('Sélection de la date impossible', err.message);
    }
  }

  /* ── 3. La surveillance voit-elle quelque chose ? ───────────────────────── */
  const nodes = parseAvailability(res.html);
  const nbNodes = Object.keys(nodes).length;
  if (nbNodes === 0) {
    ko('Surveillance aveugle', 'aucun statut de résidence lisible — la structure du site a changé');
  } else {
    const dispo = Object.entries(nodes).filter(([id, v]) => /^residence_\d+$/.test(id) && v.available);
    ok('Statuts de résidence lus', `${nbNodes} nœuds, ${dispo.length} résidence(s) avec dispo`);
    if (dispo.length) info('Résidences disponibles', dispo.map(([id]) => id).join(', '));
  }

  /* ── 4. LE POINT LE PLUS IMPORTANT : la vérification sait-elle lire ton
   *      compte ? C'est elle qui décide si un « ✅ » est envoyé ou non. Si elle
   *      répond « unknown » alors que tu n'as rien de réservé, elle ne saura pas
   *      davantage reconnaître une VRAIE réservation — et le bot annoncera un
   *      échec même en cas de succès. À corriger avant la prochaine dispo. ── */
  let compte;
  try {
    compte = await getPage(URLS.reservation, cookieHeader);
  } catch (err) {
    ko('Impossible de relire la page du compte', err.message);
    compte = { html: '' };
  }
  const etat = interpretAccountPage(compte.html, null);
  if (etat === 'none') {
    ok('Vérification de réservation calibrée', 'le bot lit bien « aucun bien réservé » sur ton compte');
  } else if (etat === 'reserved') {
    info('Ton compte a DÉJÀ un logement réservé', 'le bot ne tentera pas d\'en prendre un autre');
  } else if (etat === 'session') {
    ko('La relecture du compte tombe sur le login', 'session instable');
  } else {
    ko(
      'Vérification NON calibrée (état « unknown »)',
      'le bot ne reconnaît ni « rien de réservé » ni « réservé » sur ton compte. ' +
        'Il annoncerait un échec même en cas de réussite. HTML joint : à me transmettre pour ajuster'
    );
  }

  /* ── 5. Le formulaire de validation est-il là, et complet ? ─────────────── */
  const form = parseValidationForm(res.html);
  if (!form) {
    // Le formulaire n'existe dans le HTML qu'une fois une date choisie ; s'il
    // manque encore ici, c'est soit qu'aucune date n'était sélectionnable, soit
    // que le site a changé. Sans dispo du jour, ce n'est pas un défaut du bot.
    ko(
      'Formulaire de validation introuvable',
      dates.length
        ? 'même après avoir choisi une date — le bot basculerait sur le navigateur'
        : 'aucune date d\'arrivée n\'était sélectionnable, donc le site ne l\'affiche pas'
    );
  } else {
    const noms = form.fields.map((f) => f.name);
    ok('Formulaire de validation trouvé', `id="${form.id || '(sans id)'}", ${noms.length} champ(s)`);
    info('Champs du formulaire', noms.join(', ') || '(aucun)');
    const vides = form.fields.filter((f) => !f.value).map((f) => f.name);
    if (vides.length) {
      info(
        'Champs vides dans le HTML (normal)',
        `${vides.join(', ')} — ce sont ceux que le site remplit en JavaScript, et que le bot remplit désormais lui-même`
      );
    }
  }

  /* ── 6. S'il y a une dispo maintenant : que serait envoyé ? (SANS envoyer) ─ */
  const logements = parseLogements(res.html);
  if (logements.length === 0) {
    info('Aucun logement disponible en ce moment', 'normal — la simulation du POST n\'est pas possible aujourd\'hui');
  } else {
    ok('Logement(s) détecté(s)', logements.map((l) => `${l.code} (rés. ${l.residenceNum || '?'})`).join(', '));
    const l = logements[0];
    info('Colocation ?', isColocation(l) ? 'OUI → réservation manuelle obligatoire' : 'non → auto-réservable');
    const payload = buildValidationPayload(res.html, l, {
      dateArrivee: dates[dates.length - 1] || '',
      dateSortie: config.dateSortie,
    });
    if (!payload) {
      ko('Payload non constructible', 'formulaire absent');
    } else if (payload.stillEmpty.length) {
      ko('Le POST partirait avec des champs vides', payload.stillEmpty.join(', '));
    } else {
      ok('Le POST partirait complet', `champs renseignés par le bot : ${payload.filled.join(', ')}`);
    }
    if (payload) {
      // ⚠️ AFFICHÉ, PAS ENVOYÉ.
      info('Corps du POST qui serait envoyé', `<code>${escapeHtml(payload.body.slice(0, 500))}</code>`);
    }
  }

  /* ── 7. Réglages en vigueur ─────────────────────────────────────────────── */
  info('Mode', config.mode === 'reserve' ? 'reserve (le bot réservera)' : 'alert (le bot NE réservera PAS)');
  if (config.mode !== 'reserve') {
    ko('MODE=alert', 'aucune réservation automatique ne sera tentée — passe MODE=reserve');
  }
  info('Résidences ciblées', config.autoReserveResidences.join(', '));
  info('Fallback navigateur', config.browserFallback ? 'activé' : 'DÉSACTIVÉ');
  info('Telegram', config.telegramToken && config.telegramChatId ? 'configuré' : '❌ NON configuré');

  await envoyerBilan(compte?.html);
}

async function envoyerBilan(compteHtml) {
  const verdict = problemes.length
    ? `🛑 <b>${problemes.length} problème(s) à corriger AVANT la prochaine dispo :</b>\n• ` +
      problemes.map((p) => escapeHtml(p)).join('\n• ')
    : `✅ <b>Chaîne de réservation opérationnelle</b> — tous les maillons répondent.`;

  await notify(
    `🩺 <b>DIAGNOSTIC CESAL</b> (lecture seule, aucune réservation effectuée)\n\n` +
      lignes.join('\n') +
      `\n\n${verdict}`
  );

  // La page du compte est jointe quand la vérification n'est pas calibrée :
  // c'est le HTML dont j'ai besoin pour ajuster la détection.
  if (compteHtml && problemes.some((p) => p.includes('NON calibrée'))) {
    try {
      await notifyDocument(
        '🧾 Page de ton compte — à transmettre pour calibrer la vérification',
        Buffer.from(compteHtml, 'utf8'),
        'compte_diagnostic.html'
      );
    } catch {}
  }

  console.log(`\n${problemes.length ? '🛑' : '✅'} ${problemes.length} problème(s).\n`);
  process.exit(problemes.length ? 1 : 0);
}

main().catch(async (err) => {
  console.error(err);
  ko('Diagnostic interrompu', err.message);
  await envoyerBilan();
});
