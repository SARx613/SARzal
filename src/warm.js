import { chromium } from 'playwright';
import { config, URLS, STORAGE_STATE } from './config.js';

/**
 * FENÊTRE PRÉCHAUFFÉE ("warm window") — optimisation LOCALE uniquement.
 *
 * Le problème : jusqu'ici, Chromium n'était lancé qu'au moment où un logement
 * était détecté. Mesuré sur cette machine, arriver jusqu'à la page de
 * réservation utilisable coûte ~2,8 s à froid (~0,7 s de démarrage Chromium,
 * ~2,1 s de chargement de page). Sur un logement rare qui part en quelques
 * secondes, c'est le maillon le plus cher de toute la chaîne — et il est payé
 * exactement au pire moment.
 *
 * L'idée : garder en permanence, en local, UNE fenêtre déjà ouverte, déjà
 * authentifiée et déjà posée sur la page de réservation. La surveillance
 * continue de se faire en HTTP pur (rapide, léger, inchangé) ; quand elle
 * trouve quelque chose, `reserve()` se branche sur cette fenêtre déjà chaude
 * au lieu d'en démarrer une.
 *
 * ⚠️ Ce module ne s'active QUE si WARM_WINDOW=true. Sur le VPS (pas d'écran,
 * mémoire limitée), il reste éteint et le comportement est strictement celui
 * d'avant : `reserve()` lance son propre navigateur et le referme.
 *
 * ⚠️ On ne recharge PAS la page toutes les 3 s pour "suivre" les dispos : ce
 * serait plus lent que le fetch HTTP actuel (une page complète vs quelques ms)
 * et bien plus visible côté serveur. Le rafraîchissement ici a un seul but,
 * beaucoup plus espacé : garder la session vivante et le DOM prêt à l'emploi.
 */

/** Handle de la fenêtre chaude courante. null = aucune (mode VPS / désactivé). */
let warm = null;

/** Évite deux préchauffages simultanés (démarrage + rafraîchissement). */
let starting = null;

/**
 * Intervalle de rafraîchissement de la page chaude. Volontairement long : il
 * ne sert PAS à détecter les dispos (c'est le rôle du fetch HTTP), seulement à
 * empêcher la session de s'endormir et à garder un DOM frais.
 */
const REFRESH_MS = Math.max(30, parseInt(process.env.WARM_REFRESH_SECONDS || '120', 10)) * 1000;

function log(msg) {
  console.log(`[warm] ${msg}`);
}

/**
 * Ouvre la fenêtre et l'amène sur la page de réservation.
 * Renvoie { browser, context, page } ou lève.
 */
async function open() {
  const args = config.showBrowser
    ? ['--start-maximized']
    : ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--headless=new'];

  const browser = await chromium.launch({
    headless: false, // en mode invisible, c'est --headless=new qui agit (cf. reserve.js)
    timeout: 60_000,
    args,
  });
  const context = await browser.newContext({
    storageState: STORAGE_STATE,
    ...(config.showBrowser ? { viewport: null } : {}),
  });
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);
  page.setDefaultNavigationTimeout(30_000);

  await page.goto(URLS.reservation, { waitUntil: 'domcontentloaded' });
  if (/login/i.test(page.url())) {
    await browser.close().catch(() => {});
    throw new Error('SESSION_EXPIRED');
  }
  return { browser, context, page };
}

/**
 * Démarre la fenêtre chaude et son rafraîchissement périodique.
 * Sans effet si WARM_WINDOW n'est pas activé. Ne lève jamais : un préchauffage
 * raté ne doit pas empêcher la surveillance de tourner — on repartira
 * simplement sur un navigateur à froid le moment venu.
 */
export async function startWarmWindow() {
  if (!config.warmWindow) return null;
  if (warm) return warm;
  if (starting) return starting;

  starting = (async () => {
    try {
      const t0 = Date.now();
      warm = await open();
      log(`fenêtre prête sur la page de réservation en ${Date.now() - t0} ms — la réservation partira à chaud.`);

      // Si la fenêtre meurt (crash, ou tu la fermes à la main), on oublie le
      // handle : le prochain reserve() repartira proprement à froid.
      warm.browser.on('disconnected', () => {
        log('fenêtre fermée/perdue — retour au mode navigateur à froid.');
        warm = null;
      });

      // Rafraîchissement espacé : garde la session vivante et le DOM frais.
      const timer = setInterval(async () => {
        if (!warm) return clearInterval(timer);
        // Ne jamais rafraîchir pendant une réservation : on effacerait le
        // parcours en cours (dates saisies, toggles cochés, formulaire ouvert).
        if (warm.busy) return;
        try {
          await warm.page.goto(URLS.reservation, { waitUntil: 'domcontentloaded' });
          if (/login/i.test(warm.page.url())) log('⚠️ session expirée sur la fenêtre chaude — relance `make login`.');
        } catch (e) {
          log(`rafraîchissement échoué (non bloquant) : ${e.message}`);
        }
      }, REFRESH_MS);
      timer.unref?.();

      return warm;
    } catch (e) {
      log(`préchauffage impossible (${e.message}) — on continuera à froid.`);
      warm = null;
      return null;
    } finally {
      starting = null;
    }
  })();

  return starting;
}

/**
 * Renvoie la fenêtre chaude si elle est réellement utilisable, sinon null.
 * L'appelant DOIT gérer le cas null (navigateur à froid).
 */
export function getWarmWindow() {
  if (!warm) return null;
  if (!warm.browser.isConnected()) {
    warm = null;
    return null;
  }
  return warm;
}

/** Marque la fenêtre chaude comme occupée (pas de rafraîchissement pendant ce temps). */
export function setWarmBusy(busy) {
  if (warm) warm.busy = busy;
}

/**
 * Remet la fenêtre chaude à l'état d'attente après une réservation : on la
 * repose sur la page de réservation, prête pour la prochaine occasion. On ne
 * la ferme jamais — c'est tout l'intérêt.
 */
export async function resetWarmWindow() {
  const w = getWarmWindow();
  if (!w) return;
  try {
    await w.page.goto(URLS.reservation, { waitUntil: 'domcontentloaded' });
  } catch (e) {
    log(`remise à zéro échouée (non bloquant) : ${e.message}`);
  } finally {
    w.busy = false;
  }
}
