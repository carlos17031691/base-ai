/**
 * `base-ai pipeline plan <task-dir>` (BASE-140-B, issue #140 R2): two read-only checks of a plan.
 *
 * - P1 `plan.criteria`: every acceptance criterion names at least one command QA may run (the "Commands" of
 *   `.claude/agents/qa.md`), and none that needs network, credentials, a merged state or a remote run
 *   (`planner.md` Step 3).
 * - P2 `plan.lock`: the latest binding lock entry names the latest plan-review round, that round is `approved`, and
 *   its plan commit is the last commit of an unchanged `plan.md`. A later human re-binding entry may name a
 *   rewritten commit of the same `plan.md` content only (H14).
 *
 * P1 is pure. P2 runs git through the injected `Runner` (pipeline-gh.ts is the real one), argv only, with fixed
 * call forms. Nothing here writes. The output holds only fixed reasons, check ids, counts and line numbers, never
 * plan, note or report text.
 *
 * The CLI that judges a PR is built from that PR, so a change to this file, to `PRE_GATE_TASKS` or to the
 * vocabulary below is a change to the rule and is reviewed as one (L5).
 */
import { isAbsolute } from "node:path";
import { fenceMask, maskCodeSpans, parseStatus, type FileRead } from "./pipeline-check.js";
import type { RunFailure, Runner } from "./pipeline-registration.js";

export const PLAN_USAGE = "usage: base-ai pipeline plan <task-dir> [--json] [--root <dir>]";

/**
 * The task directories locked before the plan gate (H13). Frozen: it is never extended, so a directory created
 * after the gate cannot be exempted by back-dating its timestamps; adding an id is a code change to the rule.
 */
export const PRE_GATE_TASKS: readonly string[] = Object.freeze([
  "BASE-046-C1",
  "BASE-046-C2",
  "BASE-046-D1",
  "BASE-071-P1",
  "BASE-071-P2",
  "BASE-071-P3",
  "BASE-071-P4",
  "BASE-072-S1",
  "BASE-072-S2",
  "BASE-072-S3",
  "BASE-079-T1",
  "BASE-079-T2",
  "BASE-079-T3",
  "BASE-079-T4",
  "BASE-079-T5",
  "BASE-079-T6",
  "BASE-079-W1",
  "BASE-080-G1",
  "BASE-101-D0",
  "BASE-101-D1",
  "BASE-101-D2",
  "BASE-101-D3",
  "BASE-101-D4",
  "BASE-101-D5",
  "BASE-101-U1",
  "BASE-101-U2",
  "BASE-103-K1",
  "BASE-124-A",
  "BASE-124-B",
  "BASE-140-A",
  "BASE-140-C",
]);

export const EXEMPT = "exempt (locked before the plan gate)";
export const MAX_PRINTED_CRITERIA = 50;

/** The fixed P1 reasons. A criterion problem is always one of these. */
export const REASON = {
  disallowed: "not in the Commands of qa.md",
  network: "needs network",
  credentials: "needs credentials or the environment",
  merged: "needs a merged state or a remote run",
  noCommand: "no command QA can run",
  operator: "pipe, chain or redirect",
  unparsable: "unparsable command",
  empty: "empty criterion",
} as const;
export type Reason = (typeof REASON)[keyof typeof REASON];

/** The task files `pipeline plan` reads (pipeline-files.ts `loadPlanTask`). */
export interface PlanTaskInput {
  dirName: string;
  absPath: string;
  /** `plan.md` relative to the root, with `/` separators. */
  planRel: string;
  status: FileRead;
  plan: FileRead;
  planReview: FileRead;
  decisions: FileRead;
}

export type PlanCheckStatus = "pass" | "fail" | "skip" | "halt";
export interface PlanCheck {
  id: "P1" | "P2";
  key: "plan.criteria" | "plan.lock";
  status: PlanCheckStatus;
  detail: string;
}
export interface CriterionProblem {
  /** 1-based number of the criterion in the section. */
  criterion: number;
  /** 1-based line of plan.md. */
  line: number;
  reason: Reason;
}
export interface PlanReport {
  schema: 1;
  ticket: string | null;
  taskDir: string;
  exempt: boolean;
  outcome: "pass" | "fail" | "halt";
  ok: boolean;
  checks: PlanCheck[];
  criteria: CriterionProblem[];
}
/** The report, plus the runner failure behind a halt (for `pipeline ci`; not part of the JSON output). */
export interface PlanResult {
  report: PlanReport;
  halt?: RunFailure;
}

