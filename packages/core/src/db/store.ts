import { and, desc, eq, gte, isNotNull, lt, sql as dsql } from "drizzle-orm";
import { parseSettings, type Settings } from "../config.js";
import type { Decision } from "../pipeline.js";
import { DEFAULT_RULES } from "../policy.js";
import type { RuleRow, SuggestedAnswer } from "../types.js";
import type { DB } from "./client.js";
import { auditLog, decisions, rules, settings } from "./schema.js";

export async function loadSettings(db: DB): Promise<Settings> {
  const rows = await db.select({ key: settings.key, value: settings.value }).from(settings);
  return parseSettings(rows);
}

export async function saveSetting(db: DB, key: string, value: unknown, actorId: string, actorName?: string) {
  await db
    .insert(settings)
    .values({ key, value, updatedBy: actorId })
    .onConflictDoUpdate({ target: settings.key, set: { value, updatedBy: actorId, updatedAt: new Date() } });
  await audit(db, actorId, actorName, "setting.update", key, { value });
  await notifyConfigChanged(db);
}

export async function loadRules(db: DB): Promise<RuleRow[]> {
  const rows = await db.select().from(rules);
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    description: r.description,
    mode: r.mode,
    priority: r.priority,
    definition: r.definition,
  }));
}

/** Insert starter rules that don't exist yet; never overwrites edits. */
export async function seedRules(db: DB): Promise<number> {
  const res = await db
    .insert(rules)
    .values(DEFAULT_RULES.map((r) => ({ ...r })))
    .onConflictDoNothing()
    .returning({ id: rules.id });
  return res.length;
}

export async function notifyConfigChanged(db: DB) {
  await db.execute(dsql`NOTIFY mrmod_config`);
}

export async function audit(db: DB, actorId: string, actorName: string | undefined, action: string, target?: string, details?: unknown) {
  await db.insert(auditLog).values({ actorId, actorName, action, target, details: details ?? null });
}

export async function insertDecision(db: DB, d: Decision, executed: string[], error: string | null): Promise<number | null> {
  const j = d.judgeResult;
  const rows = await db
    .insert(decisions)
    .values({
      guildId: d.input.guildId,
      channelId: d.input.channelId,
      channelName: d.input.channelName,
      messageId: d.input.messageId,
      authorId: d.input.authorId,
      authorTag: d.input.authorTag,
      content: d.input.content.slice(0, 2000),
      contentHash: d.contentHash,
      signals: d.signals,
      riskScore: d.riskScore,
      moderationFlagged: Boolean(d.moderation?.flagged),
      moderationScores: d.moderation?.scores ?? null,
      judged: d.judged,
      verdict: d.verdict,
      judgeModel: j?.model ?? null,
      judgeLatencyMs: j?.latencyMs ?? null,
      judgeInputTokens: j?.inputTokens ?? null,
      judgeOutputTokens: j?.outputTokens ?? null,
      ruleId: d.match?.rule.id ?? null,
      mode: d.match?.mode ?? null,
      plannedAction: d.match?.action ?? null,
      executed,
      error: [...d.errors, ...(error ? [error] : [])].join("; ") || null,
      sampled: d.sampled,
    })
    .onConflictDoNothing()
    .returning({ id: decisions.id });
  return rows[0]?.id ?? null;
}

export async function setSuggestedAnswer(db: DB, id: number, suggestedAnswer: SuggestedAnswer) {
  await db.update(decisions).set({ suggestedAnswer }).where(eq(decisions.id, id));
}

/** Record an action taken after the fact (e.g. a ban from the hub) on a decision. */
export async function appendExecuted(db: DB, id: number, item: string) {
  await db
    .update(decisions)
    .set({ executed: dsql`${decisions.executed} || ${JSON.stringify([item])}::jsonb` })
    .where(eq(decisions.id, id));
}

/** Command the hub sends the bot over NOTIFY mrmod_cmd. */
export type BotCommand = { type: "ban"; decisionId: number; actor: string; deleteMessageHours: number };

export async function sendBotCommand(db: DB, cmd: BotCommand) {
  await db.execute(dsql`SELECT pg_notify('mrmod_cmd', ${JSON.stringify(cmd)})`);
}

export function parseBotCommand(payload: string): BotCommand | null {
  try {
    const c = JSON.parse(payload) as Partial<BotCommand>;
    if (c.type === "ban" && Number.isInteger(c.decisionId) && typeof c.actor === "string") {
      return { type: "ban", decisionId: c.decisionId!, actor: c.actor.slice(0, 100), deleteMessageHours: Math.min(168, Math.max(0, Number(c.deleteMessageHours) || 0)) };
    }
  } catch {
    /* "recrawl" and other plain commands */
  }
  return null;
}

export async function setModlogMessage(db: DB, id: number, modlogMessageId: string) {
  await db.update(decisions).set({ modlogMessageId }).where(eq(decisions.id, id));
}

export async function labelDecision(db: DB, id: number, label: "correct" | "wrong" | "missed", actorId: string, actorName?: string) {
  await db.update(decisions).set({ label, labeledBy: actorId, labeledAt: new Date() }).where(eq(decisions.id, id));
  await audit(db, actorId, actorName, "decision.label", String(id), { label });
}

export async function getDecision(db: DB, id: number) {
  const rows = await db.select().from(decisions).where(eq(decisions.id, id)).limit(1);
  return rows[0] ?? null;
}

export async function getDecisionByMessage(db: DB, messageId: string) {
  const rows = await db.select().from(decisions).where(eq(decisions.messageId, messageId)).limit(1);
  return rows[0] ?? null;
}

export async function recentDecisions(db: DB, limit = 50) {
  return db.select().from(decisions).orderBy(desc(decisions.createdAt)).limit(limit);
}

/** Null out message text older than the retention period. */
export async function applyRetention(db: DB, days: number): Promise<number> {
  const cutoff = new Date(Date.now() - days * 86_400_000);
  const res = await db
    .update(decisions)
    .set({ content: null })
    .where(and(lt(decisions.createdAt, cutoff), isNotNull(decisions.content)))
    .returning({ id: decisions.id });
  return res.length;
}

export async function statsSince(db: DB, since: Date) {
  const rows = await db
    .select({
      total: dsql<number>`count(*)::int`,
      judged: dsql<number>`count(*) filter (where ${decisions.judged})::int`,
      matched: dsql<number>`count(*) filter (where ${decisions.ruleId} is not null)::int`,
      inputTokens: dsql<number>`coalesce(sum(${decisions.judgeInputTokens}),0)::int`,
      outputTokens: dsql<number>`coalesce(sum(${decisions.judgeOutputTokens}),0)::int`,
    })
    .from(decisions)
    .where(gte(decisions.createdAt, since));
  return rows[0]!;
}
