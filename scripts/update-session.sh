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

SESSION_FILE="config/session.json"

if [ ! -f "$SESSION_FILE" ]; then
  echo "❌ $SESSION_FILE introuvable. Lance d'abord : npm run login"
  exit 1
fi

echo "📦 Encodage de la session en base64…"
SESSION_B64=$(base64 -i "$SESSION_FILE")

echo "🚀 Envoi du secret SESSION_JSON_B64 sur Fly.io…"
fly secrets set SESSION_JSON_B64="$SESSION_B64" --app sarzal

echo "🔄 Redémarrage de la machine Fly.io…"
fly machine restart --app sarzal

echo ""
echo "✅ Session mise à jour ! Le moniteur reprend dans quelques secondes."
