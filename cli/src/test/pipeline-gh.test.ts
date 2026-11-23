import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnRunner } from "../pipeline-gh.js";

/** True while a process with this pid exists (signal 0 only checks). */
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const until = async (cond: () => boolean, ms = 2000) => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
};

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
  // The child writes its pid to a file, then sleeps; after the abort it must be gone (review r1 L3).
  const dir = mkdtempSync(join(tmpdir(), "gh-pid-"));
  const pidFile = join(dir, "pid");
  try {
    const pending = run(node, ["-e", `require("fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setTimeout(() => {}, 30000)`]);
    await until(() => {
      try {
        return readFileSync(pidFile, "utf8").length > 0;
      } catch {
        return false;
      }
    });
    const pid = Number(readFileSync(pidFile, "utf8"));
    assert.ok(alive(pid));
    // Review r2 L6: timed from the abort itself, against the plan's 1 s.
    const aborted = Date.now();
    abort.abort();
    assert.deepEqual(await pending, { kind: "error", reason: "timeout" });
    assert.ok(Date.now() - aborted < 1000, "returned within 1 s of the abort");
    await until(() => !alive(pid), 1000);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const t0 = Date.now();
  assert.deepEqual(await run(node, ["-e", "setTimeout(() => {}, 30000)"]), { kind: "error", reason: "timeout" });
  assert.ok(Date.now() - t0 < 100, "no process was started after the abort");
});

test("review r1 L3: an output overflow kills the child, which is gone afterwards", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gh-pid-"));
  const pidFile = join(dir, "pid");
  try {
    const r = await spawnRunner({ maxBytes: 16 })(node, [
      "-e",
      `require("fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); process.stdout.write("x".repeat(1000)); setTimeout(() => {}, 30000)`,
    ]);
    assert.deepEqual(r, { kind: "error", reason: "overflow" });
    const pid = Number(readFileSync(pidFile, "utf8"));
    await until(() => !alive(pid), 1000);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
