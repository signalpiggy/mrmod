import {
  bigserial,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
  vector,
} from "drizzle-orm/pg-core";
import type { ActionPlan, JudgeVerdict, Signals, PolicyRule, RuleMode, SuggestedAnswer } from "../types.js";

/** Key/value settings edited from the hub. Values are validated by settingsSchema in config.ts. */
export const settings = pgTable("settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  updatedBy: text("updated_by"),
});

/** Policy rules: verdict/confidence/user conditions -> action, each with its own mode. */
export const rules = pgTable("rules", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  mode: text("mode").$type<RuleMode>().notNull().default("shadow"),
  priority: integer("priority").notNull().default(100),
  definition: jsonb("definition").$type<PolicyRule>().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** One row per message the pipeline evaluated past the skip list. */
export const decisions = pgTable(
  "decisions",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    guildId: text("guild_id").notNull(),
    channelId: text("channel_id").notNull(),
    channelName: text("channel_name"),
    messageId: text("message_id").notNull(),
    authorId: text("author_id").notNull(),
    authorTag: text("author_tag"),
    /** Trimmed message text; nulled by the retention job. */
    content: text("content"),
    contentHash: text("content_hash").notNull(),
    signals: jsonb("signals").$type<Signals>().notNull(),
    riskScore: real("risk_score").notNull(),
    moderationFlagged: boolean("moderation_flagged").notNull().default(false),
    moderationScores: jsonb("moderation_scores").$type<Record<string, number>>(),
    judged: boolean("judged").notNull().default(false),
    verdict: jsonb("verdict").$type<JudgeVerdict>(),
    judgeModel: text("judge_model"),
    judgeLatencyMs: integer("judge_latency_ms"),
    judgeInputTokens: integer("judge_input_tokens"),
    judgeOutputTokens: integer("judge_output_tokens"),
    ruleId: text("rule_id"),
    mode: text("mode").$type<RuleMode>(),
    plannedAction: jsonb("planned_action").$type<ActionPlan>(),
    /** What actually happened in Discord (empty in shadow). */
    executed: jsonb("executed").$type<string[]>().notNull().default([]),
    error: text("error"),
    /** correct | wrong | missed, set by reviewers. */
    label: text("label"),
    labeledBy: text("labeled_by"),
    labeledAt: timestamp("labeled_at", { withTimezone: true }),
    /** Random sample of allowed messages for catching misses. */
    sampled: boolean("sampled").notNull().default(false),
    /** Shadow-mode draft answer for questions: what the bot would have replied. */
    suggestedAnswer: jsonb("suggested_answer").$type<SuggestedAnswer>(),
    modlogMessageId: text("modlog_message_id"),
  },
  (t) => [
    index("decisions_created_idx").on(t.createdAt),
    index("decisions_author_idx").on(t.authorId, t.createdAt),
    index("decisions_hash_idx").on(t.contentHash, t.createdAt),
    uniqueIndex("decisions_message_idx").on(t.messageId),
  ],
);

/** Every settings change and moderator button press. */
export const auditLog = pgTable("audit_log", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  actorId: text("actor_id").notNull(),
  actorName: text("actor_name"),
  action: text("action").notNull(),
  target: text("target"),
  details: jsonb("details"),
});

/** Knowledge base pages (support.nu.fi articles). */
export const kbPages = pgTable("kb_pages", {
  url: text("url").primaryKey(),
  title: text("title").notNull(),
  contentHash: text("content_hash").notNull(),
  fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
  chunkCount: integer("chunk_count").notNull().default(0),
});

export const kbChunks = pgTable(
  "kb_chunks",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    url: text("url")
      .notNull()
      .references(() => kbPages.url, { onDelete: "cascade" }),
    title: text("title").notNull(),
    ordinal: integer("ordinal").notNull(),
    content: text("content").notNull(),
    embedding: vector("embedding", { dimensions: 1536 }).notNull(),
  },
  (t) => [index("kb_chunks_embedding_idx").using("hnsw", t.embedding.op("vector_cosine_ops"))],
);

/** Questions answered by the bot, for review in the hub. */
export const qaLog = pgTable("qa_log", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  userId: text("user_id").notNull(),
  channelId: text("channel_id").notNull(),
  question: text("question").notNull(),
  answer: text("answer"),
  answerable: boolean("answerable").notNull(),
  sources: jsonb("sources").$type<string[]>().notNull().default([]),
  latencyMs: integer("latency_ms"),
});

/** Credentials entered in the hub (Discord token, OpenAI key). Values are AES-256-GCM encrypted with SECRETS_KEY from the VPS .env. */
export const secrets = pgTable("secrets", {
  key: text("key").primaryKey(),
  ciphertext: text("ciphertext").notNull(),
  /** Last 4 characters, so the hub can show which key is set without revealing it. */
  hint: text("hint").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  updatedBy: text("updated_by"),
});

/** Small runtime values: bot heartbeat, hub admin password hash, setup code. */
export const runtime = pgTable("runtime", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
