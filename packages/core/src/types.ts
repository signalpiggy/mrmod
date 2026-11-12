export type RuleMode = "off" | "shadow" | "enforce";

export const VERDICTS = [
  "ok",
  "support_scam",
  "scam",
  "spam",
  "harassment",
  "nsfw",
  "other_violation",
] as const;
export type Verdict = (typeof VERDICTS)[number];

export interface JudgeVerdict {
  verdict: Verdict;
  confidence: number;
  rule_broken: string | null;
  reason: string;
  /** "llm" when the model judged it, "heuristic" when we fell back to patterns. */
  source?: "llm" | "heuristic";
}

export interface Signals {
  accountAgeDays: number;
  /** Days since the author joined this server; null if unknown. */
  memberAgeDays: number | null;
  /** Number of roles the member has besides @everyone. */
  roleCount: number;
  linkCount: number;
  domains: string[];
  hasInvite: boolean;
  mentionCount: number;
  mentionsEveryone: boolean;
  /** Distinct channels where the same text was posted by this author in the last 10 minutes (including this one). */
  duplicateChannels: number;
  supportScam: { matched: boolean; strong: boolean; patterns: string[] };
  injectionAttempt: boolean;
}

export interface ActionPlan {
  delete: boolean;
  /** 0 = no timeout. */
  timeoutMinutes: number;
  /** Ping the alert role in the alert channel. */
  alert: boolean;
  /** Show a Ban button on the alert; bans are never automatic. */
  recommendBan: boolean;
}

export interface PolicyRule {
  /** Matches if the verdict is one of these. Omit to ignore the verdict. */
  verdicts?: Verdict[];
  minConfidence?: number;
  /** Signal conditions; all given ones must hold. */
  maxAccountAgeDays?: number;
  maxMemberAgeDays?: number;
  minDuplicateChannels?: number;
  moderationFlagged?: boolean;
  action: ActionPlan;
}

export interface RuleRow {
  id: string;
  name: string;
  description: string;
  mode: RuleMode;
  priority: number;
  definition: PolicyRule;
}

/** What the pipeline needs to know about a message; built from discord.js objects by the bot. */
export interface MessageInput {
  guildId: string;
  channelId: string;
  channelName: string | null;
  messageId: string;
  authorId: string;
  authorTag: string;
  authorIsBot: boolean;
  content: string;
  accountCreatedAt: Date;
  memberJoinedAt: Date | null;
  memberRoleIds: string[];
  mentionCount: number;
  mentionsEveryone: boolean;
  /** Up to 3 previous messages from this author in this channel, oldest first. */
  recentAuthorMessages: string[];
}
