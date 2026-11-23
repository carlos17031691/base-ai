/**
 * Pure view models of the `base-ai dashboard` HUD (BASE-101-D2, epic #101).
 *
 * This module is served to the browser as the source text of its functions (H1): it may hold only exported
 * function declarations and type declarations. A module-level value or a runtime import would break /app.js;
 * the `node:vm` boot test in dashboard-client.test.ts catches that before merge.
 *
 * Every function returns data or a node tree `{ tag, attrs, children }` / `{ text }`. Task strings only ever
 * become `{ text }` nodes or attribute values, never markup. No pipeline rule lives here: states, verdicts,
 * binding and the next actor come from the API as computed by `pipeline check`.
 */

export type VNode = VElement | VText;
export interface VElement {
  tag: string;
  ns?: "svg";
  attrs: Record<string, string>;
  children: VNode[];
}
export interface VText {
  text: string;
}

export interface Totals {
  records: number;
  messages: number;
  input_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  output_tokens: number;
  cost_usd: number | null;
  unpriced_records: number;
}
export interface NextActorView {
  role: string;
  round?: number;
  reason: string;
}
export interface TaskEntryView {
  id: string;
  title: string | null;
  ticket: string | null;
  state: string | null;
  ok: boolean;
  problem: string | null;
  nextActor: NextActorView | null;
  review: { rounds: number; verdict: string | null } | null;
  qa: { rounds: number; verdict: string | null } | null;
  updated_at: string | null;
  tokens: Totals | null;
  usage_error: string | null;
}
export interface CheckView {
  id: string;
  key: string;
  status: string;
  detail: string;
}
export interface TransitionView {
  from: string | null;
  to: string;
  agent: string;
  timestamp: string;
  note: string;
}
export interface UsageView {
  report?: { groups: (Totals & { agent: string; model: string })[]; total: Totals };
  error?: string;
}
export interface TaskDetailView {
  id: string;
  title: string | null;
  ok: boolean;
  transitions: TransitionView[];
  checks: CheckView[];
  facts: {
    state: string | null;
    latestCompletion: string | null;
    review: { rounds: number; verdict: string | null };
    qa: { rounds: number; verdict: string | null };
    nextActor: NextActorView;
  };
  files: { name: string; path: string; present: boolean }[];
  usage: UsageView;
}
export interface QueueState {
  query: string;
  mode: "active" | "all";
  expanded: boolean;
  selected: string | null;
}
export type KeyAction = { action: "focus"; index: number } | { action: "search" } | { action: "none" };

/** An HTML element node. */
export function h(tag: string, attrs: Record<string, string>, children: VNode[] = []): VElement {
  return { tag, attrs, children };
}

/** An SVG element node. */
export function s(tag: string, attrs: Record<string, string>, children: VNode[] = []): VElement {
  return { tag, ns: "svg", attrs, children };
}

/** A text node: the only way task text enters the tree. */
export function t(text: string): VText {
  return { text };
}

/** `text` cut to `max` characters (code points) with a trailing ellipsis. */
export function clip(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : text;
}

/** `HH:MM` in UTC of an ISO timestamp, or "--:--". */
export function utcHHMM(ts: string): string {
  const m = /T(\d\d):(\d\d)/.exec(ts);
  return m === null ? "--:--" : `${m[1]}:${m[2]}`;
}

/** A CSS class suffix for a state; unknown states get "other". */
export function stateKey(state: string | null): string {
  const known = ["pending", "in_progress", "completed", "validated", "blocked"];
  return state !== null && known.includes(state) ? state : "other";
}

/** Upper-case label of a state ("in_progress" → "IN PROGRESS"). */
export function stateLabel(state: string | null): string {
  return state === null ? "UNKNOWN" : state.replace(/_/g, " ").toUpperCase();
}

/** The queue card's next-actor pill ("REVIEWER · R2"), or null for `none` or no actor. */
export function actorPill(actor: NextActorView | null): string | null {
  if (actor === null || actor.role === "none") return null;
  const role = actor.role.toUpperCase();
  return actor.round === undefined ? role : `${role} · R${actor.round}`;
}

