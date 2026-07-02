import { config } from './config.js';
import { checkOnce } from './monitor.js';

/** Boucle locale : un check toutes les INTERVAL_MINUTES. */
async function loop() {
  console.log(`Moniteur CESAL démarré — check toutes les ${config.intervalMinutes} min (mode: ${config.mode}).`);
  for (;;) {
    const start = Date.now();
    try {
      await checkOnce();
    } catch (err) {
      console.error('Erreur de cycle:', err);
    }
    const waitMs = config.intervalMinutes * 60_000 - (Date.now() - start);
    await new Promise((r) => setTimeout(r, Math.max(5_000, waitMs)));
  }
}

loop();
