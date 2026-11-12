import {
  applyRetention,
  configureOpenAI,
  crawlKnowledgeBase,
  loadSecrets,
  parseBacktestCommand,
  parseBotCommand,
  runMigrations,
  seedRules,
  setRuntime,
  type SecretValues,
} from "@mrmod/core";
import { Client, Events, GatewayIntentBits, Partials, REST, Routes } from "discord.js";
import { runBacktest } from "./backtest.js";
import { answerMention, COMMANDS, handleInteraction } from "./interactions.js";
import { log } from "./log.js";
import { handleMessage, runHubCommand } from "./moderation.js";
import { BotState } from "./state.js";

type Ready = Required<SecretValues>;

function complete(s: SecretValues): s is Ready {
  return Boolean(s.DISCORD_TOKEN && s.DISCORD_CLIENT_ID && s.DISCORD_GUILD_ID && s.OPENAI_API_KEY);
}

/** Secrets are entered in the hub and stored encrypted in Postgres on the VPS. Wait until all four exist. */
async function waitForSecrets(state: BotState): Promise<Ready> {
  let s = await loadSecrets(state.db);
  if (complete(s)) return s;
  log.info("waiting for secrets: open the hub and fill in the Connection page");
  await setRuntime(state.db, "bot", { status: "waiting-for-secrets", at: new Date().toISOString() });
  return new Promise((resolve) => {
    const check = async () => {
      s = await loadSecrets(state.db);
      if (complete(s)) {
        clearInterval(timer);
        resolve(s);
      }
    };
    const timer = setInterval(() => void check().catch((e) => log.error("secret check failed", e)), 10_000);
    void state.sql.listen("mrmod_secrets", () => void check());
  });
}

async function main() {
  const state = new BotState();
  await runMigrations(state.db, state.sql);
  const seeded = await seedRules(state.db);
  if (seeded) log.info(`seeded ${seeded} starter rules (all in shadow mode)`);
  await state.reload();
  await state.listen();

  const sec = await waitForSecrets(state);
  configureOpenAI(sec.OPENAI_API_KEY);
  const guildId = sec.DISCORD_GUILD_ID;

  // After startup, any change in the hub restarts the process (docker restarts it) to pick up new credentials.
  await state.sql.listen("mrmod_secrets", () => {
    log.info("secrets changed in the hub; restarting");
    process.exit(0);
  });

  try {
    await new REST().setToken(sec.DISCORD_TOKEN).put(Routes.applicationGuildCommands(sec.DISCORD_CLIENT_ID, guildId), { body: COMMANDS });
    log.info(`registered ${COMMANDS.length} commands`);
  } catch (err) {
    await setRuntime(state.db, "bot", { status: "error", error: `command registration failed: ${String(err)}`, at: new Date().toISOString() });
    throw err;
  }

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.GuildMembers,
      GatewayIntentBits.AutoModerationExecution,
    ],
    partials: [Partials.GuildMember],
    allowedMentions: { parse: [] },
  });

  const heartbeat = () =>
    setRuntime(state.db, "bot", {
      status: client.isReady() ? "online" : "connecting",
      tag: client.user?.tag ?? null,
      guild: client.guilds.cache.get(guildId)?.name ?? null,
      inGuild: client.guilds.cache.has(guildId),
      at: new Date().toISOString(),
    }).catch((e) => log.error("heartbeat failed", e));

  client.once(Events.ClientReady, (c) => {
    log.info(`logged in as ${c.user.tag}`);
    if (!c.guilds.cache.has(guildId)) log.warn(`bot is not in server ${guildId}; use the invite link from the hub`);
    void heartbeat();
  });
  setInterval(heartbeat, 60_000);

  client.on(Events.MessageCreate, (message) => {
    if (!message.inGuild() || message.guildId !== guildId) return;
    void (async () => {
      try {
        await handleMessage(state, message);
        if (!message.author.bot && message.mentions.users.has(client.user!.id)) await answerMention(state, message);
      } catch (err) {
        log.error(`message ${message.id} failed`, err);
      }
    })();
  });

  client.on(Events.InteractionCreate, (i) => void handleInteraction(state, i));

  client.on(Events.AutoModerationActionExecution, (e) => {
    log.info(`automod ${e.ruleTriggerType} blocked a message from ${e.userId} (keyword: ${e.matchedKeyword ?? "-"})`);
  });

  try {
    await client.login(sec.DISCORD_TOKEN);
  } catch (err) {
    await setRuntime(state.db, "bot", { status: "error", error: `Discord login failed: ${String(err)}`, at: new Date().toISOString() });
    throw err;
  }

  // Background jobs; the hub's "Re-crawl now" button sends NOTIFY mrmod_cmd 'recrawl'.
  const crawl = () => crawlKnowledgeBase(state.db, state.settings, log.info).catch((e) => log.error("kb crawl failed", e));
  setTimeout(crawl, 30_000);
  setInterval(crawl, Math.max(1, state.settings.crawlIntervalHours) * 3_600_000);
  await state.sql.listen("mrmod_cmd", (payload) => {
    if (payload === "recrawl") return void crawl();
    const backtest = parseBacktestCommand(payload);
    if (backtest) return void runBacktest(state, client, guildId, backtest);
    const cmd = parseBotCommand(payload);
    if (cmd) void runHubCommand(state, client, guildId, cmd);
  });
  setInterval(() => {
    applyRetention(state.db, state.settings.retentionDays)
      .then((n) => n && log.info(`retention: cleared text of ${n} old decisions`))
      .catch((e) => log.error("retention failed", e));
  }, 6 * 3_600_000);

  const shutdown = async () => {
    log.info("shutting down");
    await client.destroy();
    await state.sql.end({ timeout: 5 });
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((err) => {
  log.error("fatal", err);
  // Give docker's restart policy a pause so a bad token doesn't hot-loop.
  setTimeout(() => process.exit(1), 15_000);
});
