import { config, URLS } from './config.js';
import { notify, notifyDocument, escapeHtml } from './notify.js';
import { postForm, getPage, looksLikeLogin } from './http.js';

/**
 * RÉSERVATION HTTP + VÉRIFICATION D'ÉTAT.
 *
 * ── Ce qui n'allait pas (audit du 04/08/2026) ─────────────────────────────
 * Une Résidence III/IV s'est libérée, le bot a envoyé "✅ RÉSERVATION
 * PROBABLEMENT CONFIRMÉE", et rien n'était réservé. Trois causes cumulées :
 *
 *  1. PAYLOAD INCOMPLET. Le formulaire #action-validation_reservation est bien
 *     présent dans le HTML, mais VIDE : ce sont les scripts du site qui le
 *     remplissent quand on coche le toggle #check_logement_XXX (date de début
 *     de bail, date de fin souhaitée, nb d'occupants, keyid, message
 *     d'affectation — cf. la capture "Votre réservation de logement"). En HTTP
 *     pur, aucun de ces scripts ne tourne : l'ancien code repostait les champs
 *     tels quels, donc VIDES, en ne renseignant que `keyid`. Le serveur n'avait
 *     aucune raison d'enregistrer quoi que ce soit.
 *
 *  2. SUCCÈS DÉCLARÉ SANS PREUVE. `interpretValidationResult` concluait au
 *     succès dès que la chaîne "Valider votre réservation" était absente de la
 *     réponse — ce qui est justement le cas de toutes les pages d'erreur, de la
 *     page de login, ou d'un simple retour à l'accueil. Idem pour toute
 *     redirection 3xx, comptée comme succès. D'où le faux ✅.
 *
 *  3. L'OCCASION ÉTAIT BRÛLÉE. La signature et les codes logement étaient
 *     marqués "vus" AVANT la tentative : après l'échec, plus aucune alerte ni
 *     nouvel essai de la journée sur un logement pourtant toujours libre.
 *
 * ── Ce qu'on fait maintenant ──────────────────────────────────────────────
 *  • on reconstruit le payload en ÉMULANT ce que fait le JS du site ;
 *  • on ne déclare JAMAIS un succès sur la seule foi de la réponse au POST :
 *    on RELIT la page du compte et on vérifie qu'un logement y est réservé ;
 *  • si ce n'est pas le cas, on rejoue le flux dans un vrai navigateur (qui
 *    exécute le JS du site et la popup de confirmation), puis on re-vérifie ;
 *  • tant que rien n'est confirmé, on n'éteint ni l'alerte ni les tentatives.
 *
 * La colocation reste non auto-réservable : le site exige côté serveur l'email
 * d'un colocataire ayant un compte Césal actif (cesal_ajax_check_email.php).
 */

/* ─────────────────────────── Helpers de parsing ─────────────────────────── */

const ENTITIES = {
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"',
  '&#39;': "'", '&apos;': "'", '&nbsp;': ' ', '&eacute;': 'é', '&egrave;': 'è',
};

