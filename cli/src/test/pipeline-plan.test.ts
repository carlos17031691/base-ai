import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkTask, parseStatus } from "../pipeline-check.js";
import {
  EXEMPT,
  PRE_GATE_TASKS,
  REASON,
  checkCriteria,
  checkPlan,
  decisionBlocks,
  judgeCandidate,
  lockIndex,
  planExitCode,
  renderPlan,
  type PlanTaskInput,
  type Reason,
} from "../pipeline-plan.js";
import type { RunResult, Runner } from "../pipeline-registration.js";

// In memory only, except two reads of the repository (the plan template and qa.md). Git is a fake runner.
const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const ROOT = "/repo";
const C = "c".repeat(40);
const P = "a".repeat(40);
const BLOB = "f".repeat(40);
const T0 = "2026-11-25T00:00:00Z";
const T1 = "2026-11-25T00:01:00Z";
const T2 = "2026-11-25T00:02:00Z";
const T3 = "2026-11-25T00:03:00Z";

/** A plan whose acceptance criteria are the given items, each one `- [ ] ` line. */
const planWith = (...items: string[]) => `# Plan\n\n## Steps\n\n1. **human** — ok\n\n## Acceptance criteria\n\n${items.map((i) => `- [ ] ${i}\n`).join("")}\n## Risks\n`;
const GOOD_PLAN = planWith("**AC1** `npm --prefix <r>/cli run test` exits 0.");

/** The reasons P1 gives the only criterion of a plan built from `item`. */
function reasonsOf(item: string): Reason[] {
  return checkCriteria(planWith(item)).criteria.map((p) => p.reason);
}
const passes = (item: string) => assert.deepEqual(checkCriteria(planWith(item)).criteria, [], item);
const failsWith = (item: string, reason: Reason) => assert.ok(reasonsOf(item).includes(reason), `${item}: ${reasonsOf(item).join(", ")}`);

// ── P2 fixtures ──────────────────────────────────────────────────────────────────────────────────────────────────────

type Entry = { from: string | null; to: string; agent: string; timestamp: string; note: string };
const init: Entry = { from: null, to: "pending", agent: "planner", timestamp: T0, note: "task initialized" };
const lockOf = (note: string, agent = "human"): Entry => ({ from: "pending", to: "pending", agent, timestamp: T1, note });
const LOCK = lockOf(`plan approved and locked by the human; plan review round 2 approved, plan.md at ${C}`);
const rebind = (commit: string, o: Partial<Entry> = {}): Entry => ({
  from: "pending",
  to: "pending",
  agent: "human",
  timestamp: T2,
  note: `lock re-binding: plan review round 2 approved, plan.md at ${commit}`,
  ...o,
});

function statusOf(transitions: Entry[], locked = true, ticket = "TK-1"): string {
  const state = transitions[transitions.length - 1]?.to ?? "pending";
  return JSON.stringify({
    ticket_id: ticket,
    state,
    plan_locked: locked,
    assignee: null,
    blocker: null,
    transitions,
    checklist: { tests_pass: false, lint_pass: false, types_pass: false, review_verdict: null, qa_verdict: null },
  });
}

// The real file's shape: the skeleton inside a comment that holds a nested comment.
const SKELETON = "<!--\n## Plan review round <N>\n- Plan commit: <40-hex>\n<!-- ids continue -->\n### Verdict: <approved | changes_requested>\n-->\n";
const round = (n: number, commit: string, verdict = "approved") => `## Plan review round ${n}\n\n- Plan commit: ${commit}\n\n### Verdict: ${verdict}\n\n`;
const REVIEW = `# Plan review: TK-1\n\n${SKELETON}\n${round(1, "1".repeat(40), "changes_requested")}${round(2, C)}`;
const decision = (covers: string, text = "plan.md unchanged since plan review round 2; the note named the wrong commit") =>
  `## D1\n\n- Decided by: human\n- Decided: ${T3}\n- Recorded by: coordinator\n- Covers: ${covers}\n- Decision: ${text}\n- Affects: none\n`;

function input(o: { dirName?: string; status: string; plan?: string; review?: string; decisions?: string; planRel?: string }): PlanTaskInput {
  const dirName = o.dirName ?? "TK-1";
  const read = (text: string | undefined) => (text === undefined ? { kind: "missing" as const } : { kind: "ok" as const, text });
  return {
    dirName,
    absPath: `${ROOT}/.ai/tasks/${dirName}`,
    planRel: o.planRel ?? `.ai/tasks/${dirName}/plan.md`,
    status: read(o.status),
    plan: read(o.plan ?? GOOD_PLAN),
    planReview: read(o.review),
    decisions: read(o.decisions),
  };
}

interface Git {
  last?: string;
  dirty?: string;
  /** rev-parse of `<p>^{commit}`: the printed commit, or an exit. */
  reachable?: string | "exit";
  /** rev-parse of `<commit>:<path>`, by commit; a missing commit exits. */
  blobs?: Record<string, string>;
  fail?: (args: string[]) => RunResult | undefined;
}

