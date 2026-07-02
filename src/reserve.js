import { chromium } from 'playwright';
import { config, URLS, STORAGE_STATE } from './config.js';
import { notify } from './notify.js';

/**
 * RÉSERVATION AUTOMATIQUE (mode reserve)
 *
 * Flux réel déduit du HTML de la page :
 *
 *   1. Aller sur la page de réservation
 *   2. Sélectionner la dernière date d'arrivée (select2) + date de sortie
 *   3. Cliquer "Valider" → la grille des résidences se charge
 *   4. Cliquer sur la carte de la résidence dispo (#residence_X)
 *   5. Cocher la 1re aile dispo (#check_batiment_X_Y)
 *   6. Cocher le 1er escalier dispo (#check_cage_X_Y_Z)
 *   7. Cocher le 1er niveau dispo (#check_niveau_X_Y_Z_W)
 *      → déclenche le chargement AJAX du tableau "Logements disponibles"
 *   8. Cliquer le bouton "Réserver" dans ce tableau
 *
 * ⚠️ Chaque étape dumpe le HTML dans config/reserve_step_*.html pour debug.
 *
 * @param {Array<{id:string,label:string,text:string}>} dispoResidences
 * @param {Object} nodes  tous les nœuds parsés (residence/batiment/cage/niveau)
 */
export async function reserve(dispoResidences, nodes) {
  const browser = await chromium.launch({ headless: config.headless });
  const context = await browser.newContext({ storageState: STORAGE_STATE });
  const page = await context.newPage();

  const dump = async (name) => {
    try {
      const p = new URL(`../config/reserve_step_${name}.html`, import.meta.url).pathname;
      const { writeFileSync } = await import('fs');
      writeFileSync(p, await page.content());
    } catch {}
  };

  try {
    // ── Étape A : page de réservation ────────────────────────────────────────
    await page.goto(URLS.reservation, { waitUntil: 'domcontentloaded' });
    if (/login/i.test(page.url())) throw new Error('SESSION_EXPIRED');
    await dump('A_reservation');

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
    await dump('D_grille');

    // ── Étape E : cliquer sur la carte de la résidence ───────────────────────
    const target = dispoResidences[0];
    const resNum = target.id.replace('residence_', '');

    await page.locator(`#${target.id}`).click({ timeout: 5000 });
    await page.waitForTimeout(600);
    await dump('E_residence_cliquee');

    // ── Étape F : cocher la première aile disponible ─────────────────────────
    const availAile = Object.keys(nodes).find((id) =>
      new RegExp(`^batiment_${resNum}_[A-Z]$`).test(id) && nodes[id].available
    );
    if (!availAile) throw new Error(`Aucune aile disponible pour ${target.label}`);
    const aileNum = availAile.split('_')[2];

    await page.locator(`#check_${availAile}`).check({ timeout: 5000 });
    await page.waitForTimeout(600);
    await dump('F_aile_cochee');

    // ── Étape G : cocher le premier escalier disponible ──────────────────────
    const availCage = Object.keys(nodes).find((id) =>
      id.startsWith(`cage_${resNum}_${aileNum}_`) && nodes[id].available
    );
    if (!availCage) throw new Error(`Aucun escalier disponible pour Aile ${aileNum}`);
    const cageIdx = availCage.split('_')[3];

    await page.locator(`#check_${availCage}`).check({ timeout: 5000 });
    await page.waitForTimeout(600);
    await dump('G_cage_cochee');

    // ── Étape H : cocher le premier niveau disponible ────────────────────────
    const availNiveau = Object.keys(nodes).find((id) =>
      id.startsWith(`niveau_${resNum}_${aileNum}_${cageIdx}_`) && nodes[id].available
    );
    if (!availNiveau) throw new Error(`Aucun niveau disponible`);
    const nivNum = availNiveau.split('_')[4];

    await page.locator(`#check_${availNiveau}`).check({ timeout: 5000 });

    // Attendre le tableau AJAX "Logements disponibles" (peut prendre 1-2 s)
    await page.waitForTimeout(1500);
    await dump('H_niveau_coche');

    // ── Étape I : cliquer "Réserver" dans le tableau ──────────────────────────
    const reserverBtn = page.locator(
      'button:has-text("Réserver"), a:has-text("Réserver"), input[value="Réserver"]'
    ).first();

    await reserverBtn.waitFor({ state: 'visible', timeout: 10000 });
    await dump('I_avant_reserver');

    await Promise.all([
      page.waitForLoadState('domcontentloaded'),
      reserverBtn.click(),
    ]);
    await dump('J_apres_reserver');

    const chemin = `${target.label} › Aile ${aileNum} › Niveau R+${nivNum}`;
    await notify(
      `✅ <b>Réservation tentée !</b>\n\n` +
      `📍 ${chemin}\n\n` +
      `⚠️ VÉRIFIE sur le site que c'est bien confirmé : ${URLS.reservation}`
    );
  } catch (err) {
    await dump('ERROR');
    throw err;
  } finally {
    await browser.close();
  }
}
