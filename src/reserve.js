import { chromium } from 'playwright';
import { config, URLS, STORAGE_STATE } from './config.js';
import { notify, notifyPhoto, notifyDocument, escapeHtml } from './notify.js';

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
 * Lit le tableau "Logements disponibles" affiché après avoir coché le niveau,
 * et renvoie pour CHAQUE logement toutes ses caractéristiques + l'id de sa
 * checkbox de réservation. Tout est là, pas besoin d'aller plus loin.
 *
 * ✅ Structure CONFIRMÉE sur le HTML réel (logement 1B318, capturé le 12/07) :
 * chaque logement est une ligne <tr id="tr_logement_XXX"> avec, dans l'ordre :
 *   td[0] = <input id="check_logement_XXX"> (la colonne "Réservation ?")
 *   td[1] = N° logement       (ex. 1B318)
 *   td[2] = Type              (ex. T2)
 *   td[3] = Colocation ?      (Oui/Non + éventuellement "Loyer solidaire")
 *   td[4] = Nbr occupants
 *   td[5] = PMR ?
 *   td[6] = Surface           (ex. 28,00 m²)
 *   td[7] = Balcon ?
 *   td[8] = Boursier prioritaire ?
 *   td[9] = Loyer charges comprises  (ex. 367,97 €)
 *   td[10] = Dépôt garantie
 *   td[11] = Frais de dossier
 *
 * ⚠️ Il n'y a AUCUN bouton "Réserver" : pour réserver on coche le toggle
 * #check_logement_XXX, ce qui déclenche le JS qui affiche #formulaire_voeu.
 */
async function readLogementsDisponibles(page) {
  // Les lignes de logement portent toutes un id "tr_logement_XXX" et sont
  // injectées côté PHP uniquement quand un logement existe réellement. On ne
  // garde que celles réellement visibles (le site a plein de tables cachées en
  // display:none dans le DOM).
  const rows = page.locator('tr[id^="tr_logement_"]');
  const rowCount = await rows.count().catch(() => 0);
  const result = [];
  for (let i = 0; i < rowCount; i++) {
    const row = rows.nth(i);
    if (!(await row.isVisible().catch(() => false))) continue;

    const id = await row.getAttribute('id'); // "tr_logement_1B318"
    const code = id.replace('tr_logement_', '');
    const tds = await row.locator('td').allTextContents().catch(() => []);
    const at = (n) => (tds[n] || '').replace(/\s+/g, ' ').trim();

    result.push({
      code, // = td[1] mais on le tient déjà via l'id, plus fiable
      checkboxId: `check_logement_${code}`,
      type: at(2),
      // La cellule colocation colle "Oui"/"Non" et une mention "Loyer
      // (non) solidaire" : on insère une espace entre les deux pour lisibilité.
      colocation: at(3).replace(/(Oui|Non)(Loyer)/i, '$1 — $2'),
      nbOccupants: at(4),
      pmr: at(5),
      surface: at(6).replace(/m2\b/, 'm²'),
      balcon: at(7),
      boursier: at(8),
      loyer: at(9),
      depotGarantie: at(10),
      fraisDossier: at(11),
    });
  }
  if (result.length === 0) {
    await dumpDebugHtml(page, 'aucun_tr_logement_visible');
  }
  return result;
}

/** Formate les caractéristiques d'un logement en lignes lisibles pour Telegram. */
function formatLogementDetails(l) {
  return [
    `🔑 N° logement : ${l.code}`,
    `🏷️ Type : ${l.type}`,
    `👥 Colocation : ${l.colocation}`,
    `🔢 Nbr occupants : ${l.nbOccupants}`,
    `📐 Surface : ${l.surface}`,
    `💶 Loyer charges comprises : ${l.loyer}`,
    `🔒 Dépôt garantie : ${l.depotGarantie}`,
    `📄 Frais de dossier : ${l.fraisDossier}`,
  ].join('\n');
}

