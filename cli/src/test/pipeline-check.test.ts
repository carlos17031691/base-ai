import { test } from "node:test";
import assert from "node:assert/strict";
import {
  checkTask,
  fenceMask,
  markerOffsets,
  maskCodeSpans,
  parseStatus,
  renderText,
  type CheckReport,
  type FileRead,
  type TaskInput,
} from "../pipeline-check.js";

// ---- fixture builders (in memory; no test reads .ai/tasks/) ----

const C = "2026-01-01T00:03:00Z"; // implementer completion
type T = { from: string | null; to: string; agent: string; timestamp: string; note: string };

function baseTransitions(): T[] {
  return [
    { from: null, to: "pending", agent: "planner", timestamp: "2026-01-01T00:00:00Z", note: "task initialized" },
    { from: "pending", to: "pending", agent: "human", timestamp: "2026-01-01T00:01:00Z", note: "plan approved and locked" },
    { from: "pending", to: "in_progress", agent: "implementer", timestamp: "2026-01-01T00:02:00Z", note: "claimed" },
    { from: "in_progress", to: "completed", agent: "implementer", timestamp: C, note: "done" },
    { from: "completed", to: "completed", agent: "reviewer", timestamp: "2026-01-01T00:04:00Z", note: `review round 1: approved; High 0; reviewed implementer completion ${C}` },
    { from: "completed", to: "completed", agent: "qa", timestamp: "2026-01-01T00:05:00Z", note: `qa round 1: pass; criteria; verified implementer completion ${C}` },
  ];
}

function status(over: Record<string, unknown> = {}, transitions = baseTransitions()) {
  return {
    ticket_id: "TK-1",
    state: "completed",
    plan_locked: true,
    assignee: null,
    blocker: null,
    transitions,
    checklist: { tests_pass: true, lint_pass: false, types_pass: true, review_verdict: "approved", qa_verdict: "pass" },
    ...over,
  };
}

const PLAN = "# Plan\n\n## Steps\n\n1. **human** — approve\n2. **implementer** — do it\n\n## Files to touch\n\n| File | Action |\n|---|---|\n| `x.md` | modify |\n";
const REVIEW = `# Review\nRound: 1\nReviewed implementer completion: ${C}\n\n## Verdict: approved\n\n| # | Issue | Tech debt |\n|---|---|---|\n| L1 | thing | To register |\n`;
const QA = `# QA\nRound: 1\nImplementer completion verified: ${C}\n\n## Verdict: pass\n\n- **C1** — **To register**\n`;

const ok = (text: string): FileRead => ({ kind: "ok", text });
function input(over: Partial<TaskInput> = {}, st: unknown = status()): TaskInput {
  return {
    dirName: "TK-1",
    absPath: "/repo/.ai/tasks/TK-1",
    status: ok(JSON.stringify(st)),
    plan: ok(PLAN),
    review: ok(REVIEW),
    qa: ok(QA),
    ...over,
  };
}
const check = (r: CheckReport, id: string) => r.checks.find((c) => c.id === id)!;
const statusOf = (r: CheckReport, id: string) => check(r, id).status;

// ---- the happy path ----

test("a consistent task passes every check and computes facts and keys", () => {
  const r = checkTask(input());
  assert.equal(r.ok, true, renderText(r));
  assert.equal(r.checks.length, 16);
  assert.ok(r.checks.every((c) => c.status === "pass"));
  assert.equal(r.schema, 1);
  assert.equal(r.rule, "supervisor.md@8381e71");
  assert.equal(r.facts.latestCompletion, C);
  assert.deepEqual(r.facts.review, { rounds: 1, verdict: "approved", entry: "2026-01-01T00:04:00Z" });
  assert.deepEqual(r.facts.qa, { rounds: 1, verdict: "pass", entry: "2026-01-01T00:05:00Z" });
  assert.deepEqual(r.keys, [
    { key: "reg TK-1 review r1 i1", file: "review-report.md", line: 9 },
    { key: "reg TK-1 qa r1 i1", file: "qa-report.md", line: 7 },
  ]);
  assert.equal(r.facts.supervisor_own_ticket, false);
});

