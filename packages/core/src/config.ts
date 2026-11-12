import { z } from "zod";

export const settingsSchema = z.object({
  /** "shadow" forces every rule to shadow regardless of its own mode. "enforce" honours per-rule modes. */
  globalMode: z.enum(["shadow", "enforce"]).default("shadow"),
  judgeModel: z.string().default("gpt-5.4-mini"),
  answerModel: z.string().default("gpt-5.4-mini"),
  moderationModel: z.string().default("omni-moderation-latest"),
  embeddingModel: z.string().default("text-embedding-3-small"),
  /** Risk score at or above which the LLM judge runs. */
  riskThreshold: z.number().default(1),
  /** Always judge members who joined less than this many days ago. 0 disables. */
  judgeNewMembersDays: z.number().default(7),
  /** Judge every message from non-exempt members (costs more, catches more). On while testing. */
  judgeAll: z.boolean().default(true),
  /** Record every message (and post each to the mod log), not just suspicious ones. On while testing. */
  logAllMessages: z.boolean().default(true),
  exemptRoleIds: z.array(z.string()).default([]),
  exemptChannelIds: z.array(z.string()).default([]),
  /** Members with these roles are only judged if a signal fires. */
  trustedRoleIds: z.array(z.string()).default([]),
  modlogChannelId: z.string().nullable().default(null),
  alertChannelId: z.string().nullable().default(null),
  alertRoleId: z.string().nullable().default(null),
  /** Channels where @mention questions are answered; empty = everywhere. /ask works everywhere. */
  qaChannelIds: z.array(z.string()).default([]),
  /** Share of allowed (unflagged) messages logged for review, to catch misses. */
  sampleRate: z.number().min(0).max(1).default(0.02),
  retentionDays: z.number().default(30),
  /** Server rules the judge cites. */
  serverRules: z
    .string()
    .default(
      [
        "R1 No support scams: never direct people to open a support ticket at a link, and never ask people to DM for support. Official support is only through the team.",
        "R2 No spam, advertising, or unsolicited promotion.",
        "R3 No scams, phishing, fake giveaways, or requests for seed phrases or private keys.",
        "R4 Be respectful: no harassment, hate, or threats.",
        "R5 No NSFW content.",
      ].join("\n"),
    ),
  kbStartUrls: z.array(z.string()).default(["https://support.nu.fi/support/solutions"]),
  kbAllowedHosts: z.array(z.string()).default(["support.nu.fi"]),
  crawlIntervalHours: z.number().default(24),
});

export type Settings = z.infer<typeof settingsSchema>;

export const defaultSettings: Settings = settingsSchema.parse({});

export function parseSettings(rows: { key: string; value: unknown }[]): Settings {
  const raw: Record<string, unknown> = {};
  for (const r of rows) raw[r.key] = r.value;
  const parsed = settingsSchema.safeParse(raw);
  if (parsed.success) return parsed.data;
  // Bad value in one key should not take the bot down: drop invalid keys and use defaults for them.
  const ok: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    const field = (settingsSchema.shape as Record<string, z.ZodTypeAny>)[k];
    if (field && field.safeParse(v).success) ok[k] = v;
  }
  return settingsSchema.parse(ok);
}
