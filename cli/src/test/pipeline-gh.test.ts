import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnRunner } from "../pipeline-gh.js";

// Only process.execPath and a nonexistent binary are spawned; never gh, never the network.
const node = process.execPath;

test("spawnRunner returns stdout on success", async () => {
  assert.deepEqual(await spawnRunner()(node, ["-e", "process.stdout.write('ok')"]), { kind: "ok", stdout: "ok" });
});

test("spawnRunner maps a non-zero exit, a timeout, an output overflow and a missing binary", async () => {
  assert.deepEqual(await spawnRunner()(node, ["-e", "process.exit(3)"]), { kind: "error", reason: "exit" });
  assert.deepEqual(await spawnRunner({ timeoutMs: 200 })(node, ["-e", "setTimeout(() => {}, 5000)"]), { kind: "error", reason: "timeout" });
  assert.deepEqual(await spawnRunner({ maxBytes: 16 })(node, ["-e", "process.stdout.write('x'.repeat(1000))"]), { kind: "error", reason: "overflow" });
  assert.deepEqual(await spawnRunner()("base-ai-no-such-binary-for-tests", []), { kind: "error", reason: "missing" });
});

test("D4 H3: stderr is drained and never returned; the runner is async, so the event loop keeps running during a call", async () => {
  let ticks = 0;
  const tick = setInterval(() => ticks++, 10);
  try {
    const r = await spawnRunner()(node, ["-e", "process.stderr.write('SECRET-STDERR'); setTimeout(() => process.stdout.write('done'), 150)"]);
    assert.deepEqual(r, { kind: "ok", stdout: "done" });
    assert.ok(ticks >= 3, "timers fired while the child ran");
  } finally {
    clearInterval(tick);
  }
});

test("D4 H8: aborting the signal mid-call kills the child within 1 s and returns timeout; later calls spawn nothing", async () => {
  const abort = new AbortController();
  const run = spawnRunner({ signal: abort.signal });
  const started = Date.now();
  // The child prints its pid, then sleeps; after the abort it must be gone.
  const pending = run(node, ["-e", "setTimeout(() => {}, 30000)"]);
  setTimeout(() => abort.abort(), 100);
  assert.deepEqual(await pending, { kind: "error", reason: "timeout" });
  assert.ok(Date.now() - started < 1000, "returned within 1 s of the abort");
  const t0 = Date.now();
  assert.deepEqual(await run(node, ["-e", "setTimeout(() => {}, 30000)"]), { kind: "error", reason: "timeout" });
  assert.ok(Date.now() - t0 < 100, "no process was started after the abort");
});
