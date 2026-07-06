import { chromium } from 'playwright';
import { config, URLS, STORAGE_STATE } from './config.js';
import { notify, notifyPhoto, escapeHtml } from './notify.js';

/**
 * RÉSERVATION AUTOMATIQUE (mode reserve)
 *
 * Flux complet validé sur le HTML réel :
 *
 *   1. Aller sur la page de réservation
 *   2. Sélectionner la dernière date d'arrivée (select2) + date de sortie
 *   3. Cliquer "Valider" → la grille des résidences se charge
 *   4. Cliquer sur la carte de la résidence dispo (#residence_X)
 *   5. Cocher la 1re aile dispo  ← découverte LIVE depuis la page
 *   6. Cocher le 1er escalier dispo  ← découverte LIVE
 *   7. Cocher le 1er niveau dispo  ← découverte LIVE
 *      → le tableau "Logements disponibles" apparaît via AJAX
 *   8. Cliquer "Réserver" dans ce tableau
 *      → le formulaire #formulaire_voeu apparaît
 *   9. Cliquer "Valider votre réservation" (submit_reservation())
 *
 * ⚠️  Les nœuds batiment/cage/niveau ne sont PAS dans `nodes` (ils sont chargés
 *     en AJAX uniquement quand on clique sur une résidence dans le navigateur).
 *     On les découvre donc directement depuis la page Playwright.
 *
 * 📸 Chaque étape envoie un screenshot sur Telegram pour documentation
 *    et permet d'améliorer les sélecteurs si besoin.
 *
 * @param {Array<{id:string,label:string,text:string}>} dispoResidences
 * @param {Object} _nodes  ignoré — les sous-niveaux sont découverts live sur la page
 * @param {{commit?: boolean}} [opts]  commit=true → va jusqu'à "Valider votre
 *        réservation". commit=false → s'arrête AVANT (navigation + captures
 *        seulement, aucune réservation réelle). Utilisé pour les résidences
 *        hors III/IV où l'on veut juste documenter la dispo par captures.
 */

/**
 * Trouve la première checkbox visible+activée dont l'id commence par `prefix`.
 * Retourne { checkbox, id } ou null si aucune n'est trouvée avant le timeout.
 */
async function findFirstCheckbox(page, prefix, timeoutMs = 6000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const all = page.locator(`input[type="checkbox"][id^="${prefix}"]`);
    const count = await all.count().catch(() => 0);
    for (let i = 0; i < count; i++) {
      const el = all.nth(i);
      const visible = await el.isVisible().catch(() => false);
      const enabled = await el.isEnabled().catch(() => false);
      if (!visible || !enabled) continue;

      const id = await el.getAttribute('id');

      // L'indicateur de dispo est un <h6 id="{nodeId}_logements_disponibles">
      // ex: check_cage_5_A_N → cage_5_A_N_logements_disponibles
      const nodeId = id.replace(/^check_/, '');
      const statusEl = page.locator(`#${nodeId}_logements_disponibles`);
      const statusText = await statusEl.textContent().catch(() => null);

      // Si l'élément n'existe pas encore ou est vide → données pas encore chargées
      if (statusText === null || statusText.trim() === '') continue;

      // Si "Aucun logement disponible" → on passe à la suivante
      if (/aucun logement/i.test(statusText)) continue;

      // Logement dispo ! On retourne cette checkbox.
      console.log(`[reserve] Dispo trouvée : ${id} — "${statusText.trim()}"`);
      return { checkbox: el, id };
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return null;
}

/**
 * Lance Chromium avec les args nécessaires en conteneur, avec vérification
 * de connexion + 1 retry. `--single-process`/`--no-zygote` ont été retirés :
 * ils sont connus pour crasher Chromium silencieusement peu après le launch
 * sur certains noyaux Linux (le process meurt entre `launch()` et le premier
 * appel suivant, ex. `newContext()` → "Target ... has been closed").
 *
 * ⚠️ Quand `headless: true` est passé à `chromium.launch()`, Playwright choisit
 * TOUJOURS le binaire allégé `chrome-headless-shell` — peu importe les `args`
 * fournis, ce choix ne dépend QUE du flag `headless` de l'API, pas des args.
 * Sur le site CESAL (jQuery/select2/AJAX), ce shell est resté connecté mais
 * bloquait silencieusement sur `page.goto()` (jamais résolu, jamais d'erreur).
 * Pour forcer le vrai binaire Chromium en mode headless, il faut passer
 * `headless: false` à l'API ET ajouter `--headless=new` dans les args (c'est
 * ce flag qui active le vrai mode headless du binaire complet).
 */
async function launchBrowser() {
  const LAUNCH_ARGS = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--headless=new',
  ];
  for (let attempt = 1; attempt <= 2; attempt++) {
    const browser = await chromium.launch({
      headless: false, // le vrai mode headless vient de --headless=new dans args
      timeout: 60_000,
      args: LAUNCH_ARGS,
    });
    // Chromium peut crasher juste après le launch (OOM, incompatibilité noyau).
    // On laisse un court délai puis on vérifie explicitement la connexion avant
    // de continuer, plutôt que de découvrir le crash au prochain appel Playwright.
    await new Promise((r) => setTimeout(r, 300));
    if (browser.isConnected()) return browser;
    console.warn(`[reserve] Chromium déconnecté juste après launch (tentative ${attempt}/2)`);
    await browser.close().catch(() => {});
    if (attempt === 2) {
      throw new Error('CHROMIUM_CRASH (déconnecté juste après le launch, 2 tentatives)');
    }
  }
}

