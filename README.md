# Moniteur logements CESAL

Surveille la page des résidences CESAL et envoie une alerte Telegram dès qu'un
logement se libère. Conçu pour fonctionner **sans contourner le reCAPTCHA** :
tu te connectes une fois à la main, le script réutilise ta session.

## ⚠️ À lire d'abord

- **Aucun contournement de captcha.** Le login est semi-manuel (tu résous le
  reCAPTCHA une fois). Ça évite la suspension de ton compte résident.
- **Mode par défaut = `alert`** (notifie seulement). La réservation automatique
  (`MODE=reserve`) est volontairement non finalisée tant que le flux réel n'est
  pas validé étape par étape. Tu l'actives toi-même quand tu es prêt.

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
```

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
- **Réservation auto** (`src/reserve.js`, mode `reserve`) : faite via Playwright
  car interactive (select2 + datepicker + cases à cocher). **Échafaudée mais pas
  encore testée contre une vraie dispo** → garde `MODE=alert` jusqu'à validation.

## Hébergement 24/7 (à décider)

Le moniteur HTTP tourne partout : ton Mac (`npm start`), GitHub Actions (cron
~5 min, stocker le cookie en secret), Render, etc. À choisir une fois testé.
