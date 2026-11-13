// Backtest: read recent server history, pick conversation-starting messages, and replay them through
// the live pipeline as a dry run. Read-only in Discord: nothing is deleted, posted, or logged to #mod-log.
import {
  BACKTEST_KEY,
  collectLatestStarters,
  createReplayer,
  isConversationStarter,
  setRuntime,
  type BacktestCommand,
  type BacktestResult,
  type BacktestRun,
  type HistoryMessage,
  type HistorySource,
  type MessageInput,
} from "@mrmod/core";
import { ChannelType, MessageType, PermissionFlagsBits, type Client, type Collection, type GuildMember, type Message } from "discord.js";
import { log } from "./log.js";
import type { BotState } from "./state.js";

/** Safety stop: history pages (100 messages each) read across all channels. */
const MAX_PAGES = 3000;
const CONCURRENCY = 4;

let running = false;

type Readable = { id: string; name: string; messages: { fetch(o: { limit: number; before?: string }): Promise<Collection<string, Message>> } };

function toHistory(m: Message): HistoryMessage {
  return {
    id: m.id,
    authorId: m.author.id,
    authorIsBot: m.author.bot || m.webhookId !== null || m.system,
    createdAt: m.createdAt,
    replyToId: m.type === MessageType.Reply ? (m.reference?.messageId ?? "unknown") : null,
    replyToAuthorId: m.type === MessageType.Reply ? (m.mentions.repliedUser?.id ?? null) : null,
    mentionedUserIds: [...m.mentions.users.keys()],
    content: m.content,
  };
}

export async function runBacktest(state: BotState, client: Client, guildId: string, cmd: BacktestCommand) {
  if (running) return log.warn("backtest already running; ignoring new request");
  running = true;
  const settings = state.settings;
  const run: BacktestRun = {
    status: "running",
    requestedBy: cmd.actor,
    requested: cmd.count,
    from: cmd.from,
    to: cmd.to,
    tz: cmd.tz,
    startedAt: new Date().toISOString(),
    phase: "Reading channel history",
    channelsScanned: 0,
    messagesScanned: 0,
    startersFound: 0,
    processed: 0,
    globalMode: settings.globalMode,
    results: [],
  };
  const save = () => setRuntime(state.db, BACKTEST_KEY, run).catch((e) => log.error("backtest: save failed", e));
  await save();
  try {
    const guild = await client.guilds.fetch(guildId);
    const me = await guild.members.fetchMe();
    const skip = new Set([...settings.exemptChannelIds, settings.modlogChannelId, settings.alertChannelId].filter(Boolean) as string[]);
    const all = [...(await guild.channels.fetch()).values()].filter((c) => c !== null);
    const threads = await guild.channels.fetchActiveThreads().then((t) => [...t.threads.values()]).catch(() => []);
    const readable = [...all, ...threads].filter(
      (c) =>
        (c.type === ChannelType.GuildText ||
          c.type === ChannelType.GuildAnnouncement ||
          c.type === ChannelType.PublicThread ||
          c.type === ChannelType.AnnouncementThread) &&
        !skip.has(c.id) &&
        c.permissionsFor(me)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory]),
    ) as unknown as Readable[];

    const byId = new Map<string, Message>();
    const sources: HistorySource<Readable>[] = readable.map((ch) => ({
      key: ch,
      fetch: async (before) => {
        const batch = await ch.messages.fetch({ limit: 100, before });
        return [...batch.values()].map((m) => {
          byId.set(m.id, m);
          return toHistory(m);
        });
      },
    }));
    const eligibleTypes = new Set([MessageType.Default, MessageType.Reply]);
    const collected = await collectLatestStarters(sources, {
      count: cmd.count,
      from: cmd.from ? Date.parse(cmd.from) : null,
      to: cmd.to ? Date.parse(cmd.to) : null,
      maxPages: MAX_PAGES,
      eligible: (h) => {
        const m = byId.get(h.id);
        return Boolean(m && !h.authorIsBot && m.content.trim() && eligibleTypes.has(m.type));
      },
      onPage: async (p) => {
        run.messagesScanned = p.messages;
        run.startersFound = p.starters;
        run.phase = `Reading history (#${(p.channel as Readable).name}, ${p.pages} pages so far)`;
        if (p.pages % 10 === 0) await save();
      },
    });
    run.channelsScanned = collected.channelsRead;
    run.messagesScanned = collected.messages;
    run.startersFound = collected.starters;
    run.truncated = collected.truncated;
    const picked = collected.picked.map((p) => ({ m: byId.get(p.message.id)!, ch: p.key, history: p.history }));
    run.phase = `Fetching ${new Set(picked.map((p) => p.m.author.id)).size} members`;
    await save();

    const members = new Map<string, GuildMember>();
    const ids = [...new Set(picked.map((p) => p.m.author.id))];
    for (let i = 0; i < ids.length; i += 100) {
      const got = await guild.members.fetch({ user: ids.slice(i, i + 100) }).catch(() => null);
      got?.forEach((m) => members.set(m.id, m));
    }

    const replay = createReplayer({ db: state.db, settings, rules: state.rules, log: (m, e) => log.warn(`backtest: ${m}`, e) });
    const ordered = [...picked].reverse(); // oldest first, like live traffic
    run.phase = "Running messages through the pipeline (dry run)";
    const results: BacktestResult[] = [];
    let next = 0;
    const worker = async () => {
      while (next < ordered.length) {
        const { m, ch, history } = ordered[next++]!;
        const member = members.get(m.author.id) ?? null;
        const before = [...history].reverse(); // newest first
        const input: MessageInput = {
          guildId,
          channelId: m.channelId,
          channelName: ch.name,
          messageId: m.id,
          authorId: m.author.id,
          authorTag: m.author.tag,
          authorIsBot: false,
          content: m.content,
          accountCreatedAt: m.author.createdAt,
          memberJoinedAt: member?.joinedAt ?? null,
          memberRoleIds: member ? [...member.roles.cache.keys()] : [],
          mentionCount: m.mentions.users.size + m.mentions.roles.size,
          mentionsEveryone: m.mentions.everyone,
          recentAuthorMessages: before.filter((h) => h.authorId === m.author.id && h.content).slice(0, 3).reverse().map((h) => h.content),
        };
        try {
          results.push(await replay(input, m.createdAt));
        } catch (err) {
          log.warn(`backtest: message ${m.id} failed`, err);
        }
        run.processed++;
        if (run.processed % 10 === 0) {
          run.results = [...results].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
          await save();
        }
      }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    run.results = results.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    run.status = "done";
    run.phase = "Done";
    log.info(`backtest done: ${results.length} messages from ${run.channelsScanned} channels`);
  } catch (err) {
    run.status = "error";
    run.error = String(err).slice(0, 500);
    run.phase = "Failed";
    log.error("backtest failed", err);
  } finally {
    run.finishedAt = new Date().toISOString();
    await save();
    running = false;
  }
}
