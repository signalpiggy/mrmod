import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { Child, FC } from "hono/jsx";

// ---------- self-hosted fonts (no Google Fonts or other outside requests) ----------
const require = createRequire(import.meta.url);
function fontFile(pkg: string, file: string): Buffer | null {
  try {
    return readFileSync(join(dirname(require.resolve(`${pkg}/LICENSE`)), "files", file));
  } catch {
    return null; // falls back to the system font stack
  }
}
export const FONTS: Record<string, Buffer | null> = {
  "inter.woff2": fontFile("@fontsource-variable/inter", "inter-latin-wght-normal.woff2"),
  "bricolage.woff2": fontFile("@fontsource-variable/bricolage-grotesque", "bricolage-grotesque-latin-standard-normal.woff2"),
};

/* "Triage Desk": dark green icon rail, cool grey desk, white cards, coral for danger/primary, mint for good. */
const CSS = `
@font-face{font-family:"Inter";src:url(/fonts/inter.woff2) format("woff2");font-weight:100 900;font-display:swap}
@font-face{font-family:"Bricolage Grotesque";src:url(/fonts/bricolage.woff2) format("woff2");font-weight:200 800;font-display:swap}
:root{
  --bg:#eceef1;--surf:#fff;--surf2:#f6f7f9;--ink:#101418;--muted:#5f6873;--line:#d8dce1;
  --rail:#0f2a26;--railink:#cfe3de;--coral:#ff5a36;--coralbg:#ffe3dc;--coralink:#b42a0c;
  --mint:#19c39c;--mintbg:#dcf6ee;--mintink:#0b6b53;--sky:#2f7bf5;--skybg:#e3edfe;--sun:#ffb000;--sunbg:#fff1cc;--sunink:#7a5200;
  --display:"Bricolage Grotesque","Inter",system-ui,sans-serif;--body:"Inter",system-ui,-apple-system,"Segoe UI",sans-serif;--mono:ui-monospace,"SF Mono",Menlo,Consolas,monospace;
}
@media (prefers-color-scheme:dark){:root{
  --bg:#0c1214;--surf:#151d20;--surf2:#1b2428;--ink:#e8eef0;--muted:#93a0a6;--line:#26323a;
  --rail:#08201c;--coralbg:#3a1a13;--coralink:#ff8a6e;--mintbg:#0f3229;--mintink:#5be0bd;--skybg:#14243d;--sunbg:#352a0d;--sunink:#ffcf5c;color-scheme:dark}}
*{box-sizing:border-box}
[hidden]{display:none!important}
html,body{margin:0}
body{font:14px/1.5 var(--body);background:linear-gradient(to right,var(--rail) 84px,var(--bg) 84px);color:var(--ink);display:grid;grid-template-columns:84px minmax(0,1fr);min-height:100vh}
a{color:var(--sky)}
:focus-visible{outline:2px solid var(--sky);outline-offset:2px}

/* rail */
.rail{background:var(--rail);color:var(--railink);display:flex;flex-direction:column;align-items:center;gap:4px;padding:16px 0;position:sticky;top:0;height:100vh}
.mark{width:44px;height:44px;border-radius:13px;background:var(--coral);color:#fff;display:grid;place-items:center;font:800 19px var(--display);margin-bottom:14px;text-decoration:none}
.rail a.nav{width:64px;padding:8px 0;border-radius:11px;display:grid;justify-items:center;gap:3px;font-size:10.5px;font-weight:500;color:var(--railink);text-decoration:none;opacity:.7}
.rail a.nav:hover{opacity:1;background:rgba(255,255,255,.05)}
.rail a.nav.on{background:rgba(255,255,255,.11);opacity:1;color:#fff}
.rail svg{width:21px;height:21px}
.rail form{margin-top:auto}
.rail .out{all:unset;cursor:pointer;width:64px;padding:8px 0;border-radius:11px;display:grid;justify-items:center;gap:3px;font-size:10.5px;color:var(--railink);opacity:.6}
.rail .out:hover{opacity:1}

/* page */
.page{min-width:0;padding:26px 28px 48px;display:grid;gap:18px;align-content:start;max-width:1180px;width:100%}
.page.bleed{max-width:none;padding:0;gap:0}
h1{font:800 30px/1.1 var(--display);letter-spacing:-.02em;margin:0;text-wrap:balance}
h2{font:700 18px/1.2 var(--display);letter-spacing:-.01em;margin:10px 0 0}
.lbl{font:700 11px var(--display);letter-spacing:.1em;text-transform:uppercase;color:var(--muted)}
.head{display:flex;align-items:center;gap:14px;flex-wrap:wrap}
.head .right{margin-left:auto;display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.card{background:var(--surf);border-radius:18px;padding:20px;display:grid;gap:12px;min-width:0}
.card > *{margin:0}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:14px}
.row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.hint{color:var(--muted);font-size:12.5px}
p{margin:0}
.wrap{overflow-x:auto}

/* stats */
.stat{gap:4px}
.stat b{font:800 30px/1.1 var(--display);letter-spacing:-.02em;font-variant-numeric:tabular-nums}
.stat span{color:var(--muted);font-size:12.5px}

/* tables */
table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums}
th{font:700 11px var(--display);letter-spacing:.08em;text-transform:uppercase;color:var(--muted);text-align:left;padding:0 10px 8px}
td{text-align:left;padding:11px 10px;border-top:1px solid var(--line);vertical-align:top}
tr:hover td{background:var(--surf2)}
td a{color:var(--ink);font-weight:600;text-decoration:none}td a:hover{text-decoration:underline}
.msg{white-space:pre-wrap;word-break:break-word;max-width:460px}

/* forms */
label{display:block;margin:4px 0 5px;font-weight:600;font-size:13px}
label.check{display:flex;gap:9px;align-items:flex-start;font-weight:500;margin:0}
label.check input{width:18px;height:18px;margin:1px 0 0;accent-color:var(--mint);flex:none}
input,select,textarea{font:inherit;padding:9px 11px;border:1px solid var(--line);border-radius:10px;background:var(--surf2);color:var(--ink);width:100%}
input:focus,select:focus,textarea:focus{outline:none;border-color:var(--sky);box-shadow:0 0 0 3px var(--skybg);background:var(--surf)}
textarea{min-height:140px;resize:vertical}
input[type=checkbox]{width:auto;accent-color:var(--mint)}
.field{display:grid;gap:2px;min-width:0;align-content:start}
.checks{display:flex;gap:10px 18px;flex-wrap:wrap}
.chk{display:inline-flex;gap:7px;align-items:center;padding:7px 12px;border-radius:10px;background:var(--surf2);font-weight:500;margin:0;cursor:pointer}
.chk input{margin:0;width:16px;height:16px}
.chk:has(input:checked){background:var(--mintbg);color:var(--mintink)}
.chk.danger:has(input:checked){background:var(--coralbg);color:var(--coralink)}

/* buttons */
button,.btn{font:700 14px var(--display);padding:10px 18px;border-radius:12px;border:0;background:var(--ink);color:var(--surf);cursor:pointer;text-decoration:none;display:inline-flex;align-items:center;gap:8px;justify-content:center}
button:hover,.btn:hover{filter:brightness(1.12)}
button.ghost,.btn.ghost{background:transparent;color:var(--ink);box-shadow:inset 0 0 0 2px var(--line)}
button.ghost:hover{box-shadow:inset 0 0 0 2px var(--ink);filter:none}
button.small,.btn.small{padding:6px 12px;font-size:12.5px;border-radius:9px}
button.mint,.btn.mint{background:var(--mint);color:#04382b}
button.danger,.btn.danger{background:var(--coral);color:#fff}
kbd{font:700 11px var(--mono);padding:2px 6px;border-radius:6px;background:rgba(127,127,127,.18)}

/* pills */
.pill{display:inline-flex;align-items:center;gap:5px;padding:3px 10px;border-radius:99px;font:700 12px var(--display);background:var(--surf2);color:var(--muted);white-space:nowrap;text-decoration:none}
.pill.shadow{background:var(--sunbg);color:var(--sunink)}
.pill.enforce{background:var(--coralbg);color:var(--coralink)}
.pill.off{background:var(--surf2);color:var(--muted)}
.pill.ok{background:var(--mintbg);color:var(--mintink)}
.pill.bad{background:var(--coralbg);color:var(--coralink)}
.pill.warn{background:var(--sunbg);color:var(--sunink)}
.pill.info{background:var(--skybg);color:var(--sky)}
.okc{color:var(--mintink)}.warnc{color:var(--sunink)}.badc{color:var(--coralink)}

.flash{padding:12px 16px;border-radius:14px;background:var(--skybg);color:var(--ink);font-weight:500}
.page.bleed > .flash{margin:16px 22px 0}
.suggest{border:2px solid var(--mint);border-radius:14px;padding:12px 14px;font-size:14px;display:grid;gap:4px;white-space:normal;min-width:0;overflow-wrap:anywhere}
.suggest .k{font:700 11px var(--display);letter-spacing:.08em;text-transform:uppercase;color:var(--mintink)}
.suggest a{color:var(--mintink);font-weight:600}
.suggest.no{border-color:var(--sun)}

/* sign-in / setup */
body.auth{display:grid;grid-template-columns:1fr;place-items:center;background:var(--rail);padding:24px 16px}
.authbox{width:100%;max-width:420px;display:grid;gap:18px}
.authbox .brand{display:flex;align-items:center;gap:12px;color:#fff;font:800 22px var(--display);letter-spacing:-.01em}
.authbox .brand .mark{margin:0}
.authbox .card{padding:26px;gap:14px}

@media (max-width:760px){
  body{grid-template-columns:1fr;grid-template-rows:auto 1fr;background:var(--bg)}
  .rail{flex-direction:row;height:auto;min-height:62px;position:sticky;top:0;z-index:5;padding:8px 10px;overflow-x:auto;overflow-y:hidden;gap:2px}
  .rail a.nav,.rail .out,.mark{flex:none}
  .mark{margin:0 8px 0 0;width:38px;height:38px;flex:none}
  .rail a.nav,.rail .out{width:58px;flex:none}
  .rail form{margin:0 0 0 auto}
  .page{padding:18px 16px 40px}
  h1{font-size:25px}
}
@media (prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important}}
`;

