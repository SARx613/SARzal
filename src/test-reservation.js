/**
 * Test de bout en bout du flux de réservation, contre un FAUX serveur CESAL
 * local. Aucune connexion au vrai site, aucun compte, aucun navigateur.
 *
 * C'est le test qui manquait le plus : les parseurs pouvaient être corrects
 * individuellement et le bot annoncer quand même une réservation qui n'a pas
 * eu lieu, parce que personne ne vérifiait le RÉSULTAT. On rejoue donc ici les
 * trois situations réelles :
 *
 *   1. le serveur accepte  → le compte affiche le logement → ✅ légitime ;
 *   2. le serveur ignore le POST (payload incomplet, exactement le scénario du
 *      04/08/2026) → le compte est toujours vide → ❌ annoncé, PAS de faux ✅ ;
 *   3. le serveur refuse avec un message → ❌ annoncé avec la raison exacte.
 *
 *   node src/test-reservation.js
 */
import http from 'http';
import assert from 'assert';

const PORT = 8731;
process.env.CESAL_BASE_URL = `http://127.0.0.1:${PORT}`;
process.env.MODE = 'reserve';
process.env.DATE_SORTIE = '18/12/2026';
process.env.BROWSER_FALLBACK = 'false'; // pas de Chromium dans un test
process.env.MAX_RESERVE_ATTEMPTS = '5';
process.env.TELEGRAM_BOT_TOKEN = '';    // notify() reste en mode log
process.env.TELEGRAM_CHAT_ID = '';

const { handleAvailability } = await import('./reserve-http.js');

/* ─────────────────────────── Faux serveur CESAL ─────────────────────────── */

const PAGE_DISPO = `<html><body>
  <script>
    $("#residence_3_logements_disponibles").html("1 logement disponible");
    $("#niveau_3_E_C_2_logements_disponibles").html("1 logement disponible");
  </script>
  <div id="niveau_3_E_C_2_logements"><table><tbody>
    <tr id="tr_logement_3EC201A">
      <td><label><input type="checkbox" id="check_logement_3EC201A" name="check_logement_3EC201A"><span></span></label>
          <input type="hidden" name="message_affectation_3EC201A" id="message_affectation_3EC201A" value="La date de fin de bail maximale autoris&eacute;e pour ce logement est le 31/07/2027"></td>
      <td>3EC201</td><td>T1</td><td>Non</td><td>1</td><td>Non</td>
      <td>28,00 m<sup>2</sup></td><td>Non</td><td>Non</td>
      <td>412,50 €</td><td>412,50 €</td><td>0,00 €</td>
    </tr>
  </tbody></table></div>
  <form id="action-validation_reservation" method="post">
    <input type="hidden" name="action" value="validation_reservation">
    <input type="hidden" name="keyid" value="">
    <input type="hidden" name="date_entree" value="">
    <input type="hidden" name="date_sortie" value="">
    <input type="hidden" name="nb_occupants" value="">
    <button onclick="submit_reservation()">Valider votre réservation</button>
  </form>
  <div id="submit_reservation_error" style="display:none">
    <h4>VALIDATION DES INFORMATIONS IMPOSSIBLE</h4><span id="submit_reservation_error_message"></span>
  </div>
</body></html>`;

const COMPTE_VIDE = `<html><body><h3>Mon logement</h3>
  <p>Vous n'avez aucun bien en location ou réservé à ce jour.</p>${PAGE_DISPO}</body></html>`;

const COMPTE_RESERVE = `<html><body><h3>Mon logement</h3>
  <p>Votre réservation a bien été enregistrée pour le logement 3EC201.</p></body></html>`;

/** `behaviour` pilote la réponse du faux serveur pour chaque scénario. */
let behaviour = 'accept';
let reservationPrise = false;
let dernierPost = null;

const server = http.createServer((req, res) => {
  if (req.method === 'GET') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(reservationPrise ? COMPTE_RESERVE : COMPTE_VIDE);
    return;
  }
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    dernierPost = new URLSearchParams(body);
    if (behaviour === 'accept') {
      // Le vrai site n'enregistre que si le formulaire est COMPLET : c'est
      // précisément ce que l'ancien payload n'était pas.
      const complet =
        dernierPost.get('keyid') === '3EC201A' &&
        dernierPost.get('date_entree') &&
        dernierPost.get('date_sortie') &&
        dernierPost.get('check_logement_3EC201A') === 'on';
      if (complet) reservationPrise = true;
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(reservationPrise ? COMPTE_RESERVE : '<html><body>Retour accueil</body></html>');
    } else if (behaviour === 'silent') {
      // Le POST part, le serveur répond une page quelconque, et rien n'est pris.
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<html><body><h1>Espace résident</h1></body></html>');
    } else {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(`<html><body><div id="submit_reservation_error">
        <span id="submit_reservation_error_message">Vous devez indiquer le colocataire n°2</span>
      </div></body></html>`);
    }
  });
});

