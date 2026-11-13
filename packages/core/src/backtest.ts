// Backtesting: replay recent conversation-starting messages through the live pipeline as a dry run.
// Nothing here takes an action in Discord, posts to #mod-log, or writes to the decisions table.
import type { Settings } from "./config.js";
import { DuplicateTracker, runPipeline, VerdictCache, type Decision, type PipelineDeps } from "./pipeline.js";
import { answerQuestion, formatAnswer, looksLikeQuestion } from "./knowledge/answer.js";
import type { DB } from "./db/client.js";
import type { ActionPlan, JudgeVerdict, MessageInput, RuleMode, Signals, SuggestedAnswer } from "./types.js";

/** Runtime key holding the latest backtest run. */
export const BACKTEST_KEY = "backtest";
export const BACKTEST_DEFAULT_COUNT = 300;
/** A message counts as a new conversation if its author was quiet in that channel for this long. */
export const STARTER_GAP_MS = 10 * 60_000;

/** The minimum the starter check needs to know about a channel message. */
export interface HistoryMessage {
  id: string;
  authorId: string;
  authorIsBot: boolean;
  createdAt: Date;
  /** Discord reply (message reference) to this message id, if any. */
  replyToId: string | null;
  /** Author of the replied-to message, when known. */
  replyToAuthorId: string | null;
  mentionedUserIds: string[];
  content: string;
}

export type StarterVerdict = { starter: true } | { starter: false; why: string };

/**
 * Is `msg` the start of a conversation rather than part of one?
 * `before` holds earlier messages in the same channel (any order, newer ones matter most).
 * Not a starter if: it's a Discord reply, the author posted in this channel in the last 10 minutes,
 * or someone addressed the author (reply or @mention) in this channel in the last 10 minutes.
 */
export function isConversationStarter(msg: HistoryMessage, before: HistoryMessage[]): StarterVerdict {
  if (msg.replyToId) return { starter: false, why: "reply" };
  const since = msg.createdAt.getTime() - STARTER_GAP_MS;
  for (const p of before) {
    const t = p.createdAt.getTime();
    if (t < since || t >= msg.createdAt.getTime() || p.id === msg.id) continue;
    if (p.authorId === msg.authorId) return { starter: false, why: "follow-up" };
    if (p.replyToAuthorId === msg.authorId || p.mentionedUserIds.includes(msg.authorId)) return { starter: false, why: "answering someone" };
  }
  return { starter: true };
}

/** One replayed message and what Mr Mod would have done. */
export interface BacktestResult {
  guildId: string;
  messageId: string;
  channelId: string;
  channelName: string | null;
  authorId: string;
  authorTag: string;
  createdAt: string;
  content: string;
  /** Null when skipped. */
  signals: Signals | null;
  riskScore: number;
  moderationFlagged: boolean;
  moderationCategories: string[];
  judged: boolean;
  verdict: JudgeVerdict | null;
  ruleId: string | null;
  ruleName: string | null;
  /** The matched rule's mode as configured now (shadow in shadow mode). */
  mode: RuleMode | null;
  plannedAction: ActionPlan | null;
  suggestedAnswer: SuggestedAnswer | null;
  /** "act" = a rule matched; "answer" = would draft a reply; "allow" = nothing; "skip" = exempt or skipped. */
  outcome: "act" | "answer" | "allow" | "skip";
  skipped?: string;
  errors: string[];
}

export interface BacktestRun {
  status: "running" | "done" | "error";
  requestedBy: string;
  requested: number;
  /** Date range asked for (ISO), null = open-ended. */
  from?: string | null;
  to?: string | null;
  /** The page limit cut reading short, so older qualifying messages may be missing. */
  truncated?: boolean;
  /** Channels asked for (empty = all). */
  channelIds?: string[];
  /** Timezone offset (minutes, as getTimezoneOffset) of whoever started the run. */
  tz?: number;
  startedAt: string;
  finishedAt?: string;
  /** Live progress line for the hub. */
  phase: string;
  channelsScanned: number;
  messagesScanned: number;
  startersFound: number;
  processed: number;
  /** Settings snapshot that matters for reading the results. */
  globalMode: "shadow" | "enforce";
  error?: string;
  results: BacktestResult[];
}

