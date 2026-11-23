/**
 * Deterministic verification of a pipeline task directory (BASE-071-P1, issue #71).
 *
 * Pure domain logic: it receives the raw contents of the task files and computes the
 * mechanical facts the supervisor otherwise re-derives in prose (supervisor.md C1–C4,
 * C6–C13, the C15 decisions.md coverage (BASE-071-P2), the C16 marker count and the C19
 * form of the latest review round's Security section (BASE-124-B)).
 * No I/O here; see pipeline-files.ts.
 */

export const RULE = "supervisor.md@682c6e4";
export const MAX_FILE_BYTES = 2 * 1024 * 1024;

/** A task file as read by the I/O layer, which never throws. */
export type FileRead =
  | { kind: "ok"; text: string }
  | { kind: "missing" }
  | { kind: "error"; reason: string };

export interface TaskInput {
  /** Name of the task directory (its last path segment). */
  dirName: string;
  /** Absolute path of the task directory. */
  absPath: string;
  status: FileRead;
  plan: FileRead;
  review: FileRead;
  qa: FileRead;
  /** decisions.md; absent when not given. */
  decisions?: FileRead;
}

export type CheckStatus = "pass" | "fail" | "skip";

export interface CheckResult {
  id: string;
  key: string;
  source: string;
  status: CheckStatus;
  detail: string;
}

export interface RegistrationKey {
  key: string;
  file: string;
  line: number;
}

export type DecisionEventKind = "human" | "unblock" | "reentry";

export interface DecisionFacts {
  present: boolean;
  blocks: number;
  /** Post-lock events that a decision must cover (supervisor.md C15). */
  events: { timestamp: string; kind: DecisionEventKind }[];
  /** Blocks that cover at least one event. */
  covering: string[];
  /** Steering acknowledgement blocks, on structure only (no C17 judgement). */
  acknowledging: string[];
}

export type NextRole = "planner" | "implementer" | "reviewer" | "qa" | "supervisor" | "human" | "none";
/** Who acts next (BASE-101-D0), mirroring the "Who acts next" table of `.ai/skills/pipeline/skill.md`. */
export interface NextActor {
  role: NextRole;
  /** Present only for reviewer and qa. */
  round?: number;
  /** A fixed template filled with check ids, numbers and state names only. */
  reason: string;
}

export interface NextActorInput {
  checks: CheckResult[];
  state: string | null;
  planLocked: boolean;
  /** All reviewer entries, and QA entries after the latest reset, as counted for K9 and K13. */
  reviewEntries: number;
  qaEntries: number;
  resetExists: boolean;
  ownTicket: boolean;
  keys: number;
}

export interface TaskFacts {
  state: string | null;
  latestCompletion: string | null;
  review: { rounds: number; verdict: string | null; entry: string | null };
  qa: { rounds: number; verdict: string | null; entry: string | null };
  resets: number;
  supervisor_own_ticket: boolean;
  roundHeadingMismatches: string[];
  decisions: DecisionFacts;
  nextActor: NextActor;
  rule: string;
}

export interface CheckReport {
  schema: 1;
  rule: string;
  ticket: string | null;
  taskDir: string;
  ok: boolean;
  checks: CheckResult[];
  facts: TaskFacts;
  keys: RegistrationKey[];
}

interface Transition {
  from: string | null;
  to: string;
  agent: string;
  timestamp: string;
  note: string;
}

interface Status {
  ticket_id: string;
  state: string;
  plan_locked: boolean;
  transitions: Transition[];
  checklist: { review_verdict: string | null; qa_verdict: string | null };
}

const STATES = ["pending", "in_progress", "completed", "blocked", "validated"];
const TS = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/;
const TS_IN_TEXT = "\\d{4}-\\d\\d-\\d\\dT\\d\\d:\\d\\d:\\d\\dZ";
const REVIEW_NOTE = /^review round (\d+): (approved|changes_requested)\b/;
const QA_NOTE = /^qa round (\d+): (pass|fail)\b/;
const REVIEWED = new RegExp(`reviewed implementer completion (${TS_IN_TEXT})`);
const VERIFIED = new RegExp(`verified implementer completion (${TS_IN_TEXT})`);
const MASK = "\u0001";

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isStrOrNull = (v: unknown) => typeof v === "string" || v === null;

/** Parses status.json against the task schema; returns the problem instead of throwing. */
export function parseStatus(text: string): { status?: Status; problem?: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { problem: "not valid JSON" };
  }
  if (!isObj(raw)) return { problem: "not a JSON object" };
  if (typeof raw.ticket_id !== "string") return { problem: "ticket_id is not a string" };
  if (typeof raw.state !== "string" || !STATES.includes(raw.state)) return { problem: "state is not one of the five states" };
  if (typeof raw.plan_locked !== "boolean") return { problem: "plan_locked is not a boolean" };
  if (!isStrOrNull(raw.assignee)) return { problem: "assignee is not a string or null" };
  if (!isStrOrNull(raw.blocker)) return { problem: "blocker is not a string or null" };
  if (!Array.isArray(raw.transitions)) return { problem: "transitions is not an array" };
  for (const [i, t] of raw.transitions.entries()) {
    const ok =
      isObj(t) &&
      isStrOrNull(t.from) &&
      typeof t.to === "string" &&
      typeof t.agent === "string" &&
      typeof t.timestamp === "string" &&
      typeof t.note === "string";
    if (!ok) return { problem: `transitions[${i}] does not have from, to, agent, timestamp and note of the schema types` };
  }
  const c = raw.checklist;
  if (!isObj(c)) return { problem: "checklist is not an object" };
  for (const f of ["tests_pass", "lint_pass", "types_pass"]) {
    if (typeof c[f] !== "boolean") return { problem: `checklist.${f} is not a boolean` };
  }
  if (!(c.review_verdict === null || c.review_verdict === "approved" || c.review_verdict === "changes_requested")) {
    return { problem: "checklist.review_verdict is not approved, changes_requested or null" };
  }
  if (!(c.qa_verdict === null || c.qa_verdict === "pass" || c.qa_verdict === "fail")) {
    return { problem: "checklist.qa_verdict is not pass, fail or null" };
  }
  return { status: raw as unknown as Status };
}

