import { config } from './config.js';
import { checkOnce } from './monitor.js';
import { notify } from './notify.js';

const HEARTBEAT_MS = 6 * 60 * 60_000; // toutes les 6h : "je suis toujours en vie"

/**
 * Délai (ms) avant le prochain check. Intervalle CONSTANT, identique jour et
 * nuit (choix utilisateur : surveillance uniforme 24/7, sans ralentissement
 * nocturne ni jitter). Plancher de sécurité : jamais < 3s.
 */
function nextDelayMs() {
  return Math.max(3, config.intervalSeconds) * 1000;
}

/**
 * Boucle de surveillance rapide (fetch HTTP pur, pas de navigateur permanent).
 *
 * Intervalle CONSTANT 24/7 (pas de ralentissement nuit, pas de jitter).
 * Seul garde-fou conservé : BACKOFF exponentiel sur 429 / 5xx / erreur réseau
 * — on double le délai (plafonné à maxBackoffSeconds) tant que ça échoue, puis
 * retour au rythme normal dès le 1er cycle réussi. Un rate-limit ignoré =
 * risque de ban IP.
 */
async function loop() {
  const startedAt = Date.now();
  let checks = 0;
  let errors = 0;
  let lastHeartbeat = 0;
  let backoffS = 0; // 0 = pas de backoff en cours

  console.log(
    `Moniteur CESAL démarré — check toutes les ${config.intervalSeconds}s (constant 24/7), mode: ${config.mode}.`
  );
  await notify(
    `🚀 Moniteur CESAL démarré (mode: ${config.mode}, intervalle ${config.intervalSeconds}s constant, jour et nuit).`
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
    // En backoff : délai fixe = backoffS. Sinon : intervalle constant, moins
    // le temps déjà passé dans checkOnce (pour tenir la cadence réelle).
    let waitMs;
    if (backoffS) {
      waitMs = backoffS * 1000;
    } else {
      waitMs = nextDelayMs() - (Date.now() - start);
    }
    await new Promise((r) => setTimeout(r, Math.max(3_000, waitMs)));
  }
}

loop();
