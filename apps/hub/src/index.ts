import { serve } from "@hono/node-server";
import { connect, runMigrations, seedRules } from "@mrmod/core";
import { createApp } from "./app.js";
import { ensureSetupCode } from "./auth.js";

async function main() {
  const secret = process.env.HUB_SESSION_SECRET;
  if (!secret || secret.length < 32) throw new Error("HUB_SESSION_SECRET (32+ chars) must be set");
  if (!process.env.SECRETS_KEY) throw new Error("SECRETS_KEY must be set");
  const { db, sql } = connect();
  await runMigrations(db, sql);
  await seedRules(db);

  const code = await ensureSetupCode(db);
  if (code) console.log(`HUB SETUP CODE: ${code}  (open the hub and enter it to set the admin password)`);

  const port = Number(process.env.PORT ?? 3000);
  const app = createApp(db, secret, { secureCookies: process.env.HUB_INSECURE_COOKIES !== "1" });
  serve({ fetch: app.fetch, port, hostname: "0.0.0.0" }, () => console.log(`hub listening on :${port}`));
}

main().catch((err) => {
  console.error(err);
  setTimeout(() => process.exit(1), 5_000);
});
