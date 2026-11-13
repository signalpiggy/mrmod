// Backtesting tab: replays recent conversation-starting messages through the pipeline (dry run, in the bot) and shows what Mr Mod would have done.
import { audit, BACKTEST_COUNTS, BACKTEST_DEFAULT_COUNT, BACKTEST_KEY, getRuntime, summarizeBacktest, type BacktestResult, type BacktestRun, type DB } from "@mrmod/core";
import { sql as dsql } from "drizzle-orm";
import type { Hono } from "hono";
import { ago, Layout, ModePill, SuggestedAnswerBox } from "./layout.js";
import { kindOf, LOG_CSS, LOG_JS, prettyVerdict, type Kind } from "./logview.js";

const FILTERS: [string, string, (r: BacktestResult) => boolean][] = [
  ["All", "", () => true],
  ["Would act", "act", (r) => r.outcome === "act"],
  ["Would answer", "answer", (r) => r.outcome === "answer"],
  ["Allowed", "allow", (r) => r.outcome === "allow" || r.outcome === "skip"],
];

const BT_CSS = `
.bt-form{margin:0;display:flex;gap:12px;align-items:end;flex-wrap:wrap;padding:12px 22px;background:var(--surf);border-bottom:1px solid var(--line)}
.bt-form .field{width:170px}
.bt-form select,.bt-form input{padding:7px 9px}
.bt-form .hint{flex-basis:100%}
.bt-warn{padding:10px 22px;background:var(--sunbg);color:var(--sunink);font-weight:600}
.bt-sum{display:flex;gap:10px;flex-wrap:wrap;padding:12px 22px;background:var(--surf);border-bottom:1px solid var(--line)}
.bt-sum .s{display:grid;gap:0;padding:8px 14px;border-radius:12px;background:var(--surf2);min-width:96px}
.bt-sum .s b{font:800 22px/1.15 var(--display);font-variant-numeric:tabular-nums}
.bt-sum .s span{font-size:12px;color:var(--muted)}
.bt-sum .s.bad b{color:var(--coral)}.bt-sum .s.info b{color:var(--sky)}.bt-sum .s.ok b{color:var(--mintink)}
.bt-run{padding:18px 22px;display:grid;gap:12px;max-width:760px}
.bt-bar{height:10px;border-radius:99px;background:var(--bg);overflow:hidden}
.bt-bar i{display:block;height:100%;background:var(--mint)}
.tq-item .out{font:700 11px var(--display);letter-spacing:.04em;text-transform:uppercase}
`;

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** Date and time in the run starter's timezone (tz = getTimezoneOffset minutes). */
function fmt(iso: string, tz: number): string {
  const d = new Date(Date.parse(iso) - tz * 60_000);
  return `${d.getUTCDate()} ${MON[d.getUTCMonth()]} ${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}
/** yyyy-mm-dd for a date input; `end` turns an exclusive end time back into the last day included. */
function localDate(iso: string, tz: number, end = false): string {
  return new Date(Date.parse(iso) - tz * 60_000 - (end ? 1 : 0)).toISOString().slice(0, 10);
}
function span(results: BacktestResult[], tz: number): string {
  if (!results.length) return "";
  const times = results.map((r) => r.createdAt).sort();
  return ` sent ${fmt(times[0]!, tz)} to ${fmt(times[times.length - 1]!, tz)}`;
}

function outcomeLabel(r: BacktestResult): [string, Kind] {
  if (r.outcome === "act") {
    const a = r.plannedAction;
    if (a?.ban) return ["Delete + ban", "bad"];
    if (a?.delete) return ["Delete", "bad"];
    if (a?.timeoutMinutes) return ["Timeout", "warn"];
    return ["Log for review", "warn"];
  }
  if (r.outcome === "answer") return [r.suggestedAnswer?.answerable ? "Answer" : "Answer (no match)", "info"];
  if (r.outcome === "skip") return ["Skipped", "none"];
  return ["Allow", "none"];
}

function steps(r: BacktestResult): [string, string, string][] {
  const plan = r.plannedAction;
  const out: [string, string, string][] = [];
  if (!plan) return out;
  if (plan.delete) out.push(["bad", "Delete the message", `in #${r.channelName ?? "channel"}`]);
  if (plan.ban) out.push(["bad", `Ban ${r.authorTag}`, "and remove their last hour of messages"]);
  if (plan.timeoutMinutes) out.push(["warn", `Time out for ${plan.timeoutMinutes >= 60 ? `${Math.round(plan.timeoutMinutes / 60)}h` : `${plan.timeoutMinutes}m`}`, "they can read but not post"]);
  if (plan.alert) out.push(["info", "Alert admins", plan.recommendBan ? "with a Ban button" : "in the alert channel"]);
  if (!out.length) out.push(["", "Log only", "posted to #mod-log for a human look"]);
  return out;
}

