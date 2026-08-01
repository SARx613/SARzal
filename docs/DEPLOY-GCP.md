# Héberger SARzal sur Google Cloud (gratuit, en remplacement de Fly.io)

Guide pas-à-pas pour remettre le moniteur CESAL en ligne 24/7 sur une VM
**Compute Engine `e2-micro`**, dans le cadre du *Google Cloud Free Tier*
(gratuit à vie, pas un essai limité dans le temps).

---

## Pourquoi Compute Engine et pas Cloud Run ?

SARzal est un **worker permanent** : `src/loop.js` boucle indéfiniment et
interroge CESAL toutes les ~3 s. Il n'expose aucun port HTTP (cf. le
commentaire dans `fly.toml`).

| Service GCP | Verdict |
|---|---|
| **Compute Engine `e2-micro`** | ✅ **À utiliser.** VM Linux allumée en continu, 1 vCPU partagé + 1 Go RAM. Équivalent direct du `shared-cpu-1x / 1024mb` de Fly. |
| Cloud Run | ❌ Conçu pour répondre à des requêtes et s'endormir. Un worker permanent impose `--min-instances=1`, **facturé en continu** → plus gratuit. |
| Cloud Run Functions | ❌ Même problème, et durée d'exécution plafonnée. |
| GKE | ❌ Seul le control plane est offert ; les nœuds sont payants. Bien trop lourd. |
| Cloud Build / Storage / BigQuery | ❌ Hors sujet (build, stockage, analytics). |

### Les 3 règles du « Always Free » à respecter

1. **Région obligatoire** : `us-west1` (Oregon), `us-central1` (Iowa) ou
   `us-east1` (Caroline du Sud). **Pas l'Europe** — une VM à Paris ou en
   Belgique est facturée.
   *Conséquence :* ~120–150 ms de latence en plus vers CESAL (serveur français)
   contre Amsterdam sur Fly. Négligeable pour un check toutes les 3 s.
2. **Une seule** instance `e2-micro` non-préemptible par mois, avec au maximum
   **30 Go de disque standard** (`pd-standard`) et **1 Go d'egress** vers
   l'Amérique du Nord par mois.
   *SARzal envoie de tout petits POST et des messages Telegram ; les grosses
   pages HTML arrivent en entrée (gratuit). Tu restes loin de la limite.*
3. Un **compte de facturation actif** est requis (vérification par carte), mais
   rien n'est débité tant que tu restes dans ces limites.

> 💡 Pose quand même un **budget d'alerte à 1 €** (étape 8) : c'est le filet de
> sécurité qui te prévient si quelque chose sort du gratuit.

---

## Étape 1 — Créer le projet et activer la facturation

1. Va sur https://console.cloud.google.com/ et connecte-toi.
2. En haut, menu déroulant des projets → **Nouveau projet** → nom `sarzal` → **Créer**.
3. Menu ☰ → **Facturation** → associe un compte de facturation au projet
   (carte bancaire demandée pour vérification uniquement).
