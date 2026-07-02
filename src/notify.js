import { config } from './config.js';

/**
 * Envoie un message Telegram. Silencieux (log seulement) si non configuré,
 * pour ne pas casser le moniteur pendant la phase de mise au point.
 */
export async function notify(text) {
  console.log(`[NOTIFY] ${text}`);
  if (!config.telegramToken || !config.telegramChatId) {
    console.warn('[NOTIFY] Telegram non configuré (token/chat_id manquant) — message non envoyé.');
    return;
  }
  try {
    const res = await fetch(
      `https://api.telegram.org/bot${config.telegramToken}/sendMessage`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: config.telegramChatId,
          text,
          parse_mode: 'HTML',
          disable_web_page_preview: true,
        }),
      }
    );
    if (!res.ok) {
      console.error('[NOTIFY] Échec Telegram:', res.status, await res.text());
    }
  } catch (err) {
    console.error('[NOTIFY] Erreur réseau Telegram:', err.message);
  }
}
