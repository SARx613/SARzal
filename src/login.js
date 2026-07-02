import { chromium } from 'playwright';
import { config, URLS, STORAGE_STATE } from './config.js';

/**
 * Login SEMI-MANUEL.
 *
 * On ouvre un vrai navigateur (visible), on pré-remplit email + mot de passe,
 * et c'est TOI qui résous le reCAPTCHA et cliques "Se connecter".
 * Dès que la session est authentifiée, on sauvegarde les cookies dans
 * config/session.json. Le moniteur réutilise ensuite cette session SANS captcha.
 *
 * À relancer uniquement quand la session a expiré.
 */
async function manualLogin() {
  console.log('Ouverture du navigateur pour login manuel…');
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();

  await page.goto(URLS.login, { waitUntil: 'domcontentloaded' });

  // Pré-remplit ce qu'on peut, pour t'éviter la saisie.
  try {
    if (config.email) {
      const emailField = page.locator('input[type="email"], input[name="email"], input[name="login"]').first();
      await emailField.fill(config.email, { timeout: 3000 });
    }
    if (config.password) {
      const pwField = page.locator('input[type="password"]').first();
      await pwField.fill(config.password, { timeout: 3000 });
    }
  } catch {
    console.log('(Champs non trouvés automatiquement — remplis-les à la main, pas grave.)');
  }

  console.log('\n>>> Résous le reCAPTCHA et clique "Se connecter" dans la fenêtre. <<<');
  console.log('>>> J\'attends d\'arriver sur index.php …\n');

  // On attend que l'URL passe sur index.php (= login réussi).
  await page.waitForURL(/index\.php/, { timeout: 180000 });

  await context.storageState({ path: STORAGE_STATE });
  console.log(`✅ Session sauvegardée dans ${STORAGE_STATE}`);

  await browser.close();
}

manualLogin().catch((err) => {
  console.error('Échec du login manuel:', err);
  process.exit(1);
});
