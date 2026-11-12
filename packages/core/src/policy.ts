import type { ActionPlan, JudgeVerdict, RuleMode, RuleRow, Signals } from "./types.js";

export interface PolicyInput {
  signals: Signals;
  moderationFlagged: boolean;
  verdict: JudgeVerdict | null;
}

export interface PolicyMatch {
  rule: RuleRow;
  action: ActionPlan;
  /** Effective mode after the global switch. */
  mode: RuleMode;
}

export function ruleMatches(rule: RuleRow, p: PolicyInput): boolean {
  const d = rule.definition;
  if (d.verdicts) {
    if (!p.verdict || !d.verdicts.includes(p.verdict.verdict)) return false;
  }
  if (d.minConfidence !== undefined && (!p.verdict || p.verdict.confidence < d.minConfidence)) return false;
  if (d.maxAccountAgeDays !== undefined && p.signals.accountAgeDays > d.maxAccountAgeDays) return false;
  if (d.maxMemberAgeDays !== undefined) {
    if (p.signals.memberAgeDays === null || p.signals.memberAgeDays > d.maxMemberAgeDays) return false;
  }
  if (d.minDuplicateChannels !== undefined && p.signals.duplicateChannels < d.minDuplicateChannels) return false;
  if (d.moderationFlagged !== undefined && p.moderationFlagged !== d.moderationFlagged) return false;
  return true;
}

/** First matching rule by priority (lowest number first) that isn't off. */
export function evaluatePolicy(rules: RuleRow[], p: PolicyInput, globalMode: "shadow" | "enforce"): PolicyMatch | null {
  const sorted = [...rules].filter((r) => r.mode !== "off").sort((a, b) => a.priority - b.priority);
  for (const rule of sorted) {
    if (ruleMatches(rule, p)) {
      const mode: RuleMode = globalMode === "shadow" ? "shadow" : rule.mode;
      return { rule, action: rule.definition.action, mode };
    }
  }
  return null;
}

const A = (delete_: boolean, timeoutMinutes: number, alert: boolean, recommendBan = false): ActionPlan => ({
  delete: delete_,
  timeoutMinutes,
  alert,
  recommendBan,
});

/** Starter rules, seeded on first run. All start in shadow mode. */
export const DEFAULT_RULES: RuleRow[] = [
  {
    id: "support-scam",
    name: "Support scam (ticket link or DM for support)",
    description: "Delete any message directing users to open a support ticket at a link or asking them to DM for support.",
    mode: "shadow",
    priority: 10,
    definition: { verdicts: ["support_scam"], minConfidence: 0.6, action: A(true, 0, true) },
  },
  {
    id: "cross-channel-flood",
    name: "Same message in 3+ channels",
    description: "Classic raid/spam pattern; works without the AI judge.",
    mode: "shadow",
    priority: 20,
    definition: { minDuplicateChannels: 3, action: A(true, 60, true) },
  },
  {
    id: "scam-new-account",
    name: "Scam from a new member",
    description: "Scam verdict from someone who joined in the last 14 days.",
    mode: "shadow",
    priority: 30,
    definition: { verdicts: ["scam"], minConfidence: 0.8, maxMemberAgeDays: 14, action: A(true, 1440, true, true) },
  },
  {
    id: "scam",
    name: "Scam or phishing",
    description: "Scam verdict from an established member: delete and ask admins.",
    mode: "shadow",
    priority: 40,
    definition: { verdicts: ["scam"], minConfidence: 0.8, action: A(true, 0, true) },
  },
  {
    id: "spam",
    name: "Spam / advertising",
    description: "Delete and a short timeout.",
    mode: "shadow",
    priority: 50,
    definition: { verdicts: ["spam"], minConfidence: 0.85, action: A(true, 10, false) },
  },
  {
    id: "harmful",
    name: "Harassment or NSFW",
    description: "Model and moderation endpoint agree; delete and alert.",
    mode: "shadow",
    priority: 60,
    definition: { verdicts: ["harassment", "nsfw"], minConfidence: 0.8, action: A(true, 0, true) },
  },
  {
    id: "review",
    name: "Anything else suspicious (log only)",
    description: "Lower-confidence violations go to the mod log for a human look.",
    mode: "shadow",
    priority: 900,
    definition: {
      verdicts: ["support_scam", "scam", "spam", "harassment", "nsfw", "other_violation"],
      minConfidence: 0.5,
      action: A(false, 0, false),
    },
  },
];
