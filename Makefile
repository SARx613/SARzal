.PHONY: relogin login push-session logs status restart \
        relogin-gcp push-session-gcp logs-gcp status-gcp restart-gcp deploy-gcp ssh-gcp

APP  := sarzal
VM   := sarzal
ZONE := us-central1-a

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

# ─── Google Cloud (Compute Engine e2-micro) — voir docs/DEPLOY-GCP.md ───────
# Remplace l'hébergement Fly.io. Toutes ces cibles se lancent depuis ton Mac.

# Après un message "session expirée" : re-login puis push vers la VM.
relogin-gcp: login push-session-gcp

push-session-gcp:
	VM_NAME=$(VM) ZONE=$(ZONE) bash scripts/push-session-gcp.sh

logs-gcp:
	gcloud compute ssh $(VM) --zone $(ZONE) --command 'sudo journalctl -u sarzal -f'

status-gcp:
	gcloud compute ssh $(VM) --zone $(ZONE) --command 'sudo systemctl status sarzal --no-pager'

restart-gcp:
	gcloud compute ssh $(VM) --zone $(ZONE) --command 'sudo systemctl restart sarzal && sleep 2 && sudo systemctl is-active sarzal'

# Équivalent de `fly deploy` : la VM récupère le code et redémarre le service.
deploy-gcp:
	gcloud compute ssh $(VM) --zone $(ZONE) --command '\
	  sudo -u sarzal git -C /opt/sarzal pull --ff-only && \
	  sudo -u sarzal npm --prefix /opt/sarzal ci --omit=dev && \
	  sudo systemctl restart sarzal && sleep 2 && sudo systemctl is-active sarzal'

ssh-gcp:
	gcloud compute ssh $(VM) --zone $(ZONE)