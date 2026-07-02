FROM node:20-slim

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

# Crée le dossier config (pour session.json injecté au démarrage)
RUN mkdir -p config

CMD ["sh", "start.sh"]
