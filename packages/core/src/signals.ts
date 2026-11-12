import type { MessageInput, Signals } from "./types.js";

const DAY = 86_400_000;

const URL_RE = /\bhttps?:\/\/[^\s<>()]+|\bwww\.[^\s<>()]+/gi;
const BARE_DOMAIN_RE =
  /\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:com|net|org|io|app|xyz|site|online|live|top|info|me|co|gg|ly|link|support|help|fi|finance|dev|page|cc|tk|ru|cn|ai|pro|biz|club|vip|shop|store|tech|cloud|digital|network|services|center|desk|chat)\b(?:\/[^\s<>()]*)?/gi;
const INVITE_RE = /\b(?:discord(?:app)?\.(?:gg|com\/invite)|dsc\.gg)\/[a-z0-9-]+/i;

/** Hiding links in markdown like [click](https://...) or <https://...> is common in scams. */
export function extractDomains(text: string): { links: string[]; domains: string[] } {
  const found = new Set<string>();
  for (const m of text.matchAll(URL_RE)) found.add(m[0]);
  for (const m of text.matchAll(BARE_DOMAIN_RE)) {
    const s = m[0];
    // skip if already part of a scheme URL we captured
    if (![...found].some((u) => u.includes(s))) found.add(s);
  }
  const domains = new Set<string>();
  for (const link of found) {
    try {
      const u = new URL(link.startsWith("http") ? link : `https://${link}`);
      domains.add(u.hostname.toLowerCase().replace(/^www\./, ""));
    } catch {
      /* not a URL */
    }
  }
  return { links: [...found], domains: [...domains] };
}

/**
 * Support-impersonation scam patterns (Ben's rule: delete any message directing users to open a
 * support ticket at a link, or asking users to DM for support).
 * "strong" = pattern alone is very likely a scam; "matched" = worth sending to the judge.
 */
export function detectSupportScam(text: string, hasLink: boolean): Signals["supportScam"] {
  const t = text.toLowerCase().replace(/\s+/g, " ");
  const patterns: string[] = [];
  let strong = false;

  const ticketAsk =
    /\b(open|create|raise|submit|file|make|start|log)\b[^.!?\n]{0,30}\btickets?\b/.test(t) ||
    /\b(support|help ?desk|helpdesk|service) tickets?\b/.test(t) ||
    /\bticket (here|below|at|via|through|using|on)\b/.test(t);
  if (ticketAsk) {
    patterns.push("ticket");
    if (hasLink) {
      patterns.push("ticket+link");
      strong = true;
    }
  }

  const dmAsk =
    /\b(dm|pm|inbox|direct message|private message|message)\s+(me|us|him|her|them|the admin|an admin|a mod|the team|support)\b/.test(t) ||
    /\b(send|shoot|drop)\s+(me|us)\s+(a|an)\s+(dm|pm|direct message|private message|message)\b/.test(t) ||
    /\b(check|see) (your|ur) (dm|dms|inbox|direct messages)\b/.test(t) ||
    /\b(sent|send) (you|u) (a )?(dm|pm|direct message|friend request)\b/.test(t) ||
    /\bdm (for|4) (help|support|assistance)\b/.test(t);
  const helpContext = /\b(help|support|assist|assistance|issue|problem|resolve|fix|recover|stuck|refund|team)\b/.test(t);
  if (dmAsk) {
    patterns.push("dm");
    if (helpContext) {
      patterns.push("dm+support");
      strong = true;
    }
  }

  const contactSupport =
    /\b(contact|reach|reach out to|chat with|talk to|speak to|write to)\b[^.!?\n]{0,25}\b(support|help ?desk|helpdesk|admins?|team|live agent|customer (care|service))\b/.test(t) ||
    /\b(live (support|chat|agent)|customer (care|service)|support (team|portal|center|centre|desk|link|page))\b/.test(t);
  if (contactSupport) {
    patterns.push("contact-support");
    if (hasLink) {
      patterns.push("contact-support+link");
      strong = true;
    }
  }

  return { matched: patterns.length > 0, strong, patterns };
}

const INJECTION_RE =
  /\b(ignore|disregard|forget)\b[^.!?\n]{0,30}\b(previous|prior|above|earlier|all|your)\b[^.!?\n]{0,20}\b(instructions?|rules|prompt|guidelines)\b|\bsystem prompt\b|\byou are (now )?(an? )?(ai|assistant|moderator|bot|language model)\b|\b(classify|mark|label|rate) (this|me|my message) as\b|\b"?verdict"?\s*[:=]/i;

export function computeSignals(input: MessageInput, duplicateChannels: number, now = new Date()): Signals {
  const { links, domains } = extractDomains(input.content);
  const hasInvite = INVITE_RE.test(input.content);
  return {
    accountAgeDays: (now.getTime() - input.accountCreatedAt.getTime()) / DAY,
    memberAgeDays: input.memberJoinedAt ? (now.getTime() - input.memberJoinedAt.getTime()) / DAY : null,
    roleCount: input.memberRoleIds.filter((r) => r !== input.guildId).length,
    linkCount: links.length,
    domains,
    hasInvite,
    mentionCount: input.mentionCount,
    mentionsEveryone: input.mentionsEveryone,
    duplicateChannels,
    supportScam: detectSupportScam(input.content, links.length > 0 || hasInvite),
    injectionAttempt: INJECTION_RE.test(input.content),
  };
}

export function riskScore(s: Signals): number {
  let score = 0;
  if (s.supportScam.strong) score += 2;
  else if (s.supportScam.matched) score += 1;
  if (s.hasInvite) score += 1;
  if (s.linkCount > 0) score += 0.5;
  if (s.linkCount > 0 && s.memberAgeDays !== null && s.memberAgeDays < 7) score += 1;
  if (s.accountAgeDays < 7) score += 1;
  if (s.mentionsEveryone) score += 2;
  if (s.mentionCount >= 5) score += 2;
  if (s.duplicateChannels >= 2) score += 2;
  if (s.injectionAttempt) score += 2;
  return score;
}
