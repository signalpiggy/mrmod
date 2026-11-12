# mrmod

AI moderation and help bot for the NuFi Discord.

- **Moderation:** cheap signals and OpenAI's free moderation endpoint run on every message; a small OpenAI model judges only suspicious ones and returns a structured verdict; a deterministic policy engine picks the action. The model never bans anyone.
- **Shadow mode:** every rule is `off`, `shadow` (log what it would do) or `enforce`, and a global switch forces everything to shadow. Seeded rules all start in shadow.
- **Support-scam rule:** deletes messages that direct users to open a support ticket at a link or ask them to DM for support.
- **Q&A:** `/ask` or @mention, answered only from support.nu.fi articles (re-crawled daily), with source links.
- **Mod log:** every decision is posted to a private channel with *Correct* / *Wrong* buttons; labels are stored for measuring precision before enforcing.

## Layout

| Path | What |
| --- | --- |
| `packages/core` | Pipeline, signals, policy engine, OpenAI calls, DB schema + migrations, knowledge base crawler and answering |
| `apps/bot` | discord.js v14 process: message handling, enforcement, mod log, alerts, slash commands |
| `apps/hub` | Password-protected web hub: connection keys, overview, decisions review, rules, settings, knowledge base, audit log |
| `.github/workflows/ci.yml` | Tests on every PR; on merge to `main`, builds the images and deploys to the VPS |
| `docker-compose.yml` | Production stack: Postgres 16 + pgvector, bot, hub, Caddy (HTTPS) |


## Discord commands

| Command | Who | What |
| --- | --- | --- |
| `/ask question` | everyone | Answer from the NuFi help centre |
| `/modbot channels modlog [alerts] [ping_role]` | Manage Server | Set where decisions are logged and who gets pinged |
| `/modbot status` | Manage Server | Mode, enforced rules, last 24h numbers |
| `/modbot recrawl` | Manage Server | Re-read support.nu.fi now |
| *Apps → Report to mod bot* (right-click a message) | Manage Messages | Record a missed scam or confirm a catch |

## Local development

```bash
cp .env.example .env    # needs Postgres with pgvector
pnpm install
pnpm build
pnpm test               # set TEST_DATABASE_URL to also run the DB integration test
node --env-file=.env apps/hub/dist/index.js   # hub on :3000, prints a setup code
node --env-file=.env apps/bot/dist/index.js   # waits until secrets are entered in the hub
```

Schema changes: edit `packages/core/src/db/schema.ts`, then `pnpm db:generate`. Migrations run automatically on bot start.

See [DEPLOY.md](DEPLOY.md) for first-time setup.
