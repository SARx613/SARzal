#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# bootstrap-gcp.sh — prépare une VM Compute Engine e2-micro pour SARzal.
#
# À lancer UNE SEULE FOIS, SUR LA VM (pas sur ton Mac) :
#   curl -fsSL https://raw.githubusercontent.com/SARx613/SARzal/main/deploy/bootstrap-gcp.sh | bash
# ou, si tu as déjà cloné le dépôt :
#   bash deploy/bootstrap-gcp.sh
#
# Installe Node 20, les dépendances système de Chromium, un swap de 2 Go
# (indispensable : e2-micro n'a qu'1 Go de RAM et Chromium en demande ~512 Mo
# d'un coup — c'est exactement le problème documenté dans fly.toml), puis le
# service systemd qui relance le moniteur au boot et après un crash.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/SARx613/SARzal.git}"
APP_DIR="${APP_DIR:-/opt/sarzal}"
APP_USER="${APP_USER:-sarzal}"

log() { printf '\n\033[1;36m▶ %s\033[0m\n' "$*"; }

[ "$(id -u)" -eq 0 ] || exec sudo -E bash "$0" "$@"

# ── 1. Swap 2 Go ────────────────────────────────────────────────────────────
# e2-micro = 1 Go de RAM. Sans swap, Chromium se fait tuer par l'OOM killer (ou
# pire : il démarre mais n'arrive plus à naviguer, panne silencieuse déjà vue
# sur Fly avec 512 Mo). Le moniteur HTTP seul tient dans 1 Go ; le swap ne sert
# que de filet pour `npm run login` et le mode reserve.
if ! swapon --show | grep -q '/swapfile'; then
  log "Création d'un swap de 2 Go"
  fallocate -l 2G /swapfile || dd if=/dev/zero of=/swapfile bs=1M count=2048
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  # Swap utilisé seulement en dernier recours (garde les perfs de la RAM).
  sysctl -w vm.swappiness=10
  grep -q '^vm.swappiness' /etc/sysctl.conf || echo 'vm.swappiness=10' >> /etc/sysctl.conf
else
  log "Swap déjà présent — on garde"
fi

# ── 2. Paquets système ──────────────────────────────────────────────────────
log "Installation des paquets système"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq --no-install-recommends git curl ca-certificates

if ! command -v node >/dev/null 2>&1 || [ "$(node -v | cut -c2-3)" -lt 20 ]; then
  log "Installation de Node.js 20"
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y -qq nodejs
fi
log "Node $(node -v) / npm $(npm -v)"

# ── 3. Utilisateur applicatif (pas de root pour faire tourner le moniteur) ───
id -u "$APP_USER" >/dev/null 2>&1 || useradd --system --create-home --shell /bin/bash "$APP_USER"

# ── 4. Code ─────────────────────────────────────────────────────────────────
if [ -d "$APP_DIR/.git" ]; then
  log "Mise à jour du code dans $APP_DIR"
  git -C "$APP_DIR" fetch --all --quiet
  git -C "$APP_DIR" reset --hard origin/main --quiet
else
  log "Clonage du dépôt dans $APP_DIR"
  rm -rf "$APP_DIR"
  git clone --quiet "$REPO_URL" "$APP_DIR"
fi
mkdir -p "$APP_DIR/config"
chown -R "$APP_USER:$APP_USER" "$APP_DIR"

# ── 5. Dépendances Node + Chromium ──────────────────────────────────────────
# --with-deps installe aussi les libs système (libnss3, libgbm1, …) listées
# une à une dans le Dockerfile : ici Playwright s'en charge tout seul.
log "npm ci + navigateur Chromium (quelques minutes)"
sudo -u "$APP_USER" bash -lc "cd '$APP_DIR' && npm ci --omit=dev"
sudo -u "$APP_USER" bash -lc "cd '$APP_DIR' && npx playwright install chromium"
npx --prefix "$APP_DIR" playwright install-deps chromium

# ── 6. Fichier d'environnement (équivalent des `fly secrets`) ───────────────
if [ ! -f /etc/sarzal.env ]; then
  log "Création de /etc/sarzal.env (à remplir !)"
  cat > /etc/sarzal.env <<'EOF'
# Secrets SARzal — équivalent des `fly secrets`. NE PAS committer ce fichier.
# Après toute modification :  sudo systemctl restart sarzal
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
CESAL_EMAIL=simon5.amar@gmail.com
CESAL_PASSWORD=
MODE=alert
DATE_SORTIE=18/12/2026
INTERVAL_SECONDS=3
JITTER_SECONDS=1.5
MAX_BACKOFF_SECONDS=300
HEADLESS=true
# Session CESAL encodée en base64 (poussée par scripts/push-session-gcp.sh)
SESSION_JSON_B64=
EOF
  chmod 600 /etc/sarzal.env
else
  log "/etc/sarzal.env existe déjà — laissé intact"
fi

# ── 7. Service systemd (remplace le superviseur de Fly) ─────────────────────
log "Installation du service systemd"
install -m 644 "$APP_DIR/deploy/sarzal.service" /etc/systemd/system/sarzal.service
systemctl daemon-reload
systemctl enable sarzal

cat <<EOF

✅ Installation terminée.

Il reste 2 choses à faire :
  1) Remplis tes secrets :   sudo nano /etc/sarzal.env
  2) Pousse ta session CESAL depuis ton Mac :
        bash scripts/push-session-gcp.sh
     puis démarre :          sudo systemctl start sarzal

Commandes utiles :
  sudo systemctl status sarzal      # état
  sudo journalctl -u sarzal -f      # logs en direct (équivalent 'fly logs')
  sudo systemctl restart sarzal     # redémarrage
EOF
