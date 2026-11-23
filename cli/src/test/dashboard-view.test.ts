import { test } from "node:test";
import assert from "node:assert/strict";
import {
  actorPill,
  arcPath,
  checkCells,
  checksView,
  clip,
  compactTokens,
  contrastRatio,
  editorHref,
  filesView,
  headerStats,
  headerView,
  money,
  orderQueue,
  palette,
  queueControlsView,
  queueKey,
  queueListView,
  registrationSummary,
  registrationView,
  ringArcs,
  ringPill,
  ringView,
  roundRow,
  roundsView,
  stateLabel,
  timelineRows,
  timelineView,
  tokenFlow,
  tokensView,
  utcHHMM,
  visibleIds,
  type QueueState,
  type TaskDetailView,
  type TaskEntryView,
  type Totals,
  type VNode,
} from "../dashboard-view.js";

// Fixtures: plain objects shaped like the D1 API. No file system, no network.
const totals = (o: Partial<Totals> = {}): Totals => ({
  records: 0,
  messages: 0,
  input_tokens: 0,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
  output_tokens: 0,
  cost_usd: null,
  unpriced_records: 0,
  ...o,
});
const entry = (id: string, state: string | null, o: Partial<TaskEntryView> = {}): TaskEntryView => ({
  id,
  title: `${id} title`,
  ticket: id,
  state,
  ok: true,
  problem: null,
  nextActor: { role: "reviewer", round: 2, reason: "review not bound" },
  review: { rounds: 1, verdict: "changes_requested" },
  qa: { rounds: 0, verdict: null },
  updated_at: "2026-01-01T00:00:00Z",
  tokens: totals(),
  usage_error: null,
  ...o,
});
const checks = (n = 18, status = "pass") => Array.from({ length: n }, (_, i) => ({ id: `K${i + 1}`, key: `k.${i + 1}`, status, detail: "" }));
const detail = (o: Partial<TaskDetailView> = {}): TaskDetailView => ({
  id: "TK-1",
  title: "pipeline check",
  ok: true,
  transitions: [
    { from: null, to: "pending", agent: "planner", timestamp: "2026-01-01T02:09:00Z", note: "init" },
    { from: "pending", to: "pending", agent: "human", timestamp: "2026-01-01T02:13:00Z", note: "plan locked" },
    { from: "in_progress", to: "completed", agent: "implementer", timestamp: "2026-01-01T02:21:00Z", note: "done" },
  ],
  checks: checks(),
  facts: {
    state: "completed",
    latestCompletion: "2026-01-01T02:21:00Z",
    review: { rounds: 1, verdict: "changes_requested" },
    qa: { rounds: 0, verdict: null },
    nextActor: { role: "reviewer", round: 2, reason: "review not bound" },
  },
  files: [
    { name: "status.json", path: "/r/.ai/tasks/TK-1/status.json", present: true },
    { name: "plan.md", path: "/r/.ai/tasks/TK-1/plan.md", present: true },
    { name: "qa-report.md", path: "/r/.ai/tasks/TK-1/qa-report.md", present: false },
  ],
  usage: { report: { groups: [], total: totals() } },
  ...o,
});
const Q = (o: Partial<QueueState> = {}): QueueState => ({ query: "", mode: "active", expanded: false, selected: null, ...o });

/** Every node of a tree, depth first. */
function all(n: VNode): VNode[] {
  return "text" in n ? [n] : [n, ...n.children.flatMap(all)];
}
const texts = (n: VNode) => all(n).flatMap((x) => ("text" in x ? [x.text] : []));
const els = (n: VNode, pred: (attrs: Record<string, string>, tag: string) => boolean) =>
  all(n).flatMap((x) => ("text" in x || !pred(x.attrs, x.tag) ? [] : [x]));