type Status = NonNullable<ReturnType<typeof parseStatus>["status"]>;
type Transition = Status["transitions"][number];

const DIR_ID = /^[A-Za-z0-9#._-]+$/;
const SHA = /^[0-9a-f]{40}$/;
const MASK = "\u0001";

// ── Shared readers ───────────────────────────────────────────────────────────────────────────────────────────

/** Replaces every closed HTML comment with blanks, keeping newlines (and so line numbers). Linear on any input. */
export function blankComments(text: string): string {
  let out = "";
  let from = 0;
  for (;;) {
    const open = text.indexOf("<!--", from);
    const close = open === -1 ? -1 : text.indexOf("-->", open + 4);
    if (close === -1) return out + text.slice(from);
    out += text.slice(from, open) + text.slice(open, close + 3).replace(/[^\n]/g, " ");
    from = close + 3;
  }
}

const fileProblem = (f: FileRead, name: string) =>
  f.kind === "missing" ? `${name} is missing` : f.kind === "error" ? `${name}: ${f.reason}` : "";

// ── P1 plan.criteria ─────────────────────────────────────────────────────────────────────────────────────────

const GIT_READ = new Set(["status", "diff", "log", "show", "merge-base", "ls-files", "rev-parse", "check-ignore", "hash-object"]);
const GIT_NETWORK = new Set(["fetch", "pull", "push", "clone", "ls-remote", "remote", "submodule"]);
const FIND_FORBIDDEN = new Set(["-exec", "-execdir", "-ok", "-okdir", "-delete", "-fprint", "-fprint0", "-fprintf", "-fls"]);
const SCRIPT = /^(test|lint|typecheck|type-check|coverage|build)(:[A-Za-z0-9_-]+)?$/;
const DATE_FORM = "+%Y-%m-%dT%H:%M:%SZ";

/** Heads with an allowed form (D1.5). */
const ALLOWED_HEADS = new Set(["git", "ls", "grep", "find", "wc", "diff", "cmp", "date", "npm", "make", "node"]);
/** Heads that always fail (D1.6), with their reason. */
const FAILING_HEADS = new Map<string, Reason>([
  ...["curl", "wget", "nc", "ping"].map((h) => [h, REASON.network] as const),
  ...["gh", "gcloud", "aws", "az", "kubectl", "docker", "terraform", "tofu", "ssh", "scp", "rsync"].map((h) => [h, REASON.credentials] as const),
  ...[
    "base-ai", "npx", "sudo", "yarn", "pnpm", "pip", "pip3", "python", "python3", "cat", "head", "tail", "sed", "awk", "jq",
    "echo", "printf", "cd", "rm", "mv", "cp", "mkdir", "touch", "chmod", "tee", "sh", "bash", "zsh", "env", "export",
    "xargs", "sort", "uniq", "cut", "timeout",
  ].map((h) => [h, REASON.disallowed] as const),
]);

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const PATH_PREFIX = /^PATH=.+:\$PATH$/;
// Whole-word merged-state wording (H6), matched on prose with code spans masked.
const MERGED_ANY_CASE = /\b(?:post-merge|merged|after (?:the )?merge|after (?:the )?release|released|new session|CodeRabbit|Sonar\w*|GitHub Actions)\b/i;
const MERGED_CASED = /\bCI\b/;

interface Word {
  text: string;
  /** Variables referenced outside single quotes (`$NAME`, or `{` for `${`). */
  env: string[];
}

const isNameStart = (c: string | undefined) => c !== undefined && /[A-Za-z0-9_]/.test(c);

/** End offset of a `<name>` placeholder starting at `i`, or -1. Stops at the first character outside the name. */
function placeholderEnd(s: string, i: number): number {
  let j = i + 1;
  if (!/[A-Za-z0-9]/.test(s[j] ?? "")) return -1;
  while (/[A-Za-z0-9_.-]/.test(s[j] ?? "")) j++;
  return s[j] === ">" ? j + 1 : -1;
}

/** A `$` at `i`: a command substitution, a variable name (or `{`), or a literal dollar (null). */
function dollarAt(s: string, i: number): { subst: true } | { name: string; end: number } | null {
  const next = s[i + 1];
  if (next === "(") return { subst: true };
  if (next === "{") return { name: "{", end: i + 2 };
  if (!isNameStart(next)) return null;
  let j = i + 1;
  while (isNameStart(s[j])) j++;
  return { name: s.slice(i + 1, j), end: j };
}

/**
 * Splits a command like a shell, with no expansion (D1.4): unquoted blanks separate words, single quotes are
 * literal, and inside double quotes `\` escapes `"`, `\`, `$` and the backtick. `<name>` stays literal. One pass.
 */
export function tokenize(s: string): { words: Word[] } | { error: Reason } {
  const words: Word[] = [];
  let cur: Word | null = null;
  const word = (): Word => (cur ??= { text: "", env: [] });
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch === " " || ch === "\t") {
      if (cur) words.push(cur);
      cur = null;
      i++;
    } else if (ch === "'") {
      const close = s.indexOf("'", i + 1);
      if (close === -1) return { error: REASON.unparsable };
      word().text += s.slice(i + 1, close);
      i = close + 1;
    } else if (ch === '"') {
      const w = word();
      i++;
      for (;;) {
        if (i >= s.length) return { error: REASON.unparsable };
        const c = s[i];
        if (c === '"') {
          i++;
          break;
        }
        if (c === "\\" && '"\\$`'.includes(s[i + 1] ?? "x")) {
          w.text += s[i + 1];
          i += 2;
          continue;
        }
        // Still a substitution inside double quotes, so it is refused like the unquoted form.
        if (c === "`") return { error: REASON.operator };
        if (c === "$") {
          const d = dollarAt(s, i);
          if (d && "subst" in d) return { error: REASON.operator };
          if (d) w.env.push(d.name);
        }
        w.text += c;
        i++;
      }
    } else if (ch === "\\") {
      if (i + 1 >= s.length) return { error: REASON.unparsable };
      word().text += s[i + 1];
      i += 2;
    } else if ("|&;>()`".includes(ch)) {
      return { error: REASON.operator };
    } else if (ch === "<") {
      const end = placeholderEnd(s, i);
      if (end === -1) return { error: REASON.operator };
      word().text += s.slice(i, end);
      i = end;
    } else {
      if (ch === "$") {
        const d = dollarAt(s, i);
        if (d && "subst" in d) return { error: REASON.operator };
        if (d) word().env.push(d.name);
      }
      word().text += ch;
      i++;
    }
  }
  if (cur) words.push(cur);
  return { words };
}

