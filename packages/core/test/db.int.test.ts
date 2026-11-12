import { cosineDistance } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import {
  applyRetention,
  connect,
  insertDecision,
  labelDecision,
  loadRules,
  loadSettings,
  runMigrations,
  saveSetting,
  seedRules,
  statsSince,
} from "../src/index.js";
import { kbChunks, kbPages } from "../src/db/schema.js";
import { DuplicateTracker, runPipeline, VerdictCache } from "../src/pipeline.js";

/** Needs Postgres with pgvector: set TEST_DATABASE_URL (CI does). */
const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("database", () => {
  const { db, sql } = connect(url);
  afterAll(() => sql.end());

  it("migrates, seeds once, stores settings, decisions and vectors", async () => {
    await runMigrations(db, sql);
    const first = await seedRules(db);
    expect(await seedRules(db)).toBe(0);
    expect(first).toBeGreaterThanOrEqual(0);

    await saveSetting(db, "riskThreshold", 2, "tester");
    const settings = await loadSettings(db);
    expect(settings.riskThreshold).toBe(2);

    const rules = await loadRules(db);
    const d = await runPipeline(
      {
        guildId: "g",
        channelId: "c",
        channelName: "general",
        messageId: `m-${Date.now()}`,
        authorId: "u",
        authorTag: "t",
        authorIsBot: false,
        content: "DM me for support",
        accountCreatedAt: new Date(Date.now() - 1e10),
        memberJoinedAt: new Date(),
        memberRoleIds: [],
        mentionCount: 0,
        mentionsEveryone: false,
        recentAuthorMessages: [],
      },
      {
        settings,
        rules,
        duplicates: new DuplicateTracker(),
        verdicts: new VerdictCache(),
        moderate: async () => ({ flagged: false, scores: {} }),
        judge: async () => ({
          verdict: { verdict: "support_scam", confidence: 0.9, rule_broken: "R1", reason: "r", source: "llm" },
          model: "m",
          latencyMs: 5,
          inputTokens: 100,
          outputTokens: 20,
        }),
      },
    );
    const id = await insertDecision(db, d!, [], null);
    expect(id).not.toBeNull();
    expect(await insertDecision(db, d!, [], null)).toBeNull(); // idempotent per message
    await labelDecision(db, id!, "correct", "tester");
    const st = await statsSince(db, new Date(Date.now() - 60_000));
    expect(st.matched).toBeGreaterThanOrEqual(1);

    await db.insert(kbPages).values({ url: "u-test", title: "t", contentHash: "h", chunkCount: 1 }).onConflictDoNothing();
    await db.insert(kbChunks).values({ url: "u-test", title: "t", ordinal: 0, content: "c", embedding: Array(1536).fill(0.01) });
    const dist = cosineDistance(kbChunks.embedding, Array(1536).fill(0.01));
    const hit = await db.select({ u: kbChunks.url }).from(kbChunks).orderBy(dist).limit(1);
    expect(hit[0]?.u).toBe("u-test");

    expect(await applyRetention(db, 0)).toBeGreaterThanOrEqual(1);
  });
});
