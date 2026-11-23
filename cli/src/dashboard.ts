/**
 * `base-ai dashboard` (BASE-101-D1, epic #101): a local, read-only `node:http` server over `.ai/tasks/`, bound to
 * 127.0.0.1 only. No network beyond this listener, no write, no CORS. The page, its script and its stylesheet come
 * from memory (dashboard-assets.ts, BASE-101-D2), so `default-src 'self'` holds with no inline code. BASE-101-D3 adds
 * `GET /events`, a same-origin Server-Sent Events stream fed by per-directory watchers (dashboard-watch.ts).
 * BASE-101-D4 adds the one write-like route, `POST /api/tasks/<id>/registration`, which runs `pipeline debt`'s check
 * on demand through an injected runner factory (this module starts no process itself). It is the only path that
 * accepts POST, and only with the `X-Base-AI: 1` header, which a cross-site form or <img> cannot send.
 *
 * Every request is checked in a fixed order: Host (403, against DNS rebinding), method (405), path (404), id (400);
 * the registration POST then adds guard (403), keys (422) and busy (409).
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import { APP_CSS, APP_JS, INDEX_HTML } from "./dashboard-assets.js";
import { isTaskId, listTaskIds, listTasks, taskDetail } from "./dashboard-data.js";
import { realTimers, startTaskWatcher, type LiveEvent, type Timers, type WatchFn } from "./dashboard-watch.js";
import { checkRegistration, haltText, taskKeys, type DebtReport, type Runner } from "./pipeline-registration.js";
import { DEFAULT_EDITOR_URL } from "./source.js";
import type { Pricing } from "./usage.js";

export const DEFAULT_PORT = 4747;
const HOST = "127.0.0.1";
/** A connection socket, named through node:http so this module imports no other network module. */
type Socket = IncomingMessage["socket"];

/** `--port`: absent means 4747; a decimal integer from 0 (ephemeral) to 65535; null for anything else. */
export function parsePort(value: string | true | undefined): number | null {
  if (value === undefined) return DEFAULT_PORT;
  if (typeof value !== "string" || !/^\d{1,5}$/.test(value)) return null;
  const n = Number(value);
  return n <= 65535 ? n : null;
}

/** What the handler reads; injectable so a test can make a route throw. */
export interface DashboardData {
  ids(): string[];
  list(): unknown;
  detail(id: string): unknown;
}

export function dashboardData(root: string, pricing: Pricing): DashboardData {
  return {
    ids: () => listTaskIds(root).ids,
    list: () => listTasks(root, pricing),
    detail: (id) => taskDetail(root, id, pricing),
  };
}

const SECURITY_HEADERS = {
  "Content-Security-Policy": "default-src 'self'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-store",
} as const;
const JSON_TYPE = "application/json; charset=utf-8";
const HTML_TYPE = "text/html; charset=utf-8";
const JS_TYPE = "text/javascript; charset=utf-8";
const CSS_TYPE = "text/css; charset=utf-8";
const EVENT_TYPE = "text/event-stream; charset=utf-8";

function send(req: IncomingMessage, res: ServerResponse, status: number, body: string, type: string, extra: Record<string, string> = {}): void {
  const payload = Buffer.from(body, "utf8");
  res.writeHead(status, { ...SECURITY_HEADERS, ...extra, "Content-Type": type, "Content-Length": String(payload.length) });
  // HEAD: same status and headers as GET, no body.
  res.end(req.method === "HEAD" ? undefined : payload);
}
const sendJson = (req: IncomingMessage, res: ServerResponse, status: number, body: unknown, extra?: Record<string, string>) =>
  send(req, res, status, JSON.stringify(body), JSON_TYPE, extra);

/**
 * The raw reply to a request Node could not parse (review r1 L2, r2 L7): the status Node's default reply would
 * use for the parser error, now with the security headers. Built from constants only, never from the request.
 */
export function clientErrorReply(code: string | undefined): string {
  const [status, error] =
    code === "ERR_HTTP_REQUEST_TIMEOUT"
      ? ["408 Request Timeout", "request timeout"]
      : code === "HPE_HEADER_OVERFLOW"
        ? ["431 Request Header Fields Too Large", "request header fields too large"]
        : code === "HPE_CHUNK_EXTENSIONS_OVERFLOW"
          ? ["413 Payload Too Large", "payload too large"]
          : ["400 Bad Request", "bad request"];
  const body = JSON.stringify({ error });
  const head = Object.entries(SECURITY_HEADERS).map(([k, v]) => `${k}: ${v}\r\n`).join("");
  return `HTTP/1.1 ${status}\r\n${head}Content-Type: ${JSON_TYPE}\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`;
}

