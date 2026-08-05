/**
 * TEST HORS LIGNE de la sélection du logement à réserver.
 *
 * Aucun réseau, aucun Telegram, aucun POST : on ne teste QUE le parsing et le
 * choix, c'est-à-dire la partie qui décide quel logement sera réservé de façon
 * IRRÉVERSIBLE le jour où plusieurs dispos tombent en même temps.
 *
 *   node src/test-selection.js      (ou : npm run test:selection)
 *
 * Deux jeux de données :
 *   1. la capture RÉELLE config/reserve_step_J.html (1 seul logement, Rés. III,
 *      T1 BIS colocation solidaire) ;
 *   2. un HTML SYNTHÉTIQUE reproduisant le balisage réel avec 7 logements
 *      répartis sur 4 résidences — le scénario "demain matin".
 *
 * La section 5 rejoue le parcours COMPLET (choix → POST → échec → logement
 * suivant → succès) avec `fetch` intercepté : aucune requête ne sort, ni vers
 * CESAL ni vers Telegram, et l'état (seen_logements.json, dumps) est restauré.
 */

import fs from 'fs';
import {
  parseLogements,
  rankCandidates,
  parseReservationForm,
  buildValidationPayload,
  isColocation,
  isSolidaire,
} from './reserve-http.js';
import { config } from './config.js';

let failures = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? '✅' : '❌'} ${label}${ok ? '' : `\n     attendu: ${JSON.stringify(expected)}\n     obtenu : ${JSON.stringify(actual)}`}`);
}

/* ── Fixture : balisage identique au site (cf. config/reserve_step_J.html) ── */

function ligneLogement({ keyid, code, type, coloc, occupants, surface, loyer }) {
  return `
    <tr id="tr_logement_${keyid}">
      <td class="text-center text-danger font-w700">
        <label class="css-input switch switch-sm switch-primary font-w700">
          <input type="checkbox" id="check_logement_${keyid}" name="check_logement_${keyid}"><span></span>
        </label>
        <input type="hidden" id="message_affectation_${keyid}" name="message_affectation_${keyid}" value="La date de fin de bail maximale autorisée pour ce logement est le 31/07/2027">
      </td>
      <td class="text-center font-w700">
${code}      </td>
      <td class="text-center">${type}</td>
      <td class="text-center">
${coloc}      </td>
      <td class="text-center">${occupants}</td>
      <td class="text-center"><span class="badge badge-danger">Non</span></td>
      <td class="text-center">${surface} m<sup>2</sup></td>
      <td class="text-center"><span class="badge badge-danger">Non</span></td>
      <td class="text-center"><span class="badge badge-danger">Non</span></td>
      <td class="text-center text-nowrap">
${loyer} €      </td>
      <td class="text-center text-nowrap">
${loyer} €      </td>
      <td class="text-center text-nowrap">
