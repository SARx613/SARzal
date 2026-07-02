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

/**
 * Envoie un screenshot (Buffer PNG) sur Telegram via sendPhoto.
 * Utilisé par reserve.js pour documenter chaque étape en temps réel.
 */
export async function notifyPhoto(caption, screenshotBuffer) {
  console.log(`[NOTIFY PHOTO] ${caption}`);
  if (!config.telegramToken || !config.telegramChatId) return;
  try {
    const formData = new FormData();
    formData.append('chat_id', String(config.telegramChatId));
    formData.append('caption', caption);
    formData.append('parse_mode', 'HTML');
    formData.append(
      'photo',
      new Blob([screenshotBuffer], { type: 'image/png' }),
      'step.png'
    );
    const res = await fetch(
      `https://api.telegram.org/bot${config.telegramToken}/sendPhoto`,
      { method: 'POST', body: formData }
    );
    if (!res.ok) {
      console.error('[NOTIFY PHOTO] Échec Telegram:', res.status, await res.text());
    }
  } catch (err) {
    console.error('[NOTIFY PHOTO] Erreur:', err.message);
  }
}