/** The ring centre's pill: "NEXT ACTOR: REVIEWER · ROUND 2", or "NO ACTION". */
export function ringPill(actor: NextActorView | null): string {
  if (actor === null || actor.role === "none") return "NO ACTION";
  const role = actor.role.toUpperCase();
  return `NEXT ACTOR: ${actor.round === undefined ? role : `${role} · ROUND ${actor.round}`}`;
}

/** Queue order: non-validated by `updated_at` descending (null last, then id); validated by id. */
export function orderQueue(tasks: TaskEntryView[]): { active: TaskEntryView[]; validated: TaskEntryView[] } {
  const byId = (a: TaskEntryView, b: TaskEntryView) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const active = tasks.filter((x) => x.state !== "validated");
  const validated = tasks.filter((x) => x.state === "validated").sort(byId);
  active.sort((a, b) => {
    if (a.updated_at === b.updated_at) return byId(a, b);
    if (a.updated_at === null) return 1;
    if (b.updated_at === null) return -1;
    return a.updated_at < b.updated_at ? 1 : -1;
  });
  return { active, validated };
}

/** Case-insensitive substring match on id or title; an empty query matches everything. */
export function matchesQuery(task: TaskEntryView, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (q === "") return true;
  return task.id.toLowerCase().includes(q) || (task.title ?? "").toLowerCase().includes(q);
}

/** The ids of the queue buttons in visible order: the keyboard walks exactly these. */
export function visibleIds(tasks: TaskEntryView[], q: QueueState): string[] {
  const { active, validated } = orderQueue(tasks.filter((x) => matchesQuery(x, q.query)));
  return [...active, ...(q.expanded ? validated : [])].map((x) => x.id);
}

/**
 * The keyboard rule of the queue. ↑/↓ move between visible cards, clamped; "/" focuses the search unless the
 * focus is already in a text field. Enter is left to the native button.
 */
export function queueKey(key: string, index: number, count: number, inTextField: boolean): KeyAction {
  if (key === "/" && !inTextField) return { action: "search" };
  if (inTextField || count === 0 || index < 0) return { action: "none" };
  if (key === "ArrowDown") return { action: "focus", index: Math.min(index + 1, count - 1) };
  if (key === "ArrowUp") return { action: "focus", index: Math.max(index - 1, 0) };
  return { action: "none" };
}

/** The search box and the ACTIVE/ALL toggle. */
export function queueControlsView(q: QueueState): VElement {
  const mode = (m: "active" | "all", label: string) =>
    h("button", { type: "button", class: "mode", "data-action": "mode", "data-mode": m, "aria-pressed": String(q.mode === m) }, [t(label)]);
  return h("div", { class: "queue-controls" }, [
    h("input", { type: "search", id: "search", class: "search", placeholder: "filter tasks…", "aria-label": "Filter tasks by id or title", autocomplete: "off" }),
    h("div", { class: "modes", role: "group", "aria-label": "Task filter" }, [mode("active", "ACTIVE"), mode("all", "ALL")]),
  ]);
}

/** One queue card: a button with the id, title, state pill and next-actor pill. */
export function cardView(task: TaskEntryView, selected: boolean): VElement {
  const pills: VNode[] = [h("span", { class: `pill state-${stateKey(task.state)}` }, [t(stateLabel(task.state))])];
  const actor = actorPill(task.nextActor);
  if (actor !== null) pills.push(h("span", { class: "pill actor" }, [t(actor)]));
  if (!task.ok) pills.push(h("span", { class: "pill bad", title: task.problem ?? "a check fails", "aria-label": "a check fails" }, [t("!")]));
  const attrs: Record<string, string> = { type: "button", class: `card state-${stateKey(task.state)}`, "data-action": "select", "data-id": task.id };
  if (selected) attrs["aria-current"] = "true";
  const body: VNode[] = [h("span", { class: "card-id" }, [t(task.id)])];
  if (task.title !== null) body.push(h("span", { class: "card-title" }, [t(task.title)]));
  body.push(h("span", { class: "pills" }, pills));
  return h("li", {}, [h("button", attrs, body)]);
}

