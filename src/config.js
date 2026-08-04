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
  // Intervalle de base entre deux checks, en SECONDES — identique jour et nuit
  // (pas de ralentissement nocturne). Défaut 3s ; ajustable via le secret Fly
  // INTERVAL_SECONDS sans redéployer. Si INTERVAL_SECONDS n'est pas défini mais
  // INTERVAL_MINUTES l'est, on retombe sur les minutes (rétro-compatible).
  intervalSeconds: parseInt(
    process.env.INTERVAL_SECONDS ||
      String((parseInt(process.env.INTERVAL_MINUTES || '0', 10) || 0) * 60 || 3),
    10
  ),
  // Jitter : on ajoute ±jitterSeconds aléatoires à chaque cycle pour NE PAS
  // taper à une périodicité robotique parfaite (garde-fou anti-détection).
  // parseFloat (pas parseInt) car la valeur peut être décimale (ex: 1.5).
  jitterSeconds: parseFloat(process.env.JITTER_SECONDS || '1.5'),
  // Plafond du backoff exponentiel appliqué sur 429/5xx/erreur réseau.
  maxBackoffSeconds: parseInt(process.env.MAX_BACKOFF_SECONDS || '300', 10),

  // ── Réservation ───────────────────────────────────────────────────────────
  // Résidences pour lesquelles on RÉSERVE vraiment (les autres → alerte seule).
  // Liste de numéros séparés par des virgules, ex: "3,4". Modifiable via un
  // secret Fly sans toucher au code.
  autoReserveResidences: (process.env.AUTO_RESERVE_RESIDENCES || '3,4')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  // Nombre maximum de tentatives de réservation par logement et par jour. Une
  // tentative ratée NE clôt plus l'affaire (c'était le bug : une occasion rare
  // était abandonnée sur un simple échec technique), mais on ne martèle pas non
  // plus le site indéfiniment.
  maxReserveAttempts: parseInt(process.env.MAX_RESERVE_ATTEMPTS || '5', 10),

  // Si la validation HTTP n'aboutit pas et que le compte n'a rien de réservé,
  // rejouer le parcours dans un vrai navigateur (le site remplit son formulaire
  // en JavaScript et confirme via une popup). Mettre à "false" sur une machine
  // trop petite pour Chromium.
  browserFallback: process.env.BROWSER_FALLBACK !== 'false',
};

// Base du site. Surchargeable par CESAL_BASE_URL — uniquement pour pouvoir
// rejouer le parcours complet contre un faux serveur local dans les tests
// (cf. src/test-reservation.js). En production, on ne la définit pas.
const BASE = (process.env.CESAL_BASE_URL || 'https://logement.cesal.fr').replace(/\/$/, '');

export const URLS = {
  login: `${BASE}/espace-resident/cesal_login.php`,
  index: `${BASE}/espace-resident/index.php`,
  reservation: `${BASE}/espace-resident/cesal_mon_logement_reservation.php`,
};

// Fichier où l'état de session (cookies) est stocké après un login réussi.
export const STORAGE_STATE = new URL('../config/session.json', import.meta.url).pathname;
