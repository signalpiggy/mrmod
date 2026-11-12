import type { Child, FC } from "hono/jsx";

const CSS = `
:root{--bg:#f7f7f8;--panel:#fff;--ink:#1d1d1f;--muted:#6b6b72;--line:#e3e3e8;--accent:#5b4bdb;--ok:#2f9e44;--warn:#e67700;--bad:#c92a2a;--shadow:#7048e8}
@media (prefers-color-scheme:dark){:root{--bg:#141416;--panel:#1d1d20;--ink:#ececf0;--muted:#9a9aa3;--line:#2e2e33;--accent:#8b7ff0}}
*{box-sizing:border-box}body{margin:0;font:14px/1.5 system-ui,-apple-system,Segoe UI,sans-serif;background:var(--bg);color:var(--ink)}
header{display:flex;gap:16px;align-items:center;flex-wrap:wrap;padding:12px 20px;background:var(--panel);border-bottom:1px solid var(--line)}
header b{font-size:16px}header nav{display:flex;gap:4px;flex-wrap:wrap}header nav a{padding:6px 10px;border-radius:6px;color:var(--ink);text-decoration:none}
header nav a.on,header nav a:hover{background:var(--bg)}header form{margin-left:auto}
main{max-width:1100px;margin:0 auto;padding:20px 16px}
h1{font-size:20px;margin:0 0 16px}h2{font-size:16px;margin:24px 0 8px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:16px;margin-bottom:16px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px}
.stat b{display:block;font-size:22px}.stat span{color:var(--muted)}
table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:8px;border-bottom:1px solid var(--line);vertical-align:top}th{color:var(--muted);font-weight:500}
.wrap{overflow-x:auto}
input,select,textarea{font:inherit;padding:7px 9px;border:1px solid var(--line);border-radius:6px;background:var(--panel);color:var(--ink);width:100%}
textarea{min-height:140px}label{display:block;margin:10px 0 4px;font-weight:500}.hint{color:var(--muted);font-size:12px;margin-top:2px}
button,.btn{font:inherit;padding:7px 14px;border-radius:6px;border:1px solid var(--accent);background:var(--accent);color:#fff;cursor:pointer;text-decoration:none;display:inline-block}
button.ghost{background:transparent;color:var(--accent)}button.small{padding:3px 9px;font-size:12px}
.pill{display:inline-block;padding:1px 8px;border-radius:99px;font-size:12px;border:1px solid var(--line)}
.shadow{color:var(--shadow);border-color:var(--shadow)}.enforce{color:var(--bad);border-color:var(--bad)}.off{color:var(--muted)}
.okc{color:var(--ok)}.warnc{color:var(--warn)}.badc{color:var(--bad)}
.msg{white-space:pre-wrap;word-break:break-word;max-width:420px}
.flash{padding:10px 14px;border-radius:8px;margin-bottom:16px;background:var(--panel);border:1px solid var(--accent)}
.row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
`;

const NAV = [
  ["/", "Overview"],
  ["/decisions", "Message log"],
  ["/rules", "Rules"],
  ["/settings", "Settings"],
  ["/knowledge", "Knowledge"],
  ["/connection", "Connection"],
  ["/audit", "Audit log"],
] as const;

export const Layout: FC<{ title: string; path?: string; flash?: string; authed?: boolean; children?: Child }> = ({ title, path, flash, authed = true, children }) => (
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width,initial-scale=1" />
      <meta name="robots" content="noindex" />
      <title>{`${title} · mrmod`}</title>
      <style dangerouslySetInnerHTML={{ __html: CSS }} />
    </head>
    <body>
      <header>
        <b>mrmod</b>
        {authed && (
          <nav>
            {NAV.map(([href, label]) => (
              <a href={href} class={path === href ? "on" : ""}>
                {label}
              </a>
            ))}
          </nav>
        )}
        {authed && (
          <form method="post" action="/logout">
            <button class="ghost small">Sign out</button>
          </form>
        )}
      </header>
      <main>
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
