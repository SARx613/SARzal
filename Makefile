.PHONY: relogin login push-session logs status restart

APP := sarzal

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