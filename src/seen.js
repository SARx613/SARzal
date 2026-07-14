import fs from 'fs';

/**
 * Anti-doublon : mémorise les codes logement (ex: "6CA306") déjà notifiés
 * pour ne pas re-spammer Telegram avec le même logement à chaque cycle de
 * surveillance (toutes les INTERVAL_MINUTES). Le compteur est remis à zéro
 * chaque jour (le logement peut redevenir intéressant à re-signaler le
 * lendemain s'il est encore dispo).
 */
const SEEN_FILE = new URL('../config/seen_logements.json', import.meta.url).pathname;

function todayKey() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(SEEN_FILE, 'utf8'));
    if (raw.day === todayKey()) return raw;
  } catch {}
  return { day: todayKey(), codes: [] };
}

function save(state) {
  fs.writeFileSync(SEEN_FILE, JSON.stringify(state, null, 2));
}

/** Renvoie les codes de `codes` qui n'ont pas encore été notifiés aujourd'hui. */
export function filterNewCodes(codes) {
  const state = load();
  const seen = new Set(state.codes);
  return codes.filter((c) => c && !seen.has(c));
}

/** Marque ces codes comme notifiés pour aujourd'hui. */
export function markSeen(codes) {
  const state = load();
  const seen = new Set(state.codes);
  for (const c of codes) if (c) seen.add(c);
  state.codes = [...seen];
  save(state);
}

/**
 * Anti-spam basé sur une SIGNATURE de disponibilité (indépendant du code
 * logement, qui n'est lisible qu'après ouverture du navigateur). La signature
 * est l'ensemble trié des niveaux disponibles détectés lors du scan HTTP
 * (ex: "niveau_1_D_0_0|niveau_3_A_G_2"). Tant que cette signature ne change
 * pas, on considère qu'on a déjà traité/notifié cette situation aujourd'hui,
 * et on n'ouvre PAS le navigateur (donc pas de nouveaux screenshots).
 *
 * Renvoie true si la signature est NOUVELLE (à traiter), false si déjà vue.
 */
export function isNewSignature(signature) {
  const state = load();
  const seenSigs = new Set(state.signatures || []);
  return !seenSigs.has(signature);
}

/** Enregistre une signature de disponibilité comme traitée pour aujourd'hui. */
export function markSignatureSeen(signature) {
  const state = load();
  const seenSigs = new Set(state.signatures || []);
  seenSigs.add(signature);
  state.signatures = [...seenSigs];
  save(state);
}