/** The queue list: active cards, then the VALIDATED disclosure and, when expanded, the validated cards. */
export function queueListView(tasks: TaskEntryView[], q: QueueState): VElement {
  const { active, validated } = orderQueue(tasks.filter((x) => matchesQuery(x, q.query)));
  const items: VNode[] = active.map((x) => cardView(x, x.id === q.selected));
  if (validated.length > 0) {
    items.push(
      h("li", { class: "group" }, [
        h("button", { type: "button", class: "group-toggle", "data-action": "toggle-validated", "aria-expanded": String(q.expanded) }, [
          t(`VALIDATED (${validated.length}) ${q.expanded ? "▾" : "▸"}`),
        ]),
      ]),
    );
    if (q.expanded) for (const x of validated) items.push(cardView(x, x.id === q.selected));
  }
  if (items.length === 0) items.push(h("li", { class: "empty" }, [t(tasks.length === 0 ? "no tasks" : "no match")]));
  return h("ul", { class: "queue-list", "aria-label": "Tasks" }, items);
}

/** `$x.xx` with the "no price" rules: never `$0.00` for something unpriced. */
export function money(cost: number | null, unpriced: number): string {
  if (cost === null) return "no price";
  return unpriced > 0 ? `$${cost.toFixed(2)} + no price` : `$${cost.toFixed(2)}`;
}

/** The header counts and the recorded cost of all tasks at current prices (H5). */
export function headerStats(tasks: TaskEntryView[]): { tasks: number; active: number; cost: string } {
  let cost = 0;
  let priced = false;
  let unpriced = 0;
  for (const x of tasks) {
    if (x.tokens === null) continue;
    if (x.tokens.cost_usd !== null) {
      cost += x.tokens.cost_usd;
      priced = true;
    }
    unpriced += x.tokens.unpriced_records;
  }
  const label = priced ? `${money(cost, unpriced)} at current prices` : unpriced > 0 ? "no price" : "no usage data";
  return { tasks: tasks.length, active: tasks.filter((x) => x.state !== "validated").length, cost: label };
}

/** The header's status line. */
export function headerView(tasks: TaskEntryView[], host: string, updated: string | null): VElement {
  const st = headerStats(tasks);
  return h("div", { class: "header-stats" }, [
    h("span", { class: "where" }, [h("span", { class: "dot", "aria-hidden": "true" }, [t("●")]), t(` ${host}`)]),
    h("span", { class: "updated" }, [t(updated === null ? "not loaded" : `updated ${updated}`)]),
    h("span", { class: "totals" }, [t(`${st.tasks} TASKS · ${st.active} ACTIVE · ${st.cost}`)]),
  ]);
}

/** Ring arcs: one per state with a count, proportional, at least 6° when non-zero, 4° gaps. */
export function ringArcs(tasks: TaskEntryView[], selectedState: string | null): {
  state: string;
  label: string;
  count: number;
  start: number;
  end: number;
  selected: boolean;
}[] {
  const order = ["pending", "in_progress", "completed", "validated", "blocked", "other"];
  const counts = new Map<string, number>(order.map((k) => [k, 0]));
  for (const x of tasks) counts.set(stateKey(x.state), (counts.get(stateKey(x.state)) ?? 0) + 1);
  const shown = order.filter((k) => (counts.get(k) ?? 0) > 0 || ["pending", "in_progress", "completed", "validated"].includes(k));
  const nonZero = shown.filter((k) => (counts.get(k) ?? 0) > 0);
  const total = tasks.length;
  const gap = nonZero.length > 1 ? 4 : 0;
  const free = 360 - gap * nonZero.length - 6 * nonZero.length;
  let at = 0;
  return shown.map((k) => {
    const n = counts.get(k) ?? 0;
    const sweep = n === 0 ? 0 : 6 + (free * n) / total;
    const arc = { state: k, label: `${stateLabel(k)} (${n})`, count: n, start: at, end: at + sweep, selected: k === stateKey(selectedState) && n > 0 };
    if (n > 0) at += sweep + gap;
    return arc;
  });
}

