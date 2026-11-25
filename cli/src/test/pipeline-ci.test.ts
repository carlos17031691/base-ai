import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_FILE_BYTES, checkTask, type CheckReport, type FileRead, type TaskInput } from "../pipeline-check.js";
import { CI_USAGE, MAX_TASK_DIRS, appendOnly, ciExitCode, groupPaths, jsonEqual, renderCi, runCi, type CiDeps, type CiReport } from "../pipeline-ci.js";
import type { PlanResult } from "../pipeline-plan.js";
import type { DebtReport, RunResult, Runner } from "../pipeline-registration.js";

// In memory only: a fake git, a fake working tree and a fake registration check. No process, no network.
const SHA = "a".repeat(40);
const ROOT = "/repo";
const C = "2026-01-01T00:03:00Z";
const SEC = "\n## Security\n\n- Trust boundary touched: no\n- Method: OWASP checklist\n- Findings: none\n\n| Category | Result | Basis |\n|---|---|---|\n| Input validation & injection | none | src/x.ts:1 |\n| Authn/authz & isolation | n/a | no auth code |\n| Secrets & data protection | none | src/x.ts:2 |\n| Abuse resistance | n/a | no endpoint |\n| Supply chain | none | no dependency change |\n";

const T = [
  { from: null, to: "pending", agent: "planner", timestamp: "2026-01-01T00:00:00Z", note: "init" },
  { from: "pending", to: "pending", agent: "human", timestamp: "2026-01-01T00:01:00Z", note: "approved" },
  { from: "pending", to: "in_progress", agent: "implementer", timestamp: "2026-01-01T00:02:00Z", note: "claim" },
  { from: "in_progress", to: "completed", agent: "implementer", timestamp: C, note: "done" },
  { from: "completed", to: "completed", agent: "reviewer", timestamp: "2026-01-01T00:04:00Z", note: `review round 1: approved; reviewed implementer completion ${C}` },
  { from: "completed", to: "completed", agent: "qa", timestamp: "2026-01-01T00:05:00Z", note: `qa round 1: pass; verified implementer completion ${C}` },
];
const statusOf = (transitions: unknown[], state = "completed", indent?: number) =>
  JSON.stringify(
    { ticket_id: "TK-1", state, plan_locked: true, assignee: null, blocker: null, transitions, checklist: { tests_pass: true, lint_pass: false, types_pass: true, review_verdict: "approved", qa_verdict: "pass" } },
    null,
    indent,
  );
const BASE_STATUS = statusOf(T.slice(0, 4), "completed");
const HEAD_STATUS = statusOf(T);
const taskFiles = (status: string, keyRow = true): Record<string, string> => ({
  "status.json": status,
  "plan.md": "# Plan\n## Steps\n1. **human** — ok\n",
  "review-report.md": `Round: 1\n${C}\n## Verdict: approved\n${keyRow ? "| L1 | x | To register |\n" : ""}${SEC}`,
  "qa-report.md": `Round: 1\nImplementer completion verified: ${C}\n## Verdict: pass\n`,
});

interface World {
  /** Changed paths, as G2 lists them. */
  diff: string[];
  /** status.json text at the base, by task id. */
  base?: Record<string, string>;
  /** Working-tree files, by task id then file name. */
  tree?: Record<string, Record<string, string>>;
  fail?: (sub: string) => RunResult | undefined;
  debt?: (r: CheckReport) => DebtReport;
  /** The `pipeline plan` result, by task directory; a passing one by default. */
  plan?: (taskDir: string) => PlanResult;
  sha?: string;
}

const planPass = (taskDir: string): PlanResult => ({
  report: {
    schema: 1,
    ticket: "TK-1",
    taskDir: `${ROOT}/${taskDir}`,
    exempt: false,
    outcome: "pass",
    ok: true,
    checks: [
      { id: "P1", key: "plan.criteria", status: "pass", detail: "" },
      { id: "P2", key: "plan.lock", status: "pass", detail: "" },
    ],
    criteria: [],
  },
});

