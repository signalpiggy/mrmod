// Backtesting tab: replays recent conversation-starting messages through the pipeline (dry run, in the bot) and shows what Mr Mod would have done.
import { audit, BACKTEST_DEFAULT_COUNT, BACKTEST_KEY, getRuntime, summarizeBacktest, type BacktestResult, type BacktestRun, type DB } from "@mrmod/core";
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
              ? `${run.status === "done" ? "Last run" : running ? "Running since" : "Run started"} ${ago(run.startedAt)} · ${results.length} messages from ${run.channelsScanned} channels`
              : "No run yet"}
          </span>
          <div class="right">
            {run && <ModePill mode={run.globalMode} />}
            <form method="post" action="/backtest">
              <button class="small" disabled={running || undefined}>
                {running ? "Running…" : run ? `Run again on last ${BACKTEST_DEFAULT_COUNT}` : `Run on last ${BACKTEST_DEFAULT_COUNT}`}
              </button>
            </form>
          </div>
        </div>

        {(!run || running || run.status === "error" || stalled) && (
          <div class="bt-run">
            {!run && (
              <>
                <p>
                  Replays the last {BACKTEST_DEFAULT_COUNT} messages that <b>started a conversation</b> in the server through Mr Mod's real pipeline (signals, AI
                  judge, your rules, suggested answers) and shows what it would have done to each.
                </p>
                <p class="hint">
                  A message counts as a conversation starter when it isn't a Discord reply, its author hadn't posted in that channel in the previous 10 minutes,
                  and nobody had replied to or @mentioned the author there in those 10 minutes. It's a dry run: nothing is deleted, posted, banned, or sent to
                  #mod-log. It uses the AI judge, so it costs about as much as {BACKTEST_DEFAULT_COUNT} live messages.
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
                              #{r.channelName ?? "channel"} · {ago(r.createdAt)} · conversation starter
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
    await audit(db, c.get("actor"), "admin", "backtest.run", undefined, { count: BACKTEST_DEFAULT_COUNT });
    await db.execute(dsql`SELECT pg_notify('mrmod_cmd', ${JSON.stringify({ type: "backtest", count: BACKTEST_DEFAULT_COUNT, actor: "hub admin" })})`);
    return back("Backtest started. Reading channel history first; this page updates as it goes.");
  });
}