test("layout: the trees carry the queue (search, ACTIVE/ALL, cards with state and next actor, validated collapsed), ring, timeline, rounds, 18 cells and token flow", () => {
  const tasks = [entry("TK-1", "completed"), entry("TK-2", "validated"), entry("TK-3", "in_progress", { nextActor: { role: "implementer", reason: "" } })];
  const controls = queueControlsView(Q());
  assert.equal(els(controls, (a, tag) => tag === "input" && a.placeholder === "filter tasks…").length, 1);
  assert.deepEqual(
    els(controls, (a) => a["data-action"] === "mode").map((x) => ("text" in x ? "" : [x.attrs["data-mode"], x.attrs["aria-pressed"]].join("="))),
    ["active=true", "all=false"],
  );
  const list = queueListView(tasks, Q({ selected: "TK-1" }));
  assert.equal(list.tag, "ul");
  const cards = els(list, (a) => a["data-action"] === "select");
  assert.deepEqual(cards.map((c) => ("text" in c ? "" : c.tag + ":" + c.attrs["data-id"])), ["button:TK-1", "button:TK-3"], "validated is not listed while collapsed");
  assert.ok(texts(list).includes("COMPLETED") && texts(list).includes("REVIEWER · R2") && texts(list).includes("IMPLEMENTER"));
  const group = els(list, (a) => a["data-action"] === "toggle-validated")[0];
  assert.ok(!("text" in group) && group.attrs["aria-expanded"] === "false");
  assert.ok(texts(list).includes("VALIDATED (1) ▸"));

  const d = detail();
  assert.equal(ringView(tasks, tasks[0], d).tag, "svg");
  assert.equal(timelineView(d).tag, "ol");
  assert.equal(texts(roundsView(d)).filter((x) => x.startsWith("REVIEW") || x.startsWith("QA")).length, 2);
  assert.equal(els(checksView(d), (a) => (a.class ?? "").startsWith("cell ")).length, 18);
  const flow = tokensView(detail({ usage: { report: { groups: [{ ...totals({ records: 1, input_tokens: 10, cost_usd: 1.27 }), agent: "qa", model: "m" }], total: totals({ records: 1, cost_usd: 1.27 }) } } }));
  assert.ok(texts(flow).includes("TOTAL") && texts(flow).includes("$1.27"));
});

test("queue order and filtering: non-validated by updated_at descending (null last, then id), validated by id; search on id or title", () => {
  const tasks = [
    entry("B", "pending", { updated_at: null }),
    entry("A", "pending", { updated_at: null }),
    entry("C", "completed", { updated_at: "2026-01-02T00:00:00Z" }),
    entry("D", "in_progress", { updated_at: "2026-01-03T00:00:00Z" }),
    entry("Z", "validated"),
    entry("Y", "validated"),
  ];
  const { active, validated } = orderQueue(tasks);
  assert.deepEqual(active.map((x) => x.id), ["D", "C", "A", "B"]);
  assert.deepEqual(validated.map((x) => x.id), ["Y", "Z"]);
  assert.deepEqual(visibleIds(tasks, Q()), ["D", "C", "A", "B"]);
  assert.deepEqual(visibleIds(tasks, Q({ expanded: true })), ["D", "C", "A", "B", "Y", "Z"]);
  assert.deepEqual(visibleIds(tasks, Q({ query: " z TITLE ", expanded: true })), ["Z"], "case-insensitive on the title");
  assert.deepEqual(visibleIds(tasks, Q({ query: "c" })), ["C"]);
  assert.deepEqual(texts(queueListView(tasks, Q({ query: "nothing" }))), ["no match"]);
  assert.deepEqual(texts(queueListView([], Q())), ["no tasks"]);
  const all2 = queueListView(tasks, Q({ mode: "all", expanded: true }));
  assert.ok(texts(all2).includes("VALIDATED (2) ▾"));
});

test("cards: a selected card has aria-current; a failing task gets a ! badge with its problem; title null and actor none are omitted", () => {
  const list = queueListView(
    [entry("TK-1", "completed", { ok: false, problem: "not valid JSON", title: null, nextActor: { role: "none", reason: "" } })],
    Q({ selected: "TK-1" }),
  );
  const btn = els(list, (a) => a["data-action"] === "select")[0];
  assert.ok(!("text" in btn) && btn.attrs["aria-current"] === "true");
  assert.equal(els(list, (a) => a.title === "not valid JSON").length, 1);
  assert.deepEqual(texts(list), ["TK-1", "COMPLETED", "!"]);
});