/** The allowed forms of D1.5; null when the words (head first, prefix removed) are one of them. */
function formProblem(w: string[]): Reason | null {
  switch (w[0]) {
    case "git": {
      let k = 1;
      while (k < w.length) {
        if (w[k] === "-C" && k + 1 < w.length) k += 2;
        else if (w[k] === "--no-optional-locks") k++;
        else break;
      }
      const sub = w[k];
      const rest = w.slice(k + 1);
      if (sub !== undefined && GIT_NETWORK.has(sub)) return REASON.network;
      if (sub === undefined || !GIT_READ.has(sub)) return REASON.disallowed;
      if (rest.some((a) => a === "--output" || a.startsWith("--output="))) return REASON.disallowed;
      if (sub === "hash-object" && rest.some((a) => /^-[A-Za-z]*w/.test(a))) return REASON.disallowed;
      if ((sub === "diff" || sub === "log" || sub === "show") && rest.some((a) => a === "--ext-diff" || a === "--textconv")) {
        return REASON.disallowed;
      }
      if (sub === "merge-base" && rest.includes("--is-ancestor")) return REASON.merged;
      return null;
    }
    case "ls":
    case "grep":
    case "wc":
    case "diff":
    case "cmp":
      return null;
    case "find":
      return w.some((a) => FIND_FORBIDDEN.has(a)) ? REASON.disallowed : null;
    case "date":
      return w.length === 3 && w[1] === "-u" && w[2] === DATE_FORM ? null : REASON.disallowed;
    case "npm":
      return w.length >= 5 && w[1] === "--prefix" && w[3] === "run" && SCRIPT.test(w[4]) ? null : REASON.disallowed;
    case "make": {
      const target = w[1] === "-C" ? (w.length === 4 ? w[3] : undefined) : w.length === 2 ? w[1] : undefined;
      return target !== undefined && SCRIPT.test(target) ? null : REASON.disallowed;
    }
    case "node":
      if (w[1] === "--test" && w.slice(2).every((a) => !a.startsWith("-"))) return null;
      if (w.length >= 4 && w[1].endsWith("/index.js") && w[2] === "pipeline" && (w[3] === "check" || w[3] === "plan")) return null;
      return REASON.disallowed;
    default:
      return REASON.disallowed;
  }
}

