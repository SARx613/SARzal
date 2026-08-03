import { config, residenceLabel } from './config.js';
import { checkOnce } from './monitor.js';
import { notify } from './notify.js';

/**
 * Résumé des règles de sélection actives — affiché au démarrage (logs Fly ET
 * Telegram). Quand plusieurs logements tombent en même temps, c'est ce qui
 * décide lequel sera réservé de façon IRRÉVERSIBLE : autant pouvoir le vérifier
 * d'un coup d'œil, sans relire le code ni la liste des secrets.
 */
function resumeReglesSelection() {
  const residences = config.autoReserveResidences.map((n) => residenceLabel(n)).join(' puis ');
  return [
    `🏘️ Réserve dans : ${residences || '(aucune)'}`,
    `🏷️ Types par ordre de préférence : ${config.preferredTypes.join(' > ')}` +
      (config.strictTypes ? ' (STRICT : rien d\'autre)' : ' (les autres types en dernier recours)'),
    `👥 Colocation : ${config.allowColocNonSolidaire ? 'non solidaire acceptée' : 'jamais'}` +
      ` (solidaire = toujours refusée par le site)`,
    `🔁 Jusqu'à ${config.maxReserveAttempts} logement(s) tenté(s) si le site refuse le 1er choix`,
  ].join('\n');
}

const HEARTBEAT_MS = 6 * 60 * 60_000; // toutes les 6h : "je suis toujours en vie"

/**
 * Délai (ms) avant le prochain check. Intervalle identique jour et nuit (pas de
 * ralentissement nocturne) + jitter aléatoire ±jitterSeconds pour ne PAS taper
 * à une périodicité robotique parfaite (garde-fou anti-détection). Plancher de
 * sécurité : jamais < 1s.
 */
function nextDelayMs() {
  const jitter = config.jitterSeconds;
  const deltaS = jitter > 0 ? (Math.random() * 2 - 1) * jitter : 0;
  const s = Math.max(1, config.intervalSeconds + deltaS);
  return Math.round(s * 1000);
}

/**
 * Boucle de surveillance rapide (fetch HTTP pur, pas de navigateur permanent).
 *
 * Intervalle identique 24/7 (pas de ralentissement nuit), avec jitter ±N s
 * pour casser la périodicité robotique. Garde-fou serveur : BACKOFF exponentiel
 * sur 429 / 5xx / erreur réseau — on double le délai (plafonné à
 * maxBackoffSeconds) tant que ça échoue, puis retour au rythme normal dès le
 * 1er cycle réussi. Un rate-limit ignoré = risque de ban IP.
 */
async function loop() {
  const startedAt = Date.now();
  let checks = 0;
  let errors = 0;
  let lastHeartbeat = 0;
  let backoffS = 0; // 0 = pas de backoff en cours

  const regles = resumeReglesSelection();
  console.log(
    `Moniteur CESAL démarré — check ~${config.intervalSeconds}s (±${config.jitterSeconds}s, jour et nuit), mode: ${config.mode}.`
  );
  console.log(regles);
  await notify(
    `🚀 Moniteur CESAL démarré (mode: ${config.mode}, intervalle ~${config.intervalSeconds}s ±${config.jitterSeconds}s, jour et nuit).` +
      (config.mode === 'reserve' ? `\n\n<b>Règles de choix en cas de dispos multiples :</b>\n${regles}` : '')
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
      waitMs = nextDelayMs() - (Date.now() - start);
    }
    await new Promise((r) => setTimeout(r, Math.max(1_000, waitMs)));
  }
}

loop();