test("keyboard and semantics: queueKey moves with ↑/↓ clamped, '/' asks for search outside text fields, other keys do nothing", () => {
  assert.deepEqual(queueKey("ArrowDown", 0, 3, false), { action: "focus", index: 1 });
  assert.deepEqual(queueKey("ArrowDown", 2, 3, false), { action: "focus", index: 2 });
  assert.deepEqual(queueKey("ArrowUp", 0, 3, false), { action: "focus", index: 0 });
  assert.deepEqual(queueKey("ArrowUp", 2, 3, false), { action: "focus", index: 1 });
  assert.deepEqual(queueKey("/", -1, 3, false), { action: "search" });
  assert.deepEqual(queueKey("/", 0, 3, true), { action: "none" }, "typing / in the search box stays text");
  assert.deepEqual(queueKey("ArrowDown", -1, 3, false), { action: "none" }, "focus outside the queue");
  assert.deepEqual(queueKey("ArrowDown", 0, 0, false), { action: "none" });
  assert.deepEqual(queueKey("Enter", 1, 3, false), { action: "none" }, "Enter is the native button's");
  assert.deepEqual(queueKey("x", 1, 3, false), { action: "none" });
});

test("ring: arcs per state with counts, at least 6° when non-zero, BLOCKED only when present, the selected arc emphasised; next-actor pill per role", () => {
  const tasks = [entry("P", "pending"), ...Array.from({ length: 30 }, (_, i) => entry(`V${i}`, "validated"))];
  const arcs = ringArcs(tasks, "pending");
  assert.deepEqual(arcs.map((a) => a.label), ["PENDING (1)", "IN PROGRESS (0)", "COMPLETED (0)", "VALIDATED (30)"]);
  const p = arcs[0];
  assert.ok(p.end - p.start >= 6 && p.selected);
  const v = arcs[3];
  assert.ok(Math.abs(p.end - p.start + (v.end - v.start) + 8 - 360) < 1e-9, "two arcs and two gaps fill the circle");
  assert.deepEqual(ringArcs([entry("B", "blocked"), entry("W", "weird")], null).map((a) => a.label).slice(-2), ["BLOCKED (1)", "OTHER (1)"]);
  assert.deepEqual(ringArcs([], null).map((a) => a.count), [0, 0, 0, 0]);
  assert.match(arcPath(200, 200, 150, 0, 360), /^M 200\.00 50\.00 A 150 150 0 1 1 /);

  assert.equal(ringPill({ role: "reviewer", round: 2, reason: "" }), "NEXT ACTOR: REVIEWER · ROUND 2");
  assert.equal(ringPill({ role: "human", reason: "" }), "NEXT ACTOR: HUMAN");
  assert.equal(ringPill({ role: "none", reason: "" }), "NO ACTION");
  assert.equal(ringPill(null), "NO ACTION");
  assert.equal(actorPill({ role: "qa", round: 1, reason: "" }), "QA · R1");
  assert.equal(actorPill(null), null);

  const d = detail();
  const svg = ringView(tasks, tasks[0], { ...d, id: "P" });
  assert.ok(texts(svg).includes("NEXT ACTOR: REVIEWER · ROUND 2") && texts(svg).includes("review not bound"), "the pill's title is the reason");
  assert.match(svg.attrs["aria-label"], /PENDING \(1\).*selected P, NEXT ACTOR: REVIEWER · ROUND 2$/);
  // Review r1 L4: the detail's actor wins in both the pill and the aria-label.
  const fresh = ringView(tasks, tasks[0], { ...d, id: "P", facts: { ...d.facts, nextActor: { role: "qa", round: 1, reason: "no QA round" } } });
  assert.ok(texts(fresh).includes("NEXT ACTOR: QA · ROUND 1"));
  assert.match(fresh.attrs["aria-label"], /NEXT ACTOR: QA · ROUND 1$/);
  assert.deepEqual(texts(ringView([], null, null)), ["no tasks"]);
  assert.deepEqual(texts(ringView(tasks, null, null)).slice(-1), ["select a task"]);
  assert.equal(stateLabel(null), "UNKNOWN");
});

