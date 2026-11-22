/**
 * `base-ai dashboard` (BASE-101-D1, epic #101): a local, read-only `node:http` server over `.ai/tasks/`, bound to
 * 127.0.0.1 only. No network beyond this listener, no write, no CORS. Pages come from memory (dashboard-assets.ts).
 *
 * Every request is checked in a fixed order: Host (403, against DNS rebinding), method (405), path (404), id (400).
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { INDEX_HTML } from "./dashboard-assets.js";
import { isTaskId, listTaskIds, listTasks, taskDetail } from "./dashboard-data.js";
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

function send(req: IncomingMessage, res: ServerResponse, status: number, body: string, type: string, extra: Record<string, string> = {}): void {
  const payload = Buffer.from(body, "utf8");
  res.writeHead(status, { ...SECURITY_HEADERS, ...extra, "Content-Type": type, "Content-Length": String(payload.length) });
  // HEAD: same status and headers as GET, no body.
  res.end(req.method === "HEAD" ? undefined : payload);
}
const sendJson = (req: IncomingMessage, res: ServerResponse, status: number, body: unknown, extra?: Record<string, string>) =>
  send(req, res, status, JSON.stringify(body), JSON_TYPE, extra);

export interface HandlerOptions {
  /** The bound port, read per request: the Host check compares against it. */
  port: () => number;
  data: DashboardData;
  err: (line: string) => void;
}

export function createDashboardHandler(opts: HandlerOptions): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    const port = opts.port();
    const host = (req.headers.host ?? "").toLowerCase();
    if (host !== `${HOST}:${port}` && host !== `localhost:${port}`) return sendJson(req, res, 403, { error: "forbidden host" });
    if (req.method !== "GET" && req.method !== "HEAD") {
      return sendJson(req, res, 405, { error: "method not allowed" }, { Allow: "GET, HEAD" });
    }
    // The raw path up to "?": no URL normalisation, so dot segments are never resolved.
    const path = (req.url ?? "").split("?")[0];
    // A fixed label, never the untrusted path, goes to stderr.
    let route = "unknown";
    try {
      if (path === "/") {
        route = "/";
        return send(req, res, 200, INDEX_HTML, HTML_TYPE);
      }
      if (path === "/healthz") {
        route = "/healthz";
        return sendJson(req, res, 200, { status: "ok" });
      }
      if (path === "/api/tasks") {
        route = "/api/tasks";
        return sendJson(req, res, 200, opts.data.list());
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
  /** Defaults to the task data of `root`; injectable for tests. */
  data?: DashboardData;
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
  const handler = createDashboardHandler({ port: () => bound, data: o.data ?? dashboardData(o.root, o.pricing), err: o.err });
  const server = createServer(handler);
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
      o.out(`base-ai dashboard: http://${HOST}:${bound}/ (Ctrl+C to stop)`);
      resolve(bound);
    });
  });
  return { server, ready, stopped };
}
