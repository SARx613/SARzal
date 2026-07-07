import { chromium } from 'playwright';
import { config, URLS, STORAGE_STATE } from './config.js';
import { notify, notifyPhoto, escapeHtml } from './notify.js';

/**
 * Script de test manuel : vérifie que Chromium peut se lancer, se connecter
 * avec le cookie de session, ouvrir la page de réservation et prendre une
 * capture — sans attendre une vraie disponibilité. À lancer à la demande
 * sur le VPS via :
 *   fly ssh console -a sarzal -C "node src/test-browser.js"
 */
async function main() {
  await notify('🧪 Test manuel : lancement de Chromium…');

  const browser = await chromium.launch({
    headless: false, // le vrai mode headless vient de --headless=new dans args
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
    await notify('❌ Test échoué : Chromium déconnecté juste après le launch.');
    process.exit(1);
  }
  await notify('✅ Chromium lancé et connecté.');

  try {
    const context = await browser.newContext({ storageState: STORAGE_STATE });
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    page.setDefaultNavigationTimeout(20_000);

    // Étape 0 : d'abord un site simple, sans rien de spécifique à CESAL, pour
    // isoler si le blocage vient du réseau/Playwright en général ou du site CESAL.
    await notify('🌐 Test 1/2 : navigation vers example.com (site simple)…');
    await page.goto('https://example.com', { waitUntil: 'domcontentloaded' });
    await notify(`✅ example.com chargé : <code>${escapeHtml(await page.title())}</code>`);

    // Étape 1 : la vraie page CESAL.
    await notify('🌐 Test 2/2 : navigation vers la page de réservation CESAL…');
    await page.goto(URLS.reservation, { waitUntil: 'domcontentloaded' });
    const url = page.url();
    await notify(`🌐 Page chargée : <code>${escapeHtml(url)}</code>`);

    if (/login/i.test(url)) {
      await notify('🔐 Redirigé vers le login → session expirée, relance npm run login.');
    }

    const buf = await page.screenshot({ fullPage: true });
    await notifyPhoto('🧪 Test manuel — capture de la page de réservation', buf);

    await notify('✅ Test terminé avec succès.');
  } catch (err) {
    await notify(`❌ Test échoué : <code>${escapeHtml(err.message)}</code>`);
  } finally {
    await Promise.race([
      browser.close().catch(() => {}),
      new Promise((r) => setTimeout(r, 10_000)),
    ]);
  }
}

main().then(() => process.exit(0));
