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
    for (const id of ["header-stats", "queue-controls", "queue-error", "queue-list", "detail-error", "rounds", "tokens", "timeline", "checks", "files"]) {
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

function fakeWin(routes: Record<string, unknown | number | Error> = {}, clipboard?: { writeText(t: string): Promise<void> }) {
  const doc = new FakeDoc();
  const calls: string[] = [];
  const res = (status: number, body: unknown): ResLike => ({ ok: status === 200, status, json: async () => body });
  const win: WinLike & { document: FakeDoc } = {
    document: doc,
    location: { host: "127.0.0.1:4747" },
    navigator: clipboard === undefined ? {} : { clipboard },
    fetch: async (path: string) => {
      calls.push(path);
      const r = Object.hasOwn(routes, path) ? routes[path] : path === "/api/meta" ? { schema: 1, editorUrl: "vscode://file/{path}" } : path === "/api/tasks" ? TASKS : path.startsWith("/api/tasks/") ? DETAIL(decodeURIComponent(path.slice(11))) : 404;
      if (r instanceof Error) throw r;
      return typeof r === "number" ? res(r, {}) : res(200, r);
    },
  };
  return { win, doc, calls };
}
const settle = () => new Promise((r) => setTimeout(r, 0));

test("boot: loads /api/meta, /api/tasks and the first active task's detail with relative paths, and fills every panel", async () => {
  const { win, doc, calls } = fakeWin();
  const ctx = await boot(win);
  assert.deepEqual(calls, ["/api/meta", "/api/tasks", "/api/tasks/TK-1"]);
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
  assert.equal(calls.at(-1), "/api/tasks/TK-2");
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
  assert.deepEqual(calls.slice(before), ["/api/tasks", "/api/tasks/TK-2"], "refresh keeps the selection");
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
  assert.equal(calls.at(-1), "/api/tasks/TK-2");
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
  assert.deepEqual(calls, ["/api/meta", "/api/tasks", "/api/tasks/TK-1"]);
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
  assert.deepEqual(routes, ["`/api/tasks/${encodeURIComponent(id)}`", '"/api/tasks"', '"/api/meta"']);
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
  assert.deepEqual(calls, ["/api/tasks", "/api/tasks/TK-1"], "open runs a full refresh (H6)");
});

test("D3 reload rules: task for the selected id reloads list and detail; for another id only the list; list reloads both; bad data is ignored", async () => {
  const { es, calls, ctx, drain } = await liveBoot();
  es.emit("open");
  await drain();
  calls.length = 0;
  es.emit("task", JSON.stringify({ id: "TK-1" }));
  await drain();
  assert.deepEqual(calls, ["/api/tasks", "/api/tasks/TK-1"]);
  calls.length = 0;
  es.emit("task", JSON.stringify({ id: "TK-2" }));
  await drain();
  assert.deepEqual(calls, ["/api/tasks"], "another task: the list only");
  assert.equal(ctx.state.detail?.id, "TK-1", "the detail is kept");
  calls.length = 0;
  es.emit("list", "{}");
  await drain();
  assert.deepEqual(calls, ["/api/tasks", "/api/tasks/TK-1"]);
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
  assert.deepEqual(calls, ["/api/tasks", "/api/tasks/TK-2"]);
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
  assert.deepEqual(calls, ["/api/tasks", "/api/tasks/TK-1", "/api/tasks", "/api/tasks/TK-1"], "one queued refresh, never overlapping");
  assert.equal(ctx.busy, false);
  assert.equal(ctx.pending, false);
});

test("D3 REFRESH stays and goes through the same serialiser; without EventSource the header says OFFLINE and boot still loads", async () => {
  const { win, doc, calls } = fakeWin();
  const ctx = await boot(win);
  assert.equal(ctx.state.live, "offline");
  assert.match((doc.getElementById("header-stats") as FakeEl).text, /● OFFLINE 127\.0\.0\.1:4747/);
  assert.deepEqual(calls, ["/api/meta", "/api/tasks", "/api/tasks/TK-1"]);
  calls.length = 0;
  const refreshBtn = { getAttribute: (n: string) => (n === "data-action" ? "refresh" : null) } as unknown as client.ElLike;
  await client.onAction(ctx, refreshBtn, []);
  assert.deepEqual(calls, ["/api/tasks", "/api/tasks/TK-1"]);
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
