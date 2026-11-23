import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import * as client from "../dashboard-client.js";
import { actionTarget, boot, loadJson, mount, onKey, type Ctx, type EvLike, type ResLike, type WinLike } from "../dashboard-client.js";
import { APP_CSS, APP_JS, INDEX_HTML, appFunctions } from "../dashboard-assets.js";
import * as view from "../dashboard-view.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, "..", "..", "src");
const SVG_NS = "svg-namespace-from-the-page";

/** A minimal DOM: enough for the client's createElement/setAttribute/append/replaceChildren/focus surface. */
class FakeNode {
  parentNode: FakeEl | null = null;
}
class FakeText extends FakeNode {
  constructor(readonly text: string) {
    super();
  }
}
class FakeEl extends FakeNode {
  attrs = new Map<string, string>();
  children: FakeNode[] = [];
  listeners = new Map<string, ((e: EvLike) => void)[]>();
  value = "";
  constructor(
    readonly doc: FakeDoc,
    readonly tagName: string,
    readonly namespaceURI: string | null = null,
  ) {
    super();
  }
  setAttribute(n: string, v: string) {
    this.attrs.set(n, String(v));
  }
  getAttribute(n: string) {
    return this.attrs.get(n) ?? null;
  }
  append(...nodes: unknown[]) {
    for (const n of nodes as FakeNode[]) {
      n.parentNode = this;
      this.children.push(n);
    }
  }
  replaceChildren(...nodes: unknown[]) {
    this.children = [];
    this.append(...nodes);
  }
  addEventListener(type: string, fn: (e: EvLike) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  focus() {
    this.doc.activeElement = this;
  }
  get text(): string {
    return this.children.map((c) => (c instanceof FakeText ? c.text : (c as FakeEl).text)).join("");
  }
  all(): FakeEl[] {
    return this.children.flatMap((c) => (c instanceof FakeEl ? [c, ...c.all()] : []));
  }
}
class FakeDoc {
  activeElement: unknown = null;
  body: FakeEl;
  listeners = new Map<string, ((e: EvLike) => void)[]>();
  created: string[] = [];
  constructor() {
    this.body = new FakeEl(this, "BODY");
    for (const id of ["header-stats", "queue-controls", "queue-error", "queue-list", "detail-error", "rounds", "tokens", "timeline", "checks", "files", "registration", "registration-error"]) {
      const el = new FakeEl(this, "DIV");
      el.setAttribute("id", id);
      this.body.append(el);
    }
    const ring = new FakeEl(this, "svg", SVG_NS);
    ring.setAttribute("id", "ring");
    this.body.append(ring);
    const refresh = new FakeEl(this, "BUTTON");
    refresh.setAttribute("data-action", "refresh");
    this.body.append(refresh);
  }
  createElement(tag: string) {
    this.created.push(`html:${tag}`);
    return new FakeEl(this, tag.toUpperCase());
  }
  createElementNS(ns: string, tag: string) {
    this.created.push(`${ns}:${tag}`);
    return new FakeEl(this, tag, ns);
  }
  createTextNode(text: string) {
    return new FakeText(text);
  }
  getElementById(id: string) {
    return this.body.all().find((e) => e.getAttribute("id") === id) ?? null;
  }
  addEventListener(type: string, fn: (e: EvLike) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  fire(type: string, e: Partial<EvLike> & { target: unknown }) {
    let prevented = false;
    const ev = { ...e, preventDefault: () => (prevented = true) } as EvLike;
    for (const fn of this.listeners.get(type) ?? []) fn(ev);
    return prevented;
  }
  byAction(action: string) {
    return this.body.all().filter((e) => e.getAttribute("data-action") === action);
  }
}

const evil = "<script>alert(1)</script>";
const TASKS = {
  schema: 1,
  skipped: 0,
  tasks: [
    { id: "TK-1", title: "pipeline check", ticket: "TK-1", state: "completed", ok: true, problem: null, nextActor: { role: "reviewer", round: 2, reason: "r" }, review: { rounds: 1, verdict: "changes_requested" }, qa: { rounds: 0, verdict: null }, updated_at: "2026-01-02T00:00:00Z", tokens: null, usage_error: "x" },
    { id: "TK-2", title: null, ticket: "TK-2", state: "in_progress", ok: true, problem: null, nextActor: { role: "implementer", reason: "" }, review: null, qa: null, updated_at: "2026-01-01T00:00:00Z", tokens: null, usage_error: null },
    { id: "TK-3", title: evil, ticket: "TK-3", state: "validated", ok: true, problem: null, nextActor: { role: "none", reason: "" }, review: null, qa: null, updated_at: null, tokens: null, usage_error: null },
  ],
};
const DETAIL = (id: string) => ({
  schema: 1,
  id,
  title: null,
  ok: true,
  updated_at: null,
  transitions: [{ from: "completed", to: "completed", agent: "reviewer", timestamp: "2026-01-01T02:27:00Z", note: evil }],
  checks: Array.from({ length: 18 }, (_, i) => ({ id: `K${i + 1}`, key: "k", source: "s", status: "pass", detail: "" })),
  facts: { state: "completed", latestCompletion: null, review: { rounds: 1, verdict: "approved" }, qa: { rounds: 0, verdict: null }, nextActor: { role: "qa", round: 1, reason: "no QA round" } },
  keys: [],
  taskDir: `/r/.ai/tasks/${id}`,
  files: [{ name: "plan.md", path: `/r/.ai/tasks/${id}/plan.md`, present: true }],
  usage: { report: { groups: [], total: { records: 0, messages: 0, input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0, cost_usd: null, unpriced_records: 0 } }, records: [] },
});

/** A non-200 reply with a JSON body (D4: the server's own error string). */
class Reply {
  constructor(
    readonly status: number,
    readonly body: unknown,
  ) {}
}
const NOT_CHECKED = { schema: 1, checkedAt: null };
function fakeWin(routes: Record<string, unknown | number | Error> = {}, clipboard?: { writeText(t: string): Promise<void> }) {
  const doc = new FakeDoc();
  const calls: string[] = [];
  const inits: { path: string; method?: string; headers?: Record<string, string> }[] = [];
  const res = (status: number, body: unknown): ResLike => ({ ok: status === 200, status, json: async () => body });
  const win: WinLike & { document: FakeDoc } = {
    document: doc,
    location: { host: "127.0.0.1:4747" },
    navigator: clipboard === undefined ? {} : { clipboard },
    fetch: async (path: string, init?: { method?: string; headers?: Record<string, string> }) => {
      calls.push(path);
      inits.push({ path, ...init });
      // A POST route is keyed "POST <path>"; GET routes by their path alone.
      const key = init?.method === "POST" ? `POST ${path}` : path;
      const r = Object.hasOwn(routes, key) ? routes[key] : init?.method === "POST" ? 405 : path.endsWith("/registration") ? NOT_CHECKED : path === "/api/meta" ? { schema: 1, editorUrl: "vscode://file/{path}" } : path === "/api/tasks" ? TASKS : path.startsWith("/api/tasks/") ? DETAIL(decodeURIComponent(path.slice(11))) : 404;
      if (r instanceof Error) throw r;
      if (r instanceof Reply) return res(r.status, r.body);
      return typeof r === "number" ? res(r, {}) : res(200, r);
    },
  };
  return { win, doc, calls, inits };
}
const settle = () => new Promise((r) => setTimeout(r, 0));

test("boot: loads /api/meta, /api/tasks and the first active task's detail with relative paths, and fills every panel", async () => {
  const { win, doc, calls } = fakeWin();
  const ctx = await boot(win);
  assert.deepEqual(calls, ["/api/meta", "/api/tasks", "/api/tasks/TK-1", "/api/tasks/TK-1/registration"]);
  assert.equal(ctx.svgNs, SVG_NS, "the SVG namespace comes from the page's own <svg>");
  assert.equal(ctx.state.q.selected, "TK-1");
  assert.deepEqual(ctx.cards.map((c) => c.getAttribute("data-id")), ["TK-1", "TK-2"]);
  for (const id of ["header-stats", "queue-list", "ring", "rounds", "tokens", "timeline", "checks", "files"]) {
    assert.ok((doc.getElementById(id) as FakeEl).children.length > 0, `${id} rendered`);
  }
  assert.match((doc.getElementById("header-stats") as FakeEl).text, /127\.0\.0\.1:4747updated \d\d:\d\d:\d\d UTC3 TASKS · 2 ACTIVE · no usage data/);
  assert.ok(doc.created.some((c) => c.startsWith(`${SVG_NS}:`)) && !doc.created.some((c) => c === "html:path"), "SVG children use the page namespace");
  assert.equal((doc.getElementById("tokens") as FakeEl).text, "no usage data");
  assert.match((doc.getElementById("ring") as FakeEl).getAttribute("aria-label") ?? "", /COMPLETED \(1\)/);
});

test("hostile task text: a note or title of <script>alert(1)</script> is mounted as a text node, never as an element", async () => {
  const { win, doc } = fakeWin();
  await boot(win);
  const tl = doc.getElementById("timeline") as FakeEl;
  assert.ok(tl.text.includes(evil));
  assert.ok(!doc.body.all().some((e) => e.tagName.toLowerCase() === "script"));
  assert.throws(() => mount(doc, { tag: "a", attrs: { onclick: "x" }, children: [] }, SVG_NS), /refused event attribute onclick/);
});

test("keyboard and semantics: ↓/↑ move focus between queue buttons, '/' focuses search, Escape returns to the selected card", async () => {
  const { win, doc } = fakeWin();
  const ctx = await boot(win);
  const search = doc.getElementById("search") as FakeEl;
  ctx.cards[0].focus();
  assert.equal(doc.fire("keydown", { key: "ArrowDown", target: ctx.cards[0] }), true);
  assert.equal(doc.activeElement, ctx.cards[1]);
  doc.fire("keydown", { key: "ArrowDown", target: ctx.cards[1] });
  assert.equal(doc.activeElement, ctx.cards[1], "clamped at the end");
  doc.fire("keydown", { key: "ArrowUp", target: ctx.cards[1] });
  assert.equal(doc.activeElement, ctx.cards[0]);
  assert.equal(doc.fire("keydown", { key: "/", target: ctx.cards[0] }), true);
  assert.equal(doc.activeElement, search);
  assert.equal(doc.fire("keydown", { key: "/", target: search }), false, "/ typed in the search box stays text");
  doc.fire("keydown", { key: "Escape", target: search });
  assert.equal(doc.activeElement, ctx.cards[0]);
  assert.equal(doc.fire("keydown", { key: "Enter", target: ctx.cards[0] }), false, "Enter is left to the native button");
  const noSearch = { ...ctx, cards: [] } as Ctx;
  assert.doesNotThrow(() => onKey(noSearch, { key: "/", target: null, preventDefault() {} }, null));
});

test("clicks: select loads the detail and keeps focus; ACTIVE/ALL and the validated group; search filters; copy path; refresh", async () => {
  let written = "";
  const { win, doc, calls } = fakeWin({}, { writeText: async (t) => void (written = t) });
  const ctx = await boot(win);
  ctx.cards[1].focus();
  doc.fire("click", { target: (ctx.cards[1] as unknown as FakeEl).children[0] });
  await settle();
  assert.equal(ctx.state.q.selected, "TK-2");
  assert.deepEqual(calls.slice(-2), ["/api/tasks/TK-2", "/api/tasks/TK-2/registration"]);
  assert.equal(doc.activeElement && (doc.activeElement as FakeEl).getAttribute("data-id"), "TK-2", "focus kept on the same card after re-render");

  const [active, all2] = doc.byAction("mode");
  doc.fire("click", { target: all2 });
  await settle();
  assert.deepEqual([ctx.state.q.mode, ctx.state.q.expanded, all2.getAttribute("aria-pressed"), active.getAttribute("aria-pressed")], ["all", true, "true", "false"]);
  assert.deepEqual(ctx.cards.map((c) => c.getAttribute("data-id")), ["TK-1", "TK-2", "TK-3"]);
  doc.fire("click", { target: doc.byAction("toggle-validated")[0] });
  await settle();
  assert.equal(ctx.state.q.expanded, false);
  doc.fire("click", { target: active });
  await settle();
  assert.equal(ctx.state.q.mode, "active");

  const search = doc.getElementById("search") as FakeEl;
  search.value = "tk-2";
  for (const fn of search.listeners.get("input") ?? []) fn({ target: search, preventDefault() {} });
  assert.deepEqual(ctx.cards.map((c) => c.getAttribute("data-id")), ["TK-2"]);

  doc.fire("click", { target: doc.byAction("copy")[0] });
  await settle();
  assert.equal(written, "/r/.ai/tasks/TK-2/plan.md");
  assert.ok((doc.getElementById("files") as FakeEl).text.includes("copied"));
  const link = (doc.getElementById("files") as FakeEl).all().find((e) => e.tagName === "A");
  assert.equal(link?.getAttribute("href"), "vscode://file/r/.ai/tasks/TK-2/plan.md");

  const before = calls.length;
  doc.fire("click", { target: doc.byAction("refresh")[0] });
  await settle();
  assert.deepEqual(calls.slice(before), ["/api/tasks", "/api/tasks/TK-2", "/api/tasks/TK-2/registration"], "refresh keeps the selection");
  doc.fire("click", { target: doc.body });
  assert.equal(actionTarget(null), null);
});

test("errors: a failed or non-200 load shows 'cannot load <route> (<status|network>)' as text and keeps the previous data", async () => {
  const { win, doc } = fakeWin({ "/api/meta": 500, "/api/tasks/TK-1": new Error("down") });
  const ctx = await boot(win);
  assert.equal(ctx.state.editorUrl, null, "no template, so no open link");
  assert.equal((doc.getElementById("detail-error") as FakeEl).text, "cannot load /api/tasks/TK-1 (network)");
  assert.equal(ctx.state.tasks.length, 3);
  assert.deepEqual(await loadJson(win, "/nope"), { ok: false, message: "cannot load /nope (404)" });

  const down = fakeWin({ "/api/tasks": 503 });
  const c2 = await boot(down.win);
  assert.equal((down.doc.getElementById("queue-error") as FakeEl).text, "cannot load /api/tasks (503)");
  assert.equal(c2.state.q.selected, null);
  assert.equal((down.doc.getElementById("ring") as FakeEl).text, "no tasks");

  const noClip = fakeWin();
  await boot(noClip.win);
  noClip.doc.fire("click", { target: noClip.doc.byAction("copy")[0] });
  await settle();
  assert.ok((noClip.doc.getElementById("files") as FakeEl).text.includes("copy failed"));
  const failing = fakeWin({}, { writeText: async () => Promise.reject(new Error("denied")) });
  await boot(failing.win);
  failing.doc.fire("click", { target: failing.doc.byAction("copy")[0] });
  await settle();
  assert.ok((failing.doc.getElementById("files") as FakeEl).text.includes("copy failed"));
});

test("the first load selects the queue's first card (newest updated_at), not the API's first task", async () => {
  const later = { ...TASKS.tasks[1], updated_at: "2026-02-01T00:00:00Z" };
  const { win, calls } = fakeWin({ "/api/tasks": { schema: 1, tasks: [TASKS.tasks[0], later, TASKS.tasks[2]], skipped: 0 } });
  const ctx = await boot(win);
  assert.equal(ctx.state.q.selected, "TK-2");
  assert.deepEqual(calls.slice(-2), ["/api/tasks/TK-2", "/api/tasks/TK-2/registration"]);
  assert.equal(ctx.cards[0].getAttribute("aria-current"), "true");
});

test("review r1 L2: a detail response for a task that is no longer selected is ignored", async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => (release = r));
  const { win, doc } = fakeWin();
  const ctx = await boot(win);
  const fetch = win.fetch;
  win.fetch = async (path: string) => {
    if (path === "/api/tasks/TK-1") await gate;
    return fetch(path);
  };
  const slow = client.loadDetail(ctx);
  ctx.state.q.selected = "TK-2";
  await client.loadDetail(ctx);
  release();
  await slow;
  assert.equal(ctx.state.detail?.id, "TK-2", "the late TK-1 response does not replace TK-2");
  assert.ok((doc.getElementById("files") as FakeEl).text.includes("plan.md"));
});

