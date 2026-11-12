import {
  audit,
  getDecision,
  getRuntime,
  loadRules,
  loadSecrets,
  loadSettings,
  notifyConfigChanged,
  saveSetting,
  schema,
  secretStatus,
  sendBotCommand,
  SECRET_KEYS,
  setSecret,
  settingsSchema,
  statsSince,
  VERDICTS,
  type DB,
  type RuleMode,
  type SecretKey,
  type Settings,
} from "@mrmod/core";
import { and, count, desc, eq, isNotNull, isNull, sql as dsql } from "drizzle-orm";
import { Hono, type Context } from "hono";
import { deleteCookie, getSignedCookie, setSignedCookie } from "hono/cookie";
import { checkPassword, checkSetupCode, getAdmin, setPassword, tooManyAttempts, validPassword } from "./auth.js";
import { ago, FONTS, Layout, ModePill, SuggestedAnswerBox } from "./layout.js";
import { kindOf, LOG_CSS, LOG_JS, prettyVerdict, TABS } from "./logview.js";

const { decisions, rules, auditLog, kbPages, kbChunks, qaLog } = schema;

type Env = { Variables: { actor: string } };

const COOKIE = "mrmod_session";
const SESSION_HOURS = 12;
const PERMISSIONS = "1099511720966";

/** Host part of an Origin header; null for "null" or anything unparsable (treated as cross-site). */
export function originHost(origin: string): string | null {
  try {
    return new URL(origin).host;
  } catch {
    return null;
  }
}

function ip(c: Context): string {
  return c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || c.req.header("x-real-ip") || "local";
}

