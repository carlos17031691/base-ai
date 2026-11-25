import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadTask, readBounded } from "../pipeline-files.js";

const CLI = resolve(dirname(fileURLToPath(import.meta.url)), "..", "index.js");
// A valid Security section (BASE-124-B, K19), appended to review fixtures that must stay consistent.
const SEC = "\n## Security\n\n- Trust boundary touched: no\n- Method: OWASP checklist\n- Findings: none\n\n| Category | Result | Basis |\n|---|---|---|\n| Input validation & injection | none | src/x.ts:1 |\n| Authn/authz & isolation | n/a | no auth code |\n| Secrets & data protection | none | src/x.ts:2 |\n| Abuse resistance | n/a | no endpoint |\n| Supply chain | none | no dependency change |\n";
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
  "review-report.md": `Round: 1\n${C}\n## Verdict: approved\n| L1 | x | To register |\n${SEC}`,
  "qa-report.md": `Round: 1\nImplementer completion verified: ${C}\n## Verdict: pass\n`,
};

const run = (args: string[]) => spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8" });

const gitIn = (root: string) => (...args: string[]) => {
  const r = spawnSync("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
};
// A plan that passes P1 (BASE-140-B): steps for K3, and one criterion with a command QA may run.
const PLAN = "# Plan\n## Steps\n1. **human** — ok\n\n## Acceptance criteria\n\n- [ ] **AC1** `npm --prefix <r>/cli run test` exits 0.\n";
const planReview = (commit: string) => `# Plan review\n\n## Plan review round 1\n\n- Plan commit: ${commit}\n\n### Verdict: approved\n`;
const lockNote = (commit: string) => `approved; plan review round 1 approved, plan.md at ${commit}`;

/** Commits plan.md, then binds the lock to that commit: plan-review.md and a lock note naming it (P2). */
function commitBoundPlan(root: string, id: string, statusWith: (lock: string) => string): string {
  const git = gitIn(root);
  writeTask(root, id, { "plan.md": PLAN });
  git("add", "-A");
  git("commit", "-q", "-m", "plan");
  const commit = git("rev-parse", "HEAD");
  writeTask(root, id, { "plan-review.md": planReview(commit), "status.json": statusWith(lockNote(commit)) });
  return commit;
}

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
    writeTask(root, "TK-2", { ...files, "review-report.md": `Round: 1\n${C}\n## Verdict: approved\n${SEC}` });
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

test("pipeline check --json carries facts.nextActor with schema 1", () => {
  const root = mkdtempSync(join(tmpdir(), "pc-"));
  try {
    writeTask(root, "TK-2", files);
    const r = run(["pipeline", "check", ".ai/tasks/TK-2", "--root", root, "--json"]);
    const j = JSON.parse(r.stdout);
    assert.equal(j.schema, 1);
    assert.deepEqual(Object.keys(j.facts.nextActor).sort(), ["reason", "role"]);
    assert.equal(j.facts.nextActor.role, "supervisor");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("P3 pipeline ci on a real git repository: an appended transition exits 0; an edited entry 0 exits 1 naming A1", () => {
  const root = mkdtempSync(join(tmpdir(), "pc-ci-"));
  const git = gitIn(root);
  const all = JSON.parse(status) as { transitions: { note: string }[] };
  let lock = "approved";
  const withTransitions = (n: number, edit = false) =>
    JSON.stringify({
      ...all,
      ticket_id: "X-1",
      transitions: all.transitions.slice(0, n).map((t, i) => (edit && i === 0 ? { ...t, note: "rewritten" } : i === 1 ? { ...t, note: lock } : t)),
    });
  try {
    git("init", "-q", "-b", "main");
    // The plan check runs on a status.json change (BASE-140-B D4), so the plan and its lock are bound.
    commitBoundPlan(root, "X-1", (note) => {
      lock = note;
      return withTransitions(5);
    });
    writeTask(root, "X-1", { ...files, "plan.md": PLAN, "review-report.md": `Round: 1\n${C}\n## Verdict: approved\n${SEC}`, "status.json": withTransitions(5) });
    git("add", "-A");
    git("commit", "-q", "-m", "base");
    const base = git("rev-parse", "HEAD");

    writeTask(root, "X-1", { "status.json": withTransitions(6) });
    git("commit", "-q", "-am", "append");
    const pass = run(["pipeline", "ci", "--base", base, "--root", root]);
    assert.equal(pass.status, 0, pass.stdout + pass.stderr);
    assert.equal(pass.stdout, `pipeline ci ${base.slice(0, 7)}: PASS (1 task dir(s))\nX-1: A1 pass; check ok; plan ok; debt skip\n`);

    writeTask(root, "X-1", { "status.json": withTransitions(6, true) });
    git("commit", "-q", "-am", "edit");
    const fail = run(["pipeline", "ci", "--base", base, "--root", root, "--json"]);
    assert.equal(fail.status, 1, fail.stdout + fail.stderr);
    const j = JSON.parse(fail.stdout);
    assert.deepEqual([j.outcome, j.dirs[0].id, j.dirs[0].append_only], ["fail", "X-1", { status: "fail", detail: "transitions[0] differs from the base" }]);
    assert.match(run(["pipeline", "ci", "--base", base, "--root", root]).stdout, /X-1: A1 fail — transitions\[0\] differs from the base/);

    const usage = run(["pipeline", "ci", "--root", root]);
    assert.equal(usage.status, 1);
    assert.match(usage.stderr, /usage: base-ai pipeline ci --base <ref>/);
    const unknown = run(["pipeline", "ci", "--base", "no-such-ref", "--root", root]);
    assert.equal(unknown.status, 2);
    assert.match(unknown.stdout, /halt: G1 non-zero exit/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("R2 pipeline plan on a real git repository: a bound lock exits 0; plan.md changed and committed exits 1; no directory is a usage error", () => {
  const root = mkdtempSync(join(tmpdir(), "pc-plan-"));
  const git = gitIn(root);
  const locked = (note: string) =>
    JSON.stringify({
      ticket_id: "TK-3",
      state: "pending",
      plan_locked: true,
      assignee: null,
      blocker: null,
      transitions: [
        { from: null, to: "pending", agent: "planner", timestamp: "2026-11-25T00:00:00Z", note: "task initialized" },
        { from: "pending", to: "pending", agent: "human", timestamp: "2026-11-25T00:01:00Z", note },
      ],
      checklist: { tests_pass: false, lint_pass: false, types_pass: false, review_verdict: null, qa_verdict: null },
    });
  try {
    git("init", "-q", "-b", "main");
    commitBoundPlan(root, "TK-3", locked);
    git("add", "-A");
    git("commit", "-q", "-m", "lock");
    const pass = run(["pipeline", "plan", ".ai/tasks/TK-3", "--root", root]);
    assert.equal(pass.status, 0, pass.stdout + pass.stderr);
    assert.equal(pass.stdout, "pipeline plan TK-3: PASS\n  ✔ P1 plan.criteria\n  ✔ P2 plan.lock\n");
    const json = run(["pipeline", "plan", ".ai/tasks/TK-3", "--json", "--root", root]);
    assert.equal(json.status, 0);
    assert.deepEqual(Object.keys(JSON.parse(json.stdout)), ["schema", "ticket", "taskDir", "exempt", "outcome", "ok", "checks", "criteria"]);

    writeTask(root, "TK-3", { "plan.md": `${PLAN}- [ ] **AC2** \`gh issue view 1\` shows the issue.\n` });
    const dirty = run(["pipeline", "plan", ".ai/tasks/TK-3", "--root", root]);
    assert.equal(dirty.status, 1, dirty.stdout + dirty.stderr);
    assert.match(dirty.stdout, /✖ P2 plan\.lock — plan\.md has uncommitted changes/);
    git("commit", "-q", "-am", "edit after the lock");
    const changed = run(["pipeline", "plan", ".ai/tasks/TK-3", "--root", root]);
    assert.equal(changed.status, 1, changed.stdout + changed.stderr);
    assert.equal(
      changed.stdout,
      "pipeline plan TK-3: FAIL\n  ✖ P1 plan.criteria — 1 of 2 criteria fail\n  ✖ P2 plan.lock — plan.md changed after the reviewed commit\n" +
        "  criterion 2 (plan.md:8): needs credentials or the environment\n  criterion 2 (plan.md:8): no command QA can run\n",
    );
    assert.doesNotMatch(changed.stdout, /gh issue|shows the issue/, "no plan text in the output");

    const usage = run(["pipeline", "plan", "--root", root]);
    assert.equal(usage.status, 1);
    assert.match(usage.stderr, /usage: base-ai pipeline plan <task-dir>/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("R2 pipeline plan outside a git repository halts (exit 2) on a locked, bound plan", () => {
  const root = mkdtempSync(join(tmpdir(), "pc-plan-"));
  try {
    const commit = "b".repeat(40);
    writeTask(root, "TK-4", {
      "plan.md": PLAN,
      "plan-review.md": planReview(commit),
      "status.json": JSON.stringify({
        ticket_id: "TK-4",
        state: "pending",
        plan_locked: true,
        assignee: null,
        blocker: null,
        transitions: [
          { from: null, to: "pending", agent: "planner", timestamp: "2026-11-25T00:00:00Z", note: "init" },
          { from: "pending", to: "pending", agent: "human", timestamp: "2026-11-25T00:01:00Z", note: lockNote(commit) },
        ],
        checklist: { tests_pass: false, lint_pass: false, types_pass: false, review_verdict: null, qa_verdict: null },
      }),
    });
    const r = run(["pipeline", "plan", ".ai/tasks/TK-4", "--root", root]);
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.match(r.stdout, /^pipeline plan TK-4: HALT\n {2}✔ P1 plan\.criteria\n {2}✖ P2 plan\.lock — halt: git non-zero exit\n$/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
