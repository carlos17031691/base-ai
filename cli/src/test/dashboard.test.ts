import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { request, type IncomingHttpHeaders } from "node:http";
import { connect, createServer as createNetServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_PORT, clientErrorReply, parsePort, startDashboard, type DashboardData, type DashboardOptions } from "../dashboard.js";
import type { WatchFn } from "../dashboard-watch.js";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "index.js");
const SECURITY = {
  "content-security-policy": "default-src 'self'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cache-control": "no-store",
};

// Every server binds port 0 in a temp root and is closed in finally: never 4747 or this repository's .ai/tasks/.
function root() {
  const r = realpathSync(mkdtempSync(join(tmpdir(), "dash-srv-")));
  mkdirSync(join(r, ".ai", "tasks", "TK-1"), { recursive: true });
  writeFileSync(join(r, ".ai", "tasks", "TK-1", "status.json"), "{ broken");
  return r;
}

interface Res {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}
function get(port: number, path: string, o: { method?: string; host?: string | null; headers?: Record<string, string>; agent?: boolean } = {}): Promise<Res> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { ...(o.headers ?? {}) };
    if (o.host !== null) headers.Host = o.host ?? `127.0.0.1:${port}`;
    const req = request({ host: "127.0.0.1", port, path, method: o.method ?? "GET", headers, agent: o.agent === true ? undefined : false }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

/** A request with no Host header at all, which http.request always adds, so it goes over a raw socket. */
function rawNoHost(port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const s = connect(port, "127.0.0.1", () => s.write("GET /healthz HTTP/1.0\r\n\r\n"));
    let out = "";
    s.on("data", (c) => (out += c));
    s.on("end", () => resolve(out));
    s.on("error", reject);
  });
}

const fakeProc = () => Object.assign(new EventEmitter(), {}) as EventEmitter & { on: EventEmitter["on"]; off: EventEmitter["off"] };

type Extra = Pick<DashboardOptions, "watch" | "maxClients" | "heartbeatMs">;
async function withServer(
  fn: (port: number, ctx: { lines: string[]; errs: string[]; proc: EventEmitter; stopped: Promise<void>; root: string }) => Promise<void>,
  data?: DashboardData,
  extra: Extra = {},
) {
  const r = root();
  const lines: string[] = [];
  const errs: string[] = [];
  const proc = fakeProc();
  const d = startDashboard({ root: r, port: 0, pricing: {}, out: (l) => lines.push(l), err: (l) => errs.push(l), proc, data, ...extra });
  try {
    const port = await d.ready;
    await fn(port, { lines, errs, proc, stopped: d.stopped, root: r });
  } finally {
    // A server still running is stopped as the CLI stops it, so its watchers, timers and streams are closed too.
    if (proc.listenerCount("SIGTERM") > 0) {
      proc.emit("SIGTERM");
      await d.stopped;
    } else {
      d.server.closeAllConnections?.();
      await new Promise((res) => d.server.close(() => res(undefined)));
    }
    rmSync(r, { recursive: true, force: true });
  }
}

/** An open GET /events stream: its status, headers and everything received so far. */
interface Stream {
  status: number;
  headers: IncomingHttpHeaders;
  text: () => string;
  ended: Promise<void>;
  close: () => void;
}
function openEvents(port: number): Promise<Stream> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path: "/events", headers: { Host: `127.0.0.1:${port}` }, agent: false }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (text += c));
      const ended = new Promise<void>((r) => res.on("end", () => r()).on("close", () => r()));
      resolve({ status: res.statusCode ?? 0, headers: res.headers, text: () => text, ended, close: () => req.destroy() });
    });
    req.on("error", reject);
    req.end();
  });
}