0,00 €      </td>
    </tr>`;
}

const COLOC_SOLIDAIRE = '<span class="badge badge-success">Oui</span><br>Loyer solidaire';
const COLOC_NON_SOLIDAIRE = '<span class="badge badge-success">Oui</span><br>Loyer non solidaire';
const SANS_COLOC = '<span class="badge badge-danger">Non</span>';

function niveauBloc(niveauId, lignes) {
  return `
  <div id="${niveauId}_logements" class="row push-20" style="display:none;">
    <div class="col-lg-12 block-header background_cesal"><h4>Logements disponibles</h4></div>
    <div class="table-responsive"><table class="table"><tbody>${lignes.join('\n')}</tbody></table></div>
  </div>`;
}

/**
 * Le scénario redouté : plusieurs logements, plusieurs résidences, dans l'ordre
 * du DOM (Résidence I en premier — c'est ce qui piégeait l'ancien code).
 */
function fixtureMultiLogements() {
  const blocs = [
    // Résidence I — apparaît EN PREMIER dans le document (le piège).
    niveauBloc('niveau_1_A_0_2', [
      ligneLogement({ keyid: '1D112', code: '1D112', type: 'T2', coloc: COLOC_NON_SOLIDAIRE, occupants: 2, surface: '28,00', loyer: '367,97' }),
    ]),
    // Résidence I — un T1 individuel, tentant mais hors périmètre auto.
    niveauBloc('niveau_1_B_0_1', [
      ligneLogement({ keyid: '1B101A', code: '1B101', type: 'T1', coloc: SANS_COLOC, occupants: 1, surface: '18,00', loyer: '399,00' }),
    ]),
    // Résidence III — la colocation solidaire (cas réel du 22/07, non réservable).
    niveauBloc('niveau_3_E_C_2', [
      ligneLogement({ keyid: '3EC201A', code: '3EC201', type: 'T1 BIS', coloc: COLOC_SOLIDAIRE, occupants: 2, surface: '41,00', loyer: '984,41' }),
    ]),
    // Résidence III — LE RÊVE : T1 individuel.
    niveauBloc('niveau_3_A_G_1', [
      ligneLogement({ keyid: '3AG104A', code: '3AG104', type: 'T1', coloc: SANS_COLOC, occupants: 1, surface: '20,00', loyer: '512,30' }),
    ]),
    // Résidence IV — T1 individuel moins cher + un T1 BIS individuel.
    niveauBloc('niveau_4_B_D_0', [
      ligneLogement({ keyid: '4BD003A', code: '4BD003', type: 'T1', coloc: SANS_COLOC, occupants: 1, surface: '22,00', loyer: '498,00' }),
      ligneLogement({ keyid: '4BD104A', code: '4BD104', type: 'T1 BIS', coloc: SANS_COLOC, occupants: 1, surface: '30,00', loyer: '700,00' }),
    ]),
    // Résidence Joliot-Curie — hors périmètre.
    niveauBloc('niveau_5_A_0_1', [
      ligneLogement({ keyid: '5A101', code: '5A101', type: 'T1', coloc: SANS_COLOC, occupants: 1, surface: '19,00', loyer: '450,00' }),
    ]),
  ];

  const form = `
  <input type="hidden" name="keyid_reservation" id="keyid_reservation" value="1D112">
  <form id="action-validation_reservation" action="/espace-resident/cesal_mon_logement_reservation.php" method="post">
    <input type="hidden" name="action" value="validation_reservation">
    <input type="hidden" name="est_avec_debut_bail_sur_validation_pieces_2026-08-21" value="0">
    <input type="hidden" name="nb_occupants" id="nb_occupants" value="2">
    <input type="hidden" name="est_caution_solidaire" id="est_caution_solidaire" value="1">
    <input type="hidden" name="keyid" id="keyid" value="">
    <input type="hidden" id="numetu_1" name="numetu_1" value="44827">
    <input type="hidden" id="date_entree" name="date_entree" value="21/08/2026">
    <input type="hidden" id="date_sortie" name="date_sortie" value="18/12/2026">
    <input type="hidden" id="heure_arrivee" name="heure_arrivee" value="00:00:00">
  </form>`;

  return `<html><body><div id="residences">${blocs.join('\n')}</div>${form}</body></html>`;
}

/* ─────────────────────────────── Tests ─────────────────────────────────── */

const OPTS = {
  autoReserveResidences: ['3', '4'],
  preferredTypes: ['T1', 'T1 BIS', 'T2'],
  strictTypes: false,
  allowColocNonSolidaire: false,
};

console.log('\n═══ 1. Capture RÉELLE (config/reserve_step_J.html) ═══\n');
const realPath = new URL('../config/reserve_step_J.html', import.meta.url).pathname;
if (fs.existsSync(realPath)) {
  const realHtml = fs.readFileSync(realPath, 'utf8');
  const reels = parseLogements(realHtml);
  check('1 logement parsé', reels.length, 1);
  const l = reels[0];
  console.log(`   → ${l.code} | ${l.type} | ${l.surface} | ${l.loyer} | ${l.chemin}`);
  check('résidence déduite du <div> englobant', l.residence, '3');
  check('chemin complet', l.chemin, 'Résidence III › Aile E › Escalier C › Niveau R+2');
  check('keyid de réservation', l.keyid, '3EC201A');
  check('type', l.typeNorm, 'T1 BIS');
  check('détecté colocation', isColocation(l), true);
  check('détecté SOLIDAIRE (donc bloqué par le site)', isSolidaire(l), true);
  const r = rankCandidates(reels, OPTS);
  check('aucun candidat auto-réservable', r.candidats.length, 0);
  check('1 colocation solidaire à signaler', r.colocSolidaires.map((x) => x.code), ['3EC201']);
} else {
  console.log('   ⚠️ capture absente, test sauté.');
}

console.log('\n═══ 2. Scénario "demain matin" : 7 logements, 4 résidences ═══\n');
const html = fixtureMultiLogements();
const logements = parseLogements(html);

check('7 logements parsés', logements.length, 7);
console.log('\n   Inventaire tel que lu par le bot :');
for (const l of logements) {
  const tag = isSolidaire(l) ? 'coloc solidaire' : isColocation(l) ? 'coloc' : 'individuel';
  console.log(`   • ${l.code.padEnd(7)} ${l.type.padEnd(7)} ${String(l.loyer).padStart(9)}  ${tag.padEnd(15)} ${l.chemin}`);
}

check(
  'chaque logement rattaché à SA résidence',
  logements.map((l) => `${l.code}:${l.residence}`),
  ['1D112:1', '1B101:1', '3EC201:3', '3AG104:3', '4BD003:4', '4BD104:4', '5A101:5']
);

const { candidats, colocSolidaires, horsPrefs } = rankCandidates(logements, OPTS);
console.log('\n   Classement des candidats auto-réservables :');
candidats.forEach((l, i) => console.log(`   ${i + 1}. ${l.code} — ${l.type}, ${l.loyer}, ${l.chemin}`));

check(
  'ordre des candidats (T1 avant T1 BIS, Rés. III avant IV)',
  candidats.map((l) => l.code),
  ['3AG104', '4BD003', '4BD104']
);
check('le choix final', candidats[0].code, '3AG104');
check('coloc solidaire écartée mais signalée', colocSolidaires.map((l) => l.code), ['3EC201']);
check('aucune exclusion STRICT_TYPES (désactivé)', horsPrefs.length, 0);
check(
  'aucun logement hors Résidences III/IV retenu',
  candidats.every((l) => ['3', '4'].includes(l.residence)),
  true
);
check(
  'aucune colocation retenue (T2 jumelé 1D112 exclu)',
  candidats.some(isColocation),
  false
);

console.log('\n   → Ancien comportement (1re ligne du document, sans filtre) :',
  `${logements[0].code} en ${logements[0].chemin} ⛔`);

console.log('\n═══ 3. Payload POST envoyé pour le logement choisi ═══\n');
// buildValidationPayload part désormais du HTML complet (il doit émuler ce que
// le JS du site pose dans le formulaire) et renvoie { body, filled, … }.
const payloadRes = buildValidationPayload(html, candidats[0], {
  dateArrivee: '21/08/2026',
  dateSortie: '18/12/2026',
});
const payload = Object.fromEntries(new URLSearchParams(payloadRes.body));
console.log(`   ${JSON.stringify(payload, null, 2).split('\n').join('\n   ')}`);
check('keyid = celui du logement choisi', payload.keyid, '3AG104A');
check('toggle du logement choisi coché', payload.check_logement_3AG104A, 'on');
check('nb_occupants recalculé depuis SA ligne (pas la valeur figée du form)', payload.nb_occupants, '1');
check('est_caution_solidaire recalculé', payload.est_caution_solidaire, '0');
check('action conservée', payload.action, 'validation_reservation');
check('dates du form conservées', [payload.date_entree, payload.date_sortie], ['21/08/2026', '18/12/2026']);
check('numetu_1 (ton compte) conservé', payload.numetu_1, '44827');

console.log('\n═══ 4. Variantes de configuration ═══\n');
const strict = rankCandidates(logements, { ...OPTS, preferredTypes: ['T1'], strictTypes: true });
check('STRICT_TYPES=true + PREFERRED_TYPES=T1 → que des T1', strict.candidats.map((l) => l.code), ['3AG104', '4BD003']);
check('  → T1 BIS écarté et signalé', strict.horsPrefs.map((l) => l.code), ['4BD104']);

const avecColoc = rankCandidates(logements, { ...OPTS, allowColocNonSolidaire: true });
check(
  'ALLOW_COLOC_NON_SOLIDAIRE=true → coloc non solidaire acceptée, mais en dernier',
  avecColoc.candidats.map((l) => l.code),
  ['3AG104', '4BD003', '4BD104']
);

const seulementIV = rankCandidates(logements, { ...OPTS, autoReserveResidences: ['4'] });
check('AUTO_RESERVE_RESIDENCES=4 → que la Résidence IV', seulementIV.candidats.map((l) => l.code), ['4BD003', '4BD104']);

/* ─── 5. Parcours complet, réseau INTERCEPTÉ (rien ne sort de la machine) ─── */

console.log('\n═══ 5. Simulation du parcours complet (aucun réseau réel) ═══\n');

const PAGE_ECHEC = `<html><body>
  <div id="submit_reservation_error" style="display:none;"><span id="submit_reservation_error_message">Ce logement vient d'être réservé par un autre résident.</span></div>
  <button>Valider votre réservation</button></body></html>`;
const PAGE_SUCCES = `<html><body>
  <div id="submit_reservation_error" style="display:none;"><span id="submit_reservation_error_message"></span></div>
  <h4>Votre réservation est enregistrée.</h4></body></html>`;
// Page du compte : c'est ELLE qui fait foi désormais (relue après chaque POST).
const COMPTE_VIDE = `<html><body>Vous n'avez aucun bien en location ou réservé.</body></html>`;
const COMPTE_RESERVE = `<html><body><h4>Votre réservation a bien été enregistrée.</h4></body></html>`;

