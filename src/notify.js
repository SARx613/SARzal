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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Préfixe identifiant l'instance qui parle (`INSTANCE_NAME`).
 *
 * Quand le bot tourne simultanément sur le Mac et sur le VPS, les deux écrivent
 * dans le même chat Telegram. Sans ce préfixe, deux alertes identiques arrivent
 * et rien ne dit laquelle des deux a effectivement réservé. Le nom est échappé :
 * il vient d'une variable d'environnement et part dans un message parse_mode HTML.
 */
function withInstance(text) {
  const name = config.instanceName;
  return name ? `[${escapeHtml(name)}] ${text}` : text;
}

/**
 * Appel Telegram avec RETRY. Un message d'alerte perdu = une occasion de
 * réservation perdue : on ne se contente donc plus d'un seul essai silencieux.
 *
 *  • 429 (flood control) → on respecte `retry_after` renvoyé par Telegram ;
 *  • erreur réseau / 5xx → backoff 1s, 3s, 7s ;
 *  • 400 "can't parse entities" → géré par l'appelant (repli en texte brut).
 *
 * Renvoie { ok, status, body }.
 */
async function callTelegram(method, payload, { attempts = 4, isFormData = false } = {}) {
  let last = { ok: false, status: 0, body: '' };
  for (let i = 1; i <= attempts; i++) {
    try {
      const res = await fetch(
        `https://api.telegram.org/bot${config.telegramToken}/${method}`,
        isFormData
          ? { method: 'POST', body: payload }
          : {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(payload),
            }
      );
      const body = await res.text().catch(() => '');
      if (res.ok) return { ok: true, status: res.status, body };
      last = { ok: false, status: res.status, body };

      // 400 = requête invalide (entités HTML cassées, message trop long…).
      // Réessayer à l'identique ne sert à rien : on rend la main à l'appelant.
      if (res.status === 400) return last;

      if (res.status === 429) {
        const retryAfter = Number(JSON.parse(body || '{}')?.parameters?.retry_after) || 2;
        console.warn(`[NOTIFY] Flood control Telegram — nouvelle tentative dans ${retryAfter}s.`);
        await sleep(retryAfter * 1000);
        continue;
      }
      console.warn(`[NOTIFY] Telegram HTTP ${res.status} (tentative ${i}/${attempts}) : ${body.slice(0, 200)}`);
    } catch (err) {
      last = { ok: false, status: 0, body: err.message };
      console.warn(`[NOTIFY] Erreur réseau Telegram (tentative ${i}/${attempts}) : ${err.message}`);
    }
    if (i < attempts) await sleep(i * 2000 - 1000); // 1s, 3s, 5s
  }
  return last;
}

// Telegram refuse les messages > 4096 caractères : on tronque proprement
// plutôt que de perdre l'alerte entière sur un 400.
const TELEGRAM_MAX = 4000;

function truncate(text) {
  if (text.length <= TELEGRAM_MAX) return text;
  return text.slice(0, TELEGRAM_MAX) + '\n… (message tronqué)';
}

/**
 * Envoie un message Telegram. Silencieux (log seulement) si non configuré.
 *
 * Deux filets de sécurité ajoutés après l'audit :
 *   1. retry (cf. callTelegram) — une alerte perdue = une occasion perdue ;
 *   2. si Telegram refuse le parse HTML (400), on RENVOIE le même message en
 *      texte brut (balises retirées). Avant, un simple "&" ou "<" non échappé
 *      dans un libellé de logement faisait disparaître l'alerte entière.
 */
export async function notify(text) {
  console.log(`[NOTIFY] ${text}`);
  if (!config.telegramToken || !config.telegramChatId) {
    console.warn('[NOTIFY] Telegram non configuré (token/chat_id manquant) — message non envoyé.');
    return false;
  }
  const body = truncate(withInstance(text));
  const res = await callTelegram('sendMessage', {
    chat_id: config.telegramChatId,
    text: body,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  });
  if (res.ok) return true;

  if (res.status === 400) {
    console.warn('[NOTIFY] Telegram a refusé le HTML — repli en texte brut.');
    const plain = truncate(
      body
        .replace(/<[^>]+>/g, '')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&amp;/g, '&')
    );
    const retry = await callTelegram('sendMessage', {
      chat_id: config.telegramChatId,
      text: plain,
      disable_web_page_preview: true,
    });
    if (retry.ok) return true;
    console.error('[NOTIFY] Échec définitif Telegram:', retry.status, retry.body.slice(0, 300));
    return false;
  }
  console.error('[NOTIFY] Échec définitif Telegram:', res.status, res.body.slice(0, 300));
  return false;
}

/**
 * Envoie un screenshot (Buffer PNG) sur Telegram via sendPhoto.
 */
export async function notifyPhoto(caption, screenshotBuffer) {
  console.log(`[NOTIFY PHOTO] ${caption}`);
  if (!config.telegramToken || !config.telegramChatId) return false;
  const formData = new FormData();
  formData.append('chat_id', String(config.telegramChatId));
  formData.append('caption', truncate(withInstance(caption)).slice(0, 1000));
  formData.append('parse_mode', 'HTML');
  formData.append('photo', new Blob([screenshotBuffer], { type: 'image/png' }), 'step.png');
  const res = await callTelegram('sendPhoto', formData, { isFormData: true });
  if (!res.ok) console.error('[NOTIFY PHOTO] Échec:', res.status, res.body.slice(0, 300));
  return res.ok;
}

/**
 * Envoie un fichier (Buffer) en pièce jointe Telegram via sendDocument.
 *
 * ⚠️ C'est la SEULE copie durable des pages HTML capturées : la machine Fly n'a
 * aucun volume monté, donc tout ce qui est écrit dans /app/config disparaît au
 * moindre redéploiement ou redémarrage. Ce qui arrive dans le chat Telegram, en
 * revanche, reste consultable. D'où le retry ici aussi.
 */
export async function notifyDocument(caption, buffer, filename) {
  console.log(`[NOTIFY DOC] ${caption} (${filename})`);
  if (!config.telegramToken || !config.telegramChatId) return false;
  const formData = new FormData();
  formData.append('chat_id', String(config.telegramChatId));
  formData.append('caption', truncate(withInstance(caption)).slice(0, 1000));
  formData.append('parse_mode', 'HTML');
  formData.append('document', new Blob([buffer], { type: 'text/html' }), filename);
  const res = await callTelegram('sendDocument', formData, { isFormData: true });
  if (!res.ok) console.error('[NOTIFY DOC] Échec:', res.status, res.body.slice(0, 300));
  return res.ok;
}