test("a selected task that disappears on refresh falls back to the first active task", async () => {
  const { win } = fakeWin();
  const ctx = await boot(win);
  ctx.state.q.selected = "GONE";
  await client.refresh(ctx);
  assert.equal(ctx.state.q.selected, "TK-1");
  const empty = fakeWin({ "/api/tasks": { schema: 1, tasks: [], skipped: 0 } });
  const c2 = await boot(empty.win);
  assert.equal(c2.state.q.selected, null);
  const vOnly = fakeWin({ "/api/tasks": { schema: 1, tasks: [TASKS.tasks[2]], skipped: 0 } });
  assert.equal((await boot(vOnly.win)).state.q.selected, "TK-3");
});

test("APP_JS is every exported view and client function, booted for real in node:vm against the fake DOM", async () => {
  const exported = (m: Record<string, unknown>) => Object.entries(m).filter(([, v]) => typeof v === "function").map(([k]) => k);
  const served = appFunctions().map((f) => f.name);
  assert.deepEqual([...served].sort(), [...exported(view), ...exported(client)].sort(), "no export is missing from /app.js");
  assert.equal(new Set(served).size, served.length);

  const { win, doc, calls } = fakeWin();
  runInNewContext(APP_JS, { window: win, encodeURIComponent, Date, Math, Object, Array, Map, Set, JSON, Promise, Number, String, Error, RegExp, Boolean });
  for (let i = 0; i < 20 && calls.length < 3; i++) await settle();
  await settle();
  assert.deepEqual(calls, ["/api/meta", "/api/tasks", "/api/tasks/TK-1", "/api/tasks/TK-1/registration"]);
  assert.equal(doc.getElementById("queue-list")?.getAttribute("aria-label"), "Tasks");
  assert.ok((doc.getElementById("timeline") as FakeEl).text.includes(evil));
});

