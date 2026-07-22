import { config } from './config.js';
import { checkOnce } from './monitor.js';
import { notify } from './notify.js';

const HEARTBEAT_MS = 6 * 60 * 60_000; // toutes les 6h : "je suis toujours en vie"

/** Parse "startH-endH" (ex. "2-6") en {start, end}. Plage vide si invalide. */
function parseNightHours(spec) {
  const m = String(spec || '').match(/^\s*(\d{1,2})\s*-\s*(\d{1,2})\s*$/);
  if (!m) return null;
  return { start: parseInt(m[1], 10), end: parseInt(m[2], 10) };
}

/** True si l'heure courante (UTC de la VM) tombe dans la plage nocturne. */
function isNight(nightHours) {
  if (!nightHours) return false;
  const h = new Date().getHours();
  const { start, end } = nightHours;
  // Plage simple (2-6) ou qui passe minuit (22-6).
  return start <= end ? h >= start && h < end : h >= start || h < end;
}

/**
 * Délai (ms) avant le prochain check. Intervalle de base (jour ou nuit) +
 * jitter aléatoire ±jitterSeconds pour casser toute périodicité robotique.
 */
function nextDelayMs(nightHours) {
  const baseS = isNight(nightHours)
    ? config.nightIntervalSeconds
    : config.intervalSeconds;
  const jitter = config.jitterSeconds;
  const deltaS = jitter > 0 ? (Math.random() * 2 - 1) * jitter : 0;
  const s = Math.max(3, baseS + deltaS); // plancher de sécurité : jamais < 3s
  return Math.round(s * 1000);
}

/**
 * Boucle de surveillance rapide (fetch HTTP pur, pas de navigateur permanent).
 *
 * Garde-fous anti-ban :
 *  - jitter sur chaque intervalle (pas de signature de périodicité parfaite) ;
 *  - ralentissement nocturne (nightHours → nightIntervalSeconds) ;
 *  - BACKOFF exponentiel sur 429 / 5xx / erreur réseau : on double le délai
 *    (plafonné à maxBackoffSeconds) tant que ça échoue, puis retour au rythme
 *    normal dès le 1er cycle réussi. Un rate-limit ignoré = risque de ban IP.
 */
async function loop() {
  const startedAt = Date.now();
  let checks = 0;
  let errors = 0;
  let lastHeartbeat = 0;
  let backoffS = 0; // 0 = pas de backoff en cours

  const nightHours = parseNightHours(config.nightHours);

  console.log(
    `Moniteur CESAL démarré — check ~${config.intervalSeconds}s (±${config.jitterSeconds}s, ` +
      `nuit ${config.nightIntervalSeconds}s sur ${config.nightHours}h), mode: ${config.mode}.`
  );
  await notify(
    `🚀 Moniteur CESAL démarré (mode: ${config.mode}, intervalle ~${config.intervalSeconds}s, ` +
      `nuit ~${config.nightIntervalSeconds}s).`
  );

  for (;;) {
    const start = Date.now();
    let result = null;
    try {
      result = await checkOnce();
      checks++;
    } catch (err) {
      errors++;
      result = { error: err.message };
      console.error('Erreur de cycle:', err);
    }

    // ── Décision de backoff ───────────────────────────────────────────────
    // On recule (backoff) sur rate-limit, erreur réseau, ou 5xx implicite.
    // Les erreurs "métier" (session expirée, pas de session, structure) ne
    // sont PAS des surcharges serveur → pas de backoff, on garde le rythme.
    const err = result?.error;
    const shouldBackoff =
      err === 'RATE_LIMITED' ||
      (err && !['SESSION_EXPIRED', 'NO_SESSION', 'NO_NODES'].includes(err));

    if (shouldBackoff) {
      // Point de départ du backoff : Retry-After serveur si fourni, sinon
      // l'intervalle courant ; puis doublement à chaque échec consécutif.
      const seed = result?.retryAfter || config.intervalSeconds;
      backoffS = backoffS
        ? Math.min(backoffS * 2, config.maxBackoffSeconds)
        : Math.min(Math.max(seed, config.intervalSeconds), config.maxBackoffSeconds);
      if (result?.retryAfter) backoffS = Math.min(Math.max(backoffS, result.retryAfter), config.maxBackoffSeconds);
      console.warn(`[loop] Backoff actif : prochain check dans ~${backoffS}s (cause: ${err}).`);
      if (backoffS >= 60 && backoffS >= config.maxBackoffSeconds) {
        // On alerte quand on plafonne (serveur durablement en refus).
        await notify(`⚠️ CESAL répond mal (${err}) — surveillance ralentie à ${backoffS}s. Je réessaie doucement.`);
      }
    } else if (backoffS) {
      console.log('[loop] Reprise du rythme normal (backoff levé).');
      backoffS = 0;
    }

    // ── Heartbeat périodique ──────────────────────────────────────────────
    if (Date.now() - lastHeartbeat > HEARTBEAT_MS) {
      const uptimeH = ((Date.now() - startedAt) / 3_600_000).toFixed(1);
      await notify(
        `💓 Heartbeat — VPS actif depuis ${uptimeH}h, ${checks} checks effectués` +
          (errors ? `, ${errors} erreurs` : '') +
          `.`
      );
      lastHeartbeat = Date.now();
    }

    // ── Attente avant le prochain cycle ───────────────────────────────────
    // En backoff : délai fixe = backoffS. Sinon : intervalle + jitter, moins
    // le temps déjà passé dans checkOnce (pour tenir la cadence réelle).
    let waitMs;
    if (backoffS) {
      waitMs = backoffS * 1000;
    } else {
      waitMs = nextDelayMs(nightHours) - (Date.now() - start);
    }
    await new Promise((r) => setTimeout(r, Math.max(3_000, waitMs)));
  }
}

loop();