export function createApp(db: DB, sessionSecret: string, opts: { secureCookies: boolean }) {
  const app = new Hono<Env>();

  // CSRF: browsers send Origin on POST; it must match our host. Cookies are also SameSite=Strict.
  app.use("*", async (c, next) => {
    if (c.req.method === "POST") {
      const origin = c.req.header("origin");
      const host = c.req.header("x-forwarded-host") ?? c.req.header("host");
      if (origin && host && originHost(origin) !== host) return c.text("Cross-site request blocked", 403);
    }
    c.header("X-Frame-Options", "DENY");
    c.header("X-Content-Type-Options", "nosniff");
    // "no-referrer" makes browsers send `Origin: null` on form posts, which breaks the check above.
    c.header("Referrer-Policy", "same-origin");
    c.header("Cache-Control", "no-store");
    await next();
  });

  app.onError((err, c) => {
    console.error(`${c.req.method} ${c.req.path} failed:`, err);
    return c.text("Something went wrong; it has been logged on the server.", 500);
  });

  app.get("/healthz", (c) => c.text("ok"));
  app.get("/fonts/:file", (c) => {
    const f = FONTS[c.req.param("file")];
    if (!f) return c.notFound();
    return c.body(new Uint8Array(f), 200, { "Content-Type": "font/woff2", "Cache-Control": "public, max-age=31536000, immutable" });
  });

  // ---------- setup & login ----------
  app.get("/setup", async (c) => {
    if (await getAdmin(db)) return c.redirect("/login");
    return c.html(
      <Layout title="Set up" authed={false}>
        <form method="post" class="card">
          <h1>Set up the hub</h1>
          <p class="hint">Enter the one-time setup code (Claude will send it to you) and choose the admin password.</p>
          <div class="field">
            <label for="code">Setup code</label>
            <input id="code" name="code" autocomplete="off" required />
          </div>
          <div class="field">
            <label for="password">Admin password</label>
            <input id="password" name="password" type="password" autocomplete="new-password" minlength={12} required />
            <div class="hint">At least 12 characters. Store it in your password manager.</div>
          </div>
          <button class="danger">Save password</button>
        </form>
      </Layout>,
    );
  });

  app.post("/setup", async (c) => {
    if (await getAdmin(db)) return c.redirect("/login");
    if (tooManyAttempts(ip(c))) return c.text("Too many attempts; wait 15 minutes.", 429);
    const body = await c.req.parseBody();
    const code = String(body.code ?? "");
    const pw = String(body.password ?? "");
    if (!(await checkSetupCode(db, code))) return c.html(<Layout title="Set up" authed={false} flash="That setup code is wrong." />, 400);
    const err = validPassword(pw);
    if (err) return c.html(<Layout title="Set up" authed={false} flash={err} />, 400);
    const admin = await setPassword(db, pw);
    await audit(db, "admin", "admin", "hub.setup", undefined, { ip: ip(c) });
    await startSession(c, admin.version);
    return c.redirect("/connection");
  });

  app.get("/login", async (c) => {
    if (!(await getAdmin(db))) return c.redirect("/setup");
    return c.html(
      <Layout title="Sign in" authed={false}>
        <form method="post" class="card">
          <h1>Sign in</h1>
          <div class="field">
            <label for="password">Password</label>
            <input id="password" name="password" type="password" autocomplete="current-password" required autofocus />
          </div>
          <button class="danger">Sign in</button>
        </form>
      </Layout>,
    );
  });

  app.post("/login", async (c) => {
    const admin = await getAdmin(db);
    if (!admin) return c.redirect("/setup");
    if (tooManyAttempts(ip(c))) return c.text("Too many attempts; wait 15 minutes.", 429);
    const pw = String((await c.req.parseBody()).password ?? "");
    if (!(await checkPassword(admin, pw))) {
      await audit(db, "unknown", undefined, "hub.login_failed", undefined, { ip: ip(c) });
      return c.html(<Layout title="Sign in" authed={false} flash="Wrong password." />, 401);
    }
    await audit(db, "admin", "admin", "hub.login", undefined, { ip: ip(c) });
    await startSession(c, admin.version);
    return c.redirect("/");
  });

  app.post("/logout", (c) => {
    deleteCookie(c, COOKIE, { path: "/" });
    return c.redirect("/login");
  });

  async function startSession(c: Context, version: number) {
    const exp = Date.now() + SESSION_HOURS * 3_600_000;
    await setSignedCookie(c, COOKIE, `${version}.${exp}`, sessionSecret, {
      path: "/",
      httpOnly: true,
      secure: opts.secureCookies,
      sameSite: "Strict",
      maxAge: SESSION_HOURS * 3600,
    });
  }

  // ---------- auth gate ----------
  app.use("*", async (c, next) => {
    const admin = await getAdmin(db);
    if (!admin) return c.redirect("/setup");
    const v = await getSignedCookie(c, sessionSecret, COOKIE);
    const [version, exp] = typeof v === "string" ? v.split(".").map(Number) : [];
    if (!version || !exp || version !== admin.version || exp < Date.now()) return c.redirect("/login");
    c.set("actor", "admin");
    await next();
  });

  // ---------- overview ----------
  app.get("/", async (c) => {
    const settings = await loadSettings(db);
    const day = await statsSince(db, new Date(Date.now() - 86_400_000));
    const week = await statsSince(db, new Date(Date.now() - 7 * 86_400_000));
    const bot = await getRuntime<{ status: string; tag?: string; guild?: string; inGuild?: boolean; error?: string }>(db, "bot");
    const sec = await secretStatus(db);
    const missing = SECRET_KEYS.filter((k) => !sec[k].set);
    const precision = await db
      .select({
        ruleId: decisions.ruleId,
        total: count(),
        reviewed: dsql<number>`count(${decisions.label})::int`,
        correct: dsql<number>`count(*) filter (where ${decisions.label} = 'correct')::int`,
      })
      .from(decisions)
      .where(isNotNull(decisions.ruleId))
      .groupBy(decisions.ruleId);
    const missed = await db.select({ n: count() }).from(decisions).where(eq(decisions.label, "missed"));
    const ruleRows = await loadRules(db);
    const stale = bot ? Date.now() - bot.updatedAt.getTime() > 3 * 60_000 : true;
    const botState = !bot ? "never started" : bot.value.status === "online" && stale ? "offline (no heartbeat)" : bot.value.status;

    return c.html(
      <Layout title="Overview" path="/">
        <div class="head">
          <h1>Overview</h1>
          <div class="right">
            <ModePill mode={settings.globalMode === "shadow" ? "shadow" : "enforce"} />
            <form method="post" action="/mode">
              <input type="hidden" name="mode" value={settings.globalMode === "shadow" ? "enforce" : "shadow"} />
              <button class={`small ${settings.globalMode === "shadow" ? "danger" : "ghost"}`}>
                {settings.globalMode === "shadow" ? "Allow enforced rules to act" : "Force everything to shadow"}
              </button>
            </form>
          </div>
        </div>
        {missing.length > 0 && (
          <div class="flash">
            The bot is waiting for: {missing.join(", ")}. <a href="/connection">Fill them in on the Keys page.</a>
          </div>
        )}
        <div class="grid">
          <div class="card stat">
            <span class="lbl">Bot</span>
            <b class={botState === "online" ? "okc" : "warnc"}>{botState}</b>
            <span>
              {bot?.value.tag ?? ""} {bot?.value.guild ? `in ${bot.value.guild}` : ""} · {ago(bot?.updatedAt)}
            </span>
            {bot?.value.error && <div class="hint badc">{bot.value.error}</div>}
          </div>
          <div class="card stat">
            <span class="lbl">Global mode</span>
            <b class={settings.globalMode === "shadow" ? "warnc" : "badc"}>{settings.globalMode}</b>
            <span>{settings.globalMode === "shadow" ? "Nothing is deleted or banned; Mr Mod only logs what it would do." : "Rules set to enforce act in Discord."}</span>
          </div>
          <div class="card stat">
            <span class="lbl">Last 24 hours</span>
            <b>{day.matched} caught</b>
            <span>
              {day.total} logged · {day.judged} judged by AI
            </span>
          </div>
          <div class="card stat">
            <span class="lbl">AI tokens · 7 days</span>
            <b>{(week.inputTokens + week.outputTokens).toLocaleString()}</b>
            <span>
              {week.inputTokens.toLocaleString()} in · {week.outputTokens.toLocaleString()} out
            </span>
          </div>
        </div>
        <div class="card">
          <div class="head">
            <h2 style="margin:0">Rule accuracy from your reviews</h2>
            <a class="right btn small ghost" href="/decisions?label=none">
              Review the queue
            </a>
          </div>
          <div class="wrap">
            <table>
              <tr>
                <th>Rule</th>
                <th>Mode</th>
                <th>Caught</th>
                <th>Reviewed</th>
                <th>Accuracy</th>
              </tr>
              {ruleRows
                .sort((a, b) => a.priority - b.priority)
                .map((r) => {
                  const p = precision.find((x) => x.ruleId === r.id);
                  const prec = p && p.reviewed ? Math.round((p.correct / p.reviewed) * 100) : null;
                  return (
                    <tr>
                      <td>
                        <a href={`/decisions?rule=${r.id}`}>{r.name}</a>
                      </td>
                      <td>
                        <ModePill mode={r.mode} />
                      </td>
                      <td>{p?.total ?? 0}</td>
                      <td>{p?.reviewed ?? 0}</td>
                      <td>
                        {prec === null ? (
                          "–"
                        ) : (
                          <span class={`pill ${prec >= 95 ? "ok" : prec >= 80 ? "warn" : "bad"}`}>
                            {prec}%{p!.reviewed >= 50 && prec >= 95 && r.mode === "shadow" ? " · ready to enforce" : ""}
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
            </table>
          </div>
          <div class="hint">
            Misses reported: {missed[0]?.n ?? 0}. Move a rule to enforce once it has about 50 reviews at 95% or better.
          </div>
        </div>
      </Layout>,
    );
  });

  app.post("/mode", async (c) => {
    const mode = String((await c.req.parseBody()).mode);
    if (mode !== "shadow" && mode !== "enforce") return c.text("bad mode", 400);
    await saveSetting(db, "globalMode", mode, c.get("actor"), "admin");
    return c.redirect("/");
  });

  // ---------- decisions ----------
  app.get("/decisions", async (c) => {
    const q = c.req.query();
    const conds = [];
    if (q.rule) conds.push(eq(decisions.ruleId, q.rule));
    if (q.label === "none") conds.push(isNull(decisions.label));
    else if (q.label) conds.push(eq(decisions.label, q.label));
    if (q.mode) conds.push(eq(decisions.mode, q.mode as RuleMode));
    if (q.matched === "1") conds.push(isNotNull(decisions.ruleId));
    if (q.matched === "q") conds.push(isNotNull(decisions.suggestedAnswer));
    const rows = await db
      .select()
      .from(decisions)
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(desc(decisions.createdAt))
      .limit(300);
    const ruleRows = await loadRules(db);
    const settings = await loadSettings(db);
    const reviewed = rows.filter((r) => r.label).length;
    const tab = q.label === "none" && !q.rule && !q.matched ? "?label=none" : q.matched === "1" && !q.rule && !q.label ? "?matched=1" : q.matched === "q" && !q.rule && !q.label ? "?matched=q" : !q.rule && !q.label && !q.matched ? "" : "custom";
    return c.html(
      <Layout title="Message log" path="/decisions" bleed flash={c.req.query("flash") ?? undefined}>
        <div class="tq-top">
          <h1>Message log</h1>
          <div class="tq-prog" title="Reviewed rows on this page">
            <div class="track">
              <i style={`width:${rows.length ? Math.round((reviewed / rows.length) * 100) : 0}%`} />
            </div>
            {rows.length - reviewed} of {rows.length} not reviewed
          </div>
          <div class="right">
            <ModePill mode={settings.globalMode === "shadow" ? "shadow" : "enforce"} />
            <a class="btn small ghost" href="">
              Refresh
            </a>
          </div>
        </div>
        <div class="tq-split">
          <section class="tq-queue" aria-label="Messages">
            <div class="tq-tabs">
              {TABS.map(([label, qs]) => (
                <a href={`/decisions${qs}`} class={tab === qs ? "on" : ""}>
                  {label}
                </a>
              ))}
              <details class="tq-more" open={!TABS.some(([, qs]) => qs === tab) || undefined}>
                <summary>Filter</summary>
                <form method="get" class="tq-filter">
                  <select name="rule" aria-label="Rule">
                    <option value="">All rules</option>
                    {ruleRows.map((r) => (
                      <option value={r.id} selected={q.rule === r.id}>
                        {r.name}
                      </option>
                    ))}
                  </select>
                  <select name="label" aria-label="Review">
                    <option value="">Any review</option>
                    <option value="none" selected={q.label === "none"}>
                      Not reviewed
                    </option>
                    {["correct", "wrong", "missed"].map((l) => (
                      <option value={l} selected={q.label === l}>
                        {l}
                      </option>
                    ))}
                  </select>
                  <select name="matched" aria-label="Matched">
                    <option value="">Matched or not</option>
                    <option value="1" selected={q.matched === "1"}>
                      Matched a rule
                    </option>
                    <option value="q" selected={q.matched === "q"}>
                      Questions (suggested answers)
                    </option>
                  </select>
                  <button class="small">Filter</button>
                </form>
              </details>
            </div>
            <p class="tq-note hint">
              {settings.logAllMessages ? "Every message is logged (turn off in Settings)." : "Suspicious messages and a random sample are logged."} Newest first. Discord
              #mod-log only gets messages that match a rule.
            </p>
            {rows.length === 0 && <p class="tq-note">Nothing here yet. New messages show up when you refresh.</p>}
            {rows.map((d) => {
              const k = kindOf(d);
              return (
                <a class="tq-item" href={`#m${d.id}`} data-id={d.id}>
                  <span class={`blk ${k}`} />
                  <span class="tq-body">
                    <b>{d.authorTag ?? d.authorId}</b>
                    <span class="tq-txt">{d.content ?? "(text removed by retention)"}</span>
                  </span>
                  <span class="tq-meta">
                    <time>{ago(d.createdAt).replace(" ago", "")}</time>
                    {d.label && <span class={`dot ${d.label === "correct" ? "ok" : "bad"}`} title={`Reviewed: ${d.label}`} />}
                  </span>
                </a>
              );
            })}
          </section>
          <section class="tq-detail" aria-live="polite">
            {rows.map((d, i) => {
              const k = kindOf(d);
              const rule = d.ruleId ? ruleRows.find((r) => r.id === d.ruleId) : undefined;
              const min = rule?.definition.minConfidence;
              const conf = d.verdict ? Math.round(d.verdict.confidence * 100) : null;
              const banned = d.executed.some((e) => e === "ban" || e.startsWith("ban ("));
              const plan = d.plannedAction;
              const steps: [string, string, string][] = [];
              if (plan?.delete) steps.push(["bad", "Delete the message", `in #${d.channelName ?? "channel"}`]);
              if (plan?.ban) steps.push(["bad", `Ban ${d.authorTag ?? "the author"}`, "and remove their last hour of messages"]);
              if (plan?.timeoutMinutes) steps.push(["warn", `Time out for ${plan.timeoutMinutes >= 60 ? `${Math.round(plan.timeoutMinutes / 60)}h` : `${plan.timeoutMinutes}m`}`, "they can read but not post"]);
              if (plan?.alert) steps.push(["info", "Alert admins", plan.recommendBan ? "with a Ban button" : "in the alert channel"]);
              if (plan && !steps.length) steps.push(["", "Log only", "posted to #mod-log"]);
              const next = rows[i + 1]?.id ?? d.id;
              return (
                <article id={`m${d.id}`} class="tq-art" hidden={i > 0} data-id={d.id}>
                  <div class="card">
                    <div class="tq-who">
                      <span class={`av ${k}`}>{(d.authorTag ?? "?").replace(/[^a-z0-9]/gi, "").charAt(0).toUpperCase() || "?"}</span>
                      <div>
                        <b>{d.authorTag ?? d.authorId}</b>
                        <span class="hint">
                          #{d.channelName ?? "channel"} · {ago(d.createdAt)} · message #{d.id}
                          {d.sampled ? " · random sample" : ""}
                        </span>
                      </div>
                      <div class="right">
                        {d.label && <span class={`pill ${d.label === "correct" ? "ok" : "bad"}`}>reviewed: {d.label}</span>}
                        {banned ? <span class="pill bad">banned</span> : null}
                        <a href={`https://discord.com/channels/${d.guildId}/${d.channelId}/${d.messageId}`} target="_blank" rel="noreferrer">
                          Open in Discord ↗
                        </a>
                      </div>
                    </div>
                    <blockquote class="tq-quote">{d.content ?? "(text removed by retention)"}</blockquote>
                    <div class="row">
                      <span class={`pill ${d.riskScore >= 50 ? "bad" : ""}`}>risk {d.riskScore}</span>
                      <span class={`pill ${d.signals.accountAgeDays < 7 ? "bad" : ""}`}>account {Math.round(d.signals.accountAgeDays)}d</span>
                      <span class={`pill ${d.signals.memberAgeDays !== null && d.signals.memberAgeDays < 3 ? "bad" : ""}`}>
                        joined {d.signals.memberAgeDays === null ? "?" : `${Math.round(d.signals.memberAgeDays)}d ago`}
                      </span>
                      {d.signals.supportScam.matched && <span class="pill bad">scam pattern: {d.signals.supportScam.patterns.join(" / ")}</span>}
                      {d.signals.duplicateChannels > 1 && <span class="pill bad">same text in {d.signals.duplicateChannels} channels</span>}
                      {d.signals.domains.length > 0 && <span class="pill">links: {d.signals.domains.slice(0, 3).join(", ")}</span>}
                    </div>
                  </div>
                  <div class="tq-vgrid">
                    <div class="card">
                      <span class="lbl">AI verdict</span>
                      {d.verdict ? (
                        <>
                          <div class="tq-vbig">
                            <b class={`v-${k}`}>{prettyVerdict(d.verdict.verdict)}</b>
                            <span>{conf}% confident</span>
                            {d.verdict.is_question && <span class="pill info">· question</span>}
                          </div>
                          <div class="tq-meter">
                            <i class={k} style={`width:${conf}%`} />
                            {min !== undefined && <u style={`left:${Math.round(min * 100)}%`} title="Rule's minimum confidence" />}
                          </div>
                          {min !== undefined && <span class="hint">Line = this rule's {Math.round(min * 100)}% minimum</span>}
                          <p>{d.verdict.reason}</p>
                        </>
                      ) : (
                        <p class="hint">Not judged by the AI (signals were below the threshold).</p>
                      )}
                      {d.error && <p class="badc">{d.error}</p>}
                    </div>
                    <div class="card">
                      <div class="row">
                        <span class="lbl">{rule ? `${d.mode === "enforce" ? "Rule" : "If enforced"}: ${rule.name}` : "What Mr Mod does"}</span>
                        {d.mode && <ModePill mode={d.mode} />}
                      </div>
                      {steps.length ? (
                        <div class="tq-steps">
                          {steps.map(([cls, t, sub]) => (
                            <div class="tq-step">
                              <i class={cls} />
                              <div>
                                {t}
                                <span class="hint">{sub}</span>
                              </div>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <p class="hint">{d.suggestedAnswer ? "Drafts a reply below. Nothing is posted in Discord." : "Nothing. The message is only logged."}</p>
                      )}
                      {d.executed.length > 0 && <p class="hint">Done in Discord: {d.executed.join(", ")}</p>}
                      {d.suggestedAnswer && <SuggestedAnswerBox a={d.suggestedAnswer} />}
                    </div>
                  </div>
                  <form method="post" action={`/decisions/${d.id}/label`} class="tq-keys">
                    <input type="hidden" name="next" value={String(next)} />
                    <button class="mint" name="label" value="correct" data-key="c">
                      {d.ruleId ? "Correct" : "Fine"} <kbd>C</kbd>
                    </button>
                    <button class="ghost" name="label" value={d.ruleId ? "wrong" : "missed"} data-key="w">
                      {d.ruleId ? "Wrong" : "Missed"} <kbd>W</kbd>
                    </button>
                    {banned ? (
                      <span class="btn ghost" aria-disabled="true">
                        Already banned
                      </span>
                    ) : (
                      <a class="btn danger" href={`/decisions/${d.id}/ban`} data-key="b">
                        Ban user… <kbd>B</kbd>
                      </a>
                    )}
                  </form>
                </article>
              );
            })}
          </section>
        </div>
        <style dangerouslySetInnerHTML={{ __html: LOG_CSS }} />
        <script dangerouslySetInnerHTML={{ __html: LOG_JS }} />
      </Layout>,
    );
  });

  // ---------- ban from the message log (confirm page, then the bot does it in Discord) ----------
  app.get("/decisions/:id/ban", async (c) => {
    const d = await getDecision(db, Number(c.req.param("id")));
    if (!d) return c.notFound();
    return c.html(
      <Layout title="Ban user" path="/decisions">
        <h1>Ban {d.authorTag ?? d.authorId}?</h1>
        <div class="card">
          <p>
            The bot will ban <b>{d.authorTag ?? "this user"}</b> (ID {d.authorId}) from the Discord server. They can't rejoin unless someone unbans them in
            Server Settings → Bans.
          </p>
          <div style="background:var(--surf2);border-radius:14px;padding:14px 16px;display:grid;gap:4px">
            <span class="hint">
              {d.authorTag ?? d.authorId} · #{d.channelName ?? "channel"} · {ago(d.createdAt)}
            </span>
            <span style="font:500 18px/1.4 var(--display);white-space:pre-wrap;word-break:break-word">{d.content ?? "(text removed by retention)"}</span>
          </div>
          <form method="post" action={`/decisions/${d.id}/ban`}>
            <label>Also delete their recent messages</label>
            <select name="deleteMessageHours" style="max-width:280px">
              <option value="0">Don't delete any</option>
              <option value="1">Last hour</option>
              <option value="24" selected>
                Last 24 hours
              </option>
              <option value="168">Last 7 days</option>
            </select>
            <p class="row" style="margin-top:14px">
              <button class="danger">Yes, ban {d.authorTag ?? "user"}</button>
              <a class="btn ghost" href="/decisions">Cancel</a>
            </p>
          </form>
        </div>
      </Layout>,
    );
  });

  app.post("/decisions/:id/ban", async (c) => {
    const d = await getDecision(db, Number(c.req.param("id")));
    if (!d) return c.notFound();
    const requested = Number((await c.req.parseBody()).deleteMessageHours);
    const hours = [0, 1, 24, 168].includes(requested) ? requested : 0;
    const bot = await getRuntime<{ status: string }>(db, "bot");
    const fresh = bot?.value.status === "online" && Date.now() - bot.updatedAt.getTime() < 3 * 60_000;
    if (!fresh) return c.redirect(`/decisions?flash=${encodeURIComponent("Not sent: the bot isn't online right now, so nobody was banned. Check the Connection page.")}`);
    await audit(db, c.get("actor"), "admin", "member.ban.request", d.authorId, { decisionId: d.id, deleteMessageHours: hours });
    await sendBotCommand(db, { type: "ban", decisionId: d.id, actor: "hub admin", deleteMessageHours: hours });
    return c.redirect(
      `/decisions?flash=${encodeURIComponent(`Ban sent to the bot for ${d.authorTag ?? d.authorId}. Refresh in a few seconds: the row will show "banned", or the error if Discord refused.`)}`,
    );
  });

  app.post("/decisions/:id/label", async (c) => {
    const id = Number(c.req.param("id"));
    const body = await c.req.parseBody();
    const label = String(body.label);
    if (!["correct", "wrong", "missed"].includes(label)) return c.text("bad label", 400);
    await db.update(decisions).set({ label, labeledBy: "hub", labeledAt: new Date() }).where(eq(decisions.id, id));
    await audit(db, c.get("actor"), "admin", "decision.label", String(id), { label });
    const back = (c.req.header("referer") ?? "/decisions").split("#")[0] ?? "/decisions";
    const next = String(body.next ?? "");
    return c.redirect(/^\d+$/.test(next) ? `${back}#m${next}` : back);
  });

  // ---------- rules ----------
  app.get("/rules", async (c) => {
    const ruleRows = (await loadRules(db)).sort((a, b) => a.priority - b.priority);
    return c.html(
      <Layout title="Rules" path="/rules" flash={c.req.query("saved") ? "Saved. The bot reloads rules within a few seconds." : undefined}>
        <h1>Rules</h1>
        <p class="hint">
          Rules are checked top to bottom; the first match decides. <b>Shadow</b> logs what it would do; <b>enforce</b> acts (only when the global mode
          on Overview allows it). "Ban member" bans automatically when the rule is enforced (and deletes their last hour of messages); "recommend ban" only adds a Ban button to the admin alert.
        </p>
        {ruleRows.map((r) => {
          const d = r.definition;
          return (
            <form class="card" method="post" action={`/rules/${r.id}`}>
              <div class="row">
                <span class="pill">#{r.priority}</span>
                <h2 style="margin:0">{r.name}</h2>
                <ModePill mode={r.mode} />
                {d.action.ban && r.mode === "enforce" ? <span class="pill bad">auto-ban</span> : null}
              </div>
              <div class="hint">{r.description}</div>
              <div class="grid">
                <div>
                  <label>Mode</label>
                  <select name="mode">
                    {(["off", "shadow", "enforce"] as const).map((m) => (
                      <option value={m} selected={r.mode === m}>
                        {m}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label>Priority</label>
                  <input name="priority" type="number" value={String(r.priority)} />
                </div>
                <div>
                  <label>Min AI confidence</label>
                  <input name="minConfidence" type="number" step="0.05" min="0" max="1" value={d.minConfidence === undefined ? "" : String(d.minConfidence)} />
                </div>
                <div>
                  <label>Timeout (minutes, 0 = none)</label>
                  <input name="timeoutMinutes" type="number" min="0" max="40320" value={String(d.action.timeoutMinutes)} />
                </div>
              </div>
              <label>Verdicts</label>
              <div class="row">
                {VERDICTS.filter((v) => v !== "ok").map((v) => (
                  <label class="chk">
                    <input type="checkbox" name="verdicts" value={v} checked={d.verdicts?.includes(v)} /> {prettyVerdict(v)}
                  </label>
                ))}
              </div>
              <div class="hint">None ticked = the rule ignores the AI verdict and uses only its signal conditions.</div>
              <label>Actions</label>
              <div class="row">
                {(
                  [
                    ["delete", "Delete message"],
                    ["alert", "Alert admins"],
                    ["ban", "Ban member"],
                    ["recommendBan", "Recommend ban"],
                  ] as const
                ).map(([k, l]) => (
                  <label class={`chk${k === "ban" || k === "delete" ? " danger" : ""}`}>
                    <input type="checkbox" name={k} value="1" checked={Boolean(d.action[k])} /> {l}
                  </label>
                ))}
              </div>
              <div class="hint">
                Signal conditions:{" "}
                {[
                  d.maxAccountAgeDays !== undefined && `account ≤ ${d.maxAccountAgeDays}d`,
                  d.maxMemberAgeDays !== undefined && `joined ≤ ${d.maxMemberAgeDays}d ago`,
                  d.minDuplicateChannels !== undefined && `same text in ≥ ${d.minDuplicateChannels} channels`,
                  d.moderationFlagged !== undefined && `moderation flagged = ${d.moderationFlagged}`,
                ]
                  .filter(Boolean)
                  .join(", ") || "none"}
              </div>
              <div class="row">
                <button class="small">Save rule</button>
              </div>
            </form>
          );
        })}
      </Layout>,
    );
  });

  app.post("/rules/:id", async (c) => {
    const id = c.req.param("id");
    const existing = (await loadRules(db)).find((r) => r.id === id);
    if (!existing) return c.notFound();
    const b = await c.req.parseBody({ all: true });
    const mode = String(b.mode) as RuleMode;
    if (!["off", "shadow", "enforce"].includes(mode)) return c.text("bad mode", 400);
    const verdicts = ([] as unknown[]).concat(b.verdicts ?? []).map(String).filter((v) => (VERDICTS as readonly string[]).includes(v)) as typeof VERDICTS[number][];
    const minConf = String(b.minConfidence ?? "").trim();
    const def = {
      ...existing.definition,
      verdicts: verdicts.length ? verdicts : undefined,
      minConfidence: minConf === "" ? undefined : Math.min(1, Math.max(0, Number(minConf))),
      action: {
        delete: b.delete === "1",
        alert: b.alert === "1",
        recommendBan: b.recommendBan === "1",
        ban: b.ban === "1",
        timeoutMinutes: Math.max(0, Math.min(40320, Math.round(Number(b.timeoutMinutes) || 0))),
      },
    };
    const priority = Math.round(Number(b.priority) || existing.priority);
    await db.update(rules).set({ mode, priority, definition: def, updatedAt: new Date() }).where(eq(rules.id, id));
    await audit(db, c.get("actor"), "admin", "rule.update", id, { before: existing, after: { mode, priority, definition: def } });
    await notifyConfigChanged(db);
    return c.redirect("/rules?saved=1");
  });

  // ---------- settings ----------
  const LIST_KEYS = ["exemptRoleIds", "exemptChannelIds", "trustedRoleIds", "qaChannelIds", "kbStartUrls", "kbAllowedHosts"] as const;
  const NUM_KEYS = ["riskThreshold", "judgeNewMembersDays", "sampleRate", "retentionDays", "crawlIntervalHours"] as const;
  const STR_KEYS = ["judgeModel", "answerModel", "moderationModel", "embeddingModel"] as const;
  const ID_KEYS = ["modlogChannelId", "alertChannelId", "alertRoleId"] as const;
  const NAMES: Record<string, string> = {
    riskThreshold: "Risk threshold",
    judgeNewMembersDays: "Judge new members (days)",
    sampleRate: "Sample rate",
    retentionDays: "Keep message text (days)",
    crawlIntervalHours: "Re-read help centre (hours)",
    exemptRoleIds: "Exempt roles",
    exemptChannelIds: "Exempt channels",
    trustedRoleIds: "Trusted roles",
    qaChannelIds: "Q&A channels",
    modlogChannelId: "Mod log channel",
    alertChannelId: "Alert channel",
    alertRoleId: "Alert role",
    kbStartUrls: "Help centre start URLs",
    kbAllowedHosts: "Allowed hosts",
    judgeModel: "Judge model",
    answerModel: "Answer model",
    moderationModel: "Moderation model",
    embeddingModel: "Embedding model",
  };
  const HELP: Record<string, string> = {
    riskThreshold: "Signal score at which the AI judge runs.",
    judgeNewMembersDays: "Judge every message from members who joined fewer than this many days ago (0 = off).",
    sampleRate: "Share of allowed messages logged for review, to catch misses (0.02 = 2%).",
    retentionDays: "Message text is removed from the log after this many days.",
    crawlIntervalHours: "How often support.nu.fi is re-read (takes effect on bot restart).",
    exemptRoleIds: "Role IDs never moderated (staff). One per line.",
    exemptChannelIds: "Channel IDs never moderated. One per line.",
    trustedRoleIds: "Role IDs only judged when a signal fires. One per line.",
    qaChannelIds: "Channel IDs where @mention questions are answered; empty = everywhere.",
    modlogChannelId: "Channel ID where every decision is posted. Also settable with /modbot channels.",
    alertChannelId: "Channel ID for admin alerts (empty = mod log).",
    alertRoleId: "Role ID pinged on alerts.",
  };

  app.get("/settings", async (c) => {
    const s = await loadSettings(db);
    const field = (k: keyof Settings) => (
      <div class="field">
        <label for={`f-${k}`}>{NAMES[k] ?? k}</label>
        {(LIST_KEYS as readonly string[]).includes(k) ? (
          <textarea id={`f-${k}`} name={k} style="min-height:76px">
            {(s[k] as string[]).join("\n")}
          </textarea>
        ) : (
          <input id={`f-${k}`} name={k} value={s[k] === null ? "" : String(s[k])} />
        )}
        {HELP[k] && <div class="hint">{HELP[k]}</div>}
      </div>
    );
    return c.html(
      <Layout title="Settings" path="/settings" flash={c.req.query("saved") ? "Saved." : c.req.query("error") ?? undefined}>
        <div class="head">
          <h1>Settings</h1>
        </div>
        <form method="post" style="display:grid;gap:16px">
          <div class="card">
            <h2 style="margin:0">Detection</h2>
            <div class="grid">{(["riskThreshold", "judgeNewMembersDays", "sampleRate", "retentionDays"] as const).map(field)}</div>
            <label class="check">
              <input type="checkbox" name="judgeAll" value="1" checked={s.judgeAll} />
              <span>
                Judge every message from non-exempt members
                <span class="hint" style="display:block">Catches more, costs more. On while testing.</span>
              </span>
            </label>
            <label class="check">
              <input type="checkbox" name="logAllMessages" value="1" checked={s.logAllMessages} />
              <span>
                Log every message to the hub's Message log
                <span class="hint" style="display:block">Turn off once you're happy, so only suspicious messages and a 2% sample are logged.</span>
              </span>
            </label>
            <div class="field">
              <label for="f-serverRules">Server rules the AI judge cites</label>
              <textarea id="f-serverRules" name="serverRules">{s.serverRules}</textarea>
            </div>
          </div>
          <div class="card">
            <h2 style="margin:0">Answers</h2>
            <label class="check">
              <input type="checkbox" name="suggestAnswers" value="1" checked={s.suggestAnswers} />
              <span>
                Suggest answers to questions (shadow)
                <span class="hint" style="display:block">
                  When the AI sees a help question, it drafts the reply it would give from support.nu.fi and shows it in the Message log. Nothing is posted in Discord.
                </span>
              </span>
            </label>
            <div class="field">
              <label for="f-answerPrompt">Answer prompt</label>
              <textarea id="f-answerPrompt" name="answerPrompt">{s.answerPrompt}</textarea>
              <div class="hint">
                Guides how the bot answers from the support.nu.fi articles: length, tone, what to emphasise, topics to avoid. Built-in safety rules always apply (answer only
                from the articles, never ask for recovery phrases, never send people to DMs or outside ticket links). Applies to suggested answers, /ask and @mentions.
              </div>
            </div>
            <div class="field">
              <label for="f-answerLinkFormat">Link format</label>
              <input id="f-answerLinkFormat" name="answerLinkFormat" value={s.answerLinkFormat} />
              <div class="hint">
                How each source link is shown under an answer. {"{url}"} is the link and {"{title}"} the page title. Examples: {"🔗 <{url}>"} or {"🔗 [{title}](<{url}>)"}. The
                angle brackets stop Discord showing a big preview card. Link styling in the Answer prompt has no effect: use this field.
              </div>
            </div>
            <div class="field">
              <label for="f-answerMaxChars">Maximum answer length (characters)</label>
              <input id="f-answerMaxChars" name="answerMaxChars" type="number" min="100" max="1700" value={String(s.answerMaxChars)} />
              <div class="hint">Hard cap on the answer text, before links and footer (100 to 1700). The Answer prompt sets the style within it.</div>
            </div>
            <div class="field">
              <label for="f-answerFooter">Footer on every bot answer</label>
              <input id="f-answerFooter" name="answerFooter" value={s.answerFooter} />
            </div>
          </div>
          <div class="card">
            <h2 style="margin:0">Channels and roles</h2>
            <div class="grid">{ID_KEYS.map(field)}</div>
            <div class="grid">{(["exemptRoleIds", "trustedRoleIds", "exemptChannelIds", "qaChannelIds"] as const).map(field)}</div>
          </div>
          <div class="card">
            <h2 style="margin:0">Knowledge base</h2>
            <div class="grid">{(["kbStartUrls", "kbAllowedHosts", "crawlIntervalHours"] as const).map(field)}</div>
          </div>
          <div class="card">
            <h2 style="margin:0">Models</h2>
            <div class="grid">{STR_KEYS.map(field)}</div>
          </div>
          <div class="row">
            <button class="danger">Save settings</button>
          </div>
        </form>
      </Layout>,
    );
  });

  app.post("/settings", async (c) => {
    const b = await c.req.parseBody();
    const current = await loadSettings(db);
    const next: Record<string, unknown> = {};
    for (const k of LIST_KEYS) next[k] = String(b[k] ?? "").split(/[\n,]/).map((x) => x.trim()).filter(Boolean);
    for (const k of NUM_KEYS) next[k] = Number(b[k]);
    for (const k of STR_KEYS) next[k] = String(b[k] ?? "").trim();
    for (const k of ID_KEYS) next[k] = String(b[k] ?? "").trim() || null;
    next.judgeAll = b.judgeAll === "1";
    next.logAllMessages = b.logAllMessages === "1";
    next.suggestAnswers = b.suggestAnswers === "1";
    next.answerFooter = String(b.answerFooter ?? "").trim();
    next.answerPrompt = String(b.answerPrompt ?? "").trim().slice(0, 4000);
    next.answerLinkFormat = String(b.answerLinkFormat ?? "").trim().slice(0, 200) || "<{url}>";
    next.answerMaxChars = Math.round(Number(b.answerMaxChars) || 1200);
    next.serverRules = String(b.serverRules ?? "");
    const parsed = settingsSchema.safeParse({ ...current, ...next });
    if (!parsed.success) return c.redirect(`/settings?error=${encodeURIComponent("Not saved: " + parsed.error.issues.map((i) => i.path.join(".")).join(", "))}`);
    for (const [k, v] of Object.entries(next)) {
      if (JSON.stringify(v) !== JSON.stringify(current[k as keyof Settings])) await saveSetting(db, k, v, c.get("actor"), "admin");
    }
    return c.redirect("/settings?saved=1");
  });

  // ---------- connection (secrets) ----------
  const LABELS: Record<SecretKey, [string, string]> = {
    DISCORD_TOKEN: ["Discord bot token", "Developer Portal → your app → Bot → Reset Token"],
    DISCORD_CLIENT_ID: ["Discord application ID", "Developer Portal → General Information → Application ID"],
    DISCORD_GUILD_ID: ["Discord server ID", "Right-click your server icon → Copy Server ID (Developer Mode on)"],
    OPENAI_API_KEY: ["OpenAI API key", "platform.openai.com → API keys"],
  };

  app.get("/connection", async (c) => {
    const st = await secretStatus(db);
    const clientId = st.DISCORD_CLIENT_ID.set ? await clientIdValue(db) : null;
    return c.html(
      <Layout title="Connection" path="/connection" flash={c.req.query("saved") ? "Saved. The bot restarts with the new values." : undefined}>
        <h1>Connection</h1>
        <p class="hint">
          These are stored only on this server, encrypted in its database. They are never shown again after saving; leave a field blank to keep the
          current value.
        </p>
        <form method="post" class="card" autocomplete="off">
          {SECRET_KEYS.map((k) => (
            <div>
              <label>
                {LABELS[k][0]}{" "}
                {st[k].set ? (
                  <span class="pill ok">set · …{st[k].hint} · {ago(st[k].updatedAt)}</span>
                ) : (
                  <span class="pill bad">missing</span>
                )}
              </label>
              <input name={k} type={k.endsWith("_ID") ? "text" : "password"} autocomplete="off" spellcheck={false} />
              <div class="hint">{LABELS[k][1]}</div>
            </div>
          ))}
          <p>
            <button>Save</button>
          </p>
        </form>
        {clientId && (
          <div class="card">
            <b>Invite the bot</b>
            <p>
              <a
                class="btn"
                href={`https://discord.com/oauth2/authorize?client_id=${encodeURIComponent(clientId)}&scope=bot+applications.commands&permissions=${PERMISSIONS}`}
                target="_blank"
                rel="noreferrer"
              >
                Add to server
              </a>
            </p>
            <div class="hint">
              Grants only: View Channels, Send Messages, Embed Links, Read Message History, Manage Messages, Kick, Ban, Timeout. Then drag the bot's
              role above regular members in Server Settings → Roles, and turn on Server Members and Message Content intents in the Developer Portal.
            </div>
          </div>
        )}
        <form method="post" action="/password" class="card" style="max-width:460px">
          <b>Change hub password</b>
          <label>Current password</label>
          <input name="current" type="password" autocomplete="current-password" required />
          <label>New password</label>
          <input name="password" type="password" autocomplete="new-password" minlength={12} required />
          <p>
            <button class="small">Change password</button>
          </p>
        </form>
      </Layout>,
    );
  });

  app.post("/connection", async (c) => {
    const b = await c.req.parseBody();
    const changed: string[] = [];
    for (const k of SECRET_KEYS) {
      const v = String(b[k] ?? "").trim();
      if (!v) continue;
      if (k.endsWith("_ID") && !/^\d{15,22}$/.test(v)) return c.html(<Layout title="Connection" path="/connection" flash={`${LABELS[k][0]} should be a number like 1234567890123456789.`} />, 400);
      await setSecret(db, k, v, c.get("actor"));
      changed.push(k);
    }
    if (changed.length) await audit(db, c.get("actor"), "admin", "secrets.update", changed.join(","), null);
    return c.redirect("/connection?saved=1");
  });

  app.post("/password", async (c) => {
    const b = await c.req.parseBody();
    const admin = (await getAdmin(db))!;
    if (tooManyAttempts(ip(c))) return c.text("Too many attempts; wait 15 minutes.", 429);
    if (!(await checkPassword(admin, String(b.current ?? "")))) return c.html(<Layout title="Connection" path="/connection" flash="Current password is wrong." />, 400);
    const err = validPassword(String(b.password ?? ""));
    if (err) return c.html(<Layout title="Connection" path="/connection" flash={err} />, 400);
    const next = await setPassword(db, String(b.password));
    await audit(db, c.get("actor"), "admin", "hub.password_change", undefined, null);
    await startSession(c, next.version);
    return c.redirect("/connection");
  });

  // ---------- knowledge ----------
  app.get("/knowledge", async (c) => {
    const pages = await db.select().from(kbPages).orderBy(desc(kbPages.fetchedAt)).limit(500);
    const chunks = await db.select({ n: count() }).from(kbChunks);
    const qa = await db.select().from(qaLog).orderBy(desc(qaLog.createdAt)).limit(50);
    return c.html(
      <Layout title="Knowledge" path="/knowledge" flash={c.req.query("crawl") ? "Re-crawl started; refresh in a few minutes." : undefined}>
        <h1>Knowledge base</h1>
        <div class="card row">
          <span>
            <b>{pages.length}</b> articles · <b>{chunks[0]?.n ?? 0}</b> chunks · last update {ago(pages[0]?.fetchedAt)}
          </span>
          <form method="post" action="/knowledge/recrawl" style="margin-left:auto">
            <button class="small">Re-crawl now</button>
          </form>
        </div>
        <h2>Recent questions</h2>
        <div class="card wrap">
          <table>
            <tr>
              <th>When</th>
              <th>Question</th>
              <th>Answer</th>
            </tr>
            {qa.map((q) => (
              <tr>
                <td>{ago(q.createdAt)}</td>
                <td class="msg">{q.question}</td>
                <td class="msg">
                  {q.answerable ? "" : <span class="pill warn">not in help centre</span>} {q.answer}
                </td>
              </tr>
            ))}
          </table>
        </div>
        <h2>Articles</h2>
        <div class="card wrap">
          <table>
            {pages.map((p) => (
              <tr>
                <td>
                  <a href={p.url} target="_blank" rel="noreferrer">
                    {p.title}
                  </a>
                </td>
                <td>{p.chunkCount} chunks</td>
                <td>{ago(p.fetchedAt)}</td>
              </tr>
            ))}
          </table>
        </div>
      </Layout>,
    );
  });

  app.post("/knowledge/recrawl", async (c) => {
    await db.execute(dsql`NOTIFY mrmod_cmd, 'recrawl'`);
    await audit(db, c.get("actor"), "admin", "kb.recrawl", undefined, null);
    return c.redirect("/knowledge?crawl=1");
  });

  // ---------- audit ----------
  app.get("/audit", async (c) => {
    const rows = await db.select().from(auditLog).orderBy(desc(auditLog.createdAt)).limit(200);
    return c.html(
      <Layout title="Audit log" path="/audit">
        <h1>Audit log</h1>
        <div class="card wrap">
          <table>
            <tr>
              <th>When</th>
              <th>Who</th>
              <th>Action</th>
              <th>Target</th>
              <th>Details</th>
            </tr>
            {rows.map((r) => (
              <tr>
                <td>{ago(r.createdAt)}</td>
                <td>{r.actorName ?? r.actorId}</td>
                <td>{r.action}</td>
                <td>{r.target}</td>
                <td class="msg hint">{r.details ? JSON.stringify(r.details).slice(0, 300) : ""}</td>
              </tr>
            ))}
          </table>
        </div>
      </Layout>,
    );
  });

  return app;
}

async function clientIdValue(db: DB): Promise<string | null> {
  return (await loadSecrets(db)).DISCORD_CLIENT_ID ?? null;
}
