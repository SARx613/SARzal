import fs from 'fs';
import path from 'path';

/**
 * État quotidien du bot : ce qui a déjà été NOTIFIÉ, ce qui a été TENTÉ, et ce
 * qui a été réellement RÉSERVÉ.
 *
 * ⚠️ Distinction capitale (bug corrigé après l'audit) : avant, "notifié" et
 * "traité" étaient la même chose. Une tentative de réservation ratée marquait
 * quand même le logement comme vu → plus aucune alerte, plus aucun nouvel essai
 * de la journée, alors que le logement était toujours libre. Une occasion rare
 * était donc définitivement perdue sur un simple échec technique.
 *
 * Désormais :
 *   • `codes` / `signatures` = anti-spam de NOTIFICATION uniquement ;
 *   • `attempts`             = nb de tentatives de réservation par logement
 *                              (plafonné, pour ne pas marteler le site) ;
 *   • `reserved`             = logements réellement confirmés réservés — c'est
 *                              la seule chose qui arrête définitivement le flux.
 */
const SEEN_FILE = new URL('../config/seen_logements.json', import.meta.url).pathname;

function todayKey() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

function emptyState() {
  return { day: todayKey(), codes: [], signatures: [], attempts: {}, reserved: [] };
}

function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(SEEN_FILE, 'utf8'));
    if (raw.day === todayKey()) {
      return {
        day: raw.day,
        codes: raw.codes || [],
        signatures: raw.signatures || [],
        attempts: raw.attempts || {},
        // Une réservation confirmée ne doit PAS être oubliée au changement de
        // jour : on la conserve telle quelle (cf. save()).
        reserved: raw.reserved || [],
      };
    }
    // Nouveau jour : on repart à zéro SAUF sur les réservations confirmées.
    return { ...emptyState(), reserved: raw.reserved || [] };
  } catch {}
  return emptyState();
}

/**
 * Écriture RÉSILIENTE. Avant, un dossier `config/` absent faisait lever
 * writeFileSync en plein milieu du flux de réservation — l'exception remontait
 * jusqu'à la boucle et l'alerte n'était jamais envoyée. L'anti-doublon est un
 * confort : il ne doit jamais pouvoir faire échouer une réservation.
 */
function save(state) {
  try {
    fs.mkdirSync(path.dirname(SEEN_FILE), { recursive: true });
    fs.writeFileSync(SEEN_FILE, JSON.stringify(state, null, 2));
  } catch (err) {
    console.warn('[seen] Sauvegarde impossible (non bloquant):', err.message);
  }
}

/* ─────────────────────── Anti-spam de NOTIFICATION ─────────────────────── */

/** Renvoie les codes de `codes` qui n'ont pas encore été notifiés aujourd'hui. */
export function filterNewCodes(codes) {
  const seen = new Set(load().codes);
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
 * Anti-spam basé sur une SIGNATURE de disponibilité (ensemble trié des niveaux
 * dispo). Renvoie true si la signature est NOUVELLE.
 */
export function isNewSignature(signature) {
  return !new Set(load().signatures || []).has(signature);
}

/** Enregistre une signature de disponibilité comme notifiée pour aujourd'hui. */
export function markSignatureSeen(signature) {
  const state = load();
  const sigs = new Set(state.signatures || []);
  sigs.add(signature);
  state.signatures = [...sigs];
  save(state);
}

/**
 * Oublie une signature : à appeler quand une tentative de réservation a ÉCHOUÉ,
 * pour que le cycle suivant re-notifie et re-tente au lieu de rester muet
 * jusqu'à minuit.
 */
export function forgetSignature(signature) {
  const state = load();
  state.signatures = (state.signatures || []).filter((s) => s !== signature);
  save(state);
}

/* ───────────────────── Tentatives / réservations réelles ───────────────── */

/** Nombre de tentatives de réservation déjà faites aujourd'hui sur ce logement. */
export function reservationAttempts(code) {
  return load().attempts?.[code] || 0;
}

/** Incrémente le compteur de tentatives et renvoie sa nouvelle valeur. */
export function recordReservationAttempt(code) {
  const state = load();
  state.attempts = state.attempts || {};
  state.attempts[code] = (state.attempts[code] || 0) + 1;
  save(state);
  return state.attempts[code];
}

/** Marque un logement comme RÉELLEMENT réservé (vérifié côté site). */
export function markReserved(code) {
  const state = load();
  const set = new Set(state.reserved || []);
  set.add(code);
  state.reserved = [...set];
  save(state);
}

/** true si une réservation confirmée existe déjà (ne pas en refaire une autre). */
export function isReserved(code) {
  return new Set(load().reserved || []).has(code);
}

/** true si le bot a DÉJÀ décroché un logement (quel qu'il soit). */
export function hasAnyReservation() {
  return (load().reserved || []).length > 0;
}
