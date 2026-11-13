import { describe, expect, it } from "vitest";
import { collectLatestStarters, createReplayer, isConversationStarter, snowflakeAt, type HistorySource, parseBacktestCommand, summarizeBacktest, type HistoryMessage } from "../src/backtest.js";
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
    expect(parseBacktestCommand(JSON.stringify({ type: "backtest", count: 5000, actor: "x" }))).toEqual({ type: "backtest", count: 2000, from: null, to: null, actor: "x", tz: 0 });
    const r = parseBacktestCommand(JSON.stringify({ type: "backtest", count: 300, from: "2026-11-10T00:00:00Z", to: "2026-11-01T00:00:00Z", tz: -240 }));
    expect([r?.from, r?.to, r?.tz]).toEqual(["2026-11-01T00:00:00.000Z", "2026-11-10T00:00:00.000Z", -240]);
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

describe("collecting the latest starters across channels", () => {
  // Fake channel: messages oldest first; fetch(before) pages newest first, like Discord. Ids are minute numbers.
  function source(key: string, msgs: HistoryMessage[]): HistorySource<string> & { calls: number } {
    const src = {
      key,
      calls: 0,
      async fetch(before: string | undefined) {
        src.calls++;
        const cut = before === undefined ? Infinity : Number(before);
        return msgs.filter((m) => Number(m.id) < cut).sort((a, b) => Number(b.id) - Number(a.id)).slice(0, 100);
      },
    };
    return src;
  }
  const ts = (minute: number) => new Date(t0 + minute * MIN);
  const mk = (minute: number, author: string): HistoryMessage => ({ ...h(String(minute), author, 0), createdAt: ts(minute) });

  // Busy channel: a new author every 20 minutes for the last ~1000 minutes plus filler replies; quiet channel: one starter per day long ago.
  const busy: HistoryMessage[] = [];
  for (let m = 100_000; m < 101_000; m++) busy.push(mk(m, m % 20 === 0 ? `s${m}` : "chatter"));
  const quiet: HistoryMessage[] = [];
  for (let d = 0; d < 50; d++) quiet.push(mk(d * 1440 + 7, `q${d}`));

  it("takes the newest starters overall, not old ones from quiet channels", async () => {
    const res = await collectLatestStarters([source("busy", busy), source("quiet", quiet)], { count: 30 });
    expect(res.picked).toHaveLength(30);
    expect(res.picked.every((p) => p.key === "busy")).toBe(true);
    const mins = res.picked.map((p) => Number(p.message.id));
    expect(Math.min(...mins)).toBeGreaterThan(100_000);
    expect(mins).toEqual([...mins].sort((a, b) => b - a));
  });

  it("reads the busy channel further back when it needs more", async () => {
    const res = await collectLatestStarters([source("busy", busy), source("quiet", quiet)], { count: 60 });
    // the busy channel has ~50 starters (every 20 min over 1000 min; chatter isn't one), so quiet ones fill in by date
    expect(res.picked).toHaveLength(60);
    expect(res.picked.filter((p) => p.key === "quiet").length).toBeGreaterThan(0);
    const mins = res.picked.map((p) => Number(p.message.id));
    expect(mins).toEqual([...mins].sort((a, b) => b - a));
  });

  it("respects a date range", async () => {
    const res = await collectLatestStarters([source("busy", busy), source("quiet", quiet)], {
      count: 1000,
      from: ts(10 * 1440).getTime(),
      to: ts(20 * 1440).getTime(),
    });
    expect(res.picked.map((p) => p.message.authorId).sort()).toEqual(Array.from({ length: 10 }, (_, i) => `q${i + 10}`).sort());
  });

  it("snowflakes order like times", () => {
    expect(BigInt(snowflakeAt(Date.UTC(2026, 0, 2))) > BigInt(snowflakeAt(Date.UTC(2026, 0, 1)))).toBe(true);
  });
});