test("no HTML sink and no network beyond same-origin fetch in the UI sources and assets", () => {
  for (const f of ["dashboard-view.ts", "dashboard-client.ts", "dashboard-assets.ts"]) {
    const text = readFileSync(join(SRC, f), "utf8");
    assert.doesNotMatch(text, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|new Function|eval\(/, f);
    assert.doesNotMatch(text, /https?:\/\//, f);
  }
  for (const served of [APP_JS, APP_CSS, INDEX_HTML]) {
    assert.doesNotMatch(served, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|new Function|eval\(|https?:\/\//);
  }
  assert.doesNotMatch(APP_CSS, /@font-face|@import|url\(/);
  assert.match(APP_CSS, /@media \(prefers-reduced-motion: reduce\)\{[^}]*animation:none !important;transition:none !important\}/);
  assert.doesNotMatch(INDEX_HTML, /<style|style=|\son[a-z]+=/i);
  // Every load names a fixed relative route; the only variable part is an encoded task id.
  const clientSrc = readFileSync(join(SRC, "dashboard-client.ts"), "utf8");
  const routes = Array.from(clientSrc.matchAll(/await loadJson\((?:ctx\.)?win, (.+)\);$/gm), (m) => m[1]);
  assert.deepEqual(routes, [
    "`/api/tasks/${encodeURIComponent(id)}/registration`",
    '`/api/tasks/${encodeURIComponent(id)}/registration`, { method: "POST", headers: { "X-Base-AI": "1" } }',
    "`/api/tasks/${encodeURIComponent(id)}`",
    '"/api/tasks"',
    '"/api/meta"',
  ]);
  assert.equal(clientSrc.match(/\.fetch\(/g)?.length, 1, "fetch is called in loadJson only");
});

/** A fake EventSource: records the URL and lets a test emit open, error, task and list by hand. */
class FakeSource {
  static last: FakeSource | null = null;
  readyState = 0;
  readonly handlers = new Map<string, ((e: { data?: unknown }) => void)[]>();
  constructor(readonly url: string) {
    FakeSource.last = this;
  }
  addEventListener(type: string, fn: (e: { data?: unknown }) => void) {
    this.handlers.set(type, [...(this.handlers.get(type) ?? []), fn]);
  }
  emit(type: string, data?: unknown) {
    if (type === "open") this.readyState = 1;
    for (const fn of this.handlers.get(type) ?? []) fn({ data });
  }
}
async function liveBoot() {
  const f = fakeWin();
  f.win.EventSource = FakeSource;
  const ctx = await boot(f.win);
  const es = FakeSource.last as FakeSource;
  const header = () => (f.doc.getElementById("header-stats") as FakeEl).text;
  const drain = async () => {
    for (let i = 0; i < 20; i++) await settle();
  };
  return { ...f, ctx, es, header, drain };
}

test("D3 subscribe: EventSource('/events') after the first load; RECONNECTING until open, then LIVE and a full reload", async () => {
  const { es, calls, header, drain } = await liveBoot();
  assert.equal(es.url, "/events");
  assert.match(header(), / RECONNECTING 127\.0\.0\.1:4747/);
  assert.doesNotMatch(header(), /(^|\s)LIVE\b/);
  calls.length = 0;
  es.emit("open");
  await drain();
  assert.match(header(), /● LIVE 127\.0\.0\.1:4747/);
  assert.deepEqual(calls, ["/api/tasks", "/api/tasks/TK-1", "/api/tasks/TK-1/registration"], "open runs a full refresh (H6)");
});

test("D3 reload rules: task for the selected id reloads list and detail; for another id only the list; list reloads both; bad data is ignored", async () => {
  const { es, calls, ctx, drain } = await liveBoot();
  es.emit("open");
  await drain();
  calls.length = 0;
  es.emit("task", JSON.stringify({ id: "TK-1" }));
  await drain();
  assert.deepEqual(calls, ["/api/tasks", "/api/tasks/TK-1", "/api/tasks/TK-1/registration"]);
  calls.length = 0;
  es.emit("task", JSON.stringify({ id: "TK-2" }));
  await drain();
  assert.deepEqual(calls, ["/api/tasks"], "another task: the list only");
  assert.equal(ctx.state.detail?.id, "TK-1", "the detail is kept");
  calls.length = 0;
  es.emit("list", "{}");
  await drain();
  assert.deepEqual(calls, ["/api/tasks", "/api/tasks/TK-1", "/api/tasks/TK-1/registration"]);
  calls.length = 0;
  for (const bad of ["not json", "null", '{"id":7}', "[]", undefined]) es.emit("task", bad);
  await drain();
  assert.deepEqual(calls, [], "malformed task data is ignored");
  assert.equal(client.eventId('{"id":"TK-9"}'), "TK-9");
});

test("D3 reconnect: error while CONNECTING shows RECONNECTING; the next open reloads and keeps the selection; CLOSED shows OFFLINE", async () => {
  const { es, calls, ctx, header, drain } = await liveBoot();
  es.emit("open");
  await drain();
  ctx.state.q.selected = "TK-2";
  es.readyState = 0;
  es.emit("error");
  assert.match(header(), / RECONNECTING /);
  calls.length = 0;
  es.emit("open");
  await drain();
  assert.match(header(), / LIVE /);
  assert.deepEqual(calls, ["/api/tasks", "/api/tasks/TK-2", "/api/tasks/TK-2/registration"]);
  assert.equal(ctx.state.q.selected, "TK-2");
  es.readyState = 2;
  es.emit("error");
  assert.match(header(), / OFFLINE /);
  assert.doesNotMatch(header(), /(^|\s)LIVE\b/);
});

test("D3 serialised reloads: events during a reload set one pending flag, so exactly one more full refresh follows", async () => {
  const { es, win, calls, ctx, drain } = await liveBoot();
  es.emit("open");
  await drain();
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => (release = r));
  const fetch = win.fetch;
  let first = true;
  win.fetch = async (path: string) => {
    if (first && path === "/api/tasks") {
      first = false;
      await gate;
    }
    return fetch(path);
  };
  calls.length = 0;
  es.emit("list", "{}");
  await settle();
  for (let i = 0; i < 5; i++) es.emit("task", JSON.stringify({ id: "TK-2" }));
  es.emit("list", "{}");
  assert.equal(ctx.pending, true);
  release();
  await drain();
  assert.deepEqual(calls, ["/api/tasks", "/api/tasks/TK-1", "/api/tasks/TK-1/registration", "/api/tasks", "/api/tasks/TK-1", "/api/tasks/TK-1/registration"], "one queued refresh, never overlapping");
  assert.equal(ctx.busy, false);
  assert.equal(ctx.pending, false);
});

test("D3 REFRESH stays and goes through the same serialiser; without EventSource the header says OFFLINE and boot still loads", async () => {
  const { win, doc, calls } = fakeWin();
  const ctx = await boot(win);
  assert.equal(ctx.state.live, "offline");
  assert.match((doc.getElementById("header-stats") as FakeEl).text, /● OFFLINE 127\.0\.0\.1:4747/);
  assert.deepEqual(calls, ["/api/meta", "/api/tasks", "/api/tasks/TK-1", "/api/tasks/TK-1/registration"]);
  calls.length = 0;
  const refreshBtn = { getAttribute: (n: string) => (n === "data-action" ? "refresh" : null) } as unknown as client.ElLike;
  await client.onAction(ctx, refreshBtn, []);
  assert.deepEqual(calls, ["/api/tasks", "/api/tasks/TK-1", "/api/tasks/TK-1/registration"]);
  ctx.busy = true;
  await client.onAction(ctx, refreshBtn, []);
  assert.equal(ctx.pending, true, "a refresh asked for during a reload is queued");
});

test("D3 APP_JS in node:vm subscribes to the relative /events route when the window has EventSource", async () => {
  const { win, calls } = fakeWin();
  FakeSource.last = null;
  win.EventSource = FakeSource;
  runInNewContext(APP_JS, { window: win, encodeURIComponent, Date, Math, Object, Array, Map, Set, JSON, Promise, Number, String, Error, RegExp, Boolean });
  const created = () => FakeSource.last as FakeSource | null;
  for (let i = 0; i < 20 && created() === null; i++) await settle();
  assert.equal(created()?.url, "/events");
  assert.ok(calls.includes("/api/tasks"));
  const src = readFileSync(join(SRC, "dashboard-client.ts"), "utf8");
  assert.deepEqual(Array.from(src.matchAll(/new Source\((.+?)\)/g), (m) => m[1]), ['"/events"'], "the only stream is same-origin /events");
});

test("review r1 L3: boot's first load and a card select go through the serialiser, so they never overlap another reload", async () => {
  // A REFRESH during the first load is queued, not run alongside it.
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => (release = r));
  const f = fakeWin();
  const fetch = f.win.fetch;
  f.win.fetch = async (path: string) => {
    if (path === "/api/tasks") await gate;
    return fetch(path);
  };
  const booting = boot(f.win);
  for (let i = 0; i < 5; i++) await settle();
  f.calls.length = 0;
  f.doc.fire("click", { target: f.doc.byAction("refresh")[0] });
  await settle();
  assert.equal(f.calls.length, 0, "a REFRESH click during the first load starts no second load");
  f.win.fetch = fetch;
  release();
  const ctx = await booting;
  // The first load's list fetch (held by the gate) and exactly one queued refresh after it.
  assert.equal(f.calls.filter((c) => c === "/api/tasks").length, 2, "the queued refresh runs once, after the first load");
  assert.equal(ctx.busy, false);

  // A select while a reload runs is queued: one full refresh follows, which loads the newly selected detail.
  let release2: () => void = () => {};
  const gate2 = new Promise<void>((r) => (release2 = r));
  f.win.fetch = async (path: string) => {
    if (path === "/api/tasks") await gate2;
    return fetch(path);
  };
  f.calls.length = 0;
  const running = client.serialized(ctx, () => client.refresh(ctx));
  await settle();
  const card = { getAttribute: (n: string) => (n === "data-action" ? "select" : n === "data-id" ? "TK-2" : null) } as unknown as client.ElLike;
  await client.onAction(ctx, card, []);
  assert.equal(ctx.pending, true, "the select's detail load is queued behind the running reload");
  assert.ok(!f.calls.includes("/api/tasks/TK-2"), "no detail load overlaps the running reload");
  release2();
  await running;
  assert.equal(ctx.state.detail?.id, "TK-2");
  assert.equal(ctx.pending, false);
});

// ---- BASE-101-D4: the REGISTRATION panel ----
const KEYS = [
  { key: "reg TK-1 review r1 i1", file: "review-report.md", line: 10 },
  { key: "reg TK-1 review r1 i2", file: "review-report.md", line: 11 },
];
const RESULT = {
  schema: 1,
  ticket: "TK-1",
  outcome: "missing",
  repo: "acme/repo",
  calls: 3,
  checkedAt: "2026-11-23T16:05:09.000Z",
  keys: [
    { key: "reg TK-1 review r1 i1", status: "registered", issue: 104, state: "open" },
    { key: "reg TK-1 review r1 i2", status: "missing" },
  ],
};
const keyed = (id: string) => ({ ...DETAIL(id), keys: id === "TK-1" ? KEYS : [] });

test("D4 check on demand: the button POSTs the relative path with X-Base-AI: 1, shows CHECKING… while running, then each key's status as text", async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => (release = r));
  const { win, doc, inits } = fakeWin({ "/api/tasks/TK-1": keyed("TK-1"), "POST /api/tasks/TK-1/registration": RESULT });
  const ctx = await boot(win);
  const panel = doc.getElementById("registration") as FakeEl;
  assert.ok(panel.text.includes("reg TK-1 review r1 i1 · review-report.md:10 · not checked"));
  assert.ok(panel.text.includes("not checked yet"));
  const fetch = win.fetch;
  win.fetch = async (path, init) => {
    if (init?.method === "POST") await gate;
    return fetch(path, init);
  };
  doc.fire("click", { target: doc.byAction("registration")[0] });
  await settle();
  const busy = doc.byAction("registration")[0];
  assert.deepEqual([busy.text, busy.getAttribute("disabled")], ["CHECKING…", ""]);
  assert.equal(ctx.state.checking, "TK-1");
  // A second click while running sends nothing.
  doc.fire("click", { target: busy });
  release();
  await settle();
  await settle();
  const posts = inits.filter((i) => i.method === "POST");
  assert.equal(posts.length, 1, "one POST");
  assert.deepEqual(posts[0], { path: "/api/tasks/TK-1/registration", method: "POST", headers: { Accept: "application/json", "X-Base-AI": "1" } });
  const text = (doc.getElementById("registration") as FakeEl).text;
  assert.ok(text.includes("reg TK-1 review r1 i1 · review-report.md:10 · registered #104 (open)"));
  assert.ok(text.includes("reg TK-1 review r1 i2 · review-report.md:11 · missing"));
  assert.ok(text.includes("MISSING · 3 gh call(s) · checked 16:05:09"));
  assert.equal(doc.byAction("registration")[0].text, "CHECK REGISTRATION");
  assert.equal(ctx.state.checking, null);
});

test("D4 selecting a task GETs its cached registration; a task without keys shows no button", async () => {
  const { win, doc, calls } = fakeWin({ "/api/tasks/TK-1": keyed("TK-1"), "/api/tasks/TK-1/registration": RESULT });
  const ctx = await boot(win);
  assert.ok(calls.includes("/api/tasks/TK-1/registration"));
  assert.ok((doc.getElementById("registration") as FakeEl).text.includes("registered #104 (open)"), "the cached result renders");
  ctx.state.q.selected = "TK-2";
  await client.loadDetail(ctx);
  assert.equal((doc.getElementById("registration") as FakeEl).text, "no keys to register");
  assert.equal(doc.byAction("registration").length, 0);
});

test("D4 gh missing: the halt text shows as text and no key counts as registered", async () => {
  const halt = { ...RESULT, outcome: "halt", calls: 0, halt: { template: "T6", reason: "missing", text: "gh: command not found" }, keys: KEYS.map((k) => ({ key: k.key, status: "unchecked" })) };
  const { win, doc } = fakeWin({ "/api/tasks/TK-1": keyed("TK-1"), "POST /api/tasks/TK-1/registration": halt });
  await boot(win);
  doc.fire("click", { target: doc.byAction("registration")[0] });
  await settle();
  await settle();
  const text = (doc.getElementById("registration") as FakeEl).text;
  assert.ok(text.includes("gh: command not found"));
  assert.ok(text.includes("reg TK-1 review r1 i1 · review-report.md:10 · unchecked") && !text.includes("registered #"));
  assert.ok(text.includes("HALT · 0 gh call(s)"));
});

test("D4 errors: 409, 403 and 422 show the server's error text through showError; a network failure the generic message; the panel keeps its last result", async () => {
  for (const [reply, shown] of [
    [new Reply(409, { error: "a registration check is already running" }), "a registration check is already running"],
    [new Reply(403, { error: "missing X-Base-AI header" }), "missing X-Base-AI header"],
    [new Reply(422, { error: "keys not computed" }), "keys not computed"],
    [new Reply(500, "not json"), "cannot load /api/tasks/TK-1/registration (500)"],
    [new Error("down"), "cannot load /api/tasks/TK-1/registration (network)"],
  ] as const) {
    const { win, doc } = fakeWin({ "/api/tasks/TK-1": keyed("TK-1"), "/api/tasks/TK-1/registration": RESULT, "POST /api/tasks/TK-1/registration": reply });
    const ctx = await boot(win);
    doc.fire("click", { target: doc.byAction("registration")[0] });
    await settle();
    await settle();
    assert.equal((doc.getElementById("registration-error") as FakeEl).text, shown);
    assert.equal(ctx.state.errors.registration, shown);
    assert.ok((doc.getElementById("registration") as FakeEl).text.includes("registered #104 (open)"), "the last result stays");
    assert.equal(ctx.state.checking, null, "the button is enabled again");
  }
});

test("D4 a late result for a deselected task is stored but not rendered over the new task's panel", async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => (release = r));
  const { win, doc } = fakeWin({ "/api/tasks/TK-1": keyed("TK-1"), "POST /api/tasks/TK-1/registration": RESULT });
  const ctx = await boot(win);
  const fetch = win.fetch;
  win.fetch = async (path, init) => {
    if (init?.method === "POST") await gate;
    return fetch(path, init);
  };
  const running = client.checkRegistrationAction(ctx);
  ctx.state.q.selected = "TK-2";
  await client.loadDetail(ctx);
  release();
  await running;
  assert.deepEqual(ctx.state.registration["TK-1"], RESULT, "stored for TK-1");
  assert.equal((doc.getElementById("registration") as FakeEl).text, "no keys to register", "TK-2's panel is untouched");
  assert.equal((doc.getElementById("registration-error") as FakeEl).text, "");
});