function git(g: Git) {
  const calls: string[][] = [];
  const run: Runner = async (cmd, args) => {
    calls.push([cmd, ...args]);
    assert.equal(cmd, "git");
    const forced = g.fail?.(args);
    if (forced) return forced;
    if (args.includes("log")) return { kind: "ok", stdout: `${g.last ?? C}\n` };
    if (args.includes("status")) return { kind: "ok", stdout: g.dirty ?? "" };
    const rev = args[args.length - 1];
    if (rev.endsWith("^{commit}")) return g.reachable === "exit" ? { kind: "error", reason: "exit" } : { kind: "ok", stdout: `${g.reachable ?? rev.slice(0, 40)}\n` };
    const blob = g.blobs?.[rev.slice(0, 40)];
    return blob === undefined ? { kind: "error", reason: "exit" } : { kind: "ok", stdout: `${blob}\n` };
  };
  return { run, calls };
}

async function p2(o: Parameters<typeof input>[0], g: Git = {}) {
  const { run, calls } = git(g);
  const { report, halt } = await checkPlan(input({ review: REVIEW, ...o }), ROOT, run);
  return { report, halt, calls, lock: report.checks.find((c) => c.id === "P2") };
}

// ── P1 ──────────────────────────────────────────────────────────────────────────────────────────────────────

test("R2 P1 fails a disallowed command: another CLI subcommand, a disallowed head or script, node -e, a git write, find -delete", () => {
  for (const cmd of [
    "node <r>/cli/dist/index.js ai stats",
    "node <r>/cli/dist/index.js ai sync --root <r>",
    "node <r>/cli/dist/index.js doctor --root <r>",
    "node <r>/cli/dist/index.js pipeline debt <r>/.ai/tasks/X",
    "node <r>/cli/dist/index.js pipeline ci --base <base>",
    "cat x",
    "base-ai pipeline check x",
    "npx tsc",
    "npm --prefix cli run check:package",
    "npm install",
    "npm ci",
    "npm publish",
    "node -e 1",
    "node --eval 1",
    "node -p 1",
    "node --input-type=module x",
    "node scripts/other.mjs",
    "git commit -m x",
    "git checkout main",
    "git -c core.pager=x log",
    "git hash-object -w x",
    "git diff --output=/tmp/x",
    "git log --output /tmp/x",
    "find . -delete",
    "find . -exec rm {} +",
    "make deploy",
    "sed -n 1p x",
  ]) {
    failsWith(`\`${cmd}\` runs.`, REASON.disallowed);
  }
  for (const cmd of ["grep x a | wc -l", "ls && rm x", "ls ; ls", "grep x a;ls", "grep x a > out", "ls $(pwd)", "ls `pwd`", "grep \"$(id)\" x", "ls (x)", "wc < x"]) {
    failsWith(`\`\` ${cmd} \`\` runs.`, REASON.operator);
  }
  failsWith("`grep 'x a` runs.", REASON.unparsable);
  failsWith('`grep "x a` runs.', REASON.unparsable);
});

test("R2 P1 fails a credentialed command: gh, a non-PATH prefix, a variable, a secret file", () => {
  for (const cmd of [
    "gh issue view 1",
    "gcloud auth list",
    "docker ps",
    "TOKEN=x npm --prefix cli run test",
    "PATH=/x:$PATH TOKEN=x npm --prefix cli run test",
    "PATH=$HOME/bin:$PATH npm --prefix cli run test",
    "grep $GITHUB_TOKEN x",
    'grep "${GITHUB_TOKEN}" x',
    "grep x .env",
    "grep x <r>/.env.local",
    "cmp a ~/.ssh/id_rsa",
    "wc -c server.pem",
    "ls --file=.env",
  ]) {
    failsWith(`\`${cmd}\` runs.`, REASON.credentials);
  }
  passes("`grep '$GITHUB_TOKEN' x` finds the literal.");
});

test("R2 P1 fails a merged-state criterion: post-merge wording, merged, CI, a remote run, merge-base --is-ancestor", () => {
  for (const prose of [
    "post-merge, `grep x a` shows it.",
    "Once merged, `grep x a` shows it.",
    "After the merge, `grep x a` shows it.",
    "After release, `grep x a` shows it.",
    "When released, `grep x a` shows it.",
    "In a new session, `grep x a` shows it.",
    "CodeRabbit approves; `grep x a` shows it.",
    "SonarCloud passes; `grep x a` shows it.",
    "GitHub Actions passes; `grep x a` shows it.",
    "CI passes; `grep x a` shows it.",
    "After the\n  merge, `grep x a` shows it.",
  ]) {
    failsWith(prose, REASON.merged);
  }
  failsWith("`git merge-base --is-ancestor <c> HEAD` exits 0.", REASON.merged);
  // Wording in a code span, or another case of CI, does not count (H6).
  passes("`grep -c \"merged\" a` prints `1`, and the `CI` job too.");
  passes("`grep x a` shows the ci folder.");
});

