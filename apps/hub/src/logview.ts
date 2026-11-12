// Pieces of the Message log's review-queue view (Triage Desk): kinds, labels, CSS and the small keyboard script.
import type { JudgeVerdict } from "@mrmod/core";

export type Kind = "bad" | "warn" | "info" | "none";

export const TABS: [string, string][] = [
  ["Needs review", "?label=none"],
  ["Caught", "?matched=1"],
  ["Questions", "?matched=q"],
  ["All", ""],
];

/** Colour family for a logged message: scams red, other matches/violations amber, questions blue, the rest grey. */
export function kindOf(d: { verdict: JudgeVerdict | null; ruleId: string | null; suggestedAnswer: unknown }): Kind {
  const v = d.verdict?.verdict;
  if (v === "support_scam" || v === "scam") return "bad";
  if (d.ruleId || (v && v !== "ok")) return "warn";
  if (d.suggestedAnswer || d.verdict?.is_question) return "info";
  return "none";
}

export function prettyVerdict(v: string): string {
  if (v === "ok") return "Fine";
  const s = v.replace(/_/g, " ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export const LOG_CSS = `
.tq-top{display:flex;align-items:center;gap:16px;flex-wrap:wrap;padding:16px 22px;background:var(--surf);border-bottom:1px solid var(--line)}
.tq-top h1{font-size:26px}
.tq-top .right{margin-left:auto;display:flex;gap:8px;align-items:center}
.tq-prog{display:flex;align-items:center;gap:10px;font-size:13px;color:var(--muted)}
.tq-prog .track{width:140px;height:8px;border-radius:99px;background:var(--bg);overflow:hidden}
.tq-prog .track i{display:block;height:100%;background:var(--mint)}
.tq-split{display:grid;grid-template-columns:360px minmax(0,1fr);align-items:start}
.tq-queue{background:var(--surf);border-right:1px solid var(--line);position:sticky;top:0;height:100vh;overflow-y:auto;min-width:0}
.tq-tabs{display:flex;gap:4px;padding:12px 14px;border-bottom:1px solid var(--line);flex-wrap:wrap;align-items:center;position:sticky;top:0;background:var(--surf);z-index:1}
.tq-tabs > a{font:700 12.5px var(--display);padding:6px 11px;border-radius:9px;color:var(--muted);text-decoration:none}
.tq-tabs > a:hover{background:var(--surf2);color:var(--ink)}
.tq-tabs > a.on{background:var(--ink);color:var(--surf)}
.tq-more{margin-left:auto}
.tq-more summary{cursor:pointer;font:700 12.5px var(--display);color:var(--muted);padding:6px 8px;list-style:none}
.tq-more summary::-webkit-details-marker{display:none}
.tq-more summary::after{content:" ▾"}
.tq-more[open]{flex-basis:100%;margin:0}
.tq-filter{display:grid;gap:8px;padding:6px 0 4px}
.tq-filter select{padding:7px 9px}
.tq-note{padding:10px 14px;margin:0;border-bottom:1px solid var(--line)}
.tq-item{display:grid;grid-template-columns:10px minmax(0,1fr) auto;gap:10px;padding:12px 14px;border-bottom:1px solid var(--line);color:var(--ink);text-decoration:none}
.tq-item:hover{background:var(--surf2)}
.tq-item.on{background:var(--coralbg);box-shadow:inset 3px 0 0 var(--coral)}
.tq-item .blk{width:10px;border-radius:3px}
.tq-body{min-width:0;display:grid}
.tq-body b{font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tq-txt{font-size:12.5px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tq-meta{display:grid;justify-items:end;gap:6px;font-size:11.5px;color:var(--muted)}
.tq-meta .dot{width:8px;height:8px;border-radius:50%}
.blk.bad,.dot.bad,.av.bad,.tq-meter i.bad{background:var(--coral)}
.blk.warn,.av.warn,.tq-meter i.warn{background:var(--sun)}
.blk.info,.av.info,.tq-meter i.info{background:var(--sky)}
.blk.none,.av.none,.tq-meter i.none{background:var(--line)}
.dot.ok{background:var(--mint)}
.v-bad{color:var(--coral)}.v-warn{color:var(--sunink)}.v-info{color:var(--sky)}.v-none{color:var(--muted)}
.tq-detail{padding:22px;min-width:0}
.tq-art{display:grid;gap:16px}
.tq-who{display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.tq-who > div:nth-child(2){display:grid;min-width:0}
.tq-who b{font-size:15px}
.tq-who .right{margin-left:auto;display:flex;gap:8px;align-items:center;flex-wrap:wrap;font-size:13px;font-weight:600}
.tq-who .right a{text-decoration:none}
.av{width:44px;height:44px;border-radius:14px;display:grid;place-items:center;color:#fff;font:800 17px var(--display);flex:none}
.av.none{color:var(--muted)}
.tq-quote{margin:0;font:500 21px/1.38 var(--display);letter-spacing:-.01em;white-space:pre-wrap;word-break:break-word}
.tq-vgrid{display:grid;grid-template-columns:minmax(0,1.1fr) minmax(0,1fr);gap:16px;align-items:start}
.tq-vbig{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap}
.tq-vbig b{font:800 32px/1 var(--display);letter-spacing:-.02em}
.tq-vbig > span:not(.pill){font:700 14px var(--display);color:var(--muted)}
.tq-meter{height:12px;border-radius:99px;background:var(--bg);position:relative}
.tq-meter i{display:block;height:100%;border-radius:99px}
.tq-meter u{position:absolute;top:-3px;bottom:-3px;width:2px;background:var(--ink)}
.tq-steps{display:grid;gap:10px}
.tq-step{display:flex;gap:10px;align-items:center;font-weight:600}
.tq-step > div{display:grid}
.tq-step i{width:28px;height:28px;border-radius:9px;flex:none;background:var(--surf2);position:relative}
.tq-step i::after{content:"";position:absolute;inset:9px;border-radius:3px;background:var(--muted)}
.tq-step i.bad{background:var(--coralbg)}.tq-step i.bad::after{background:var(--coral)}
.tq-step i.warn{background:var(--sunbg)}.tq-step i.warn::after{background:var(--sun)}
.tq-step i.info{background:var(--skybg)}.tq-step i.info::after{background:var(--sky)}
.tq-keys{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px}
.tq-keys > *{padding:15px 16px;border-radius:14px;font-size:16px;justify-content:space-between}
.tq-keys .ghost{box-shadow:inset 0 0 0 2px var(--ink)}
.tq-keys kbd{background:rgba(0,0,0,.12)}
.tq-keys .danger kbd{background:rgba(255,255,255,.25)}
@media (max-width:1000px){.tq-split{grid-template-columns:1fr}.tq-queue{position:static;height:auto;max-height:320px;border-right:0;border-bottom:1px solid var(--line)}.tq-vgrid{grid-template-columns:1fr}}
@media (max-width:620px){.tq-keys{grid-template-columns:1fr}.tq-detail{padding:14px}.tq-top{padding:14px 16px}.tq-top .right{margin-left:0}.tq-quote{font-size:18px}}
`;

/** Shows one message at a time (from the #m<id> hash), with j/k to move and c/w/b to review or ban. Works without it: every row stays reachable by link. */
export const LOG_JS = `
(function(){
  var items=[].slice.call(document.querySelectorAll('.tq-item'));
  var arts=[].slice.call(document.querySelectorAll('.tq-art'));
  if(!arts.length)return;
  var cur=0;
  function show(i,scroll){
    if(i<0||i>=arts.length)return;cur=i;
    arts.forEach(function(a,j){a.hidden=j!==i});
    items.forEach(function(it,j){it.classList.toggle('on',j===i);if(j===i){it.setAttribute('aria-current','true');if(scroll)it.scrollIntoView({block:'nearest'})}else it.removeAttribute('aria-current')});
  }
  function fromHash(){var id=location.hash.slice(2);var i=arts.findIndex(function(a){return a.dataset.id===id});show(i<0?0:i,true)}
  items.forEach(function(it,j){it.addEventListener('click',function(e){e.preventDefault();history.replaceState(null,'','#m'+it.dataset.id);show(j,false);if(window.innerWidth<=1000)arts[j].scrollIntoView({block:'start'})})});
  window.addEventListener('hashchange',fromHash);
  document.addEventListener('keydown',function(e){
    if(e.metaKey||e.ctrlKey||e.altKey||/^(INPUT|SELECT|TEXTAREA)$/.test((e.target||{}).tagName||''))return;
    var k=e.key.toLowerCase(),go=null;
    if(k==='j'||k==='arrowdown')go=cur+1;else if(k==='k'||k==='arrowup')go=cur-1;
    if(go!==null){if(go>=0&&go<arts.length){e.preventDefault();history.replaceState(null,'','#m'+arts[go].dataset.id);show(go,true)}return}
    var el=arts[cur].querySelector('[data-key="'+k+'"]');
    if(el){e.preventDefault();el.click()}
  });
  fromHash();
})();
`;