4. Menu ☰ → **API et services** → active l'API **Compute Engine**
   (ou laisse la console te la proposer à l'étape suivante).

## Étape 2 — Installer `gcloud` sur ton Mac

```bash
brew install --cask google-cloud-sdk

gcloud init                        # connexion + choix du projet 'sarzal'
gcloud config set project sarzal   # remplace par l'ID réel du projet
gcloud config set compute/zone us-central1-a
```

> L'**ID** du projet n'est pas toujours son nom (ex. `sarzal-473210`) :
> récupère-le en haut de la console ou avec `gcloud projects list`.

## Étape 3 — Créer la VM gratuite

```bash
gcloud compute instances create sarzal \
  --zone=us-central1-a \
  --machine-type=e2-micro \
  --image-family=debian-12 \
  --image-project=debian-cloud \
  --boot-disk-size=30GB \
  --boot-disk-type=pd-standard \
  --metadata=enable-oslogin=TRUE
```

Chaque option compte pour rester gratuit : `e2-micro` + zone US + `pd-standard`
≤ 30 Go. Debian 12 est l'image la plus légère et la mieux supportée par
Playwright.

> **Pas de règle de pare-feu à créer** : le moniteur n'expose aucun port, il ne
> fait que des connexions sortantes. C'est plus sûr, et c'est aussi pour ça
> qu'aucun `[http_service]` n'existait dans `fly.toml`.

## Étape 4 — Installer SARzal sur la VM

Connecte-toi (le premier `ssh` génère la clé automatiquement) :

```bash
gcloud compute ssh sarzal --zone=us-central1-a
```

Puis, **sur la VM** :

```bash
curl -fsSL https://raw.githubusercontent.com/SARx613/SARzal/main/deploy/bootstrap-gcp.sh | sudo bash
```

Le script `deploy/bootstrap-gcp.sh` fait tout ce que le `Dockerfile` faisait
chez Fly, plus ce que Fly gérait pour toi :

- **swap de 2 Go** (`vm.swappiness=10`) — indispensable : c'est le remède au
  problème documenté dans `fly.toml` (Chromium qui n'obtient pas son allocation
  de 512 Mo d'un coup et se bloque *silencieusement*) ;
- Node.js 20, Chromium et ses dépendances système via `playwright install-deps` ;
- clonage dans `/opt/sarzal` sous un utilisateur dédié `sarzal` (pas root) ;
- `/etc/sarzal.env` (l'équivalent des `fly secrets`), en `chmod 600` ;
- le **service systemd** `sarzal` : démarrage au boot et **redémarrage
  automatique en cas de crash** — c'est le rôle que tenait le superviseur Fly.

## Étape 5 — Renseigner les secrets

Toujours sur la VM :

```bash
sudo nano /etc/sarzal.env
```

Reprends les valeurs de tes anciens `fly secrets` :

```ini
TELEGRAM_BOT_TOKEN=123456:ABC...
TELEGRAM_CHAT_ID=123456789
CESAL_EMAIL=simon5.amar@gmail.com
CESAL_PASSWORD=...
MODE=alert
DATE_SORTIE=18/12/2026
INTERVAL_SECONDS=3
JITTER_SECONDS=1.5
MAX_BACKOFF_SECONDS=300
HEADLESS=true
```

`Ctrl+O`, `Entrée`, `Ctrl+X` pour enregistrer. Après **toute** modification de
ce fichier : `sudo systemctl restart sarzal`.

> Si tu ne les retrouves pas et que l'app Fly existe encore :
> `fly secrets list --app sarzal` en donne les noms (pas les valeurs — celles-ci
> ne sont jamais réaffichables, il faut les régénérer si tu les as perdues).

## Étape 6 — Pousser la session CESAL et démarrer

Sur **ton Mac**, dans le dépôt :

```bash
npm run login                        # ouvre le navigateur, tu résous le captcha
bash scripts/push-session-gcp.sh     # encode + envoie + redémarre le service
```

Puis démarre le service la première fois (sur la VM) :

```bash
sudo systemctl start sarzal
```

Tu dois recevoir sur Telegram : `🚀 Moniteur CESAL démarré…`

## Étape 7 — Vérifier et piloter au quotidien

Depuis ton Mac, les cibles `make` font le SSH pour toi :

| Fly.io (avant) | Google Cloud (maintenant) |
|---|---|
| `fly logs --app sarzal` | `make logs-gcp` |
| `fly status --app sarzal` | `make status-gcp` |
| `fly machine restart …` | `make restart-gcp` |
| `fly secrets set …` | `sudo nano /etc/sarzal.env` puis restart |
| `make relogin` | `make relogin-gcp` |
| `fly deploy` | `make deploy-gcp` (git pull + npm ci + restart) |

Sur la VM directement :

```bash
sudo systemctl status sarzal      # état du service
sudo journalctl -u sarzal -f      # logs en direct
sudo journalctl -u sarzal -n 100  # 100 dernières lignes
free -h                           # RAM + swap
```

## Étape 8 — Poser un garde-fou budget (2 min, à ne pas sauter)

Console → ☰ **Facturation** → **Budgets et alertes** → **Créer un budget** :
portée = projet `sarzal`, montant = **1 €**, alertes à 50 % / 90 % / 100 %.
Tu recevras un e-mail dès le premier centime — donc dès que quelque chose sort
du free tier.

---

## Quand la session CESAL expire

Exactement le même geste qu'avant, une seule commande depuis ton Mac :

```bash
make relogin-gcp
```

(= `npm run login` puis `scripts/push-session-gcp.sh`, qui met à jour
`/etc/sarzal.env` et redémarre le service.)

---

## Mettre à jour le code

```bash
make deploy-gcp
```

La VM fait un `git pull`, réinstalle les dépendances si besoin et redémarre le
service. Pas d'image Docker à reconstruire : c'est plus rapide qu'un
`fly deploy`.

---

## Différences de performance avec Fly.io

| | Fly.io (`shared-cpu-1x`) | GCP `e2-micro` |
|---|---|---|
| RAM | 1024 Mo | 1024 Mo **+ 2 Go de swap** |
| CPU | 1 vCPU partagé | 1 vCPU partagé (burst ~0,25 vCPU en continu) |
| Région | `ams` (Amsterdam) | `us-central1` (Iowa) |
| Latence vers CESAL | ~20 ms | ~120–150 ms |
| Coût | essai gratuit expiré | 0 € (Always Free) |

**Impact réel : aucun.** Avec un check toutes les 3 s (±1,5 s de jitter), 130 ms
de latence supplémentaire représentent ~4 % du cycle. Le backoff exponentiel
déjà présent dans `src/loop.js` absorbe le reste.

Le seul point d'attention est le **CPU burstable** : `e2-micro` garantit ~0,25
vCPU en moyenne et n'autorise des pointes à 100 % que par crédits. `checkOnce()`
étant un simple `fetch` + parsing de texte, la charge de fond est très faible.
Seul `npm run login` (Chromium) consomme vraiment — et il ne tourne que
ponctuellement.

---

## Dépannage

**Le service ne démarre pas**
```bash
sudo journalctl -u sarzal -n 50 --no-pager
```

**Alerte « session expirée » en boucle** → `make relogin-gcp` depuis ton Mac.
(`src/loop.js` coupe déjà le spam Telegram après 10 alertes.)

**Chromium ne se lance pas / `page.goto()` ne répond jamais** → c'est le
symptôme mémoire connu. Vérifie le swap :
```bash
free -h && swapon --show
```
S'il manque, relance `sudo bash /opt/sarzal/deploy/bootstrap-gcp.sh`.

**`gcloud compute ssh` refuse la connexion** → attends ~30 s après la création
de la VM (le temps du premier boot), puis réessaie.

**Tout supprimer** (arrêt total, remise à zéro de la facturation) :
```bash
gcloud compute instances delete sarzal --zone=us-central1-a
```
