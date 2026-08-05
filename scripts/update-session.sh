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

# Le nom de l'app est lu depuis fly.toml : c'est la seule source de vérité.
# (Il a déjà changé une fois — "sarzal" → "sarzal-crfugg" — et le nom codé en
# dur ici faisait échouer le script avec "Could not find App".)
APP=$(sed -n "s/^app *= *['\"]\(.*\)['\"].*/\1/p" fly.toml | head -1)
SESSION_FILE="config/session.json"

if [ -z "$APP" ]; then
  echo "❌ Impossible de lire le nom de l'app dans fly.toml"
  exit 1
fi

if [ ! -f "$SESSION_FILE" ]; then
  echo "❌ $SESSION_FILE introuvable. Lance d'abord : npm run login"
  exit 1
fi

echo "📦 Encodage de la session en base64…"
SESSION_B64=$(base64 -i "$SESSION_FILE")

echo "🚀 Envoi du secret SESSION_JSON_B64 sur Fly.io (app : $APP)…"
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
