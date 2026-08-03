import { config, URLS, residenceLabel } from './config.js';
import { notify, notifyDocument, escapeHtml } from './notify.js';

/**
 * RÉSERVATION 100 % HTTP — SANS NAVIGATEUR.
 *
 * Découverte majeure (HTML réel capturé, cf. config/reserve_step_J.html) :
 * TOUT le parcours de réservation du site est purement CÔTÉ CLIENT. Les clics
 * "résidence → aile → escalier → niveau → logement" ne font QUE masquer/afficher
 * des <div> DÉJÀ présents dans la page (aucun appel AJAX). Concrètement, l'unique
 * réponse HTTP que la surveillance récupère déjà (POST modifier_date_arrivee)
 * contient, en clair :
 *   • les lignes logement  <tr id="tr_logement_XXX">…</tr>  avec tous les détails
 *     (code, type, loyer, surface, colocation, occupants…) de TOUTES les
 *     résidences à la fois, chacune DANS son <div id="niveau_R_A_C_N_logements">,
 *   • le formulaire de validation complet <form id="action-validation_reservation">
 *     avec keyid, nb_occupants, est_caution_solidaire, date_entree, date_sortie…
 *
 * Donc :
 *   – lire les détails du logement = parser le HTML déjà en main (0 requête, ~1 ms) ;
 *   – RÉSERVER = UN SEUL POST `action=validation_reservation`, en reproduisant
 *     exactement ce que fait le JS du site au clic sur la ligne (cf. plus bas).
 *
 * ⚠️ POINT CRITIQUE quand PLUSIEURS logements sont dispos en même temps :
 * le HTML contient les lignes de TOUTES les résidences, dans l'ordre du DOM
 * (Résidence I d'abord). Il faut donc :
 *   1. rattacher chaque ligne à SA résidence — le site le fait lui-même via
 *      `var residence = keyid.substr(0,1)` (1er caractère du keyid, ex 3EC201A
 *      → résidence 3) ; on utilise en priorité le <div id="niveau_3_E_C_2_logements">
 *      englobant, qui donne en plus l'aile / l'escalier / le niveau exacts ;
 *   2. CHOISIR selon les préférences (type, sans colocation…) et pas "le premier
 *      du document" ;
 *   3. recalculer nb_occupants + est_caution_solidaire DEPUIS LA LIGNE CHOISIE :
 *      le JS du site les repose à chaque clic ($("#nb_occupants").val(...)), donc
 *      les valeurs statiques du <form> correspondent à un AUTRE logement dès
 *      qu'il y en a plusieurs.
 *
 * La colocation SOLIDAIRE reste NON auto-réservable (le site exige côté serveur
 * l'email d'un colocataire ayant un compte Césal actif — cf.
 * cesal_ajax_check_email.php, branche `if (est_caution_solidaire==1)`).
 * On la détecte et on alerte pour réservation manuelle.
 */

/* ─────────────────────────── Helpers de parsing ─────────────────────────── */