function world(w: World) {
  const calls: string[][] = [];
  const debtCalls: string[] = [];
  const planCalls: string[] = [];
  const run: Runner = async (cmd, args) => {
    calls.push([cmd, ...args]);
    assert.deepEqual(args.slice(0, 2), ["-C", ROOT]);
    const sub = args[2];
    const forced = w.fail?.(sub);
    if (forced) return forced;
    if (sub === "rev-parse") return { kind: "ok", stdout: `${w.sha ?? SHA}\n` };
    if (sub === "diff") return { kind: "ok", stdout: w.diff.map((p) => `${p}\0`).join("") };
    const path = sub === "ls-tree" ? args[args.length - 1] : args[3].slice(SHA.length + 1);
    const id = path.split("/")[2];
    const text = w.base?.[id];
    if (sub === "ls-tree") return { kind: "ok", stdout: text === undefined ? "" : `${path}\0` };
    return text === undefined ? { kind: "error", reason: "exit" } : { kind: "ok", stdout: text };
  };
  const read = (relPath: string): FileRead => {
    const [, , id, name] = relPath.split("/");
    const text = w.tree?.[id]?.[name];
    return text === undefined ? { kind: "missing" } : { kind: "ok", text };
  };
  const loadTask = (dir: string): TaskInput => {
    const id = dir.split("/")[2];
    const f = (name: string) => read(`${dir}/${name}`);
    return { dirName: id, absPath: `${ROOT}/${dir}`, status: f("status.json"), plan: f("plan.md"), review: f("review-report.md"), qa: f("qa-report.md"), decisions: f("decisions.md") };
  };
  const deps: CiDeps = {
    root: ROOT,
    run,
    read,
    loadTask,
    checkTask,
    debt: async (r) => {
      debtCalls.push(r.ticket ?? "");
      return w.debt?.(r) ?? { schema: 1, rule: r.rule, ticket: r.ticket, repo: "acme/repo", outcome: "registered", calls: 2, keys: r.keys.map((k) => ({ ...k, status: "registered", issue: 106, state: "open" })) };
    },
    plan: async (taskDir) => {
      planCalls.push(taskDir);
      return (w.plan ?? planPass)(taskDir);
    },
  };
  return { deps, calls, debtCalls, planCalls };
}

async function report(w: World, ref = "origin/development"): Promise<{ r: CiReport; calls: string[][]; debtCalls: string[]; planCalls: string[] }> {
  const { deps, calls, debtCalls, planCalls } = world(w);
  const res = await runCi(ref, deps);
  assert.equal(res.kind, "report");
  return { r: (res as { kind: "report"; report: CiReport }).report, calls, debtCalls, planCalls };
}
const subs = (calls: string[][]) => calls.map((c) => c[3]);
const ok = (text: string): FileRead => ({ kind: "ok", text });

test("P3 A1: a new status.json (no base version) passes as new", () => {
  assert.deepEqual(appendOnly(null, ok(HEAD_STATUS)), { status: "pass", detail: "new" });
});

test("P3 A1: appended entries pass, with other key order and whitespace", () => {
  const reordered = T.map((t) => ({ note: t.note, timestamp: t.timestamp, agent: t.agent, to: t.to, from: t.from }));
  assert.deepEqual(appendOnly(ok(BASE_STATUS), ok(statusOf(reordered, "completed", 2))), { status: "pass", detail: "" });
  assert.deepEqual(appendOnly(ok(BASE_STATUS), ok(BASE_STATUS)), { status: "pass", detail: "" }, "nothing appended");
  assert.deepEqual(appendOnly(ok(BASE_STATUS), ok(statusOf(T.slice(0, 4), "blocked"))).status, "pass", "other fields may change (H11)");
});

test("P3 A1: a modified, a removed and a reordered entry each name the first differing index", () => {
  const modified = T.map((t, i) => (i === 2 ? { ...t, note: "rewritten" } : t));
  assert.deepEqual(appendOnly(ok(BASE_STATUS), ok(statusOf(modified))), { status: "fail", detail: "transitions[2] differs from the base" });
  const removed = [T[0], T[2], T[3], T[4], T[5]];
  assert.deepEqual(appendOnly(ok(BASE_STATUS), ok(statusOf(removed))), { status: "fail", detail: "transitions[1] differs from the base" });
  const swapped = [T[0], T[1], T[3], T[2], T[4]];
  assert.deepEqual(appendOnly(ok(BASE_STATUS), ok(statusOf(swapped))), { status: "fail", detail: "transitions[2] differs from the base" });
});

