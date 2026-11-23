import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RULE, type CheckReport } from "../pipeline-check.js";
import { MAX_GH_CALLS, checkRegistration, debtForTask, haltText, parseRemote, renderDebt, taskKeys, type RunResult, type Runner } from "../pipeline-registration.js";

// A fake runner: no process, no network. It records every call.
type Issue = { number: number; state: string; title: string; body: string; comments: { body: string }[] };
function fake(opts: { remote?: RunResult; issues?: Issue[]; search?: Record<string, number[]>; fail?: (args: string[]) => RunResult | undefined }) {
  const calls: string[][] = [];
  const run: Runner = async (cmd, args) => {
    calls.push([cmd, ...args]);
    const forced = opts.fail?.(args);
    if (forced) return forced;
    if (cmd === "git") return opts.remote ?? { kind: "ok", stdout: "https://github.com/acme/repo.git\n" };
    if (args[1] === "view") {
      const issue = (opts.issues ?? []).find((i) => i.number === Number(args[2]));
      return issue ? { kind: "ok", stdout: JSON.stringify(issue) } : { kind: "error", reason: "exit" };
    }
    const key = /^"(.*)" in:body,comments$/.exec(args[args.indexOf("--search") + 1])?.[1] ?? "";
    return { kind: "ok", stdout: JSON.stringify((opts.search?.[key] ?? []).map((n) => ({ number: n, state: "OPEN", title: "t" }))) };
  };
  return { run, calls };
}

const report = (n: number): CheckReport =>
  ({
    schema: 1,
    rule: RULE,
    ticket: "TK-1",
    taskDir: "/repo/.ai/tasks/TK-1",
    ok: true,
    checks: [],
    facts: {} as CheckReport["facts"],
    keys: Array.from({ length: n }, (_, i) => ({ key: `reg TK-1 review r1 i${i + 1}`, file: "review-report.md", line: 10 + i })),
  }) as CheckReport;
const issue = (number: number, body: string, comments: string[] = [], state = "OPEN"): Issue => ({
  number,
  state,
  title: "SECRET-TITLE",
  body,
  comments: comments.map((b) => ({ body: b })),
});

test("parseRemote accepts the github.com HTTPS and SSH forms and returns only owner/name", () => {
  for (const u of [
    "https://github.com/acme/repo",
    "https://github.com/acme/repo.git",
    "https://x-access-token:SECRET@github.com/acme/repo.git",
    "git@github.com:acme/repo.git",
    "ssh://git@github.com/acme/repo",
  ]) {
    assert.equal(parseRemote(u), "acme/repo", u);
  }
  for (const u of ["https://gitlab.com/acme/repo", "http://github.com/acme/repo", "https://github.com/ac me/repo", "https://github.com/acme/re$po", "file:///x"]) {
    assert.equal(parseRemote(u), null, u);
  }
});

test("zero keys: no command runs and the outcome is registered", async () => {
  const f = fake({});
  const r = await checkRegistration(report(0), [], f.run);
  assert.equal(r.outcome, "registered");
  assert.deepEqual(f.calls, []);
});

test("an invocation-named issue confirming every key means no search runs", async () => {
  const f = fake({ issues: [issue(7, "x [reg TK-1 review r1 i1] y", ["[reg TK-1 review r1 i2]"])] });
  const r = await checkRegistration(report(2), [7], f.run);
  assert.equal(r.outcome, "registered");
  assert.equal(r.calls, 1);
  assert.deepEqual(f.calls.map((c) => (c[0] === "git" ? "git" : c[2])), ["git", "view"]);
  assert.deepEqual(r.keys.map((k) => [k.status, k.issue, k.state]), [["registered", 7, "open"], ["registered", 7, "open"]]);
  assert.equal(r.repo, "acme/repo");
});

test("search per missing key in computed order; a closed issue counts; a candidate is viewed once", async () => {
  const f = fake({
    issues: [issue(3, "[reg TK-1 review r1 i1]", ["[reg TK-1 review r1 i2]"], "CLOSED")],
    search: { "reg TK-1 review r1 i1": [3], "reg TK-1 review r1 i2": [3] },
  });
  const r = await checkRegistration(report(2), [], f.run);
  assert.equal(r.outcome, "registered");
  assert.deepEqual(r.keys.map((k) => k.state), ["closed", "closed"]);
  assert.equal(f.calls.filter((c) => c[2] === "view").length, 1, "issue 3 viewed once");
  assert.equal(f.calls.filter((c) => c[2] === "list").length, 1, "the second key, confirmed by the earlier view, gets no search");
});

