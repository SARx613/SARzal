import { config, URLS } from './config.js';
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
 *     (code, type, loyer, surface, colocation, occupants…),
 *   • le formulaire de validation complet <form id="action-validation_reservation">
 *     avec keyid_reservation, date_entree, date_sortie, nb_occupants, etc.
 *
 * Donc :
 *   – lire les détails du logement = parser le HTML déjà en main (0 requête, ~1 ms) ;
 *   – RÉSERVER un logement individuel = UN SEUL POST `action=validation_reservation`
 *     (le même que le clic "Valider votre réservation" du site pour un logement
 *     NON solidaire). Aucun Chromium, aucune navigation, aucune capture.
 *
 * La colocation reste NON auto-réservable (le site exige côté serveur l'email
 * d'un colocataire ayant un compte Césal actif — cf. cesal_ajax_check_email.php).
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
 */
export function parseLogements(html) {
  const rows = [...html.matchAll(/<tr\s+id="tr_logement_([^"]+)"[^>]*>([\s\S]*?)<\/tr>/gi)];
  const result = [];
  for (const [, keyid, rowHtml] of rows) {
    const tds = splitCells(rowHtml);
    const at = (n) => stripTags(tds[n] || '');
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
    });
  }
  return result;
}

/**
 * Détermine si un logement est une COLOCATION (non auto-réservable en solo).
 * Deux signaux, l'un OU l'autre suffit : "Colocation ? = Oui", ou occupants > 1.
 * (Identique à la logique éprouvée de l'ancien reserve.js.)
 */
export function isColocation(l) {
  const nb = parseInt(String(l.nbOccupants).replace(/\D/g, ''), 10);
  if (Number.isFinite(nb) && nb > 1) return true;
  return /\boui\b/i.test(l.colocation || '');
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
    `🏷️ Type : ${l.type}`,
    `👥 Colocation : ${l.colocation}`,
    `🔢 Nbr occupants : ${l.nbOccupants}`,
    `📐 Surface : ${l.surface}`,
    `💶 Loyer charges comprises : ${l.loyer}`,
    `🔒 Dépôt garantie : ${l.depotGarantie}`,
    `📄 Frais de dossier : ${l.fraisDossier}`,
  ].join('\n');
}

/* ────────────────────────────── Réservation ────────────────────────────── */

/**
 * Envoie le POST de validation d'une réservation (équivalent HTTP exact du clic
 * "Valider votre réservation" pour un logement INDIVIDUEL). On repart des champs
 * réels du form et on positionne #keyid = code de réservation du logement choisi
 * (ce que fait submit_reservation() en JS). Renvoie { status, html }.
 */
async function postValidation(cookieHeader, formFields, keyid) {
  const body = new URLSearchParams({ ...formFields, keyid });
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
  return { status: res.status, html };
}

/**
 * Interprète la réponse du POST de validation pour dire si la réservation a
 * réellement abouti. Signaux (déduits du JS/HTML du site) :
 *   • ÉCHEC   : "VALIDATION DES INFORMATIONS IMPOSSIBLE" ou #submit_reservation_error
 *               visible, ou la page "Mon logement" affiche encore "aucun bien…".
 *   • SUCCÈS  : plus de bouton "Valider votre réservation" ET plus de tableau
 *               logements dispo, et pas de message d'erreur → le voeu est pris.
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

/**
 * Traite une dispo à partir du HTML DÉJÀ récupéré par la surveillance.
 *
 * @param {string}  html          réponse HTML complète (POST modifier_date_arrivee)
 * @param {string}  cookieHeader  cookie de session (pour le POST de validation)
 * @param {string}  chemin        libellé lisible "Résidence III › Aile … › Niveau …"
 * @param {boolean} commit        true (III/IV) → tente la validation ; false → détails seuls
 * @returns {Promise<{handled:boolean, reserved?:boolean}>}
 */