const I = (d: string) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d={d} />
  </svg>
);
const NAV: [string, string, string][] = [
  ["/", "Home", "M4 13h6V4H4zM14 20h6v-9h-6zM14 4h6v3h-6zM4 20h6v-3H4z"],
  ["/decisions", "Log", "M4 6h16M4 12h16M4 18h10"],
  ["/rules", "Rules", "M12 3 4 6v6c0 4.5 3.2 8 8 9 4.8-1 8-4.5 8-9V6z"],
  ["/knowledge", "Help KB", "M5 4h11l3 3v13H5zM9 9h6M9 13h6M9 17h4"],
  ["/settings", "Settings", "M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0M16 4v4M10 10v4M18 16v4"],
  ["/connection", "Keys", "M8 10V7a4 4 0 1 1 8 0v3M5 10h14v10H5z"],
  ["/audit", "Audit", "M12 8v4l3 2M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5"],
];

const Head: FC<{ title: string }> = ({ title }) => (
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <meta name="robots" content="noindex" />
    <meta name="color-scheme" content="light dark" />
    <title>{`${title} · Mr Mod`}</title>
    <link rel="preload" href="/fonts/bricolage.woff2" as="font" type="font/woff2" crossorigin="anonymous" />
    <style dangerouslySetInnerHTML={{ __html: CSS }} />
  </head>
);