test("timeline: from → to for state changes, the note cut at 60 otherwise, UTC HH:MM, red for blocked, latest highlighted", () => {
  const long = "x".repeat(80);
  const rows = timelineRows([
    { from: "pending", to: "in_progress", agent: "implementer", timestamp: "2026-01-01T02:21:59Z", note: "claim" },
    { from: "completed", to: "completed", agent: "reviewer", timestamp: "2026-01-01T23:05:00Z", note: long },
    { from: "in_progress", to: "blocked", agent: "implementer", timestamp: "bad", note: "stuck" },
    { from: "blocked", to: "blocked", agent: "mallory", timestamp: "2026-01-01T00:00:00Z", note: "?" },
  ]);
  assert.deepEqual(rows.map((r) => r.label), ["pending → in_progress", `${"x".repeat(59)}…`, "in_progress → blocked", "?"]);
  assert.deepEqual(rows.map((r) => r.time), ["02:21", "23:05", "--:--", "00:00"]);
  assert.deepEqual(rows.map((r) => r.tone), ["agent-implementer", "agent-reviewer", "bad", "bad"]);
  assert.equal(timelineRows([{ from: "a", to: "a", agent: "mallory", timestamp: "", note: "" }])[0].tone, "agent-other");
  assert.equal(rows[1].note, long, "the full note is kept for the row's title");
  assert.deepEqual(rows.map((r) => r.latest), [false, false, false, true]);
  assert.deepEqual(texts(timelineView(detail({ transitions: [] }))), ["no transitions"]);
  assert.deepEqual(texts(timelineView(null)), ["no task selected"]);
  assert.equal(utcHHMM("2026-11-23T13:05:51Z"), "13:05");
});

test("rounds: verdict and tone per kind, bound completion, and K10/K14 status read from checks, not recomputed", () => {
  const d = detail({ checks: [...checks(9), { id: "K10", key: "review.binding", status: "fail", detail: "" }, ...checks(3).map((c, i) => ({ ...c, id: `K${11 + i}` })), { id: "K14", key: "qa.binding", status: "skip", detail: "" }] });
  assert.deepEqual(roundRow("review", d), { text: "REVIEW: R1 changes requested", tone: "bad", binding: "bound to 2026-01-01T02:21:00Z · K10 fail" });
  assert.deepEqual(roundRow("qa", d), { text: "QA: R0 pending", tone: "wait", binding: "bound to 2026-01-01T02:21:00Z · K14 skip" });
  const ok = detail({ facts: { ...detail().facts, latestCompletion: null, review: { rounds: 2, verdict: "approved" }, qa: { rounds: 1, verdict: "pass" } }, checks: [] });
  assert.deepEqual([roundRow("review", ok).tone, roundRow("qa", ok).tone], ["good", "good"]);
  assert.equal(roundRow("qa", ok).binding, "no completion · K? n/a");
  assert.equal(roundRow("qa", detail({ facts: { ...detail().facts, qa: { rounds: 1, verdict: "fail" } } })).tone, "bad");
  assert.deepEqual(texts(roundsView(null)), ["no task selected"]);
});

test("check cells: 18 cells in API order with pass/fail/skip classes and the summary; another count is shown as received", () => {
  const c = checks();
  c[6] = { ...c[6], status: "fail", detail: "no completion" };
  c[7] = { ...c[7], status: "skip", detail: "depends on K7" };
  const { cells, summary } = checkCells(c);
  assert.deepEqual(cells.map((x) => x.id), Array.from({ length: 18 }, (_, i) => `K${i + 1}`));
  assert.deepEqual([cells[6].status, cells[7].status, cells[0].status], ["fail", "skip", "pass"]);
  assert.equal(cells[6].label, "K7 k.7: fail — no completion");
  assert.equal(summary, "16 PASS · 1 FAIL · 1 SKIP");
  assert.equal(checkCells(checks(3)).cells.length, 3);
  assert.equal(checkCells([{ id: "K1", key: "k", status: "odd", detail: "" }]).cells[0].status, "skip");
  assert.deepEqual(texts(checksView(null)), ["no task selected"]);
});

