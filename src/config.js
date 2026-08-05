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

  // Nom de cette instance, préfixé à chaque message Telegram. Quand le bot
  // tourne à la fois sur le Mac et sur le VPS, les deux écrivent dans le MÊME
  // chat : sans ce préfixe, impossible de savoir laquelle a vu quoi (ni
  // laquelle a réservé). Vide = pas de préfixe (comportement d'avant).
  instanceName: process.env.INSTANCE_NAME || '',

  // true → le Chromium de la réservation s'ouvre VISIBLE à l'écran, au lieu de
  // tourner en headless. Réservé au Mac : sur le VPS il n'y a pas d'affichage.
  // Le site (jQuery/select2/AJAX) se comporte mieux dans une vraie fenêtre, et
  // ça permet de reprendre la main à la souris si le bot se coince.
  showBrowser: process.env.SHOW_BROWSER === 'true',

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

  // ── Sélection du logement à auto-réserver ────────────────────────────────
  // Quand PLUSIEURS logements sont dispos en même temps (cas réel attendu),
  // il faut choisir. Tout est pilotable par secret Fly, sans redéployer.

  // Résidences pour lesquelles on RÉSERVE vraiment (les autres = alerte seule).
  // Ex: "3,4". L'ORDRE compte : sert de départage à qualité égale.
  autoReserveResidences: (process.env.AUTO_RESERVE_RESIDENCES || '3,4')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  // Ordre de PRÉFÉRENCE des types de logement (le 1er = le rêve).
  // Comparaison insensible à la casse/espaces ("t1 bis" == "T1 BIS").
  preferredTypes: (process.env.PREFERRED_TYPES || 'T1,T1 BIS,T2')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  // true → on ne réserve QUE les types listés ci-dessus (un type inconnu est
  // signalé mais jamais validé). false (défaut) → les autres types restent
  // réservables, mais toujours APRÈS les préférés (filet de sécurité : mieux
  // vaut un logement en III/IV que rien).
  strictTypes: process.env.STRICT_TYPES === 'true',

  // Autoriser l'auto-réservation d'une colocation NON solidaire (le site ne
  // demande alors aucun email de colocataire — cf. submit_reservation()).
  // Défaut false : tu veux du sans-colocation. Ces logements restent notifiés.
  allowColocNonSolidaire: process.env.ALLOW_COLOC_NON_SOLIDAIRE === 'true',

  // Nombre max de logements DIFFÉRENTS tentés dans un même cycle si les
  // premiers échouent (garde-fou : on ne martèle pas le serveur).
  maxCandidatesPerCycle: parseInt(process.env.MAX_CANDIDATES_PER_CYCLE || '3', 10),

  // Nombre maximum de tentatives de réservation SUR UN MÊME logement, par jour.
  // Une tentative ratée NE clôt plus l'affaire (c'était le bug : une occasion
  // rare était abandonnée sur un simple échec technique), mais on ne martèle
  // pas non plus le site indéfiniment.
  maxReserveAttempts: parseInt(process.env.MAX_RESERVE_ATTEMPTS || '5', 10),

  // Si la validation HTTP n'aboutit pas et que le compte n'a rien de réservé,
  // rejouer le parcours dans un vrai navigateur (le site remplit son formulaire
  // en JavaScript et confirme via une popup). Mettre à "false" sur une machine
  // trop petite pour Chromium.
  browserFallback: process.env.BROWSER_FALLBACK !== 'false',
};

/** Libellés lisibles des résidences (partagés monitor / reserve). */
export const RESIDENCE_LABELS = {
  1: 'Résidence I',
  2: 'Résidence II',
  3: 'Résidence III',
  4: 'Résidence IV',
  5: 'Résidence Joliot-Curie',
  6: 'Résidence Le Mail',
};

/** "3" → "Résidence III" (repli : "Résidence 7" si numéro inconnu). */
export function residenceLabel(num) {
  return RESIDENCE_LABELS[num] || `Résidence ${num}`;
}

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
