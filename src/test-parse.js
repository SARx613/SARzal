/**
 * Tests HORS-LIGNE des parseurs (aucun réseau, aucun navigateur, aucun compte).
 *
 * Pourquoi ce fichier existe : tous les bugs de l'audit du 04/08/2026 étaient
 * des bugs de PARSING ou d'INTERPRÉTATION, entièrement reproductibles sur du
 * HTML statique — et pourtant jamais testés, parce qu'il n'y avait aucun test.
 * Chaque cas ci-dessous rejoue précisément une de ces défaillances.
 *
 *   npm test
 */
import fs from 'fs';
import assert from 'assert';
import {
  parseLogements,
  filterByResidence,
  isColocation,
  parseValidationForm,
  buildValidationPayload,
  interpretAccountPage,
  interpretValidationResult,
  decodeEntities,
} from './reserve-http.js';
import { parseAvailability, parseArrivalDates } from './monitor.js';

let passed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✅ ${name}`);
  } catch (err) {
    failures.push({ name, err });
    console.log(`  ❌ ${name}\n     ${err.message}`);
  }
}

/* ──────────────────────────────── Fixtures ─────────────────────────────── */

const SAMPLE = fs.readFileSync(
  new URL('../docs/html-samples/tableaux_1D112_extrait.html', import.meta.url).pathname,
  'utf8'
);

/**
 * Page reconstituée telle que la surveillance la reçoit : deux résidences avec
 * une dispo chacune, chaque tableau logement à l'intérieur de son conteneur
 * `niveau_..._logements`, et le formulaire de validation VIDE — c'est le point
 * crucial : sur le vrai site, ce sont les scripts de la page qui le remplissent
 * quand on coche le toggle, et ils ne tournent jamais en HTTP pur.
 */
function pageAvecDeuxResidences() {
  const ligne = (keyid, code, type, coloc, occ, loyer) => `
    <tr id="tr_logement_${keyid}">
      <td class="text-center">
        <label class="css-input switch"><input type="checkbox" id="check_logement_${keyid}" name="check_logement_${keyid}"><span></span></label>
        <input type="hidden" id="message_affectation_${keyid}" name="message_affectation_${keyid}" value="La date de fin de bail maximale autoris&eacute;e pour ce logement est le 31/07/2027">
      </td>
      <td class="text-center font-w700">${code}</td>
      <td class="text-center">${type}</td>
      <td class="text-center">${coloc}</td>
      <td class="text-center">${occ}</td>
      <td class="text-center">Non</td>
      <td class="text-center">28,00 m<sup>2</sup></td>
      <td class="text-center">Non</td>
      <td class="text-center">Non</td>
      <td class="text-center">${loyer}</td>
      <td class="text-center">367,97 €</td>
      <td class="text-center">0,00 €</td>
    </tr>`;

  return `
  <html><body>
    <select id="date_arrivee" name="date_arrivee">
      <option value="2026-08-01">01/08/2026</option>
      <option value="2026-08-06" selected>06/08/2026</option>
    </select>
    <script>
      $("#residence_1_logements_disponibles").html("1 logement disponible");
      $("#residence_3_logements_disponibles").html("1 logement disponible");
      $("#residence_4_logements_disponibles").html("Aucun logement disponible");
      $("#niveau_1_D_0_1_logements_disponibles").html("1 logement disponible");
      $("#niveau_3_E_C_2_logements_disponibles").html("1 logement disponible");
    </script>

    <div id="niveau_1_D_0_1_logements">
      <table><tbody>${ligne('1D112', '1D112', 'T2', 'Oui Loyer non solidaire', '2', '367,97 €')}</tbody></table>
    </div>

    <div id="niveau_3_E_C_2_logements">
      <table><tbody>${ligne('3EC201A', '3EC201', 'T1', 'Non', '1', '412,50 €')}</tbody></table>
    </div>

    <form id="action-validation_reservation" method="post">
      <input type="hidden" name="action" value="validation_reservation">
      <input type="hidden" name="keyid" id="keyid" value="">
      <input type="hidden" name="date_entree" id="date_entree" value="">
      <input type="hidden" name="date_sortie" id="date_sortie" value="">
      <input type="hidden" name="nb_occupants" id="nb_occupants" value="">
      <input type="checkbox" name="option_parking" value="1">
      <select name="civilite"><option value="M">M</option><option value="MME" selected>Mme</option></select>
      <button type="button" onclick="submit_reservation()">Valider votre réservation</button>
      <input type="submit" name="envoyer" value="Valider">
    </form>
    <div id="submit_reservation_error" style="display:none">
      <h4>VALIDATION DES INFORMATIONS IMPOSSIBLE</h4>
      <span id="submit_reservation_error_message"></span>
    </div>
  </body></html>`;
}

const PAGE = pageAvecDeuxResidences();

/* ───────────────────────────── Parsing logements ───────────────────────── */

console.log('\n▸ Lecture du tableau des logements');

test('lit les colonnes du HTML réel capturé (1D112)', () => {
  const [l] = parseLogements(SAMPLE);
  assert.equal(l.keyid, '1D112');
  assert.equal(l.code, '1D112');
  assert.equal(l.type, 'T2');
  assert.equal(l.nbOccupants, '2');
  assert.equal(l.surface, '28,00 m²');
  assert.equal(l.loyer, '367,97 €');
  assert.match(l.colocation, /Oui/);
});

test('récupère le message d\'affectation caché (date de fin de bail max)', () => {
  const l = parseLogements(PAGE).find((x) => x.keyid === '3EC201A');
  assert.match(l.messageAffectation, /31\/07\/2027/);
  // Les entités doivent être décodées, sinon on reposte "autoris&eacute;e".
  assert.ok(!l.messageAffectation.includes('&eacute;'), 'entités non décodées');
});

test('message d\'affectation trouvé même sans attribut id (name seul)', () => {
  // Variante réelle : l'ordre et la présence des attributs changent d'un
  // tableau à l'autre. Ne matcher que `id` faisait perdre la valeur en silence.
  const html = PAGE.replace(
    'id="message_affectation_3EC201A" name="message_affectation_3EC201A"',
    'name="message_affectation_3EC201A"'
  );
  const l = parseLogements(html).find((x) => x.keyid === '3EC201A');
  assert.match(l.messageAffectation, /31\/07\/2027/);
});

test('distingue keyid (code de réservation) et n° logement affiché', () => {
  const l = parseLogements(PAGE).find((x) => x.code === '3EC201');
  assert.equal(l.keyid, '3EC201A');
  assert.equal(l.checkboxId, 'check_logement_3EC201A');
});

test('RÉGRESSION — chaque ligne est rattachée à SA résidence', () => {
  // Le bug : parseLogements ramassait toutes les lignes de la page, donc une
  // dispo en Résidence III pouvait déclencher une tentative sur celle de la I.
  const all = parseLogements(PAGE);
  assert.equal(all.length, 2);
  assert.equal(all.find((l) => l.code === '1D112').residenceNum, '1');
  assert.equal(all.find((l) => l.code === '3EC201').residenceNum, '3');

  const res3 = filterByResidence(all, '3');
  assert.equal(res3.length, 1);
  assert.equal(res3[0].code, '3EC201', 'filtrage résidence III cassé');
});

test('colocation détectée par la colonne OU par le nombre d\'occupants', () => {
  const all = parseLogements(PAGE);
  assert.equal(isColocation(all.find((l) => l.code === '1D112')), true);
  assert.equal(isColocation(all.find((l) => l.code === '3EC201')), false);
});

/* ─────────────────────────── Formulaire & payload ──────────────────────── */

console.log('\n▸ Formulaire de validation');

test('lit inputs, selects, et ignore checkbox décochées et boutons', () => {
  const form = parseValidationForm(PAGE);
  const names = form.fields.map((f) => f.name);
  assert.ok(names.includes('keyid'));
  assert.ok(names.includes('civilite'), 'les <select> étaient ignorés');
  assert.equal(
    form.fields.find((f) => f.name === 'civilite').value,
    'MME',
    'option selected non retenue'
  );
  assert.ok(!names.includes('option_parking'), 'checkbox décochée envoyée à tort');
  assert.ok(!names.includes('envoyer'), 'bouton submit envoyé à tort');
});

test('RÉGRESSION — le payload ne part plus avec des champs vides', () => {
  // Le bug d'origine : le formulaire du site est vide dans le HTML (c'est son
  // JavaScript qui le remplit au clic sur le toggle). L'ancien code reposait
  // ces champs tels quels et ne renseignait que keyid → le serveur ne pouvait
  // rien enregistrer, et pourtant le bot annonçait "réservé".
  const logement = parseLogements(PAGE).find((l) => l.code === '3EC201');
  const payload = buildValidationPayload(PAGE, logement, {
    dateArrivee: '2026-08-06',
    dateSortie: '18/12/2026',
  });
  const p = new URLSearchParams(payload.body);

  assert.equal(p.get('keyid'), '3EC201A');
  assert.equal(p.get('action'), 'validation_reservation');
  assert.equal(p.get('check_logement_3EC201A'), 'on', 'le toggle du logement n\'est pas coché');
  assert.equal(p.get('date_entree'), '2026-08-06', 'date de début de bail vide');
  assert.equal(p.get('date_sortie'), '18/12/2026', 'date de fin de bail vide');
  assert.equal(p.get('nb_occupants'), '1');
  assert.match(p.get('message_affectation_3EC201A'), /31\/07\/2027/);
  assert.equal(payload.stillEmpty.length, 0, `champs encore vides: ${payload.stillEmpty}`);
});

test('n\'écrase pas une valeur déjà posée par le site', () => {
  const html = PAGE.replace(
    '<input type="hidden" name="date_sortie" id="date_sortie" value="">',
    '<input type="hidden" name="date_sortie" id="date_sortie" value="31/07/2027">'
  );
  const logement = parseLogements(html).find((l) => l.code === '3EC201');
  const payload = buildValidationPayload(html, logement, {
    dateArrivee: '2026-08-06',
    dateSortie: '18/12/2026',
  });
  assert.equal(new URLSearchParams(payload.body).get('date_sortie'), '31/07/2027');
});

test('formulaire absent → payload null (et pas un POST vide)', () => {
  assert.equal(buildValidationPayload('<html><body>rien</body></html>', { keyid: 'X' }, {}), null);
});

/* ──────────────────── Interprétation : le cœur du faux ✅ ───────────────── */

console.log('\n▸ Interprétation du résultat');

test('RÉGRESSION — une page sans "Valider votre réservation" n\'est PAS un succès', () => {
  // C'est très exactement ce qui a produit le faux "✅ RÉSERVATION PROBABLEMENT
  // CONFIRMÉE" : l'ancien code concluait au succès dès que ce libellé était
  // absent de la réponse — ce qui est le cas de n'importe quelle page d'erreur.
  const r = interpretValidationResult('<html><body><h1>Erreur interne</h1></body></html>');
  assert.notEqual(r.ok, true, 'succès déclaré sans la moindre preuve');
});

test('un message d\'erreur serveur rempli = échec, avec sa raison', () => {
  const html = '<span id="submit_reservation_error_message">Vous devez indiquer le colocataire n°2</span>';
  const r = interpretValidationResult(html);
  assert.equal(r.ok, false);
  assert.match(r.reason, /colocataire/);
});

test('le div d\'erreur vide (toujours présent, display:none) n\'est pas un échec', () => {
  const r = interpretValidationResult(PAGE);
  assert.notEqual(r.ok, false);
});

test('"aucun bien en location ou réservé" ⇒ état none', () => {
  const html = '<html><body><p>Vous n\'avez aucun bien en location ou réservé à ce jour.</p></body></html>';
  assert.equal(interpretAccountPage(html, '3EC201'), 'none');
});

test('confirmation explicite du site ⇒ état reserved', () => {
  const html = '<html><body><p>Votre réservation a bien été enregistrée.</p></body></html>';
  assert.equal(interpretAccountPage(html, '3EC201'), 'reserved');
});

test('page de login ⇒ état session (jamais confondu avec un succès)', () => {
  const html = '<html><body><div class="g-recaptcha"></div><input name="login-email"></body></html>';
  assert.equal(interpretAccountPage(html, '3EC201'), 'session');
});

test('page ambiguë ⇒ unknown (on n\'invente pas un succès)', () => {
  assert.equal(interpretAccountPage('<html><body>Bonjour</body></html>', '3EC201'), 'unknown');
});

/* ────────────────────────── Surveillance (monitor) ─────────────────────── */

console.log('\n▸ Surveillance');

test('parseAvailability lit les statuts du script inline', () => {
  const nodes = parseAvailability(PAGE);
  assert.equal(nodes.residence_1.available, true);
  assert.equal(nodes.residence_3.available, true);
  assert.equal(nodes.residence_4.available, false);
});

test('parseArrivalDates lit toutes les dates proposées', () => {
  assert.deepEqual(parseArrivalDates(PAGE), ['2026-08-01', '2026-08-06']);
});

test('decodeEntities gère les accents encodés', () => {
  assert.equal(decodeEntities('autoris&eacute;e &amp; valid&egrave;'), 'autorisée & validè');
});

/* ────────────────────────────────── Bilan ──────────────────────────────── */

console.log(`\n${failures.length ? '❌' : '✅'} ${passed} test(s) OK, ${failures.length} échec(s).\n`);
if (failures.length) process.exit(1);
