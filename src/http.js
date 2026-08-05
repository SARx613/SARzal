/**
 * Couche HTTP commune (surveillance + réservation).
 *
 * Avant, monitor.js et reserve-http.js dupliquaient chacun leurs en-têtes. Le
 * risque : le POST de validation ne partait PAS avec exactement les mêmes
 * en-têtes que le POST de surveillance, alors que c'est la même session et le
 * même formulaire côté site. On centralise ici pour que les deux soient
 * strictement cohérents.
 */

export const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';

const ORIGIN = 'https://logement.cesal.fr';

function baseHeaders(cookieHeader, referer) {
  return {
    accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'accept-language': 'fr-FR,fr;q=0.9,en;q=0.8',
    'user-agent': USER_AGENT,
    cookie: cookieHeader,
    referer: referer || ORIGIN,
  };
}

/** POST application/x-www-form-urlencoded. Renvoie { status, headers, html, url }. */
export async function postForm(url, body, cookieHeader, { referer } = {}) {
  const res = await fetch(url, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      ...baseHeaders(cookieHeader, referer || url),
      'content-type': 'application/x-www-form-urlencoded',
      origin: ORIGIN,
    },
    body,
  });
  const html = await res.text().catch(() => '');
  return { status: res.status, headers: res.headers, html, url };
}

/**
 * GET d'une page. `redirect: 'follow'` par défaut : pour la VÉRIFICATION d'état
 * on veut la page finale réellement affichée (le site redirige volontiers), pas
 * un 302 vide qu'on interpréterait à tort.
 */
export async function getPage(url, cookieHeader, { redirect = 'follow' } = {}) {
  const res = await fetch(url, {
    method: 'GET',
    redirect,
    headers: baseHeaders(cookieHeader, url),
  });
  const html = await res.text().catch(() => '');
  return { status: res.status, headers: res.headers, html, url: res.url || url };
}

/**
 * true si la réponse est en fait la page de login (session tombée).
 *
 * On se fie aux marqueurs du FORMULAIRE de connexion (captcha, champs
 * login-email / login-password), pas à une simple mention de `cesal_login.php` :
 * ce lien apparaît aussi dans le menu « déconnexion » des pages authentifiées.
 * Confondre les deux ferait diagnostiquer « session expirée » sur une page de
 * compte parfaitement valide — et donc renoncer à une réservation à tort.
 */
export function looksLikeLogin(html) {
  const loginForm = /g-recaptcha|name="login-email"|name="login-password"/i.test(html);
  const authenticated = /id="date_arrivee"|id="residences"|id="tr_logement_/i.test(html);
  return loginForm && !authenticated;
}