export function registerBacktest(app: Hono<{ Variables: { actor: string } }>, db: DB) {
  app.get("/backtest", async (c) => {
    const row = await getRuntime<BacktestRun>(db, BACKTEST_KEY);
    const run = row?.value ?? null;
    // A run whose bot died mid-way stops updating; treat it as stalled after 10 minutes of silence.
    const stalled = run?.status === "running" && Date.now() - row!.updatedAt.getTime() > 10 * 60_000;
    const running = run?.status === "running" && !stalled;
    const f = c.req.query("f") ?? "";
    const filter = FILTERS.find(([, k]) => k === f) ?? FILTERS[0]!;
    const results = run?.results ?? [];
    const rows = results.filter(filter[2]);
    const sum = summarizeBacktest(results);

    return c.html(
      <Layout title="Backtesting" path="/backtest" bleed flash={c.req.query("flash") ?? undefined}>
        <div class="tq-top">
          <h1>Backtesting</h1>
          <span class="hint">
            {run
              ? `${run.status === "done" ? "Last run" : running ? "Running since" : "Run started"} ${ago(run.startedAt)} · ${results.length} messages${span(results, run.tz ?? 0)} · ${run.channelsScanned} channels`
              : "No run yet"}
          </span>
          <div class="right">
            {run && <ModePill mode={run.globalMode} />}
          </div>
        </div>
        <form method="post" action="/backtest" class="bt-form">
          <div class="field">
            <label for="bt-count">Messages</label>
            <select id="bt-count" name="count">
              {BACKTEST_COUNTS.map((n) => (
                <option value={String(n)} selected={(run?.requested ?? BACKTEST_DEFAULT_COUNT) === n || undefined}>
                  Latest {n}
                </option>
              ))}
            </select>
          </div>
          <div class="field">
            <label for="bt-from">From (optional)</label>
            <input id="bt-from" type="date" name="from" value={run?.from ? localDate(run.from, run.tz ?? 0) : ""} />
          </div>
          <div class="field">
            <label for="bt-to">To (optional)</label>
            <input id="bt-to" type="date" name="to" value={run?.to ? localDate(run.to, run.tz ?? 0, true) : ""} />
          </div>
          <input type="hidden" name="tz" value="0" />
          <button disabled={running || undefined}>{running ? "Running…" : "Run backtest"}</button>
          <p class="hint">
            Takes the newest conversation starters across all channels. With dates set, the newest ones inside that range (both days included).
          </p>
          <script dangerouslySetInnerHTML={{ __html: "document.querySelector('.bt-form [name=tz]').value=String(new Date().getTimezoneOffset())" }} />
        </form>

        {(!run || running || run.status === "error" || stalled) && (
          <div class="bt-run">
            {!run && (
              <>
                <p>
                  Replays the latest messages that <b>started a conversation</b> in the server through Mr Mod's real pipeline (signals, AI
                  judge, your rules, suggested answers) and shows what it would have done to each.
                </p>
                <p class="hint">
                  A message counts as a conversation starter when it isn't a Discord reply, its author hadn't posted in that channel in the previous 10 minutes,
                  and nobody had replied to or @mentioned the author there in those 10 minutes. It's a dry run: nothing is deleted, posted, banned, or sent to
                  #mod-log. It uses the AI judge, so it costs about as much as the same number of live messages.
                </p>
              </>
            )}
            {running && run && (
              <>
                <p>
                  <b>{run.phase}</b>
                </p>
                <div class="bt-bar" role="progressbar" aria-valuenow={run.processed} aria-valuemax={Math.max(1, Math.min(run.requested, run.startersFound || run.requested))}>
                  <i style={`width:${run.startersFound ? Math.round((run.processed / Math.min(run.requested, run.startersFound)) * 100) : 3}%`} />
                </div>
                <p class="hint">
                  {run.channelsScanned} channels read · {run.messagesScanned} messages scanned · {run.startersFound} conversation starters found ·{" "}
                  {run.processed} judged. This page refreshes itself.
                </p>
                <script dangerouslySetInnerHTML={{ __html: "setTimeout(function(){location.reload()},5000)" }} />
              </>
            )}
            {run?.status === "error" && <p class="badc">The last run failed: {run.error}</p>}
            {stalled && <p class="warnc">The last run stopped reporting progress (the bot may have restarted). Run it again.</p>}
          </div>
        )}

        {results.length > 0 && (
          <>
            {run?.truncated && (
              <p class="bt-warn">Stopped after reading 300,000 messages, so this may not reach back far enough. Pick a narrower date range for a complete result.</p>
            )}
            <div class="bt-sum">
              <div class="s bad">
                <b>{sum.del}</b>
                <span>would delete</span>
              </div>
              <div class="s bad">
                <b>{sum.ban}</b>
                <span>would ban</span>
              </div>
              <div class="s">
                <b>{sum.logOnly + sum.timeout}</b>
                <span>log / timeout</span>
              </div>
              <div class="s info">
                <b>{sum.answer}</b>
                <span>would answer ({sum.answerable} found in KB)</span>
              </div>
              <div class="s ok">
                <b>{sum.allow + sum.skip}</b>
                <span>allowed</span>
              </div>
            </div>
            <div class="tq-split">
              <section class="tq-queue" aria-label="Replayed messages">
                <div class="tq-tabs">
                  {FILTERS.map(([label, k, fn]) => (
                    <a href={`/backtest${k ? `?f=${k}` : ""}`} class={filter[1] === k ? "on" : ""}>
                      {label} {results.filter(fn).length}
                    </a>
                  ))}
                </div>
                <p class="tq-note hint">
                  Newest first. Rules as configured now{run?.globalMode === "shadow" ? "; you're in shadow mode, so live these would only be logged" : ""}.
                </p>
                {rows.length === 0 && <p class="tq-note">Nothing in this group.</p>}
                {rows.map((r) => {
                  const k = kindOf({ verdict: r.verdict, ruleId: r.ruleId, suggestedAnswer: r.suggestedAnswer });
                  const [out, ok] = outcomeLabel(r);
                  return (
                    <a class="tq-item" href={`#m${r.messageId}`} data-id={r.messageId}>
                      <span class={`blk ${k}`} />
                      <span class="tq-body">
                        <b>{r.authorTag}</b>
                        <span class="tq-txt">{r.content}</span>
                      </span>
                      <span class="tq-meta">
                        <time>{ago(r.createdAt).replace(" ago", "")}</time>
                        <span class={`out v-${ok}`}>{out}</span>
                      </span>
                    </a>
                  );
                })}
              </section>
              <section class="tq-detail" aria-live="polite">
                {rows.map((r, i) => {
                  const k = kindOf({ verdict: r.verdict, ruleId: r.ruleId, suggestedAnswer: r.suggestedAnswer });
                  const conf = r.verdict ? Math.round(r.verdict.confidence * 100) : null;
                  const st = steps(r);
                  const s = r.signals;
                  return (
                    <article id={`m${r.messageId}`} class="tq-art" hidden={i > 0} data-id={r.messageId}>
                      <div class="card">
                        <div class="tq-who">
                          <span class={`av ${k}`}>{r.authorTag.replace(/[^a-z0-9]/gi, "").charAt(0).toUpperCase() || "?"}</span>
                          <div>
                            <b>{r.authorTag}</b>
                            <span class="hint">
                              #{r.channelName ?? "channel"} · {fmt(r.createdAt, run?.tz ?? 0)} ({ago(r.createdAt)}) · conversation starter
                            </span>
                          </div>
                          <div class="right">
                            <a href={`https://discord.com/channels/${r.guildId}/${r.channelId}/${r.messageId}`} target="_blank" rel="noreferrer">
                              Open in Discord ↗
                            </a>
                          </div>
                        </div>
                        <blockquote class="tq-quote">{r.content}</blockquote>
                        {s && (
                          <div class="row">
                            <span class={`pill ${r.riskScore >= 50 ? "bad" : ""}`}>risk {r.riskScore}</span>
                            <span class={`pill ${s.accountAgeDays < 7 ? "bad" : ""}`}>account {Math.round(s.accountAgeDays)}d</span>
                            <span class={`pill ${s.memberAgeDays !== null && s.memberAgeDays < 3 ? "bad" : ""}`}>
                              joined {s.memberAgeDays === null ? "? (may have left)" : `${Math.round(s.memberAgeDays)}d before`}
                            </span>
                            {s.supportScam.matched && <span class="pill bad">scam pattern: {s.supportScam.patterns.join(" / ")}</span>}
                            {s.duplicateChannels > 1 && <span class="pill bad">same text in {s.duplicateChannels} channels</span>}
                            {s.domains.length > 0 && <span class="pill">links: {s.domains.slice(0, 3).join(", ")}</span>}
                            {r.moderationFlagged && <span class="pill bad">moderation: {r.moderationCategories.join(", ")}</span>}
                          </div>
                        )}
                      </div>
                      <div class="tq-vgrid">
                        <div class="card">
                          <span class="lbl">AI verdict</span>
                          {r.verdict ? (
                            <>
                              <div class="tq-vbig">
                                <b class={`v-${k}`}>{prettyVerdict(r.verdict.verdict)}</b>
                                <span>{conf}% confident</span>
                                {r.verdict.is_question && <span class="pill info">· question</span>}
                              </div>
                              <div class="tq-meter">
                                <i class={k} style={`width:${conf}%`} />
                              </div>
                              <p>{r.verdict.reason}</p>
                            </>
                          ) : (
                            <p class="hint">{r.outcome === "skip" ? `Skipped: ${r.skipped}.` : "Not judged by the AI (signals were below the threshold)."}</p>
                          )}
                          {r.errors.length > 0 && <p class="badc">{r.errors.join("; ")}</p>}
                        </div>
                        <div class="card">
                          <div class="row">
                            <span class="lbl">{r.ruleName ? `Would match: ${r.ruleName}` : "What Mr Mod would do"}</span>
                            {r.mode && <ModePill mode={r.mode} />}
                          </div>
                          {st.length ? (
                            <div class="tq-steps">
                              {st.map(([cls, t, sub]) => (
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
                            <p class="hint">{r.suggestedAnswer ? "Reply with the answer below." : "Nothing. The message is allowed."}</p>
                          )}
                          {r.suggestedAnswer && <SuggestedAnswerBox a={r.suggestedAnswer} />}
                        </div>
                      </div>
                    </article>
                  );
                })}
              </section>
            </div>
          </>
        )}
        <style dangerouslySetInnerHTML={{ __html: LOG_CSS + BT_CSS }} />
        <script dangerouslySetInnerHTML={{ __html: LOG_JS }} />
      </Layout>,
    );
  });

  app.post("/backtest", async (c) => {
    const back = (msg: string) => c.redirect(`/backtest?flash=${encodeURIComponent(msg)}`);
    const bot = await getRuntime<{ status: string }>(db, "bot");
    const fresh = bot?.value.status === "online" && Date.now() - bot.updatedAt.getTime() < 3 * 60_000;
    if (!fresh) return back("Not started: the bot isn't online right now. Check the Keys page.");
    const row = await getRuntime<BacktestRun>(db, BACKTEST_KEY);
    if (row?.value.status === "running" && Date.now() - row.updatedAt.getTime() < 10 * 60_000) return back("A backtest is already running.");
    const body = await c.req.parseBody();
    const count = (BACKTEST_COUNTS as readonly number[]).includes(Number(body.count)) ? Number(body.count) : BACKTEST_DEFAULT_COUNT;
    const tz = Math.max(-840, Math.min(840, Math.round(Number(body.tz) || 0)));
    // Date inputs are days in the admin's timezone: from = start of that day, to = end of that day.
    const day = (v: unknown, plus: number) => {
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v ?? ""));
      return m ? new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]! + plus) + tz * 60_000).toISOString() : null;
    };
    const from = day(body.from, 0);
    const to = day(body.to, 1);
    if (from && to && from >= to) return back("Not started: the From date is after the To date.");
    const cmd = { type: "backtest", count, from, to, tz, actor: "hub admin" };
    await audit(db, c.get("actor"), "admin", "backtest.run", undefined, cmd);
    await db.execute(dsql`SELECT pg_notify('mrmod_cmd', ${JSON.stringify(cmd)})`);
    return back("Backtest started. Reading channel history first; this page updates as it goes.");
  });
}