export async function reserve(dispoResidences, _nodes, opts = {}) {
  const { commit = true } = opts;
  await notify('🌐 Ouverture du navigateur pour la réservation…');
  const browser = await launchBrowser();
  browser.on('disconnected', () => console.warn('[reserve] Événement: navigateur déconnecté'));
  const context = await browser.newContext({ storageState: STORAGE_STATE });
  const page = await context.newPage();
  // Timeout par défaut raisonnable pour toutes les actions Playwright.
  page.setDefaultTimeout(15_000);
  page.setDefaultNavigationTimeout(30_000);

  /** Prend un screenshot et l'envoie sur Telegram + le sauvegarde localement. */
  const screenshot = async (stepName, caption) => {
    try {
      const buf = await page.screenshot({ fullPage: true });
      // Envoi Telegram
      await notifyPhoto(`📸 <b>Étape ${stepName}</b>\n${caption}`, buf);
      // Sauvegarde locale pour debug
      const { writeFileSync } = await import('fs');
      const p = new URL(`../config/reserve_step_${stepName}.png`, import.meta.url).pathname;
      writeFileSync(p, buf);
    } catch (e) {
      console.warn(`[reserve] Screenshot ${stepName} échoué:`, e.message);
    }
  };

  try {
    // ── Étape A : page de réservation ────────────────────────────────────────
    await page.goto(URLS.reservation, { waitUntil: 'domcontentloaded' });
    if (/login/i.test(page.url())) throw new Error('SESSION_EXPIRED');
    await screenshot('A', 'Page de réservation chargée');

    // ── Étape B : sélectionner la dernière date d'arrivée (select2) ──────────
    await page.locator('#select2-date_arrivee-container').click({ timeout: 5000 }).catch(() => {});
    const opts = page.locator('#select2-date_arrivee-results li[id]');
    const n = await opts.count();
    if (n > 0) await opts.nth(n - 1).click();

    // ── Étape C : date de sortie ──────────────────────────────────────────────
    // ⚠️ Le champ #date_sortie est géré par bootstrap-datepicker. `.fill()` pose
    // la valeur dans le DOM mais le plugin la vide/invalide avant le submit natif
    // du formulaire (constaté en live : la page relue après "Valider" affiche
    // "la date de fin de bail ne peut pas être vide"). Taper la date au clavier
    // (comme un vrai utilisateur) déclenche les events internes du plugin et la
    // valeur est bien conservée jusqu'au submit.
    const dateSortieInput = page.locator('#date_sortie');
    await dateSortieInput.click({ timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(200);
    await dateSortieInput.pressSequentially(config.dateSortie, { delay: 50, timeout: 5000 }).catch(() => {});

    // ── Étape D : Valider → grille des résidences ────────────────────────────
    // `force: true` car le popup calendrier du datepicker peut rester ouvert et
    // intercepter le clic normal (l'élément "Valider" est alors masqué dessous).
    await Promise.all([
      page.waitForLoadState('domcontentloaded'),
      page.locator('button:has-text("Valider")').first().click({ force: true }),
    ]).catch(() => {});
    await page.waitForTimeout(800);
    await screenshot('D', 'Grille des résidences après Valider');

    // ── Étape E : cliquer sur la carte de la résidence ───────────────────────
    const target = dispoResidences[0];
    const resNum = target.id.replace('residence_', '');

    await page.locator(`#${target.id}`).click({ timeout: 5000 });
    // Laisser le temps aux cases batiment de s'afficher via AJAX
    await page.waitForTimeout(1200);
    await screenshot('E', `Résidence cliquée : ${target.label}`);

    // ── Étape F : cocher la première aile disponible (découverte live) ────────
    // Les cases #check_batiment_N_X sont injectées en AJAX après le clic résidence.
    const aileResult = await findFirstCheckbox(page, `check_batiment_${resNum}_`);
    if (!aileResult) {
      await screenshot('F_ERREUR', '❌ Aucune case batiment trouvée sur la page');
      throw new Error(`Aucune aile trouvée sur la page pour ${target.label}`);
    }
    const { checkbox: aileCheckbox, id: aileId } = aileResult;
    // L'id est "check_batiment_N_X" → on extrait la lettre de l'aile
    const aileNum = aileId.replace(`check_batiment_${resNum}_`, '');
    console.log(`[reserve] Aile trouvée : ${aileId}`);

    await aileCheckbox.check({ timeout: 5000 });
    await page.waitForTimeout(800);
    await screenshot('F', `Aile cochée : Aile ${aileNum}`);

    // ── Étape G : cocher le premier escalier disponible (découverte live) ─────
    const cageResult = await findFirstCheckbox(page, `check_cage_${resNum}_${aileNum}_`);
    if (!cageResult) {
      await screenshot('G_ERREUR', '❌ Aucune case cage/escalier trouvée sur la page');
      throw new Error(`Aucun escalier trouvé sur la page pour Aile ${aileNum}`);
    }
    const { checkbox: cageCheckbox, id: cageId } = cageResult;
    const cageIdx = cageId.replace(`check_cage_${resNum}_${aileNum}_`, '');
    console.log(`[reserve] Cage trouvée : ${cageId}`);

    await cageCheckbox.check({ timeout: 5000 });
    await page.waitForTimeout(800);
    await screenshot('G', `Escalier coché : escalier ${cageIdx}`);

    // ── Étape H : cocher le premier niveau disponible (découverte live) ───────
    const niveauResult = await findFirstCheckbox(page, `check_niveau_${resNum}_${aileNum}_${cageIdx}_`);
    if (!niveauResult) {
      await screenshot('H_ERREUR', '❌ Aucune case niveau trouvée sur la page');
      throw new Error('Aucun niveau trouvé sur la page');
    }
    const { checkbox: niveauCheckbox, id: niveauId } = niveauResult;
    const nivNum = niveauId.replace(`check_niveau_${resNum}_${aileNum}_${cageIdx}_`, '');
    const chemin = `${target.label} › Aile ${aileNum} › Escalier ${cageIdx} › Niveau R+${nivNum}`;
    console.log(`[reserve] Niveau trouvé : ${niveauId}`);

    await niveauCheckbox.check({ timeout: 5000 });

    // Attendre le chargement AJAX du tableau "Logements disponibles"
    await page.waitForTimeout(2000);
    await screenshot('H', `Niveau coché : ${chemin}\nTableau "Logements disponibles" attendu`);

    // ── Mode "captures seulement" (résidences hors III/IV) ────────────────────
    // On a documenté toute la navigation jusqu'au tableau des logements, mais on
    // NE clique NI "Réserver" NI "Valider" : aucune réservation réelle n'est faite.
    if (!commit) {
      await notify(
        `📸 <b>Captures terminées (pas de réservation)</b>\n\n` +
        `📍 ${chemin}\n\n` +
        `ℹ️ Cette résidence n'est pas III/IV → je n'ai rien réservé.\n` +
        `👉 Si tu veux la prendre, réserve à la main : ${URLS.reservation}`
      );
      return;
    }

    // ── Étape I : cliquer "Réserver" dans le tableau ──────────────────────────
    // On essaie plusieurs sélecteurs car le texte exact peut varier
    const reserverSelectors = [
      'button:has-text("Réserver")',
      'a:has-text("Réserver")',
      'input[value="Réserver"]',
      'button:has-text("réserver")',
      '[onclick*="reserver"]',
      '[onclick*="Reserver"]',
      '.btn:has-text("Réser")',
    ];
    let reserverBtn = null;
    for (const sel of reserverSelectors) {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 2000 }).catch(() => false)) {
        reserverBtn = el;
        console.log(`[reserve] Bouton Réserver trouvé avec : ${sel}`);
        break;
      }
    }

    if (!reserverBtn) {
      await screenshot('I_ERREUR', '❌ Bouton "Réserver" introuvable dans le tableau');
      throw new Error('Bouton Réserver introuvable — voir screenshot étape I_ERREUR');
    }

    await screenshot('I', 'Tableau "Logements disponibles" — bouton Réserver trouvé');
    await reserverBtn.click();
    await page.waitForTimeout(1500);
    await screenshot('I2', 'Après clic Réserver — formulaire de confirmation attendu');

    // ── Étape J : formulaire de confirmation #formulaire_voeu ─────────────────
    // Attendre que le formulaire de confirmation soit visible
    await page.locator('#formulaire_voeu').waitFor({ state: 'visible', timeout: 10000 });
    await screenshot('J', 'Formulaire "Votre réservation de logement" — détails du logement');

    // Extraction des caractéristiques du logement affichées dans le tableau
    // "Votre réservation de logement" (#tr_formulaire_voeu). Les <td> n'ont pas
    // d'id individuel : on les récupère par position, dans l'ordre des <th>
    // (Type logement / Colocation / Nbr occupants / PMR / Surface / Balcon /
    // Boursier prioritaire / Loyer charges comprises / Dépôt garantie / Frais
    // de dossier).
    const logementInfo = await page.locator('#tr_formulaire_voeu td').allTextContents()
      .then((tds) => ({
        typeLogement: tds[0]?.trim() || '',
        colocation: tds[1]?.trim() || '',
        nbOccupants: tds[2]?.trim() || '',
        pmr: tds[3]?.trim() || '',
        surface: tds[4]?.trim() || '',
        balcon: tds[5]?.trim() || '',
        boursier: tds[6]?.trim() || '',
        loyer: tds[7]?.trim() || '',
        depotGarantie: tds[8]?.trim() || '',
        fraisDossier: tds[9]?.trim() || '',
      }))
      .catch(() => null);

    // Cliquer "Valider votre réservation" (appelle submit_reservation() en JS)
    const validerBtn = page.locator(
      'button:has-text("Valider votre réservation"), [onclick*="submit_reservation"]'
    ).first();
    await validerBtn.waitFor({ state: 'visible', timeout: 5000 });
    await validerBtn.click();

    await page.waitForTimeout(2000);
    await screenshot('K', 'Après "Valider votre réservation" — résultat final');

    const detailsLines = logementInfo
      ? [
          `🏷️ Type : ${logementInfo.typeLogement}`,
          `👥 Colocation : ${logementInfo.colocation}`,
          `🔢 Nbr occupants : ${logementInfo.nbOccupants}`,
          `📐 Surface : ${logementInfo.surface}`,
          `💶 Loyer charges comprises : ${logementInfo.loyer}`,
          `🔒 Dépôt garantie : ${logementInfo.depotGarantie}`,
          `📄 Frais de dossier : ${logementInfo.fraisDossier}`,
        ].join('\n')
      : '⚠️ Détails du logement non récupérés (structure de page inattendue).';

    await notify(
      `✅ <b>Réservation tentée !</b>\n\n` +
      `📍 ${chemin}\n\n` +
      `${detailsLines}\n\n` +
      `⚠️ VÉRIFIE sur le site que la réservation est bien confirmée :\n${URLS.reservation}`
    );

  } catch (err) {
    // Screenshot d'erreur + notification
    try {
      const buf = await page.screenshot({ fullPage: true });
      await notifyPhoto(`❌ <b>Erreur réservation</b>\n<code>${escapeHtml(err.message)}</code>`, buf);
    } catch {}
    throw err;
  } finally {
    // Fermeture protégée : ne jamais rester bloqué sur close() (browser zombie).
    await Promise.race([
      browser.close().catch(() => {}),
      new Promise((r) => setTimeout(r, 10_000)),
    ]);
  }
}
