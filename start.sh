#!/bin/sh
# Injecte la session CESAL depuis la variable d'environnement (Fly.io secret)
if [ -n "$SESSION_JSON_B64" ]; then
  echo "$SESSION_JSON_B64" | base64 -d > /app/config/session.json
  echo "✅ session.json chargée depuis SESSION_JSON_B64"
else
  echo "⚠️  SESSION_JSON_B64 non définie — le moniteur enverra une alerte Telegram pour demander un login."
fi

exec node src/loop.js
