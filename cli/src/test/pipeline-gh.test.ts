import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnRunner } from "../pipeline-gh.js";

// Only process.execPath and a nonexistent binary are spawned; never gh, never the network.
const node = process.execPath;

test("spawnRunner returns stdout on success", () => {
  assert.deepEqual(spawnRunner()(node, ["-e", "process.stdout.write('ok')"]), { kind: "ok", stdout: "ok" });
});

test("spawnRunner maps a non-zero exit, a timeout, an output overflow and a missing binary", () => {
  assert.deepEqual(spawnRunner()(node, ["-e", "process.exit(3)"]), { kind: "error", reason: "exit" });
  assert.deepEqual(spawnRunner(200)(node, ["-e", "setTimeout(() => {}, 5000)"]), { kind: "error", reason: "timeout" });
  assert.deepEqual(spawnRunner(10_000, 16)(node, ["-e", "process.stdout.write('x'.repeat(1000))"]), { kind: "error", reason: "overflow" });
  assert.deepEqual(spawnRunner()("base-ai-no-such-binary-for-tests", []), { kind: "error", reason: "missing" });
});
