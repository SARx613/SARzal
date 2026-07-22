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

  // ── Surveillance rapide (fetch HTTP pur, pas de navigateur permanent) ──────
  // Intervalle de base entre deux checks, en SECONDES. Défaut prudent (25s) ;
  // baisse-le (ex. 10) via le secret Fly INTERVAL_SECONDS sans redéployer.
  // Si INTERVAL_SECONDS n'est pas défini mais INTERVAL_MINUTES l'est, on
  // retombe sur les minutes pour rester rétro-compatible.
  intervalSeconds: parseInt(
    process.env.INTERVAL_SECONDS ||
      String((parseInt(process.env.INTERVAL_MINUTES || '0', 10) || 0) * 60 || 25),
    10
  ),
  // Jitter : on ajoute ±jitterSeconds aléatoires à chaque cycle pour NE PAS
  // taper à une périodicité robotique parfaite (garde-fou anti-détection nº1).
  jitterSeconds: parseInt(process.env.JITTER_SECONDS || '4', 10),
  // Plage nocturne : on ralentit à nightIntervalSeconds pendant nightHours
  // (heure locale UTC de la VM). Divise le volume quotidien et supprime le
  // trafic le plus "anormal" (4h du matin toutes les 10s = signature de bot).
  nightIntervalSeconds: parseInt(process.env.NIGHT_INTERVAL_SECONDS || '60', 10),
  nightHours: process.env.NIGHT_HOURS || '2-6', // "startH-endH" inclusif→exclusif
  // Plafond du backoff exponentiel appliqué sur 429/5xx/erreur réseau.
  maxBackoffSeconds: parseInt(process.env.MAX_BACKOFF_SECONDS || '300', 10),
};

export const URLS = {
  login: 'https://logement.cesal.fr/espace-resident/cesal_login.php',
  index: 'https://logement.cesal.fr/espace-resident/index.php',
  reservation: 'https://logement.cesal.fr/espace-resident/cesal_mon_logement_reservation.php',
};

// Fichier où l'état de session (cookies) est stocké après un login réussi.
export const STORAGE_STATE = new URL('../config/session.json', import.meta.url).pathname;
