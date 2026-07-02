import 'dotenv/config';

export const config = {
  email: process.env.CESAL_EMAIL || '',
  password: process.env.CESAL_PASSWORD || '',
  telegramToken: process.env.TELEGRAM_BOT_TOKEN || '',
  telegramChatId: process.env.TELEGRAM_CHAT_ID || '',
  mode: process.env.MODE || 'alert',
  dateSortie: process.env.DATE_SORTIE || '18/12/2026',
  intervalMinutes: parseInt(process.env.INTERVAL_MINUTES || '10', 10),
  headless: process.env.HEADLESS !== 'false',
};

export const URLS = {
  login: 'https://logement.cesal.fr/espace-resident/cesal_login.php',
  index: 'https://logement.cesal.fr/espace-resident/index.php',
  reservation: 'https://logement.cesal.fr/espace-resident/cesal_mon_logement_reservation.php',
};

// Fichier où l'état de session (cookies) est stocké après un login réussi.
export const STORAGE_STATE = new URL('../config/session.json', import.meta.url).pathname;