test("no usage data / no price: never an error or $0 — empty, unpriced, partly priced, priced, and a usage error", () => {
  const g = (agent: string, o: Partial<Totals>) => ({ ...totals({ records: 1, ...o }), agent, model: "m" });
  assert.deepEqual(tokenFlow({ report: { groups: [], total: totals() } }), { status: "empty", message: "no usage data", rows: [], total: "", totalTokens: 0 });
  assert.deepEqual(texts(tokensView(detail())), ["no usage data"]);

  const unpriced = tokenFlow({ report: { groups: [g("qa", { input_tokens: 5, unpriced_records: 1 })], total: totals({ records: 1, unpriced_records: 1 }) } });
  assert.deepEqual([unpriced.rows[0].cost, unpriced.total], ["no price", "no price"]);
  assert.ok(!JSON.stringify(unpriced).includes("$0"));

  const mixed = tokenFlow({
    report: {
      groups: [g("qa", { input_tokens: 100, cost_usd: 0.21 }), g("qa", { output_tokens: 50, unpriced_records: 1 }), g("planner", { output_tokens: 300, cost_usd: 0.41 })],
      total: totals({ records: 3, cost_usd: 0.62, unpriced_records: 1 }),
    },
  });
  assert.deepEqual(mixed.rows.map((r) => [r.agent, r.tokens, r.cost]), [["planner", 300, "$0.41"], ["qa", 150, "$0.21 + no price"]]);
  assert.deepEqual([mixed.rows[0].share, mixed.rows[1].share, mixed.total], [1, 0.5, "$0.62 + no price"]);

  const err = tokenFlow({ error: ".ai/tasks/TK-1/usage.jsonl cannot be read (EACCES)" });
  assert.equal(err.message, "usage unavailable: .ai/tasks/TK-1/usage.jsonl cannot be read (EACCES)");
  assert.equal(tokenFlow({}).status, "error");
  assert.deepEqual(texts(tokensView(null)), ["no task selected"]);
  assert.equal(money(0, 0), "$0.00", "a priced zero is a real zero");
});

test("header: counts, ACTIVE = not validated, cost at current prices with the no-price rules", () => {
  const tasks = [
    entry("A", "completed", { tokens: totals({ records: 2, cost_usd: 1.2 }) }),
    entry("B", "validated", { tokens: totals({ records: 1, cost_usd: 0.07, unpriced_records: 1 }) }),
    entry("C", "pending", { tokens: null, usage_error: "x" }),
  ];
  assert.deepEqual(headerStats(tasks), { tasks: 3, active: 2, cost: "$1.27 + no price at current prices" });
  assert.equal(headerStats([entry("A", "pending", { tokens: totals({ records: 1, unpriced_records: 1 }) })]).cost, "no price");
  assert.equal(headerStats([entry("A", "pending")]).cost, "no usage data");
  const v = headerView(tasks, "127.0.0.1:4747", "13:05:51 UTC", "live");
  assert.deepEqual(texts(v), ["●", " LIVE 127.0.0.1:4747", "updated 13:05:51 UTC", "3 TASKS · 2 ACTIVE · $1.27 + no price at current prices"]);
  assert.ok(texts(headerView([], "h", null, "offline")).includes("not loaded"));
});

test("D3 H5: the header shows LIVE, RECONNECTING or OFFLINE as text with a class per state; LIVE only when live", () => {
  for (const [live, label] of [["live", "LIVE"], ["reconnecting", "RECONNECTING"], ["offline", "OFFLINE"]] as const) {
    const v = headerView([], "127.0.0.1:4747", null, live);
    const where = v.children[0];
    assert.ok(!("text" in where) && where.attrs.class === `where live-${live}`, live);
    assert.ok(texts(v).includes(` ${label} 127.0.0.1:4747`), live);
    if (live !== "live") assert.ok(!texts(v).some((x) => /(^|\s)LIVE\b/.test(x)), `${live} never claims LIVE`);
  }
});