test("P3 A1: fewer entries than the base fail with the count", () => {
  assert.deepEqual(appendOnly(ok(BASE_STATUS), ok(statusOf(T.slice(0, 3)))), { status: "fail", detail: "3 of 4 base entries remain" });
});

test("P3 A1: status.json removed fails", () => {
  assert.deepEqual(appendOnly(ok(BASE_STATUS), { kind: "missing" }), { status: "fail", detail: "status.json removed" });
});

test("P3 A1: unparseable base or head, and transitions that is not an array, fail naming the side", () => {
  const notArray = JSON.stringify({ transitions: { 0: T[0] } });
  assert.deepEqual(appendOnly(ok("{ broken"), ok(HEAD_STATUS)), { status: "fail", detail: "base is not a JSON object with a transitions array" });
  assert.deepEqual(appendOnly(ok(BASE_STATUS), ok("{ broken")), { status: "fail", detail: "head is not a JSON object with a transitions array" });
  assert.deepEqual(appendOnly(ok(notArray), ok(HEAD_STATUS)).detail, "base is not a JSON object with a transitions array");
  assert.deepEqual(appendOnly(ok(BASE_STATUS), ok(notArray)).detail, "head is not a JSON object with a transitions array");
  assert.deepEqual(appendOnly(ok(BASE_STATUS), ok("[1]")).detail, "head is not a JSON object with a transitions array");
  assert.deepEqual(appendOnly(ok(BASE_STATUS), { kind: "error", reason: "is a directory" }), { status: "fail", detail: "head is a directory" });
});

test("P3 A1: a base over 2 MiB fails naming base, whether measured here or capped by the runner", async () => {
  const big = `{"transitions":[],"pad":"${"x".repeat(MAX_FILE_BYTES)}"}`;
  const tree = { "TK-1": taskFiles(HEAD_STATUS) };
  const sized = await report({ diff: [".ai/tasks/TK-1/status.json"], base: { "TK-1": big }, tree });
  assert.deepEqual(sized.r.dirs[0].append_only, { status: "fail", detail: `base larger than ${MAX_FILE_BYTES} bytes` });
  const capped = await report({ diff: [".ai/tasks/TK-1/status.json"], base: { "TK-1": BASE_STATUS }, tree, fail: (s) => (s === "show" ? { kind: "error", reason: "overflow" } : undefined) });
  assert.deepEqual(capped.r.dirs[0].append_only.detail, `base larger than ${MAX_FILE_BYTES} bytes`);
  assert.equal(ciExitCode(capped.r), 1);
});

test("P3 jsonEqual compares by value, ignoring key order", () => {
  assert.ok(jsonEqual({ a: 1, b: [1, { c: null }] }, { b: [1, { c: null }], a: 1 }));
  for (const [a, b] of [
    [{ a: 1 }, { a: 1, b: 2 }],
    [{ a: 1, b: undefined }, { a: 1, c: undefined }],
    [[1, 2], [2, 1]],
    [[1], { 0: 1 }],
    [null, {}],
    ["1", 1],
  ]) {
    assert.equal(jsonEqual(a, b), false, JSON.stringify([a, b]));
  }
});

test("P3 grouping: NUL-separated paths group by directory; files directly under .ai/tasks are ignored", () => {
  const g = groupPaths(".ai/tasks/B-2/plan.md\0.ai/tasks/A-1/status.json\0.ai/tasks/notes.md\0README.md\0.ai/tasks/A-1/evidence/x.log\0.ai/tasks/C-3/\0\0");
  assert.deepEqual([...g], [
    ["A-1", ["status.json", "evidence/x.log"]],
    ["B-2", ["plan.md"]],
  ]);
});

test("P3 grouping: an id outside the accepted characters fails D0 dir.name and is not checked further", async () => {
  const { r, calls } = await report({ diff: [".ai/tasks/bad id/status.json", ".ai/tasks/../x/status.json"] });
  assert.deepEqual(r.dirs.map((d) => [d.id, d.name]), [["..", "fail"], ["bad id", "fail"]]);
  assert.deepEqual(subs(calls), ["rev-parse", "diff"], "no G3 for a rejected id");
  assert.equal(ciExitCode(r), 1);
  assert.match(renderCi(r), /^"bad id": D0 dir\.name fail — not /m);
});

