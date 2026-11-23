/**
 * DOM glue of the `base-ai dashboard` HUD (BASE-101-D2, epic #101). Served to the browser as the source text of
 * its functions together with dashboard-view.ts (H1), so it may hold only exported function declarations and
 * type declarations; the only runtime import is the view functions, by their own names.
 *
 * The window is injected (`boot(win)`), so tests drive it with a fake DOM. Nodes are built only with
 * createElement, createElementNS, createTextNode, setAttribute, append and replaceChildren: no HTML is ever parsed.
 * `fetch` is only called with relative paths on this origin.
 */
import {
  checksView,
  filesView,
  headerView,
  orderQueue,
  queueControlsView,
  queueKey,
  queueListView,
  ringView,
  roundsView,
  timelineView,
  tokensView,
  type QueueState,
  type TaskDetailView,
  type TaskEntryView,
  type VNode,
} from "./dashboard-view.js";

/** The DOM surface the client uses; the browser's objects satisfy it. */
export interface ElLike {
  tagName: string;
  namespaceURI?: string | null;
  value?: string;
  parentNode: ElLike | null;
  setAttribute(name: string, value: string): void;
  getAttribute(name: string): string | null;
  append(...nodes: unknown[]): void;
  replaceChildren(...nodes: unknown[]): void;
  addEventListener(type: string, fn: (e: EvLike) => void): void;
  focus(): void;
}
export interface EvLike {
  key?: string;
  target: unknown;
  preventDefault(): void;
}
export interface DocLike {
  activeElement: unknown;
  createElement(tag: string): ElLike;
  createElementNS(ns: string, tag: string): ElLike;
  createTextNode(text: string): unknown;
  getElementById(id: string): ElLike | null;
  addEventListener(type: string, fn: (e: EvLike) => void): void;
}
export interface ResLike {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}
export interface WinLike {
  document: DocLike;
  location: { host: string };
  fetch(path: string, init?: { headers?: Record<string, string> }): Promise<ResLike>;
  navigator: { clipboard?: { writeText(text: string): Promise<void> } };
}
export interface AppState {
  tasks: TaskEntryView[];
  detail: TaskDetailView | null;
  editorUrl: string | null;
  q: QueueState;
  updated: string | null;
  copied: Record<string, string>;
  errors: Record<string, string>;
}
export interface Ctx {
  win: WinLike;
  doc: DocLike;
  svgNs: string;
  state: AppState;
  cards: ElLike[];
}

/**
 * Builds real nodes from a view tree. Attributes named on… are refused (events are wired only by the client
 * with addEventListener), and `onEl` sees every element with its attributes, so callers can keep references.
 */
export function mount(doc: DocLike, node: VNode, svgNs: string, onEl?: (el: ElLike, attrs: Record<string, string>) => void): unknown {
  if ("text" in node) return doc.createTextNode(node.text);
  const el = node.ns === "svg" ? doc.createElementNS(svgNs, node.tag) : doc.createElement(node.tag);
  for (const [name, value] of Object.entries(node.attrs)) {
    if (/^on/i.test(name)) throw new Error(`refused event attribute ${name}`);
    el.setAttribute(name, value);
  }
  for (const child of node.children) el.append(mount(doc, child, svgNs, onEl));
  if (onEl !== undefined) onEl(el, node.attrs);
  return el;
}

/** Replaces the children of the element `id` with `node`, or with the children of `node` when `unwrap`. */
export function place(ctx: Ctx, id: string, node: VNode, unwrap = false, onEl?: (el: ElLike, attrs: Record<string, string>) => void): void {
  const host = ctx.doc.getElementById(id);
  if (host === null) return;
  const nodes = unwrap && !("text" in node) ? node.children : [node];
  host.replaceChildren(...nodes.map((n) => mount(ctx.doc, n, ctx.svgNs, onEl)));
  if (unwrap && !("text" in node) && node.attrs["aria-label"] !== undefined) host.setAttribute("aria-label", node.attrs["aria-label"]);
}

/** Shows a load error as text in a panel's status line; an empty message clears it. */
export function showError(ctx: Ctx, panel: string, message: string): void {
  ctx.state.errors[panel] = message;
  const host = ctx.doc.getElementById(`${panel}-error`);
  if (host !== null) host.replaceChildren(...(message === "" ? [] : [ctx.doc.createTextNode(message)]));
}