test("file links: one row per present file with an editor link (vscode://file/<abs>, configurable) and a copy-path button; no file text", () => {
  const v = filesView(detail(), "vscode://file/{path}", { "/r/.ai/tasks/TK-1/plan.md": "copied" });
  const links = els(v, (_a, tag) => tag === "a").map((x) => ("text" in x ? "" : x.attrs.href));
  assert.deepEqual(links, ["vscode://file/r/.ai/tasks/TK-1/status.json", "vscode://file/r/.ai/tasks/TK-1/plan.md"], "D1: no double slash");
  assert.deepEqual(els(v, (a) => a["data-action"] === "copy").map((x) => ("text" in x ? "" : x.attrs["data-path"])), ["/r/.ai/tasks/TK-1/status.json", "/r/.ai/tasks/TK-1/plan.md"]);
  assert.deepEqual(texts(v), ["status.json", "open", "copy path", "plan.md", "open", "copied"]);
  assert.equal(editorHref("cursor://file/{path}:1", "/a b/#x?.md"), "cursor://file/a%20b/%23x%3F.md:1");
  assert.equal(editorHref("vscode://file/{path}", "//srv/x.md"), "vscode://file/srv/x.md");
  assert.equal(editorHref("vscode://file/{path}", "C:\\work\\t.md"), "vscode://file/C%3A/work/t.md");
  assert.deepEqual(texts(filesView(detail(), null, {})), ["status.json", "copy path", "plan.md", "copy path"], "no template, no link");
  assert.deepEqual(texts(filesView(detail({ files: [] }), "x:{path}", {})), ["no files"]);
  assert.deepEqual(texts(filesView(null, "x:{path}", {})), ["no task selected"]);
});

test("hostile task text: <script>alert(1)</script> in a note, title, check detail, agent, id or problem is only ever a text node or an attribute value", () => {
  const evil = "<script>alert(1)</script>";
  const e = entry(evil, "completed", { title: evil, problem: evil, ok: false });
  const d = detail({
    id: evil,
    title: evil,
    transitions: [{ from: "a", to: "a", agent: evil, timestamp: evil, note: evil }],
    checks: [{ id: "K1", key: evil, status: "fail", detail: evil }],
    files: [{ name: evil, path: evil, present: true }],
    usage: { report: { groups: [{ ...totals({ records: 1, input_tokens: 1 }), agent: evil, model: evil }], total: totals({ records: 1 }) } },
  });
  const trees: VNode[] = [
    queueListView([e], Q({ selected: evil })),
    ringView([e], e, d),
    timelineView(d),
    roundsView(d),
    checksView(d),
    tokensView(d),
    filesView(d, "vscode://file/{path}", {}),
    headerView([e], evil, evil, "live"),
  ];
  for (const tree of trees) {
    for (const n of all(tree)) {
      if ("text" in n) continue;
      assert.ok(/^[a-z][a-z0-9-]*$/.test(n.tag), `tag ${n.tag} is a fixed name`);
      for (const name of Object.keys(n.attrs)) assert.ok(!/^on/i.test(name), `no event attribute ${name}`);
    }
  }
  // Where the task text is shown, it is literal: in a text node, or in an attribute value (title, aria-label, data-*).
  for (const tree of [trees[0], trees[2], trees[5], trees[6]]) assert.ok(texts(tree).some((x) => x.includes(evil)), "shown as text");
  const attrValues = all(trees[4]).flatMap((n) => ("text" in n ? [] : Object.values(n.attrs)));
  assert.ok(attrValues.some((v) => v.includes(evil)), "a check detail is an attribute value");
  assert.ok(texts(trees[1]).some((x) => x.startsWith("<script>alert(1)</scr")), "the ring shows the id literally, clipped");
  assert.equal(clip(evil, 10), "<script>a…");
});

