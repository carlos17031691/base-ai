import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadTask, readBounded } from "../pipeline-files.js";

const CLI = resolve(dirname(fileURLToPath(import.meta.url)), "..", "index.js");
const C = "2026-01-01T00:03:00Z";

function writeTask(root: string, id: string, files: Record<string, string>) {
  const dir = join(root, ".ai", "tasks", id);
  mkdirSync(dir, { recursive: true });
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  return dir;
}

const status = JSON.stringify({
  ticket_id: "TK-2",
  state: "completed",
  plan_locked: true,
  assignee: null,
  blocker: null,
  transitions: [
    { from: null, to: "pending", agent: "planner", timestamp: "2026-01-01T00:00:00Z", note: "init" },
    { from: "pending", to: "pending", agent: "human", timestamp: "2026-01-01T00:01:00Z", note: "approved" },
    { from: "pending", to: "in_progress", agent: "implementer", timestamp: "2026-01-01T00:02:00Z", note: "claim" },
    { from: "in_progress", to: "completed", agent: "implementer", timestamp: C, note: "done" },
    { from: "completed", to: "completed", agent: "reviewer", timestamp: "2026-01-01T00:04:00Z", note: `review round 1: approved; reviewed implementer completion ${C}` },
    { from: "completed", to: "completed", agent: "qa", timestamp: "2026-01-01T00:05:00Z", note: `qa round 1: pass; verified implementer completion ${C}` },
  ],
  checklist: { tests_pass: true, lint_pass: false, types_pass: true, review_verdict: "approved", qa_verdict: "pass" },
});
const files = {
  "status.json": status,
  "plan.md": "# Plan\n## Steps\n1. **human** — ok\n",
  "review-report.md": `Round: 1\n${C}\n## Verdict: approved\n| L1 | x | To register |\n`,
  "qa-report.md": `Round: 1\nImplementer completion verified: ${C}\n## Verdict: pass\n`,
};

const run = (args: string[]) => spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8" });

test("pipeline check exits 0 on a consistent task, resolving the directory against --root", () => {
  const root = mkdtempSync(join(tmpdir(), "pc-"));
  try {
    writeTask(root, "TK-2", files);
    const r = run(["pipeline", "check", ".ai/tasks/TK-2", "--root", root]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /^pipeline check TK-2: PASS/);
    assert.match(r.stdout, /reg TK-2 review r1 i1 — review-report\.md:4/);
    const before = run(["pipeline", "check", "--json", ".ai/tasks/TK-2", "--root", root]);
    assert.equal(before.status, 0, "--json before the task directory keeps the path (review L1)");
    assert.equal(JSON.parse(before.stdout).ok, true);
    const j = run(["pipeline", "check", ".ai/tasks/TK-2", "--json", "--root", root]);
    assert.equal(j.status, 0);
    const parsed = JSON.parse(j.stdout);
    for (const k of ["schema", "rule", "ok", "checks", "facts", "keys"]) assert.ok(k in parsed, k);
    assert.equal(parsed.keys[0].key, "reg TK-2 review r1 i1");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("pipeline check exits 1 on a malformed task, names the failed checks, and prints no stack trace", () => {
  const root = mkdtempSync(join(tmpdir(), "pc-"));
  try {
    writeTask(root, "TK-2", { ...files, "status.json": "{ broken" });
    const r = run(["pipeline", "check", join(root, ".ai/tasks/TK-2")]);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /✖ K1 status\.parse — not valid JSON/);
    assert.doesNotMatch(r.stdout + r.stderr, /\n\s+at /);
    const j = run(["pipeline", "check", join(root, ".ai/tasks/TK-2"), "--json"]);
    assert.equal(j.status, 1);
    const parsed = JSON.parse(j.stdout);
    assert.equal(parsed.ok, false);
    assert.deepEqual(parsed.checks.filter((c: { status: string }) => c.status === "fail").map((c: { id: string }) => c.id), ["K1"]);
    const missing = run(["pipeline", "check", join(root, "nope")]);
    assert.equal(missing.status, 1);
    assert.match(missing.stdout, /status\.json is missing/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("pipeline check with no task directory exits 1 with a usage line", () => {
  const r = run(["pipeline", "check"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /usage: base-ai pipeline check <task-dir>/);
});

test("readBounded reports missing, oversized and directory paths without throwing", () => {
  const root = mkdtempSync(join(tmpdir(), "pc-"));
  try {
    writeFileSync(join(root, "big.txt"), "x".repeat(20));
    assert.deepEqual(readBounded(join(root, "absent.txt")), { kind: "missing" });
    assert.deepEqual(readBounded(join(root, "big.txt"), 10), { kind: "error", reason: "larger than 10 bytes" });
    assert.deepEqual(readBounded(join(root, "big.txt")), { kind: "ok", text: "x".repeat(20) });
    assert.deepEqual(readBounded(root), { kind: "error", reason: "is a directory" });
    assert.deepEqual(readBounded(join(root, "big.txt", "child")), { kind: "missing" });
    // A FIFO must not block the read (review L3); mkfifo exists on macOS and Linux.
    if (spawnSync("mkfifo", [join(root, "fifo")]).status === 0) {
      assert.deepEqual(readBounded(join(root, "fifo")), { kind: "error", reason: "is not a regular file" });
    }
    const t = loadTask(root, "x/TK-9");
    assert.equal(t.dirName, "TK-9");
    assert.equal(t.absPath, resolve(root, "x/TK-9"));
    assert.deepEqual(t.status, { kind: "missing" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("pipeline check names K17 for a malformed decisions.md", () => {
  const root = mkdtempSync(join(tmpdir(), "pc-"));
  try {
    writeTask(root, "TK-2", { ...files, "decisions.md": "# D\n\n## Notes\n" });
    const r = run(["pipeline", "check", ".ai/tasks/TK-2", "--root", root]);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /✖ K17 decisions\.format — line 3: a "## " heading/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("pipeline debt: zero keys exit 0 with no command; keys outside a git repository halt at T5 (exit 2); bad --issues is a usage error", () => {
  const root = mkdtempSync(join(tmpdir(), "pc-"));
  try {
    writeTask(root, "TK-2", { ...files, "review-report.md": `Round: 1\n${C}\n## Verdict: approved\n` });
    const none = run(["pipeline", "debt", ".ai/tasks/TK-2", "--root", root, "--json"]);
    assert.equal(none.status, 0, none.stdout + none.stderr);
    assert.deepEqual([JSON.parse(none.stdout).outcome, JSON.parse(none.stdout).calls], ["registered", 0]);
    writeTask(root, "TK-2", files);
    const halt = run(["pipeline", "debt", ".ai/tasks/TK-2", "--root", root]);
    assert.equal(halt.status, 2, halt.stdout + halt.stderr);
    assert.match(halt.stdout, /HALT \(repo -, 0 gh call\(s\)\)/);
    assert.match(halt.stdout, /halt: T5 /);
    for (const bad of ["x", "0", "1,,2", "-3"]) {
      const u = run(["pipeline", "debt", ".ai/tasks/TK-2", "--root", root, "--issues", bad]);
      assert.equal(u.status, 1, bad);
      assert.match(u.stderr, /usage: base-ai pipeline debt/);
    }
    assert.match(run(["pipeline", "debt"]).stderr, /usage: base-ai pipeline debt/);
    writeTask(root, "TK-2", { ...files, "status.json": "{" });
    const notComputed = run(["pipeline", "debt", ".ai/tasks/TK-2", "--root", root]);
    assert.equal(notComputed.status, 1);
    assert.match(notComputed.stderr, /keys not computed: K16 skip/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