export function renderHeader(ctx: Ctx): void {
  place(ctx, "header-stats", headerView(ctx.state.tasks, ctx.win.location.host, ctx.state.updated));
}

/** Re-renders the queue list; focus stays on the card that had it, by id. */
export function renderQueue(ctx: Ctx): void {
  const active = ctx.doc.activeElement as ElLike | null;
  const focusedId = active !== null && ctx.cards.includes(active) ? active.getAttribute("data-id") : null;
  const cards: ElLike[] = [];
  place(ctx, "queue-list", queueListView(ctx.state.tasks, ctx.state.q), true, (el, attrs) => {
    if (attrs["data-action"] === "select") cards.push(el);
  });
  // Cards are siblings, and onEl runs in document order for them.
  ctx.cards = cards;
  if (focusedId !== null) ctx.cards.find((c) => c.getAttribute("data-id") === focusedId)?.focus();
}

/** Mirrors the ACTIVE/ALL state onto the static toggle buttons. */
export function renderModes(ctx: Ctx, buttons: ElLike[]): void {
  for (const b of buttons) b.setAttribute("aria-pressed", String(b.getAttribute("data-mode") === ctx.state.q.mode));
}

export function renderDetail(ctx: Ctx): void {
  const sel = ctx.state.tasks.find((x) => x.id === ctx.state.q.selected) ?? null;
  const detail = ctx.state.detail !== null && ctx.state.detail.id === ctx.state.q.selected ? ctx.state.detail : null;
  place(ctx, "ring", ringView(ctx.state.tasks, sel, detail), true);
  place(ctx, "timeline", timelineView(detail));
  place(ctx, "rounds", roundsView(detail));
  place(ctx, "checks", checksView(detail));
  place(ctx, "tokens", tokensView(detail));
  place(ctx, "files", filesView(detail, ctx.state.editorUrl, ctx.state.copied));
}

export function renderAll(ctx: Ctx): void {
  renderHeader(ctx);
  renderQueue(ctx);
  renderDetail(ctx);
}

/** GETs a same-origin JSON route; failures become a message, never an exception. */
export async function loadJson(win: WinLike, path: string): Promise<{ ok: true; data: unknown } | { ok: false; message: string }> {
  try {
    const res = await win.fetch(path, { headers: { Accept: "application/json" } });
    if (!res.ok) return { ok: false, message: `cannot load ${path} (${res.status})` };
    return { ok: true, data: await res.json() };
  } catch {
    return { ok: false, message: `cannot load ${path} (network)` };
  }
}

/** Loads the selected task's detail; on failure the previous detail stays and the error is shown. */
export async function loadDetail(ctx: Ctx): Promise<void> {
  const id = ctx.state.q.selected;
  if (id === null) {
    renderDetail(ctx);
    return;
  }
  const r = await loadJson(ctx.win, `/api/tasks/${encodeURIComponent(id)}`);
  // Review r1 L2: a response for a task that is no longer selected is stale; the newer request renders.
  if (ctx.state.q.selected !== id) return;
  if (r.ok) {
    ctx.state.detail = r.data as TaskDetailView;
    showError(ctx, "detail", "");
  } else {
    showError(ctx, "detail", r.message);
  }
  renderDetail(ctx);
}

/** Boot and REFRESH: the task list, then the selected task's detail; the selection is kept if it still exists. */
export async function refresh(ctx: Ctx): Promise<void> {
  const r = await loadJson(ctx.win, "/api/tasks");
  if (r.ok) {
    ctx.state.tasks = (r.data as { tasks: TaskEntryView[] }).tasks;
    ctx.state.updated = `${new Date().toISOString().slice(11, 19)} UTC`;
    showError(ctx, "queue", "");
    const ids = ctx.state.tasks.map((x) => x.id);
    if (ctx.state.q.selected === null || !ids.includes(ctx.state.q.selected)) {
      // The first card of the queue (plan item 9), in queue order, not API order.
      const { active, validated } = orderQueue(ctx.state.tasks);
      const first = active[0] ?? validated[0];
      ctx.state.q.selected = first === undefined ? null : first.id;
    }
  } else {
    showError(ctx, "queue", r.message);
  }
  renderHeader(ctx);
  renderQueue(ctx);
  await loadDetail(ctx);
}