test("palette: every text colour meets AA (4.5:1) on both backgrounds, and the dark cell text on every cell colour", () => {
  const c = palette();
  for (const fg of ["text", "muted", "cyan", "green", "red", "amber", "blue", "violet"]) {
    for (const bg of ["bg", "panel"]) assert.ok(contrastRatio(c[fg], c[bg]) >= 4.5, `${fg} on ${bg}: ${contrastRatio(c[fg], c[bg]).toFixed(2)}`);
  }
  for (const cell of ["green", "red", "amber"]) assert.ok(contrastRatio(c.bg, c[cell]) >= 4.5, `bg on ${cell}`);
  assert.equal(Math.round(contrastRatio("#000000", "#ffffff")), 21);
  assert.equal(contrastRatio("#777777", "#777777"), 1);
});

test("D4 H11 compactTokens: 388 tok, 575.6K tok, 11.2M tok, with the K-to-M switch at 999,950", () => {
  const cases: [number, string][] = [
    [0, "0 tok"],
    [388, "388 tok"],
    [999, "999 tok"],
    [1000, "1.0K tok"],
    [575_600, "575.6K tok"],
    [999_949, "999.9K tok"],
    [999_950, "1.0M tok"],
    [11_234_567, "11.2M tok"],
  ];
  for (const [n, out] of cases) assert.equal(compactTokens(n), out, String(n));
});

test("D4 H11 visible tokens: every row and TOTAL show a tok count, with and without prices; the cost text is unchanged; the tooltip splits the four counters", () => {
  const g = (agent: string, o: Partial<Totals>) => ({ ...totals({ records: 1, ...o }), agent, model: "m" });
  const report = (cost: number | null, unpriced: number) => ({
    groups: [
      g("coordinator", { input_tokens: 388, cache_creation_input_tokens: 823_288, cache_read_input_tokens: 10_000_000, output_tokens: 61_093, cost_usd: cost, unpriced_records: unpriced }),
      g("qa", { input_tokens: 12, cache_creation_input_tokens: 0, cache_read_input_tokens: 575_000, output_tokens: 588, cost_usd: cost === null ? null : 0.21, unpriced_records: unpriced }),
    ],
    total: totals({ records: 2, input_tokens: 400, cache_creation_input_tokens: 823_288, cache_read_input_tokens: 10_575_000, output_tokens: 61_681, cost_usd: cost === null ? null : cost + 0.21, unpriced_records: unpriced * 2 }),
  });
  for (const [cost, unpriced, totalText] of [[1.06, 0, "$1.27"], [null, 1, "no price"]] as const) {
    const flow = tokenFlow({ report: report(cost, unpriced) });
    assert.equal(flow.totalTokens, 400 + 823_288 + 10_575_000 + 61_681, "totalTokens is the four-counter sum");
    assert.deepEqual(
      flow.rows.map((r) => [r.agent, r.input, r.cacheWrite, r.cacheRead, r.output]),
      [
        ["coordinator", 388, 823_288, 10_000_000, 61_093],
        ["qa", 12, 0, 575_000, 588],
      ],
    );
    const v = tokensView(detail({ usage: { report: report(cost, unpriced) } }));
    const out = texts(v);
    assert.ok(out.includes("10.9M tok") && out.includes("575.6K tok"), `row counts: ${out.join("|")}`);
    assert.ok(out.includes("11.5M tok"), "TOTAL count");
    assert.equal(out.at(-1), totalText, "the total cost text is unchanged");
    const spans = all(v).filter((n): n is Exclude<VNode, { text: string }> => !("text" in n) && n.attrs.class === "flow-tokens");
    assert.equal(spans.length, 3, "a count on both rows and on TOTAL");
    assert.equal(spans[0].attrs.title, "input 388 · cache write 823288 · cache read 10000000 · output 61093");
  }
  const partly = tokenFlow({ report: report(0.21, 1) });
  assert.equal(partly.rows[1].cost, "$0.21 + no price");
});