/**
 * Filet de sécurité : si la lecture du tableau "Logements disponibles" échoue
 * (structure différente de ce qui était prévu), on sauvegarde le HTML complet
 * de la page + on l'envoie sur Telegram en pièce jointe, pour pouvoir ajuster
 * les sélecteurs dès le premier cas réel au lieu de rester aveugle.
 */
async function dumpDebugHtml(page, tag) {
  try {
    const html = await page.content();
    const { writeFileSync } = await import('fs');
    const p = new URL(`../config/reserve_debug_${tag}.html`, import.meta.url).pathname;
    writeFileSync(p, html);
    await notify(
      `🐛 <b>Debug</b> : structure inattendue pour "${tag}". HTML sauvegardé sur le serveur : <code>config/reserve_debug_${tag}.html</code>`
    );
  } catch (e) {
    console.warn('[reserve] dumpDebugHtml échoué:', e.message);
  }
}

/**
 * Coche une checkbox de type "toggle switch" (pattern CSS du site : l'input
 * est imbriqué dans un <label class="switch">...<span></span></label>, le
 * <span> dessinant visuellement le rond du switch par-dessus l'input réel).
 * Cliquer directement sur l'input échoue en mode normal ("<span></span>
 * intercepts pointer events" car le span capte le clic en premier).
 * `force: true` fait déclencher l'event natif directement sur l'input sans
 * vérifier qu'il est visuellement atteignable — la page attache ses handlers
 * `change`/`click` sur l'id de l'input (ex. $("#check_cage_1_A_0").on("click",
 * ...)), donc c'est suffisant pour déclencher toute la logique JS du site
 * (affichage du tableau suivant, reset des autres cases du même niveau, etc).
 * Un clic sur le <label> parent avait été testé mais son effet ne persistait
 * pas de façon fiable (état revenu à "unchecked" après le re-render AJAX).
 */
