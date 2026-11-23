/**
 * The HUD served by `base-ai dashboard`, held in memory: nothing is ever served from disk (BASE-101-D1 AC5).
 *
 * BASE-101-D2: `INDEX_HTML` is a static skeleton with no inline script or style, `APP_JS` is the source text of
 * the view and client functions (H1) and `APP_CSS` is built from the tested palette (H8). All three are
 * same-origin, so `Content-Security-Policy: default-src 'self'` holds unchanged. No absolute URL appears here:
 * the inline <svg> gets its namespace from the HTML parser, and the client reads it from that element.
 */
import * as client from "./dashboard-client.js";
import * as view from "./dashboard-view.js";

export const INDEX_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>base-ai dashboard</title>
<link rel="stylesheet" href="/app.css">
<script src="/app.js" defer></script>
</head>
<body>
<header class="top">
<h1>BASE-AI <span class="sub">// PIPELINE CORE</span></h1>
<div id="header-stats" class="header-stats"></div>
<button type="button" class="refresh" data-action="refresh">REFRESH</button>
</header>
<div class="layout">
<nav class="panel queue" data-panel="queue" aria-labelledby="h-queue">
<h2 id="h-queue">TASK QUEUE</h2>
<div id="queue-controls" class="queue-controls"></div>
<p id="queue-error" class="error" role="status"></p>
<ul id="queue-list" class="queue-list" aria-label="Tasks"></ul>
</nav>
<main class="center">
<section class="panel ring-panel" data-panel="ring" aria-labelledby="h-ring">
<h2 id="h-ring" class="sr-only">Pipeline stages</h2>
<svg id="ring" class="ring" viewBox="-80 0 560 400" role="img" aria-label="Pipeline stages"></svg>
<p id="detail-error" class="error" role="status"></p>
</section>
<div class="lower">
<section class="panel" data-panel="rounds" aria-labelledby="h-rounds"><h2 id="h-rounds">ROUNDS</h2><div id="rounds"></div></section>
<section class="panel" data-panel="tokens" aria-labelledby="h-tokens"><h2 id="h-tokens">TOKEN FLOW <span class="note">at current prices</span></h2><div id="tokens"></div></section>
</div>
</main>
<aside class="side">
<section class="panel" data-panel="timeline" aria-labelledby="h-timeline"><h2 id="h-timeline">TIMELINE</h2><div id="timeline"></div></section>
<section class="panel" data-panel="checks" aria-labelledby="h-checks"><h2 id="h-checks">INTEGRITY CHECKS</h2><div id="checks"></div></section>
<section class="panel" data-panel="files" aria-labelledby="h-files"><h2 id="h-files">FILES</h2><div id="files"></div></section>
<section class="panel" data-panel="registration" aria-labelledby="h-registration"><h2 id="h-registration">REGISTRATION <span class="note">checks GitHub with gh on demand</span></h2><div id="registration"></div><p id="registration-error" class="error" role="status"></p></section>
</aside>
</div>
</body>
</html>
`;

/** The functions served in /app.js, in order: every export of both modules (a test proves none is missing). */
export function appFunctions(): ((...args: never[]) => unknown)[] {
  return [
    view.h,
    view.s,
    view.t,
    view.clip,
    view.utcHHMM,
    view.stateKey,
    view.stateLabel,
    view.actorPill,
    view.ringPill,
    view.orderQueue,
    view.matchesQuery,
    view.visibleIds,
    view.queueKey,
    view.queueControlsView,
    view.cardView,
    view.queueListView,
    view.money,
    view.headerStats,
    view.headerView,
    view.ringArcs,
    view.arcPath,
    view.ringView,
    view.timelineRows,
    view.timelineView,
    view.roundRow,
    view.roundsView,
    view.checkCells,
    view.checksView,
    view.compactTokens,
    view.tokenFlow,
    view.tokensView,
    view.keyStatus,
    view.registrationSummary,
    view.registrationView,
    view.editorHref,
    view.filesView,
    view.palette,
    view.contrastRatio,
    client.mount,
    client.place,
    client.showError,
    client.renderHeader,
    client.renderQueue,
    client.renderModes,
    client.renderDetail,
    client.renderAll,
    client.loadJson,
    client.loadDetail,
    client.loadRegistration,
    client.checkRegistrationAction,
    client.refresh,
    client.serialized,
    client.eventId,
    client.setLive,
    client.subscribe,
    client.actionTarget,
    client.onAction,
    client.onKey,
    client.boot,
  ];
}

export const APP_JS = `(function () {
"use strict";
${appFunctions().map(String).join("\n\n")}

boot(window);
})();
`;

function css(): string {
  const c = view.palette();
  const widths = Array.from({ length: 21 }, (_, i) => `.flow-fill.w${i * 5}{width:${i * 5}%}`).join("\n");
  return `:root{color-scheme:dark}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;background:${c.bg};color:${c.text};font:14px/1.4 system-ui,-apple-system,"Segoe UI",sans-serif}