export async function handleAvailability(html, cookieHeader, chemin, { commit }) {
  const logements = parseLogements(html);
  if (logements.length === 0) {
    // Dispo annoncée par les compteurs mais aucune ligne logement lisible :
    // structure inattendue → on le signale (et on garde le HTML pour debug).
    try {
      const { writeFileSync } = await import('fs');
      writeFileSync(
        new URL('../config/reserve_http_no_logement.html', import.meta.url).pathname,
        html
      );
    } catch {}
    await notify(
      `⚠️ Dispo détectée (${chemin}) mais aucune ligne logement lisible dans le HTML. ` +
      `HTML sauvegardé pour debug.\n👉 Vérifie à la main : ${URLS.reservation}`
    );
    return { handled: false };
  }

  // Anti-doublon quotidien (par code logement), inchangé.
  const { filterNewCodes, markSeen } = await import('./seen.js');
  const allCodes = logements.map((l) => l.code);
  const newCodes = filterNewCodes(allCodes);
  const notYetSeen = logements.filter((l) => newCodes.includes(l.code));
  if (notYetSeen.length === 0) {
    console.log(`[reserve-http] Logement(s) ${allCodes.join(', ')} déjà notifié(s) aujourd'hui.`);
    return { handled: true };
  }
  markSeen(allCodes);

  const chosen = notYetSeen[0];
  const details = formatLogementDetails(chosen);
  const listeAutres =
    logements.length > 1
      ? `\n\n📋 <b>Tous les logements dispo ici</b> (${logements.length}) : ` +
        logements.map((l) => `${l.code} (${l.type}, ${l.loyer})`).join(', ')
      : '';

  // ── Détails envoyés IMMÉDIATEMENT (0 requête réseau, quelques ms). ─────────
  await notify(
    `🏠 <b>Logement disponible !</b>\n\n📍 ${chemin}\n\n${details}${listeAutres}` +
    (commit
      ? `\n\n🎯 Résidence III/IV → analyse pour réservation auto…`
      : `\n\nℹ️ Hors III/IV → pas de réservation auto.\n👉 Pour la prendre : ${URLS.reservation}`)
  );

  // Hors III/IV → on s'arrête après avoir envoyé les détails.
  if (!commit) return { handled: true, reserved: false };

  // ── COLOCATION : non auto-réservable → alerte manuelle forte. ─────────────
  if (isColocation(chosen)) {
    await notify(
      `🚨🚨 <b>LOGEMENT DISPO — ACTION MANUELLE REQUISE</b> 🚨🚨\n\n` +
      `📍 ${chemin}\n\n${details}\n\n` +
      `👥 <b>C'est une COLOCATION</b> (${chosen.nbOccupants} occupants). Le site exige ` +
      `l'email d'un colocataire ayant un compte Césal actif — le bot ne peut pas réserver seul.\n\n` +
      `⚡️ <b>RÉSERVE TOI-MÊME MAINTENANT :</b>\n🔗 ${URLS.reservation}`
    );
    return { handled: true, reserved: false };
  }

  // ── LOGEMENT INDIVIDUEL III/IV : validation HTTP directe. ─────────────────
  const formFields = parseReservationForm(html);
  if (!formFields) {
    await notify(
      `⚠️ Logement individuel ${chosen.code} détecté mais formulaire de validation ` +
      `introuvable dans le HTML. Réserve à la main tout de suite : ${URLS.reservation}`
    );
    return { handled: true, reserved: false };
  }

  let result;
  let respHtml = '';
  try {
    const resp = await postValidation(cookieHeader, formFields, chosen.keyid);
    respHtml = resp.html || '';
    // On SAUVEGARDE systématiquement la réponse du POST de validation : c'est le
    // tout premier cas réel de validation individuelle (jamais capturé), donc ce
    // dump permettra d'ajuster interpretValidationResult() au vrai format de la
    // page "succès" dès la première fois.
    try {
      const { writeFileSync } = await import('fs');
      writeFileSync(
        new URL(`../config/reserve_http_validation_${chosen.code}.html`, import.meta.url).pathname,
        respHtml
      );
    } catch {}
    if (resp.status >= 300 && resp.status < 400) {
      // Une redirection ici est généralement le rechargement post-succès de la
      // page. On ne peut pas conclure fermement → succès "probable".
      result = { ok: true, probable: true };
    } else {
      result = interpretValidationResult(respHtml);
    }
  } catch (err) {
    await notify(
      `⚠️ <b>Erreur réseau pendant la validation</b> de ${chosen.code} : ` +
      `<code>${escapeHtml(err.message)}</code>\n👉 Réserve à la main : ${URLS.reservation}`
    );
    return { handled: true, reserved: false };
  }

  // ── Envoi du HTML COMPLET de la réponse sur Telegram dès que le résultat
  //    n'est PAS un succès net (échec, incertain, ou succès seulement "probable").
  //    But : voir sur ton téléphone ce qui a pu entraver la réservation (pop-up,
  //    champ manquant, message serveur…) SANS aucun navigateur, directement le
  //    HTTP brut renvoyé par le site. On n'envoie rien sur un succès 100 % sûr
  //    (inutile de spammer un gros fichier quand tout va bien).
  const isSureSuccess = result.ok === true && !result.probable;
  if (!isSureSuccess) {
    try {
      await notifyDocument(
        `🧾 <b>HTML de la réponse de validation</b> — ${chosen.code} (${chemin}).\n` +
        `À inspecter : pop-up / champ manquant / message serveur ?`,
        Buffer.from(respHtml, 'utf8'),
        `validation_${chosen.code}.html`
      );
    } catch (e) {
      console.warn('[reserve-http] Envoi HTML de validation échoué:', e.message);
    }
  }

  if (result.ok === true) {
    await notify(
      `✅✅ <b>RÉSERVATION ${result.probable ? 'PROBABLEMENT ' : ''}CONFIRMÉE !</b> 🎉\n\n` +
      `📍 ${chemin}\n\n${details}\n\n` +
      (result.probable
        ? `⚠️ Résultat non 100 % certain côté site — <b>VÉRIFIE</b> (HTML envoyé ci-dessus) : ${URLS.reservation}`
        : `🔗 Complète ton dossier : ${URLS.reservation}`)
    );
    return { handled: true, reserved: true };
  }

  if (result.ok === false) {
    await notify(
      `❌ <b>RÉSERVATION ÉCHOUÉE</b> — le site a refusé.\n\n` +
      `📍 ${chemin}\n${details}\n\n` +
      `🛑 <b>Raison :</b> ${escapeHtml(result.reason || 'inconnue')}\n\n` +
      `📎 HTML complet de la réponse envoyé ci-dessus (pop-up / entrave ?).\n` +
      `⚡️ <b>Réserve à la main TOUT DE SUITE :</b>\n🔗 ${URLS.reservation}`
    );
    return { handled: true, reserved: false };
  }

  await notify(
    `⚠️ <b>Réservation — résultat INCERTAIN</b> (${escapeHtml(result.reason || '')}).\n\n` +
    `📍 ${chemin}\n${details}\n\n` +
    `📎 HTML complet de la réponse envoyé ci-dessus (pop-up / entrave ?).\n` +
    `👉 <b>VÉRIFIE ET/OU RÉSERVE À LA MAIN :</b>\n🔗 ${URLS.reservation}`
  );
  return { handled: true, reserved: false };
}