test("P3 grouping: the 21st directory halts at G2 before any per-directory call", async () => {
  const diff = Array.from({ length: MAX_TASK_DIRS + 1 }, (_, i) => `.ai/tasks/TK-${i}/usage.jsonl`);
  const { r, calls } = await report({ diff });
  assert.deepEqual(r.halt, { template: "G2", reason: "cap" });
  assert.deepEqual(r.dirs, []);
  assert.deepEqual(subs(calls), ["rev-parse", "diff"]);
  assert.equal(ciExitCode(r), 2);
  assert.match(renderCi(r), /halt: G2 more than 20 task directories changed/);
  const twenty = await report({ diff: diff.slice(0, MAX_TASK_DIRS) });
  assert.equal(ciExitCode(twenty.r), 0, "20 directories are within the cap");
});

test("P3 grouping: no changed task directory exits 0", async () => {
  const { r } = await report({ diff: ["README.md"] });
  assert.deepEqual([r.outcome, r.dirs.length, r.base], ["pass", 0, SHA]);
  assert.equal(ciExitCode(r), 0);
  assert.equal(renderCi(r), "pipeline ci aaaaaaa: PASS (0 task dir(s))\nno task directory changed");
});

test("P3 routing: usage.jsonl only skips the check and runs no A1", async () => {
  const { r, calls, debtCalls } = await report({ diff: [".ai/tasks/TK-1/usage.jsonl"], tree: { "TK-1": taskFiles(statusOf(T, "in_progress")) } });
  assert.deepEqual(r.dirs[0].append_only, { status: "skip", detail: "status.json unchanged" });
  assert.deepEqual(r.dirs[0].check, { status: "skip", detail: "no checked file changed" });
  assert.deepEqual(subs(calls), ["rev-parse", "diff"]);
  assert.deepEqual(debtCalls, []);
  assert.equal(ciExitCode(r), 0, "an unfinished task's usage.jsonl alone passes (H4)");
  assert.match(renderCi(r), /\nTK-1: A1 skip \(status\.json unchanged\); check skip \(no checked file changed\); plan skip \(no plan file changed\); debt skip$/);
});

test("P3 routing: improvement-report.md or evidence/ only skips the check", async () => {
  for (const f of ["improvement-report.md", "evidence/e1.txt"]) {
    const { r } = await report({ diff: [`.ai/tasks/TK-1/${f}`], tree: { "TK-1": taskFiles(HEAD_STATUS) } });
    assert.equal(r.dirs[0].check.status, "skip", f);
    assert.equal(ciExitCode(r), 0, f);
  }
});

test("P3 routing: plan.md only runs the check without A1", async () => {
  const { r, calls } = await report({ diff: [".ai/tasks/TK-1/plan.md"], tree: { "TK-1": taskFiles(HEAD_STATUS, false) } });
  assert.equal(r.dirs[0].append_only.status, "skip");
  assert.deepEqual(r.dirs[0].check, { status: "ok" });
  assert.deepEqual(subs(calls), ["rev-parse", "diff"]);
  assert.equal(ciExitCode(r), 0);
});

test("P3 routing: a deleted directory fails A1 and skips the check", async () => {
  const { r } = await report({ diff: [".ai/tasks/TK-1/status.json", ".ai/tasks/TK-1/plan.md"], base: { "TK-1": BASE_STATUS } });
  assert.deepEqual(r.dirs[0].append_only, { status: "fail", detail: "status.json removed" });
  assert.deepEqual(r.dirs[0].check, { status: "skip", detail: "no status.json" });
  assert.equal(ciExitCode(r), 1);
});

test("P3 routing: an in_progress task fails the check naming K4", async () => {
  const st = statusOf(T.slice(0, 3), "in_progress");
  const { r } = await report({ diff: [".ai/tasks/TK-1/status.json"], tree: { "TK-1": { ...taskFiles(st), "review-report.md": "", "qa-report.md": "" } } });
  assert.equal(r.dirs[0].append_only.status, "pass");
  assert.equal(r.dirs[0].check.status, "fail");
  assert.ok((r.dirs[0].check as { failed: string[] }).failed.includes("K4"));
  assert.equal(ciExitCode(r), 1);
  assert.match(renderCi(r), /^TK-1: A1 pass \(new\); check FAIL K4/m);
});

