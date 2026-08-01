#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────
# push-session-gcp.sh — équivalent GCP de scripts/update-session.sh
#
# À lancer sur TON MAC, APRÈS `npm run login` (session CESAL fraîche).
# Encode config/session.json en base64, l'écrit dans /etc/sarzal.env sur la VM
# Compute Engine, puis redémarre le service.
#
# Usage : bash scripts/push-session-gcp.sh
# ─────────────────────────────────────────────────────────────
set -euo pipefail

VM_NAME="${VM_NAME:-sarzal}"
ZONE="${ZONE:-us-central1-a}"
SESSION_FILE="config/session.json"

if [ ! -f "$SESSION_FILE" ]; then
  echo "❌ $SESSION_FILE introuvable. Lance d'abord : npm run login"
  exit 1
fi

echo "📦 Encodage de la session en base64…"
# -w0 (GNU) n'existe pas sur macOS ; tr -d '\n' fonctionne partout.
SESSION_B64=$(base64 < "$SESSION_FILE" | tr -d '\n')

echo "🚀 Envoi sur la VM $VM_NAME ($ZONE)…"
# La valeur transite par stdin, jamais par la ligne de commande : elle
# n'apparaît donc ni dans `ps` ni dans l'historique shell de la VM.
printf '%s' "$SESSION_B64" | gcloud compute ssh "$VM_NAME" --zone "$ZONE" --command '
  set -e
  B64=$(cat)
  sudo sed -i "/^SESSION_JSON_B64=/d" /etc/sarzal.env
  printf "SESSION_JSON_B64=%s\n" "$B64" | sudo tee -a /etc/sarzal.env > /dev/null
  sudo chmod 600 /etc/sarzal.env
  echo "🔄 Redémarrage du service…"
  sudo systemctl restart sarzal
  sleep 2
  sudo systemctl is-active sarzal
'

echo ""
echo "✅ Session mise à jour ! Le moniteur reprend dans quelques secondes."
echo "📋 Logs en direct : make logs-gcp"