async function until(cond: () => boolean, ms = 2000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** A fake watch: one listener per watched path, fired by hand; `closed` counts the handles closed. */
function fakeWatch() {
  const listeners = new Map<string, () => void>();
  let opened = 0;
  let closed = 0;
  const watch: WatchFn = (path, listener) => {
    listeners.set(path, listener);
    opened++;
    const handle = { close: () => void closed++, on: () => handle };
    return handle;
  };
  return { watch, listeners, counts: () => ({ opened, closed }) };
}

test("start: listens on 127.0.0.1 only, prints the URL, and GET /healthz returns 200", async () => {
  await withServer(async (port, { lines }) => {
    assert.deepEqual(lines, [`base-ai dashboard: http://127.0.0.1:${port}/ (Ctrl+C to stop)`]);
    const h = await get(port, "/healthz");
    assert.deepEqual([h.status, JSON.parse(h.body)], [200, { status: "ok" }]);
  });
});

test("start: the server address is 127.0.0.1, and parsePort defaults to 4747 and refuses other values", async () => {
  const r = root();
  const d = startDashboard({ root: r, port: 0, pricing: {}, out: () => {}, err: () => {}, proc: fakeProc() });
  try {
    await d.ready;
    assert.equal((d.server.address() as AddressInfo).address, "127.0.0.1");
  } finally {
    await new Promise((res) => d.server.close(() => res(undefined)));
    rmSync(r, { recursive: true, force: true });
  }
  assert.equal(DEFAULT_PORT, 4747);
  assert.equal(parsePort(undefined), 4747);
  for (const [v, n] of [["0", 0], ["1", 1], ["65535", 65535]] as const) assert.equal(parsePort(v), n);
  for (const v of ["65536", "-1", "abc", "1.5", "0x10", "", "123456", true] as const) assert.equal(parsePort(v), null, String(v));
});

test("task list and detail routes return the JSON API shapes; / is the HUD page; others are 404", async () => {
  await withServer(async (port) => {
    const list = await get(port, "/api/tasks");
    assert.equal(list.status, 200);
    assert.equal(list.headers["content-type"], "application/json; charset=utf-8");
    const body = JSON.parse(list.body);
    assert.deepEqual([body.schema, body.skipped, body.tasks.length, body.tasks[0].id, body.tasks[0].ok], [1, 0, 1, "TK-1", false]);
    assert.equal(body.tasks[0].problem, "not valid JSON");

    const detail = await get(port, "/api/tasks/TK-1");
    assert.equal(detail.status, 200);
    const d = JSON.parse(detail.body);
    assert.deepEqual([d.id, d.checks.length, d.transitions.length], ["TK-1", 18, 0]);

    const page = await get(port, "/");
    assert.equal(page.status, 200);
    assert.equal(page.headers["content-type"], "text/html; charset=utf-8");
    // BASE-101-D2 (H11): the HUD skeleton loads same-origin /app.js and /app.css, with no inline code or style.
    assert.match(page.body, /<script src="\/app\.js" defer><\/script>/);
    assert.match(page.body, /<link rel="stylesheet" href="\/app\.css">/);
    assert.doesNotMatch(page.body, /<script>|<script [^>]*>[^<]|<style|style=|\son[a-z]+=|https?:\/\//i);

    assert.equal((await get(port, "/nope")).status, 404);
    assert.equal((await get(port, "/healthz?x=1")).status, 200, "the query string is ignored");
  });
});

test("invalid id or traversal: 400 for ..%2F..%2Fetc, dot segments, a bad escape, an empty id and an unlisted id", async () => {
  await withServer(async (port) => {
    for (const p of ["/api/tasks/..%2F..%2Fetc", "/api/tasks/%2e%2e", "/api/tasks/..", "/api/tasks/%E0%A4%A", "/api/tasks/", "/api/tasks/TK-9", "/api/tasks/a%20b"]) {
      const r = await get(port, p);
      assert.deepEqual([r.status, JSON.parse(r.body)], [400, { error: "invalid task id" }], p);
    }
  });
});

test("DNS rebinding: a Host other than 127.0.0.1:<port> or localhost:<port> gives 403, before any other check", async () => {
  await withServer(async (port) => {
    for (const host of [`evil.test:${port}`, "127.0.0.1", `127.0.0.1:${port + 1}`, `[::1]:${port}`]) {
      const r = await get(port, "/healthz", { host });
      assert.deepEqual([r.status, JSON.parse(r.body)], [403, { error: "forbidden host" }], host);
    }
    assert.match(await rawNoHost(port), /^HTTP\/1\.1 403/);
    assert.equal((await get(port, "/healthz", { host: `LOCALHOST:${port}` })).status, 200);
    assert.equal((await get(port, "/healthz", { host: `localhost:${port}` })).status, 200);
    assert.equal((await get(port, "/healthz", { host: `evil.test:${port}`, method: "POST" })).status, 403, "403 wins over 405");
  });
});

test("read-only: every method other than GET or HEAD gives 405 with Allow: GET, HEAD", async () => {
  await withServer(async (port) => {
    for (const method of ["POST", "PUT", "DELETE", "OPTIONS", "PATCH"]) {
      const r = await get(port, "/api/tasks", { method });
      assert.deepEqual([r.status, r.headers.allow, JSON.parse(r.body)], [405, "GET, HEAD", { error: "method not allowed" }], method);
    }
  });
});

test("HEAD gives the same status and headers as GET, with an empty body", async () => {
  await withServer(async (port) => {
    for (const p of ["/healthz", "/api/tasks/TK-1", "/nope"]) {
      const g = await get(port, p);
      const h = await get(port, p, { method: "HEAD" });
      assert.equal(h.status, g.status, p);
      assert.equal(h.body, "", p);
      for (const k of ["content-type", "content-length", ...Object.keys(SECURITY)]) assert.equal(h.headers[k], g.headers[k], `${p} ${k}`);
    }
  });
});

test("headers: every response has the CSP, nosniff, no-referrer and no-store, and no Access-Control-* header", async () => {
  await withServer(async (port) => {
    const responses = [
      await get(port, "/healthz"),
      await get(port, "/"),
      await get(port, "/api/tasks/..%2F..%2Fetc"),
      await get(port, "/healthz", { host: "evil.test" }),
      await get(port, "/nope"),
      await get(port, "/api/tasks", { method: "OPTIONS", headers: { Origin: "http://evil.test", "Access-Control-Request-Method": "GET" } }),
    ];
    assert.deepEqual(responses.map((r) => r.status), [200, 200, 400, 403, 404, 405]);
    for (const r of responses) {
      for (const [k, v] of Object.entries(SECURITY)) assert.equal(r.headers[k], v, `${r.status} ${k}`);
      assert.deepEqual(Object.keys(r.headers).filter((k) => k.startsWith("access-control-")), [], String(r.status));
    }
  });
});

test("an exception inside a handler gives 500 with no message or stack, and the server keeps serving", async () => {
  const data: DashboardData = {
    ids: () => ["TK-1"],
    list: () => {
      throw new Error("secret detail /home/x");
    },
    detail: () => ({ ok: true }),
  };
  await withServer(async (port, { errs }) => {
    const r = await get(port, "/api/tasks");
    assert.deepEqual([r.status, JSON.parse(r.body)], [500, { error: "internal error" }]);
    assert.doesNotMatch(r.body, /secret|at /);
    assert.deepEqual(errs, ["base-ai dashboard: internal error on /api/tasks"]);
    assert.equal((await get(port, "/api/tasks/TK-1")).status, 200, "next request succeeds");
  }, data);
});

test("port busy: startDashboard rejects with a --port hint; no signal listener is left", async () => {
  const holder = createNetServer();
  await new Promise<void>((res) => holder.listen(0, "127.0.0.1", () => res()));
  const port = (holder.address() as AddressInfo).port;
  const r = root();
  const proc = fakeProc();
  try {
    const d = startDashboard({ root: r, port, pricing: {}, out: () => {}, err: () => {}, proc });
    await assert.rejects(d.ready, new RegExp(`^Error: base-ai dashboard: port ${port} is in use \\(choose another with --port <n>\\)$`));
    assert.deepEqual([proc.listenerCount("SIGINT"), proc.listenerCount("SIGTERM")], [0, 0]);
  } finally {
    await new Promise((res) => holder.close(() => res(undefined)));
    rmSync(r, { recursive: true, force: true });
  }
});

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  test(`graceful shutdown on ${signal}: the server closes, a keep-alive socket is destroyed, listeners are removed`, async () => {
    const r = root();
    const errs: string[] = [];
    const proc = fakeProc();
    const d = startDashboard({ root: r, port: 0, pricing: {}, out: () => {}, err: (l) => errs.push(l), proc });
    let s: ReturnType<typeof connect> | undefined;
    try {
      const port = await d.ready;
      // A held keep-alive connection would keep server.close() waiting without the socket tracking.
      s = connect(port, "127.0.0.1");
      const sock = s;
      await new Promise<void>((res) => sock.on("connect", () => res()));
      sock.write(`GET /healthz HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: keep-alive\r\n\r\n`);
      await new Promise<void>((res) => sock.once("data", () => res()));
      const closed = new Promise<void>((res) => sock.on("close", () => res()));
      proc.emit(signal);
      await d.stopped;
      await closed;
      assert.equal(d.server.listening, false);
      assert.deepEqual([proc.listenerCount("SIGINT"), proc.listenerCount("SIGTERM")], [0, 0]);
      assert.deepEqual(errs, ["base-ai dashboard: stopped"]);
    } finally {
      // Review r1 L1: a failed assertion must not leave the server or the socket open and hang the file.
      s?.destroy();
      if (d.server.listening) await new Promise((res) => d.server.close(() => res(undefined)));
      rmSync(r, { recursive: true, force: true });
    }
  });
}

// --- Spawned CLI ---

function spawnCli(args: string[]) {
  const child = spawn(process.execPath, [CLI, "dashboard", ...args], { stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  let err = "";
  child.stdout.setEncoding("utf8").on("data", (c) => (out += c));
  child.stderr.setEncoding("utf8").on("data", (c) => (err += c));
  const exit = new Promise<number | null>((res) => child.on("exit", (code, sig) => res(sig === null ? code : -1)));
  const url = new Promise<number>((res, rej) => {
    child.stdout.on("data", () => {
      const m = /http:\/\/127\.0\.0\.1:(\d+)\//.exec(out);
      if (m) res(Number(m[1]));
    });
    child.on("exit", () => rej(new Error(`exited before listening: ${err}`)));
  });
  url.catch(() => {});
  return { child, exit, url, out: () => out, err: () => err };
}

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  test(`spawned CLI: prints the URL, serves /healthz, and exits 0 on ${signal}`, async () => {
    const r = root();
    const c = spawnCli(["--root", r, "--port", "0"]);
    try {
      const port = await c.url;
      assert.match(c.out().split("\n")[0], /^base-ai dashboard: http:\/\/127\.0\.0\.1:\d+\/ \(Ctrl\+C to stop\)$/);
      assert.equal((await get(port, "/healthz")).status, 200);
      c.child.kill(signal);
      assert.equal(await c.exit, 0);
      assert.match(c.err(), /base-ai dashboard: stopped/);
    } finally {
      c.child.kill("SIGKILL");
      rmSync(r, { recursive: true, force: true });
    }
  });
}

test("spawned CLI: a busy port, a bad --port and a root without .ai/ each exit 1", async () => {
  const holder = createNetServer();
  await new Promise<void>((res) => holder.listen(0, "127.0.0.1", () => res()));
  const port = (holder.address() as AddressInfo).port;
  const r = root();
  const bare = realpathSync(mkdtempSync(join(tmpdir(), "dash-bare-")));
  const children: ReturnType<typeof spawnCli>[] = [];
  const cli = (args: string[]) => {
    const c = spawnCli(args);
    children.push(c);
    return c;
  };
  try {
    const busy = cli(["--root", r, "--port", String(port)]);
    assert.equal(await busy.exit, 1);
    assert.match(busy.err(), /port \d+ is in use \(choose another with --port <n>\)/);

    const bad = cli(["--root", r, "--port", "70000"]);
    assert.equal(await bad.exit, 1);
    assert.match(bad.err(), /--port must be an integer from 0 to 65535/);

    const none = cli(["--root", bare, "--port", "0"]);
    assert.equal(await none.exit, 1);
    assert.match(none.err(), /Not a base-ai project/);
  } finally {
    // Review r1 L1: a child that unexpectedly listens must not outlive a failed assertion.
    for (const c of children) c.child.kill("SIGKILL");
    await new Promise((res) => holder.close(() => res(undefined)));
    rmSync(r, { recursive: true, force: true });
    rmSync(bare, { recursive: true, force: true });
  }
});

test("review r1 L2: a malformed request gets 400, and oversized headers 431, with the security headers", async () => {
  await withServer(async (port) => {
    const raw = (text: string) =>
      new Promise<string>((resolve, reject) => {
        const s = connect(port, "127.0.0.1", () => s.write(text));
        let out = "";
        s.on("data", (c) => (out += c));
        s.on("end", () => resolve(out));
        s.on("close", () => resolve(out));
        // Review r2 L8: the server may reset a connection whose request it did not finish reading (the 431
        // case on Linux). Once a whole response head has arrived, that reset is not a failure.
        s.on("error", (e) => (out.includes("\r\n\r\n") ? resolve(out) : reject(e)));
      });
    for (const [text, status] of [
      ["NOT A REQUEST\r\n\r\n", "400 Bad Request"],
      [`GET /healthz HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nX-Big: ${"a".repeat(20_000)}\r\n\r\n`, "431 Request Header Fields Too Large"],
    ] as const) {
      const out = await raw(text);
      assert.match(out, new RegExp(`^HTTP/1\\.1 ${status}\r\n`), status);
      for (const [k, v] of Object.entries(SECURITY)) assert.ok(out.toLowerCase().includes(`${k}: ${v.toLowerCase()}`), `${status} ${k}`);
      assert.doesNotMatch(out.toLowerCase(), /access-control-/);
    }
  });
});

test("review r2 L7: clientErrorReply keeps Node's status per parser error, always with the security headers", () => {
  for (const [code, status, error] of [
    ["ERR_HTTP_REQUEST_TIMEOUT", "408 Request Timeout", "request timeout"],
    ["HPE_HEADER_OVERFLOW", "431 Request Header Fields Too Large", "request header fields too large"],
    ["HPE_CHUNK_EXTENSIONS_OVERFLOW", "413 Payload Too Large", "payload too large"],
    ["HPE_INVALID_METHOD", "400 Bad Request", "bad request"],
    [undefined, "400 Bad Request", "bad request"],
  ] as const) {
    const reply = clientErrorReply(code);
    const [head, body] = reply.split("\r\n\r\n");
    assert.ok(head.startsWith(`HTTP/1.1 ${status}\r\n`), String(code));
    assert.deepEqual(JSON.parse(body), { error }, String(code));
    for (const [k, v] of Object.entries(SECURITY)) assert.ok(head.toLowerCase().includes(`${k}: ${v.toLowerCase()}`), `${code} ${k}`);
    assert.match(head, new RegExp(`\r\nContent-Length: ${Buffer.byteLength(body)}\r\n`));
    assert.match(head, /\r\nConnection: close$/);
  }
});

test("D2 routes: /app.js, /app.css and /api/meta from memory with their Content-Types and D1's headers; HEAD has no body", async () => {
  await withServer(async (port) => {
    for (const [path, type] of [
      ["/app.js", "text/javascript; charset=utf-8"],
      ["/app.css", "text/css; charset=utf-8"],
      ["/api/meta", "application/json; charset=utf-8"],
    ] as const) {
      const r = await get(port, path);
      assert.equal(r.status, 200, path);
      assert.equal(r.headers["content-type"], type, path);
      for (const [k, v] of Object.entries(SECURITY)) assert.equal(r.headers[k], v, `${path} ${k}`);
      assert.equal(r.headers["access-control-allow-origin"], undefined);
      assert.equal(Number(r.headers["content-length"]), Buffer.byteLength(r.body), path);
      const head = await get(port, path, { method: "HEAD" });
      assert.deepEqual([head.status, head.body], [200, ""], `HEAD ${path}`);
    }
    assert.deepEqual(JSON.parse((await get(port, "/api/meta")).body), { schema: 1, editorUrl: "vscode://file/{path}" });
    assert.match((await get(port, "/app.js")).body, /^\(function \(\) \{\n"use strict";/);
    assert.equal((await get(port, "/app.js", { host: "evil.test" })).status, 403, "the Host guard covers the assets");
    assert.equal((await get(port, "/app.css", { method: "POST" })).status, 405);
  });
});

test("D2 H2: /api/meta serves the configured editor template", async () => {
  const r = root();
  const d = startDashboard({ root: r, port: 0, pricing: {}, out: () => {}, err: () => {}, proc: fakeProc(), editorUrl: "cursor://file/{path}" });
  try {
    const port = await d.ready;
    assert.deepEqual(JSON.parse((await get(port, "/api/meta")).body), { schema: 1, editorUrl: "cursor://file/{path}" });
  } finally {
    await new Promise((res) => d.server.close(() => res(undefined)));
    rmSync(r, { recursive: true, force: true });
  }
});

test("D2 H2: an invalid dashboard.editor_url makes the CLI exit 1 at start with one line naming the key", async () => {
  const r = root();
  writeFileSync(join(r, ".ai", "config.yaml"), 'dashboard:\n  editor_url: "javascript:alert(1)//{path}"\n');
  try {
    const c = spawnCli(["--root", r, "--port", "0"]);
    try {
      assert.equal(await c.exit, 1);
      assert.match(c.err(), /"dashboard\.editor_url" must be/);
    } finally {
      c.child.kill("SIGKILL");
    }
  } finally {
    rmSync(r, { recursive: true, force: true });
  }
});

test("D3 /events: 200 text/event-stream with D1's security headers, no CORS and a retry line; HEAD has no body; Host and method guards first", async () => {
  await withServer(async (port) => {
    const st = await openEvents(port);
    try {
      assert.equal(st.status, 200);
      assert.equal(st.headers["content-type"], "text/event-stream; charset=utf-8");
      for (const [k, v] of Object.entries(SECURITY)) assert.equal(st.headers[k], v, k);
      assert.ok(!Object.keys(st.headers).some((k) => k.startsWith("access-control-")));
      assert.equal(st.headers["content-length"], undefined);
      await until(() => st.text().includes("retry: 2000\n\n"));
      assert.ok(st.text().startsWith("retry: 2000\n\n"));
    } finally {
      st.close();
    }
    const head = await get(port, "/events", { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(head.headers["content-type"], "text/event-stream; charset=utf-8");
    assert.equal(head.body, "");
    assert.equal((await get(port, "/events", { host: "evil.example:80" })).status, 403);
    assert.equal((await get(port, "/events", { method: "POST" })).status, 405);
  });
});

test("D3 events: a change in a task directory reaches every open stream once as event task; a new directory as event list", async () => {
  const w = fakeWatch();
  await withServer(
    async (port, { root: r }) => {
      const a = await openEvents(port);
      const b = await openEvents(port);
      try {
        await until(() => a.text().includes("retry") && b.text().includes("retry"));
        const task = w.listeners.get(join(r, ".ai", "tasks", "TK-1"));
        task?.();
        task?.();
        const frame = 'event: task\ndata: {"id":"TK-1"}\n\n';
        await until(() => a.text().includes(frame) && b.text().includes(frame));
        mkdirSync(join(r, ".ai", "tasks", "TK-2"));
        w.listeners.get(join(r, ".ai", "tasks"))?.();
        await until(() => a.text().includes("event: list\ndata: {}\n\n") && b.text().includes("event: list\ndata: {}\n\n"));
        assert.equal(a.text().split(frame).length - 1, 1, "two raw events in one window give one frame");
        assert.ok(!a.text().includes(r), "no path reaches a stream");
      } finally {
        a.close();
        b.close();
      }
    },
    undefined,
    { watch: w.watch },
  );
});

test("D3 heartbeat: open streams get a ': ping' comment on the heartbeat timer", async () => {
  await withServer(
    async (port) => {
      const st = await openEvents(port);
      try {
        await until(() => st.text().includes(": ping\n\n"));
      } finally {
        st.close();
      }
    },
    undefined,
    { heartbeatMs: 20, watch: fakeWatch().watch },
  );
});

test("D3 client cap: with 10 streams open the 11th gets 503 JSON; after one closes a new stream gets 200", async () => {
  await withServer(
    async (port) => {
      const open: Stream[] = [];
      try {
        for (let i = 0; i < 10; i++) open.push(await openEvents(port));
        assert.ok(open.every((s) => s.status === 200));
        assert.equal((await get(port, "/events", { method: "HEAD" })).status, 200, "HEAD is not counted");
        const over = await get(port, "/events");
        assert.equal(over.status, 503);
        assert.equal(over.headers["content-type"], "application/json; charset=utf-8");
        assert.deepEqual(JSON.parse(over.body), { error: "too many event streams" });
        for (const [k, v] of Object.entries(SECURITY)) assert.equal(over.headers[k], v, k);
        open.shift()?.close();
        let again: Stream | null = null;
        for (let i = 0; i < 50 && (again === null || again.status !== 200); i++) {
          again?.close();
          again = await openEvents(port);
          if (again.status !== 200) await new Promise((r) => setTimeout(r, 20));
        }
        assert.equal(again?.status, 200);
        open.push(again as Stream);
      } finally {
        for (const s of open) s.close();
      }
    },
    undefined,
    { watch: fakeWatch().watch },
  );
});

test("D3 stop: SIGTERM with open streams ends them, closes every watcher and still resolves stopped", async () => {
  const w = fakeWatch();
  await withServer(
    async (port, { proc, stopped, errs }) => {
      const a = await openEvents(port);
      const b = await openEvents(port);
      proc.emit("SIGTERM");
      await Promise.all([a.ended, b.ended, stopped]);
      assert.deepEqual([proc.listenerCount("SIGINT"), proc.listenerCount("SIGTERM")], [0, 0]);
      assert.equal(w.counts().closed, w.counts().opened, "every watcher closed");
      assert.ok(errs.includes("base-ai dashboard: stopped"));
    },
    undefined,
    { watch: w.watch },
  );
});

test("D3 spawned CLI: with an /events stream open, SIGTERM still exits 0", async () => {
  const r = root();
  const c = spawnCli(["--root", r, "--port", "0"]);
  try {
    const port = await c.url;
    const st = await openEvents(port);
    await until(() => st.text().includes("retry"));
    c.child.kill("SIGTERM");
    assert.equal(await c.exit, 0);
    await st.ended;
    assert.match(c.err(), /base-ai dashboard: stopped/);
  } finally {
    c.child.kill("SIGKILL");
    rmSync(r, { recursive: true, force: true });
  }
});