// Le fallback navigateur n'a pas sa place dans un test hors ligne : sans lui,
// un échec HTTP reste un échec, ce qui est exactement ce qu'on veut vérifier.
config.browserFallback = false;

const appels = [];
let reservationPrise = false;
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  const method = (opts.method || 'GET').toUpperCase();
  appels.push({ url: u, body: opts.body, method });
  if (u.includes('api.telegram.org')) {
    return { ok: true, status: 200, text: async () => '{"ok":true}' };
  }
  // GET = relecture de la page du compte (vérification du résultat réel).
  if (method === 'GET') {
    return { ok: true, status: 200, headers: new Map(), text: async () => (reservationPrise ? COMPTE_RESERVE : COMPTE_VIDE) };
  }
  // POST de validation : la 1re est refusée par le site, la 2e acceptée.
  const nPosts = appels.filter((a) => a.url.includes('cesal.fr') && a.method === 'POST').length;
  if (nPosts >= 2) reservationPrise = true;
  return { ok: true, status: 200, headers: new Map(), text: async () => (nPosts === 1 ? PAGE_ECHEC : PAGE_SUCCES) };
};

// L'état "déjà vu" et les dumps sont sauvegardés puis restaurés : un test ne
// doit jamais laisser de trace dans l'état réel du bot.
const seenPath = new URL('../config/seen_logements.json', import.meta.url).pathname;
const seenBackup = fs.existsSync(seenPath) ? fs.readFileSync(seenPath, 'utf8') : null;