test("P3 routing: zero keys make no debt call; keys make one, and a registered outcome passes", async () => {
  const none = await report({ diff: [".ai/tasks/TK-1/review-report.md"], tree: { "TK-1": taskFiles(HEAD_STATUS, false) } });
  assert.deepEqual([none.debtCalls, none.r.dirs[0].debt], [[], { status: "skip" }]);
  const some = await report({ diff: [".ai/tasks/TK-1/status.json"], base: { "TK-1": BASE_STATUS }, tree: { "TK-1": taskFiles(HEAD_STATUS) } });
  assert.deepEqual(some.debtCalls, ["TK-1"]);
  assert.deepEqual(some.r.dirs[0].debt, { status: "registered", calls: 2, missing: [], halt: undefined });
  assert.equal(ciExitCode(some.r), 0);
  assert.equal(renderCi(some.r), "pipeline ci aaaaaaa: PASS (1 task dir(s))\nTK-1: A1 pass; check ok; plan ok; debt registered");
});

test("P3 routing: debt missing exits 1 and lists the keys; debt halt exits 2", async () => {
  const w = { diff: [".ai/tasks/TK-1/plan.md"], tree: { "TK-1": taskFiles(HEAD_STATUS) } };
  const missing = await report({
    ...w,
    debt: (r) => ({ schema: 1, rule: r.rule, ticket: r.ticket, repo: "acme/repo", outcome: "missing", calls: 1, keys: r.keys.map((k) => ({ ...k, status: "missing" })) }),
  });
  assert.equal(ciExitCode(missing.r), 1);
  assert.deepEqual((missing.r.dirs[0].debt as { missing: string[] }).missing, ["reg TK-1 review r1 i1"]);
  assert.match(renderCi(missing.r), /debt missing\n {2}missing keys, ready to paste:\n {4}\[reg TK-1 review r1 i1\]/);
  const halt = await report({
    ...w,
    debt: (r) => ({ schema: 1, rule: r.rule, ticket: r.ticket, repo: null, outcome: "halt", halt: { template: "T5", reason: "remote" }, calls: 0, keys: r.keys.map((k) => ({ ...k, status: "unchecked" })) }),
  });
  assert.equal(halt.r.outcome, "halt");
  assert.equal(ciExitCode(halt.r), 2);
  assert.match(renderCi(halt.r), /^pipeline ci aaaaaaa: HALT .*\nTK-1: A1 skip \(status\.json unchanged\); check ok; plan ok; debt halt \(T5 remote\)$/);
});

test("P3 git failures: G1–G4, each by a non-zero exit, ENOENT and a timeout, halt naming the template", async () => {
  const w = { diff: [".ai/tasks/TK-1/status.json"], base: { "TK-1": BASE_STATUS }, tree: { "TK-1": taskFiles(HEAD_STATUS) } };
  const subOf = { G1: "rev-parse", G2: "diff", G3: "ls-tree", G4: "show" } as const;
  for (const [template, sub] of Object.entries(subOf)) {
    for (const reason of ["exit", "missing", "timeout"] as const) {
      const { r } = await report({ ...w, fail: (s) => (s === sub ? { kind: "error", reason } : undefined) });
      assert.deepEqual(r.halt, { template, reason }, `${template} ${reason}`);
      assert.equal(ciExitCode(r), 2);
      assert.match(renderCi(r), new RegExp(`\\nhalt: ${template} `));
    }
  }
  const notSha = await report({ ...w, sha: "deadbeef" });
  assert.deepEqual([notSha.r.halt, notSha.r.base], [{ template: "G1", reason: "sha" }, null]);
  assert.match(renderCi(notSha.r), /^pipeline ci -: HALT \(0 task dir\(s\)\)\nhalt: G1 the base is not a 40-hex commit$/);
});

test("P3 git calls: argv only, the base resolved once, the merge-base diff limited to .ai/tasks", async () => {
  const { calls } = await report({ diff: [".ai/tasks/TK-1/status.json"], base: { "TK-1": BASE_STATUS }, tree: { "TK-1": taskFiles(HEAD_STATUS) } }, "v1.0");
  assert.deepEqual(calls.slice(0, 4), [
    ["git", "-C", ROOT, "rev-parse", "--verify", "--quiet", "v1.0^{commit}"],
    ["git", "-C", ROOT, "diff", "--name-only", "-z", "--no-renames", `${SHA}...HEAD`, "--", ".ai/tasks"],
    ["git", "-C", ROOT, "ls-tree", "-z", "--name-only", SHA, "--", ".ai/tasks/TK-1/status.json"],
    ["git", "-C", ROOT, "show", `${SHA}:.ai/tasks/TK-1/status.json`],
  ]);
});

