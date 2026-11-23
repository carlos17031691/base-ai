import { test } from "node:test";
import assert from "node:assert/strict";
import {
  checkTask,
  fenceMask,
  markerOffsets,
  maskCodeSpans,
  nextActor,
  parseStatus,
  renderText,
  type NextActorInput,
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
// A valid Security section (BASE-124-B, K19); `### Security` is the heading of a re-review round.
const SEC = "\n## Security\n\n- Trust boundary touched: no\n- Method: OWASP checklist\n- Findings: none\n\n| Category | Result | Basis |\n|---|---|---|\n| Input validation & injection | none | src/x.ts:1 |\n| Authn/authz & isolation | n/a | no auth code |\n| Secrets & data protection | none | src/x.ts:2 |\n| Abuse resistance | n/a | no endpoint |\n| Supply chain | none | no dependency change |\n";
const SEC3 = SEC.replace("## Security", "### Security");
const REVIEW = `# Review\nRound: 1\nReviewed implementer completion: ${C}\n\n## Verdict: approved\n\n| # | Issue | Tech debt |\n|---|---|---|\n| L1 | thing | To register |\n${SEC}`;
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
  assert.equal(r.checks.length, 19);
  assert.ok(r.checks.every((c) => c.status === "pass"));
  assert.equal(r.schema, 1);
  assert.match(r.rule, /^supervisor\.md@[0-9a-f]{7}$/);
  assert.notEqual(r.rule, "supervisor.md@682c6e4");
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
    "## Round 2 re-review", "", C, "**Round 2 verdict:** approved", "- **To register** then **To register**", SEC3,
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
  assert.match(text, /^pipeline check TK-1: PASS \(0 failed, 0 skipped of 19\)/);
  const failed = renderText(checkTask(input({ status: { kind: "missing" } })));
  assert.match(failed, /^pipeline check \(unknown\): FAIL \(1 failed, 17 skipped of 19\)/);
  assert.match(failed, /✖ K1 status\.parse — status\.json is missing/);
  assert.match(failed, /- K2 status\.ticket — skipped: depends on K1/);
});

// ---- K17 / K18: decisions.md (BASE-071-P2) ----

const block = (id: string, covers: string, opts: { bold?: boolean; list?: boolean; decision?: string; omit?: string; extra?: string } = {}) => {
  const fields: [string, string][] = [
    ["Decided", "2026-01-01T00:09:00Z"],
    ["Decided by", "human"],
    ["Recorded by", "coordinator"],
    ["Covers", covers],
    ["Decision", opts.decision ?? "the human decided something"],
    ["Affects", "plan.md"],
  ];
  const pre = opts.list === false ? "" : "- ";
  const lines = fields
    .filter(([l]) => l !== opts.omit)
    .map(([l, v]) => (opts.bold ? `${pre}**${l}:** ${v}` : `${pre}${l}: ${v}`));
  return [`## ${id}`, "", ...lines, ...(opts.extra ? [opts.extra] : []), ""].join("\n");
};
const decisions = (...blocks: string[]) => ok(["# Decisions — TK-1", "", ...blocks].join("\n"));
const LOCK = "2026-01-01T00:01:00Z";
const REVIEW1 = "2026-01-01T00:04:00Z";

test("K17 accepts plain and bold labels, with or without a list marker, and annotated multi-item Covers", () => {
  for (const opts of [{}, { bold: true }, { list: false }, { bold: true, list: false }]) {
    const r = checkTask(input({ decisions: decisions(block("D1", `${LOCK} (the lock, with a comma, inside), ${REVIEW1}`, opts)) }));
    assert.equal(statusOf(r, "K17"), "pass", `${JSON.stringify(opts)}: ${check(r, "K17").detail}`);
    assert.equal(r.facts.decisions.blocks, 1);
  }
  assert.equal(statusOf(checkTask(input()), "K17"), "pass", "an absent decisions.md passes");
  assert.equal(checkTask(input()).facts.decisions.present, false);
});