export const BACKTEST_COUNTS = [100, 300, 500, 1000, 2000] as const;
export const BACKTEST_MAX_COUNT = 2000;

/** Runtime key: the server's channels as the bot sees them, for the Backtest channel picker. */
export const BACKTEST_CHANNELS_KEY = "backtest_channels";

export interface ChannelInfo {
  id: string;
  name: string;
  /** Category name, or the parent channel's name for a thread. */
  parent: string | null;
  kind: "text" | "announcement" | "thread" | "forum" | "voice";
  /** The backtest can read this channel's history. */
  readable: boolean;
  /** Why it can't be read, or a note (exempt, mod log). */
  note: string | null;
  /** @everyone can see it. */
  public?: boolean;
  /** When the bot can't see it: roles (not admin/bot roles) that can, lowest first. */
  visibleTo?: string[];
}

/** Channels the bot can't see, so it never moderates them. */
export function unseenChannels(channels: ChannelInfo[]): ChannelInfo[] {
  return channels.filter((c) => c.note === "bot can't see this channel");
}

/** Hub -> bot: start a backtest. Takes the newest `count` starters, optionally only those sent between `from` and `to` (ISO times). */
export type BacktestCommand = { type: "backtest"; count: number; from: string | null; to: string | null; /** Only these channels; empty = all readable. */ channelIds: string[]; actor: string; /** Viewer's getTimezoneOffset(), for showing dates. */ tz: number };

