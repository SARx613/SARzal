import { chromium } from 'playwright';
import { config, URLS, STORAGE_STATE } from './config.js';
import { notify } from './notify.js';

/**
 * RÉSERVATION AUTOMATIQUE (mode reserve) — à finaliser sur le site réel.
 *
 * Contrairement à la surveillance (HTTP pur), la réservation implique la
 * navigation interactive (select2 date_arrivee, datepicker date_sortie, clic
 * sur la résidence dispo, cases à cocher bâtiment/aile/niveau, puis Valider).
 * On la fait donc avec Playwright en réutilisant la session capturée.
 *
 * ⚠️ Ce flux est ÉCHAFAUDÉ depuis le HTML/HAR fourni mais N'A PAS encore été
 * exécuté contre une vraie dispo (il n'y en a jamais eu pendant la capture).
 * Tant que tu n'as pas validé une exécution réelle, garde MODE=alert.
 * Chaque étape capture son HTML dans config/reserve_step_*.html.
 *
 * @param {Array<{id:string,label:string,text:string}>} dispoResidences
 * @param {Object} nodes  tous les noeuds parsés (residence/batiment/cage/niveau)
 */
export async function reserve(dispoResidences, nodes) {
  const browser = await chromium.launch({ headless: config.headless });
  const context = await browser.newContext({ storageState: STORAGE_STATE });
  const page = await context.newPage();
  const dump = async (name) => {
    try {
      const p = new URL(`../config/reserve_step_${name}.html`, import.meta.url).pathname;
      const fs = await import('fs');
      fs.writeFileSync(p, await page.content());
    } catch {}
  };

  try {
    // Étape A : aller sur la page de réservation.
    await page.goto(URLS.reservation, { waitUntil: 'domcontentloaded' });
    if (/login/i.test(page.url())) throw new Error('SESSION_EXPIRED');
    await dump('A_reservation');

    // Étape B : sélectionner la dernière date d'arrivée (select2).
    await page.locator('#select2-date_arrivee-container').click({ timeout: 5000 }).catch(() => {});
    const opts = page.locator('#select2-date_arrivee-results li[id]');
    const n = await opts.count();
    if (n > 0) await opts.nth(n - 1).click();

    // Étape C : date de sortie.
    await page.locator('#date_sortie').fill(config.dateSortie, { timeout: 5000 }).catch(() => {});

    // Étape D : Valider pour charger la grille des résidences.
    await Promise.all([
      page.waitForLoadState('domcontentloaded'),
      page.locator('button:has-text("Valider")').first().click(),
    ]).catch(() => {});
    await dump('D_grille');

    // Étape E : cliquer la 1re résidence dispo, puis cocher le 1er noeud feuille dispo.
    const target = dispoResidences[0];
    await page.locator(`#${target.id}`).click({ timeout: 5000 }).catch(() => {});
    await dump('E_residence_ouverte');

    // Coche le premier checkbox d'un noeud marqué disponible (bâtiment/aile/niveau).
    const leaf = Object.keys(nodes).find(
      (id) => nodes[id].available && /^(niveau|cage|batiment)_/.test(id)
    );
    if (leaf) {
      const checkId = `#check_${leaf}`;
      await page.locator(checkId).check({ timeout: 5000 }).catch(() => {});
    }

    // Étape F : bouton Réserver final.
    await dump('F_avant_reserver');
    await Promise.all([
      page.waitForLoadState('domcontentloaded'),
      page.locator('button:has-text("Réserver")').first().click(),
    ]).catch(() => {});
    await dump('G_apres_reserver');

    await notify('✅ Tentative de réservation effectuée — VÉRIFIE sur le site que c\'est bien pris.');
  } finally {
    await browser.close();
  }
}