const SECRET_SEGMENT = (seg: string) =>
  seg === ".env" || seg.startsWith(".env.") || seg.endsWith(".pem") || seg.endsWith(".key") || /^id_(?:rsa|ed25519|ecdsa)/.test(seg);

function wordProblem(w: Word): Reason | null {
  if (w.text.includes("://")) return REASON.network;
  const last = w.text.slice(w.text.lastIndexOf("/") + 1);
  const value = last.slice(last.lastIndexOf("=") + 1);
  if (SECRET_SEGMENT(last) || SECRET_SEGMENT(value)) return REASON.credentials;
  return null;
}

export type Judgement = { kind: "literal" } | { kind: "command" } | { kind: "fail"; reason: Reason };

/**
 * Judges one candidate (a code span or a fenced line). Its head is read leniently first: a head outside the
 * vocabulary makes it a literal, to which no other rule applies (H5, M4).
 */
export function judgeCandidate(candidate: string): Judgement {
  const raw = candidate.trim().split(/[ \t]+/);
  let h = 0;
  while (h < raw.length && ASSIGNMENT.test(raw[h])) h++;
  const head = raw[h];
  const known = (w: string | undefined) => w !== undefined && (ALLOWED_HEADS.has(w) || FAILING_HEADS.has(w));
  if (head === undefined) return { kind: "literal" };

  const t = tokenize(candidate.trim());
  if (!known(head)) {
    // A prefix value with a quoted blank or a substitution splits wrongly on blanks and would hide a known
    // head (`TOKEN="a b" gh …`, `TOKEN=$(cat f) gh …`; review r1 L1). With a prefix, re-read the head from
    // the tokenized words; a prefix that does not tokenize is a command with a substitution, not a literal.
    if (h === 0) return { kind: "literal" };
    if ("error" in t) return { kind: "fail", reason: t.error };
    if (!known(t.words.find((w) => !ASSIGNMENT.test(w.text))?.text)) return { kind: "literal" };
  }
  if ("error" in t) return { kind: "fail", reason: t.error };
  let k = 0;
  for (; k < t.words.length && ASSIGNMENT.test(t.words[k].text); k++) {
    const p = t.words[k];
    const pathOnly = PATH_PREFIX.test(p.text) && p.env.length === 1 && p.env[0] === "PATH";
    if (!pathOnly) return { kind: "fail", reason: REASON.credentials };
  }
  const words = t.words.slice(k);
  const failing = FAILING_HEADS.get(words[0]?.text ?? "");
  if (failing) return { kind: "fail", reason: failing };
  if (words.some((w) => w.env.length > 0)) return { kind: "fail", reason: REASON.credentials };
  for (const w of words) {
    const p = wordProblem(w);
    if (p) return { kind: "fail", reason: p };
  }
  const form = formProblem(words.map((w) => w.text));
  return form ? { kind: "fail", reason: form } : { kind: "command" };
}

/** The inline code spans of one line, by the delimiting of `maskCodeSpans`, with CommonMark's one-space strip. */
export function codeSpans(line: string): string[] {
  const clean = line.replaceAll(MASK, " ");
  const masked = maskCodeSpans(clean);
  const spans: string[] = [];
  let i = 0;
  while (i < masked.length) {
    if (masked[i] !== MASK) {
      i++;
      continue;
    }
    let j = i;
    while (masked[j] === MASK) j++;
    let n = 0;
    while (clean[i + n] === "`") n++;
    let content = clean.slice(i + n, j - n);
    if (content.length >= 2 && content.startsWith(" ") && content.endsWith(" ") && content.trim() !== "") content = content.slice(1, -1);
    spans.push(content);
    i = j;
  }
  return spans;
}