function isoOrNull(v: unknown): string | null {
  if (typeof v !== "string" || !v) return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

export function parseBacktestCommand(payload: string): BacktestCommand | null {
  try {
    const c = JSON.parse(payload) as Partial<BacktestCommand>;
    if (c.type !== "backtest") return null;
    const count = Math.min(BACKTEST_MAX_COUNT, Math.max(1, Math.floor(Number(c.count) || BACKTEST_DEFAULT_COUNT)));
    let from = isoOrNull(c.from);
    let to = isoOrNull(c.to);
    if (from && to && from > to) [from, to] = [to, from];
    const tz = Math.max(-840, Math.min(840, Math.round(Number(c.tz) || 0)));
    const channelIds = Array.isArray(c.channelIds) ? c.channelIds.filter((x): x is string => typeof x === "string" && /^\d{5,25}$/.test(x)).slice(0, 100) : [];
    return { type: "backtest", count, from, to, channelIds, actor: typeof c.actor === "string" ? c.actor.slice(0, 100) : "hub", tz };
  } catch {
    return null;
  }
}

/** Discord snowflake for a time: messages fetched `before` it were sent before that time. */
export function snowflakeAt(ms: number): string {
  return ((BigInt(Math.floor(ms)) - 1420070400000n) << 22n).toString();
}

/**
 * Duplicate tracker that uses each message's own timestamp, so replaying days of history at once
 * doesn't count messages hours apart as the same 10-minute wave.
 */
class ReplayDuplicates extends DuplicateTracker {
  at = Date.now();
  override record(authorId: string, hash: string, channelId: string): number {
    return super.record(authorId, hash, channelId, this.at);
  }
}

/** The live pipeline computes account/member age against "now"; shift dates so ages are as of when the message was sent. */
function asOf(input: MessageInput, sentAt: Date): MessageInput {
  const shift = Date.now() - sentAt.getTime();
  return {
    ...input,
    accountCreatedAt: new Date(input.accountCreatedAt.getTime() + shift),
    memberJoinedAt: input.memberJoinedAt ? new Date(input.memberJoinedAt.getTime() + shift) : null,
  };
}

/** Same test the bot uses before drafting a shadow answer. */
export function wouldSuggestAnswer(settings: Settings, d: Decision): boolean {
  if (!settings.suggestAnswers || d.match) return false;
  const v = d.verdict;
  if (v && v.verdict !== "ok") return false;
  return Boolean(v?.is_question) || looksLikeQuestion(d.input.content);
}

export interface ReplayDeps {
  db: DB;
  settings: Settings;
  rules: PipelineDeps["rules"];
  log?: (msg: string, err?: unknown) => void;
  /** Overrides for tests. */
  moderate?: PipelineDeps["moderate"];
  judge?: PipelineDeps["judge"];
  answer?: (question: string) => Promise<SuggestedAnswer>;
}

/** A replay session: call `replay` for each message oldest first. */
export function createReplayer(deps: ReplayDeps) {
  const duplicates = new ReplayDuplicates();
  const verdicts = new VerdictCache(365 * 86_400_000);
  const answer =
    deps.answer ??
    (async (q: string): Promise<SuggestedAnswer> => {
      const a = await answerQuestion(deps.db, deps.settings, q, { userId: "backtest", channelId: "backtest" }, { log: false });
      return { answerable: a.answerable, text: formatAnswer(a, deps.settings), sources: a.sources, model: a.model, latencyMs: a.latencyMs };
    });

  return async function replay(input: MessageInput, sentAt: Date): Promise<BacktestResult> {
    duplicates.at = sentAt.getTime();
    const d = await runPipeline(asOf(input, sentAt), {
      settings: deps.settings,
      rules: deps.rules,
      duplicates,
      verdicts,
      moderate: deps.moderate,
      judge: deps.judge,
      random: () => 1, // no random sampling in a dry run
      log: deps.log,
    });
    const base = {
      guildId: input.guildId,
      messageId: input.messageId,
      channelId: input.channelId,
      channelName: input.channelName,
      authorId: input.authorId,
      authorTag: input.authorTag,
      createdAt: sentAt.toISOString(),
      content: input.content.slice(0, 2000),
    };
    if (!d) {
      return {
        ...base,
        signals: null,
        riskScore: 0,
        moderationFlagged: false,
        moderationCategories: [],
        judged: false,
        verdict: null,
        ruleId: null,
        ruleName: null,
        mode: null,
        plannedAction: null,
        suggestedAnswer: null,
        outcome: "skip",
        skipped: "exempt role or channel",
        errors: [],
      };
    }
    let suggestedAnswer: SuggestedAnswer | null = null;
    if (wouldSuggestAnswer(deps.settings, d)) {
      try {
        suggestedAnswer = await answer(input.content);
      } catch (err) {
        suggestedAnswer = { answerable: false, text: "", sources: [], error: String(err).slice(0, 300) };
      }
    }
    return {
      ...base,
      signals: d.signals,
      riskScore: d.riskScore,
      moderationFlagged: Boolean(d.moderation?.flagged),
      moderationCategories: d.moderation?.flagged ? Object.keys(d.moderation.scores).slice(0, 4) : [],
      judged: d.judged,
      verdict: d.verdict,
      ruleId: d.match?.rule.id ?? null,
      ruleName: d.match?.rule.name ?? null,
      mode: d.match?.mode ?? null,
      plannedAction: d.match?.action ?? null,
      suggestedAnswer,
      outcome: d.match ? "act" : suggestedAnswer ? "answer" : "allow",
      errors: d.errors,
    };
  };
}

/** Counts for the summary bar. */
export function summarizeBacktest(results: BacktestResult[]) {
  const acts = results.filter((r) => r.outcome === "act");
  return {
    total: results.length,
    act: acts.length,
    del: acts.filter((r) => r.plannedAction?.delete).length,
    ban: acts.filter((r) => r.plannedAction?.ban).length,
    timeout: acts.filter((r) => (r.plannedAction?.timeoutMinutes ?? 0) > 0).length,
    logOnly: acts.filter((r) => r.plannedAction && !r.plannedAction.delete && !r.plannedAction.ban && !r.plannedAction.timeoutMinutes).length,
    answer: results.filter((r) => r.outcome === "answer").length,
    answerable: results.filter((r) => r.suggestedAnswer?.answerable).length,
    allow: results.filter((r) => r.outcome === "allow").length,
    skip: results.filter((r) => r.outcome === "skip").length,
  };
}

/** A channel to read: `fetch` returns up to 100 messages sent before the `before` message id (or the newest), newest first. */
export interface HistorySource<K> {
  key: K;
  fetch(before: string | undefined): Promise<HistoryMessage[]>;
}

export interface CollectOptions {
  count: number;
  /** Only starters sent at or after this time (ms). */
  from?: number | null;
  /** Only starters sent before this time (ms). */
  to?: number | null;
  /** Extra filter for which messages can be replayed (bots, empty, system types...). */
  eligible?: (m: HistoryMessage) => boolean;
  /** Safety stop on total history pages read. */
  maxPages?: number;
  onPage?: (stats: { pages: number; messages: number; starters: number; channel: unknown }) => void | Promise<void>;
}

export interface Collected<K> {
  picked: { key: K; message: HistoryMessage; history: HistoryMessage[] }[];
  pages: number;
  messages: number;
  starters: number;
  channelsRead: number;
  /** True if the page limit cut the read short (results may then miss older messages). */
  truncated: boolean;
}

/**
 * Finds the newest `count` conversation starters across all channels.
 * Reads all channels backwards in step: it always fetches the next page of whichever channel is
 * read least far back, so everything newer than the shared "frontier" has been seen in every channel.
 * It stops once `count` starters sit above that frontier (or it has passed `from`).
 */
export async function collectLatestStarters<K>(sources: HistorySource<K>[], o: CollectOptions): Promise<Collected<K>> {
  const maxPages = o.maxPages ?? 3000;
  const from = o.from ?? -Infinity;
  const to = o.to ?? Infinity;
  type St = { src: HistorySource<K>; asc: HistoryMessage[]; frontier: number; before?: string; done: boolean; settledUpTo: number; lo: number };
  const chans: St[] = sources.map((src) => ({
    src,
    asc: [],
    frontier: to,
    before: Number.isFinite(to) ? snowflakeAt(to) : undefined,
    done: false,
    settledUpTo: 0,
    lo: 0,
  }));
  const starters: { at: number; key: K; message: HistoryMessage; st: St }[] = [];
  let pages = 0;
  let messages = 0;
  let truncated = false;

  // Classify messages whose 10-minute lookback is fully read. Messages are kept oldest first; newly fetched pages go in front.
  const settle = (st: St) => {
    const limit = st.done ? -Infinity : st.frontier + STARTER_GAP_MS;
    // asc is oldest first; anything at index >= settledUpTo from the end has been handled. Walk from newest unsettled downwards.
    for (let i = st.asc.length - 1 - st.settledUpTo; i >= 0; i--) {
      const m = st.asc[i]!;
      const t = m.createdAt.getTime();
      if (t < limit) break;
      st.settledUpTo++;
      if (t < from || t >= to) continue;
      if (o.eligible && !o.eligible(m)) continue;
      let j = i - 1;
      const window: HistoryMessage[] = [];
      while (j >= 0 && st.asc[j]!.createdAt.getTime() >= t - STARTER_GAP_MS) window.push(st.asc[j--]!);
      if (isConversationStarter(m, window).starter) starters.push({ at: t, key: st.src.key, message: m, st });
    }
  };

  for (;;) {
    const open = chans.filter((c) => !c.done);
    // The shared frontier: every channel has been read back to at least here.
    const frontier = open.length ? Math.max(...open.map((c) => c.frontier)) : -Infinity;
    if (!open.length) break;
    if (starters.filter((s) => s.at >= frontier + STARTER_GAP_MS).length >= o.count) break;
    if (pages >= maxPages) {
      truncated = true;
      break;
    }
    const st = open.reduce((a, b) => (b.frontier > a.frontier ? b : a));
    let page: HistoryMessage[];
    try {
      page = await st.src.fetch(st.before);
    } catch {
      st.done = true; // unreadable channel
      settle(st);
      continue;
    }
    pages++;
    messages += page.length;
    if (page.length) {
      const asc = [...page].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
      st.asc = [...asc, ...st.asc];
      st.before = asc[0]!.id;
      st.frontier = asc[0]!.createdAt.getTime();
    }
    if (page.length < 100) st.done = true;
    if (st.frontier < from - STARTER_GAP_MS) st.done = true;
    settle(st);
    await o.onPage?.({ pages, messages, starters: starters.length, channel: st.src.key });
  }

  const open = chans.filter((c) => !c.done);
  const frontier = open.length ? Math.max(...open.map((c) => c.frontier)) : -Infinity;
  const picked = starters
    .filter((s) => truncated || s.at >= frontier + STARTER_GAP_MS || !open.length)
    .sort((a, b) => b.at - a.at)
    .slice(0, o.count)
    .map((s) => {
      const i = s.st.asc.indexOf(s.message);
      return { key: s.key, message: s.message, history: s.st.asc.slice(Math.max(0, i - 20), i) };
    });
  return { picked, pages, messages, starters: starters.length, channelsRead: chans.filter((c) => c.asc.length).length, truncated };
}