/** The element carrying `data-action` at or above `target`, if any. */
export function actionTarget(target: unknown): ElLike | null {
  let el = target as ElLike | null;
  while (el !== null && el !== undefined && typeof el.getAttribute === "function") {
    if (el.getAttribute("data-action") !== null) return el;
    el = el.parentNode;
  }
  return null;
}

/** Click handling for every `data-action` element. */
export async function onAction(ctx: Ctx, el: ElLike, modes: ElLike[]): Promise<void> {
  const action = el.getAttribute("data-action");
  const q = ctx.state.q;
  if (action === "select") {
    q.selected = el.getAttribute("data-id");
    renderQueue(ctx);
    renderDetail(ctx);
    await loadDetail(ctx);
  } else if (action === "mode") {
    q.mode = el.getAttribute("data-mode") === "all" ? "all" : "active";
    q.expanded = q.mode === "all";
    renderModes(ctx, modes);
    renderQueue(ctx);
  } else if (action === "toggle-validated") {
    q.expanded = !q.expanded;
    renderQueue(ctx);
  } else if (action === "refresh") {
    await refresh(ctx);
  } else if (action === "copy") {
    const path = el.getAttribute("data-path") ?? "";
    try {
      if (ctx.win.navigator.clipboard === undefined) throw new Error("no clipboard");
      await ctx.win.navigator.clipboard.writeText(path);
      ctx.state.copied[path] = "copied";
    } catch {
      ctx.state.copied[path] = "copy failed";
    }
    place(ctx, "files", filesView(ctx.state.detail, ctx.state.editorUrl, ctx.state.copied));
  }
}

/** Keyboard: ↑/↓ walk the queue, "/" focuses search, Escape in search returns to the selected card. */
export function onKey(ctx: Ctx, e: EvLike, search: ElLike | null): void {
  const active = ctx.doc.activeElement as ElLike | null;
  const tag = active === null ? "" : String(active.tagName).toUpperCase();
  const inText = tag === "INPUT" || tag === "TEXTAREA";
  if (e.key === "Escape" && active !== null && active === search) {
    ctx.cards.find((c) => c.getAttribute("data-id") === ctx.state.q.selected)?.focus();
    return;
  }
  const index = active === null ? -1 : ctx.cards.indexOf(active);
  const k = queueKey(e.key ?? "", index, ctx.cards.length, inText);
  if (k.action === "search" && search !== null) {
    e.preventDefault();
    search.focus();
  } else if (k.action === "focus") {
    e.preventDefault();
    ctx.cards[k.index].focus();
  }
}

/** Starts the HUD in `win`: wires the static controls, then loads /api/meta and the task list. */
export async function boot(win: WinLike): Promise<Ctx> {
  const doc = win.document;
  const ring = doc.getElementById("ring");
  const ctx: Ctx = {
    win,
    doc,
    // Taken from the page's own <svg>, so no namespace URL is written in this file.
    svgNs: ring?.namespaceURI ?? "",
    state: {
      tasks: [],
      detail: null,
      editorUrl: null,
      q: { query: "", mode: "active", expanded: false, selected: null },
      updated: null,
      copied: {},
      errors: {},
    },
    cards: [],
  };
  const modes: ElLike[] = [];
  place(ctx, "queue-controls", queueControlsView(ctx.state.q), true, (el, attrs) => {
    if (attrs["data-action"] === "mode") modes.push(el);
  });
  const search = doc.getElementById("search");
  search?.addEventListener("input", () => {
    ctx.state.q.query = search.value ?? "";
    renderQueue(ctx);
  });
  doc.addEventListener("click", (e) => {
    const el = actionTarget(e.target);
    if (el !== null) void onAction(ctx, el, modes);
  });
  doc.addEventListener("keydown", (e) => onKey(ctx, e, search));
  const meta = await loadJson(win, "/api/meta");
  if (meta.ok) ctx.state.editorUrl = (meta.data as { editorUrl?: unknown }).editorUrl === undefined ? null : String((meta.data as { editorUrl: unknown }).editorUrl);
  else showError(ctx, "detail", meta.message);
  renderAll(ctx);
  await refresh(ctx);
  return ctx;
}