export const Layout: FC<{ title: string; path?: string; flash?: string; authed?: boolean; bleed?: boolean; children?: Child }> = ({
  title,
  path,
  flash,
  authed = true,
  bleed = false,
  children,
}) =>
  authed ? (
    <html lang="en">
      <Head title={title} />
      <body>
        <nav class="rail" aria-label="Hub">
          <a class="mark" href="/" aria-label="Mr Mod home">
            M
          </a>
          {NAV.map(([href, label, d]) => (
            <a href={href} class={`nav${path === href ? " on" : ""}`} aria-current={path === href ? "page" : undefined}>
              {I(d)}
              {label}
            </a>
          ))}
          <form method="post" action="/logout">
            <button class="out" title="Sign out">
              {I("M15 4h4v16h-4M10 8l-4 4 4 4M6 12h10")}
              Sign out
            </button>
          </form>
        </nav>
        <main class={`page${bleed ? " bleed" : ""}`}>
          {flash && <div class="flash">{flash}</div>}
          {children}
        </main>
      </body>
    </html>
  ) : (
    <html lang="en">
      <Head title={title} />
      <body class="auth">
        <main class="authbox">
          <div class="brand">
            <span class="mark">M</span>Mr Mod
          </div>
          {flash && <div class="flash">{flash}</div>}
          {children}
        </main>
      </body>
    </html>
  );

export const ModePill: FC<{ mode: string | null | undefined }> = ({ mode }) => <span class={`pill ${mode ?? "off"}`}>{mode ?? "none"}</span>;

export function ago(d: Date | string | null | undefined): string {
  if (!d) return "never";
  const s = (Date.now() - new Date(d).getTime()) / 1000;
  if (s < 90) return `${Math.round(s)}s ago`;
  if (s < 5400) return `${Math.round(s / 60)}m ago`;
  if (s < 129600) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

/** Renders text with bare/angle-bracketed URLs as links, the way Discord shows them. */
const Linked: FC<{ text: string }> = ({ text }) => (
  <>
    {text.split(/(\[[^\]\n]+\]\(<?https?:\/\/[^\s)>]+>?\)|<?https?:\/\/[^\s>]+>?)/g).map((part) => {
      // Discord markdown link [title](<url>) shows the title; bare or <url> shows the URL.
      const md = /^\[([^\]]+)\]\(<?(https?:\/\/[^\s)>]+)>?\)$/.exec(part);
      const url = md ? md[2]! : part.replace(/^<|>$/g, "");
      return /^https?:\/\//.test(url) ? (
        <a href={url} target="_blank" rel="noreferrer">
          {md ? md[1] : url}
        </a>
      ) : (
        part.replace(/^-# /gm, "")
      );
    })}
  </>
);

export const SuggestedAnswerBox: FC<{ a: { answerable: boolean; text: string; error?: string; latencyMs?: number } }> = ({ a }) => (
  <div class={`suggest${a.answerable ? "" : " no"}`}>
    <div class="k">
      Suggested answer · not posted{a.answerable ? "" : " · not found in help centre"}
      {a.latencyMs ? ` · ${(a.latencyMs / 1000).toFixed(1)}s` : ""}
    </div>
    <div style="white-space:pre-wrap">{a.error ? <span class="badc">Couldn't draft: {a.error}</span> : <Linked text={a.text} />}</div>
  </div>
);
