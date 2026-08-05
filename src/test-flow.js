import { chromium } from 'playwright';
import { config, URLS, STORAGE_STATE } from './config.js';
import { notify, notifyPhoto, escapeHtml } from './notify.js';

/**
 * Script de test manuel EN LECTURE SEULE : reproduit exactement la navigation
 * de reserve.js (sélection date, clic résidence, cocher aile/escalier/niveau)
 * MÊME SI le niveau choisi n'a AUCUN logement disponible — le but est de
 * vérifier que chaque clic déclenche bien le display:block attendu (cf. JS du
 * site : $(...).css('display','block') sans appel réseau), et de documenter
 * par screenshot la structure de chaque tableau intermédiaire.
 *
 * Ne clique JAMAIS "Réserver" ni "Valider votre réservation" — sûr à lancer
 * à tout moment, même sans logement réellement dispo.
 *
 * Lancer sur le VPS via :
 *   fly ssh console -a sarzal-crfugg -C "node src/test-flow.js"
 */
async function main() {
  await notify('🧪 <b>Test de flux (lecture seule, aucune réservation)</b> — démarrage…');

  const browser = await chromium.launch({
    headless: false,
    timeout: 60_000,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--headless=new',
    ],
  });
  await new Promise((r) => setTimeout(r, 300));
  if (!browser.isConnected()) {
    await notify('❌ Chromium déconnecté juste après le launch.');
    process.exit(1);
  }

  const context = await browser.newContext({ storageState: STORAGE_STATE });
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);
  page.setDefaultNavigationTimeout(30_000);

  const screenshot = async (stepName, caption) => {
    try {
      const buf = await page.screenshot({ fullPage: true, timeout: 30_000 });
      await notifyPhoto(`🧪 <b>Test ${stepName}</b>\n${caption}`, buf);
    } catch (e) {
      console.warn(`Screenshot ${stepName} échoué:`, e.message);
      await notify(`⚠️ Screenshot ${stepName} échoué : <code>${escapeHtml(e.message)}</code>`);
    }
  };

  try {
    await page.goto(URLS.reservation, { waitUntil: 'domcontentloaded' });
    if (/login/i.test(page.url())) throw new Error('SESSION_EXPIRED');
    await screenshot('A', 'Page de réservation chargée');

    await page.locator('#select2-date_arrivee-container').click({ timeout: 5000 }).catch(() => {});
    const opts = page.locator('#select2-date_arrivee-results li[id]');
    const n = await opts.count();
    if (n > 0) await opts.nth(n - 1).click();

    const dateSortieInput = page.locator('#date_sortie');
    await dateSortieInput.click({ timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(200);
    await dateSortieInput.pressSequentially(config.dateSortie, { delay: 50, timeout: 5000 }).catch(() => {});

    await Promise.all([
      page.waitForLoadState('domcontentloaded'),
      page.locator('button:has-text("Valider")').first().click({ force: true }),
    ]).catch(() => {});
    await page.waitForTimeout(1500);

    const residenceCount = await page.locator('[id^="residence_"][id$="_logements_disponibles"]').count().catch(() => 0);
    const bodyLen = (await page.content().catch(() => '')).length;
    await notify(`🧪 Diagnostic après Valider : ${residenceCount} nœud(s) résidence trouvé(s), page ${bodyLen} caractères, url=<code>${escapeHtml(page.url())}</code>`);
    await screenshot('B', 'Grille des résidences après Valider');

    // On force le test sur la Résidence III (peu importe la dispo réelle).
    const resNum = '3';
    const target = { id: `residence_${resNum}`, label: 'Résidence III (test)' };

    await page.locator(`#${target.id}`).click({ timeout: 10_000 });
    await page.waitForTimeout(1200);
    await screenshot('C', `Résidence cliquée : ${target.label}`);

    // Cette fois on prend le PREMIER bâtiment trouvé, dispo ou non (test only).
    const aileCheckbox = page.locator(`input[type="checkbox"][id^="check_batiment_${resNum}_"]`).first();
    const aileCount = await page.locator(`input[type="checkbox"][id^="check_batiment_${resNum}_"]`).count();
    if (aileCount === 0) throw new Error('Aucune case bâtiment trouvée (structure inattendue)');
    const aileId = await aileCheckbox.getAttribute('id');
    const aileNum = aileId.replace(`check_batiment_${resNum}_`, '');
    await aileCheckbox.check({ timeout: 5000, force: true });
    await page.waitForTimeout(800);
    await screenshot('D', `Aile cochée (test, sans vérifier dispo) : ${aileId}`);

    const cageCheckbox = page.locator(`input[type="checkbox"][id^="check_cage_${resNum}_${aileNum}_"]`).first();
    const cageCount = await page.locator(`input[type="checkbox"][id^="check_cage_${resNum}_${aileNum}_"]`).count();
    if (cageCount === 0) throw new Error('Aucune case cage/escalier trouvée');
    const cageId = await cageCheckbox.getAttribute('id');
    const cageIdx = cageId.replace(`check_cage_${resNum}_${aileNum}_`, '');
    await cageCheckbox.check({ timeout: 5000, force: true });
    await page.waitForTimeout(800);
    await screenshot('E', `Escalier coché (test) : ${cageId}`);

    const niveauCheckbox = page.locator(`input[type="checkbox"][id^="check_niveau_${resNum}_${aileNum}_${cageIdx}_"]`).first();
    const niveauCount = await page.locator(`input[type="checkbox"][id^="check_niveau_${resNum}_${aileNum}_${cageIdx}_"]`).count();
    if (niveauCount === 0) throw new Error('Aucune case niveau trouvée');
    const niveauId = await niveauCheckbox.getAttribute('id');
    await niveauCheckbox.check({ timeout: 5000, force: true });
    await page.waitForTimeout(1500);
    await screenshot('F', `Niveau coché (test) : ${niveauId}\nVérification : le tableau "Logements disponibles" doit être visible (display:block) même si vide ("Aucun logement...")`);

    // Vérification technique : le bloc niveau_..._logements doit être visible.
    const nivPart = niveauId.replace('check_niveau_', '');
    const logementsDiv = page.locator(`#niveau_${nivPart}_logements`);
    const isVisible = await logementsDiv.isVisible().catch(() => false);
    const text = await logementsDiv.textContent().catch(() => '(introuvable)');
    await notify(
      `🧪 <b>Résultat clic niveau</b>\n` +
      `Bloc #niveau_${nivPart}_logements visible : <b>${isVisible ? 'OUI ✅' : 'NON ❌'}</b>\n` +
      `Contenu : <code>${escapeHtml((text || '').trim().slice(0, 200))}</code>`
    );

    // On ne clique NI Réserver NI Valider — test en lecture seule uniquement.
    await notify('✅ <b>Test terminé</b> — navigation jusqu\'au niveau confirmée fonctionnelle, aucune réservation effectuée.');
  } catch (err) {
    try {
      const buf = await page.screenshot({ fullPage: true });
      await notifyPhoto(`❌ <b>Erreur test</b>\n<code>${escapeHtml(err.message)}</code>`, buf);
    } catch {}
    console.error(err);
  } finally {
    await Promise.race([
      browser.close().catch(() => {}),
      new Promise((r) => setTimeout(r, 10_000)),
    ]);
  }
}

main();