test("validated is accepted by K4 (H3)", () => {
  const t = baseTransitions();
  t.push({ from: "completed", to: "validated", agent: "supervisor", timestamp: "2026-01-01T00:06:00Z", note: "validated" });
  const r = checkTask(input({}, status({ state: "validated" }, t)));
  assert.equal(statusOf(r, "K4"), "pass");
  assert.equal(r.ok, true);
});

// ---- K1 / K2 / K3 ----

test("K1 fails on a missing, unreadable, invalid or mistyped status.json and skips its dependants", () => {
  for (const status of [{ kind: "missing" } as FileRead, { kind: "error", reason: "larger than 2097152 bytes" } as FileRead, ok("{nope"), ok("[]")]) {
    const r = checkTask(input({ status }));
    assert.equal(statusOf(r, "K1"), "fail");
    assert.equal(statusOf(r, "K2"), "skip");
    assert.match(check(r, "K16").detail, /depends on K1/);
    assert.equal(r.ticket, null);
    assert.equal(r.ok, false);
  }
  assert.match(check(checkTask(input({ status: { kind: "missing" } })), "K1").detail, /status\.json is missing/);
});

test("parseStatus names each wrong field type", () => {
  const cases: [Record<string, unknown>, RegExp][] = [
    [{ ticket_id: 7 }, /ticket_id/],
    [{ state: "done" }, /state/],
    [{ plan_locked: "yes" }, /plan_locked/],
    [{ assignee: 1 }, /assignee/],
    [{ blocker: undefined }, /blocker/],
    [{ transitions: {} }, /transitions is not an array/],
    [{ transitions: [{ from: null, to: "pending" }] }, /transitions\[0\]/],
    [{ checklist: null }, /checklist is not an object/],
    [{ checklist: { tests_pass: "y", lint_pass: true, types_pass: true, review_verdict: null, qa_verdict: null } }, /tests_pass/],
    [{ checklist: { tests_pass: true, lint_pass: true, types_pass: true, review_verdict: "ok", qa_verdict: null } }, /review_verdict/],
    [{ checklist: { tests_pass: true, lint_pass: true, types_pass: true, review_verdict: null, qa_verdict: "ok" } }, /qa_verdict/],
  ];
  for (const [over, re] of cases) {
    const raw = JSON.parse(JSON.stringify(status(over)));
    const p = parseStatus(JSON.stringify(raw));
    assert.match(p.problem ?? "", re, JSON.stringify(over));
  }
  assert.ok(parseStatus(JSON.stringify({ ...status(), extra: 1 })).status, "extra fields are allowed");
});

test("K2 fails on a mismatched directory, an unsafe id or a quote in the path; the id is printed escaped", () => {
  assert.match(check(checkTask(input({ dirName: "OTHER" })), "K2").detail, /differs from the directory name/);
  const bad = checkTask(input({ dirName: "TK 1" }, status({ ticket_id: "TK 1" })));
  assert.match(check(bad, "K2").detail, /characters outside/);
  assert.match(renderText(bad), /^pipeline check "TK 1": FAIL/);
  assert.match(check(checkTask(input({ absPath: "/repo/it's/TK-1" })), "K2").detail, /single quote/);
});

test("an unvalidated ticket_id never reaches a key or an unescaped output line (review M1)", () => {
  const id = "TK\n✔ K1 PASS x";
  const r = checkTask(input({ dirName: id }, status({ ticket_id: id })));
  assert.equal(statusOf(r, "K2"), "fail");
  assert.match(check(r, "K16").detail, /depends on K2/);
  assert.deepEqual(r.keys, []);
  const text = renderText(r);
  assert.ok(text.startsWith(`pipeline check ${JSON.stringify(id)}: FAIL`));
  assert.equal(text.split("\n").filter((l) => l.includes("PASS x")).length, 1, "the id appears only once, escaped, in the header");
});