/** Enlève les balises HTML et normalise les espaces d'un fragment. */
function stripTags(html) {
  return String(html)
    .replace(/<sup>2<\/sup>/gi, '²') // m<sup>2</sup> → m²
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Découpe une ligne <tr> en ses cellules <td> (contenu HTML brut de chacune). */
function splitCells(rowHtml) {
  return [...rowHtml.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => m[1]);
}

/** "984,41 €" → 984.41 ; "1 234,56 €" → 1234.56 ; illisible → null. */
function parseMontant(txt) {
  const cleaned = String(txt).replace(/[^\d.,]/g, '');
  if (!cleaned) return null;
  // Format FR : la virgule est le séparateur décimal, le point (rare) les milliers.
  const n = parseFloat(cleaned.replace(/\./g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

/** "41,00 m²" → 41 ; illisible → null. */
function parseSurface(txt) {
  return parseMontant(txt);
}

/** Normalise un type pour comparaison : "t1  bis" → "T1 BIS". */
export function normalizeType(t) {
  return String(t).toUpperCase().replace(/\s+/g, ' ').trim();
}

/**
 * Repère tous les conteneurs de niveau `<div id="niveau_R_A_C_N_logements">` avec
 * leur position dans le HTML. Ces <div> sont des frères (jamais imbriqués), donc
 * une ligne <tr> appartient au DERNIER conteneur ouvert avant elle.
 */
function buildNiveauIndex(html) {
  const idx = [];
  const re = /<div\s+id="niveau_(\d+)_([A-Za-z0-9]+)_([A-Za-z0-9]+)_(\d+)_logements"/gi;
  for (const m of html.matchAll(re)) {
    idx.push({
      pos: m.index,
      residence: m[1],
      aile: m[2],
      cage: m[3],
      niveau: m[4],
    });
  }
  return idx;
}

/** Dernier conteneur de niveau ouvert avant la position `pos`. */
function locateNiveau(idx, pos) {
  let found = null;
  for (const c of idx) {
    if (c.pos < pos) found = c;
    else break;
  }
  return found;
}

/**
 * Parse toutes les lignes de logements disponibles présentes dans le HTML.
 * Structure confirmée (cf. docs/html-samples + reserve_step_J.html) :
 *   td[0] = toggle "Réservation ?" (#check_logement_XXX) + message_affectation
 *   td[1] = N° logement (ex. 3EC201)   td[2] = Type
 *   td[3] = Colocation ?               td[4] = Nbr occupants
 *   td[5] = PMR ?                      td[6] = Surface
 *   td[7] = Balcon ?                   td[8] = Boursier prioritaire ?
 *   td[9] = Loyer CC   td[10] = Dépôt garantie   td[11] = Frais de dossier
 *
 * Le CODE de réservation (keyid) est le suffixe de l'id `tr_logement_XXX`
 * (ex. `3EC201A`) — c'est bien ce que le site place dans #keyid au submit, PAS
 * le n° logement affiché (`3EC201`). On garde donc les deux distinctement.
 *
 * Chaque logement est enrichi de SA localisation (résidence / aile / escalier /
 * niveau) déduite du <div> englobant — indispensable dès qu'il y a plusieurs
 * résidences dispos en même temps.
 */
export function parseLogements(html) {
  const niveaux = buildNiveauIndex(html);
  const rows = [...html.matchAll(/<tr\s+id="tr_logement_([^"]+)"[^>]*>([\s\S]*?)<\/tr>/gi)];
  const result = [];
  for (const m of rows) {
    const [, keyid, rowHtml] = m;
    const tds = splitCells(rowHtml);
    const at = (n) => stripTags(tds[n] || '');
    const loc = locateNiveau(niveaux, m.index);
    // Repli si le <div> englobant n'est pas identifiable : le site lui-même
    // déduit la résidence du 1er caractère du keyid (`keyid.substr(0,1)`).
    const residence = loc?.residence || (String(keyid).match(/^\d/) || [''])[0];

    const l = {
      keyid,                 // = suffixe tr_logement_XXX → valeur du champ #keyid
      checkboxId: `check_logement_${keyid}`,
      code: at(1) || keyid,  // n° logement affiché (ex. 3EC201)
      type: at(2),
      colocation: at(3),
      colocationHtml: (tds[3] || '').trim(), // brut : sert à détecter "Loyer solidaire"
      nbOccupants: at(4),
      pmr: at(5),
      surface: at(6),
      balcon: at(7),
      boursier: at(8),
      loyer: at(9),
      depotGarantie: at(10),
      fraisDossier: at(11),

      // ── Champs dérivés (sélection & tri) ──────────────────────────────────
      residence,                                   // "3"
      residenceId: residence ? `residence_${residence}` : '',
      aile: loc?.aile || '',
      cage: loc?.cage || '',
      niveau: loc?.niveau || '',
      typeNorm: normalizeType(at(2)),
      loyerNum: parseMontant(at(9)),
      surfaceNum: parseSurface(at(6)),
    };
    l.chemin = buildCheminLogement(l);
    result.push(l);
  }
  return result;
}

/** "Résidence III › Aile E › Escalier C › Niveau R+2" pour UN logement précis. */
export function buildCheminLogement(l) {
  const parts = [residenceLabel(l.residence)];
  if (l.aile) parts.push(`Aile ${l.aile}`);
  if (l.cage) parts.push(`Escalier ${l.cage}`);
  if (l.niveau) parts.push(`Niveau R+${l.niveau}`);
  return parts.join(' › ');
}

/** Nombre d'occupants du logement (1 si illisible). */
export function nbOccupantsOf(l) {
  const nb = parseInt(String(l.nbOccupants).replace(/\D/g, ''), 10);
  return Number.isFinite(nb) && nb > 0 ? nb : 1;
}

/**
 * Détermine si un logement est une COLOCATION.
 * Deux signaux, l'un OU l'autre suffit : "Colocation ? = Oui", ou occupants > 1.
 */
export function isColocation(l) {
  if (nbOccupantsOf(l) > 1) return true;
  return /\boui\b/i.test(l.colocation || '');
}

/**
 * Colocation SOLIDAIRE = celle qui BLOQUE l'auto-réservation. Reproduit à
 * l'identique le test du JS du site (case 3 du parcours des <td>) :
 *   est_caution_solidaire = 1  ssi  la cellule vaut "Oui" + "Loyer solidaire".
 * C'est cette valeur qui déclenche, côté site, l'exigence d'un email de
 * colocataire ayant un compte Césal actif (cesal_ajax_check_email.php).
 * Un "Oui / Loyer NON solidaire" (ex. T2 jumelé) ne déclenche PAS ce contrôle.
 */
export function isSolidaire(l) {
  const txt = String(l.colocation || '');
  return /\boui\b/i.test(txt) && /loyer solidaire/i.test(txt) && !/non solidaire/i.test(txt);
}

/** Valeur à envoyer dans le champ caché `est_caution_solidaire`. */
export function estCautionSolidaireValue(l) {
  return isSolidaire(l) ? '1' : '0';
}

/**
 * Extrait tous les champs du <form id="action-validation_reservation"> tel qu'il
 * est dans le HTML, sous forme de paires {name: value}. On repart des VRAIS
 * champs de la page (plutôt que de les reconstruire à la main) pour rester
 * robuste si le site ajoute/retire un champ. On ne garde que les inputs à
 * l'intérieur de CE form précis.
 */
export function parseReservationForm(html) {
  const formMatch = html.match(
    /<form[^>]*id="action-validation_reservation"[^>]*>([\s\S]*?)<\/form>/i
  );
  if (!formMatch) return null;
  const inner = formMatch[1];
  const fields = {};
  for (const m of inner.matchAll(/<input\b([^>]*)>/gi)) {
    const attrs = m[1];
    const name = (attrs.match(/\bname="([^"]*)"/i) || [])[1];
    if (!name) continue;
    const value = (attrs.match(/\bvalue="([^"]*)"/i) || [])[1] ?? '';
    fields[name] = value;
  }
  return fields;
}

/** Formate les caractéristiques d'un logement en lignes lisibles pour Telegram. */
export function formatLogementDetails(l) {
  return [
    `🔑 N° logement : ${l.code}`,
    `📍 ${l.chemin || buildCheminLogement(l)}`,
    `🏷️ Type : ${l.type}`,
    `👥 Colocation : ${l.colocation}`,
    `🔢 Nbr occupants : ${l.nbOccupants}`,
    `📐 Surface : ${l.surface}`,
    `💶 Loyer charges comprises : ${l.loyer}`,
    `🔒 Dépôt garantie : ${l.depotGarantie}`,
    `📄 Frais de dossier : ${l.fraisDossier}`,
  ].join('\n');
}

/** Ligne compacte pour l'inventaire "voici tout ce qui est dispo". */
function formatLogementLigne(l) {
  const flags = [];
  if (isSolidaire(l)) flags.push('👥 coloc solidaire');
  else if (isColocation(l)) flags.push(`👥 coloc (${nbOccupantsOf(l)})`);
  else flags.push('🙋 individuel');
  if (/\boui\b/i.test(l.pmr || '')) flags.push('♿ PMR');
  return `• <b>${l.code}</b> — ${l.type}, ${l.surface}, ${l.loyer} — ${l.chemin} — ${flags.join(', ')}`;
}

/* ────────────────────────────── Sélection ──────────────────────────────── */

/**
 * Trie/filtre les logements pour décider LEQUEL réserver quand plusieurs sont
 * dispos en même temps. Critères, dans cet ordre :
 *
 *   1. la résidence doit être auto-réservable (config.autoReserveResidences) ;
 *   2. pas de colocation solidaire (le site la refuserait de toute façon) ;
 *      pas de colocation du tout, sauf si ALLOW_COLOC_NON_SOLIDAIRE=true ;
 *   3. type préféré (config.preferredTypes, ordre = préférence : T1 d'abord) ;
 *      STRICT_TYPES=true → un type hors liste n'est jamais réservé ;
 *   4. individuel avant colocation non solidaire (si celle-ci est autorisée) ;
 *   5. ordre des résidences tel que configuré (ex. "3,4" → III avant IV) ;
 *   6. loyer le moins cher, puis plus grande surface, puis code (déterminisme).
 *
 * @returns {{candidats: object[], colocSolidaires: object[], horsPrefs: object[]}}
 *   candidats = réservables, du meilleur au moins bon.
 *   colocSolidaires = en III/IV mais bloquées par le site → alerte manuelle.
 *   horsPrefs = en III/IV, réservables techniquement, mais écartées par STRICT_TYPES.
 */
export function rankCandidates(logements, opts = {}) {
  const residences = opts.autoReserveResidences || config.autoReserveResidences;
  const prefs = (opts.preferredTypes || config.preferredTypes).map(normalizeType);
  const strict = opts.strictTypes ?? config.strictTypes;
  const allowColoc = opts.allowColocNonSolidaire ?? config.allowColocNonSolidaire;

  const dansResidencesCibles = logements.filter((l) => residences.includes(String(l.residence)));

  const colocSolidaires = dansResidencesCibles.filter(isSolidaire);
  const reservablesTech = dansResidencesCibles.filter(
    (l) => !isSolidaire(l) && (allowColoc || !isColocation(l))
  );

  const typeRank = (l) => {
    const i = prefs.indexOf(l.typeNorm);
    return i === -1 ? prefs.length : i;
  };

  const horsPrefs = strict ? reservablesTech.filter((l) => typeRank(l) === prefs.length) : [];
  const candidats = (strict
    ? reservablesTech.filter((l) => typeRank(l) < prefs.length)
    : reservablesTech
  ).slice();

  candidats.sort((a, b) => {
    const t = typeRank(a) - typeRank(b);
    if (t) return t;
    const c = Number(isColocation(a)) - Number(isColocation(b)); // individuel d'abord
    if (c) return c;
    const r = residences.indexOf(String(a.residence)) - residences.indexOf(String(b.residence));
    if (r) return r;
    const la = a.loyerNum ?? Infinity;
    const lb = b.loyerNum ?? Infinity;
    if (la !== lb) return la - lb;
    const sa = a.surfaceNum ?? 0;
    const sb = b.surfaceNum ?? 0;
    if (sa !== sb) return sb - sa; // plus grande surface d'abord
    return String(a.code).localeCompare(String(b.code));
  });

  return { candidats, colocSolidaires, horsPrefs };
}

/* ────────────────────────────── Réservation ────────────────────────────── */

/**
 * Envoie le POST de validation d'une réservation (équivalent HTTP exact du clic
 * "Valider votre réservation"). On repart des champs réels du form, puis on
 * REPOSE les 3 champs que le JS du site recalcule à chaque sélection de ligne :
 *   #keyid                 ← keyid du logement choisi  (submit_reservation)
 *   #nb_occupants          ← td[4] de SA ligne          (handler du clic)
 *   #est_caution_solidaire ← td[3] de SA ligne          (handler du clic)
 * Sans ça, avec plusieurs logements dispos, on enverrait les occupants d'un
 * autre logement que celui qu'on réserve. Renvoie { status, html, sent }.
 */
export function buildValidationPayload(formFields, logement) {
  return {
    ...formFields,
    keyid: logement.keyid,
    nb_occupants: String(nbOccupantsOf(logement)),
    est_caution_solidaire: estCautionSolidaireValue(logement),
  };
}

async function postValidation(cookieHeader, formFields, logement) {
  const payload = buildValidationPayload(formFields, logement);
  const body = new URLSearchParams(payload);
  const res = await fetch(URLS.reservation, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      origin: 'https://logement.cesal.fr',
      referer: URLS.reservation,
      'user-agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36',
      cookie: cookieHeader,
    },
    body: body.toString(),
  });
  const html = await res.text().catch(() => '');
  return { status: res.status, html, sent: payload };
}

/**
 * Interprète la réponse du POST de validation pour dire si la réservation a
 * réellement abouti. Signaux (déduits du JS/HTML du site) :
 *   • ÉCHEC   : message NON VIDE dans #submit_reservation_error_message.
 *   • SUCCÈS  : confirmation explicite, ou disparition du bouton "Valider votre
 *               réservation" sans message d'erreur.
 * En cas de doute on renvoie 'incertain' pour ne jamais annoncer un faux succès.
 */
export function interpretValidationResult(html) {
  const text = stripTags(html);

  // La page renvoyée est encore un login → session tombée pile pendant le POST.
  if (/g-recaptcha|name="login-email"/.test(html)) {
    return { ok: false, reason: 'Session expirée pendant la validation' };
  }

  // ⚠️ Le div #submit_reservation_error (titre "VALIDATION DES INFORMATIONS
  // IMPOSSIBLE") est TOUJOURS présent dans la page en display:none — sa simple
  // présence NE signifie PAS un échec. Le vrai signal d'échec serveur est un
  // MESSAGE d'erreur NON VIDE dans #submit_reservation_error_message (rempli
  // côté serveur en cas de refus), donc on ne conclut à l'échec que là-dessus.
  const errMsg = stripTags(
    (html.match(/id="submit_reservation_error_message"[^>]*>([\s\S]*?)<\/span>/i) || [])[1] || ''
  );
  if (errMsg) {
    return { ok: false, reason: errMsg };
  }

  // Confirmation explicite du voeu (le site affiche l'état "réservé / en cours"
  // ou la demande enregistrée). Formulations à confirmer sur un vrai succès.
  if (/logement r.serv|r.servation (enregistr|valid|confirm)|voeu.*enregistr|demande.*enregistr/i.test(text)) {
    return { ok: true };
  }

  // Si le formulaire de validation ("Valider votre réservation") a disparu de la
  // page ET qu'aucun message d'erreur n'est rempli, la demande a très
  // probablement été prise → succès probable (à vérifier côté site).
  if (!/Valider votre r.servation/i.test(html)) {
    return { ok: true, probable: true };
  }

  // Le formulaire est encore là sans erreur remplie : soit le POST n'a rien
  // changé, soit la page ne reflète pas encore le voeu → indéterminé.
  return { ok: null, reason: 'résultat indéterminé' };
}

/** Sauvegarde best-effort d'un HTML dans config/ (debug post-mortem). */
async function dumpHtml(nom, html) {
  try {
    const { writeFileSync } = await import('fs');
    writeFileSync(new URL(`../config/${nom}`, import.meta.url).pathname, html);
  } catch {}
}

/**
 * Traite une dispo à partir du HTML DÉJÀ récupéré par la surveillance.
 * UN SEUL appel par cycle, quel que soit le nombre de résidences dispos : le
 * HTML contient tout, et c'est ICI qu'on trie pour choisir le bon logement.
 *
 * @param {string}  html          réponse HTML complète (POST modifier_date_arrivee)
 * @param {string}  cookieHeader  cookie de session (pour le POST de validation)
 * @param {object}  opts
 * @param {string}  opts.contexte libellé lisible de la dispo (pour les messages d'erreur)
 * @param {boolean} opts.commit   true → tente réellement la validation ; false → détails seuls
 * @returns {Promise<{handled:boolean, reserved?:boolean, chosen?:object}>}
 */
export async function handleAvailability(html, cookieHeader, opts = {}) {
  const { contexte = '', commit = false } = opts;
  const logements = parseLogements(html);
  if (logements.length === 0) {
    // Dispo annoncée par les compteurs mais aucune ligne logement lisible :
    // structure inattendue → on le signale (et on garde le HTML pour debug).
    await dumpHtml('reserve_http_no_logement.html', html);
    await notify(
      `⚠️ Dispo détectée (${contexte}) mais aucune ligne logement lisible dans le HTML. ` +
      `HTML sauvegardé pour debug.\n👉 Vérifie à la main : ${URLS.reservation}`
    );
    return { handled: false };
  }

  // Anti-doublon quotidien (par code logement) : on ne retraite QUE les
  // logements jamais vus aujourd'hui — sinon on re-tenterait la même
  // réservation refusée toutes les 3 secondes.
  const { filterNewCodes, markSeen } = await import('./seen.js');
  const allCodes = logements.map((l) => l.code);
  const newCodes = filterNewCodes(allCodes);
  const nouveaux = logements.filter((l) => newCodes.includes(l.code));
  if (nouveaux.length === 0) {
    console.log(`[reserve-http] Logement(s) ${allCodes.join(', ')} déjà notifié(s) aujourd'hui.`);
    return { handled: true };
  }
  markSeen(allCodes);

  const { candidats, colocSolidaires, horsPrefs } = rankCandidates(nouveaux);
  const chosen = candidats[0] || null;

  // ── Inventaire envoyé IMMÉDIATEMENT (0 requête réseau, quelques ms). ──────
  const inventaire = nouveaux.map(formatLogementLigne).join('\n');
  const entete =
    nouveaux.length > 1
      ? `🏠 <b>${nouveaux.length} LOGEMENTS DISPONIBLES !</b>\n\n${inventaire}`
      : `🏠 <b>Logement disponible !</b>\n\n${formatLogementDetails(nouveaux[0])}`;

  let verdict;
  if (!commit) {
    verdict =
      `\n\nℹ️ Aucune résidence auto-réservable (${config.autoReserveResidences
        .map((r) => residenceLabel(r))
        .join(' / ')}) dans le lot → pas de réservation auto.` +
      `\n👉 Pour en prendre un : ${URLS.reservation}`;
  } else if (chosen) {
    verdict =
      `\n\n🎯 <b>Choix du bot → ${chosen.code}</b> (${chosen.type}, ${chosen.loyer}, ${chosen.chemin})` +
      `${nouveaux.length > 1 ? `\n   (meilleur des ${candidats.length} réservables selon tes préférences : ${config.preferredTypes.join(' > ')}, sans colocation)` : ''}` +
      `\n⏳ Validation en cours…`;
  } else if (colocSolidaires.length) {
    verdict = `\n\n🚨 Rien d'auto-réservable : que des colocations solidaires (email colocataire exigé par le site).`;
  } else {
    verdict = `\n\nℹ️ Rien d'auto-réservable dans tes résidences/types configurés.`;
  }

  await notify(entete + verdict);

  // ── Hors III/IV → on s'arrête après avoir envoyé les détails. ─────────────
  if (!commit) return { handled: true, reserved: false };

  // ── Colocations solidaires : non auto-réservables → alerte manuelle. ──────
  if (colocSolidaires.length) {
    await notify(
      `🚨🚨 <b>COLOCATION DISPO — ACTION MANUELLE REQUISE</b> 🚨🚨\n\n` +
      colocSolidaires.map((l) => `${formatLogementDetails(l)}\n`).join('\n') +
      `\n👥 Le site exige l'email d'un colocataire ayant un compte Césal actif — ` +
      `le bot ne peut pas réserver seul.\n\n` +
      `⚡️ <b>SI ÇA T'INTÉRESSE, RÉSERVE TOI-MÊME :</b>\n🔗 ${URLS.reservation}`
    );
  }

  if (horsPrefs.length) {
    await notify(
      `ℹ️ Écartés par STRICT_TYPES (types hors ${config.preferredTypes.join(', ')}) : ` +
      horsPrefs.map((l) => `${l.code} (${l.type})`).join(', ') +
      `\n👉 À prendre à la main si tu veux : ${URLS.reservation}`
    );
  }

  if (!chosen) return { handled: true, reserved: false };

  // ── VALIDATION HTTP DIRECTE, dans l'ordre de préférence. ──────────────────
  const formFields = parseReservationForm(html);
  if (!formFields) {
    await notify(
      `⚠️ Logement ${chosen.code} sélectionné mais formulaire de validation ` +
      `introuvable dans le HTML. Réserve à la main tout de suite : ${URLS.reservation}`
    );
    return { handled: true, reserved: false };
  }

  const aTenter = candidats.slice(0, Math.max(1, config.maxReserveAttempts));
  for (const [i, cible] of aTenter.entries()) {
    const details = formatLogementDetails(cible);
    let result;
    let respHtml = '';
    try {
      const resp = await postValidation(cookieHeader, formFields, cible);
      respHtml = resp.html || '';
      // On SAUVEGARDE systématiquement la réponse du POST de validation : le
      // format exact d'une page "succès" n'a jamais été capturé, donc ce dump
      // permet d'ajuster interpretValidationResult() dès la première fois.
      await dumpHtml(`reserve_http_validation_${cible.code}.html`, respHtml);
      if (resp.status >= 300 && resp.status < 400) {
        // Une redirection ici est généralement le rechargement post-succès de la
        // page. On ne peut pas conclure fermement → succès "probable".
        result = { ok: true, probable: true };
      } else {
        result = interpretValidationResult(respHtml);
      }
    } catch (err) {
      await notify(
        `⚠️ <b>Erreur réseau pendant la validation</b> de ${cible.code} : ` +
        `<code>${escapeHtml(err.message)}</code>\n👉 Réserve à la main : ${URLS.reservation}`
      );
      continue;
    }

    // ── Envoi du HTML COMPLET de la réponse dès que le résultat n'est PAS un
    //    succès net (échec, incertain, ou succès seulement "probable"). But :
    //    voir sur ton téléphone ce qui a pu entraver la réservation (pop-up,
    //    champ manquant, message serveur…) SANS aucun navigateur.
    const isSureSuccess = result.ok === true && !result.probable;
    if (!isSureSuccess) {
      try {
        await notifyDocument(
          `🧾 <b>HTML de la réponse de validation</b> — ${cible.code} (${cible.chemin}).\n` +
          `À inspecter : pop-up / champ manquant / message serveur ?`,
          Buffer.from(respHtml, 'utf8'),
          `validation_${cible.code}.html`
        );
      } catch (e) {
        console.warn('[reserve-http] Envoi HTML de validation échoué:', e.message);
      }
    }

    if (result.ok === true) {
      await notify(
        `✅✅ <b>RÉSERVATION ${result.probable ? 'PROBABLEMENT ' : ''}CONFIRMÉE !</b> 🎉\n\n` +
        `${details}\n\n` +
        (result.probable
          ? `⚠️ Résultat non 100 % certain côté site — <b>VÉRIFIE</b> (HTML envoyé ci-dessus) : ${URLS.reservation}`
          : `🔗 Complète ton dossier : ${URLS.reservation}`)
      );
      return { handled: true, reserved: true, chosen: cible };
    }

    const suivant = aTenter[i + 1];
    const suite = suivant
      ? `\n\n➡️ J'enchaîne sur le suivant : <b>${suivant.code}</b> (${suivant.type}, ${suivant.loyer}).`
      : `\n\n⚡️ <b>Réserve à la main TOUT DE SUITE :</b>\n🔗 ${URLS.reservation}`;

    if (result.ok === false) {
      await notify(
        `❌ <b>RÉSERVATION ÉCHOUÉE</b> (${cible.code}) — le site a refusé.\n\n` +
        `${details}\n\n🛑 <b>Raison :</b> ${escapeHtml(result.reason || 'inconnue')}` +
        `\n📎 HTML complet de la réponse envoyé ci-dessus.` + suite
      );
    } else {
      await notify(
        `⚠️ <b>Réservation — résultat INCERTAIN</b> (${cible.code}, ${escapeHtml(result.reason || '')}).\n\n` +
        `${details}\n📎 HTML complet de la réponse envoyé ci-dessus.` +
        `\n👉 <b>VÉRIFIE ET/OU RÉSERVE À LA MAIN :</b>\n🔗 ${URLS.reservation}`
      );
      // Résultat indéterminé : on NE tente PAS le suivant — le voeu est
      // peut-être déjà pris, réserver un 2e logement serait pire que rien.
      return { handled: true, reserved: false, chosen: cible };
    }
  }

  return { handled: true, reserved: false, chosen };
}