test("D4 loadJson: a non-200 body with an error string is returned as error; without one only the generic message", async () => {
  const { win } = fakeWin({ "/x": new Reply(409, { error: "busy" }), "/y": new Reply(404, { other: 1 }), "/z": new Reply(400, null) });
  assert.deepEqual(await loadJson(win, "/x"), { ok: false, message: "cannot load /x (409)", error: "busy" });
  assert.deepEqual(await loadJson(win, "/y"), { ok: false, message: "cannot load /y (404)" });
  assert.deepEqual(await loadJson(win, "/z"), { ok: false, message: "cannot load /z (400)" });
});

test("review r1 L2: a registration error stays under its own task; while one check runs, another task's button is disabled and says why", async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => (release = r));
  const routes = {
    "/api/tasks/TK-1": keyed("TK-1"),
    "/api/tasks/TK-2": { ...DETAIL("TK-2"), keys: [{ key: "reg TK-2 review r1 i1", file: "review-report.md", line: 3 }] },
    "POST /api/tasks/TK-1/registration": new Reply(409, { error: "a registration check is already running" }),
    "POST /api/tasks/TK-2/registration": RESULT,
  };
  const { win, doc } = fakeWin(routes);
  const ctx = await boot(win);
  const errorLine = () => (doc.getElementById("registration-error") as FakeEl).text;
  await client.checkRegistrationAction(ctx);
  assert.equal(errorLine(), "a registration check is already running");
  ctx.state.q.selected = "TK-2";
  await client.loadDetail(ctx);
  assert.equal(errorLine(), "", "TK-1's error is not shown under TK-2");
  ctx.state.q.selected = "TK-1";
  await client.loadDetail(ctx);
  assert.equal(errorLine(), "a registration check is already running", "and is back under TK-1");

  ctx.state.q.selected = "TK-2";
  await client.loadDetail(ctx);
  const fetch = win.fetch;
  win.fetch = async (path, init) => {
    if (init?.method === "POST") await gate;
    return fetch(path, init);
  };
  const running = client.checkRegistrationAction(ctx);
  ctx.state.q.selected = "TK-1";
  await client.loadDetail(ctx);
  const button = doc.byAction("registration")[0];
  assert.deepEqual([button.text, button.getAttribute("disabled")], ["ANOTHER CHECK RUNNING", ""]);
  release();
  await running;
  assert.equal(doc.byAction("registration")[0].text, "CHECK REGISTRATION");
});