test("K3 needs a Steps section with a top-level numbered step and reports the own-ticket fact", () => {
  assert.equal(statusOf(checkTask(input({ plan: { kind: "missing" } })), "K3"), "fail");
  assert.equal(statusOf(checkTask(input({ plan: ok("# Plan\n## Steps\n\n   1. indented only\n") })), "K3"), "fail");
  assert.equal(statusOf(checkTask(input({ plan: ok("# Plan\n## Other\n1. x\n") })), "K3"), "fail");
  const own = checkTask(input({ plan: ok(PLAN.replace("`x.md`", "`.claude/agents/supervisor.md`")) }));
  assert.equal(own.facts.supervisor_own_ticket, true);
  assert.match(renderText(own), /supervisor_own_ticket: true/);
  const fenced = "# Plan\n```\n## Steps\n1. x\n```\n";
  assert.equal(statusOf(checkTask(input({ plan: ok(fenced) })), "K3"), "fail", "a Steps heading inside a fence does not count");
  const fencedStep = "# Plan\n## Steps\n```\n1. inside a fence\n```\n";
  assert.equal(statusOf(checkTask(input({ plan: ok(fencedStep) })), "K3"), "fail", "a numbered line inside a fence is not a step (review L2)");
  const fencedRow = PLAN + "\n```\n| `.claude/agents/supervisor.md` | example |\n```\n";
  assert.equal(checkTask(input({ plan: ok(fencedRow) })).facts.supervisor_own_ticket, false);
});

// ---- K4 / K5 / K6 / K7 ----

test("K4 names any state other than completed or validated", () => {
  const t = baseTransitions().slice(0, 3);
  const r = checkTask(input({}, status({ state: "in_progress" }, t)));
  assert.match(check(r, "K4").detail, /state is in_progress/);
});