/** Décode les entités HTML d'un attribut (les valeurs de champ en contiennent). */
export function decodeEntities(str) {
  return String(str).replace(/&(amp|lt|gt|quot|#39|apos|nbsp|eacute|egrave);/gi, (m) => ENTITIES[m.toLowerCase()] ?? m);
}

/** Enlève les balises HTML et normalise les espaces d'un fragment. */
function stripTags(html) {
  return String(html)
    .replace(/<sup>2<\/sup>/gi, '²') // m<sup>2</sup> → m²
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Lit la valeur d'un attribut dans une chaîne d'attributs de balise. */
function attr(attrs, name) {
  const m =
    attrs.match(new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, 'i')) ||
    attrs.match(new RegExp(`\\b${name}\\s*=\\s*'([^']*)'`, 'i'));
  return m ? m[1] : undefined;
}

/** Découpe une ligne <tr> en ses cellules <td> (contenu HTML brut de chacune). */
function splitCells(rowHtml) {
  return [...rowHtml.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => m[1]);
}

/**
 * Repère les conteneurs de niveau `id="niveau_<res>_<aile>_<cage>_<niv>_logements"`
 * pour pouvoir rattacher chaque ligne logement à SA résidence.
 *
 * ⚠️ Sans ça, `parseLogements` ramassait indistinctement toutes les lignes de la
 * page : si la Résidence I et la Résidence III avaient chacune une dispo, le bot
 * pouvait très bien tenter de réserver celui de la Résidence I alors qu'il avait
 * été déclenché pour la III. On filtre maintenant explicitement.
 */
function niveauMarkers(html) {
  return [...html.matchAll(/id="(niveau_(\d+)_[A-Za-z0-9_]+?)_logements"/g)].map((m) => ({
    index: m.index,
    niveauId: m[1],
    residenceNum: m[2],
  }));
}

/**
 * Parse toutes les lignes de logements disponibles présentes dans le HTML.
 * Structure confirmée (cf. docs/html-samples/tableaux_1D112_extrait.html) :
 *   td[0] = toggle "Réservation ?" (#check_logement_XXX) + message_affectation
 *   td[1] = N° logement (ex. 3EC201)   td[2] = Type
 *   td[3] = Colocation ?               td[4] = Nbr occupants
 *   td[5] = PMR ?                      td[6] = Surface
 *   td[7] = Balcon ?                   td[8] = Boursier prioritaire ?
 *   td[9] = Loyer CC   td[10] = Dépôt garantie   td[11] = Frais de dossier
 *
 * Le CODE de réservation (keyid) est le suffixe de l'id `tr_logement_XXX` — c'est
 * ce que le site place dans #keyid au submit, PAS forcément le n° affiché.
 */
export function parseLogements(html) {
  const markers = niveauMarkers(html);
  const rows = [...html.matchAll(/<tr\s+id="tr_logement_([^"]+)"[^>]*>([\s\S]*?)<\/tr>/gi)];
  const result = [];
  for (const row of rows) {
    const [, keyid, rowHtml] = row;
    const tds = splitCells(rowHtml);
    const at = (n) => stripTags(tds[n] || '');

    // Conteneur de niveau le plus proche AVANT cette ligne → sa résidence.
    let owner = null;
    for (const m of markers) {
      if (m.index < row.index) owner = m;
      else break;
    }

    // <input type="hidden" id="message_affectation_XXX" value="La date de fin de
    // bail maximale autorisée…"> : le site le recopie dans le formulaire final.
    const msg = rowHtml.match(/id="message_affectation_[^"]*"[^>]*/i);
    const messageAffectation = msg ? decodeEntities(attr(msg[0], 'value') || '') : '';

    result.push({
      keyid,                 // = suffixe tr_logement_XXX → valeur du champ #keyid
      checkboxId: `check_logement_${keyid}`,
      code: at(1) || keyid,  // n° logement affiché (ex. 3EC201)
      type: at(2),
      colocation: at(3),
      nbOccupants: at(4),
      pmr: at(5),
      surface: at(6),
      balcon: at(7),
      boursier: at(8),
      loyer: at(9),
      depotGarantie: at(10),
      fraisDossier: at(11),
      messageAffectation,
      niveauId: owner?.niveauId || null,
      residenceNum: owner?.residenceNum || null,
    });
  }
  return result;
}

/** Ne garde que les logements rattachés à la résidence demandée (ex. '3'). */
export function filterByResidence(logements, residenceNum) {
  if (!residenceNum) return logements;
  const scoped = logements.filter((l) => l.residenceNum === String(residenceNum));
  // Repli : si le rattachement n'a pas pu être fait (structure inattendue), on
  // préfère rendre la liste complète plutôt que de rater la dispo — mais
  // l'appelant est prévenu via `scopeKnown`.
  return scoped.length ? scoped : logements.filter((l) => l.residenceNum === null);
}

/**
 * Détermine si un logement est une COLOCATION (non auto-réservable en solo).
 * Deux signaux, l'un OU l'autre suffit : "Colocation ? = Oui", ou occupants > 1.
 */
export function isColocation(l) {
  const nb = parseInt(String(l.nbOccupants).replace(/\D/g, ''), 10);
  if (Number.isFinite(nb) && nb > 1) return true;
  return /\boui\b/i.test(l.colocation || '');
}

/* ────────────────── Formulaire de validation : extraction ────────────────── */

/**
 * Extrait le formulaire de validation et TOUS ses champs soumissibles.
 *
 * Corrections par rapport à l'ancienne version, qui ne lisait que les <input> :
 *   • les <select> et <textarea> sont désormais pris en compte (un champ oublié
 *     = un formulaire refusé côté serveur) ;
 *   • les checkbox/radio NON cochées sont exclues — un navigateur ne les envoie
 *     pas, les inclure fait diverger le POST de ce que le site attend ;
 *   • les boutons (submit/button/reset/image) sont exclus ;
 *   • les valeurs sont décodées (entités HTML).
 */
export function parseValidationForm(html) {
  const forms = [...html.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/gi)];
  let picked = null;
  for (const f of forms) {
    const id = attr(f[1], 'id') || '';
    const action = attr(f[1], 'action') || '';
    if (/validation_reservation/i.test(id) || /validation_reservation/i.test(action)) {
      picked = f;
      break;
    }
  }
  // Repli : le formulaire qui contient le champ #keyid.
  if (!picked) picked = forms.find((f) => /name="keyid"/i.test(f[2]));
  if (!picked) return null;

  const inner = picked[2];
  const fields = [];

  for (const m of inner.matchAll(/<input\b([^>]*?)\/?>/gi)) {
    const attrs = m[1];
    const name = attr(attrs, 'name');
    if (!name) continue;
    const type = (attr(attrs, 'type') || 'text').toLowerCase();
    if (['submit', 'button', 'reset', 'image', 'file'].includes(type)) continue;
    const checked = /\bchecked\b/i.test(attrs);
    if ((type === 'checkbox' || type === 'radio') && !checked) continue;
    const raw = attr(attrs, 'value');
    const value = decodeEntities(raw ?? (type === 'checkbox' || type === 'radio' ? 'on' : ''));
    fields.push({ name, value, type });
  }

  for (const m of inner.matchAll(/<select\b([^>]*)>([\s\S]*?)<\/select>/gi)) {
    const name = attr(m[1], 'name');
    if (!name) continue;
    const options = [...m[2].matchAll(/<option\b([^>]*)>([\s\S]*?)<\/option>/gi)];
    const chosen = options.find((o) => /\bselected\b/i.test(o[1])) || options[0];
    const value = chosen ? decodeEntities(attr(chosen[1], 'value') ?? stripTags(chosen[2])) : '';
    fields.push({ name, value, type: 'select' });
  }

  for (const m of inner.matchAll(/<textarea\b([^>]*)>([\s\S]*?)<\/textarea>/gi)) {
    const name = attr(m[1], 'name');
    if (!name) continue;
    fields.push({ name, value: decodeEntities(stripTags(m[2])), type: 'textarea' });
  }

  return { id: attr(picked[1], 'id') || '', action: attr(picked[1], 'action') || '', fields };
}

/** Rétro-compat : ancienne API {name: value}, encore utilisée par des scripts. */
export function parseReservationForm(html) {
  const parsed = parseValidationForm(html);
  if (!parsed) return null;
  return Object.fromEntries(parsed.fields.map((f) => [f.name, f.value]));
}

/**
 * Construit le corps du POST de validation en ÉMULANT ce que fait le JS du site
 * lorsqu'on coche le toggle #check_logement_XXX puis qu'on clique "Valider
 * votre réservation" :
 *
 *   • #keyid                        ← code de réservation du logement choisi
 *   • check_logement_<keyid>=on     ← le toggle réellement coché
 *   • message_affectation_<keyid>   ← recopié depuis la ligne du tableau
 *   • date de début de bail         ← date d'arrivée sélectionnée pour le scan
 *   • date de fin de bail souhaitée ← DATE_SORTIE
 *   • nb d'occupants                ← valeur de la ligne du tableau
 *   • action=validation_reservation ← si le formulaire ne le porte pas lui-même
 *
 * Les noms de champs varient : on les repère par MOTIF plutôt qu'en dur, et on
 * ne remplit que ceux qui sont VIDES (jamais d'écrasement d'une valeur que le
 * site aurait déjà posée).
 *
 * Renvoie { body, fields, filled, stillEmpty } — `filled`/`stillEmpty` servent
 * au diagnostic envoyé sur Telegram en cas d'échec.
 */
export function buildValidationPayload(html, logement, { dateArrivee, dateSortie } = {}) {
  const parsed = parseValidationForm(html);
  if (!parsed) return null;

  const fields = new Map(parsed.fields.map((f) => [f.name, f.value]));
  const filled = [];

  const force = (name, value) => {
    if (value === undefined || value === null || value === '') return;
    if (fields.get(name) !== String(value)) filled.push(name);
    fields.set(name, String(value));
  };
  const fillIfEmpty = (name, value) => {
    if (value === undefined || value === null || value === '') return;
    if ((fields.get(name) ?? '') === '') {
      fields.set(name, String(value));
      filled.push(name);
    }
  };

  // 1. Le logement choisi.
  force('keyid', logement.keyid);
  force(`check_logement_${logement.keyid}`, 'on');
  if (logement.messageAffectation) {
    force(`message_affectation_${logement.keyid}`, logement.messageAffectation);
  }

  // 2. L'action : si le formulaire ne porte pas son propre champ `action`, le
  //    POST ne serait rattaché à aucun traitement côté serveur.
  if (!fields.get('action')) force('action', 'validation_reservation');

  // 3. Les dates. Le site les affiche ("Date de début de bail 06/08/2026",
  //    "Date de fin de bail souhaitée 18/12/2026") uniquement après le clic sur
  //    le toggle — donc vides dans le HTML brut.
  const nbOcc = String(logement.nbOccupants || '').replace(/\D/g, '');
  for (const name of fields.keys()) {
    if (/date/i.test(name) && /(entree|entrée|arrivee|arrivée|debut|début)/i.test(name)) {
      fillIfEmpty(name, dateArrivee);
    } else if (/date/i.test(name) && /(sortie|fin)/i.test(name)) {
      fillIfEmpty(name, dateSortie);
    } else if (/(nb|nombre).*occupant/i.test(name)) {
      fillIfEmpty(name, nbOcc);
    }
  }

  // 4. Filet : certains formulaires n'exposent le champ qu'au moment du submit
  //    JS. Si aucune date n'a pu être posée, on ajoute les noms canoniques vus
  //    sur le site plutôt que d'envoyer un formulaire sans aucune date.
  const hasEntree = [...fields].some(([n, v]) => /date/i.test(n) && /(entree|arrivee|debut)/i.test(n) && v);
  const hasSortie = [...fields].some(([n, v]) => /date/i.test(n) && /(sortie|fin)/i.test(n) && v);
  if (!hasEntree && dateArrivee) force('date_arrivee', dateArrivee);
  if (!hasSortie && dateSortie) force('date_sortie', dateSortie);

  const stillEmpty = [...fields].filter(([, v]) => v === '').map(([n]) => n);

  const params = new URLSearchParams();
  for (const [name, value] of fields) params.set(name, value);

  return { body: params.toString(), fields, filled, stillEmpty, formId: parsed.id };
}

/** Formate les caractéristiques d'un logement en lignes lisibles pour Telegram. */
export function formatLogementDetails(l) {
  const e = (v) => escapeHtml(v ?? '');
  return [
    `🔑 N° logement : ${e(l.code)}`,
    `🏷️ Type : ${e(l.type)}`,
    `👥 Colocation : ${e(l.colocation)}`,
    `🔢 Nbr occupants : ${e(l.nbOccupants)}`,
    `📐 Surface : ${e(l.surface)}`,
    `💶 Loyer charges comprises : ${e(l.loyer)}`,
    `🔒 Dépôt garantie : ${e(l.depotGarantie)}`,
    `📄 Frais de dossier : ${e(l.fraisDossier)}`,
  ].join('\n');
}

/* ───────────────────── Vérification de l'état du compte ─────────────────── */

/**
 * Lit la page du compte et dit si un logement y est RÉSERVÉ. C'est la seule
 * source de vérité : la réponse au POST de validation, elle, peut ressembler à
 * n'importe quoi (redirection, page d'accueil, page d'erreur silencieuse).
 *
 * Renvoie 'reserved' | 'none' | 'session' | 'unknown'.
 */
export function interpretAccountPage(html, code) {
  if (looksLikeLogin(html)) return 'session';
  const text = stripTags(html);

  // Message explicite du site quand le compte n'a RIEN : "vous n'avez aucun
  // bien en location ou réservé". C'est le signal négatif le plus fiable.
  if (/aucun bien\b[^.]{0,80}r[ée]serv/i.test(text)) return 'none';

  // Signaux positifs explicites.
  if (
    /votre r[ée]servation a bien [ée]t[ée]/i.test(text) ||
    /r[ée]servation (enregistr|valid|confirm|prise en compte)/i.test(text) ||
    /demande de r[ée]servation[^.]{0,60}(enregistr|prise en compte)/i.test(text) ||
    /logement r[ée]serv[ée]/i.test(text)
  ) {
    return 'reserved';
  }

  // Le code du logement apparaît alors qu'il n'y a plus de tableau de sélection
  // (plus aucune ligne tr_logement_) → il est devenu "mon logement".
  if (code && text.includes(code) && !/id="tr_logement_/i.test(html)) return 'reserved';

  return 'unknown';
}

/** Relit la page du compte (GET) et interprète son état. */
export async function verifyReservationState(cookieHeader, code) {
  try {
    const { html, status } = await getPage(URLS.reservation, cookieHeader);
    return { state: interpretAccountPage(html, code), html, status };
  } catch (err) {
    return { state: 'unknown', html: '', error: err.message };
  }
}

/**
 * Interprète la réponse IMMÉDIATE au POST de validation.
 *
 * ⚠️ Volontairement PESSIMISTE désormais : cette fonction ne peut plus renvoyer
 * `ok: true` sur une simple absence de bouton. Elle sert à repérer un refus
 * explicite (et sa raison) ; la confirmation, elle, vient de la relecture du
 * compte (verifyReservationState).
 */
export function interpretValidationResult(html) {
  if (looksLikeLogin(html)) {
    return { ok: false, reason: 'Session expirée pendant la validation' };
  }

  // Le div #submit_reservation_error est TOUJOURS présent en display:none — sa
  // présence ne prouve rien. Le vrai refus, c'est un MESSAGE non vide dedans.
  const errMsg = stripTags(
    (html.match(/id="submit_reservation_error_message"[^>]*>([\s\S]*?)<\/(?:span|div)>/i) || [])[1] || ''
  );
  if (errMsg) return { ok: false, reason: errMsg };

  // ⚠️ Ne PAS chercher le titre "VALIDATION DES INFORMATIONS IMPOSSIBLE" dans le
  // texte : il est présent dans TOUTES les pages du site (le div qui le porte est
  // en display:none tant qu'il n'y a pas d'erreur). S'en servir ferait échouer
  // toutes les validations, y compris les bonnes. Seul le message d'erreur
  // rempli ci-dessus fait foi côté réponse ; la confirmation, elle, vient de la
  // relecture du compte.

  if (/votre r[ée]servation a bien [ée]t[ée]|r[ée]servation (enregistr|valid|confirm)/i.test(stripTags(html))) {
    return { ok: true };
  }

  return { ok: null, reason: 'réponse non concluante — vérification du compte requise' };
}

/* ────────────────────────────── Orchestration ───────────────────────────── */

async function sendHtml(caption, html, filename) {
  if (!html) return;
  try {
    await notifyDocument(caption, Buffer.from(html, 'utf8'), filename);
  } catch (e) {
    console.warn('[reserve-http] Envoi HTML échoué:', e.message);
  }
}

/** Sauvegarde locale best-effort (le volume Fly est éphémère : c'est du bonus). */
async function saveLocal(filename, content) {
  try {
    const { writeFileSync, mkdirSync } = await import('fs');
    const dir = new URL('../config/', import.meta.url).pathname;
    mkdirSync(dir, { recursive: true });
    writeFileSync(dir + filename, content);
  } catch {}
}

/**
 * Tente la réservation d'un logement individuel, puis VÉRIFIE le résultat.
 * Renvoie { reserved: boolean, state, reason?, respHtml, verifyHtml }.
 */
async function attemptReservation(html, cookieHeader, chosen, dateArrivee) {
  const payload = buildValidationPayload(html, chosen, {
    dateArrivee,
    dateSortie: config.dateSortie,
  });

  if (!payload) {
    return { reserved: false, state: 'no-form', reason: 'formulaire de validation introuvable dans le HTML' };
  }

  console.log(
    `[reserve-http] POST validation ${chosen.code} — champs remplis par le bot : ${payload.filled.join(', ') || '(aucun)'}` +
      (payload.stillEmpty.length ? ` | encore vides : ${payload.stillEmpty.join(', ')}` : '')
  );

  let resp;
  try {
    resp = await postForm(URLS.reservation, payload.body, cookieHeader, { referer: URLS.reservation });
  } catch (err) {
    return { reserved: false, state: 'network', reason: err.message, payload };
  }

  const respHtml = resp.html || '';
  await saveLocal(`reserve_http_validation_${chosen.code}.html`, respHtml);

  const immediate = interpretValidationResult(respHtml);

  // ⚠️ On ne conclut JAMAIS depuis la seule réponse au POST. Même quand elle a
  // l'air bonne, on relit la page du compte : c'est ce contrôle qui manquait et
  // qui a produit le faux "✅ RÉSERVATION PROBABLEMENT CONFIRMÉE".
  const verif = await verifyReservationState(cookieHeader, chosen.code);

  return {
    reserved: verif.state === 'reserved',
    state: verif.state,
    reason: immediate.ok === false ? immediate.reason : verif.error || immediate.reason,
    immediate,
    payload,
    respHtml,
    verifyHtml: verif.html,
    status: resp.status,
  };
}

/**
 * Traite une dispo à partir du HTML DÉJÀ récupéré par la surveillance.
 *
 * @param {string} html          réponse HTML complète (POST modifier_date_arrivee)
 * @param {string} cookieHeader  cookie de session
 * @param {object} opts
 * @param {object} opts.residence  { id, label } de la résidence ciblée
 * @param {string} opts.chemin     libellé lisible "Résidence III › Aile … › Niveau …"
 * @param {boolean} opts.commit    true → tente réellement la réservation
 * @param {string} opts.dateArrivee date d'arrivée scannée (YYYY-MM-DD)
 * @returns {Promise<{handled:boolean, reserved:boolean, retry?:boolean}>}
 */
export async function handleAvailability(html, cookieHeader, opts = {}) {
  const { residence, chemin = '', commit = false, dateArrivee = '' } = opts;
  const residenceNum = residence?.id ? String(residence.id).replace('residence_', '') : null;

  const all = parseLogements(html);
  const logements = filterByResidence(all, residenceNum);

  if (logements.length === 0) {
    // Ce cas se répète à chaque cycle tant que la dispo est annoncée : on le
    // plafonne pour ne pas transformer une structure inattendue en pluie de
    // notifications toutes les 3 secondes.
    const { reservationAttempts, recordReservationAttempt } = await import('./seen.js');
    const key = `nolog:${residence?.id || '?'}:${chemin}`;
    if (reservationAttempts(key) >= config.maxReserveAttempts) {
      console.warn(`[reserve-http] ${key} — déjà signalé ${config.maxReserveAttempts} fois, on se tait.`);
      return { handled: false, reserved: false, retry: true };
    }
    recordReservationAttempt(key);

    await saveLocal('reserve_http_no_logement.html', html);
    await sendHtml(
      `⚠️ Dispo annoncée (${escapeHtml(chemin)}) mais aucune ligne logement lisible. ` +
        `HTML complet ci-joint — c'est la trace à regarder si la structure du site a changé.`,
      html,
      'dispo_sans_logement.html'
    );
    await notify(
      `⚠️ Dispo détectée (${escapeHtml(chemin)}) mais aucune ligne logement lisible dans le HTML.\n` +
        `👉 Vérifie à la main TOUT DE SUITE : ${URLS.reservation}`
    );
    // retry:true → on ne considère pas la situation comme traitée, le prochain
    // cycle réessaiera au lieu de rester muet jusqu'à minuit.
    return { handled: false, reserved: false, retry: true };
  }

  const {
    filterNewCodes, markSeen, reservationAttempts, recordReservationAttempt,
    markReserved, isReserved,
  } = await import('./seen.js');

  const allCodes = logements.map((l) => l.code);
  const newCodes = filterNewCodes(allCodes);
  const notYetSeen = logements.filter((l) => newCodes.includes(l.code));

  // Le choix se porte sur un logement pas encore notifié ; s'ils l'ont tous été,
  // on retente quand même le 1er tant qu'il n'est pas RÉSERVÉ (c'était le vrai
  // trou : "déjà notifié" arrêtait aussi les tentatives).
  const candidates = (notYetSeen.length ? notYetSeen : logements).filter((l) => !isReserved(l.code));
  if (candidates.length === 0) {
    console.log(`[reserve-http] ${allCodes.join(', ')} — déjà réservé(s), rien à faire.`);
    return { handled: true, reserved: true };
  }
  const chosen = candidates[0];
  const isFirstNotification = notYetSeen.length > 0;
  markSeen(allCodes);

  const details = formatLogementDetails(chosen);
  const listeAutres =
    logements.length > 1
      ? `\n\n📋 <b>Tous les logements dispo ici</b> (${logements.length}) : ` +
        escapeHtml(logements.map((l) => `${l.code} (${l.type}, ${l.loyer})`).join(', '))
      : '';

  // ── Détails envoyés IMMÉDIATEMENT (0 requête réseau). ─────────────────────
  if (isFirstNotification) {
    await notify(
      `🏠 <b>Logement disponible !</b>\n\n📍 ${escapeHtml(chemin)}\n\n${details}${listeAutres}` +
        (commit
          ? `\n\n🎯 Résidence ciblée → analyse pour réservation auto…`
          : `\n\nℹ️ Hors résidences ciblées → pas de réservation auto.\n👉 Pour la prendre : ${URLS.reservation}`)
    );
  }

  if (!commit) return { handled: true, reserved: false };

  // ── COLOCATION : non auto-réservable → alerte manuelle forte. ─────────────
  if (isColocation(chosen)) {
    await notify(
      `🚨🚨 <b>LOGEMENT DISPO — ACTION MANUELLE REQUISE</b> 🚨🚨\n\n` +
        `📍 ${escapeHtml(chemin)}\n\n${details}\n\n` +
        `👥 <b>C'est une COLOCATION</b> (${escapeHtml(chosen.nbOccupants)} occupants). Le site exige ` +
        `l'email d'un colocataire ayant un compte Césal actif — le bot ne peut pas réserver seul.\n\n` +
        `⚡️ <b>RÉSERVE TOI-MÊME MAINTENANT :</b>\n🔗 ${URLS.reservation}`
    );
    return { handled: true, reserved: false };
  }

  // ── Plafond de tentatives : on retente, mais on ne martèle pas le site. ───
  const attempts = reservationAttempts(chosen.code);
  if (attempts >= config.maxReserveAttempts) {
    console.warn(`[reserve-http] ${chosen.code} — plafond de ${config.maxReserveAttempts} tentatives atteint.`);
    return { handled: true, reserved: false };
  }
  const attemptNo = recordReservationAttempt(chosen.code);

  // ── 1re passe : validation HTTP directe. ─────────────────────────────────
  let result = await attemptReservation(html, cookieHeader, chosen, dateArrivee);

  // ── 2e passe : le vrai navigateur, qui exécute le JS du site (remplissage du
  //    formulaire au clic sur le toggle + popup jquery-confirm de confirmation).
  //    Déclenchée tant que la réservation n'est PAS constatée — y compris sur un
  //    état 'unknown'. Arbitrage assumé : dans le pire cas le site refuse une
  //    seconde demande (il n'accepte qu'une réservation par compte), alors que
  //    ne rien tenter fait perdre une occasion rare. On s'abstient seulement si
  //    c'est déjà réservé, ou si la session est tombée (il faut se reconnecter).
  let browserTried = false;
  if (!result.reserved && result.state !== 'session' && config.browserFallback) {
    browserTried = true;
    await notify(
      `🌐 Validation HTTP sans effet sur ${escapeHtml(chosen.code)} — je rejoue le parcours dans un vrai ` +
        `navigateur (le site remplit le formulaire en JavaScript et ouvre une popup de confirmation).`
    );
    try {
      const { reserve } = await import('./reserve.js');
      await reserve([residence], null, { commit: true, force: true, targetCode: chosen.code });
    } catch (err) {
      console.warn('[reserve-http] Fallback navigateur en échec:', err.message);
      await notify(`⚠️ Fallback navigateur en échec : <code>${escapeHtml(err.message)}</code>`);
    }
    const verif = await verifyReservationState(cookieHeader, chosen.code);
    result = { ...result, reserved: verif.state === 'reserved', state: verif.state, verifyHtml: verif.html };
  }

  // ── Traces HTML : envoyées sur Telegram dès que ce n'est pas un succès net.
  //    C'est la seule copie durable (le disque de la machine Fly ne l'est pas).
  if (!result.reserved) {
    await sendHtml(
      `🧾 <b>Réponse du POST de validation</b> — ${escapeHtml(chosen.code)} (tentative ${attemptNo}).\n` +
        `À inspecter : message serveur, champ manquant, pop-up ?`,
      result.respHtml,
      `validation_${chosen.code}.html`
    );
    await sendHtml(
      `🧾 <b>Page du compte après tentative</b> — ${escapeHtml(chosen.code)}. C'est elle qui fait foi.`,
      result.verifyHtml,
      `compte_${chosen.code}.html`
    );
    if (result.payload) {
      const diag =
        `Formulaire : ${result.payload.formId || '(sans id)'}\n` +
        `Champs remplis par le bot : ${result.payload.filled.join(', ') || '(aucun)'}\n` +
        `Champs encore vides : ${result.payload.stillEmpty.join(', ') || '(aucun)'}\n\n` +
        `Corps du POST envoyé :\n${result.payload.body}`;
      await sendHtml(
        `🔧 <b>Diagnostic du POST</b> — ${escapeHtml(chosen.code)}`,
        diag,
        `payload_${chosen.code}.txt`
      );
    }
  }

  // ── Verdict. ─────────────────────────────────────────────────────────────
  if (result.reserved) {
    markReserved(chosen.code);
    await notify(
      `✅✅ <b>RÉSERVATION CONFIRMÉE</b> 🎉\n\n` +
        `📍 ${escapeHtml(chemin)}\n\n${details}\n\n` +
        `✔️ Vérifié en relisant la page de ton compte (pas une supposition).\n` +
        `🔗 Complète ton dossier : ${URLS.reservation}`
    );
    return { handled: true, reserved: true };
  }

  const raisonTxt = result.reason ? `\n🛑 <b>Raison :</b> ${escapeHtml(result.reason)}` : '';
  const suite =
    attemptNo < config.maxReserveAttempts
      ? `\n🔁 Je retente au prochain cycle (tentative ${attemptNo}/${config.maxReserveAttempts}).`
      : `\n⛔ Plafond de tentatives atteint — je ne retente plus automatiquement.`;

  if (result.state === 'session') {
    await notify(
      `🔐 <b>SESSION EXPIRÉE PENDANT LA RÉSERVATION</b> de ${escapeHtml(chosen.code)} !\n\n` +
        `📍 ${escapeHtml(chemin)}\n${details}\n\n` +
        `⚡️ <b>RÉSERVE À LA MAIN TOUT DE SUITE</b> puis relance <code>npm run login</code> :\n🔗 ${URLS.reservation}`
    );
    return { handled: true, reserved: false, retry: true };
  }

  await notify(
    `❌ <b>RÉSERVATION NON CONFIRMÉE</b> — le logement n'est PAS à toi.\n\n` +
      `📍 ${escapeHtml(chemin)}\n${details}\n` +
      `${raisonTxt}\n` +
      `🔎 État du compte après tentative : <code>${escapeHtml(result.state)}</code>` +
      (browserTried ? ` (fallback navigateur tenté)` : '') +
      `\n📎 HTML de la réponse + page du compte + payload envoyés ci-dessus.${suite}\n\n` +
      `⚡️ <b>RÉSERVE À LA MAIN TOUT DE SUITE :</b>\n🔗 ${URLS.reservation}`
  );
  return { handled: true, reserved: false, retry: true };
}