test("P3 usage: a missing ref, one starting with -, or one containing a space makes no call", async () => {
  for (const ref of [undefined, "", "-x", "--output=/tmp/x", "a b", "a\nb", "/abs"]) {
    const { deps, calls } = world({ diff: [] });
    assert.deepEqual(await runCi(ref, deps), { kind: "usage" }, String(ref));
    assert.deepEqual(calls, []);
  }
  assert.match(CI_USAGE, /^usage: base-ai pipeline ci --base <ref>/);
});

test("P3 rendering: text and JSON carry no base content and no stderr", async () => {
  const secret = "SECRET-NOTE";
  const base = statusOf([{ ...T[0], note: secret }, ...T.slice(1, 4)]);
  const { r } = await report({ diff: [".ai/tasks/TK-1/status.json"], base: { "TK-1": base }, tree: { "TK-1": taskFiles(HEAD_STATUS) } });
  assert.deepEqual(r.dirs[0].append_only, { status: "fail", detail: "transitions[0] differs from the base" });
  const text = renderCi(r);
  const json = JSON.stringify(r);
  for (const out of [text, json]) {
    assert.doesNotMatch(out, /SECRET|init|claim|stderr/);
  }
  assert.match(text, /^pipeline ci aaaaaaa: FAIL \(1 task dir\(s\)\)\nTK-1: A1 fail — transitions\[0\] differs from the base; check ok; plan ok; debt registered$/);
  const parsed = JSON.parse(json);
  assert.deepEqual(Object.keys(parsed), ["schema", "base", "outcome", "dirs"]);
  assert.deepEqual(Object.keys(parsed.dirs[0]), ["id", "files", "name", "append_only", "check", "plan", "debt"]);
  assert.deepEqual([parsed.schema, parsed.base, parsed.outcome, parsed.dirs[0].files], [1, SHA, "fail", ["status.json"]]);
});

const planWith = (checks: PlanResult["report"]["checks"], extra: Partial<PlanResult["report"]> = {}, halt?: PlanResult["halt"]) => (taskDir: string): PlanResult => {
  const base = planPass(taskDir).report;
  const failed = checks.some((c) => c.status === "fail");
  const halted = checks.some((c) => c.status === "halt");
  const report = { ...base, checks, outcome: halted ? "halt" : failed ? "fail" : "pass", ok: !failed && !halted, ...extra } as PlanResult["report"];
  return halt ? { report, halt } : { report };
};

test("R2 ci trigger: status.json, plan.md, plan-review.md or decisions.md runs pipeline plan; other files skip it", async () => {
  for (const f of ["status.json", "plan.md", "plan-review.md", "decisions.md"]) {
    const { r, planCalls } = await report({ diff: [`.ai/tasks/TK-1/${f}`], base: { "TK-1": BASE_STATUS }, tree: { "TK-1": taskFiles(HEAD_STATUS, false) } });
    assert.deepEqual(planCalls, [".ai/tasks/TK-1"], f);
    assert.deepEqual(r.dirs[0].plan, { status: "ok" }, f);
  }
  const reviewOnly = await report({ diff: [".ai/tasks/TK-1/plan-review.md"], tree: { "TK-1": taskFiles(HEAD_STATUS, false) } });
  assert.deepEqual(reviewOnly.r.dirs[0].check, { status: "skip", detail: "no checked file changed" }, "plan-review.md is not a pipeline check file");
  assert.match(renderCi(reviewOnly.r), /\nTK-1: A1 skip \(status\.json unchanged\); check skip \(no checked file changed\); plan ok; debt skip$/);
  const decisionsOnly = await report({ diff: [".ai/tasks/TK-1/decisions.md"], tree: { "TK-1": taskFiles(HEAD_STATUS, false) } });
  assert.deepEqual(decisionsOnly.planCalls, [".ai/tasks/TK-1"], "a decisions.md-only change runs the plan check");
  for (const f of ["usage.jsonl", "review-report.md", "qa-report.md", "evidence/e2.txt"]) {
    const { r, planCalls } = await report({ diff: [`.ai/tasks/TK-1/${f}`], tree: { "TK-1": taskFiles(HEAD_STATUS, false) } });
    assert.deepEqual(planCalls, [], f);
    assert.deepEqual(r.dirs[0].plan, { status: "skip", detail: "no plan file changed" }, f);
  }
});