test("R2 P1 network commands fail: curl, wget, a URL, git fetch, push, remote", () => {
  for (const cmd of ["curl -s x", "wget x", "grep x https://example.invalid/a", "git fetch origin", "git push", "git -C <r> remote -v", "git ls-remote x"]) {
    failsWith(`\`${cmd}\` runs.`, REASON.network);
  }
});

test("R2 P1 passes every allowed form: PATH prefix, placeholders, quoted pipes, test:coverage, node --test, pipeline plan, date, a fence", () => {
  for (const cmd of [
    "PATH=/opt/node/bin:$PATH npm --prefix <r>/cli run test",
    "npm --prefix <r>/cli run test:coverage",
    "npm --prefix <r>/cli run build",
    "npm --prefix <r>/cli run type-check -- --pretty",
    "make -C <r> lint",
    "make test",
    "node --test <r>/cli/dist/test/",
    "node <r>/cli/dist/index.js pipeline plan <r>/.ai/tasks/X --root <r>",
    "node <r>/cli/dist/index.js pipeline check <r>/.ai/tasks/X --json",
    "date -u +%Y-%m-%dT%H:%M:%SZ",
    'grep -c -E "a (b|c)" <r>/x',
    "grep -n 'a|b;c>d' <r>/x",
    "grep -c a\\|b x",
    "git --no-optional-locks -C <r> status --porcelain",
    "git -C <r> diff --no-ext-diff --no-textconv --name-only <base> -- x",
    "git -C <r> log -1 --format=%H -- <r>/x",
    "git show <40-hex>:x",
    "git merge-base HEAD <base>",
    "git ls-files --others --exclude-standard",
    "git rev-parse HEAD",
    "git check-ignore x",
    "git hash-object -- a b",
    "ls -la <r>",
    "find <r>/x -name '*.ts'",
    "wc -c <r>/x",
    "diff a b",
    "cmp a b",
  ]) {
    passes(`\`${cmd}\` exits 0.`);
  }
  passes("The output of this block:\n\n  ```bash\n  npm --prefix <r>/cli run test\n  ```\n");
  passes("``grep -c 'a`b' x`` prints `1`.");
  failsWith("``grep -c `x` a`` prints `1`.", REASON.operator);
});

test("R2 P1 fails --ext-diff, --textconv and another date form", () => {
  for (const cmd of ["git diff --ext-diff", "git log -p --textconv", "git show --ext-diff HEAD", "date", "date -u", "date +%s", "date -u +%Y"]) {
    failsWith(`\`${cmd}\` runs.`, REASON.disallowed);
  }
});

test("R2 P1 does not fail literal spans (M4): headings, diff stats, partial phrases, placeholders, apostrophes, a lone variable", () => {
  // The head is read verbatim (D1.3), so an operator glued to it makes a literal, as any unknown word does (H5).
  assert.deepEqual(judgeCandidate("ls;ls"), { kind: "literal" });
  for (const span of ["## Other statements & guards", "1 insertion(+), 1 deletion(-)", "delta of round <M> from <base>; ", "<40-hex>", "it's", "$GITHUB_TOKEN", "a | b", "R2 P1 is a test name"]) {
    assert.deepEqual(judgeCandidate(span), { kind: "literal" }, span);
  }
  passes("`grep x a` shows `## Other statements & guards`, `1 insertion(+), 1 deletion(-)`, ``delta of round <M> from <base>; ``, `<40-hex>`, `it's` and `$GITHUB_TOKEN`.");
});

test("R2 P1 no criteria, empty criterion (the plan template itself) and no command QA can run", () => {
  assert.deepEqual(checkCriteria("# Plan\n\n## Steps\n\n1. x\n").check, { id: "P1", key: "plan.criteria", status: "fail", detail: "no criteria" });
  assert.deepEqual(checkCriteria("# Plan\n\n## Acceptance criteria\n\nnone\n").check.detail, "no criteria");
  assert.deepEqual(checkCriteria("```\n## Acceptance criteria\n- [ ] `grep x a`\n```\n").check.detail, "no criteria", "a fenced heading is not the section");
  const template = checkCriteria(readFileSync(join(REPO, "templates", "task", "plan.md"), "utf8"));
  assert.equal(template.check.status, "fail");
  assert.equal(template.check.detail, "2 of 2 criteria fail");
  assert.deepEqual(template.criteria.map((p) => [p.criterion, p.reason]), [[1, REASON.empty], [2, REASON.empty]]);
  assert.deepEqual(reasonsOf("The README explains it."), [REASON.noCommand]);
  assert.deepEqual(reasonsOf("`README.md` names `pipeline plan`."), [REASON.noCommand], "literal spans are not commands");
  assert.deepEqual(reasonsOf("`gh issue view 1` shows it."), [REASON.credentials, REASON.noCommand]);
  const checked = checkCriteria("## Acceptance criteria\n\n- [x] **AC1** done, nothing to run\n- [ ] **AC2** `grep x a` prints 1.\n");
  assert.deepEqual(checked.criteria, [{ criterion: 1, line: 3, reason: REASON.noCommand }], "a checked item is a criterion too");
  assert.equal(checked.check.detail, "1 of 2 criteria fail");
});