test("D4 registration panel: per-key status as text, the summary line, the halt text, the button, and no button without keys", () => {
  const keys = [
    { key: "reg TK-1 review r1 i1", file: "review-report.md", line: 10 },
    { key: "reg TK-1 review r1 i2", file: "review-report.md", line: 11 },
    { key: "reg TK-1 qa r1 i1", file: "qa-report.md", line: 4 },
  ];
  assert.deepEqual(texts(registrationView([], null, "idle")), ["no keys to register"]);
  assert.deepEqual(texts(registrationView(null, null, "idle")), ["no task selected"], "no detail loaded yet");
  const fresh = texts(registrationView(keys, null, "idle"));
  assert.ok(fresh.includes("reg TK-1 review r1 i1 · review-report.md:10 · not checked"));
  assert.ok(fresh.includes("not checked yet") && fresh.includes("CHECK REGISTRATION"));
  assert.equal(registrationSummary({ schema: 1, checkedAt: null }), "not checked yet");

  const result = {
    schema: 1 as const,
    checkedAt: "2026-11-23T16:05:09.000Z",
    outcome: "missing" as const,
    calls: 3,
    keys: [
      { key: "reg TK-1 review r1 i1", status: "registered", issue: 104, state: "open" },
      { key: "reg TK-1 review r1 i2", status: "missing" },
    ],
  };
  const out = texts(registrationView(keys, result, "idle"));
  assert.ok(out.includes("reg TK-1 review r1 i1 · review-report.md:10 · registered #104 (open)"));
  assert.ok(out.includes("reg TK-1 review r1 i2 · review-report.md:11 · missing"));
  assert.ok(out.includes("reg TK-1 qa r1 i1 · qa-report.md:4 · not checked"), "a key the result lacks");
  assert.ok(out.includes("MISSING · 3 gh call(s) · checked 16:05:09"));
  const closed = { ...result, outcome: "registered" as const, keys: [{ key: "reg TK-1 review r1 i1", status: "registered", issue: 7, state: "closed" }] };
  assert.ok(texts(registrationView(keys.slice(0, 1), closed, "idle")).includes("reg TK-1 review r1 i1 · review-report.md:10 · registered #7 (closed)"));
  assert.ok(registrationSummary(closed).startsWith("REGISTERED · "));

  const halt = { schema: 1 as const, checkedAt: "2026-11-23T16:05:09Z", outcome: "halt" as const, calls: 0, halt: { template: "T6", reason: "missing", text: "gh: command not found" }, keys: [{ key: "reg TK-1 review r1 i1", status: "unchecked" }] };
  const h = texts(registrationView(keys.slice(0, 1), halt, "idle"));
  assert.ok(h.includes("gh: command not found") && h.includes("reg TK-1 review r1 i1 · review-report.md:10 · unchecked"));
  assert.ok(h.some((x) => x.startsWith("HALT · 0 gh call(s)")));

  const running = registrationView(keys, null, "running");
  const button = all(running).find((n): n is Exclude<VNode, { text: string }> => !("text" in n) && n.tag === "button");
  assert.equal(button?.attrs.disabled, "");
  assert.equal(button?.attrs["data-action"], "registration");
  assert.ok(texts(running).includes("CHECKING…"));
  // Review r1 L2: while another task's check runs, this task's button is disabled and says why.
  const busy = registrationView(keys, null, "busy");
  const busyButton = all(busy).find((n): n is Exclude<VNode, { text: string }> => !("text" in n) && n.tag === "button");
  assert.equal(busyButton?.attrs.disabled, "");
  assert.ok(texts(busy).includes("ANOTHER CHECK RUNNING"));
});

test("D4 registration panel: hostile key or file text stays a text node", () => {
  const evilKey = "<b>reg</b><img src=x onerror=alert(1)>";
  const v = registrationView([{ key: evilKey, file: "<i>f</i>", line: 1 }], { schema: 1, checkedAt: "2026-11-23T16:05:09Z", outcome: "missing", calls: 1, keys: [{ key: evilKey, status: "missing" }] }, "idle");
  assert.ok(texts(v).includes(`${evilKey} · <i>f</i>:1 · missing`));
  assert.ok(!all(v).some((n) => !("text" in n) && ["b", "img", "i"].includes(n.tag)), "no element built from the text");
});