/**
 * Splits text into lines and marks those inside a pair of code fences (fence lines included).
 * An unpaired fence line has no effect.
 */
export function fenceMask(text: string): { lines: string[]; inFence: boolean[] } {
  const lines = text.split(/\r?\n/);
  const inFence = lines.map(() => false);
  const fences = lines.flatMap((l, i) => (l.trim().startsWith("```") ? [i] : []));
  for (let p = 0; p + 1 < fences.length; p += 2) {
    for (let i = fences[p]; i <= fences[p + 1]; i++) inFence[i] = true;
  }
  return { lines, inFence };
}

/** Replaces every inline code span (CommonMark backtick runs, within one line) with a placeholder of equal length. */
export function maskCodeSpans(line: string): string {
  const out = line.split("");
  let i = 0;
  while (i < line.length) {
    if (line[i] !== "`") {
      i++;
      continue;
    }
    let n = 0;
    while (line[i + n] === "`") n++;
    let j = i + n;
    let close = -1;
    while (j < line.length) {
      if (line[j] !== "`") {
        j++;
        continue;
      }
      let m = 0;
      while (line[j + m] === "`") m++;
      if (m === n) {
        close = j;
        break;
      }
      j += m;
    }
    if (close === -1) {
      i += n;
      continue;
    }
    for (let k = i; k < close + n; k++) out[k] = MASK;
    i = close + n;
  }
  return out.join("");
}

/** Offsets of the To register markers on one masked line, in left-to-right order. */
export function markerOffsets(masked: string): number[] {
  const offsets: number[] = [];
  if (masked.trim().startsWith("|")) {
    let start = 0;
    for (let i = 0; i <= masked.length; i++) {
      const atEnd = i === masked.length;
      if (atEnd || (masked[i] === "|" && masked[i - 1] !== "\\")) {
        if (masked.slice(start, i).trim() === "To register") offsets.push(start);
        start = i + 1;
      }
    }
  }
  for (const m of masked.matchAll(/\*\*To register\.?\*\*/g)) offsets.push(m.index ?? 0);
  return offsets.sort((a, b) => a - b);
}

interface Round {
  /** 0-based line index where the round starts (0 for round 1). */
  start: number;
  end: number;
  heading: number | null;
}

interface Report {
  lines: string[];
  inFence: boolean[];
  hasRound1: boolean;
  rounds: Round[];
  unfilled: boolean;
  round1Verdict: string | null;
}

function parseReport(text: string, kind: "review" | "qa"): Report {
  const { lines, inFence } = fenceMask(text);
  const live = (i: number) => !inFence[i];
  const headingRe = kind === "review" ? /^## Round (\d+) re-review/ : /^## Round (\d+) re-verification/;
  // The header line as reports write it: `Round: 1`, optionally as a list item and with a bold label.
  const hasRound1 = lines.some((l, i) => live(i) && /^(?:[-*] )?(?:\*\*Round:\*\*|Round:) 1\s*$/.test(l));
  const headings = lines.flatMap((l, i) => {
    const m = live(i) ? headingRe.exec(l) : null;
    return m ? [{ i, n: Number(m[1]) }] : [];
  });
  const starts: { start: number; heading: number | null }[] = [];
  if (hasRound1) starts.push({ start: 0, heading: null });
  for (const h of headings) starts.push({ start: h.i, heading: h.n });
  const rounds = starts.map((s, k) => ({ ...s, end: k + 1 < starts.length ? starts[k + 1].start : lines.length }));
  const verdictLine = lines.find((l, i) => live(i) && l.startsWith("## Verdict:"));
  const word = verdictLine?.slice("## Verdict:".length).replace(/<!--[\s\S]*?-->/g, "").trim() ?? "";
  const round1Verdict = /^[a-z_]+/.exec(word)?.[0] ?? null;
  return { lines, inFence, hasRound1, rounds, unfilled: verdictLine !== undefined && round1Verdict === null && !hasRound1, round1Verdict };
}

function roundText(r: Report, round: Round): string {
  return r.lines.slice(round.start, round.end).filter((_, k) => !r.inFence[round.start + k]).join("\n");
}