export interface HandlerOptions {
  /** The bound port, read per request: the Host check compares against it. */
  port: () => number;
  data: DashboardData;
  err: (line: string) => void;
  /** The validated `dashboard.editor_url` template, served by /api/meta (BASE-101-D2 H2). */
  editorUrl: string;
  /** Opens an event stream on a GET /events that passed the Host and method checks (BASE-101-D3). */
  events?: (res: ServerResponse) => void;
  /** BASE-101-D4: the cached result of a listed task, and a guarded POST that runs a check. */
  registration?: {
    cached(id: string): unknown;
    post(req: IncomingMessage, res: ServerResponse, id: string): void;
  };
}

/** The only path that accepts POST (BASE-101-D4 H1). */
const REGISTRATION_PATH = /^\/api\/tasks\/([^/?]+)\/registration$/;

/**
 * H2: the POST needs `X-Base-AI: 1`; a present Origin must be this server, a present Sec-Fetch-Site must be
 * same-origin (absent ones are allowed, so curl works); a body is refused unread. Null when the request passes.
 */
export function registrationGuard(req: IncomingMessage, port: number): { status: number; error: string } | null {
  if (req.headers["x-base-ai"] !== "1") return { status: 403, error: "missing X-Base-AI header" };
  const origin = req.headers.origin;
  if (origin !== undefined && origin !== `http://${HOST}:${port}` && origin !== `http://localhost:${port}`) {
    return { status: 403, error: "cross-site request refused" };
  }
  const site = req.headers["sec-fetch-site"];
  if (site !== undefined && site !== "same-origin") return { status: 403, error: "cross-site request refused" };
  const length = req.headers["content-length"];
  if ((length !== undefined && length !== "0") || req.headers["transfer-encoding"] !== undefined) {
    return { status: 400, error: "no body expected" };
  }
  return null;
}

export function createDashboardHandler(opts: HandlerOptions): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    const port = opts.port();
    const host = (req.headers.host ?? "").toLowerCase();
    if (host !== `${HOST}:${port}` && host !== `localhost:${port}`) return sendJson(req, res, 403, { error: "forbidden host" });
    // The raw path up to "?": no URL normalisation, so dot segments are never resolved.
    const path = (req.url ?? "").split("?")[0];
    const registration = opts.registration === undefined ? null : REGISTRATION_PATH.exec(path);
    if (req.method !== "GET" && req.method !== "HEAD" && !(req.method === "POST" && registration !== null)) {
      return sendJson(req, res, 405, { error: "method not allowed" }, { Allow: registration === null ? "GET, HEAD" : "GET, HEAD, POST" });
    }
    // A fixed label, never the untrusted path, goes to stderr.
    let route = "unknown";
    try {
      if (path === "/") {
        route = "/";
        return send(req, res, 200, INDEX_HTML, HTML_TYPE);
      }
      if (path === "/app.js") {
        route = "/app.js";
        return send(req, res, 200, APP_JS, JS_TYPE);
      }
      if (path === "/app.css") {
        route = "/app.css";
        return send(req, res, 200, APP_CSS, CSS_TYPE);
      }
      if (path === "/api/meta") {
        route = "/api/meta";
        return sendJson(req, res, 200, { schema: 1, editorUrl: opts.editorUrl });
      }
      if (path === "/events" && opts.events !== undefined) {
        route = "/events";
        // HEAD: the stream's status and headers, no body, and not counted against the cap.
        if (req.method === "HEAD") {
          res.writeHead(200, { ...SECURITY_HEADERS, "Content-Type": EVENT_TYPE });
          return void res.end();
        }
        return opts.events(res);
      }
      if (path === "/healthz") {
        route = "/healthz";
        return sendJson(req, res, 200, { status: "ok" });
      }
      if (path === "/api/tasks") {
        route = "/api/tasks";
        return sendJson(req, res, 200, opts.data.list());
      }
      if (REGISTRATION_PATH.test(path)) {
        // Without a runner factory the route does not exist, as /events without its stream.
        if (registration === null || opts.registration === undefined) return sendJson(req, res, 404, { error: "not found" });
        route = "/api/tasks/:id/registration";
        let id: string;
        try {
          id = decodeURIComponent(registration[1]);
        } catch {
          return sendJson(req, res, 400, { error: "invalid task id" });
        }
        if (!isTaskId(id) || !opts.data.ids().includes(id)) return sendJson(req, res, 400, { error: "invalid task id" });
        if (req.method !== "POST") return sendJson(req, res, 200, opts.registration.cached(id));
        const refused = registrationGuard(req, port);
        if (refused !== null) return sendJson(req, res, refused.status, { error: refused.error });
        return opts.registration.post(req, res, id);
      }
      if (path.startsWith("/api/tasks/")) {
        route = "/api/tasks/:id";
        let id: string;
        try {
          id = decodeURIComponent(path.slice("/api/tasks/".length));
        } catch {
          return sendJson(req, res, 400, { error: "invalid task id" });
        }
        // Matched against the listing, so no path is ever built from an id that is not a listed directory.
        if (!isTaskId(id) || !opts.data.ids().includes(id)) return sendJson(req, res, 400, { error: "invalid task id" });
        return sendJson(req, res, 200, opts.data.detail(id));
      }
      return sendJson(req, res, 404, { error: "not found" });
    } catch {
      opts.err(`base-ai dashboard: internal error on ${route}`);
      if (!res.headersSent) sendJson(req, res, 500, { error: "internal error" });
      else res.destroy();
    }
  };
}