test("a search hit without the literal [key] is missing; the output lists it ready to paste with the indexing hint", async () => {
  const f = fake({ issues: [issue(4, "mentions reg TK-1 review r1 i1 without brackets")], search: { "reg TK-1 review r1 i1": [4] } });
  const r = await checkRegistration(report(1), [], f.run);
  assert.equal(r.outcome, "missing");
  assert.equal(r.keys[0].status, "missing");
  const text = renderDebt(r);
  assert.match(text, /^pipeline debt TK-1: MISSING \(repo acme\/repo, 2 gh call\(s\)\)/);
  assert.match(text, /\n {2}\[reg TK-1 review r1 i1\]\n/);
  assert.match(text, /may not be indexed yet/);
  assert.doesNotMatch(text + JSON.stringify(r), /SECRET|without brackets/);
});

test("each template failing halts naming it; could not check is never registered", async () => {
  const cases: [Parameters<typeof fake>[0], string, string][] = [
    [{ remote: { kind: "error", reason: "exit" } }, "T5", "exit"],
    [{ remote: { kind: "error", reason: "missing" } }, "T5", "missing"],
    [{ remote: { kind: "error", reason: "timeout" } }, "T5", "timeout"],
    [{ fail: (a) => (a[1] === "list" ? { kind: "error", reason: "exit" } : undefined) }, "T6", "exit"],
    [{ search: { "reg TK-1 review r1 i1": [9] }, fail: (a) => (a[1] === "view" ? { kind: "error", reason: "timeout" } : undefined) }, "T7", "timeout"],
    [{ search: { "reg TK-1 review r1 i1": [9] }, fail: (a) => (a[1] === "view" ? { kind: "error", reason: "missing" } : undefined) }, "T7", "missing"],
    [{ remote: { kind: "ok", stdout: "https://gitlab.com/a/b" } }, "T5", "remote"],
    [{ fail: (a) => (a[1] === "list" ? { kind: "error", reason: "timeout" } : undefined) }, "T6", "timeout"],
    [{ fail: (a) => (a[1] === "list" ? { kind: "ok", stdout: "not json" } : undefined) }, "T6", "json"],
    [{ fail: (a) => (a[1] === "list" ? { kind: "error", reason: "missing" } : undefined) }, "T6", "missing"],
    [{ search: { "reg TK-1 review r1 i1": [9] } }, "T7", "exit"],
    [{ search: { "reg TK-1 review r1 i1": [9] }, fail: (a) => (a[1] === "view" ? { kind: "ok", stdout: "{}" } : undefined) }, "T7", "json"],
    [{ search: { "reg TK-1 review r1 i1": [9] }, fail: (a) => (a[1] === "view" ? { kind: "error", reason: "overflow" } : undefined) }, "T7", "overflow"],
  ];
  for (const [opts, template, reason] of cases) {
    const r = await checkRegistration(report(1), [], fake(opts).run);
    assert.equal(r.outcome, "halt", `${template} ${reason}`);
    assert.deepEqual(r.halt, { template, reason });
    assert.notEqual(r.keys[0].status, "registered");
    assert.match(renderDebt(r), new RegExp(`halt: ${template} .*could not check`));
  }
  const badShape = await checkRegistration(report(1), [], fake({ fail: (a) => (a[1] === "list" ? { kind: "ok", stdout: '[{"x":1}]' } : undefined) }).run);
  assert.deepEqual(badShape.halt, { template: "T6", reason: "json" });
  const badState = await checkRegistration(report(1), [5], fake({ issues: [issue(5, "[reg TK-1 review r1 i1]", [], "MERGED")] }).run);
  assert.deepEqual(badState.halt, { template: "T7", reason: "json" });
});

test("the 61st gh call is never made", async () => {
  const n = MAX_GH_CALLS + 5;
  const f = fake({});
  const r = await checkRegistration(report(n), [], f.run);
  assert.equal(r.outcome, "halt");
  assert.deepEqual(r.halt, { template: "T6", reason: "cap" });
  assert.equal(r.calls, MAX_GH_CALLS);
  assert.equal(f.calls.filter((c) => c[0] === "gh").length, MAX_GH_CALLS);
  assert.match(renderDebt(r), /exceed 60 gh calls/);
});

