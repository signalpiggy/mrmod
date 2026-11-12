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
import { ago, Layout, ModePill, SuggestedAnswerBox } from "./layout.js";

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

  // ---------- setup & login ----------
  app.get("/setup", async (c) => {
    if (await getAdmin(db)) return c.redirect("/login");
    return c.html(
      <Layout title="Set up" authed={false}>
        <div class="card" style="max-width:460px">
          <h1>Set up the hub</h1>
          <p>Enter the one-time setup code (Claude will send it to you) and choose the admin password.</p>
          <form method="post">
            <label>Setup code</label>
            <input name="code" autocomplete="off" required />
            <label>Admin password</label>
            <input name="password" type="password" autocomplete="new-password" minlength={12} required />
            <div class="hint">At least 12 characters. Store it in your password manager.</div>
            <p>
              <button>Save password</button>
            </p>
          </form>
        </div>
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
        <div class="card" style="max-width:380px">
          <h1>Sign in</h1>
          <form method="post">
            <label>Password</label>
            <input name="password" type="password" autocomplete="current-password" required autofocus />
            <p>
              <button>Sign in</button>
            </p>
          </form>
        </div>
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
        <h1>Overview</h1>
        {missing.length > 0 && (
          <div class="flash">
            The bot is waiting for: {missing.join(", ")}. <a href="/connection">Fill them in on the Connection page.</a>
          </div>
        )}
        <div class="grid">
          <div class="card stat">
            <span>Bot</span>
            <b class={botState === "online" ? "okc" : "warnc"}>{botState}</b>
            <span>
              {bot?.value.tag ?? ""} {bot?.value.guild ? `in ${bot.value.guild}` : ""} · {ago(bot?.updatedAt)}
            </span>
            {bot?.value.error && <div class="hint badc">{bot.value.error}</div>}
          </div>
          <div class="card stat">
            <span>Global mode</span>
            <b>
              <ModePill mode={settings.globalMode} />
            </b>
            <form method="post" action="/mode">
              <input type="hidden" name="mode" value={settings.globalMode === "shadow" ? "enforce" : "shadow"} />
              <button class="small ghost">{settings.globalMode === "shadow" ? "Allow enforced rules to act" : "Force everything to shadow"}</button>
            </form>
          </div>
          <div class="card stat">
            <span>Last 24 hours</span>
            <b>{day.matched} matched</b>
            <span>
              {day.total} logged · {day.judged} judged by AI
            </span>
          </div>
          <div class="card stat">
            <span>AI tokens (7 days)</span>
            <b>{(week.inputTokens + week.outputTokens).toLocaleString()}</b>
            <span>
              {week.inputTokens.toLocaleString()} in · {week.outputTokens.toLocaleString()} out
            </span>
          </div>
        </div>
        <h2>Rule accuracy from reviews</h2>
        <div class="card wrap">
          <table>
            <tr>
              <th>Rule</th>
              <th>Mode</th>
              <th>Matches</th>
              <th>Reviewed</th>
              <th>Precision</th>
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
                    <td class={prec === null ? "" : prec >= 95 ? "okc" : prec >= 80 ? "warnc" : "badc"}>
                      {prec === null ? "–" : `${prec}%`}
                      {prec !== null && p!.reviewed >= 50 && prec >= 95 && r.mode === "shadow" ? " · ready to enforce" : ""}
                    </td>
                  </tr>
                );
              })}
          </table>
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
    return c.html(
      <Layout title="Message log" path="/decisions" flash={c.req.query("flash") ?? undefined}>
        <h1>Message log</h1>
        <p class="hint">
          {settings.logAllMessages ? "Every message is logged (turn off in Settings)." : "Suspicious messages and a random sample are logged."} Newest first;
          <a href="">refresh</a> to see new ones. Discord #mod-log only gets messages that match a rule.
        </p>
        <form class="row card" method="get">
          <select name="rule">
            <option value="">All rules</option>
            {ruleRows.map((r) => (
              <option value={r.id} selected={q.rule === r.id}>
                {r.name}
              </option>
            ))}
          </select>
          <select name="label">
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
          <select name="matched">
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
        <div class="card wrap">
          <table>
            <tr>
              <th>When</th>
              <th>Message</th>
              <th>Verdict</th>
              <th>Rule / action</th>
              <th>Review</th>
            </tr>
            {rows.map((d) => (
              <tr>
                <td>
                  #{d.id}
                  <br />
                  {ago(d.createdAt)}
                  <br />
                  <a href={`https://discord.com/channels/${d.guildId}/${d.channelId}/${d.messageId}`} target="_blank" rel="noreferrer">
                    #{d.channelName ?? "channel"}
                  </a>
                </td>
                <td class="msg">
                  <b>{d.authorTag}</b>{" "}
                  {d.executed.some((e) => e === "ban" || e.startsWith("ban (")) ? (
                    <span class="pill badc">banned</span>
                  ) : (
                    <a class="pill badc" href={`/decisions/${d.id}/ban`} style="text-decoration:none">
                      Ban user
                    </a>
                  )}
                  {"\n"}
                  {d.content ?? "(text removed by retention)"}
                  <div class="hint">
                    risk {d.riskScore} · acct {Math.round(d.signals.accountAgeDays)}d · joined{" "}
                    {d.signals.memberAgeDays === null ? "?" : `${Math.round(d.signals.memberAgeDays)}d`}
                    {d.signals.supportScam.matched ? ` · scam pattern: ${d.signals.supportScam.patterns.join("/")}` : ""}
                    {d.sampled ? " · random sample" : ""}
                  </div>
                  {d.suggestedAnswer && <SuggestedAnswerBox a={d.suggestedAnswer} />}
                </td>
                <td>
                  {d.verdict ? (
                    <>
                      <b>{d.verdict.verdict}</b> {Math.round(d.verdict.confidence * 100)}%{d.verdict.is_question ? " · question" : ""}<div class="hint">{d.verdict.reason}</div>
                    </>
                  ) : (
                    "–"
                  )}
                  {d.error && <div class="hint badc">{d.error}</div>}
                </td>
                <td>
                  {d.ruleId ?? "–"} <ModePill mode={d.mode} />
                  <div class="hint">
                    {d.plannedAction
                      ? [d.plannedAction.delete && "delete", d.plannedAction.ban && "ban", d.plannedAction.timeoutMinutes && `timeout ${d.plannedAction.timeoutMinutes}m`, d.plannedAction.alert && "alert"]
                          .filter(Boolean)
                          .join(", ") || "log only"
                      : ""}
                    {d.executed.length ? ` · did: ${d.executed.join(", ")}` : ""}
                  </div>
                </td>
                <td>
                  {d.label ? <span class="pill">{d.label}</span> : null}
                  <form method="post" action={`/decisions/${d.id}/label`} class="row" style="margin-top:4px">
                    <button class="small ghost" name="label" value="correct">
                      {d.ruleId ? "Correct" : "Fine"}
                    </button>
                    <button class="small ghost" name="label" value={d.ruleId ? "wrong" : "missed"}>
                      {d.ruleId ? "Wrong" : "Missed"}
                    </button>
                  </form>
                </td>
              </tr>
            ))}
          </table>
        </div>
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
          <div class="msg card" style="max-width:none">
            <span class="hint">
              #{d.channelName ?? "channel"} · {ago(d.createdAt)}
            </span>
            {"\n"}
            {d.content ?? "(text removed by retention)"}
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
            <p class="row">
              <button style="background:var(--bad);border-color:var(--bad)">Yes, ban {d.authorTag ?? "user"}</button>
              <a href="/decisions">Cancel</a>
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
    const label = String((await c.req.parseBody()).label);
    if (!["correct", "wrong", "missed"].includes(label)) return c.text("bad label", 400);
    await db.update(decisions).set({ label, labeledBy: "hub", labeledAt: new Date() }).where(eq(decisions.id, id));
    await audit(db, c.get("actor"), "admin", "decision.label", String(id), { label });
    return c.redirect(c.req.header("referer") ?? "/decisions");
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
                <b>{r.name}</b> <ModePill mode={r.mode} />
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
                  <label style="font-weight:400;margin:0">
                    <input type="checkbox" name="verdicts" value={v} checked={d.verdicts?.includes(v)} style="width:auto" /> {v}
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
                  <label style="font-weight:400;margin:0">
                    <input type="checkbox" name={k} value="1" checked={Boolean(d.action[k])} style="width:auto" /> {l}
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
              <p>
                <button class="small">Save rule</button>
              </p>
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
      <div>
        <label>{k}</label>
        {(LIST_KEYS as readonly string[]).includes(k) ? (
          <textarea name={k} style="min-height:70px">
            {(s[k] as string[]).join("\n")}
          </textarea>
        ) : (
          <input name={k} value={s[k] === null ? "" : String(s[k])} />
        )}
        {HELP[k] && <div class="hint">{HELP[k]}</div>}
      </div>
    );
    return c.html(
      <Layout title="Settings" path="/settings" flash={c.req.query("saved") ? "Saved." : c.req.query("error") ?? undefined}>
        <h1>Settings</h1>
        <form method="post" class="card">
          <h2>Channels and roles</h2>
          <div class="grid">{ID_KEYS.map(field)}</div>
          <div class="grid">{(["exemptRoleIds", "trustedRoleIds", "exemptChannelIds", "qaChannelIds"] as const).map(field)}</div>
          <h2>Detection</h2>
          <div class="grid">{(["riskThreshold", "judgeNewMembersDays", "sampleRate", "retentionDays"] as const).map(field)}</div>
          <div>
            <label>
              <input type="checkbox" name="judgeAll" value="1" checked={s.judgeAll} style="width:auto" /> Judge every message from non-exempt members
            </label>
            <div class="hint">Catches more, costs more. On while testing.</div>
            <label>
              <input type="checkbox" name="logAllMessages" value="1" checked={s.logAllMessages} style="width:auto" /> Log every message to the hub's Message log
            </label>
            <div class="hint">Turn off once you're happy, so only suspicious messages and a 2% sample are logged.</div>
            <label>
              <input type="checkbox" name="suggestAnswers" value="1" checked={s.suggestAnswers} style="width:auto" /> Suggest answers to questions (shadow)
            </label>
            <div class="hint">When the AI sees a help question, it drafts the reply it would give from support.nu.fi and shows it in the Message log. Nothing is posted in Discord.</div>
          </div>
          <label>Answer prompt</label>
          <textarea name="answerPrompt">{s.answerPrompt}</textarea>
          <div class="hint">
            Guides how the bot answers from the support.nu.fi articles: length, tone, what to emphasise, topics to avoid. Built-in safety rules always apply (answer only from
            the articles, never ask for recovery phrases, never send people to DMs or outside ticket links). Applies to suggested answers, /ask and @mentions.
          </div>
          <label>Footer on every bot answer</label>
          <input name="answerFooter" value={s.answerFooter} />
          <label>Server rules the AI judge cites</label>
          <textarea name="serverRules">{s.serverRules}</textarea>
          <h2>Models</h2>
          <div class="grid">{STR_KEYS.map(field)}</div>
          <h2>Knowledge base</h2>
          <div class="grid">{(["kbStartUrls", "kbAllowedHosts", "crawlIntervalHours"] as const).map(field)}</div>
          <p>
            <button>Save settings</button>
          </p>
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
                  <span class="pill okc">set · …{st[k].hint} · {ago(st[k].updatedAt)}</span>
                ) : (
                  <span class="pill badc">missing</span>
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
                  {q.answerable ? "" : <span class="pill warnc">not in help centre</span>} {q.answer}
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