/** The process events the dashboard listens to; `process` satisfies it, and tests pass a fake. */
export interface DashboardProcess {
  on(signal: "SIGINT" | "SIGTERM", listener: () => void): unknown;
  off(signal: "SIGINT" | "SIGTERM", listener: () => void): unknown;
}

export interface DashboardOptions {
  root: string;
  port: number;
  pricing: Pricing;
  out: (line: string) => void;
  err: (line: string) => void;
  proc: DashboardProcess;
  /** The validated editor link template; defaults to `vscode://file/{path}`. */
  editorUrl?: string;
  /** Defaults to the task data of `root`; injectable for tests. */
  data?: DashboardData;
  /** BASE-101-D3: injectable watch function and timers, the stream cap (10) and the heartbeat period (25 s). */
  watch?: WatchFn;
  timers?: Timers;
  maxClients?: number;
  heartbeatMs?: number;
  /** BASE-101-D4: makes the runner for one check; absent, the registration route does not exist. */
  registration?: (signal: AbortSignal) => Runner;
  /** The whole-run deadline (5 minutes); the 60-second per-call timeout is the runner's. */
  registrationDeadlineMs?: number;
  /** The clock for `checkedAt`; injectable for tests. */
  now?: () => Date;
}

/** What a check returns and what GET serves: keys, issue numbers and states only; no file, line, path or stderr. */
export interface RegistrationResult {
  schema: 1;
  ticket: string | null;
  outcome: DebtReport["outcome"];
  repo: string | null;
  calls: number;
  checkedAt: string;
  halt?: { template: string; reason: string; text: string };
  keys: { key: string; status: string; issue?: number; state?: string }[];
}

export function registrationResult(r: DebtReport, checkedAt: string): RegistrationResult {
  const out: RegistrationResult = {
    schema: 1,
    ticket: r.ticket,
    outcome: r.outcome,
    repo: r.repo,
    calls: r.calls,
    checkedAt,
    keys: r.keys.map((k) => ({ key: k.key, status: k.status, ...(k.issue === undefined ? {} : { issue: k.issue, state: k.state }) })),
  };
  if (r.halt) {
    // H7: T5 is the git remote read; T6 and T7 are gh calls.
    const tool = r.halt.template === "T5" ? "git" : "gh";
    out.halt = { template: r.halt.template, reason: r.halt.reason, text: `${tool}: ${haltText(r.halt.reason)}` };
  }
  return out;
}

export interface Dashboard {
  server: Server;
  /** The bound port, or a rejection whose message is the one line to print. */
  ready: Promise<number>;
  /** Resolves once a signal has closed the server. */
  stopped: Promise<void>;
}