test("a credential in the remote never reaches the output", async () => {
  const f = fake({ remote: { kind: "ok", stdout: "https://user:TOKEN123@github.com/acme/repo.git" }, issues: [issue(1, "[reg TK-1 review r1 i1]")] });
  const r = await checkRegistration(report(1), [1], f.run);
  assert.equal(r.outcome, "registered");
  assert.doesNotMatch(JSON.stringify(r) + renderDebt(r), /TOKEN123|user:/);
  assert.match(renderDebt(r), /reg TK-1 review r1 i1 — registered #1 \(open\)/);
});

test("keys are processed in computed order, and every candidate not yet viewed is viewed once", async () => {
  const f = fake({
    issues: [issue(1, "[reg TK-1 review r1 i1]"), issue(2, "unrelated"), issue(3, "[reg TK-1 review r1 i3]")],
    search: { "reg TK-1 review r1 i1": [1, 2], "reg TK-1 review r1 i2": [2], "reg TK-1 review r1 i3": [3] },
  });
  const r = await checkRegistration(report(3), [], f.run);
  const order = f.calls
    .filter((c) => c[0] === "gh")
    .map((c) => (c[2] === "list" ? `search ${/i\d+/.exec(c[c.indexOf("--search") + 1])?.[0]}` : `view ${c[3]}`));
  assert.deepEqual(order, ["search i1", "view 1", "view 2", "search i2", "search i3", "view 3"]);
  assert.deepEqual(r.keys.map((k) => k.status), ["registered", "missing", "registered"]);
  assert.equal(r.calls, 6);
});

// BASE-101-D4: the CLI sequence shared with the dashboard. A temp task whose review marks one key To register.
const C = "2026-01-01T00:03:00Z";
function taskRoot(review: string) {
  const root = mkdtempSync(join(tmpdir(), "reg-"));
  const dir = join(root, ".ai", "tasks", "TK-2");
  mkdirSync(dir, { recursive: true });
  const transitions = [
    { from: null, to: "pending", agent: "planner", timestamp: "2026-01-01T00:00:00Z", note: "init" },
    { from: "pending", to: "pending", agent: "human", timestamp: "2026-01-01T00:01:00Z", note: "approved" },
    { from: "pending", to: "in_progress", agent: "implementer", timestamp: "2026-01-01T00:02:00Z", note: "claim" },
    { from: "in_progress", to: "completed", agent: "implementer", timestamp: C, note: "done" },
    { from: "completed", to: "completed", agent: "reviewer", timestamp: "2026-01-01T00:04:00Z", note: `review round 1: approved; reviewed implementer completion ${C}` },
    { from: "completed", to: "completed", agent: "qa", timestamp: "2026-01-01T00:05:00Z", note: `qa round 1: pass; verified implementer completion ${C}` },
  ];
  const files: Record<string, string> = {
    "status.json": JSON.stringify({ ticket_id: "TK-2", state: "completed", plan_locked: true, assignee: null, blocker: null, transitions, checklist: { tests_pass: true, lint_pass: false, types_pass: true, review_verdict: "approved", qa_verdict: "pass" } }),
    "plan.md": "# Plan\n## Steps\n1. **human** — ok\n",
    "review-report.md": review,
    "qa-report.md": `Round: 1\nImplementer completion verified: ${C}\n## Verdict: pass\n`,
  };
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  return { root, done: () => rmSync(root, { recursive: true, force: true }) };
}

test("D4 taskKeys and debtForTask: K16 not passing gives keys with its status and no call; passing runs the check", async () => {
  const ok = taskRoot(`Round: 1\n${C}\n## Verdict: approved\n| L1 | x | To register |\n`);
  try {
    const keys = taskKeys(ok.root, ".ai/tasks/TK-2");
    assert.equal(keys.kind, "ready");
    const f = fake({ search: {}, issues: [] });
    const r = await debtForTask(ok.root, ".ai/tasks/TK-2", [], f.run);
    assert.equal(r.kind, "debt");
    if (r.kind === "debt") {
      assert.equal(r.report.keys.length, 1);
      assert.equal(r.report.outcome, "missing");
    }
  } finally {
    ok.done();
  }
  // A broken status.json fails K1, so K16 is skipped: the keys are not computed.
  const bad = taskRoot(`Round: 1\n${C}\n## Verdict: approved\n| L1 | x | To register |\n`);
  writeFileSync(join(bad.root, ".ai", "tasks", "TK-2", "status.json"), "{ broken");
  try {
    const f = fake({});
    const r = await debtForTask(bad.root, ".ai/tasks/TK-2", [], f.run);
    assert.equal(r.kind, "keys");
    if (r.kind === "keys") assert.notEqual(r.status, "pass");
    assert.equal(f.calls.length, 0, "no process call when the keys are not computed");
  } finally {
    bad.done();
  }
});

test("D4 H7: haltText is the one source of the halt explanation the CLI prints", async () => {
  for (const reason of ["missing", "exit", "timeout", "overflow", "json", "remote", "cap"] as const) {
    assert.ok(haltText(reason).length > 0);
  }
  assert.equal(haltText("missing"), "command not found");
  const r = await checkRegistration(report(1), [], fake({ fail: (a) => (a[0] === "issue" ? { kind: "error", reason: "missing" } : undefined) }).run);
  assert.ok(renderDebt(r).includes(`halt: T6 ${haltText("missing")};`));
});