test("R2 P1 reads only the criteria: the preamble, other sections and closed HTML comments are not read", () => {
  const plan = [
    "# Plan",
    "## Goal",
    "- [ ] `gh issue view 1` after the merge",
    "## Acceptance criteria",
    "`curl x` is the preamble; CI and merged state here do not count.",
    "<!-- - [ ] `gh issue view 2`",
    "  still a comment, CI -->",
    "- [ ] **AC1** `grep x a` prints 1.",
    "## Post-merge verification",
    "- [ ] `curl https://example.invalid` once merged",
  ].join("\n");
  assert.deepEqual(checkCriteria(plan), { check: { id: "P1", key: "plan.criteria", status: "pass", detail: "" }, criteria: [] });
  const lines = checkCriteria(["## Acceptance criteria", "<!-- x", "-->", "- [ ] `gh x`"].join("\n")).criteria.map((p) => p.line);
  assert.deepEqual(lines, [4, 4], "line numbers survive a blanked comment");
});

test("R2 P1 output carries no plan text, only fixed reasons and line numbers", async () => {
  const plan = planWith("SECRET-WORDING `gh SECRET-ARG` and `curl https://SECRET-HOST`", "`cat SECRET-FILE` post-merge");
  const { report } = await checkPlan(input({ status: statusOf([init], false), plan }), ROOT, git({}).run);
  const out = renderPlan(report) + JSON.stringify(report);
  assert.doesNotMatch(out, /SECRET|curl|cat |gh /);
  const fixed = new Set<string>(Object.values(REASON));
  for (const p of report.criteria) assert.ok(fixed.has(p.reason), p.reason);
  assert.match(renderPlan(report), /^pipeline plan TK-1: FAIL\n {2}✖ P1 plan\.criteria — 2 of 2 criteria fail\n {2}- P2 plan\.lock — skipped: not locked\n {2}criterion 1 \(plan\.md:9\): /);
  const many = await checkPlan(input({ status: statusOf([init], false), plan: planWith(...Array.from({ length: 60 }, () => "none")) }), ROOT, git({}).run);
  const printed = renderPlan(many.report).split("\n").filter((l) => l.startsWith("  criterion "));
  assert.equal(printed.length, 50);
  assert.match(renderPlan(many.report), /\n {2}… 10 more$/);
});

test("R2 P1 mirrors the Commands of qa.md", () => {
  const qa = readFileSync(join(REPO, ".claude", "agents", "qa.md"), "utf8");
  const start = qa.indexOf("### Commands");
  assert.ok(start >= 0, "qa.md has a Commands section");
  const end = qa.indexOf("\n### ", start + 1);
  const section = qa.slice(start, end === -1 ? undefined : end);
  for (const sub of ["status", "diff", "log", "show", "merge-base", "ls-files", "rev-parse", "check-ignore", "hash-object"]) {
    assert.ok(section.includes(`\`${sub}\``), `git ${sub}`);
    assert.deepEqual(judgeCandidate(`git ${sub} x`), { kind: "command" }, `git ${sub}`);
  }
  for (const cmd of ["ls", "grep", "find", "wc", "diff", "cmp"]) {
    assert.ok(section.includes(`\`${cmd}\``), cmd);
    assert.deepEqual(judgeCandidate(`${cmd} x`), { kind: "command" }, cmd);
  }
  for (const s of ["--no-ext-diff", "--no-textconv", "--no-optional-locks", "date -u +%Y-%m-%dT%H:%M:%SZ", "never with `-w`", "`--output`", "`-exec`", "`-delete`"]) {
    assert.ok(section.includes(s), s);
  }
  assert.ok(/test, lint, type-check, coverage, build/.test(section), "the five check categories");
  assert.ok(section.includes("npm --prefix <absolute package dir> run <script>"), "the npm form");
  assert.ok(section.includes("`PATH=<dir>:$PATH`"), "the only prefix");
  const forbidden = section.slice(section.indexOf("**Forbidden to run"));
  assert.ok(forbidden.includes("`base-ai ai sync`"), "ai sync is forbidden");
  assert.ok(/including `fetch`/.test(forbidden), "fetch is forbidden");
  assert.ok(forbidden.includes("`sudo`"), "sudo is forbidden");
});

// ── P2 ──────────────────────────────────────────────────────────────────────────────────────────────────────

