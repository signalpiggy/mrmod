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

/** Hub -> bot: start a backtest. */
export type BacktestCommand = { type: "backtest"; count: number; actor: string };

export function parseBacktestCommand(payload: string): BacktestCommand | null {
  try {
    const c = JSON.parse(payload) as Partial<BacktestCommand>;
    if (c.type !== "backtest") return null;
    const count = Math.min(1000, Math.max(1, Math.floor(Number(c.count) || BACKTEST_DEFAULT_COUNT)));
    return { type: "backtest", count, actor: typeof c.actor === "string" ? c.actor.slice(0, 100) : "hub" };
  } catch {
    return null;
  }
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