interface Criterion {
  /** 0-based line indexes, end exclusive. */
  start: number;
  end: number;
}

const CRITERION = /^- \[[ x]\](?: |$)/;

/** The criteria of the first `## Acceptance criteria` section outside code fences (D1.2). */
function criteriaOf(lines: string[], inFence: boolean[]): Criterion[] {
  const start = lines.findIndex((l, i) => !inFence[i] && /^## Acceptance criteria\b/.test(l));
  if (start === -1) return [];
  let end = start + 1;
  while (end < lines.length && (inFence[end] || !lines[end].startsWith("## "))) end++;
  const items: Criterion[] = [];
  for (let i = start + 1; i < end; i++) {
    if (inFence[i] || !CRITERION.test(lines[i])) continue;
    if (items.length) items[items.length - 1].end = i;
    items.push({ start: i, end });
  }
  return items;
}

/** The problems of one criterion, at most one per reason (the first line it occurs on). */
function criterionProblems(lines: string[], inFence: boolean[], c: Criterion): { line: number; reason: Reason }[] {
  const body = [lines[c.start].replace(CRITERION, ""), ...lines.slice(c.start + 1, c.end)];
  if (body.every((l) => l.trim() === "")) return [{ line: c.start + 1, reason: REASON.empty }];

  const problems = new Map<Reason, number>();
  const add = (reason: Reason, i: number) => {
    if (!problems.has(reason)) problems.set(reason, i + 1);
  };
  let commands = 0;
  const prose: string[] = [];
  for (let i = c.start; i < c.end; i++) {
    const line = lines[i];
    let candidates: string[];
    if (inFence[i]) {
      candidates = line.trim().startsWith("```") || line.trim() === "" ? [] : [line.trim()];
    } else {
      candidates = codeSpans(line);
      const masked = maskCodeSpans(line);
      prose.push(masked);
      if (MERGED_ANY_CASE.test(masked) || MERGED_CASED.test(masked)) add(REASON.merged, i);
    }
    for (const candidate of candidates) {
      const j = judgeCandidate(candidate);
      if (j.kind === "command") commands++;
      else if (j.kind === "fail") add(j.reason, i);
    }
  }
  // Wording split across lines ("after the" / "merge").
  const joined = prose.join(" ").replace(/\s+/g, " ");
  if (MERGED_ANY_CASE.test(joined) || MERGED_CASED.test(joined)) add(REASON.merged, c.start);
  if (commands === 0) add(REASON.noCommand, c.start);
  return [...problems].map(([reason, line]) => ({ line, reason })).sort((a, b) => a.line - b.line);
}

/** P1 on the text of plan.md. */
export function checkCriteria(planText: string): { check: PlanCheck; criteria: CriterionProblem[] } {
  const { lines, inFence } = fenceMask(blankComments(planText));
  const items = criteriaOf(lines, inFence);
  const P1 = (status: PlanCheckStatus, detail: string): PlanCheck => ({ id: "P1", key: "plan.criteria", status, detail });
  if (items.length === 0) return { check: P1("fail", "no criteria"), criteria: [] };
  const criteria: CriterionProblem[] = [];
  let failing = 0;
  items.forEach((c, k) => {
    const problems = criterionProblems(lines, inFence, c);
    if (problems.length) failing++;
    for (const p of problems) criteria.push({ criterion: k + 1, ...p });
  });
  return {
    check: failing ? P1("fail", `${failing} of ${items.length} criteria fail`) : P1("pass", ""),
    criteria,
  };
}

// ── P2 plan.lock ─────────────────────────────────────────────────────────────────────────────────────────────

/** The K6 lock entry (pipeline-check.ts, the `lock` predicate): kept as one line, pinned by a test to K6. */
export const lockIndex = (t: Transition[]) =>
  t.findIndex((e) => e.from === "pending" && e.to === "pending" && (e.agent === "planner" || e.agent === "human") && /\b(approved|locked)\b/.test(e.note));

const CLAUSE = /plan review round ([1-9]\d*) approved, plan\.md at ([0-9a-f]{40})(?![0-9A-Za-z])/;

// decisions.md with the K17 grammar (pipeline-check.ts `parseDecisions`, `coveredBy`): pinned by a test to K18.
const TS_IN_TEXT = "\\d{4}-\\d\\d-\\d\\dT\\d\\d:\\d\\d:\\d\\dZ";
const DECISION_LABELS = ["Decided by", "Decided", "Recorded by", "Covers", "Decision", "Affects"];
const LABEL_ALT = DECISION_LABELS.join("|");
const FIELD_LINE = new RegExp(`^(?:[-*] )?(?:\\*\\*(${LABEL_ALT}):\\*\\*|(${LABEL_ALT}):)(.*)$`);
const COVERS_ITEM = new RegExp(`^(${TS_IN_TEXT})(?:\\s*\\([^()]*\\))?$`);

export interface DecisionBlock {
  id: string;
  /** The timestamps its first `Covers:` value counts. */
  covers: string[];
  /** Its first `Decision:` value. */
  decision: string;
}

function coversItems(value: string): string[] {
  const items: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < value.length; i++) {
    if (value[i] === "(") depth++;
    else if (value[i] === ")") depth = Math.max(0, depth - 1);
    else if (value[i] === "," && depth === 0) {
      items.push(value.slice(start, i).trim());
      start = i + 1;
    }
  }
  items.push(value.slice(start).trim());
  return items;
}

