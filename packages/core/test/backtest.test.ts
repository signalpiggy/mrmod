import { describe, expect, it } from "vitest";
import { createReplayer, isConversationStarter, parseBacktestCommand, summarizeBacktest, type HistoryMessage } from "../src/backtest.js";
import { defaultSettings } from "../src/config.js";
import type { DB } from "../src/db/client.js";
import { DEFAULT_RULES } from "../src/policy.js";
import type { JudgeVerdict, MessageInput } from "../src/types.js";

const MIN = 60_000;
const DAY = 86_400_000;
const t0 = new Date("2026-11-10T12:00:00Z").getTime();

function h(id: string, authorId: string, minute: number, over: Partial<HistoryMessage> = {}): HistoryMessage {
  return { id, authorId, authorIsBot: false, createdAt: new Date(t0 + minute * MIN), replyToId: null, replyToAuthorId: null, mentionedUserIds: [], content: "x", ...over };
}

describe("conversation starters", () => {
  it("first message after a quiet spell is a starter", () => {
    const m = h("3", "a", 30);
    expect(isConversationStarter(m, [h("1", "a", 0), h("2", "b", 25), m]).starter).toBe(true);
  });
  it("Discord replies are not starters", () => {
    expect(isConversationStarter(h("2", "a", 30, { replyToId: "1" }), []).starter).toBe(false);
  });
  it("a follow-up within 10 minutes is not a starter", () => {
    expect(isConversationStarter(h("2", "a", 8), [h("1", "a", 0)])).toEqual({ starter: false, why: "follow-up" });
  });
  it("answering someone who addressed you is not a starter", () => {
    expect(isConversationStarter(h("2", "a", 5), [h("1", "b", 2, { mentionedUserIds: ["a"] })]).starter).toBe(false);
    expect(isConversationStarter(h("2", "a", 5), [h("1", "b", 2, { replyToId: "0", replyToAuthorId: "a" })]).starter).toBe(false);
  });
  it("later messages don't count against an earlier one", () => {
    expect(isConversationStarter(h("1", "a", 0), [h("2", "a", 3)]).starter).toBe(true);
  });
});

describe("backtest command", () => {
  it("parses and clamps", () => {
    expect(parseBacktestCommand(JSON.stringify({ type: "backtest", count: 5000, actor: "x" }))).toEqual({ type: "backtest", count: 1000, actor: "x" });
    expect(parseBacktestCommand(JSON.stringify({ type: "ban", decisionId: 1 }))).toBeNull();
    expect(parseBacktestCommand("recrawl")).toBeNull();
  });
});

describe("replay (dry run)", () => {
  const sentAt = new Date(Date.now() - 30 * DAY);
  const input = (content: string, over: Partial<MessageInput> = {}): MessageInput => ({
    guildId: "g",
    channelId: "c1",
    channelName: "general",
    messageId: String(Math.random()),
    authorId: "u1",
    authorTag: "user",
    authorIsBot: false,
    content,
    // account made 2 days before the message was sent, i.e. 32 days ago
    accountCreatedAt: new Date(sentAt.getTime() - 2 * DAY),
    memberJoinedAt: new Date(sentAt.getTime() - 1 * DAY),
    memberRoleIds: [],
    mentionCount: 0,
    mentionsEveryone: false,
    recentAuthorMessages: [],
    ...over,
  });
  const verdict = (v: Partial<JudgeVerdict>): JudgeVerdict => ({ verdict: "ok", confidence: 0.9, rule_broken: null, reason: "r", ...v });
  const replayer = (v: Partial<JudgeVerdict>) =>
    createReplayer({
      db: {} as DB,
      settings: defaultSettings,
      rules: DEFAULT_RULES,
      moderate: async () => ({ flagged: false, scores: {} }),
      judge: async () => ({ verdict: verdict(v), model: "m", latencyMs: 1, inputTokens: 1, outputTokens: 1 }),
      answer: async () => ({ answerable: true, text: "Do X.\n🔗 <https://support.nu.fi/a>", sources: [{ url: "https://support.nu.fi/a", title: "A" }] }),
    });

  it("reports the matching rule and its planned action, ages as of when it was sent", async () => {
    const r = await replayer({ verdict: "support_scam", confidence: 0.95 })(input("open a ticket at nufi-help.app"), sentAt);
    expect(r.outcome).toBe("act");
    expect(r.ruleId).toBe("support-scam");
    expect(r.plannedAction?.delete).toBe(true);
    expect(Math.round(r.signals!.accountAgeDays)).toBe(2);
  });

  it("drafts an answer for questions", async () => {
    const r = await replayer({ is_question: true })(input("How do I connect my Ledger?"), sentAt);
    expect(r.outcome).toBe("answer");
    expect(r.suggestedAnswer?.answerable).toBe(true);
  });

  it("allows ordinary chat", async () => {
    const r = await replayer({})(input("gm everyone"), sentAt);
    expect(r.outcome).toBe("allow");
    expect(summarizeBacktest([r]).allow).toBe(1);
  });
});