await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

/* ──────────────────────────────── Scénarios ─────────────────────────────── */

const messages = [];
const origLog = console.log;
console.log = (...a) => {
  const s = a.join(' ');
  if (s.startsWith('[NOTIFY]')) messages.push(s);
  origLog(...a);
};

let passed = 0;
const failures = [];
async function scenario(name, fn) {
  messages.length = 0;
  reservationPrise = false;
  dernierPost = null;
  // État quotidien remis à zéro entre les scénarios.
  const { rmSync } = await import('fs');
  rmSync(new URL('../config/seen_logements.json', import.meta.url).pathname, { force: true });
  try {
    await fn();
    passed++;
    origLog(`  ✅ ${name}`);
  } catch (err) {
    failures.push(name);
    origLog(`  ❌ ${name}\n     ${err.message}`);
  }
}

const residence = { id: 'residence_3', label: 'Résidence III' };
const run = () =>
  handleAvailability(PAGE_DISPO, 'PHPSESSID=fake', {
    residence,
    chemin: 'Résidence III › Aile E › Escalier C › Niveau R+2',
    commit: true,
    dateArrivee: '2026-08-06',
  });

const dit = (re) => messages.some((m) => re.test(m));

origLog('\n▸ Flux complet contre un faux serveur CESAL\n');

await scenario('serveur qui accepte → ✅ confirmé, et le POST était complet', async () => {
  behaviour = 'accept';
  const r = await run();
  assert.equal(r.reserved, true, 'la réservation aurait dû être confirmée');
  assert.equal(dernierPost.get('keyid'), '3EC201A');
  assert.equal(dernierPost.get('date_entree'), '2026-08-06');
  assert.equal(dernierPost.get('date_sortie'), '18/12/2026');
  assert.equal(dernierPost.get('check_logement_3EC201A'), 'on');
  assert.match(dernierPost.get('message_affectation_3EC201A'), /31\/07\/2027/);
  assert.ok(dit(/RÉSERVATION CONFIRMÉE/), 'pas de message de confirmation');
});

await scenario('serveur qui ignore le POST → ❌ annoncé, JAMAIS un faux ✅', async () => {
  // Reproduction exacte du 04/08/2026 : le POST part, la réponse n'a rien de
  // reconnaissable, et rien n'est réservé.
  behaviour = 'silent';
  const r = await run();
  assert.equal(r.reserved, false);
  assert.ok(!dit(/RÉSERVATION CONFIRMÉE/), 'FAUX SUCCÈS annoncé — la régression est revenue');
  assert.ok(dit(/RÉSERVATION NON CONFIRMÉE/), 'l\'échec n\'a pas été annoncé');
  assert.ok(dit(/RÉSERVE À LA MAIN/), 'pas d\'appel à réserver à la main');
});

await scenario('serveur qui refuse avec un message → la raison est remontée', async () => {
  behaviour = 'refuse';
  const r = await run();
  assert.equal(r.reserved, false);
  assert.ok(dit(/colocataire/), 'la raison du refus n\'a pas été transmise');
});

await scenario('échec puis nouvelle chance : le bot RETENTE au cycle suivant', async () => {
  // Le bug historique : la 1re tentative marquait le logement "vu", donc plus
  // aucune tentative ni alerte de la journée. Ici, la 2e passe doit bien
  // reposter (le serveur accepte cette fois) et confirmer.
  behaviour = 'silent';
  const r1 = await run();
  assert.equal(r1.reserved, false);
  behaviour = 'accept';
  const r2 = await run();
  assert.equal(r2.reserved, true, 'le bot n\'a pas retenté après un échec');
});

await scenario('plafond de tentatives respecté (pas de martèlement)', async () => {
  behaviour = 'silent';
  for (let i = 0; i < 5; i++) await run();
  const avant = dernierPost;
  dernierPost = null;
  await run(); // 6e passe : doit être refusée par le plafond
  assert.equal(dernierPost, null, 'le plafond de tentatives n\'est pas respecté');
  assert.ok(avant, 'aucune tentative n\'a été faite');
});

console.log = origLog;
server.close();

console.log(`\n${failures.length ? '❌' : '✅'} ${passed} scénario(s) OK, ${failures.length} échec(s).\n`);
process.exit(failures.length ? 1 : 0);