/** The `## D<n>` blocks of decisions.md; fenced lines are ignored and another `## ` heading ends a block. */
export function decisionBlocks(text: string): DecisionBlock[] {
  const { lines, inFence } = fenceMask(text);
  const blocks: { id: string; fields: Map<string, string[]> }[] = [];
  let current: (typeof blocks)[number] | undefined;
  lines.forEach((line, i) => {
    if (inFence[i]) return;
    if (line.startsWith("## ")) {
      const m = /^## D([1-9]\d*)\s*$/.exec(line);
      current = m ? { id: `D${m[1]}`, fields: new Map() } : undefined;
      if (current) blocks.push(current);
      return;
    }
    const f = current ? FIELD_LINE.exec(line) : null;
    if (current && f) {
      const label = f[1] ?? f[2];
      current.fields.set(label, [...(current.fields.get(label) ?? []), f[3].trim()]);
    }
  });
  return blocks.map((b) => {
    const value = b.fields.get("Covers")?.[0] ?? "";
    const covers =
      value === "none"
        ? []
        : coversItems(value).flatMap((item) => {
            const m = COVERS_ITEM.exec(item);
            return m ? [m[1]] : [];
          });
    return { id: b.id, covers, decision: b.fields.get("Decision")?.[0] ?? "" };
  });
}

interface ReviewRound {
  commit: string;
}