/** Verdict of a round: round 1 from `## Verdict:`, an appended round from its one verdict line. */
function roundVerdict(r: Report, idx: number, words: string[]): { verdict: string | null; problem?: string } {
  const round = r.rounds[idx];
  if (round.heading === null) return { verdict: r.round1Verdict };
  // "verdict", an optional short qualifier such as "(round 2 — authoritative)", a colon, then the word.
  const re = new RegExp(`verdict[^:\\n]{0,60}:\\s*\\**\\s*(${words.join("|")})\\b`, "i");
  const hits: string[] = [];
  for (let i = round.start; i < round.end; i++) {
    if (r.inFence[i]) continue;
    const m = re.exec(r.lines[i]);
    if (m && words.filter((w) => new RegExp(`\\b${w}\\b`, "i").test(r.lines[i])).length === 1) hits.push(m[1].toLowerCase());
  }
  if (hits.length !== 1) return { verdict: null, problem: `${hits.length} verdict lines in round ${idx + 1}` };
  return { verdict: hits[0] };
}

function keysFrom(r: Report, kind: "review" | "qa", ticket: string, file: string, onlyLatest: boolean): RegistrationKey[] {
  const keys: RegistrationKey[] = [];
  const counted = onlyLatest ? r.rounds.slice(-1) : r.rounds;
  const firstN = onlyLatest ? r.rounds.length : 1;
  counted.forEach((round, k) => {
    const n = firstN + k;
    let ordinal = 0;
    for (let i = round.start; i < round.end; i++) {
      if (r.inFence[i]) continue;
      for (const _ of markerOffsets(maskCodeSpans(r.lines[i]))) {
        ordinal++;
        keys.push({ key: `reg ${ticket} ${kind} r${n} i${ordinal}`, file, line: i + 1 });
      }
    }
  });
  return keys;
}

/** Whole-file key count used when a report has no `Round: 1` line: the file is treated as one round. */
function asSingleRound(r: Report): Report {
  return r.rounds.length ? r : { ...r, rounds: [{ start: 0, end: r.lines.length, heading: null }] };
}

function sectionLines(text: string, heading: RegExp): string[] {
  const { lines, inFence } = fenceMask(text);
  const start = lines.findIndex((l, i) => !inFence[i] && heading.test(l));
  if (start === -1) return [];
  const out: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (inFence[i]) continue;
    if (/^## /.test(lines[i])) break;
    out.push(lines[i]);
  }
  return out;
}

const DECISION_LABELS = ["Decided by", "Decided", "Recorded by", "Covers", "Decision", "Affects"];
const LABEL_ALT = DECISION_LABELS.join("|");
// A field line: column 0, an optional list marker, then `Label:` or `**Label:**` (H1).
const FIELD_LINE = new RegExp(`^(?:[-*] )?(?:\\*\\*(${LABEL_ALT}):\\*\\*|(${LABEL_ALT}):)(.*)$`);
// A timestamp and at most one parenthesised annotation (which may contain commas but no parentheses).
const COVERS_ITEM = new RegExp(`^(${TS_IN_TEXT})(?:\\s*\\([^()]*\\))?$`);

interface DecisionBlock {
  id: string;
  fields: Map<string, string[]>;
}

/** Parses decisions.md into `## D<n>` blocks; fenced lines are ignored. */
function parseDecisions(text: string): { blocks: DecisionBlock[]; badHeadings: number[] } {
  const { lines, inFence } = fenceMask(text);
  const blocks: DecisionBlock[] = [];
  const badHeadings: number[] = [];
  let current: DecisionBlock | undefined;
  lines.forEach((line, i) => {
    if (inFence[i]) return;
    if (line.startsWith("## ")) {
      const m = /^## D([1-9]\d*)\s*$/.exec(line);
      if (!m) {
        badHeadings.push(i + 1);
        current = undefined;
        return;
      }
      current = { id: `D${m[1]}`, fields: new Map() };
      blocks.push(current);
      return;
    }
    const f = current ? FIELD_LINE.exec(line) : null;
    if (current && f) {
      const label = f[1] ?? f[2];
      current.fields.set(label, [...(current.fields.get(label) ?? []), f[3].trim()]);
    }
  });
  return { blocks, badHeadings };
}

/** Splits a `Covers:` value on commas outside parentheses. */
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

const isAck = (b: DecisionBlock) => (b.fields.get("Decision")?.[0] ?? "").startsWith("Steering acknowledged:");

/** The counted `Covers:` timestamps of a block: the leading timestamp of each well-formed item. */
function coveredBy(b: DecisionBlock): string[] {
  const value = b.fields.get("Covers")?.[0] ?? "";
  if (value === "none") return [];
  return coversItems(value).flatMap((item) => {
    const m = COVERS_ITEM.exec(item);
    return m ? [m[1]] : [];
  });
}

const SECURITY_LABELS = ["Trust boundary touched", "Method", "Findings"] as const;
const SECURITY_FIELD = new RegExp(`^(?:[-*] )?(?:\\*\\*(${SECURITY_LABELS.join("|")}):\\*\\*|(${SECURITY_LABELS.join("|")}):)(.*)$`);
const BOUNDARY_KINDS = ["network", "processes", "external input", "secrets"];
const CATEGORY_KEYWORDS = {
  STRIDE: ["spoof", "tamper", "repudiat", "information", "denial", "elevation"],
  "OWASP checklist": ["input", "auth", "secret", "abuse", "supply"],
};
const FINDING_ID = /\b[HML]\d+\b/g;