test("K17 names each format problem by block and field, never echoing values", () => {
  const cases: [FileRead, RegExp][] = [
    ...["Decided", "Decided by", "Recorded by", "Covers", "Decision", "Affects"].map(
      (f): [FileRead, RegExp] => [decisions(block("D1", LOCK, { omit: f })), new RegExp(`D1 ${f}: missing`)],
    ),
    [decisions(block("D1", `${LOCK} (one) (two)`)), /D1 Covers: item 1 is not a timestamp/],
    [decisions(block("D1", LOCK, { extra: "- Covers: " + REVIEW1 })), /D1 Covers: appears 2 times/],
    [decisions(block("D1", LOCK).replace("- Decided by: human", "- Decided by:")), /D1 Decided by: empty/],
    [decisions(block("D0", LOCK)), /line 3: a "## " heading that is not ## D<n>/],
    [decisions(block("D01", LOCK)), /heading that is not/],
    [decisions("## Notes\n", block("D1", LOCK)), /line 3: a "## " heading/],
    [decisions(block("D1", "soon")), /D1 Covers: item 1 is not a timestamp with an optional \(note\)/],
    [decisions(block("D1", `${LOCK}, 2026-01-01T09:09:09Z`)), /D1 Covers: 2026-01-01T09:09:09Z is not the timestamp of a transitions\[\] entry/],
    [decisions(block("D1", "none")), /D1 Covers: none outside a steering acknowledgement block/],
    [{ kind: "error", reason: "larger than 2097152 bytes" }, /decisions\.md: larger than/],
  ];
  for (const [d, re] of cases) {
    const r = checkTask(input({ decisions: d }));
    assert.equal(statusOf(r, "K17"), "fail", String(re));
    assert.match(check(r, "K17").detail, re);
    assert.doesNotMatch(check(r, "K17").detail, /the human decided something|coordinator/);
  }
  const ack = checkTask(input({ decisions: decisions(block("D1", "none", { decision: "Steering acknowledged: plan.md:3" })) }));
  assert.equal(statusOf(ack, "K17"), "pass", check(ack, "K17").detail);
  assert.deepEqual(ack.facts.decisions.acknowledging, ["D1"]);
  const fenced = checkTask(input({ decisions: decisions("```", "## Notes", "```", block("D1", LOCK)) }));
  assert.equal(statusOf(fenced, "K17"), "pass", "a heading inside a fence is ignored");
});

// A human entry and an implementer re-entry after the lock, as status transitions.
function withEntries(...extra: T[]): T[] {
  return [...baseTransitions(), ...extra];
}
const human = (ts: string, note = "qa rounds reset: x"): T => ({ from: "completed", to: "completed", agent: "human", timestamp: ts, note });

test("K18 events: human entries after the lock (resets included), but not the lock entry itself", () => {
  const r = checkTask(input({}, status({}, withEntries(human("2026-01-01T00:06:00Z")))));
  assert.deepEqual(r.facts.decisions.events, [{ timestamp: "2026-01-01T00:06:00Z", kind: "human" }]);
  assert.match(check(r, "K18").detail, /uncovered: 2026-01-01T00:06:00Z \(human\)/);
  const covered = checkTask(input({ decisions: decisions(block("D1", "2026-01-01T00:06:00Z (the reset)")) }, status({}, withEntries(human("2026-01-01T00:06:00Z")))));
  assert.equal(statusOf(covered, "K18"), "pass", check(covered, "K18").detail);
  assert.deepEqual(covered.facts.decisions.covering, ["D1"]);
  assert.equal(statusOf(checkTask(input()), "K18"), "pass", "no events, no decisions.md");
});

test("K18 events: a human entry that is not a reset", () => {
  const r = checkTask(input({}, status({}, withEntries(human("2026-01-01T00:06:00Z", "human decided a scope change")))));
  assert.deepEqual(r.facts.decisions.events, [{ timestamp: "2026-01-01T00:06:00Z", kind: "human" }]);
  assert.equal(r.facts.resets, 0);
  assert.equal(statusOf(r, "K18"), "fail");
});

test("K18 events: a blocked → in_progress re-entry", () => {
  const t = baseTransitions().slice(0, 3);
  t.push(
    { from: "in_progress", to: "blocked", agent: "implementer", timestamp: "2026-01-01T00:02:10Z", note: "blocked" },
    { from: "blocked", to: "in_progress", agent: "implementer", timestamp: "2026-01-01T00:02:20Z", note: "unblocked" },
    ...baseTransitions().slice(3),
  );
  const r = checkTask(input({}, status({}, t)));
  assert.deepEqual(r.facts.decisions.events, [{ timestamp: "2026-01-01T00:02:20Z", kind: "unblock" }]);
  assert.equal(statusOf(r, "K18"), "fail");
});

function reentryAfter(note: string): T[] {
  const t = baseTransitions().slice(0, 4);
  t.push(
    { from: "completed", to: "completed", agent: "reviewer", timestamp: REVIEW1, note },
    { from: "completed", to: "in_progress", agent: "implementer", timestamp: "2026-01-01T00:04:10Z", note: "re-entry" },
    { from: "in_progress", to: "completed", agent: "implementer", timestamp: "2026-01-01T00:04:20Z", note: "done" },
  );
  return t;
}

test("K18 events: a re-entry is an ordinary send-back only after a failing round bound to the previous completion (H4)", () => {
  const ordinary = checkTask(input({}, status({}, reentryAfter(`review round 1: changes_requested; reviewed implementer completion ${C}`))));
  assert.deepEqual(ordinary.facts.decisions.events, []);
  const other = checkTask(input({}, status({}, reentryAfter("review round 1: changes_requested; reviewed implementer completion 2026-01-01T00:00:01Z"))));
  assert.deepEqual(other.facts.decisions.events, [{ timestamp: "2026-01-01T00:04:10Z", kind: "reentry" }]);
  const t = baseTransitions();
  t[5].note = `qa round 1: fail; verified implementer completion ${C}`;
  t.push({ from: "completed", to: "in_progress", agent: "implementer", timestamp: "2026-01-01T00:05:10Z", note: "re-entry" });
  assert.deepEqual(checkTask(input({}, status({}, t))).facts.decisions.events, [], "a QA fail for the previous completion");
  const none = baseTransitions().slice(0, 4);
  none.push({ from: "completed", to: "in_progress", agent: "implementer", timestamp: "2026-01-01T00:03:30Z", note: "re-entry" });
  assert.deepEqual(checkTask(input({}, status({}, none))).facts.decisions.events, [{ timestamp: "2026-01-01T00:03:30Z", kind: "reentry" }]);
});

test("K18 catches the BASE-080-G1 shape: a re-entry after an approved review, with D1 covering only the reviewer entry", () => {
  const t = reentryAfter(`review round 1: approved; reviewed implementer completion ${C}`);
  const before = checkTask(input({ decisions: decisions(block("D1", `${REVIEW1} (the reviewer round 1 entry)`)) }, status({}, t)));
  assert.equal(statusOf(before, "K17"), "pass");
  assert.equal(statusOf(before, "K18"), "fail");
  assert.match(check(before, "K18").detail, /^uncovered: 2026-01-01T00:04:10Z \(reentry\)$/);
  assert.deepEqual(before.facts.decisions.covering, []);
  const fixed = checkTask(input({ decisions: decisions(block("D1", `${REVIEW1} (the reviewer entry), 2026-01-01T00:04:10Z (the re-entry)`)) }, status({}, t)));
  assert.equal(statusOf(fixed, "K18"), "pass");
  assert.deepEqual(fixed.facts.decisions.covering, ["D1"]);
  assert.match(renderText(fixed), /decisions: 1 block\(s\); events: 2026-01-01T00:04:10Z \(reentry\); covering: D1; acknowledging: -/);
});

test("K18 with an absent file fails on events, fails on an unreadable file, and is skipped when K6 fails", () => {
  const t = withEntries(human("2026-01-01T00:06:00Z"));
  assert.match(check(checkTask(input({ decisions: { kind: "missing" } }, status({}, t))), "K18").detail, /uncovered/);
  assert.match(check(checkTask(input({ decisions: { kind: "error", reason: "is a directory" } })), "K18").detail, /decisions\.md: is a directory/);
  const unlocked = checkTask(input({}, status({ plan_locked: false })));
  assert.match(check(unlocked, "K18").detail, /depends on K6/);
  assert.match(renderText(checkTask(input())), /decisions: absent; events: none; covering: -; acknowledging: -/);
});

// ---- facts.nextActor (BASE-101-D0) ----

const KEYS = [
  "status.parse", "status.ticket", "plan.steps", "state", "transitions.order", "lock", "completion", "review.present", "review.consistency",
  "review.binding", "review.verdict", "qa.present", "qa.consistency", "qa.binding", "qa.verdict", "register.keys", "decisions.format", "decisions.covers",
];
type St = "pass" | "fail" | "skip";
const checksWith = (over: Record<string, St> = {}) =>
  KEYS.map((key, i) => ({ id: `K${i + 1}`, key, source: "x", status: over[`K${i + 1}`] ?? ("pass" as St), detail: "" }));
const na = (over: Partial<NextActorInput> = {}, st: Record<string, St> = {}) =>
  nextActor({ checks: checksWith(st), state: "completed", planLocked: true, reviewEntries: 1, qaEntries: 1, resetExists: false, ownTicket: false, keys: 0, ...over });
const UNSTARTED: Record<string, St> = { K4: "fail", K6: "fail", K7: "fail", K8: "fail", K9: "skip", K10: "skip", K11: "skip", K12: "fail", K13: "skip", K14: "skip", K15: "skip", K18: "skip" };

test("nextActor rows 1–3: pending — planner without a draft, human for approval, implementer once locked", () => {
  assert.deepEqual(na({ state: "pending", planLocked: false, reviewEntries: 0, qaEntries: 0 }, { ...UNSTARTED, K3: "fail" }), { role: "planner", reason: "plan not drafted" });
  assert.deepEqual(na({ state: "pending", planLocked: false, reviewEntries: 0, qaEntries: 0 }, UNSTARTED), { role: "human", reason: "plan approval" });
  assert.deepEqual(na({ state: "pending", reviewEntries: 0, qaEntries: 0 }, { ...UNSTARTED, K6: "pass", K18: "pass" }), { role: "implementer", reason: "plan locked; claim it" });
});

test("nextActor rows 4–5: in_progress is the implementer, blocked is the human", () => {
  assert.deepEqual(na({ state: "in_progress", reviewEntries: 0, qaEntries: 0 }, { ...UNSTARTED, K6: "pass", K18: "pass" }), { role: "implementer", reason: "in progress" });
  assert.deepEqual(na({ state: "blocked", reviewEntries: 0, qaEntries: 0 }, { ...UNSTARTED, K6: "pass", K18: "pass" }), { role: "human", reason: "blocked" });
  assert.deepEqual(na({ state: "blocked", planLocked: false, reviewEntries: 0, qaEntries: 0 }, UNSTARTED), { role: "human", reason: "blocked" }, "K6 is progress while blocked and unlocked");
});

test("nextActor rows 6–8: review missing, not bound (round = reviewer entries + 1), changes_requested is a human send-back", () => {
  assert.deepEqual(na({ reviewEntries: 0, qaEntries: 0 }, { K8: "fail", K9: "skip", K10: "skip", K11: "skip", K12: "fail", K13: "skip", K14: "skip", K15: "skip" }), {
    role: "reviewer",
    round: 1,
    reason: "no review round",
  });
  assert.deepEqual(na({ reviewEntries: 1 }, { K10: "fail", K11: "skip" }), { role: "reviewer", round: 2, reason: "review not bound to latest completion" });
  assert.deepEqual(na({ reviewEntries: 2 }, { K10: "fail" }), { role: "reviewer", round: 3, reason: "review not bound to latest completion" });
  assert.deepEqual(na({ reviewEntries: 2 }, { K11: "fail" }), { role: "human", reason: "send-back decision: review round 2 changes_requested" });
});

test("nextActor rows 9–12: QA after a reset, QA missing, not bound (round = counted entries + 1), QA fail is a human send-back", () => {
  const noQa = { K12: "fail", K13: "skip", K14: "skip", K15: "skip" } as Record<string, St>;
  assert.deepEqual(na({ qaEntries: 0, resetExists: true }, noQa), { role: "qa", round: 1, reason: "no QA round since the QA rounds reset" });
  assert.deepEqual(na({ qaEntries: 0 }, noQa), { role: "qa", round: 1, reason: "no QA round" });
  assert.deepEqual(na({ qaEntries: 1 }, { K14: "fail", K15: "skip" }), { role: "qa", round: 2, reason: "QA not bound to latest completion" });
  assert.deepEqual(na({ qaEntries: 1 }, { K15: "fail" }), { role: "human", reason: "send-back decision: QA round 1 fail" });
});

test("nextActor rows 13–15: own ticket goes to the human; supervisor with and without keys; validated is none", () => {
  assert.deepEqual(na({ ownTicket: true }), { role: "human", reason: "supervisor own ticket: the human decides" });
  assert.deepEqual(na(), { role: "supervisor", reason: "review approved and QA pass for latest completion" });
  assert.deepEqual(na({ keys: 3 }), { role: "supervisor", reason: "review approved and QA pass for latest completion; register 3 key(s) first" });
  assert.deepEqual(na({ state: "validated" }), { role: "none", reason: "validated; improvement optional, then the human's PR" });
  assert.deepEqual(na({ state: "weird" }), { role: "human", reason: "no rule matched" });
});

test("nextActor precedence: the first integrity failure in K order names the human, progress failures do not", () => {
  assert.deepEqual(na({}, { K5: "fail", K18: "fail" }), { role: "human", reason: "check K5 transitions.order failed" });
  assert.deepEqual(na({}, { K18: "fail" }), { role: "human", reason: "check K18 decisions.covers failed" });
  assert.deepEqual(na({ state: null }, { K1: "fail" }), { role: "human", reason: "check K1 status.parse failed" });
  assert.equal(na({ reviewEntries: 1 }, { K8: "fail" }).reason, "check K8 review.present failed", "a reviewer entry with a null verdict");
  assert.equal(na({ qaEntries: 1 }, { K12: "fail" }).reason, "check K12 qa.present failed");
  assert.equal(na({ qaEntries: 0, resetExists: true }, { K12: "fail", K13: "fail" }).reason, "check K13 qa.consistency failed", "a filled report after a reset");
  assert.equal(na({}, { K7: "fail" }).reason, "check K7 completion failed", "no completion in completed");
  assert.equal(na({ state: "in_progress" }, { K3: "fail" }).reason, "check K3 plan.steps failed", "K3 once the plan is locked");
  assert.equal(na({ state: "pending" }, { K6: "fail" }).reason, "check K6 lock failed", "K6 with plan_locked true");
  for (const id of ["K2", "K9", "K16", "K17"]) assert.equal(na({}, { [id]: "fail" }).role, "human", id);
});

test("nextActor end to end: a fresh pending task, a locked one, the full pass, and K18 in checkTask", () => {
  const init = [{ from: null, to: "pending", agent: "planner", timestamp: "2026-01-01T00:00:00Z", note: "task initialized" }];
  const fresh = { review: { kind: "missing" } as FileRead, qa: { kind: "missing" } as FileRead };
  const draft = checkTask(input({ ...fresh, plan: ok("# Plan\n\n## Steps\n\n1. \n") }, status({ state: "pending", plan_locked: false, checklist: { tests_pass: false, lint_pass: false, types_pass: false, review_verdict: null, qa_verdict: null } }, init)));
  assert.deepEqual(draft.facts.nextActor, { role: "planner", reason: "plan not drafted" });
  const ready = checkTask(input(fresh, status({ state: "pending", plan_locked: false, checklist: { tests_pass: false, lint_pass: false, types_pass: false, review_verdict: null, qa_verdict: null } }, init)));
  assert.deepEqual(ready.facts.nextActor, { role: "human", reason: "plan approval" });
  assert.deepEqual(checkTask(input()).facts.nextActor, { role: "supervisor", reason: "review approved and QA pass for latest completion; register 2 key(s) first" });
  const human = { from: "completed", to: "completed", agent: "human", timestamp: "2026-01-01T00:06:00Z", note: "human decided something" };
  assert.deepEqual(checkTask(input({}, status({}, [...baseTransitions(), human]))).facts.nextActor, { role: "human", reason: "check K18 decisions.covers failed" });
  assert.deepEqual(checkTask(input({ status: { kind: "missing" } })).facts.nextActor.reason, "check K1 status.parse failed");
});

test("the next: line, with and without a round; note and report text never reach the reason or the output", () => {
  assert.match(renderText(checkTask(input())), /\n {2}next: supervisor — review approved and QA pass for latest completion; register 2 key\(s\) first\n/);
  const t = baseTransitions().slice(0, 5).map((e) => ({ ...e, note: `${e.note} SENTINEL-NOTE` }));
  const r = checkTask(input({ review: ok(`${REVIEW}\nSENTINEL-REPORT\n`), qa: { kind: "missing" } }, status({ checklist: { tests_pass: true, lint_pass: false, types_pass: true, review_verdict: "approved", qa_verdict: null } }, t)));
  assert.deepEqual(r.facts.nextActor, { role: "qa", round: 1, reason: "no QA round" });
  const text = renderText(r);
  assert.match(text, /\n {2}next: qa round 1 — no QA round\n/);
  assert.doesNotMatch(text + r.facts.nextActor.reason, /SENTINEL/);
});

// ---- K19 review.security (BASE-124-B): the form of the latest review round's Security section ----

const BARE = REVIEW.replace(SEC, "");
const OWASP = ["Input validation & injection", "Authn/authz & isolation", "Secrets & data protection", "Abuse resistance", "Supply chain"];
const STRIDE = ["Spoofing", "Tampering", "Repudiation", "Information disclosure", "Denial of service", "Elevation of privilege"];
interface SecOpts {
  heading?: string;
  boundary?: string | null;
  method?: string | null;
  findings?: string | null;
  cats?: string[];
  results?: string[];
  basis?: string;
  label?: (l: string) => string;
  extra?: string;
}
/** A Security section; every part can be bent. */
function sec(o: SecOpts = {}): string {
  const label = o.label ?? ((l: string) => `- ${l}:`);
  const cats = o.cats ?? OWASP;
  const line = (l: string, v: string | null | undefined, d: string) => (v === null ? [] : [`${label(l)} ${v ?? d}`]);
  return [
    o.heading ?? "## Security",
    "",
    ...line("Trust boundary touched", o.boundary, "no"),
    ...line("Method", o.method, "OWASP checklist"),
    ...line("Findings", o.findings, "none"),
    "",
    "| Category | Result | Basis |",
    "|---|---|---|",
    ...cats.map((c, i) => `| ${c} | ${o.results?.[i] ?? "none"} | ${o.basis ?? "cli/src/x.ts:1"} |`),
    ...(o.extra === undefined ? [] : [o.extra]),
    "",
  ].join("\n");
}
const k19 = (review: string, st: unknown = status()) => check(checkTask(input({ review: ok(review) }, st)), "K19");
const stride = (o: SecOpts = {}) => sec({ boundary: "yes — external input", method: "STRIDE", cats: STRIDE, ...o });
/** Two review rounds on one completion: round 1 changes_requested, round 2 approved. */
function twoRounds(round2: string): [string, unknown] {
  const t = baseTransitions();
  t[4].note = `review round 1: changes_requested; reviewed implementer completion ${C}`;
  t.splice(5, 0, { from: "completed", to: "completed", agent: "reviewer", timestamp: "2026-01-01T00:04:30Z", note: `review round 2: approved; reviewed implementer completion ${C}` });
  const review = `${REVIEW.replace("## Verdict: approved", "## Verdict: changes_requested")}\n## Round 2 re-review\n\n${C}\n**Round 2 verdict:** approved\n\n${round2}`;
  return [review, status({}, t)];
}

test("K19 a well-formed section passes: OWASP checklist after no, STRIDE after yes, every accepted line form, bold categories", () => {
  assert.deepEqual([k19(BARE + sec()).status, k19(BARE + sec()).detail], ["pass", ""]);
  assert.equal(k19(BARE + stride()).status, "pass");
  for (const boundary of ["yes — network", "Yes: processes and secrets", "yes (external input)", "**yes** — secrets"]) {
    assert.equal(k19(BARE + stride({ boundary })).status, "pass", boundary);
  }
  for (const label of [(l: string) => `- ${l}:`, (l: string) => `${l}:`, (l: string) => `- **${l}:**`, (l: string) => `* ${l}:`, (l: string) => `**${l}:**`]) {
    assert.equal(k19(BARE + sec({ label })).status, "pass", label("x"));
  }
  assert.equal(k19(BARE + sec({ cats: OWASP.map((c) => `**${c}**`) })).status, "pass", "bold category labels");
  assert.equal(k19(BARE + sec({ cats: OWASP.map((c) => `\`${c.toLowerCase()}\``) })).status, "pass", "case and backticks");
  assert.equal(k19(BARE + sec({ method: "`OWASP checklist`", boundary: "No" })).status, "pass");
  // The section ends at the next heading: later tables are not category rows.
  assert.equal(k19(`${BARE}${sec()}\n## Checklist\n\n| a | b | c |\n|---|---|---|\n| x | H9 | z |\n`).status, "pass");
  const [review, st] = twoRounds(sec({ heading: "### Security" }));
  assert.equal(k19(review, st).status, "pass", "a re-review round with ### Security");
  assert.equal(k19(...twoRounds(stride())).status, "pass", "## is accepted in a re-review round too");
});

test("K19 a re-review round cannot skip the section: only the latest round counts", () => {
  const [review, st] = twoRounds("no security pass here\n");
  const c = k19(review, st);
  assert.deepEqual([c.status, c.detail], ["fail", "round 2: 0 Security headings"]);
  // And a valid latest round is enough, whatever round 1 holds.
  const [fixed, st2] = twoRounds(sec({ heading: "### Security" }));
  assert.equal(k19(fixed.replace(SEC, ""), st2).status, "pass");
});

test("K19 absent or not counted: no heading, two headings, a section only inside a code fence, the unfilled template", () => {
  assert.deepEqual([k19(BARE).status, k19(BARE).detail], ["fail", "round 1: 0 Security headings"]);
  assert.equal(k19(BARE + sec() + sec()).detail, "round 1: 2 Security headings");
  assert.equal(k19(`${BARE}\`\`\`\n${sec()}\`\`\`\n`).detail, "round 1: 0 Security headings");
  assert.equal(k19(BARE + sec({ heading: "#### Security" })).detail, "round 1: 0 Security headings");
  assert.equal(k19(BARE + sec({ heading: "## Security review" })).detail, "round 1: 0 Security headings");
  const template = [
    "## Security",
    "",
    "<!-- Required in every round. -->",
    "",
    "- Trust boundary touched: <!-- no | yes — network -->",
    "- Method: <!-- STRIDE | OWASP checklist -->",
    "- Findings: <!-- none | ids -->",
    "",
    "| Category | Result | Basis |",
    "|---|---|---|",
    "| <!-- STRIDE: Spoofing … --> | <!-- ids --> | <!-- basis --> |",
    "",
  ].join("\n");
  const unfilled = k19(BARE + template);
  assert.deepEqual([unfilled.status, unfilled.detail], ["fail", "round 1: Trust boundary touched is empty"]);
  assert.equal(k19(`${BARE}<!--\n${sec()}-->\n`).detail, "round 1: 0 Security headings", "a section inside a comment");
});

test("K19 lines: each label missing, twice or empty; a boundary that is neither no nor yes with a kind", () => {
  for (const [key, label] of [["boundary", "Trust boundary touched"], ["method", "Method"], ["findings", "Findings"]] as const) {
    assert.equal(k19(BARE + sec({ [key]: null })).detail, `round 1: ${label}: 0 lines`);
    assert.equal(k19(BARE + sec({ [key]: "" })).detail, `round 1: ${label} is empty`);
    assert.equal(k19(BARE + sec({ [key]: "**" })).detail, `round 1: ${label} is empty`);
    assert.equal(k19(BARE + sec({ extra: `\n- ${label}: none` })).detail, `round 1: ${label}: 2 lines`);
  }
  for (const boundary of ["maybe", "yes", "yes — the database", "no, but yes", "none", "n/a"]) {
    assert.equal(k19(BARE + sec({ boundary })).detail, "round 1: Trust boundary touched is neither no nor yes with a kind", boundary);
  }
  // An indented field line is not a field line.
  assert.equal(k19(BARE + sec({ label: (l) => `  - ${l}:` })).detail, "round 1: Trust boundary touched: 0 lines");
});

test("K19 the method follows the boundary: yes with OWASP checklist and no with STRIDE fail", () => {
  assert.equal(k19(BARE + sec({ boundary: "yes — network" })).detail, "round 1: Method does not match Trust boundary touched");
  assert.equal(k19(BARE + sec({ method: "STRIDE", cats: STRIDE })).detail, "round 1: Method does not match Trust boundary touched");
  assert.equal(k19(BARE + sec({ method: "OWASP" })).detail, "round 1: Method does not match Trust boundary touched");
  assert.equal(k19(BARE + stride({ method: "STRIDE and OWASP checklist" })).status, "fail");
});

test("K19 rows: one filled row per category of the method, and no other row", () => {
  assert.equal(k19(BARE + stride({ cats: STRIDE.slice(1) })).detail, "round 1: category rows: expected 6, found 5");
  assert.equal(k19(BARE + sec({ cats: OWASP.slice(1) })).detail, "round 1: category rows: expected 5, found 4");
  assert.equal(k19(BARE + sec({ cats: [...OWASP.slice(0, 4), OWASP[0]] })).detail, "round 1: category rows: 2 for one OWASP checklist category");
  assert.equal(k19(BARE + sec({ cats: [...OWASP, "Logging"] })).detail, "round 1: category rows: expected 5, found 6");
  assert.equal(k19(BARE + sec({ cats: [...OWASP.slice(0, 4), "Logging"] })).detail, "round 1: category rows: 0 for one OWASP checklist category");
  assert.equal(k19(BARE + sec({ cats: STRIDE.slice(0, 5) })).status, "fail", "STRIDE rows under the OWASP method");
  assert.equal(k19(BARE + sec({ results: ["", "none", "none", "none", "none"] })).detail, "round 1: a category row has an empty Result or Basis");
  assert.equal(k19(BARE + sec({ basis: "" })).detail, "round 1: a category row has an empty Result or Basis");
  assert.equal(k19(BARE + sec({ basis: "``" })).detail, "round 1: a category row has an empty Result or Basis");
  assert.equal(k19(BARE + sec().replace("| Supply chain | none | cli/src/x.ts:1 |", "| Supply chain | none |")).detail, "round 1: a category row has an empty Result or Basis");
  assert.equal(k19(BARE + sec().replace("| Category | Result | Basis |\n|---|---|---|\n", "")).status, "pass", "the rows count without a header");
});

test("K19 the cited findings agree between the Findings line and the rows", () => {
  const h1 = ["H1", "none", "none", "none", "none"];
  assert.equal(k19(BARE + sec({ results: h1 })).detail, "round 1: finding ids differ: 0 in Findings, 1 in the rows");
  assert.equal(k19(BARE + sec({ findings: "H1" })).detail, "round 1: finding ids differ: 1 in Findings, 0 in the rows");
  assert.equal(k19(BARE + sec({ findings: "H1, L2", results: h1 })).detail, "round 1: finding ids differ: 2 in Findings, 1 in the rows");
  assert.equal(k19(BARE + sec({ findings: "H1, L2", results: ["H1", "L2 and H1", "none", "n/a", "none"] })).status, "pass");
  assert.equal(k19(BARE + sec({ findings: "M3", results: ["none", "none", "**M3**", "none", "none"] })).status, "pass");
  assert.equal(k19(BARE + sec({ findings: "M3", results: ["none", "none", "M4", "none", "none"] })).status, "fail", "the same count, different ids");
  assert.equal(k19(BARE + sec({ findings: "see above" })).detail, "round 1: Findings is neither none nor finding ids");
  assert.equal(k19(BARE + sec({ findings: "None" })).status, "pass");
});

test("K19 older and unfinished tasks are not failed: skipped outside completed, and when K8 or K9 does not pass", () => {
  const t = baseTransitions();
  const validated = [...t, { from: "completed", to: "validated", agent: "supervisor", timestamp: "2026-01-01T00:06:00Z", note: "validated" }];
  const old = checkTask(input({ review: ok(BARE) }, status({ state: "validated" }, validated)));
  assert.deepEqual([check(old, "K19").status, check(old, "K19").detail, old.ok], ["skip", "state is validated", true]);
  assert.match(renderText(old), /^pipeline check TK-1: PASS \(0 failed, 1 skipped of 19\)/);
  assert.match(renderText(old), /- K19 review\.security — skipped: state is validated/);
  const blocked = [...t.slice(0, 3), { from: "in_progress", to: "blocked", agent: "implementer", timestamp: C, note: "blocked: x" }];
  for (const [state, list] of [["in_progress", t.slice(0, 3)], ["pending", t.slice(0, 2)], ["blocked", blocked]] as const) {
    const c = k19(BARE, status({ state, blocker: state === "blocked" ? "x" : null }, list));
    assert.deepEqual([c.status, c.detail], ["skip", `state is ${state}`], state);
  }
  const noReview = k19(BARE, status({ checklist: { tests_pass: true, lint_pass: false, types_pass: true, review_verdict: null, qa_verdict: null } }, t.slice(0, 4)));
  assert.deepEqual([noReview.status, noReview.detail], ["skip", "depends on K8"]);
  const inconsistent = k19(REVIEW.replace("## Verdict: approved", "## Verdict: changes_requested"));
  assert.deepEqual([inconsistent.status, inconsistent.detail], ["skip", "depends on K9"]);
  assert.deepEqual([k19(REVIEW, undefined).status], ["pass"]);
  const noStatus = check(checkTask(input({ status: { kind: "missing" } })), "K19");
  assert.deepEqual([noStatus.status, noStatus.detail], ["skip", "depends on K1"]);
});

test("K19 detail and output never carry report text", () => {
  const marker = "SENTINEL-K19";
  const reviews = [
    BARE + sec({ boundary: marker }),
    BARE + sec({ method: marker }),
    BARE + sec({ findings: marker }),
    BARE + sec({ cats: [...OWASP.slice(0, 4), marker] }),
    BARE + sec({ results: [marker, "H1", "none", "none", "none"] }),
    BARE + sec({ basis: marker, findings: "H1" }),
  ];
  for (const review of reviews) {
    const r = checkTask(input({ review: ok(review) }));
    assert.equal(check(r, "K19").status, "fail");
    assert.doesNotMatch(check(r, "K19").detail + renderText(r) + JSON.stringify(r), /SENTINEL/);
    assert.match(check(r, "K19").detail, /^round 1: /);
  }
});

test("K19 report shape and next actor: 19 checks in order, source C19, and a failing section goes to the human", () => {
  const good = checkTask(input());
  assert.deepEqual(good.checks.map((c) => c.id), Array.from({ length: 19 }, (_, i) => `K${i + 1}`));
  assert.deepEqual([good.checks[18].key, good.checks[18].source, good.checks[18].status], ["review.security", "C19", "pass"]);
  assert.equal(good.schema, 1);
  assert.match(renderText(good), /of 19\)/);
  assert.match(renderText(good), /✔ K19 review\.security/);
  assert.match(good.rule, /^supervisor\.md@[0-9a-f]{7}$/);
  assert.equal(good.facts.nextActor.role, "supervisor");

  const bad = checkTask(input({ review: ok(BARE) }));
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.facts.nextActor, { role: "human", reason: "check K19 review.security failed" });
  assert.match(renderText(bad), /✖ K19 review\.security — round 1: 0 Security headings/);
  // Review approved, no QA yet: the missing section is raised before QA is asked to run.
  const t = baseTransitions().slice(0, 5);
  const early = checkTask(input({ review: ok(BARE), qa: { kind: "missing" } }, status({ checklist: { tests_pass: true, lint_pass: false, types_pass: true, review_verdict: "approved", qa_verdict: null } }, t)));
  assert.deepEqual(early.facts.nextActor, { role: "human", reason: "check K19 review.security failed" });
});
