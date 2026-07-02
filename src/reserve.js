import { chromium } from 'playwright';
import { config, URLS, STORAGE_STATE } from './config.js';
import { notify, notifyPhoto } from './notify.js';

/**
 * RÉSERVATION AUTOMATIQUE (mode reserve)
 *
 * Flux complet validé sur le HTML réel :
 *
 *   1. Aller sur la page de réservation
 *   2. Sélectionner la dernière date d'arrivée (select2) + date de sortie
 *   3. Cliquer "Valider" → la grille des résidences se charge
 *   4. Cliquer sur la carte de la résidence dispo (#residence_X)
 *   5. Cocher la 1re aile dispo (#check_batiment_X_Y)
 *   6. Cocher le 1er escalier dispo (#check_cage_X_Y_Z)
 *   7. Cocher le 1er niveau dispo (#check_niveau_X_Y_Z_W)
 *      → le tableau "Logements disponibles" apparaît via AJAX
 *   8. Cliquer "Réserver" dans ce tableau
 *      → le formulaire #formulaire_voeu apparaît
 *   9. Cliquer "Valider votre réservation" (submit_reservation())
 *
 * 📸 Chaque étape envoie un screenshot sur Telegram pour documentation
 *    et permet d'améliorer les sélecteurs si besoin.
 *
 * @param {Array<{id:string,label:string,text:string}>} dispoResidences
 * @param {Object} nodes  tous les nœuds parsés (residence/batiment/cage/niveau)
 */
export async function reserve(dispoResidences, nodes) {
  const browser = await chromium.launch({ headless: config.headless });
  const context = await browser.newContext({ storageState: STORAGE_STATE });
  const page = await context.newPage();

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
    await page.locator('#date_sortie').fill(config.dateSortie, { timeout: 5000 }).catch(() => {});

    // ── Étape D : Valider → grille des résidences ────────────────────────────
    await Promise.all([
      page.waitForLoadState('domcontentloaded'),
      page.locator('button:has-text("Valider")').first().click(),
    ]).catch(() => {});
    await page.waitForTimeout(800);
    await screenshot('D', 'Grille des résidences après Valider');

    // ── Étape E : cliquer sur la carte de la résidence ───────────────────────
    const target = dispoResidences[0];
    const resNum = target.id.replace('residence_', '');

    await page.locator(`#${target.id}`).click({ timeout: 5000 });
    await page.waitForTimeout(600);
    await screenshot('E', `Résidence cliquée : ${target.label}`);

    // ── Étape F : cocher la première aile disponible ─────────────────────────
    const availAile = Object.keys(nodes).find((id) =>
      new RegExp(`^batiment_${resNum}_[A-Z]$`).test(id) && nodes[id].available
    );
    if (!availAile) throw new Error(`Aucune aile disponible pour ${target.label}`);
    const aileNum = availAile.split('_')[2];

    await page.locator(`#check_${availAile}`).check({ timeout: 5000 });
    await page.waitForTimeout(600);
    await screenshot('F', `Aile cochée : Aile ${aileNum}`);

    // ── Étape G : cocher le premier escalier disponible ──────────────────────
    const availCage = Object.keys(nodes).find((id) =>
      id.startsWith(`cage_${resNum}_${aileNum}_`) && nodes[id].available
    );
    if (!availCage) throw new Error(`Aucun escalier disponible pour Aile ${aileNum}`);
    const cageIdx = availCage.split('_')[3];

    await page.locator(`#check_${availCage}`).check({ timeout: 5000 });
    await page.waitForTimeout(600);
    await screenshot('G', 'Escalier coché');

    // ── Étape H : cocher le premier niveau disponible ────────────────────────
    const availNiveau = Object.keys(nodes).find((id) =>
      id.startsWith(`niveau_${resNum}_${aileNum}_${cageIdx}_`) && nodes[id].available
    );
    if (!availNiveau) throw new Error('Aucun niveau disponible');
    const nivNum = availNiveau.split('_')[4];
    const chemin = `${target.label} › Aile ${aileNum} › Niveau R+${nivNum}`;

    await page.locator(`#check_${availNiveau}`).check({ timeout: 5000 });

    // Attendre le chargement AJAX du tableau "Logements disponibles"
    await page.waitForTimeout(2000);
    await screenshot('H', `Niveau coché : ${chemin}\nTableau "Logements disponibles" attendu`);

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

    // Cliquer "Valider votre réservation" (appelle submit_reservation() en JS)
    const validerBtn = page.locator(
      'button:has-text("Valider votre réservation"), [onclick*="submit_reservation"]'
    ).first();
    await validerBtn.waitFor({ state: 'visible', timeout: 5000 });
    await validerBtn.click();

    await page.waitForTimeout(2000);
    await screenshot('K', 'Après "Valider votre réservation" — résultat final');

    await notify(
      `✅ <b>Réservation tentée !</b>\n\n` +
      `📍 ${chemin}\n\n` +
      `⚠️ VÉRIFIE sur le site que la réservation est bien confirmée :\n${URLS.reservation}`
    );

  } catch (err) {
    // Screenshot d'erreur + notification
    try {
      const buf = await page.screenshot({ fullPage: true });
      await notifyPhoto(`❌ <b>Erreur réservation</b>\n<code>${err.message}</code>`, buf);
    } catch {}
    throw err;
  } finally {
    await browser.close();
  }
}