/** An SVG arc path on a circle, angles in degrees clockwise from 12 o'clock. */
export function arcPath(cx: number, cy: number, r: number, a0: number, a1: number): string {
  const p = (a: number) => {
    const rad = ((a - 90) * Math.PI) / 180;
    return `${(cx + r * Math.cos(rad)).toFixed(2)} ${(cy + r * Math.sin(rad)).toFixed(2)}`;
  };
  const end = a1 - a0 >= 360 ? a1 - 0.01 : a1;
  return `M ${p(a0)} A ${r} ${r} 0 ${end - a0 > 180 ? 1 : 0} 1 ${p(end)}`;
}

/** The stage ring with the selected task at its centre. No satellites (D5). */
export function ringView(tasks: TaskEntryView[], selected: TaskEntryView | null, detail: TaskDetailView | null): VElement {
  const arcs = ringArcs(tasks, selected?.state ?? null);
  const label = arcs.map((a) => a.label).join(", ");
  // Review r1 L4: one actor for the pill and the aria-label: the detail's when it is the selected task's.
  const actor = selected === null ? null : detail?.id === selected.id ? detail.facts.nextActor : selected.nextActor;
  const children: VNode[] = [s("circle", { class: "ring-track", cx: "200", cy: "200", r: "150" })];
  for (const a of arcs) {
    if (a.count === 0) continue;
    children.push(s("path", { class: `arc state-${a.state}${a.selected ? " selected" : ""}`, d: arcPath(200, 200, 150, a.start, a.end) }));
    // Outside the arc, anchored away from the ring so a long label never crosses it.
    const mid = ((a.start + a.end) / 2 - 90) * (Math.PI / 180);
    const cos = Math.cos(mid);
    const lx = (200 + 176 * cos).toFixed(1);
    const ly = (200 + 176 * Math.sin(mid)).toFixed(1);
    const anchor = cos > 0.3 ? "start" : cos < -0.3 ? "end" : "middle";
    children.push(s("text", { class: `arc-label state-${a.state}`, x: lx, y: ly, "text-anchor": anchor, "dominant-baseline": "middle" }, [t(a.label)]));
  }
  children.push(s("circle", { class: "ring-core", cx: "200", cy: "200", r: "118" }));
  if (selected === null) {
    children.push(s("text", { class: "core-id", x: "200", y: "205", "text-anchor": "middle" }, [t(tasks.length === 0 ? "no tasks" : "select a task")]));
  } else {
    children.push(s("text", { class: "core-id", x: "200", y: "188", "text-anchor": "middle" }, [t(clip(selected.id, 22))]));
    if (selected.title !== null) children.push(s("text", { class: "core-title", x: "200", y: "214", "text-anchor": "middle" }, [t(clip(selected.title, 26))]));
    children.push(
      s("text", { class: "core-pill", x: "200", y: "244", "text-anchor": "middle" }, [s("title", {}, [t(actor?.reason ?? "")]), t(ringPill(actor))]),
    );
  }
  const summary = selected === null ? label : `${label}; selected ${selected.id}, ${ringPill(actor)}`;
  return s("svg", { class: "ring", viewBox: "-80 0 560 400", role: "img", "aria-label": summary }, children);
}

/** Timeline rows: state changes as `from → to`, other entries as the note cut to 60 characters. */
export function timelineRows(transitions: TransitionView[]): { time: string; full: string; agent: string; label: string; note: string; tone: string; latest: boolean }[] {
  return transitions.map((x, i) => ({
    time: utcHHMM(x.timestamp),
    full: x.timestamp,
    agent: x.agent.toUpperCase(),
    label: x.from !== x.to ? `${x.from ?? "∅"} → ${x.to}` : clip(x.note, 60),
    note: x.note,
    tone: x.to === "blocked" ? "bad" : `agent-${["planner", "human", "implementer", "reviewer", "qa", "supervisor", "coordinator"].includes(x.agent) ? x.agent : "other"}`,
    latest: i === transitions.length - 1,
  }));
}

