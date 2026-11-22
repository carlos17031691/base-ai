import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isTaskId, listTaskIds, listTasks, taskDetail } from "../dashboard-data.js";

// Every test works in its own temp root: never this repository's .ai/tasks/.
const C = "2026-01-01T00:03:00Z";
const T = (from: string | null, to: string, agent: string, minute: number, note: string, extra: Record<string, unknown> = {}) => ({
  from,
  to,
  agent,
  timestamp: `2026-01-01T00:0${minute}:00Z`,
  note,
  ...extra,
});
/** A completed task with review round 1 approved and no QA round: next is qa round 1. */
const status = (ticket: string) =>
  JSON.stringify({
    ticket_id: ticket,
    state: "completed",
    plan_locked: true,
    assignee: null,
    blocker: null,
    updated_at: "2026-01-01T00:04:00Z",
    transitions: [
      T(null, "pending", "planner", 0, "init", { extra: "dropped" }),
      T("pending", "pending", "human", 1, "approved"),
      T("pending", "in_progress", "implementer", 2, "claim"),
      T("in_progress", "completed", "implementer", 3, "done"),
      T("completed", "completed", "reviewer", 4, `review round 1: approved; reviewed implementer completion ${C}`),
    ],
    checklist: { tests_pass: true, lint_pass: false, types_pass: true, review_verdict: "approved", qa_verdict: null },
  });
const files = (ticket: string) => ({
  "status.json": status(ticket),
  "plan.md": "# Plan\n## Steps\n1. **human** — ok\n",
  "review-report.md": `Round: 1\n${C}\n## Verdict: approved\n| L1 | x | To register |\n`,
});
const record = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    schema: 1,
    ts: "2026-01-01T00:05:00Z",
    agent: "qa",
    model: "claude-x",
    messages: 1,
    input_tokens: 1_000_000,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    output_tokens: 100_000,
    ...over,
  });
const PRICING = { "claude-x": { input: 3, cache_write: 0, cache_read: 0, output: 15 } };

function sandbox() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "dash-")));
  const task = (id: string, f: Record<string, string> = files(id)) => {
    const dir = join(root, ".ai", "tasks", id);
    mkdirSync(dir, { recursive: true });
    for (const [name, text] of Object.entries(f)) writeFileSync(join(dir, name), text);
    return dir;
  };
  return { root, task, done: () => rmSync(root, { recursive: true, force: true }) };
}

test("task list: N directories give N sorted entries from pipeline check run in process", () => {
  const b = sandbox();
  try {
    for (const id of ["TK-3", "TK-1", "TK-2"]) b.task(id);
    const list = listTasks(b.root, PRICING);
    assert.equal(list.schema, 1);
    assert.equal(list.skipped, 0);
    assert.deepEqual(list.tasks.map((t) => t.id), ["TK-1", "TK-2", "TK-3"]);
    const t = list.tasks[0];
    assert.deepEqual(
      [t.ticket, t.state, t.ok, t.problem, t.updated_at, t.usage_error],
      ["TK-1", "completed", false, null, "2026-01-01T00:04:00Z", null],
    );
    assert.deepEqual(t.nextActor, { role: "qa", round: 1, reason: "no QA round" });
    assert.deepEqual(t.review, { rounds: 1, verdict: "approved" });
    assert.deepEqual(t.qa, { rounds: 0, verdict: null });
    assert.equal(t.tokens?.records, 0, "no usage.jsonl: zero records");
  } finally {
    b.done();
  }
});

test("corrupt task: a status.json that does not parse gives ok=false with K1's detail; the others are unaffected", () => {
  const b = sandbox();
  try {
    b.task("TK-1");
    b.task("TK-3");
    const clean = listTasks(b.root, PRICING).tasks;
    b.task("TK-2", { ...files("TK-2"), "status.json": "{ broken" });
    const list = listTasks(b.root, PRICING).tasks;
    const bad = list.find((t) => t.id === "TK-2");
    assert.deepEqual([bad?.ok, bad?.problem, bad?.state], [false, "not valid JSON", null]);
    assert.deepEqual(list.filter((t) => t.id !== "TK-2"), clean);
  } finally {
    b.done();
  }
});

test("listing: a file, a symlinked directory and an invalid name are skipped and never read; no .ai/tasks is empty", () => {
  const b = sandbox();
  try {
    assert.deepEqual(listTasks(b.root, PRICING), { schema: 1, tasks: [], skipped: 0 });
    const real = b.task("TK-1");
    writeFileSync(join(b.root, ".ai", "tasks", "README.md"), "x");
    symlinkSync(real, join(b.root, ".ai", "tasks", "LINK"));
    b.task("a b");
    assert.deepEqual(listTaskIds(b.root), { ids: ["TK-1"], skipped: 3 });
    const list = listTasks(b.root, PRICING);
    assert.deepEqual([list.tasks.map((t) => t.id), list.skipped], [["TK-1"], 3]);
  } finally {
    b.done();
  }
});

