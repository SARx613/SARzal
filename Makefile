.PHONY: relogin login push-session logs status restart \
        run run-visible run-alert all stop-local logs-local check-node

# Nom de l'app lu depuis fly.toml (source de vérité unique). Le nom a déjà
# changé une fois côté Fly, et le codage en dur cassait `make logs/status`.
APP := $(shell sed -n "s/^app *= *['\"]\(.*\)['\"].*/\1/p" fly.toml | head -1)

# Logs des instances locales. Sous config/, donc déjà hors git.
LOG_DIR := config/logs

# Le `node` par défaut de ce Mac est un v14 : `fetch` n'y existe pas (arrivé en
# v18) et TOUTE la surveillance HTTP repose dessus. Lancé avec, le bot planterait
# à chaque cycle — et on ne veut pas le découvrir le jour où un logement se
# libère. On refuse donc de démarrer sous Node < 18.
check-node:
	@node -e 'const v=+process.versions.node.split(".")[0]; if(v<18){console.error("\n❌ Node "+process.versions.node+" détecté — il faut Node 18+ (fetch).\n   Corrige avec :  nvm use 22\n");process.exit(1)}'

# Enchaîne les 2 commandes du re-login : ouvre le navigateur pour te
# reconnecter (résous le captcha), puis pousse la nouvelle session sur Fly et
# redémarre la machine. C'est la commande à lancer après un message "session
# expirée".
relogin: login push-session

login:
	npm run login

push-session:
	bash scripts/update-session.sh

logs:
	fly logs --app $(APP)

status:
	fly status --app $(APP)

restart:
	fly machine restart $$(fly machine list --app $(APP) --json | grep '"id"' | head -1 | awk -F'"' '{print $$4}') --app $(APP)

# ─────────────────────── Instances locales (sur ton Mac) ────────────────────
#
# Le VPS tourne en permanence. Ces cibles lancent EN PLUS une instance sur ta
# machine : deux chances de décrocher le logement. INSTANCE_NAME apparaît en
# préfixe de chaque message Telegram, pour savoir laquelle des deux a parlé.
#
# ⚠️ Les deux peuvent tenter de réserver le MÊME logement : elles ne partagent
# pas config/seen_logements.json. Le site refuse la seconde, mais si tu préfères
# éviter, lance `make run-alert` côté Mac et laisse le VPS seul en reserve.

# Surveillance locale, Chromium invisible (même comportement que le VPS).
# Tourne au premier plan : Ctrl-C pour arrêter.
run:
	INSTANCE_NAME=Mac npm start

# ⭐ Surveillance locale avec Chromium OUVERT à l'écran pour la réservation.
# Le site (jQuery/select2/AJAX) répond mieux dans une vraie fenêtre, et tu peux
# reprendre la main à la souris si le bot se coince. Le VPS, lui, n'a aucun
# affichage : cette cible n'a de sens qu'en local.
run-visible:
	INSTANCE_NAME=Mac-visible SHOW_BROWSER=true npm start

# Surveillance locale en ALERTE SEULE : notifie, ne réserve jamais.
# Le filet sans le risque de double réservation.
run-alert:
	INSTANCE_NAME=Mac-alerte MODE=alert npm start

# Lance les deux instances locales en ARRIÈRE-PLAN (visible + invisible), en
# plus du VPS. `make logs-local` pour suivre, `make stop-local` pour arrêter.
all:
	@mkdir -p $(LOG_DIR)
	@INSTANCE_NAME=Mac nohup npm start > $(LOG_DIR)/mac.log 2>&1 & \
	  echo "  ▶ Mac (invisible) → $(LOG_DIR)/mac.log"
	@INSTANCE_NAME=Mac-visible SHOW_BROWSER=true nohup npm start > $(LOG_DIR)/mac-visible.log 2>&1 & \
	  echo "  ▶ Mac-visible     → $(LOG_DIR)/mac-visible.log"
	@echo "  ▶ VPS             → déjà en route (make status)"
	@echo ""
	@echo "Suivre : make logs-local   |   Arrêter : make stop-local"

# Suit les logs des instances lancées par `make all`.
logs-local:
	@mkdir -p $(LOG_DIR)
	tail -f $(LOG_DIR)/*.log

# Arrête les instances locales. N'affecte PAS le VPS.
stop-local:
	@pkill -f "node src/loop.js" && echo "Instances locales arrêtées." || echo "Aucune instance locale en cours."