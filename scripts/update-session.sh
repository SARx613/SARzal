#!/bin/bash
# ─────────────────────────────────────────────────────────────
# update-session.sh
#
# À lancer APRÈS npm run login (quand la session CESAL est fraîche).
# Encode config/session.json en base64 et le pousse sur Fly.io.
#
# Usage : bash scripts/update-session.sh
# ─────────────────────────────────────────────────────────────

set -e

APP="sarzal"
SESSION_FILE="config/session.json"

if [ ! -f "$SESSION_FILE" ]; then
  echo "❌ $SESSION_FILE introuvable. Lance d'abord : npm run login"
  exit 1
fi

echo "📦 Encodage de la session en base64…"
SESSION_B64=$(base64 -i "$SESSION_FILE")

echo "🚀 Envoi du secret SESSION_JSON_B64 sur Fly.io…"
fly secrets set SESSION_JSON_B64="$SESSION_B64" --app "$APP"

echo "🔄 Redémarrage de toutes les machines…"
# Récupère tous les IDs de machines et les redémarre sans prompt
fly machine list --app "$APP" --json 2>/dev/null \
  | grep '"id"' \
  | awk -F'"' '{print $4}' \
  | while read -r id; do
      echo "  → restart machine $id"
      fly machine restart "$id" --app "$APP"
    done

echo ""
echo "✅ Session mise à jour ! Le moniteur reprend dans quelques secondes."
echo "📋 Logs en direct : fly logs --app $APP"
