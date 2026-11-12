import { createHash } from "node:crypto";
import { judge as defaultJudge, moderate as defaultModerate, type JudgeResult, type ModerationResult } from "./ai.js";
import type { Settings } from "./config.js";
import { evaluatePolicy, type PolicyMatch } from "./policy.js";
import { computeSignals, riskScore } from "./signals.js";
import type { JudgeVerdict, MessageInput, RuleRow, Signals } from "./types.js";

export function contentHash(text: string): string {
  return createHash("sha256").update(text.trim().toLowerCase().replace(/\s+/g, " ")).digest("hex").slice(0, 32);
}

/** Tracks which channels each author posted the same text in, over a sliding window. */
export class DuplicateTracker {
  private seen = new Map<string, { channels: Set<string>; at: number }>();
  constructor(private windowMs = 10 * 60_000) {}

  record(authorId: string, hash: string, channelId: string, now = Date.now()): number {
    if (this.seen.size > 50_000) this.prune(now);
    const key = `${authorId}:${hash}`;
    const entry = this.seen.get(key);
    if (!entry || now - entry.at > this.windowMs) {
      this.seen.set(key, { channels: new Set([channelId]), at: now });
      return 1;
    }
    entry.channels.add(channelId);
    entry.at = now;
    return entry.channels.size;
  }

  private prune(now: number) {
    for (const [k, v] of this.seen) if (now - v.at > this.windowMs) this.seen.delete(k);
  }
}

/** Reuse a verdict for identical text judged recently (spam waves post the same thing many times). */
export class VerdictCache {
  private cache = new Map<string, { result: JudgeResult; at: number }>();
  constructor(private ttlMs = 10 * 60_000) {}
  get(hash: string, now = Date.now()): JudgeResult | null {
    const e = this.cache.get(hash);
    if (!e || now - e.at > this.ttlMs) return null;
    return e.result;
  }
  set(hash: string, result: JudgeResult, now = Date.now()) {
    if (this.cache.size > 5_000) this.cache.clear();
    this.cache.set(hash, { result, at: now });
  }
}

export interface PipelineDeps {
  settings: Settings;
  rules: RuleRow[];
  duplicates: DuplicateTracker;
  verdicts: VerdictCache;
  moderate?: (text: string, s: Settings) => Promise<ModerationResult>;
  judge?: (input: MessageInput, signals: Signals, s: Settings) => Promise<JudgeResult>;
  random?: () => number;
  log?: (msg: string, err?: unknown) => void;
}

export interface Decision {
  input: MessageInput;
  contentHash: string;
  signals: Signals;
  riskScore: number;
  moderation: ModerationResult | null;
  judged: boolean;
  judgeResult: JudgeResult | null;
  verdict: JudgeVerdict | null;
  match: PolicyMatch | null;
  sampled: boolean;
  /** Should this be written to the decisions table? */
  record: boolean;
  errors: string[];
}

export type SkipReason = "bot" | "empty" | "exempt-channel" | "exempt-role";

export function skipReason(input: MessageInput, s: Settings): SkipReason | null {
  if (input.authorIsBot) return "bot";
  if (!input.content.trim()) return "empty";
  if (s.exemptChannelIds.includes(input.channelId)) return "exempt-channel";
  if (input.memberRoleIds.some((r) => s.exemptRoleIds.includes(r))) return "exempt-role";
  return null;
}

export function shouldJudge(signals: Signals, risk: number, input: MessageInput, s: Settings): boolean {
  const trusted = input.memberRoleIds.some((r) => s.trustedRoleIds.includes(r));
  if (risk >= s.riskThreshold) return true;
  if (signals.supportScam.matched) return true;
  if (trusted) return false;
  if (s.judgeAll) return true;
  if (s.judgeNewMembersDays > 0 && signals.memberAgeDays !== null && signals.memberAgeDays < s.judgeNewMembersDays) return true;
  return false;
}

export async function runPipeline(input: MessageInput, deps: PipelineDeps): Promise<Decision | null> {
  const s = deps.settings;
  if (skipReason(input, s)) return null;
  const log = deps.log ?? (() => {});
  const errors: string[] = [];
  const hash = contentHash(input.content);
  const dupes = deps.duplicates.record(input.authorId, hash, input.channelId);
  const signals = computeSignals(input, dupes);
  const risk = riskScore(signals);

  let moderation: ModerationResult | null = null;
  try {
    moderation = await (deps.moderate ?? defaultModerate)(input.content, s);
  } catch (err) {
    errors.push(`moderation: ${String(err)}`);
    log("moderation endpoint failed", err);
  }

  const wantJudge = shouldJudge(signals, risk, input, s) || Boolean(moderation?.flagged);
  let judgeResult: JudgeResult | null = null;
  let verdict: JudgeVerdict | null = null;
  if (wantJudge) {
    judgeResult = deps.verdicts.get(hash);
    if (!judgeResult) {
      try {
        judgeResult = await (deps.judge ?? defaultJudge)(input, signals, s);
        deps.verdicts.set(hash, judgeResult);
      } catch (err) {
        errors.push(`judge: ${String(err)}`);
        log("judge failed", err);
      }
    }
    verdict = judgeResult?.verdict ?? null;
    // If the model is unavailable, a strong support-scam pattern still counts.
    if (!verdict && signals.supportScam.strong) {
      verdict = {
        verdict: "support_scam",
        confidence: 0.8,
        rule_broken: "R1",
        reason: `Pattern match (${signals.supportScam.patterns.join(", ")}); AI judge unavailable.`,
        source: "heuristic",
      };
    }
  }

  const match = evaluatePolicy(deps.rules, { signals, moderationFlagged: Boolean(moderation?.flagged), verdict }, s.globalMode);
  const sampled = !match && (deps.random ?? Math.random)() < s.sampleRate;
  const record = s.logAllMessages || Boolean(match) || sampled || wantJudge || Boolean(moderation?.flagged);

  return {
    input,
    contentHash: hash,
    signals,
    riskScore: risk,
    moderation,
    judged: Boolean(judgeResult),
    judgeResult,
    verdict,
    match,
    sampled,
    record,
    errors,
  };
}