/**
 * The form of a review round's Security section (supervisor.md C19, BASE-124-B): one heading, the three
 * field lines, a method that follows the boundary, one filled row per category of that method, and finding
 * ids that agree between the `Findings` line and the rows. Structure only. Returns the first problem in
 * fixed words, labels and counts — never text from the report — or null.
 */
function securityProblem(r: Report, round: Round): string | null {
  // Outside code fences and with HTML comments removed, so an unfilled template section does not count.
  const lines = roundText(r, round).replace(/<!--[\s\S]*?-->/g, "").split("\n");
  const headings = lines.flatMap((l, i) => (/^#{2,3} Security\s*$/.test(l) ? [i] : []));
  if (headings.length !== 1) return `${headings.length} Security headings`;
  const rest = lines.slice(headings[0] + 1);
  const end = rest.findIndex((l) => /^#{1,3} /.test(l));
  const section = end === -1 ? rest : rest.slice(0, end);
  const plain = (v: string) => v.replace(/[*`]/g, "").trim();

  const fields = new Map<string, string[]>();
  for (const l of section) {
    const m = SECURITY_FIELD.exec(l);
    if (m) fields.set(m[1] ?? m[2], [...(fields.get(m[1] ?? m[2]) ?? []), plain(m[3])]);
  }
  for (const label of SECURITY_LABELS) {
    const values = fields.get(label) ?? [];
    if (values.length !== 1) return `${label}: ${values.length} lines`;
    if (values[0] === "") return `${label} is empty`;
  }
  const value = (label: (typeof SECURITY_LABELS)[number]) => (fields.get(label) as string[])[0];

  const boundary = value("Trust boundary touched").toLowerCase();
  const touched = boundary.startsWith("yes") && BOUNDARY_KINDS.some((k) => boundary.includes(k));
  if (boundary !== "no" && !touched) return "Trust boundary touched is neither no nor yes with a kind";
  const method = touched ? "STRIDE" : "OWASP checklist";
  if (value("Method").toLowerCase() !== method.toLowerCase()) return "Method does not match Trust boundary touched";

  const cells = (l: string) => l.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
  const table = section.filter((l) => l.trim().startsWith("|")).map(cells);
  const separator = table.findIndex((row) => row.every((c) => /^:?-+:?$/.test(c)));
  const rows = separator === -1 ? table : table.filter((_, i) => i !== separator && i !== separator - 1);
  const keywords = CATEGORY_KEYWORDS[method];
  if (rows.length !== keywords.length) return `category rows: expected ${keywords.length}, found ${rows.length}`;
  for (const k of keywords) {
    const n = rows.filter((row) => plain(row[0] ?? "").toLowerCase().startsWith(k)).length;
    if (n !== 1) return `category rows: ${n} for one ${method} category`;
  }
  if (rows.some((row) => row.length < 3 || plain(row[1]) === "" || plain(row[2]) === "")) return "a category row has an empty Result or Basis";

  const ids = (text: string) => [...new Set(text.match(FINDING_ID) ?? [])].sort();
  const cited = ids(value("Findings"));
  const inRows = ids(rows.map((row) => row[1]).join(" "));
  if (cited.length === 0 && value("Findings").toLowerCase() !== "none") return "Findings is neither none nor finding ids";
  if (cited.join(",") !== inRows.join(",")) return `finding ids differ: ${cited.length} in Findings, ${inRows.length} in the rows`;
  return null;
}

const fileProblem = (f: FileRead, name: string) =>
  f.kind === "missing" ? `${name} is missing` : f.kind === "error" ? `${name}: ${f.reason}` : "";

/** A failing check that means "work is still to do" rather than "the task is malformed" (plan H1). */
function isProgress(id: string, i: NextActorInput, entries: { review: boolean; qa: boolean }): boolean {
  const pendingOrBlocked = i.state === "pending" || i.state === "blocked";
  switch (id) {
    case "K3":
      return i.state === "pending" && !i.planLocked;
    case "K4":
    case "K10":
    case "K11":
    case "K14":
    case "K15":
      return true;
    case "K6":
      return !i.planLocked && pendingOrBlocked;
    case "K7":
      return pendingOrBlocked || i.state === "in_progress";
    case "K8":
      return !entries.review;
    case "K12":
      return !entries.qa;
    default:
      return false;
  }
}

/** Pure rule table: integrity failures first (step A), then by state (step B). */
export function nextActor(i: NextActorInput): NextActor {
  const entries = { review: i.reviewEntries > 0, qa: i.qaEntries > 0 };
  const integrity = i.checks.find((c) => c.status === "fail" && !isProgress(c.id, i, entries));
  if (integrity) return { role: "human", reason: `check ${integrity.id} ${integrity.key} failed` };
  const status = (id: string) => i.checks.find((c) => c.id === id)?.status;
  const k3 = status("K3") === "pass";
  switch (i.state) {
    case "pending":
      if (i.planLocked) return { role: "implementer", reason: "plan locked; claim it" };
      return k3 ? { role: "human", reason: "plan approval" } : { role: "planner", reason: "plan not drafted" };
    case "in_progress":
      return { role: "implementer", reason: "in progress" };
    case "blocked":
      return { role: "human", reason: "blocked" };
    case "validated":
      return { role: "none", reason: "validated; improvement optional, then the human's PR" };
    case "completed":
      if (!entries.review) return { role: "reviewer", round: 1, reason: "no review round" };
      if (status("K10") !== "pass") return { role: "reviewer", round: i.reviewEntries + 1, reason: "review not bound to latest completion" };
      if (status("K11") === "fail") return { role: "human", reason: `send-back decision: review round ${i.reviewEntries} changes_requested` };
      if (!entries.qa) {
        return { role: "qa", round: 1, reason: i.resetExists ? "no QA round since the QA rounds reset" : "no QA round" };
      }
      if (status("K14") !== "pass") return { role: "qa", round: i.qaEntries + 1, reason: "QA not bound to latest completion" };
      if (status("K15") === "fail") return { role: "human", reason: `send-back decision: QA round ${i.qaEntries} fail` };
      if (i.ownTicket) return { role: "human", reason: "supervisor own ticket: the human decides" };
      return {
        role: "supervisor",
        reason: `review approved and QA pass for latest completion${i.keys ? `; register ${i.keys} key(s) first` : ""}`,
      };
    default:
      // Unreachable once K1 passes (parseStatus admits only the five states); kept for type safety.
      return { role: "human", reason: "no rule matched" };
  }
}

/** Runs K1–K18 on one task directory. Never throws on malformed input. */
export function checkTask(input: TaskInput): CheckReport {
  const results = new Map<string, CheckResult>();
  const facts: TaskFacts = {
    state: null,
    latestCompletion: null,
    review: { rounds: 0, verdict: null, entry: null },
    qa: { rounds: 0, verdict: null, entry: null },
    resets: 0,
    supervisor_own_ticket: false,
    roundHeadingMismatches: [],
    decisions: { present: false, blocks: 0, events: [], covering: [], acknowledging: [] },
    nextActor: { role: "human", reason: "" },
    rule: RULE,
  };
  let keys: RegistrationKey[] = [];

  const put = (id: string, key: string, source: string, status: CheckStatus, detail = "") =>
    results.set(id, { id, key, source, status, detail });
  const failed = (...ids: string[]) => ids.find((id) => results.get(id)?.status !== "pass");
  /** Runs `fn` unless a dependency did not pass, in which case the check is skipped naming it. */
  const run = (id: string, key: string, source: string, deps: string[], fn: () => string | true) => {
    const dep = failed(...deps);
    if (dep) return put(id, key, source, "skip", `depends on ${dep}`);
    const r = fn();
    put(id, key, source, r === true ? "pass" : "fail", r === true ? "" : r);
  };

  // K1 status.parse
  let st: Status | undefined;
  if (input.status.kind !== "ok") put("K1", "status.parse", "C1", "fail", fileProblem(input.status, "status.json"));
  else {
    const p = parseStatus(input.status.text);
    st = p.status;
    put("K1", "status.parse", "C1", st ? "pass" : "fail", p.problem ?? "");
  }
  const s = st as Status;
  if (st) facts.state = st.state;

  run("K2", "status.ticket", "C1", ["K1"], () => {
    if (s.ticket_id !== input.dirName) return "ticket_id differs from the directory name";
    if (!/^[A-Za-z0-9#._-]+$/.test(s.ticket_id)) return "ticket_id has characters outside [A-Za-z0-9#._-]";
    if (input.absPath.includes("'")) return "the task directory path contains a single quote";
    return true;
  });

  // K3 plan.steps (independent of status.json)
  if (input.plan.kind !== "ok") put("K3", "plan.steps", "C1", "fail", fileProblem(input.plan, "plan.md"));
  else {
    const steps = sectionLines(input.plan.text, /^## Steps\s*$/);
    const ok = steps.some((l) => /^\d+\.\s+\S/.test(l));
    put("K3", "plan.steps", "C1", ok ? "pass" : "fail", ok ? "" : "no `## Steps` section with a top-level numbered step");
    facts.supervisor_own_ticket = sectionLines(input.plan.text, /^## Files to touch\s*$/).some(
      (l) => l.trim().startsWith("|") && l.includes(".claude/agents/supervisor.md"),
    );
  }

  run("K4", "state", "C2", ["K1"], () =>
    s.state === "completed" || s.state === "validated" ? true : `state is ${s.state}`,
  );

  run("K5", "transitions.order", "state machine", ["K1"], () => {
    const t = s.transitions;
    if (t.length === 0) return "transitions is empty";
    if (t[0].from !== null) return "the first entry's from is not null";
    for (let i = 0; i < t.length; i++) {
      if (!TS.test(t[i].timestamp)) return `transitions[${i}] timestamp is malformed`;
      if (i > 0 && t[i].from !== t[i - 1].to) return `transitions[${i}] from differs from the previous entry's to`;
      if (i > 0 && t[i].timestamp < t[i - 1].timestamp) return `transitions[${i}] timestamp is earlier than the previous one`;
    }
    if (t[t.length - 1].to !== s.state) return "the last entry's to differs from state";
    return true;
  });

  // Entry kinds (supervisor.md "Literal definitions").
  const t = st?.transitions ?? [];
  const lastIndex = (pred: (e: Transition) => boolean) => t.map(pred).lastIndexOf(true);
  const claim = t.findIndex((e) => e.agent === "implementer" && e.to === "in_progress");
  const lock = t.findIndex(
    (e) => e.from === "pending" && e.to === "pending" && (e.agent === "planner" || e.agent === "human") && /\b(approved|locked)\b/.test(e.note),
  );
  const completion = lastIndex((e) => e.agent === "implementer" && e.to === "completed");
  const reviewerIdx = t.flatMap((e, i) => (e.agent === "reviewer" ? [i] : []));
  const latestReviewer = reviewerIdx.length ? reviewerIdx[reviewerIdx.length - 1] : -1;
  const reset = lastIndex((e) => e.agent === "human" && e.from === e.to && e.note.startsWith("qa rounds reset:"));
  const qaIdx = t.flatMap((e, i) => (e.agent === "qa" && i > reset ? [i] : []));
  const latestQa = qaIdx.length ? qaIdx[qaIdx.length - 1] : -1;
  facts.resets = t.filter((e) => e.agent === "human" && e.from === e.to && e.note.startsWith("qa rounds reset:")).length;
  const completionTs = completion >= 0 ? t[completion].timestamp : null;
  facts.latestCompletion = completionTs;
  if (latestReviewer >= 0) facts.review.entry = t[latestReviewer].timestamp;
  if (latestQa >= 0) facts.qa.entry = t[latestQa].timestamp;

  run("K6", "lock", "C3", ["K1"], () => {
    if (!s.plan_locked) return "plan_locked is not true";
    if (lock === -1) return "no lock entry";
    if (claim !== -1 && lock > claim) return "the lock entry comes after the first implementer claim";
    return true;
  });

  run("K7", "completion", "C4", ["K1"], () => (completion >= 0 ? true : "no implementer → completed entry"));

  run("K8", "review.present", "C6", ["K1"], () => {
    if (latestReviewer === -1) return "no reviewer entry";
    if (s.checklist.review_verdict === null) return "review_verdict is null";
    if (input.review.kind !== "ok") return fileProblem(input.review, "review-report.md");
    return true;
  });

  const review = input.review.kind === "ok" ? parseReport(input.review.text, "review") : undefined;
  const qa = input.qa.kind === "ok" ? parseReport(input.qa.text, "qa") : undefined;
  for (const [name, r] of [["review-report.md", review], ["qa-report.md", qa]] as const) {
    r?.rounds.forEach((round, k) => {
      if (round.heading !== null && round.heading !== k + 1) {
        facts.roundHeadingMismatches.push(`${name}: heading "Round ${round.heading}" is round ${k + 1}`);
      }
    });
  }
  if (review) {
    facts.review.rounds = review.rounds.length;
    if (review.rounds.length) facts.review.verdict = roundVerdict(review, review.rounds.length - 1, ["approved", "changes_requested"]).verdict;
  }
  if (qa) {
    facts.qa.rounds = qa.rounds.length;
    if (qa.rounds.length) facts.qa.verdict = roundVerdict(qa, qa.rounds.length - 1, ["pass", "fail"]).verdict;
  }

  run("K9", "review.consistency", "C7", ["K8"], () => {
    const r = review as Report;
    const problems: string[] = [];
    if (r.unfilled) problems.push("unfilled template");
    if (r.rounds.length !== reviewerIdx.length) problems.push(`round count ${r.rounds.length} ≠ reviewer entries ${reviewerIdx.length}`);
    const note = t[latestReviewer].note;
    const named = REVIEWED.exec(note)?.[1];
    if (r.rounds.length && (!named || !roundText(r, r.rounds[r.rounds.length - 1]).includes(named))) {
      problems.push("latest round does not contain the completion the latest reviewer note names");
    }
    const v = r.rounds.length ? roundVerdict(r, r.rounds.length - 1, ["approved", "changes_requested"]) : { verdict: null, problem: "no rounds" };
    if (v.problem) problems.push(v.problem);
    else if (v.verdict !== s.checklist.review_verdict) problems.push("latest-round verdict ≠ review_verdict");
    const m = REVIEW_NOTE.exec(note);
    if (!m || Number(m[1]) !== r.rounds.length || m[2] !== s.checklist.review_verdict || m[2] !== v.verdict) {
      problems.push("latest reviewer note prefix ≠ round count and verdict");
    }
    return problems.length ? problems.join("; ") : true;
  });

  run("K10", "review.binding", "C8", ["K7", "K8"], () => {
    if (latestReviewer < completion) return "the latest reviewer entry comes before the latest completion";
    return REVIEWED.exec(t[latestReviewer].note)?.[1] === completionTs ? true : "the latest reviewer note does not name the latest completion";
  });

  run("K11", "review.verdict", "C9", ["K8"], () =>
    s.checklist.review_verdict === "approved" ? true : `review_verdict is ${s.checklist.review_verdict}`,
  );

  run("K12", "qa.present", "C10", ["K1"], () => {
    if (latestQa === -1) return "no counted QA entry";
    if (s.checklist.qa_verdict === null) return "qa_verdict is null";
    if (input.qa.kind !== "ok") return fileProblem(input.qa, "qa-report.md");
    return true;
  });

  // C11: while no QA entry follows the latest reset, the report must be absent or an unfilled template.
  if (st && reset >= 0 && qaIdx.length === 0) {
    const filled = qa !== undefined && !qa.unfilled;
    put("K13", "qa.consistency", "C11", filled ? "fail" : "skip", filled ? "qa-report.md is filled while no QA entry follows the latest reset" : "depends on K12");
  } else run("K13", "qa.consistency", "C11", ["K12"], () => {
    const r = qa as Report;
    const problems: string[] = [];
    if (r.unfilled) problems.push("unfilled template");
    if (r.rounds.length !== qaIdx.length) problems.push(`round count ${r.rounds.length} ≠ counted QA entries ${qaIdx.length}`);
    r.rounds.forEach((round, k) => {
      const line = r.lines.slice(round.start, round.end).find((l, j) => !r.inFence[round.start + j] && l.startsWith("Implementer completion verified:"));
      const ts = line ? new RegExp(TS_IN_TEXT).exec(line)?.[0] : undefined;
      const entry = qaIdx[k];
      const named = entry === undefined ? undefined : VERIFIED.exec(t[entry].note)?.[1];
      if (!ts || ts !== named) problems.push(`round ${k + 1} completion ≠ its counted QA entry`);
    });
    const v = r.rounds.length ? roundVerdict(r, r.rounds.length - 1, ["pass", "fail"]) : { verdict: null, problem: "no rounds" };
    if (v.problem) problems.push(v.problem);
    else if (v.verdict !== s.checklist.qa_verdict) problems.push("latest-round verdict ≠ qa_verdict");
    const m = QA_NOTE.exec(t[latestQa].note);
    if (!m || Number(m[1]) !== r.rounds.length || m[2] !== s.checklist.qa_verdict || m[2] !== v.verdict) {
      problems.push("latest QA note prefix ≠ round count and verdict");
    }
    return problems.length ? problems.join("; ") : true;
  });

  run("K14", "qa.binding", "C12", ["K7", "K12"], () => {
    if (VERIFIED.exec(t[latestQa].note)?.[1] !== completionTs) return "the latest QA note does not name the latest completion";
    if (latestQa < latestReviewer) return "the latest QA entry comes before the latest reviewer entry";
    return true;
  });

  run("K15", "qa.verdict", "C13", ["K12"], () => (s.checklist.qa_verdict === "pass" ? true : `qa_verdict is ${s.checklist.qa_verdict}`));

  // K2 first: keys embed ticket_id, so an unvalidated id never reaches the output (review M1).
  run("K16", "register.keys", "C16", ["K1", "K2"], () => {
    const unreadable = [input.review, input.qa].find((f) => f.kind === "error");
    if (unreadable) return fileProblem(unreadable, unreadable === input.review ? "review-report.md" : "qa-report.md");
    if (review) keys.push(...keysFrom(asSingleRound(review), "review", s.ticket_id, "review-report.md", false));
    if (qa) keys.push(...keysFrom(asSingleRound(qa), "qa", s.ticket_id, "qa-report.md", true));
    return true;
  });
  if (results.get("K16")?.status !== "pass") keys = [];

  // K17–K18: decisions.md (supervisor.md C15, supervisor/decisions-format.md).
  const decisionsFile: FileRead = input.decisions ?? { kind: "missing" };
  const parsed = decisionsFile.kind === "ok" ? parseDecisions(decisionsFile.text) : undefined;
  facts.decisions.present = decisionsFile.kind === "ok";
  if (parsed) {
    facts.decisions.blocks = parsed.blocks.length;
    facts.decisions.acknowledging = parsed.blocks.filter(isAck).map((b) => b.id);
  }

  run("K17", "decisions.format", "C15", ["K1"], () => {
    if (decisionsFile.kind === "missing") return true;
    if (!parsed) return fileProblem(decisionsFile, "decisions.md");
    const known = new Set(t.map((e) => e.timestamp));
    const problems = parsed.badHeadings.map((n) => `line ${n}: a "## " heading that is not ## D<n>`);
    for (const b of parsed.blocks) {
      for (const label of DECISION_LABELS) {
        const values = b.fields.get(label) ?? [];
        if (values.length === 0) problems.push(`${b.id} ${label}: missing`);
        else if (values.length > 1) problems.push(`${b.id} ${label}: appears ${values.length} times`);
        else if (values[0] === "") problems.push(`${b.id} ${label}: empty`);
      }
      const covers = b.fields.get("Covers");
      if (covers?.length !== 1 || covers[0] === "") continue;
      if (covers[0] === "none") {
        if (!isAck(b)) problems.push(`${b.id} Covers: none outside a steering acknowledgement block`);
        continue;
      }
      coversItems(covers[0]).forEach((item, k) => {
        const m = COVERS_ITEM.exec(item);
        if (!m) problems.push(`${b.id} Covers: item ${k + 1} is not a timestamp with an optional (note)`);
        else if (!known.has(m[1])) problems.push(`${b.id} Covers: ${m[1]} is not the timestamp of a transitions[] entry`);
      });
    }
    return problems.length ? problems.join("; ") : true;
  });

  // Events after the lock entry (C15 "Events that must be covered"), derived from structure only.
  if (st && lock >= 0) {
    for (let i = lock + 1; i < t.length; i++) {
      const e = t[i];
      if (e.agent === "human") facts.decisions.events.push({ timestamp: e.timestamp, kind: "human" });
      else if (e.agent === "implementer" && e.from === "blocked" && e.to === "in_progress") {
        facts.decisions.events.push({ timestamp: e.timestamp, kind: "unblock" });
      } else if (e.agent === "implementer" && e.from === "completed" && e.to === "in_progress") {
        const prev = t.slice(0, i).map((x) => x.agent === "implementer" && x.to === "completed").lastIndexOf(true);
        const between = t.slice(prev + 1, i).filter((x) => x.agent === "reviewer" || x.agent === "qa");
        const latest = between[between.length - 1];
        const prevTs = prev >= 0 ? t[prev].timestamp : null;
        // An ordinary send-back: a failing round bound to that previous completion (H4).
        const ordinary =
          latest !== undefined &&
          (latest.agent === "reviewer"
            ? /^review round \d+: changes_requested\b/.test(latest.note) && REVIEWED.exec(latest.note)?.[1] === prevTs
            : /^qa round \d+: fail\b/.test(latest.note) && VERIFIED.exec(latest.note)?.[1] === prevTs);
        if (!ordinary) facts.decisions.events.push({ timestamp: e.timestamp, kind: "reentry" });
      }
    }
  }
  const coverMap = new Map<string, string[]>();
  for (const b of parsed?.blocks ?? []) for (const ts of coveredBy(b)) coverMap.set(ts, [...(coverMap.get(ts) ?? []), b.id]);
  facts.decisions.covering = (parsed?.blocks ?? [])
    .filter((b) => facts.decisions.events.some((ev) => coverMap.get(ev.timestamp)?.includes(b.id)))
    .map((b) => b.id);

  run("K18", "decisions.covers", "C15", ["K1", "K6"], () => {
    if (decisionsFile.kind === "error") return fileProblem(decisionsFile, "decisions.md");
    const uncovered = facts.decisions.events.filter((ev) => !coverMap.has(ev.timestamp));
    return uncovered.length ? `uncovered: ${uncovered.map((ev) => `${ev.timestamp} (${ev.kind})`).join(", ")}` : true;
  });

  // K19 review.security: the gate applies while the task is `completed`; in any other state it is skipped,
  // so directories validated before the rule existed keep passing (BASE-124-B H2).
  if (st && st.state !== "completed") put("K19", "review.security", "C19", "skip", `state is ${st.state}`);
  else {
    run("K19", "review.security", "C19", ["K1", "K8", "K9"], () => {
      const r = review as Report;
      const n = r.rounds.length;
      const problem = securityProblem(r, r.rounds[n - 1]);
      return problem === null ? true : `round ${n}: ${problem}`;
    });
  }

  const order = Array.from({ length: 19 }, (_, i) => `K${i + 1}`);
  const checks = order.map((id) => results.get(id) as CheckResult);
  facts.nextActor = nextActor({
    checks,
    state: facts.state,
    planLocked: st?.plan_locked ?? false,
    reviewEntries: reviewerIdx.length,
    qaEntries: qaIdx.length,
    resetExists: reset >= 0,
    ownTicket: facts.supervisor_own_ticket,
    keys: keys.length,
  });
  return {
    schema: 1,
    rule: RULE,
    ticket: st ? st.ticket_id : null,
    taskDir: input.absPath,
    ok: checks.every((c) => c.status !== "fail"),
    checks,
    facts,
    keys,
  };
}

/** Plain-text rendering; prints only computed values, never note or report text. */
export function renderText(r: CheckReport): string {
  const failedN = r.checks.filter((c) => c.status === "fail").length;
  const skipped = r.checks.filter((c) => c.status === "skip").length;
  const k2 = r.checks.find((c) => c.id === "K2");
  const ticket = r.ticket === null ? "(unknown)" : k2?.status === "pass" ? r.ticket : JSON.stringify(r.ticket);
  const out = [`pipeline check ${ticket}: ${r.ok ? "PASS" : "FAIL"} (${failedN} failed, ${skipped} skipped of ${r.checks.length})`];
  for (const c of r.checks) {
    if (c.status === "pass") out.push(`  ✔ ${c.id} ${c.key}`);
    else if (c.status === "fail") out.push(`  ✖ ${c.id} ${c.key} — ${c.detail}`);
    else out.push(`  - ${c.id} ${c.key} — skipped: ${c.detail}`);
  }
  const f = r.facts;
  out.push(
    "facts:",
    `  state: ${f.state ?? "-"}`,
    `  latest completion: ${f.latestCompletion ?? "-"}`,
    `  review: ${f.review.rounds} round(s), verdict ${f.review.verdict ?? "-"}, entry ${f.review.entry ?? "-"}`,
    `  qa: ${f.qa.rounds} round(s), verdict ${f.qa.verdict ?? "-"}, entry ${f.qa.entry ?? "-"}`,
    `  qa resets: ${f.resets}`,
    `  supervisor_own_ticket: ${f.supervisor_own_ticket}`,
    `  next: ${f.nextActor.role}${f.nextActor.round === undefined ? "" : ` round ${f.nextActor.round}`} — ${f.nextActor.reason}`,
    `  decisions: ${f.decisions.present ? `${f.decisions.blocks} block(s)` : "absent"}; events: ${
      f.decisions.events.map((e) => `${e.timestamp} (${e.kind})`).join(", ") || "none"
    }; covering: ${f.decisions.covering.join(", ") || "-"}; acknowledging: ${f.decisions.acknowledging.join(", ") || "-"}`,
    `  rule: ${f.rule}`,
  );
  for (const m of f.roundHeadingMismatches) out.push(`  note: ${m}`);
  out.push(`keys (${r.keys.length}):`);
  for (const k of r.keys) out.push(`  ${k.key} — ${k.file}:${k.line}`);
  return out.join("\n");
}