const { handleAvailability } = await import('./reserve-http.js');
const res = await handleAvailability(html, 'PHPSESSID=fake', {
  contexte: 'Résidence I, Résidence III, Résidence IV, Résidence Joliot-Curie',
  commit: true,
});

const validations = appels.filter((a) => a.url.includes('cesal.fr') && a.method === 'POST');
const keyidsEnvoyes = validations.map((a) => new URLSearchParams(a.body).get('keyid'));
check('2 validations tentées (la 1re refusée, on enchaîne)', validations.length, 2);
check('ordre des tentatives', keyidsEnvoyes, ['3AG104A', '4BD003A']);
check('réservation finalement obtenue', res.reserved, true);
check(
  'le compte a été relu après chaque tentative (la preuve, pas la supposition)',
  appels.filter((a) => a.url.includes('cesal.fr') && a.method === 'GET').length,
  2
);
check('logement réservé', res.chosen.code, '4BD003');
check(
  'nb_occupants correct sur la 2e tentative',
  new URLSearchParams(validations[1].body).get('nb_occupants'),
  '1'
);

// Nettoyage : dumps de validation + état "déjà vu".
for (const code of ['3AG104', '4BD003']) {
  const p = new URL(`../config/reserve_http_validation_${code}.html`, import.meta.url).pathname;
  if (fs.existsSync(p)) fs.unlinkSync(p);
}
if (seenBackup !== null) fs.writeFileSync(seenPath, seenBackup);
else if (fs.existsSync(seenPath)) fs.unlinkSync(seenPath);

console.log(`\n${failures ? `❌ ${failures} test(s) en échec.` : '✅ Tous les tests passent.'}\n`);
process.exit(failures ? 1 : 0);