button,input{font:inherit;color:inherit}
button{cursor:pointer}
:focus-visible{outline:2px solid ${c.cyan};outline-offset:2px}
.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
h1,h2{margin:0;letter-spacing:.08em;font-weight:600}
h1{font-size:18px}
h1 .sub,h2 .note{color:${c.muted};font-weight:400}
h2{font-size:13px;margin-bottom:10px}
h2 .note{font-size:11px;letter-spacing:0;margin-left:6px}
.top{display:flex;align-items:center;gap:16px;padding:12px 20px;border-bottom:1px solid ${c.line}}
.header-stats{flex:1;display:flex;gap:18px;justify-content:center;flex-wrap:wrap;font-family:ui-monospace,monospace;font-size:13px}
.header-stats .live-live .dot,.header-stats .live-live{color:${c.green}}
.header-stats .live-reconnecting{color:${c.amber}}
.header-stats .live-offline{color:${c.muted}}
.header-stats .updated{color:${c.muted}}
.refresh{background:${c.panel};border:1px solid ${c.cyan};color:${c.cyan};border-radius:6px;padding:6px 12px;letter-spacing:.08em}
.layout{display:grid;grid-template-columns:300px 1fr 320px;gap:16px;padding:16px 20px}
@media (max-width:1100px){.layout{grid-template-columns:1fr}}
.panel{background:${c.panel};border:1px solid ${c.line};border-radius:10px;padding:14px}
.center,.side{display:flex;flex-direction:column;gap:16px}
.lower{display:grid;grid-template-columns:1fr 1fr;gap:16px}
.error{margin:6px 0;color:${c.red};font-size:12px}
.error:empty{display:none}
.empty{color:${c.muted};list-style:none}
.search{width:100%;padding:7px 10px;background:${c.bg};border:1px solid ${c.line};border-radius:6px}
.search::placeholder{color:${c.muted}}
.modes{display:flex;margin:10px 0;border:1px solid ${c.line};border-radius:999px;overflow:hidden}
.mode{flex:1;background:none;border:0;padding:6px;color:${c.muted};letter-spacing:.08em}
.mode[aria-pressed="true"]{background:${c.line};color:${c.text}}
.queue-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:8px}
.card{width:100%;text-align:left;display:flex;flex-direction:column;gap:4px;padding:10px 12px;background:${c.bg};border:1px solid ${c.line};border-left:4px solid ${c.muted};border-radius:8px;transition:border-color .2s,box-shadow .2s}
.card.state-pending,.card.state-blocked{border-left-color:${c.amber}}
.card.state-in_progress{border-left-color:${c.blue}}
.card.state-completed{border-left-color:${c.cyan}}
.card.state-validated{border-left-color:${c.green}}
.card[aria-current="true"]{border-color:${c.cyan};box-shadow:0 0 12px ${c.cyan}66;animation:pulse 2.4s ease-in-out infinite}
.card-id{font-weight:600;font-family:ui-monospace,monospace}
.card-title{color:${c.muted};font-size:13px}
.pills{display:flex;gap:6px;flex-wrap:wrap;margin-top:2px}
.pill{font-size:11px;letter-spacing:.06em;padding:1px 8px;border-radius:999px;border:1px solid currentColor}
.pill.state-pending,.pill.state-other{color:${c.muted}}
.pill.state-in_progress{color:${c.blue}}
.pill.state-completed{color:${c.cyan}}
.pill.state-validated{color:${c.green}}
.pill.state-blocked,.pill.bad{color:${c.red}}
.pill.actor{color:${c.amber}}
.group-toggle{width:100%;text-align:right;background:${c.bg};border:1px solid ${c.line};border-radius:6px;padding:6px 10px;color:${c.muted};letter-spacing:.06em}
.ring-panel{display:flex;flex-direction:column;align-items:center}
.ring{width:100%;max-width:600px;height:auto}
.ring-track{fill:none;stroke:${c.line};stroke-width:2;stroke-dasharray:2 6}
.ring-core{fill:none;stroke:${c.cyan};stroke-width:6;filter:drop-shadow(0 0 8px ${c.cyan})}
.arc{fill:none;stroke-width:14;stroke-linecap:butt;opacity:.55;transition:opacity .3s}
.arc.selected{opacity:1;filter:drop-shadow(0 0 6px currentColor);animation:glow 2.4s ease-in-out infinite}
.arc.state-pending,.arc.state-blocked{stroke:${c.amber};color:${c.amber}}
.arc.state-in_progress{stroke:${c.blue};color:${c.blue}}
.arc.state-completed{stroke:${c.cyan};color:${c.cyan}}
.arc.state-validated{stroke:${c.green};color:${c.green}}
.arc.state-other{stroke:${c.violet};color:${c.violet}}
.arc-label{font-size:11px;letter-spacing:.06em;font-family:ui-monospace,monospace}
.arc-label.state-pending,.arc-label.state-blocked{fill:${c.amber}}
.arc-label.state-in_progress{fill:${c.blue}}
.arc-label.state-completed{fill:${c.cyan}}
.arc-label.state-validated{fill:${c.green}}
.arc-label.state-other{fill:${c.violet}}
.core-id{fill:${c.text};font-size:26px;font-weight:600;font-family:ui-monospace,monospace}
.core-title{fill:${c.muted};font-size:15px}
.core-pill{fill:${c.amber};font-size:11px;letter-spacing:.02em}
.timeline{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:6px;max-height:320px;overflow:auto}
.tl-row{display:grid;grid-template-columns:44px 1fr;column-gap:8px;padding:4px 6px;border-radius:6px}
.tl-row time{grid-row:span 2;color:${c.muted};font-family:ui-monospace,monospace;font-size:12px}
.tl-agent{font-weight:600;font-size:12px;letter-spacing:.06em}
.tl-label{color:${c.muted};font-size:12px;overflow-wrap:anywhere}
.tl-row.agent-reviewer .tl-agent,.tl-row.agent-qa .tl-agent{color:${c.violet}}
.tl-row.agent-implementer .tl-agent{color:${c.blue}}
.tl-row.agent-supervisor .tl-agent{color:${c.green}}
.tl-row.agent-human .tl-agent,.tl-row.agent-planner .tl-agent{color:${c.amber}}
.tl-row.bad .tl-agent,.tl-row.bad .tl-label{color:${c.red}}
.tl-row.latest{border:1px solid ${c.cyan};box-shadow:0 0 10px ${c.cyan}55}
.rounds{display:flex;flex-direction:column;gap:10px}
.round{margin:0;display:flex;flex-direction:column}
.round-main{font-weight:600}
.round-bind{color:${c.muted};font-size:12px;font-family:ui-monospace,monospace}
.round.good .round-main{color:${c.green}}
.round.bad .round-main{color:${c.red}}
.round.wait .round-main{color:${c.amber}}
.cells{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:repeat(6,1fr);gap:6px}
.cell{aspect-ratio:1.1;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;color:${c.bg};clip-path:polygon(25% 3%,75% 3%,100% 50%,75% 97%,25% 97%,0 50%)}
.cell.pass{background:${c.green}}
.cell.fail{background:${c.red}}
.cell.skip{background:${c.amber}}
.checks-summary{margin:10px 0 0;text-align:center;font-size:12px;color:${c.muted}}
.flow{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:6px}
.flow-row{display:grid;grid-template-columns:90px 1fr auto auto;gap:8px;align-items:center;font-size:12px}
.flow-tokens{font-family:ui-monospace,monospace;color:${c.text}}
.flow-agent{color:${c.muted}}
.flow-bar{height:8px;background:${c.bg};border-radius:4px;overflow:hidden}
.flow-fill{display:block;height:100%;background:${c.cyan};box-shadow:0 0 6px ${c.cyan}}
${widths}
.flow-cost{font-family:ui-monospace,monospace}
.flow-total{display:flex;justify-content:space-between;gap:8px;margin:10px 0 0;padding-top:8px;border-top:1px solid ${c.line};font-weight:600}
.files{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:6px}
.file{display:flex;gap:10px;align-items:center;font-size:12px}
.file-name{flex:1;font-family:ui-monospace,monospace}
.file-open{color:${c.cyan}}
.reg-keys{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:4px;font-size:12px;font-family:ui-monospace,monospace}
.reg-key{overflow-wrap:anywhere;color:${c.muted}}
.reg-key.reg-ok{color:${c.green}}
.reg-key.reg-missing{color:${c.amber}}
.reg-summary{margin:8px 0;font-size:12px;color:${c.text}}
.reg-halt{margin:4px 0;font-size:12px;color:${c.red}}
.reg-check{margin-top:6px;padding:6px 10px;border:1px solid ${c.cyan};border-radius:6px;background:${c.bg};color:${c.cyan}}
.reg-check[disabled]{opacity:.6;cursor:progress}
.file-copy{background:none;border:1px solid ${c.line};border-radius:6px;padding:2px 8px;color:${c.muted}}
@keyframes pulse{50%{box-shadow:0 0 20px ${c.cyan}99}}
@keyframes glow{50%{opacity:.8}}
@media (prefers-reduced-motion: reduce){*,*::before,*::after{animation:none !important;transition:none !important}}
`;
}

export const APP_CSS = css();
