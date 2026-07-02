import { config } from './config.js';
import { checkOnce } from './monitor.js';
import { notify } from './notify.js';

const HEARTBEAT_MS = 6 * 60 * 60_000; // toutes les 6h : "je suis toujours en vie"

/** Boucle : un check toutes les INTERVAL_MINUTES + heartbeat Telegram périodique. */
async function loop() {
  const startedAt = Date.now();
  let checks = 0;
  let errors = 0;
  let lastHeartbeat = 0;

  console.log(`Moniteur CESAL démarré — check toutes les ${config.intervalMinutes} min (mode: ${config.mode}).`);
  await notify(`🚀 Moniteur CESAL démarré sur le VPS (mode: ${config.mode}, intervalle: ${config.intervalMinutes} min).`);

  for (;;) {
    const start = Date.now();
    try {
      await checkOnce();
      checks++;
    } catch (err) {
      errors++;
      console.error('Erreur de cycle:', err);
    }

    if (Date.now() - lastHeartbeat > HEARTBEAT_MS) {
      const uptimeH = ((Date.now() - startedAt) / 3_600_000).toFixed(1);
      await notify(
        `💓 Heartbeat — VPS actif depuis ${uptimeH}h, ${checks} checks effectués` +
          (errors ? `, ${errors} erreurs` : '') +
          `.`
      );
      lastHeartbeat = Date.now();
    }

    const waitMs = config.intervalMinutes * 60_000 - (Date.now() - start);
    await new Promise((r) => setTimeout(r, Math.max(5_000, waitMs)));
  }
}

loop();