export function timelineView(detail: TaskDetailView | null): VElement {
  if (detail === null) return h("ol", { class: "timeline" }, [h("li", { class: "empty" }, [t("no task selected")])]);
  const rows = timelineRows(detail.transitions);
  if (rows.length === 0) return h("ol", { class: "timeline" }, [h("li", { class: "empty" }, [t("no transitions")])]);
  return h(
    "ol",
    { class: "timeline" },
    rows.map((r) =>
      h("li", { class: `tl-row ${r.tone}${r.latest ? " latest" : ""}`, title: r.note }, [
        h("time", { datetime: r.full, title: r.full }, [t(r.time)]),
        h("span", { class: "tl-agent" }, [t(r.agent)]),
        h("span", { class: "tl-label" }, [t(r.label)]),
      ]),
    ),
  );
}

/** One ROUNDS line; the binding status is K10 (review) or K14 (QA) as reported, never recomputed. */
export function roundRow(kind: "review" | "qa", detail: TaskDetailView): { text: string; tone: string; binding: string } {
  const f = kind === "review" ? detail.facts.review : detail.facts.qa;
  const verdict = f.verdict ?? "pending";
  const tone = verdict === "approved" || verdict === "pass" ? "good" : verdict === "changes_requested" || verdict === "fail" ? "bad" : "wait";
  const check = detail.checks.find((c) => c.id === (kind === "review" ? "K10" : "K14"));
  const bound = detail.facts.latestCompletion === null ? "no completion" : `bound to ${detail.facts.latestCompletion}`;
  return {
    text: `${kind === "review" ? "REVIEW" : "QA"}: R${f.rounds} ${verdict.replace(/_/g, " ")}`,
    tone,
    binding: `${bound} · ${check === undefined ? "K? n/a" : `${check.id} ${check.status}`}`,
  };
}

export function roundsView(detail: TaskDetailView | null): VElement {
  if (detail === null) return h("div", { class: "rounds" }, [h("p", { class: "empty" }, [t("no task selected")])]);
  return h(
    "div",
    { class: "rounds" },
    (["review", "qa"] as const).map((k) => {
      const r = roundRow(k, detail);
      return h("p", { class: `round ${r.tone}` }, [h("span", { class: "round-main" }, [t(r.text)]), h("span", { class: "round-bind" }, [t(r.binding)])]);
    }),
  );
}

/** The check cells in API order, and the summary counts. */
export function checkCells(checks: CheckView[]): { cells: { id: string; status: string; label: string }[]; summary: string } {
  const cells = checks.map((c) => ({
    id: c.id,
    status: ["pass", "fail", "skip"].includes(c.status) ? c.status : "skip",
    label: `${c.id} ${c.key}: ${c.status}${c.detail === "" ? "" : ` — ${c.detail}`}`,
  }));
  const n = (st: string) => cells.filter((c) => c.status === st).length;
  return { cells, summary: `${n("pass")} PASS · ${n("fail")} FAIL · ${n("skip")} SKIP` };
}

export function checksView(detail: TaskDetailView | null): VElement {
  if (detail === null) return h("div", { class: "checks" }, [h("p", { class: "empty" }, [t("no task selected")])]);
  const { cells, summary } = checkCells(detail.checks);
  return h("div", { class: "checks" }, [
    h(
      "ul",
      { class: "cells", "aria-label": `${cells.length} checks` },
      cells.map((c) => h("li", { class: `cell ${c.status}`, title: c.label, "aria-label": c.label }, [t(c.id)])),
    ),
    h("p", { class: "checks-summary" }, [t(summary)]),
  ]);
}