export function startDashboard(o: DashboardOptions): Dashboard {
  let bound = o.port;
  const timers = o.timers ?? realTimers;
  const maxClients = o.maxClients ?? 10;
  const streams = new Set<ServerResponse>();
  /** H1: `retry: 2000` first; no `id:` field, because every reconnect reloads the full state. */
  const openStream = (res: ServerResponse) => {
    if (streams.size >= maxClients) {
      const body = JSON.stringify({ error: "too many event streams" });
      res.writeHead(503, { ...SECURITY_HEADERS, "Content-Type": JSON_TYPE, "Content-Length": String(Buffer.byteLength(body)) });
      return void res.end(body);
    }
    res.writeHead(200, { ...SECURITY_HEADERS, "Content-Type": EVENT_TYPE });
    res.flushHeaders();
    res.write("retry: 2000\n\n");
    streams.add(res);
    res.on("close", () => streams.delete(res));
  };
  const broadcast = (e: LiveEvent) => {
    // The id is a listed directory name that passed isTaskId, so the JSON has no newline and no path.
    const frame = e.kind === "task" ? `event: task\ndata: ${JSON.stringify({ id: e.id })}\n\n` : "event: list\ndata: {}\n\n";
    for (const res of streams) res.write(frame);
  };
  let watcher: { close(): void } | null = null;
  let heartbeat: unknown = null;

  // BASE-101-D4: one check at a time across all tasks (H5); the last result per task, in memory only (H6).
  const results = new Map<string, RegistrationResult>();
  let running: { abort: AbortController; deadline: unknown } | null = null;
  const now = o.now ?? (() => new Date());
  const factory = o.registration;
  const registration =
    factory === undefined
      ? undefined
      : {
          cached: (id: string): unknown => {
            // Ids no longer listed are dropped, so the map never outgrows the task folders.
            const listed = new Set(listTaskIds(o.root).ids);
            for (const k of Array.from(results.keys())) if (!listed.has(k)) results.delete(k);
            return results.get(id) ?? { schema: 1, checkedAt: null };
          },
          post: (req: IncomingMessage, res: ServerResponse, id: string): void => {
            const keys = taskKeys(o.root, join(".ai", "tasks", id));
            if (keys.kind === "keys") return sendJson(req, res, 422, { error: "keys not computed" });
            if (running !== null) return sendJson(req, res, 409, { error: "a registration check is already running" });
            const abort = new AbortController();
            const run = { abort, deadline: timers.setTimeout(() => abort.abort(), o.registrationDeadlineMs ?? 300_000) };
            running = run;
            // Review r1 L1: `catch` after `then`, so a throw while building the reply still answers 500; and a run
            // that `stop()` cut short (running no longer this run) neither caches nor replies.
            void checkRegistration(keys.report, [], factory(abort.signal))
              .then((report) => {
                if (running !== run) return;
                const result = registrationResult(report, now().toISOString());
                results.set(id, result);
                if (!res.writableEnded) sendJson(req, res, 200, result);
              })
              .catch(() => {
                if (running !== run) return;
                o.err("base-ai dashboard: internal error on /api/tasks/:id/registration");
                if (!res.writableEnded) sendJson(req, res, 500, { error: "internal error" });
              })
              .finally(() => {
                timers.clearTimeout(run.deadline);
                if (running === run) running = null;
              });
          },
        };

  const handler = createDashboardHandler({
    port: () => bound,
    data: o.data ?? dashboardData(o.root, o.pricing),
    err: o.err,
    editorUrl: o.editorUrl ?? DEFAULT_EDITOR_URL,
    events: openStream,
    registration,
  });
  const server = createServer(handler);
  // Node's default reply to a malformed request carries none of the security headers: send our own.
  server.on("clientError", (e: NodeJS.ErrnoException, socket: Socket) => {
    if (!socket.writable) return socket.destroy();
    socket.end(clientErrorReply(e.code));
  });
  // Tracked by hand: closeAllConnections is missing before Node 18.2, and engines is >=18.
  const sockets = new Set<Socket>();
  server.on("connection", (s: Socket) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });

  let resolveStopped!: () => void;
  const stopped = new Promise<void>((r) => (resolveStopped = r));
  const stop = () => {
    o.proc.off("SIGINT", stop);
    o.proc.off("SIGTERM", stop);
    // A running check first (its child is killed), then watchers and timers, the open streams, D1's socket teardown.
    if (running !== null) {
      running.abort.abort();
      timers.clearTimeout(running.deadline);
      running = null;
    }
    results.clear();
    watcher?.close();
    watcher = null;
    if (heartbeat !== null) timers.clearInterval(heartbeat);
    heartbeat = null;
    for (const res of streams) res.end();
    streams.clear();
    server.close(() => {
      o.err("base-ai dashboard: stopped");
      resolveStopped();
    });
    for (const s of sockets) s.destroy();
  };

  const ready = new Promise<number>((resolve, reject) => {
    server.once("error", (e: NodeJS.ErrnoException) => {
      reject(
        new Error(
          e.code === "EADDRINUSE"
            ? `base-ai dashboard: port ${o.port} is in use (choose another with --port <n>)`
            : `base-ai dashboard: cannot listen on ${HOST}:${o.port} (${e.code ?? "error"})`,
        ),
      );
    });
    server.listen(o.port, HOST, () => {
      const addr = server.address();
      bound = typeof addr === "object" && addr !== null ? addr.port : o.port;
      o.proc.on("SIGINT", stop);
      o.proc.on("SIGTERM", stop);
      watcher = startTaskWatcher({ root: o.root, onEvent: broadcast, err: o.err, watch: o.watch, timers });
      // H3: one shared heartbeat comment keeps idle streams open through proxies; it never keeps the process alive.
      heartbeat = timers.setInterval(() => {
        for (const res of streams) res.write(": ping\n\n");
      }, o.heartbeatMs ?? 25_000);
      (heartbeat as { unref?: () => void }).unref?.();
      o.out(`base-ai dashboard: http://${HOST}:${bound}/ (Ctrl+C to stop)`);
      resolve(bound);
    });
  });
  return { server, ready, stopped };
}