test("R2 ci skip: no status.json at HEAD, an invalid id and an exempt directory skip the plan check", async () => {
  const gone = await report({ diff: [".ai/tasks/TK-1/plan.md"] });
  assert.deepEqual([gone.planCalls, gone.r.dirs[0].plan], [[], { status: "skip", detail: "no status.json" }]);
  const bad = await report({ diff: [".ai/tasks/bad id/plan.md"] });
  assert.deepEqual([bad.planCalls, bad.r.dirs[0].plan], [[], { status: "skip", detail: "invalid directory name" }]);
  const skipped = { id: "P1", key: "plan.criteria", status: "skip", detail: "exempt (locked before the plan gate)" } as const;
  const exempt = await report({
    diff: [".ai/tasks/TK-1/plan.md"],
    tree: { "TK-1": taskFiles(HEAD_STATUS, false) },
    plan: planWith([skipped, { ...skipped, id: "P2", key: "plan.lock" }], { exempt: true }),
  });
  assert.deepEqual(exempt.r.dirs[0].plan, { status: "skip", detail: "exempt (locked before the plan gate)" });
  assert.equal(ciExitCode(exempt.r), 0);
  assert.match(renderCi(exempt.r), /; plan skip \(exempt \(locked before the plan gate\)\); /);
});

test("R2 ci fail: a failing plan check fails the directory (exit 1) naming P1 and P2", async () => {
  const { r } = await report({
    diff: [".ai/tasks/TK-1/plan.md"],
    tree: { "TK-1": taskFiles(HEAD_STATUS, false) },
    plan: planWith([
      { id: "P1", key: "plan.criteria", status: "fail", detail: "1 of 2 criteria fail" },
      { id: "P2", key: "plan.lock", status: "fail", detail: "no lock entry" },
    ]),
  });
  assert.deepEqual(r.dirs[0].plan, { status: "fail", failed: ["P1", "P2"] });
  assert.equal(r.outcome, "fail");
  assert.equal(ciExitCode(r), 1);
  assert.equal(renderCi(r), "pipeline ci aaaaaaa: FAIL (1 task dir(s))\nTK-1: A1 skip (status.json unchanged); check ok; plan FAIL P1,P2; debt skip");
  const text = renderCi(r) + JSON.stringify(r);
  assert.doesNotMatch(text, /criteria fail|no lock entry/, "only the failed ids reach the output");
});

test("R2 ci halt: a plan halt is per directory (exit 2) and leaves CiReport.halt absent", async () => {
  for (const reason of ["exit", "missing", "timeout", "overflow"] as const) {
    const { r } = await report({
      diff: [".ai/tasks/TK-1/plan.md"],
      tree: { "TK-1": taskFiles(HEAD_STATUS, false) },
      plan: planWith([{ id: "P1", key: "plan.criteria", status: "pass", detail: "" }, { id: "P2", key: "plan.lock", status: "halt", detail: "git" }], {}, reason),
    });
    assert.deepEqual(r.dirs[0].plan, { status: "halt", reason }, reason);
    assert.equal(r.halt, undefined, reason);
    assert.equal(r.outcome, "halt", reason);
    assert.equal(ciExitCode(r), 2, reason);
  }
  const { r } = await report({
    diff: [".ai/tasks/TK-1/plan.md"],
    tree: { "TK-1": taskFiles(HEAD_STATUS, false) },
    plan: planWith([{ id: "P1", key: "plan.criteria", status: "pass", detail: "" }, { id: "P2", key: "plan.lock", status: "halt", detail: "git" }], {}, "timeout"),
  });
  assert.equal(renderCi(r), "pipeline ci aaaaaaa: HALT (1 task dir(s))\nTK-1: A1 skip (status.json unchanged); check ok; plan halt (git timed out); debt skip");
  assert.deepEqual(Object.keys(JSON.parse(JSON.stringify(r))), ["schema", "base", "outcome", "dirs"]);
});
