import { config } from './config.js';

/**
 * Escapes HTML special characters so that raw strings (e.g. error messages)
 * can be safely embedded inside parse_mode:'HTML' Telegram messages without
 * triggering a "Bad Request: can't parse entities" error.
 */
export function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

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

/**
 * Envoie un fichier (Buffer) en pièce jointe Telegram via sendDocument.
 * Utilisé par reserve.js pour envoyer le HTML brut d'une étape critique — un
 * screenshot montre le rendu visuel, mais le HTML donne directement les vrais
 * id/class/structure, utile pour corriger un sélecteur cassé sans devoir se
 * connecter en SSH à la machine.
 */
export async function notifyDocument(caption, buffer, filename) {
  console.log(`[NOTIFY DOC] ${caption} (${filename})`);
  if (!config.telegramToken || !config.telegramChatId) return;
  try {
    const formData = new FormData();
    formData.append('chat_id', String(config.telegramChatId));
    formData.append('caption', caption);
    formData.append('parse_mode', 'HTML');
    formData.append(
      'document',
      new Blob([buffer], { type: 'text/html' }),
      filename
    );
    const res = await fetch(
      `https://api.telegram.org/bot${config.telegramToken}/sendDocument`,
      { method: 'POST', body: formData }
    );
    if (!res.ok) {
      console.error('[NOTIFY DOC] Échec Telegram:', res.status, await res.text());
    }
  } catch (err) {
    console.error('[NOTIFY DOC] Erreur:', err.message);
  }
}