async function checkToggle(checkbox, timeoutMs = 5000) {
  await checkbox.check({ timeout: timeoutMs, force: true });
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

  /**
   * Sauvegarde le HTML complet de la page sur le serveur (config/) pour une
   * étape donnée. Contrairement au screenshot (qui montre le rendu visuel),
   * le HTML donne directement les vrais id/class/structure — c'est ce qui a
   * permis de corriger le bug du datepicker et des toggles aile/cage/niveau.
   * Appelé systématiquement aux étapes critiques encore jamais vérifiées sur
   * un vrai logement dispo (clic "Réserver", formulaire J, après "Valider"),
   * pas seulement en cas d'erreur, pour pouvoir diagnostiquer immédiatement
   * si un sélecteur ne matche plus au premier vrai cas III/IV.
   */
  const dumpHtml = async (stepName) => {
    try {
      const html = await page.content();
      const { writeFileSync } = await import('fs');
      const filename = `reserve_step_${stepName}.html`;
      const p = new URL(`../config/${filename}`, import.meta.url).pathname;
      writeFileSync(p, html);
      await notifyDocument(`🧾 HTML étape ${stepName}`, Buffer.from(html, 'utf8'), filename);
    } catch (e) {
      console.warn(`[reserve] Dump HTML ${stepName} échoué:`, e.message);
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

    await checkToggle(aileCheckbox);
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

    await checkToggle(cageCheckbox);
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

    await checkToggle(niveauCheckbox);

    // Attendre le chargement AJAX du tableau "Logements disponibles"
    await page.waitForTimeout(2000);
    await screenshot('H', `Niveau coché : ${chemin}\nTableau "Logements disponibles" attendu`);

    // ── Étape I : lire le tableau des logements (TOUT est là) ────────────────
    // Chaque logement dispo est une ligne <tr id="tr_logement_XXX"> contenant
    // déjà code / type / colocation / occupants / surface / loyer / etc. AUCUN
    // bouton "Réserver" : la colonne "Réservation ?" est un toggle
    // #check_logement_XXX qu'on coche pour ouvrir le formulaire de validation.
    const logements = await readLogementsDisponibles(page);
    console.log(`[reserve] Logements trouvés : ${JSON.stringify(logements)}`);

    if (logements.length === 0) {
      await screenshot('I_ERREUR', '❌ Aucune ligne de logement (tr_logement_*) trouvée');
      await dumpHtml('I_ERREUR');
      throw new Error('Aucun logement lisible dans le tableau — voir HTML debug');
    }

    // Anti-doublon quotidien : on ne re-notifie pas les mêmes codes le même jour.
    const { filterNewCodes, markSeen } = await import('./seen.js');
    const newCodes = filterNewCodes(logements.map((l) => l.code));
    const notYetSeen = logements.filter((l) => newCodes.includes(l.code));
    if (notYetSeen.length === 0) {
      await notify(
        `ℹ️ <b>${chemin}</b> : logement(s) ${logements.map((l) => l.code).join(', ')} déjà notifié(s) aujourd'hui → pas de nouvelle alerte${commit ? ', pas de re-réservation' : ''}.`
      );
      return;
    }
    const chosen = notYetSeen[0];
    const details = formatLogementDetails(chosen);
    markSeen(logements.map((l) => l.code));

    await screenshot('I', `Tableau des logements — ${chosen.code}`);

    // ── Cocher le toggle du logement → ouvre le formulaire "Votre réservation
    //    de logement" (#formulaire_voeu). On fait ça DANS TOUS LES CAS :
    //    - III/IV : c'est l'étape avant de valider la réservation ;
    //    - autres : ça affiche le tableau final dont on capture le HTML, pour
    //      documenter la structure exacte (utile pour préparer une vraie
    //      réservation future). D'après le JS du site, cocher ce toggle ne fait
    //      QU'AFFICHER le formulaire (display:block) — aucun appel serveur, donc
    //      rien n'est réservé tant qu'on ne clique pas "Valider".
    const logementCheckbox = page.locator(`#${chosen.checkboxId}`);
    await checkToggle(logementCheckbox);
    await page.waitForTimeout(1500);
    await page.locator('#formulaire_voeu').waitFor({ state: 'visible', timeout: 10000 });
    await screenshot('J', 'Tableau "Votre réservation de logement"');
    await dumpHtml('J'); // HTML exact du formulaire final, envoyé sur Telegram

    // ── Hors III/IV : on s'arrête ICI, formulaire ouvert mais NON validé. ────
    if (!commit) {
      await notify(
        `🏠 <b>Logement disponible !</b>\n\n` +
        `📍 ${chemin}\n\n` +
        `${details}\n\n` +
        `ℹ️ Résidence hors III/IV → formulaire ouvert pour capture, mais je ne valide PAS.\n` +
        `👉 Pour la prendre, réserve à la main : ${URLS.reservation}`
      );
      return;
    }

    // ── III/IV : cliquer "Valider votre réservation" pour réserver réellement.
    // submit_reservation() ouvre une popup jquery-confirm dont le bouton
    // "Valider" soumet vraiment le formulaire.
    const validerBtn = page.locator('[onclick*="submit_reservation"]').first();
    await validerBtn.waitFor({ state: 'visible', timeout: 5000 });
    await validerBtn.click();
    await page.waitForTimeout(1000);

    const popupValider = page.locator('.jconfirm-buttons button:has-text("Valider")').first();
    if (await popupValider.isVisible({ timeout: 3000 }).catch(() => false)) {
      await popupValider.click();
    }

    await page.waitForTimeout(2000);
    await screenshot('K', 'Après "Valider votre réservation" — résultat final');

    await notify(
      `✅ <b>Réservation tentée !</b>\n\n` +
      `📍 ${chemin}\n\n` +
      `${details}\n\n` +
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