test("R2 P2 passes a lock bound to the latest approved round and the last, clean plan commit", async () => {
  const { report, calls, lock } = await p2({ status: statusOf([init, LOCK]) });
  assert.deepEqual(lock, { id: "P2", key: "plan.lock", status: "pass", detail: "" });
  assert.deepEqual([report.outcome, report.ok, report.exempt, planExitCode(report)], ["pass", true, false, 0]);
  assert.equal(renderPlan(report), "pipeline plan TK-1: PASS\n  ✔ P1 plan.criteria\n  ✔ P2 plan.lock");
  assert.deepEqual(calls, [
    ["git", "--literal-pathspecs", "-C", ROOT, "log", "-1", "--format=%H", "--", ".ai/tasks/TK-1/plan.md"],
    ["git", "--literal-pathspecs", "--no-optional-locks", "-C", ROOT, "status", "--porcelain", "--", ".ai/tasks/TK-1/plan.md"],
  ]);
  assert.deepEqual((await p2({ status: statusOf([init], false) })).lock, { id: "P2", key: "plan.lock", status: "skip", detail: "not locked" });
  assert.deepEqual((await p2({ status: statusOf([init], false) })).calls, [], "no git call for an unlocked plan");
});

test("R2 P2 fails each item of D2: entries, note, plan-review.md, verdict, paths and git", async () => {
  const detail = async (o: Parameters<typeof input>[0], g: Git = {}) => {
    const r = await p2(o, g);
    assert.equal(r.lock?.status, "fail", JSON.stringify(o).slice(0, 80));
    assert.equal(planExitCode(r.report), 1);
    return r.lock?.detail;
  };
  const locked = statusOf([init, LOCK]);
  // D2.2 binding entries.
  assert.equal(await detail({ status: statusOf([init, lockOf("plan reviewed", "human")]) }), "no lock entry");
  assert.equal(await detail({ status: statusOf([init, lockOf("approved", "reviewer")]) }), "no lock entry");
  // D2.3 the note.
  assert.equal(await detail({ status: statusOf([init, lockOf("plan approved by the human")]) }), "lock note names no approved plan-review round and commit");
  assert.equal(await detail({ status: statusOf([init, lockOf("approved; plan review round 2 approved, plan.md at 75fdbd3")]) }), "lock note names no approved plan-review round and commit");
  assert.equal(await detail({ status: statusOf([init, lockOf(`approved; plan review round 2 approved, plan.md at ${C.toUpperCase()}`)]) }), "lock note names no approved plan-review round and commit");
  // D2.4 plan-review.md.
  assert.equal(await detail({ status: locked, review: undefined }), "plan-review.md is missing");
  assert.equal((await p2({ status: locked, review: undefined })).calls.length, 0);
  assert.equal(await detail({ status: locked, review: `# Plan review\n${SKELETON}` }), "plan-review.md has no plan-review round");
  assert.equal(await detail({ status: locked, review: `${round(1, P)}${round(3, C)}` }), "plan-review.md rounds are not numbered 1 to R in order");
  assert.equal(await detail({ status: locked, review: `${round(1, P)}${round(2, C)}${round(3, C)}` }), "the lock note names round 2; the latest plan-review round is 3");
  assert.equal(await detail({ status: locked, review: `${round(1, P)}## Plan review round 2\n\n### Verdict: approved\n` }), "round 2: 0 Plan commit lines");
  assert.equal(await detail({ status: locked, review: `${round(1, P)}${round(2, C)}- Plan commit: ${C}\n` }), "round 2: 2 Plan commit lines");
  assert.equal(await detail({ status: locked, review: `${round(1, P)}${round(2, "75fdbd3")}` }), "round 2: Plan commit is not a 40-hex commit");
  assert.equal(await detail({ status: locked, review: `${round(1, P)}${round(2, P)}` }), "the lock note's commit is not the round's plan commit");
  assert.equal(await detail({ status: locked, review: `${round(1, P)}${round(2, C, "changes_requested")}` }), "round 2: the verdict is not approved");
  assert.equal(await detail({ status: locked, review: `${round(1, P)}${round(2, C)}### Verdict: approved\n` }), "round 2: 2 Verdict lines");
  assert.equal((await p2({ status: locked, review: `${round(1, P)}${round(2, `\`${C}\``)}` })).lock?.status, "pass", "a commit in backticks");
  assert.equal((await p2({ status: locked, review: `${round(1, P)}## Plan review round 2\n\n**Plan commit:** ${C}\n\n\`\`\`\n### Verdict: changes_requested\n\`\`\`\n### Verdict: approved\n` })).lock?.status, "pass", "a bold field; a fenced verdict is ignored");
  // D2.5 paths and git.
  assert.equal(await detail({ status: locked, dirName: "bad id" }), "the task directory name has characters outside [A-Za-z0-9#._-]");
  assert.equal(await detail({ status: locked, planRel: "../elsewhere/plan.md" }), "plan.md is not under --root");
  assert.equal(await detail({ status: locked, planRel: "/abs/plan.md" }), "plan.md is not under --root");
  assert.equal(await detail({ status: locked }, { last: P }), "plan.md changed after the reviewed commit");
  assert.equal(await detail({ status: locked }, { dirty: " M .ai/tasks/TK-1/plan.md\n" }), "plan.md has uncommitted changes");
  // D2.1 status.json itself.
  const broken = await p2({ status: "{" });
  assert.deepEqual(broken.report.checks.map((c) => [c.id, c.status, c.detail]), [["P1", "fail", "not valid JSON"], ["P2", "fail", "not valid JSON"]]);
  const missing = await checkPlan({ ...input({ status: "" }), status: { kind: "missing" } }, ROOT, git({}).run);
  assert.deepEqual(missing.report.checks.map((c) => c.detail), ["status.json is missing", "status.json is missing"]);
  assert.equal(renderPlan(missing.report).split("\n")[0], "pipeline plan (unknown): FAIL");
  const noPlan = await checkPlan({ ...input({ status: statusOf([init], false) }), plan: { kind: "missing" } }, ROOT, git({}).run);
  assert.deepEqual(noPlan.report.checks[0], { id: "P1", key: "plan.criteria", status: "fail", detail: "plan.md is missing" });
});

test("R2 P2 halts on a runner failure (exit 2): log, status and the content comparison", async () => {
  for (const reason of ["exit", "missing", "timeout", "overflow"] as const) {
    for (const sub of ["log", "status"]) {
      const r = await p2({ status: statusOf([init, LOCK]) }, { fail: (a) => (a.includes(sub) ? { kind: "error", reason } : undefined) });
      assert.equal(r.lock?.status, "halt", `${sub} ${reason}`);
      assert.equal(r.halt, reason);
      assert.deepEqual([r.report.outcome, r.report.ok, planExitCode(r.report)], ["halt", false, 2]);
      assert.match(renderPlan(r.report), /^pipeline plan TK-1: HALT\n {2}✔ P1 plan\.criteria\n {2}✖ P2 plan\.lock — halt: git /);
    }
  }
  const covered = decision(T2);
  const st = statusOf([init, LOCK, rebind(P)]);
  const reachTimeout = await p2({ status: statusOf([init, LOCK, rebind(C)]), decisions: decision(T2) }, { last: C });
  assert.equal(reachTimeout.lock?.status, "pass", "no comparison when the re-binding names the same commit");
  const t = await p2({ status: st, decisions: covered }, { last: P, fail: (a) => (a[a.length - 1].endsWith("^{commit}") ? { kind: "error", reason: "timeout" } : undefined) });
  assert.deepEqual([t.lock?.status, t.halt], ["halt", "timeout"]);
  const c = await p2({ status: st, decisions: covered }, { last: P, reachable: C, blobs: { [C]: BLOB } });
  assert.deepEqual([c.lock?.status, c.halt], ["halt", "exit"], "the lookup at the bound commit halts on a non-zero exit");
  const json = JSON.parse(JSON.stringify(t.report));
  assert.deepEqual(Object.keys(json), ["schema", "ticket", "taskDir", "exempt", "outcome", "ok", "checks", "criteria"]);
});

test("R2 P2 binds to the latest binding entry: a covered, attested human re-binding passes; others fail", async () => {
  const status = (e: Entry) => statusOf([init, LOCK, e]);
  const wrongNote = lockOf(`approved; plan review round 2 approved, plan.md at ${"d".repeat(40)}`);
  // A wrong lock note, corrected by a re-binding naming the right commit.
  const fixed = await p2({ status: statusOf([init, wrongNote, rebind(C)]), decisions: decision(T2) });
  assert.equal(fixed.lock?.status, "pass", fixed.lock?.detail);
  assert.equal(fixed.calls.length, 2, "no comparison when the re-binding names the round's commit");
  // A rewritten commit (P → C) with the same plan.md blob: the round still names P.
  const review = `${round(1, "1".repeat(40), "changes_requested")}${round(2, P)}`;
  const rewritten = statusOf([init, lockOf(`approved; plan review round 2 approved, plan.md at ${P}`), rebind(C)]);
  const same = await p2({ status: rewritten, review, decisions: decision(T2) }, { blobs: { [P]: BLOB, [C]: BLOB } });
  assert.equal(same.lock?.status, "pass", same.lock?.detail);
  assert.deepEqual(same.calls.slice(2), [
    ["git", "-C", ROOT, "rev-parse", "--verify", "--quiet", `${P}^{commit}`],
    ["git", "-C", ROOT, "rev-parse", "--verify", "--quiet", `${P}:.ai/tasks/TK-1/plan.md`],
    ["git", "-C", ROOT, "rev-parse", "--verify", "--quiet", `${C}:.ai/tasks/TK-1/plan.md`],
  ]);
  const gone = await p2({ status: rewritten, review, decisions: decision(T2) }, { reachable: "exit" });
  assert.equal(gone.lock?.status, "pass", "an unreachable old commit leaves the attestation alone");
  assert.equal(gone.calls.length, 3);
  // Without a re-binding, the lock note's commit must be the last commit.
  assert.equal((await p2({ status: statusOf([init, wrongNote]) })).lock?.detail, "the lock note's commit is not the round's plan commit");

  const fails = async (o: Parameters<typeof input>[0], g: Git, expected: string) => {
    const r = await p2(o, g);
    assert.deepEqual([r.lock?.status, r.lock?.detail], ["fail", expected]);
  };
  await fails({ status: status(rebind(C, { agent: "coordinator" })), decisions: decision(T2) }, {}, "re-binding entry not by the human");
  await fails({ status: status(rebind(C, { agent: "planner" })), decisions: decision(T2) }, {}, "re-binding entry not by the human");
  await fails({ status: statusOf([init, LOCK, rebind(C, { to: "blocked" })]), decisions: decision(T2) }, {}, "re-binding entry changes state");
  await fails({ status: status(rebind(C)) }, {}, "re-binding entry not covered by decisions.md");
  await fails({ status: status(rebind(C)), decisions: decision(T3) }, {}, "re-binding entry not covered by decisions.md");
  await fails({ status: status(rebind(C)), decisions: decision(T2, "the note named the wrong commit") }, {}, "re-binding not attested as unchanged plan.md");
  await fails({ status: status(rebind(C)), decisions: decision(T2, "plan.md unchanged since plan review round 21") }, {}, "re-binding not attested as unchanged plan.md");
  await fails({ status: rewritten, review, decisions: decision(T2) }, { blobs: { [P]: BLOB, [C]: "e".repeat(40) } }, "re-binding names different plan.md content");
  // L8: the reachable old commit has no plan.md at that path: a fail, not a halt.
  await fails({ status: rewritten, review, decisions: decision(T2) }, { blobs: { [C]: BLOB } }, "re-binding names different plan.md content");
  await fails({ status: rewritten, review, decisions: decision(T2) }, { reachable: "b".repeat(40) }, "re-binding names different plan.md content");
  const unreadable = await checkPlan({ ...input({ status: status(rebind(C)), review: REVIEW }), decisions: { kind: "error", reason: "is a directory" } }, ROOT, git({}).run);
  assert.equal(unreadable.report.checks[1].detail, "decisions.md: is a directory");
});

test("R2 P2 and K6 find the same lock entry", () => {
  const e = (from: string, to: string, agent: string, ts: string, note: string): Entry => ({ from, to, agent, timestamp: ts, note });
  const cases: Entry[][] = [
    [init, e("pending", "pending", "reviewer", T1, "approved"), e("pending", "pending", "planner", T2, "plan locked"), e("pending", "pending", "human", T3, "approved again")],
    [init, e("pending", "pending", "human", T1, "unlockedness"), e("pending", "pending", "human", T2, "approved")],
    [init, e("pending", "in_progress", "human", T1, "approved"), e("in_progress", "in_progress", "human", T2, "locked")],
    [init, e("pending", "pending", "planner", T1, "plan drafted")],
    [init],
  ];
  for (const t of cases) {
    const text = statusOf(t);
    const st = parseStatus(text).status;
    assert.ok(st);
    const mine = lockIndex(st.transitions);
    const report = checkTask({ dirName: "TK-1", absPath: "/repo/TK-1", status: { kind: "ok", text }, plan: { kind: "missing" }, review: { kind: "missing" }, qa: { kind: "missing" } });
    const k6 = report.checks.find((c) => c.id === "K6");
    assert.equal(k6?.detail === "no lock entry", mine === -1, JSON.stringify(t));
    // K18's events are the human entries after K6's lock entry, so they pin its index.
    const after = mine === -1 ? [] : t.slice(mine + 1).filter((x) => x.agent === "human").map((x) => x.timestamp);
    assert.deepEqual(report.facts.decisions.events.map((x) => x.timestamp), after, JSON.stringify(t));
  }
});

test("R2 P2 and K18 read Covers alike", () => {
  const ts = (m: number) => `2026-11-25T00:${String(m).padStart(2, "0")}:00Z`;
  const t: Entry[] = [init, lockOf("approved")];
  for (let m = 2; m <= 12; m++) t.push({ from: "pending", to: "pending", agent: "human", timestamp: ts(m), note: "decision" });
  const fields = (covers: string) => `- Decided by: human\n- Decided: ${ts(13)}\n- Recorded by: coordinator\n${covers}\n- Decision: x\n- Affects: none\n`;
  const decisions = [
    `## D1\n${fields(`- Covers: ${ts(2)}, ${ts(3)} (re-binding, the wrong note)`)}`,
    `## D2\n${fields(`**Covers:** ${ts(4)}`)}`,
    `## D3\n${fields(`Covers: ${ts(5)}\n- Covers: ${ts(6)}`)}`,
    `## Notes\nCovers: ${ts(7)}`,
    "```",
    `## D4\nCovers: ${ts(8)}`,
    "```",
    `## D5\n${fields(`  - Covers: ${ts(9)}`)}`,
    `## D6\n${fields(`- Covers: ${ts(10)} (a (nested) note), ${ts(11)}x`)}`,
    `## D7\n${fields("- Covers: none")}`,
  ].join("\n");
  const text = statusOf(t);
  const report = checkTask({ dirName: "TK-1", absPath: "/repo/TK-1", status: { kind: "ok", text }, plan: { kind: "missing" }, review: { kind: "missing" }, qa: { kind: "missing" }, decisions: { kind: "ok", text: decisions } });
  const k18 = report.checks.find((c) => c.id === "K18")?.detail ?? "";
  const mine = new Set(decisionBlocks(decisions).flatMap((b) => b.covers));
  for (let m = 2; m <= 12; m++) {
    assert.equal(!k18.includes(`${ts(m)} (human)`), mine.has(ts(m)), ts(m));
  }
  assert.deepEqual([...mine].sort(), [ts(2), ts(3), ts(4), ts(5)], "only D1–D3 count, D3 by its first Covers line");
});

test("R2 PRE_GATE_TASKS is the frozen list of the 31 directories locked before the gate", async () => {
  const ids = [
    "BASE-046-C1", "BASE-046-C2", "BASE-046-D1",
    "BASE-071-P1", "BASE-071-P2", "BASE-071-P3", "BASE-071-P4",
    "BASE-072-S1", "BASE-072-S2", "BASE-072-S3",
    "BASE-079-T1", "BASE-079-T2", "BASE-079-T3", "BASE-079-T4", "BASE-079-T5", "BASE-079-T6", "BASE-079-W1",
    "BASE-080-G1",
    "BASE-101-D0", "BASE-101-D1", "BASE-101-D2", "BASE-101-D3", "BASE-101-D4", "BASE-101-D5", "BASE-101-U1", "BASE-101-U2",
    "BASE-103-K1", "BASE-124-A", "BASE-124-B", "BASE-140-A", "BASE-140-C",
  ];
  assert.equal(ids.length, 31);
  assert.deepEqual([...PRE_GATE_TASKS], ids);
  assert.ok(Object.isFrozen(PRE_GATE_TASKS));
  assert.ok(!PRE_GATE_TASKS.includes("BASE-140-B"), "this ticket is checked");

  const old = lockOf("plan approved and locked by the human");
  const exempt = await checkPlan(input({ dirName: "BASE-140-C", status: statusOf([init, old], true, "BASE-140-C"), plan: "# no criteria\n" }), ROOT, git({}).run);
  assert.deepEqual(exempt.report.checks.map((c) => [c.id, c.status, c.detail]), [["P1", "skip", EXEMPT], ["P2", "skip", EXEMPT]]);
  assert.deepEqual([exempt.report.exempt, exempt.report.outcome, planExitCode(exempt.report)], [true, "pass", 0]);
  assert.equal(
    renderPlan(exempt.report),
    "pipeline plan BASE-140-C: PASS\n  - P1 plan.criteria — skipped: exempt (locked before the plan gate)\n  - P2 plan.lock — skipped: exempt (locked before the plan gate)",
  );
  // A listed directory whose ticket_id differs is checked.
  const mismatch = await checkPlan(input({ dirName: "BASE-140-C", status: statusOf([init, old], true, "BASE-999-X"), plan: "# no criteria\n" }), ROOT, git({}).run);
  assert.equal(mismatch.report.exempt, false);
  assert.equal(mismatch.report.outcome, "fail");
  // A new directory back-dated before the gate is still checked (H13).
  const backDated = [
    { ...init, timestamp: "2026-01-01T00:00:00Z" },
    { ...old, timestamp: "2026-01-01T00:01:00Z" },
  ];
  const checked = await checkPlan(input({ dirName: "BASE-999-Z", status: statusOf(backDated, true, "BASE-999-Z"), plan: "# no criteria\n" }), ROOT, git({}).run);
  assert.equal(checked.report.exempt, false);
  assert.deepEqual(checked.report.checks.map((c) => [c.id, c.status]), [["P1", "fail"], ["P2", "fail"]]);
  assert.equal(renderPlan(checked.report).split("\n")[0], "pipeline plan BASE-999-Z: FAIL");
  const quoted = await checkPlan(input({ dirName: "bad id", status: statusOf([init], false, "bad id") }), ROOT, git({}).run);
  assert.equal(renderPlan(quoted.report).split("\n")[0], 'pipeline plan "bad id": PASS');
});
