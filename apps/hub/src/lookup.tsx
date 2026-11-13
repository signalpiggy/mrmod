// "Find by message link": was a Discord message logged, and if not, the likely reason.
import { BACKTEST_CHANNELS_KEY, getRuntime, schema, unseenChannels, type ChannelInfo, type DB } from "@mrmod/core";
import { and, count, eq, gte, lte } from "drizzle-orm";
import type { Hono } from "hono";
import { ago, Layout } from "./layout.js";

const { decisions } = schema;
const DISCORD_EPOCH = 1420070400000n;

/** Accepts a Discord message link or a bare message id. */
export function parseMessageLink(text: string): { guildId: string | null; channelId: string | null; messageId: string } | null {
  const t = text.trim();
  const m = /channels\/(\d{5,25}|@me)\/(\d{5,25})\/(\d{5,25})/.exec(t);
  if (m) return { guildId: m[1] === "@me" ? null : m[1]!, channelId: m[2]!, messageId: m[3]! };
  if (/^\d{5,25}$/.test(t)) return { guildId: null, channelId: null, messageId: t };
  return null;
}

export function snowflakeTime(id: string): Date {
  return new Date(Number((BigInt(id) >> 22n) + DISCORD_EPOCH));
}

/** How to let the bot see a channel. */
export function fixHint(c: ChannelInfo): string {
  if (c.note === "bot can't see this channel" && c.visibleTo?.length)
    return `Members with ${c.visibleTo.map((r) => `@${r}`).join(" or ")} can see it. Give the Mr Mod bot that role in Discord (Server Settings → Members), or allow View Channel for Mr Mod in this channel's permissions.`;
  if (c.note === "bot lacks Read Message History here") return "In this channel's permissions, allow Read Message History for the Mr Mod role.";
  return "In Discord, allow View Channel and Read Message History for the Mr Mod role in this channel's permissions (or give Mr Mod the Administrator permission).";
}

/** Banner listing channels the bot can't see (and so never moderates). */
export async function unseenBanner(db: DB) {
  const chans = (await getRuntime<{ channels: ChannelInfo[] }>(db, BACKTEST_CHANNELS_KEY))?.value.channels ?? [];
  const hidden = unseenChannels(chans).filter((c) => c.kind !== "thread");
  if (!hidden.length) return null;
  return (
    <details class="unseen">
      <summary>
        ⚠ Mr Mod can't see {hidden.length} channel{hidden.length === 1 ? "" : "s"}, so messages there are not moderated or logged. Show which and how to fix
      </summary>
      <ul>
        {hidden.map((c) => (
          <li>
            <b>#{c.name}</b>
            {c.parent ? <span class="hint"> in {c.parent}</span> : null}: {fixHint(c)}
          </li>
        ))}
      </ul>
    </details>
  );
}

export const UNSEEN_CSS = `.unseen{margin:12px 22px 0;padding:12px 16px;border-radius:14px;background:var(--sunbg);color:var(--sunink)}
.unseen summary{cursor:pointer;font-weight:700}
.unseen ul{margin:10px 0 0;padding-left:18px;display:grid;gap:6px;color:var(--ink)}`;

export function registerLookup(app: Hono<{ Variables: { actor: string } }>, db: DB) {
  app.get("/lookup", async (c) => {
    const link = c.req.query("link") ?? "";
    const parsed = parseMessageLink(link);
    const reasons: [string, string][] = [];
    let found: typeof decisions.$inferSelect | null = null;
    let sentAt: Date | null = null;
    let chan: ChannelInfo | undefined;

    if (parsed) {
      sentAt = snowflakeTime(parsed.messageId);
      found = (await db.select().from(decisions).where(eq(decisions.messageId, parsed.messageId)).limit(1))[0] ?? null;
      if (!found) {
        const near = 5 * 60_000;
        const [around] = await db
          .select({ n: count() })
          .from(decisions)
          .where(and(gte(decisions.createdAt, new Date(sentAt.getTime() - near)), lte(decisions.createdAt, new Date(sentAt.getTime() + near))));
        const [inChannel] = parsed.channelId ? await db.select({ n: count() }).from(decisions).where(eq(decisions.channelId, parsed.channelId)) : [{ n: -1 }];
        const chans = (await getRuntime<{ channels: ChannelInfo[] }>(db, BACKTEST_CHANNELS_KEY))?.value.channels ?? null;
        chan = parsed.channelId ? chans?.find((x) => x.id === parsed.channelId) : undefined;

        if (Date.now() - sentAt.getTime() < 60_000) reasons.push(["Just sent", "It was sent less than a minute ago. Give the AI judge a few seconds, then check again."]);
        if (parsed.channelId && chans && !chan)
          reasons.push(["The bot can't see this channel", "It isn't in the list of channels the bot can see. In Discord, give the Mr Mod role View Channel there (or it's a closed thread)."]);
        if (chan?.note) reasons.push([`Channel: ${chan.note}`, chan.readable ? "Messages here are skipped by design." : fixHint(chan)]);
        if (inChannel && inChannel.n === 0)
          reasons.push(["Nothing from this channel has ever been logged", "That almost always means the bot can't see the channel: check View Channel for the Mr Mod role there."]);
        if (around && around.n === 0)
          reasons.push(["Nothing at all was logged within 5 minutes of it", "The bot was probably offline or restarting then (for example during a deploy). Messages sent while it's down are never seen."]);
        reasons.push([
          "Or it wasn't something the bot checks",
          "Bot and webhook messages, and messages with no text (an image or sticker only), are skipped. Members with an exempt role are skipped too.",
        ]);
      }
    }

    return c.html(
      <Layout title="Find a message" path="/decisions">
        <h1>Find a message</h1>
        <form method="get" action="/lookup" class="card">
          <label for="lk">Discord message link</label>
          <div class="row" style="flex-wrap:nowrap">
            <input id="lk" name="link" value={link} placeholder="https://discord.com/channels/…/…/…" autofocus />
            <button>Check</button>
          </div>
          <p class="hint">In Discord: right-click the message → Copy Message Link.</p>
        </form>
        {link && !parsed && (
          <div class="card">
            <p class="badc">That doesn't look like a Discord message link.</p>
          </div>
        )}
        {found && (
          <div class="card">
            <span class="lbl">Logged</span>
            <p>
              Logged as message #{found.id} from <b>{found.authorTag ?? found.authorId}</b> in #{found.channelName ?? "channel"}, {ago(found.createdAt)}.
            </p>
            <p>
              <a class="btn small" href={`/decisions?id=${found.id}`}>
                Open it in the Message log
              </a>
            </p>
          </div>
        )}
        {parsed && !found && (
          <div class="card">
            <span class="lbl">Not logged</span>
            <p>
              This message (sent {sentAt ? ago(sentAt) : "?"}
              {chan ? ` in #${chan.name}` : ""}) isn't in the log. Likely reasons, most likely first:
            </p>
            <div class="tq-steps" style="display:grid;gap:12px">
              {reasons.map(([t, d]) => (
                <div>
                  <b>{t}</b>
                  <p class="hint">{d}</p>
                </div>
              ))}
            </div>
          </div>
        )}
      </Layout>,
    );
  });
}
