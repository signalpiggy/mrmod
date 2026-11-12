# Deploying

Merging to `main` runs the tests, builds the bot and hub images on GitHub's runner, copies them to the VPS over SSH, and restarts the stack with `docker compose`. The first deploy also installs Docker on the VPS if needed and creates `~/mrmod/.env` there with random internal secrets.

**Where secrets live**

| Secret | Where |
| --- | --- |
| Discord bot token, application ID, server ID, OpenAI key | Entered in the hub's **Connection** page; stored AES-256-GCM encrypted in Postgres on the VPS. Never in GitHub. |
| Postgres password, encryption key, hub session key | `~/mrmod/.env` on the VPS, generated there on first deploy. Never in GitHub. |
| SSH key used to deploy | GitHub repository secrets (`VPS_HOST`, `VPS_USER`, `VPS_SSH_KEY`, optional `VPS_PORT`, `VPS_HOST_KEY`). |

Optional repository **variable** `HUB_DOMAIN` sets the hub's address; otherwise the VPS hostname is used (e.g. `srvNNNN.hstgr.cloud`). Caddy gets an HTTPS certificate for it automatically; ports 80 and 443 must be free on the VPS.

## First-time setup

1. Merge to `main` (or run the workflow manually). The deploy log prints the hub URL and a one-time **setup code**.
2. Open the hub, enter the setup code, and choose an admin password (12+ characters).
3. On **Connection**, enter the Discord bot token, application ID, server ID and OpenAI key. The bot starts within seconds.
4. Use **Add to server** on the same page to invite the bot with only the permissions it needs; then drag its role above regular members.
5. In the Developer Portal → Bot, enable **Server Members** and **Message Content** intents.
6. In Discord, create a private `#mod-log` channel and run `/modbot channels modlog:#mod-log` (optionally `alerts:` and `ping_role:`).

Everything starts in **shadow mode**: decisions are logged in `#mod-log` and the hub, nothing is deleted. Review them for a week or two, then enforce rules one at a time from the **Rules** page and switch the global mode on **Overview**.

## Operations (on the VPS)

- Logs: `cd ~/mrmod && docker compose logs -f bot`
- Restart: `docker compose restart bot`
- Backup: `docker compose exec db pg_dump -U mrmod mrmod | gzip > backup.sql.gz` (also back up `~/mrmod/.env`: without `SECRETS_KEY` the stored credentials can't be decrypted, and you'd re-enter them in the hub)
- Manual redeploy: GitHub → Actions → *CI and deploy* → **Run workflow**
