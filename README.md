# Moniteur logements CESAL

Surveille la page des résidences CESAL et envoie une alerte Telegram dès qu'un
logement se libère. Conçu pour fonctionner **sans contourner le reCAPTCHA** :
tu te connectes une fois à la main, le script réutilise ta session.

## ⚠️ À lire d'abord

- **Aucun contournement de captcha.** Le login est semi-manuel (tu résous le
  reCAPTCHA une fois). Ça évite la suspension de ton compte résident.
- **Mode par défaut = `alert`** (notifie seulement). Mets `MODE=reserve` pour que
  le bot tente la réservation. Dans tous les cas, réserve **aussi** à la main
  dès que tu reçois l'alerte : le bot est un filet, pas une garantie.
- **Un « ✅ » ne t'est envoyé que si le bot a relu ton compte et constaté la
  réservation.** Toute autre issue est annoncée comme un échec, avec le HTML de
  la réponse en pièce jointe. Voir le post-mortem plus bas.

## Installation

```bash
npm install
npx playwright install chromium
cp .env.example .env   # puis remplis Telegram + mot de passe
```

## Configurer Telegram (2 min)

1. Sur Telegram, parle à **@BotFather** → `/newbot` → copie le token dans `TELEGRAM_BOT_TOKEN`.
2. Parle à **@userinfobot** → copie ton id dans `TELEGRAM_CHAT_ID`.
3. Envoie un premier message à ton bot pour "ouvrir" la conversation.

## Utilisation

```bash
npm run login    # ouvre un navigateur : connecte-toi (résous le captcha) UNE fois
npm run check    # un seul check (utile pour debug)
npm start        # boucle : check toutes les INTERVAL_MINUTES
npm test         # tests hors-ligne (parseurs + flux de réservation complet)
```

`npm test` ne touche ni au site ni à ton compte : il rejoue le parcours contre
un faux serveur local. À lancer avant tout déploiement.

Quand la session expire, le bot t'envoie une alerte Telegram → relance `npm run login`.

## Comment ça marche (architecture, validée sur HAR réel)

- **Surveillance = HTTP pur** (rapide, léger, hébergeable partout). Un seul POST
  `action=modifier_date_arrivee` vers `cesal_mon_logement_reservation.php` renvoie
  une page dont le `<script>` contient en clair le statut de chaque résidence
  (`$("#residence_1_logements_disponibles").html("Aucun logement disponible")`).
  Le moniteur parse ces lignes — si une n'est pas « Aucun logement disponible »,
  c'est une dispo → alerte Telegram.
- **Date d'arrivée** : le moniteur lit la liste à jour et scanne sur la **dernière**
  date proposée (configurable plus tard).
- **Le cookie de session** est capturé une fois par `npm run login` (Playwright,
  tu résous le captcha). Le moniteur HTTP le réutilise → plus jamais de captcha.
- **Réservation** (mode `reserve`), en trois temps :
  1. `src/reserve-http.js` reconstruit le formulaire de validation et le poste
     directement (rapide : quelques millisecondes) ;
  2. il **relit ensuite la page du compte** pour vérifier que la réservation a
     réellement été prise — c'est la seule chose qui vaut confirmation ;
  3. si rien n'a été pris, `src/reserve.js` rejoue le parcours dans un vrai
     navigateur (Playwright), qui exécute le JavaScript du site et sa popup de
     confirmation, puis re-vérifie.

  Le bot n'envoie « ✅ RÉSERVATION CONFIRMÉE » que si l'étape 2 le prouve.

## Post-mortem : la réservation annoncée qui n'avait pas eu lieu (04/08/2026)

Une Résidence III/IV s'est libérée, le bot a envoyé « ✅ RÉSERVATION
PROBABLEMENT CONFIRMÉE », et rien n'avait été réservé. Trois défauts cumulés,
tous corrigés et désormais couverts par `npm test` :

| Défaut | Effet | Correction |
|---|---|---|
| Le formulaire `#action-validation_reservation` est **vide dans le HTML** — ce sont les scripts du site qui le remplissent quand on coche le toggle du logement. Le bot le repostait tel quel, en ne renseignant que `keyid`. | Le POST partait sans date de début de bail, sans date de fin, sans nb d'occupants, sans toggle coché → le serveur n'enregistrait rien. | `buildValidationPayload()` émule ce remplissage (dates, occupants, toggle, message d'affectation), lit aussi les `<select>`, et n'envoie pas les cases décochées. |
| Le succès était déduit de l'**absence** du libellé « Valider votre réservation » dans la réponse, ou d'une simple redirection 3xx. | N'importe quelle page d'erreur, d'accueil ou de login était comptée comme un succès. | La réponse au POST ne sert plus qu'à repérer un refus explicite. La confirmation vient de `verifyReservationState()`, qui **relit la page du compte**. |
| Les codes logement et la signature de dispo étaient marqués « vus » **avant** la tentative. | Après l'échec : plus aucune alerte ni nouvel essai de la journée, sur un logement toujours libre. | « Notifié » et « réservé » sont désormais deux choses distinctes (`src/seen.js`). Tant que rien n'est décroché, le bot retente (jusqu'à `MAX_RESERVE_ATTEMPTS`). |

Autres correctifs issus du même audit :

- les lignes logement sont rattachées à **leur** résidence — le bot pouvait
  sinon tenter de réserver en Résidence I une dispo détectée en Résidence III ;
- Telegram : retry + repli en texte brut si le parse HTML échoue (un `&` dans un
  libellé faisait disparaître l'alerte entière) ;
- en cas d'échec, le HTML de la réponse, la page du compte **et** le corps exact
  du POST sont envoyés en pièce jointe sur Telegram. C'est la seule copie
  durable : la machine Fly n'a aucun volume, donc `/app/config` est effacé à
  chaque redéploiement ;
- si la page CESAL devient illisible (structure changée), le bot le **dit** au
  lieu de surveiller dans le vide.

## Hébergement 24/7 (à décider)

Le moniteur HTTP tourne partout : ton Mac (`npm start`), GitHub Actions (cron
~5 min, stocker le cookie en secret), Render, etc. À choisir une fois testé.