test("usage: priced records give cost per record and in the total; unpriced is null, never 0; a symlink is an error", () => {
  const b = sandbox();
  try {
    const dir = b.task("TK-1");
    // Hand-computed: 1,000,000 × 3 + 100,000 × 15 = 4,500,000 → 4.5 USD per priced record.
    writeFileSync(join(dir, "usage.jsonl"), `${record()}\n${record({ model: "other", ts: "bad" })}\nnot json\n`);
    const t = listTasks(b.root, PRICING).tasks[0];
    assert.deepEqual([t.tokens?.records, t.tokens?.cost_usd, t.tokens?.unpriced_records], [2, 4.5, 1]);

    const d = taskDetail(b.root, "TK-1", PRICING);
    assert.ok("records" in d.usage);
    if ("records" in d.usage) {
      assert.deepEqual(d.usage.records.map((r) => [r.ts, r.model, r.cost_usd]), [
        ["2026-01-01T00:05:00Z", "claude-x", 4.5],
        [null, "other", null],
      ]);
      assert.equal(d.usage.report.skipped_lines, 1);
      assert.equal(d.usage.report.total.cost_usd, 4.5);
    }

    const other = b.task("TK-2");
    symlinkSync(join(dir, "usage.jsonl"), join(other, "usage.jsonl"));
    const linked = listTasks(b.root, PRICING).tasks.find((x) => x.id === "TK-2");
    assert.equal(linked?.tokens, null);
    assert.match(linked?.usage_error ?? "", /^\.ai\/tasks\/TK-2\/usage\.jsonl is not a regular file/);
    assert.equal(linked?.ticket, "TK-2", "the task's other fields are still present");
    const dl = taskDetail(b.root, "TK-2", PRICING);
    assert.ok("error" in dl.usage);
  } finally {
    b.done();
  }
});

test("task detail: transitions with five fields, checks K1–K18 in order, facts, keys with file and line only", () => {
  const b = sandbox();
  try {
    b.task("TK-1");
    const d = taskDetail(b.root, "TK-1", PRICING);
    assert.deepEqual([d.schema, d.id, d.ticket, d.updated_at], [1, "TK-1", "TK-1", "2026-01-01T00:04:00Z"]);
    assert.equal(d.transitions.length, 5);
    assert.deepEqual(Object.keys(d.transitions[0]), ["from", "to", "agent", "timestamp", "note"]);
    assert.deepEqual(d.checks.map((c) => c.id), Array.from({ length: 18 }, (_, i) => `K${i + 1}`));
    assert.equal(d.facts.nextActor.role, "qa");
    assert.deepEqual(d.keys, [{ key: "reg TK-1 review r1 i1", file: "review-report.md", line: 4 }]);
    assert.equal(d.taskDir, join(b.root, ".ai", "tasks", "TK-1"));

    b.task("TK-2", { ...files("TK-2"), "status.json": "[]" });
    const bad = taskDetail(b.root, "TK-2", PRICING);
    assert.deepEqual(bad.transitions, []);
    assert.equal(bad.checks[0].status, "fail");
    assert.equal(bad.ok, false);
  } finally {
    b.done();
  }
});

test("isTaskId accepts ticket-like names and rejects paths, escapes, spaces and the empty string", () => {
  for (const ok of ["BASE-101-D1", "#45", "a.b_c"]) assert.ok(isTaskId(ok), ok);
  for (const bad of ["../../etc", "a/b", "a%2Fb", "", "a b"]) assert.ok(!isTaskId(bad), bad);
  // "." and ".." match the regex, but readdir never lists them, so they never reach a read.
  assert.ok(isTaskId("..") && isTaskId("."));
});

test("review r1 L3: an unreadable usage.jsonl reports its errno code with a root-relative path, never an absolute one", () => {
  const b = sandbox();
  const dir = b.task("TK-1");
  try {
    writeFileSync(join(dir, "usage.jsonl"), `${record()}\n`);
    chmodSync(dir, 0o000); // lstat inside the directory now fails with EACCES
    const t = listTasks(b.root, PRICING).tasks[0];
    assert.equal(t.tokens, null);
    assert.equal(t.usage_error, ".ai/tasks/TK-1/usage.jsonl cannot be read (EACCES)");
    assert.ok(!(t.usage_error ?? "").includes(b.root));
  } finally {
    chmodSync(dir, 0o755);
    b.done();
  }
});

test("review r1 L5: a task whose entry throws gets the internal error fallback; the other tasks are unaffected", () => {
  const b = sandbox();
  try {
    writeFileSync(join(b.task("TK-1"), "usage.jsonl"), `${record({ model: "boom" })}\n`);
    b.task("TK-2");
    // A price lookup that throws stands in for any unexpected failure while one entry is built.
    const pricing = { ...PRICING };
    Object.defineProperty(pricing, "boom", { enumerable: true, get: () => { throw new Error("boom"); } });
    const list = listTasks(b.root, pricing);
    assert.deepEqual(list.tasks[0], {
      id: "TK-1",
      ticket: null,
      state: null,
      ok: false,
      problem: "internal error",
      nextActor: null,
      review: null,
      qa: null,
      updated_at: null,
      tokens: null,
      usage_error: null,
    });
    assert.deepEqual([list.tasks[1].id, list.tasks[1].ticket, list.tasks[1].state], ["TK-2", "TK-2", "completed"]);
  } finally {
    b.done();
  }
});