test("K5 fails on a broken chain, a non-null first from, a bad or decreasing timestamp, a wrong last to, or no entries", () => {
  const mutate = (f: (t: T[]) => void) => {
    const t = baseTransitions();
    f(t);
    return check(checkTask(input({}, status({}, t))), "K5");
  };
  assert.match(mutate((t) => (t[3].from = "pending")).detail, /transitions\[3\] from differs/);
  assert.match(mutate((t) => (t[0].from = "pending")).detail, /first entry's from is not null/);
  assert.match(mutate((t) => (t[2].timestamp = "2026-01-01 00:02")).detail, /transitions\[2\] timestamp is malformed/);
  assert.match(mutate((t) => (t[4].timestamp = "2025-12-31T00:00:00Z")).detail, /earlier than the previous/);
  assert.match(mutate((t) => (t[5].to = "validated")).detail, /last entry's to differs from state/);
  assert.match(check(checkTask(input({}, status({}, []))), "K5").detail, /transitions is empty/);
});

test("K6 needs plan_locked and a lock entry before the first claim", () => {
  assert.match(check(checkTask(input({}, status({ plan_locked: false }))), "K6").detail, /plan_locked/);
  const noLock = baseTransitions();
  noLock[1].note = "looked at it";
  assert.match(check(checkTask(input({}, status({}, noLock))), "K6").detail, /no lock entry/);
  const ordered = [
    baseTransitions()[0],
    { from: "pending", to: "in_progress", agent: "implementer", timestamp: "2026-01-01T00:00:30Z", note: "claimed" },
    { from: "in_progress", to: "pending", agent: "implementer", timestamp: "2026-01-01T00:00:40Z", note: "released" },
    { from: "pending", to: "pending", agent: "human", timestamp: "2026-01-01T00:01:00Z", note: "approved" },
    ...baseTransitions().slice(2),
  ];
  assert.match(check(checkTask(input({}, status({}, ordered))), "K6").detail, /after the first implementer claim/);
});

test("K7 fails with no completion, and dependants of K7 are skipped", () => {
  const t = baseTransitions().slice(0, 3);
  t.push({ from: "in_progress", to: "completed", agent: "planner", timestamp: C, note: "x" });
  const r = checkTask(input({}, status({}, t)));
  assert.match(check(r, "K7").detail, /no implementer → completed/);
  assert.match(check(r, "K10").detail, /depends on K7/);
});

// ---- review: K8–K11 ----

test("K8 fails with no reviewer entry, a null verdict or a missing report", () => {
  const noReviewer = baseTransitions().filter((e) => e.agent !== "reviewer");
  assert.match(check(checkTask(input({}, status({}, noReviewer))), "K8").detail, /no reviewer entry/);
  const nullV = status();
  (nullV.checklist as Record<string, unknown>).review_verdict = null;
  assert.match(check(checkTask(input({}, nullV)), "K8").detail, /review_verdict is null/);
  const r = checkTask(input({ review: { kind: "missing" } }));
  assert.match(check(r, "K8").detail, /review-report\.md is missing/);
  assert.equal(statusOf(r, "K9"), "skip");
});

test("K9 catches an unfilled template, a wrong round count, a missing completion, a wrong verdict and a wrong note prefix", () => {
  const unfilled = "# Review\n\n## Verdict: <!-- approved | changes_requested -->\n";
  assert.match(check(checkTask(input({ review: ok(unfilled) })), "K9").detail, /unfilled template/);

  const two = baseTransitions();
  two.splice(5, 0, { ...two[4], timestamp: "2026-01-01T00:04:30Z" });
  assert.match(check(checkTask(input({}, status({}, two))), "K9").detail, /round count 1 ≠ reviewer entries 2/);

  const otherTs = REVIEW.replace(`completion: ${C}`, "completion: 2026-01-01T00:09:09Z");
  assert.match(check(checkTask(input({ review: ok(otherTs) })), "K9").detail, /latest round does not contain/);

  const wrongV = REVIEW.replace("## Verdict: approved", "## Verdict: changes_requested");
  assert.match(check(checkTask(input({ review: ok(wrongV) })), "K9").detail, /latest-round verdict ≠ review_verdict/);

  const badNote = baseTransitions();
  badNote[4].note = `review round 2: approved; reviewed implementer completion ${C}`;
  assert.match(check(checkTask(input({}, status({}, badNote))), "K9").detail, /note prefix/);
  const badVerdict = baseTransitions();
  badVerdict[4].note = `review round 1: changes_requested; reviewed implementer completion ${C}`;
  assert.match(check(checkTask(input({}, status({}, badVerdict))), "K9").detail, /note prefix/, "wrong verdict in the note (review L4)");
});

test("K9 reads an appended round's single verdict line, in its accepted forms, and rejects zero or two", () => {
  const t = baseTransitions();
  t[4].note = `review round 1: changes_requested; reviewed implementer completion ${C}`;
  const C2 = "2026-01-01T00:04:20Z";
  t.splice(5, 0,
    { from: "completed", to: "in_progress", agent: "implementer", timestamp: "2026-01-01T00:04:10Z", note: "re-entry" },
    { from: "in_progress", to: "completed", agent: "implementer", timestamp: C2, note: "done again" },
    { from: "completed", to: "completed", agent: "reviewer", timestamp: "2026-01-01T00:04:30Z", note: `review round 2: approved; reviewed implementer completion ${C2}` },
  );
  t[t.length - 1].note = `qa round 1: pass; verified implementer completion ${C2}`;
  const qa = QA.replace(C, C2);
  const base = REVIEW.replace("## Verdict: approved", "## Verdict: changes_requested");
  for (const line of ["**Round 2 verdict:** approved", "### Verdict (round 2 — authoritative): approved", "Verdict: APPROVED"]) {
    const review = `${base}\n## Round 2 re-review\n\nCompletion ${C2}\n\n${line}\n`;
    const r = checkTask(input({ review: ok(review), qa: ok(qa) }, status({}, t)));
    assert.equal(statusOf(r, "K9"), "pass", `${line}: ${check(r, "K9").detail}`);
    assert.equal(r.facts.review.rounds, 2);
  }
  const none = `${base}\n## Round 2 re-review\n\nCompletion ${C2}\n\nno verdict here\n`;
  assert.match(check(checkTask(input({ review: ok(none), qa: ok(qa) }, status({}, t))), "K9").detail, /0 verdict lines in round 2/);
  const twoLines = `${base}\n## Round 2 re-review\n\n${C2}\nVerdict: approved\nFinal verdict: approved\n`;
  assert.match(check(checkTask(input({ review: ok(twoLines), qa: ok(qa) }, status({}, t))), "K9").detail, /2 verdict lines/);
  const both = `${base}\n## Round 2 re-review\n\n${C2}\nVerdict: approved (was changes_requested)\n`;
  assert.match(check(checkTask(input({ review: ok(both), qa: ok(qa) }, status({}, t))), "K9").detail, /0 verdict lines/);
});

test("the Round 1 header is accepted as a plain line, a list item or a bold label; a misnumbered heading is a fact", () => {
  for (const h of ["Round: 1", "- Round: 1", "- **Round:** 1"]) {
    const r = checkTask(input({ review: ok(REVIEW.replace("Round: 1", h)) }));
    assert.equal(statusOf(r, "K9"), "pass", h);
  }
  const t = baseTransitions();
  t.splice(5, 0, { ...t[4], timestamp: "2026-01-01T00:04:30Z", note: `review round 2: approved; reviewed implementer completion ${C}` });
  const review = `${REVIEW}\n## Round 7 re-review\n\n${C}\n**Round 7 verdict:** approved\n`;
  const r = checkTask(input({ review: ok(review) }, status({}, t)));
  assert.deepEqual(r.facts.roundHeadingMismatches, ['review-report.md: heading "Round 7" is round 2']);
  assert.match(renderText(r), /note: review-report\.md: heading "Round 7" is round 2/);
});

test("K10 refuses a review bound to an older completion; K11 needs approved", () => {
  const t = baseTransitions();
  const C2 = "2026-01-01T00:04:40Z";
  t.splice(5, 0,
    { from: "completed", to: "in_progress", agent: "implementer", timestamp: "2026-01-01T00:04:35Z", note: "re-entry" },
    { from: "in_progress", to: "completed", agent: "implementer", timestamp: C2, note: "done" },
  );
  t[t.length - 1].note = `qa round 1: pass; verified implementer completion ${C2}`;
  const r = checkTask(input({ qa: ok(QA.replace(C, C2)) }, status({}, t)));
  assert.match(check(r, "K10").detail, /comes before the latest completion/);

  const wrongTs = baseTransitions();
  wrongTs[4].note = "review round 1: approved; reviewed implementer completion 2026-01-01T00:00:01Z";
  assert.match(check(checkTask(input({}, status({}, wrongTs))), "K10").detail, /does not name the latest completion/);

  const cr = status();
  (cr.checklist as Record<string, unknown>).review_verdict = "changes_requested";
  assert.match(check(checkTask(input({}, cr)), "K11").detail, /review_verdict is changes_requested/);
});

// ---- QA: K12–K15 ----

test("K12 fails with no counted QA entry, a null verdict or a missing report", () => {
  const noQa = baseTransitions().slice(0, 5);
  const st = status({}, noQa);
  assert.match(check(checkTask(input({}, st)), "K12").detail, /no counted QA entry/);
  const nullV = status();
  (nullV.checklist as Record<string, unknown>).qa_verdict = null;
  assert.match(check(checkTask(input({}, nullV)), "K12").detail, /qa_verdict is null/);
  assert.match(check(checkTask(input({ qa: { kind: "missing" } })), "K12").detail, /qa-report\.md is missing/);
});

test("K13 catches round count, per-round completion, unfilled template, verdict and note prefix problems", () => {
  const unfilled = "# QA\n\n## Verdict: <!-- pass | fail -->\n";
  assert.match(check(checkTask(input({ qa: ok(unfilled) })), "K13").detail, /unfilled template/);
  assert.match(check(checkTask(input({ qa: ok(QA.replace(`verified: ${C}`, "verified: 2026-01-01T00:00:09Z")) })), "K13").detail, /round 1 completion/);
  assert.match(check(checkTask(input({ qa: ok(QA.replace("## Verdict: pass", "## Verdict: fail")) })), "K13").detail, /latest-round verdict ≠ qa_verdict/);
  const t = baseTransitions();
  t[5].note = `qa round 1: fail; verified implementer completion ${C}`;
  assert.match(check(checkTask(input({}, status({}, t))), "K13").detail, /note prefix/);
  const round = baseTransitions();
  round[5].note = `qa round 2: pass; verified implementer completion ${C}`;
  assert.match(check(checkTask(input({}, status({}, round))), "K13").detail, /note prefix/, "wrong round in the note (review L4)");
  const two = baseTransitions();
  two.push({ ...two[5], timestamp: "2026-01-01T00:06:00Z", note: `qa round 2: pass; verified implementer completion ${C}` });
  assert.match(check(checkTask(input({}, status({}, two))), "K13").detail, /round count 1 ≠ counted QA entries 2/);
  const multi = `${QA}\n## Round 2 re-verification\n\nImplementer completion verified: ${C}\n\n**Verdict:** pass\n`;
  assert.equal(statusOf(checkTask(input({ qa: ok(multi) }, status({}, two))), "K13"), "pass");
});

test("QA reset: earlier entries stop counting; a filled report with no entry after the reset fails K13", () => {
  const reset = baseTransitions();
  reset.push({ from: "completed", to: "completed", agent: "human", timestamp: "2026-01-01T00:06:00Z", note: "qa rounds reset: plan change" });
  const r = checkTask(input({}, status({}, reset)));
  assert.equal(r.facts.resets, 1);
  assert.match(check(r, "K12").detail, /no counted QA entry/);
  assert.match(check(r, "K13").detail, /filled while no QA entry follows the latest reset/);
  const unfilled = checkTask(input({ qa: ok("# QA\n## Verdict: <!-- pass | fail -->\n") }, status({}, reset)));
  assert.equal(statusOf(unfilled, "K13"), "skip");
  const absent = checkTask(input({ qa: { kind: "missing" } }, status({}, reset)));
  assert.equal(statusOf(absent, "K13"), "skip");

  const after = [...reset, { from: "completed", to: "completed", agent: "qa", timestamp: "2026-01-01T00:07:00Z", note: `qa round 1: pass; verified implementer completion ${C}` }];
  const r2 = checkTask(input({}, status({}, after)));
  assert.equal(statusOf(r2, "K13"), "pass", check(r2, "K13").detail);
  assert.equal(r2.facts.qa.entry, "2026-01-01T00:07:00Z");
});

test("K14 refuses QA before the latest reviewer entry or bound to another completion; K15 needs pass", () => {
  const early = baseTransitions();
  [early[4], early[5]] = [early[5], early[4]];
  early[4].from = "completed";
  const r = checkTask(input({}, status({}, early)));
  assert.match(check(r, "K14").detail, /before the latest reviewer entry/);
  const wrong = baseTransitions();
  wrong[5].note = "qa round 1: pass; verified implementer completion 2026-01-01T00:00:02Z";
  assert.match(check(checkTask(input({}, status({}, wrong))), "K14").detail, /does not name the latest completion/);
  const fail = status();
  (fail.checklist as Record<string, unknown>).qa_verdict = "fail";
  assert.match(check(checkTask(input({}, fail)), "K15").detail, /qa_verdict is fail/);
});

// ---- K16 markers and keys ----

test("markerOffsets counts a table cell and bold spans, case-sensitively, in offset order", () => {
  assert.deepEqual(markerOffsets("| L1 | x | To register |"), [10]);
  assert.deepEqual(markerOffsets("- **C1** — **To register** and **To register.**"), [11, 31]);
  assert.deepEqual(markerOffsets("| To register | **To register** |"), [1, 16]);
  assert.deepEqual(markerOffsets("To register, unbold"), []);
  assert.deepEqual(markerOffsets("**to register**"), []);
  assert.deepEqual(markerOffsets("**L1 — To register.**"), []);
  assert.deepEqual(markerOffsets("| a \\| To register | b |"), []);
});

test("maskCodeSpans hides inline code of any backtick run, keeps offsets, and leaves unclosed runs alone", () => {
  const m = maskCodeSpans("x `**To register**` y");
  assert.equal(m.length, "x `**To register**` y".length);
  assert.deepEqual(markerOffsets(m), []);
  assert.deepEqual(markerOffsets(maskCodeSpans("``a ` **To register** ``")), []);
  assert.deepEqual(markerOffsets(maskCodeSpans("`` x ` **To register**")), [7]);
  assert.deepEqual(markerOffsets(maskCodeSpans("| AC5 | `  - the marker **To register**` | Met |")), []);
});

test("fenceMask ignores paired fences and leaves an unpaired one without effect", () => {
  const { inFence } = fenceMask("a\n```\nb\n```\nc\n```\nd");
  assert.deepEqual(inFence, [false, true, true, true, false, false, false]);
});

test("K16 keys: every review round, only the latest QA round, fences and code spans excluded, ordinals per round", () => {
  const t = baseTransitions();
  t[4].note = `review round 1: changes_requested; reviewed implementer completion ${C}`;
  t.splice(5, 0, { from: "completed", to: "completed", agent: "reviewer", timestamp: "2026-01-01T00:04:30Z", note: `review round 2: approved; reviewed implementer completion ${C}` });
  t.push({ ...t[t.length - 1], timestamp: "2026-01-01T00:06:00Z", note: `qa round 2: pass; verified implementer completion ${C}` });
  const review = [
    "# Review", "Round: 1", C, "", "## Verdict: changes_requested", "",
    "| L1 | a | To register |", "| L2 | b | `To register` |", "```", "**To register**", "```",
    "## Round 2 re-review", "", C, "**Round 2 verdict:** approved", "- **To register** then **To register**",
  ].join("\n");
  const qa = [
    "# QA", "Round: 1", `Implementer completion verified: ${C}`, "## Verdict: pass", "- **To register**", "",
    "## Round 2 re-verification", `Implementer completion verified: ${C}`, "**Verdict:** pass", "- O1 **To register**", "summary: items marked To register",
  ].join("\n");
  const r = checkTask(input({ review: ok(review), qa: ok(qa) }, status({}, t)));
  assert.equal(r.ok, true, renderText(r));
  assert.deepEqual(r.keys.map((k) => `${k.key}@${k.line}`), [
    "reg TK-1 review r1 i1@7",
    "reg TK-1 review r2 i1@16",
    "reg TK-1 review r2 i2@16",
    "reg TK-1 qa r2 i1@10",
  ]);
  assert.match(renderText(r), /keys \(4\):\n {2}reg TK-1 review r1 i1 — review-report\.md:7/);
});

test("K16 fails only on an unreadable report; a missing report adds no keys", () => {
  const r = checkTask(input({ qa: { kind: "error", reason: "larger than 2097152 bytes" } }));
  assert.match(check(r, "K16").detail, /qa-report\.md: larger than/);
  assert.deepEqual(r.keys, []);
  const rr = checkTask(input({ review: { kind: "error", reason: "is a directory" } }));
  assert.match(check(rr, "K16").detail, /review-report\.md: is a directory/);
  const missing = checkTask(input({ qa: { kind: "missing" } }));
  assert.equal(statusOf(missing, "K16"), "pass");
  assert.deepEqual(missing.keys.map((k) => k.key), ["reg TK-1 review r1 i1"]);
  const noRound = checkTask(input({ review: ok("# Review\n| L1 | x | To register |\n") }));
  assert.deepEqual(noRound.keys.map((k) => k.key).slice(0, 1), ["reg TK-1 review r1 i1"], "a report with no Round: 1 line is one round");
});

// ---- rendering ----

test("renderText prints only computed values: no note or report text", () => {
  const t = baseTransitions();
  t[2].note = "SECRET-NOTE-TEXT";
  const r = checkTask(input({ review: ok(REVIEW + "\nSECRET-REPORT-TEXT\n") }, status({}, t)));
  const text = renderText(r);
  assert.doesNotMatch(text, /SECRET/);
  assert.doesNotMatch(JSON.stringify(r), /SECRET/);
  assert.match(text, /^pipeline check TK-1: PASS \(0 failed, 0 skipped of 16\)/);
  const failed = renderText(checkTask(input({ status: { kind: "missing" } })));
  assert.match(failed, /^pipeline check \(unknown\): FAIL \(1 failed, 14 skipped of 16\)/);
  assert.match(failed, /✖ K1 status\.parse — status\.json is missing/);
  assert.match(failed, /- K2 status\.ticket — skipped: depends on K1/);
});