/** The latest round of plan-review.md, or the problem (D2.4). Numbers and fixed words only. */
function latestRound(text: string, n: number): { round: ReviewRound; r: number } | { problem: string } {
  const { lines, inFence } = fenceMask(blankComments(text));
  const headings: { i: number; n: number }[] = [];
  lines.forEach((l, i) => {
    const m = inFence[i] ? null : /^## Plan review round (\d+)(?!\d)/.exec(l);
    if (m) headings.push({ i, n: Number(m[1]) });
  });
  if (headings.length === 0) return { problem: "plan-review.md has no plan-review round" };
  if (headings.some((h, k) => h.n !== k + 1)) return { problem: "plan-review.md rounds are not numbered 1 to R in order" };
  const r = headings.length;
  if (n !== r) return { problem: `the lock note names round ${n}; the latest plan-review round is ${r}` };
  const body = lines.slice(headings[r - 1].i + 1).filter((_, k) => !inFence[headings[r - 1].i + 1 + k]);
  const commitLines = body.filter((l) => /^(?:[-*] )?(?:\*\*Plan commit:\*\*|Plan commit:)/.test(l));
  if (commitLines.length !== 1) return { problem: `round ${r}: ${commitLines.length} Plan commit lines` };
  const m = /^(?:[-*] )?(?:\*\*Plan commit:\*\*|Plan commit:)\s*(`?)([0-9A-Fa-f]{40})\1\s*$/.exec(commitLines[0]);
  if (!m) return { problem: `round ${r}: Plan commit is not a 40-hex commit` };
  const verdicts = body.filter((l) => l.startsWith("### Verdict:"));
  if (verdicts.length !== 1) return { problem: `round ${r}: ${verdicts.length} Verdict lines` };
  const word = /^[a-z_]+/.exec(verdicts[0].slice("### Verdict:".length).trim())?.[0];
  if (word !== "approved") return { problem: `round ${r}: the verdict is not approved` };
  return { round: { commit: m[2].toLowerCase() }, r };
}

class Halt extends Error {
  constructor(readonly reason: RunFailure) {
    super(reason);
  }
}

export const HALT_TEXT: Record<RunFailure, string> = {
  missing: "command not found",
  exit: "non-zero exit",
  timeout: "timed out",
  overflow: "output over the cap",
};

type LockOutcome = { status: "pass" | "fail" | "skip"; detail: string } | { status: "halt"; reason: RunFailure };

async function checkLock(st: Status, input: PlanTaskInput, root: string, run: Runner): Promise<LockOutcome> {
  const fail = (detail: string): LockOutcome => ({ status: "fail", detail });
  if (!st.plan_locked) return { status: "skip", detail: "not locked" };
  const t = st.transitions;
  const lock = lockIndex(t);
  if (lock === -1) return fail("no lock entry");

  // Binding entries (H14): the lock entry, then any later entry whose note carries the plan-review clause.
  const rebinding = t.flatMap((e, i) => (i > lock && CLAUSE.test(e.note) ? [i] : []));
  let blocks: DecisionBlock[] = [];
  if (rebinding.length) {
    if (input.decisions.kind === "error") return fail(fileProblem(input.decisions, "decisions.md"));
    if (input.decisions.kind === "ok") blocks = decisionBlocks(input.decisions.text);
  }
  const covering = (e: Transition) => blocks.filter((b) => b.covers.includes(e.timestamp));
  for (const i of rebinding) {
    if (t[i].agent !== "human") return fail("re-binding entry not by the human");
    if (t[i].from !== t[i].to) return fail("re-binding entry changes state");
    if (covering(t[i]).length === 0) return fail("re-binding entry not covered by decisions.md");
  }
  const bound = rebinding.length ? rebinding[rebinding.length - 1] : lock;
  const clause = CLAUSE.exec(t[bound].note);
  if (!clause) return fail("lock note names no approved plan-review round and commit");
  const c = clause[2];

  if (input.planReview.kind !== "ok") return fail(fileProblem(input.planReview, "plan-review.md"));
  const latest = latestRound(input.planReview.text, Number(clause[1]));
  if ("problem" in latest) return fail(latest.problem);
  const p = latest.round.commit;
  const rebound = bound !== lock;
  if (!rebound && p !== c) return fail("the lock note's commit is not the round's plan commit");
  if (rebound) {
    const attest = new RegExp(`plan\\.md unchanged since plan review round ${latest.r}(?!\\d)`);
    for (const i of rebinding) {
      if (!covering(t[i]).some((b) => attest.test(b.decision))) return fail("re-binding not attested as unchanged plan.md");
    }
  }

  if (!DIR_ID.test(input.dirName) || input.dirName === "." || input.dirName === "..") {
    return fail("the task directory name has characters outside [A-Za-z0-9#._-]");
  }
  const rel = input.planRel;
  if (rel === "" || isAbsolute(rel) || rel === ".." || rel.startsWith("../")) return fail("plan.md is not under --root");
  // Both commits are 40 lowercase hex here (CLAUSE, latestRound), so they reach git only as revisions.
  if (!SHA.test(c) || !SHA.test(p)) return fail("lock note names no approved plan-review round and commit");

  const git = async (args: string[], allowExit = false): Promise<string | null> => {
    const r = await run("git", args);
    if (r.kind === "ok") return r.stdout;
    if (allowExit && r.reason === "exit") return null;
    throw new Halt(r.reason);
  };
  try {
    const last = await git(["--literal-pathspecs", "-C", root, "log", "-1", "--format=%H", "--", rel]);
    if ((last ?? "").trim() !== c) return fail("plan.md changed after the reviewed commit");
    const dirty = await git(["--literal-pathspecs", "--no-optional-locks", "-C", root, "status", "--porcelain", "--", rel]);
    if ((dirty ?? "").trim() !== "") return fail("plan.md has uncommitted changes");
    if (rebound && p !== c) {
      const reachable = await git(["-C", root, "rev-parse", "--verify", "--quiet", `${p}^{commit}`], true);
      // An unreachable old commit (rebased away, or not fetched) cannot be compared: the attestation stands alone.
      if (reachable === null) return { status: "pass", detail: "" };
      if (reachable.trim() !== p) return fail("re-binding names different plan.md content");
      const before = await git(["-C", root, "rev-parse", "--verify", "--quiet", `${p}:${rel}`], true);
      if (before === null) return fail("re-binding names different plan.md content");
      const after = await git(["-C", root, "rev-parse", "--verify", "--quiet", `${c}:${rel}`]);
      if ((after ?? "").trim() !== before.trim()) return fail("re-binding names different plan.md content");
    }
  } catch (e) {
    if (!(e instanceof Halt)) throw e;
    return { status: "halt", reason: e.reason };
  }
  return { status: "pass", detail: "" };
}

// ── The command ──────────────────────────────────────────────────────────────────────────────────────────────

/** Runs P1 and P2 on one task directory. Never throws on malformed input. */
export async function checkPlan(input: PlanTaskInput, root: string, run: Runner): Promise<PlanResult> {
  const report: PlanReport = { schema: 1, ticket: null, taskDir: input.absPath, exempt: false, outcome: "pass", ok: true, checks: [], criteria: [] };
  const both = (status: PlanCheckStatus, detail: string) => {
    report.checks = [
      { id: "P1", key: "plan.criteria", status, detail },
      { id: "P2", key: "plan.lock", status, detail },
    ];
  };
  let halt: RunFailure | undefined;
  const parsed = input.status.kind === "ok" ? parseStatus(input.status.text) : { problem: fileProblem(input.status, "status.json") };
  const st = parsed.status;
  if (!st) both("fail", parsed.problem ?? "status.json is not valid");
  else {
    report.ticket = st.ticket_id;
    if (PRE_GATE_TASKS.includes(input.dirName) && st.ticket_id === input.dirName) {
      report.exempt = true;
      both("skip", EXEMPT);
    } else {
      if (input.plan.kind === "ok") {
        const p1 = checkCriteria(input.plan.text);
        report.checks.push(p1.check);
        report.criteria = p1.criteria;
      } else report.checks.push({ id: "P1", key: "plan.criteria", status: "fail", detail: fileProblem(input.plan, "plan.md") });
      const p2 = await checkLock(st, input, root, run);
      if (p2.status === "halt") {
        halt = p2.reason;
        report.checks.push({ id: "P2", key: "plan.lock", status: "halt", detail: `git ${HALT_TEXT[p2.reason]}` });
      } else report.checks.push({ id: "P2", key: "plan.lock", ...p2 });
    }
  }
  const statuses = report.checks.map((c) => c.status);
  report.outcome = statuses.includes("halt") ? "halt" : statuses.includes("fail") ? "fail" : "pass";
  report.ok = report.outcome === "pass";
  return halt ? { report, halt } : { report };
}

export function planExitCode(r: PlanReport): 0 | 1 | 2 {
  return r.outcome === "halt" ? 2 : r.outcome === "fail" ? 1 : 0;
}

/** Plain-text rendering: check ids, fixed reasons, counts and line numbers only. */
export function renderPlan(r: PlanReport): string {
  const ticket = r.ticket === null ? "(unknown)" : DIR_ID.test(r.ticket) ? r.ticket : JSON.stringify(r.ticket);
  const out = [`pipeline plan ${ticket}: ${r.outcome.toUpperCase()}`];
  for (const c of r.checks) {
    if (c.status === "pass") out.push(`  ✔ ${c.id} ${c.key}`);
    else if (c.status === "fail") out.push(`  ✖ ${c.id} ${c.key} — ${c.detail}`);
    else if (c.status === "halt") out.push(`  ✖ ${c.id} ${c.key} — halt: ${c.detail}`);
    else out.push(`  - ${c.id} ${c.key} — skipped: ${c.detail}`);
  }
  for (const p of r.criteria.slice(0, MAX_PRINTED_CRITERIA)) out.push(`  criterion ${p.criterion} (plan.md:${p.line}): ${p.reason}`);
  if (r.criteria.length > MAX_PRINTED_CRITERIA) out.push(`  … ${r.criteria.length - MAX_PRINTED_CRITERIA} more`);
  return out.join("\n");
}