/** Token flow by agent (merged across models), with the ticket total and the "no price" rules. */
export function tokenFlow(usage: UsageView): {
  status: "ok" | "empty" | "error";
  message: string;
  rows: { agent: string; tokens: number; share: number; cost: string }[];
  total: string;
} {
  if (usage.error !== undefined || usage.report === undefined) {
    return { status: "error", message: `usage unavailable: ${usage.error ?? "no report"}`, rows: [], total: "" };
  }
  const { groups, total } = usage.report;
  if (total.records === 0) return { status: "empty", message: "no usage data", rows: [], total: "" };
  const byAgent = new Map<string, { tokens: number; cost: number; priced: number; unpriced: number }>();
  for (const g of groups) {
    const a = byAgent.get(g.agent) ?? { tokens: 0, cost: 0, priced: 0, unpriced: 0 };
    a.tokens += g.input_tokens + g.cache_creation_input_tokens + g.cache_read_input_tokens + g.output_tokens;
    if (g.cost_usd !== null) {
      a.cost += g.cost_usd;
      a.priced += 1;
    }
    a.unpriced += g.unpriced_records;
    byAgent.set(g.agent, a);
  }
  const max = Math.max(1, ...Array.from(byAgent.values(), (a) => a.tokens));
  const rows = Array.from(byAgent, ([agent, a]) => ({
    agent,
    tokens: a.tokens,
    share: a.tokens / max,
    cost: money(a.priced > 0 ? a.cost : null, a.unpriced),
  })).sort((x, y) => y.tokens - x.tokens || (x.agent < y.agent ? -1 : 1));
  return { status: "ok", message: "", rows, total: money(total.cost_usd, total.unpriced_records) };
}

export function tokensView(detail: TaskDetailView | null): VElement {
  if (detail === null) return h("div", { class: "tokens" }, [h("p", { class: "empty" }, [t("no task selected")])]);
  const flow = tokenFlow(detail.usage);
  if (flow.status !== "ok") return h("div", { class: "tokens" }, [h("p", { class: flow.status === "error" ? "empty bad" : "empty" }, [t(flow.message)])]);
  return h("div", { class: "tokens" }, [
    h(
      "ul",
      { class: "flow" },
      flow.rows.map((r) =>
        h("li", { class: "flow-row" }, [
          h("span", { class: "flow-agent" }, [t(r.agent)]),
          h("span", { class: "flow-bar", "aria-hidden": "true" }, [h("span", { class: `flow-fill w${Math.round(r.share * 20) * 5}` })]),
          h("span", { class: "flow-cost", title: `${r.tokens} tokens` }, [t(r.cost)]),
        ]),
      ),
    ),
    h("p", { class: "flow-total" }, [h("span", {}, [t("TOTAL")]), h("span", {}, [t(flow.total)])]),
  ]);
}

/**
 * The editor link: `{path}` replaced by the path in `/`-separated, percent-encoded segments. A leading `/` is
 * dropped (decisions.md D1): `vscode://file/{path}` must give `vscode://file/Users/…`, because a double slash
 * makes VS Code read the first segment as a UNC host.
 */
export function editorHref(template: string, path: string): string {
  const encoded = path.replace(/\\/g, "/").replace(/^\/+/, "").split("/").map(encodeURIComponent).join("/");
  return template.replace("{path}", encoded);
}

/** One row per present task file: an "open" link and a "copy path" button. File text is never fetched. */
export function filesView(detail: TaskDetailView | null, template: string | null, copied: Record<string, string>): VElement {
  if (detail === null) return h("ul", { class: "files" }, [h("li", { class: "empty" }, [t("no task selected")])]);
  const present = detail.files.filter((f) => f.present);
  if (present.length === 0) return h("ul", { class: "files" }, [h("li", { class: "empty" }, [t("no files")])]);
  return h(
    "ul",
    { class: "files" },
    present.map((f) => {
      const row: VNode[] = [h("span", { class: "file-name", title: f.path }, [t(f.name)])];
      if (template !== null) row.push(h("a", { class: "file-open", href: editorHref(template, f.path) }, [t("open")]));
      row.push(h("button", { type: "button", class: "file-copy", "data-action": "copy", "data-path": f.path }, [t(copied[f.path] ?? "copy path")]));
      return h("li", { class: "file" }, row);
    }),
  );
}

/** The fixed palette (H8): every text colour is checked for AA contrast against both backgrounds. */
export function palette(): Record<string, string> {
  return {
    bg: "#0b1220",
    panel: "#101b30",
    line: "#1f3352",
    text: "#e6f1ff",
    muted: "#9fb3c8",
    cyan: "#22d3ee",
    green: "#34d399",
    red: "#f87171",
    amber: "#fbbf24",
    blue: "#60a5fa",
    violet: "#c4b5fd",
  };
}

/** WCAG 2 contrast ratio of two `#rrggbb` colours. */
export function contrastRatio(a: string, b: string): number {
  const lum = (hex: string) => {
    const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
