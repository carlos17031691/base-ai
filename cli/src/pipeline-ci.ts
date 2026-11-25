/**
 * `base-ai pipeline ci --base <ref>` (BASE-071-P3 D2, issue #71): the task directories a PR changes, each checked
 * for an append-only `transitions[]` (A1, invariant 5 of docs/task-state-machine.md), then `pipeline check`,
 * `pipeline plan` (BASE-140-B D4: P1 criteria and P2 lock, when status.json, plan.md, plan-review.md or
 * decisions.md changed; its two fixed git calls per directory) and `pipeline debt`.
 *
 * Pure: git goes through the injected `Runner` (pipeline-gh.ts is the real one), the working tree through the
 * injected reader, and the check, plan and debt through injected functions, so every case is tested with fakes.
 * Read-only. It never prints file content, git stderr, a URL or issue text.
 */
import { MAX_FILE_BYTES, type CheckReport, type FileRead, type TaskInput } from "./pipeline-check.js";
import { EXEMPT, HALT_TEXT as PLAN_HALT_TEXT, type PlanResult } from "./pipeline-plan.js";
import type { DebtReport, RunFailure, Runner } from "./pipeline-registration.js";

export const MAX_TASK_DIRS = 20;
export const CI_USAGE = "usage: base-ai pipeline ci --base <ref> [--json] [--root <dir>]";

const REF = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const SHA = /^[0-9a-f]{40}$/;
const DIR_ID = /^[A-Za-z0-9#._-]+$/;
const TASKS = ".ai/tasks";
/** The files `pipeline check` reads; a change to any other file (usage.jsonl, evidence/, …) skips it (H4). */
const CHECKED = new Set(["status.json", "plan.md", "review-report.md", "qa-report.md", "decisions.md"]);
/** The files `pipeline plan` reads; a change to any of them runs it (BASE-140-B D4). */
const PLAN_FILES = new Set(["status.json", "plan.md", "plan-review.md", "decisions.md"]);

export type CiTemplate = "G1" | "G2" | "G3" | "G4";
export type CiHaltReason = RunFailure | "sha" | "cap";

export interface CiDeps {
  root: string;
  run: Runner;
  /** A working-tree file, by its path relative to `root`. Never throws. */
  read: (relPath: string) => FileRead;
  loadTask: (taskDir: string) => TaskInput;
  checkTask: (input: TaskInput) => CheckReport;
  /** The registration check of a report with keys (`checkRegistration` with no `--issues`). */
  debt: (report: CheckReport) => Promise<DebtReport>;
  /** `pipeline plan` of a task directory (`checkPlan`), by its path relative to `root`. */
  plan: (taskDir: string) => Promise<PlanResult>;
}

export interface AppendOnly {
  status: "pass" | "fail" | "skip";
  detail: string;
}
export type CiCheck = { status: "ok" } | { status: "fail"; failed: string[] } | { status: "skip"; detail: string };
/** `pipeline plan` per directory; a halt is per directory, like a debt halt (M3). */
export type CiPlan = CiCheck | { status: "halt"; reason: RunFailure };
export type CiDebt =
  | { status: "skip" }
  | { status: "registered" | "missing" | "halt"; calls: number; missing: string[]; halt?: DebtReport["halt"] };

export interface CiDir {
  id: string;
  files: string[];
  /** D0 `dir.name`: an id outside the accepted characters is not checked further. */
  name: "pass" | "fail";
  append_only: AppendOnly;
  check: CiCheck;
  plan: CiPlan;
  debt: CiDebt;
}

export interface CiReport {
  schema: 1;
  base: string | null;
  outcome: "pass" | "fail" | "halt";
  halt?: { template: CiTemplate; reason: CiHaltReason };
  dirs: CiDir[];
}

export type CiResult = { kind: "usage" } | { kind: "report"; report: CiReport };
type Git = (template: CiTemplate, args: string[]) => Promise<string>;

class Halt extends Error {
  constructor(
    readonly template: CiTemplate,
    readonly reason: CiHaltReason,
  ) {
    super(`${template} ${reason}`);
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Value equality of JSON values; object key order does not matter (H11). */
export function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((x, i) => jsonEqual(x, b[i]));
  if (!isObj(a) || !isObj(b)) return false;
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => Object.hasOwn(b, k) && jsonEqual(a[k], b[k]));
}

function transitionsOf(text: string): unknown[] | null {
  try {
    const v: unknown = JSON.parse(text);
    return isObj(v) && Array.isArray(v.transitions) ? v.transitions : null;
  } catch {
    return null;
  }
}

const NOT_TRANSITIONS = "is not a JSON object with a transitions array";

/**
 * A1 `transitions.append_only`: every base entry is kept, by value and in order; entries may only be appended.
 * `base` is null when status.json does not exist at the base. A detail names a side and an index, never content.
 */
export function appendOnly(base: FileRead | null, head: FileRead): AppendOnly {
  if (base === null) return { status: "pass", detail: "new" };
  if (head.kind === "missing") return { status: "fail", detail: "status.json removed" };
  if (base.kind !== "ok") return { status: "fail", detail: `base ${base.kind === "error" ? base.reason : NOT_TRANSITIONS}` };
  if (head.kind === "error") return { status: "fail", detail: `head ${head.reason}` };
  const b = transitionsOf(base.text);
  if (b === null) return { status: "fail", detail: `base ${NOT_TRANSITIONS}` };
  const h = transitionsOf(head.text);
  if (h === null) return { status: "fail", detail: `head ${NOT_TRANSITIONS}` };
  if (h.length < b.length) return { status: "fail", detail: `${h.length} of ${b.length} base entries remain` };
  const i = b.findIndex((entry, n) => !jsonEqual(entry, h[n]));
  if (i >= 0) return { status: "fail", detail: `transitions[${i}] differs from the base` };
  return { status: "pass", detail: "" };
}

/** G2 output (NUL-separated paths) grouped by task directory; paths directly under .ai/tasks are ignored. */
export function groupPaths(stdout: string): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const path of stdout.split("\0")) {
    if (!path.startsWith(`${TASKS}/`)) continue;
    const rel = path.slice(TASKS.length + 1);
    const slash = rel.indexOf("/");
    if (slash <= 0 || slash === rel.length - 1) continue;
    const id = rel.slice(0, slash);
    groups.set(id, [...(groups.get(id) ?? []), rel.slice(slash + 1)]);
  }
  return new Map([...groups].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

const validId = (id: string) => DIR_ID.test(id) && id !== "." && id !== "..";
const byteLength = (s: string) => new TextEncoder().encode(s).length;

export async function runCi(ref: string | undefined, deps: CiDeps): Promise<CiResult> {
  if (ref === undefined || !REF.test(ref)) return { kind: "usage" };
  const report: CiReport = { schema: 1, base: null, outcome: "pass", dirs: [] };
  const git: Git = async (template, args) => {
    const r = await deps.run("git", ["-C", deps.root, ...args]);
    if (r.kind === "error") throw new Halt(template, r.reason);
    return r.stdout;
  };
  try {
    const sha = (await git("G1", ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`])).trim();
    if (!SHA.test(sha)) throw new Halt("G1", "sha");
    report.base = sha;
    const groups = groupPaths(await git("G2", ["diff", "--name-only", "-z", "--no-renames", `${sha}...HEAD`, "--", TASKS]));
    if (groups.size > MAX_TASK_DIRS) throw new Halt("G2", "cap");
    for (const [id, files] of groups) report.dirs.push(await checkDir(id, files, sha, deps, git));
  } catch (e) {
    if (!(e instanceof Halt)) throw e;
    report.halt = { template: e.template, reason: e.reason };
  }
  report.outcome = outcomeOf(report);
  return { kind: "report", report };
}

async function checkDir(
  id: string,
  files: string[],
  sha: string,
  deps: CiDeps,
  git: Git,
): Promise<CiDir> {
  const dir: CiDir = {
    id,
    files,
    name: "pass",
    append_only: { status: "skip", detail: "status.json unchanged" },
    check: { status: "skip", detail: "no checked file changed" },
    plan: { status: "skip", detail: "no plan file changed" },
    debt: { status: "skip" },
  };
  if (!validId(id)) {
    dir.name = "fail";
    dir.append_only = { status: "skip", detail: "invalid directory name" };
    dir.check = { status: "skip", detail: "invalid directory name" };
    dir.plan = { status: "skip", detail: "invalid directory name" };
    return dir;
  }
  const statusPath = `${TASKS}/${id}/status.json`;
  const head = deps.read(statusPath);
  if (files.includes("status.json")) {
    const listed = await git("G3", ["ls-tree", "-z", "--name-only", sha, "--", statusPath]);
    dir.append_only = appendOnly(listed === "" ? null : await baseRead(sha, statusPath, git), head);
  }
  if (files.some((f) => PLAN_FILES.has(f))) {
    dir.plan = head.kind === "missing" ? { status: "skip", detail: "no status.json" } : ciPlan(await deps.plan(`${TASKS}/${id}`));
  }
  if (!files.some((f) => CHECKED.has(f))) return dir;
  if (head.kind === "missing") {
    dir.check = { status: "skip", detail: "no status.json" };
    return dir;
  }
  const checked = deps.checkTask(deps.loadTask(`${TASKS}/${id}`));
  const failed = checked.checks.filter((c) => c.status === "fail").map((c) => c.id);
  dir.check = checked.ok ? { status: "ok" } : { status: "fail", failed };
  const k16 = checked.checks.find((c) => c.id === "K16");
  if (k16?.status === "pass" && checked.keys.length > 0) {
    const d = await deps.debt(checked);
    dir.debt = { status: d.outcome, calls: d.calls, missing: d.keys.filter((k) => k.status === "missing").map((k) => k.key), halt: d.halt };
  }
  return dir;
}

function ciPlan(r: PlanResult): CiPlan {
  if (r.halt) return { status: "halt", reason: r.halt };
  if (r.report.exempt) return { status: "skip", detail: EXEMPT };
  if (r.report.ok) return { status: "ok" };
  return { status: "fail", failed: r.report.checks.filter((c) => c.status === "fail").map((c) => c.id) };
}

const TOO_LARGE: FileRead = { kind: "error", reason: `larger than ${MAX_FILE_BYTES} bytes` };

/** The base version of status.json (G4), bounded like a working-tree read: one over MAX_FILE_BYTES fails A1 naming base. */
async function baseRead(sha: string, path: string, git: Git): Promise<FileRead> {
  try {
    const text = await git("G4", ["show", `${sha}:${path}`]);
    return byteLength(text) > MAX_FILE_BYTES ? TOO_LARGE : { kind: "ok", text };
  } catch (e) {
    // The runner's output cap is larger than MAX_FILE_BYTES, so its overflow is an oversized base too.
    if (e instanceof Halt && e.reason === "overflow") return TOO_LARGE;
    throw e;
  }
}

const dirFailed = (d: CiDir) =>
  d.name === "fail" || d.append_only.status === "fail" || d.check.status === "fail" || d.plan.status === "fail" || d.debt.status === "missing";

function outcomeOf(r: CiReport): CiReport["outcome"] {
  if (r.halt || r.dirs.some((d) => d.debt.status === "halt" || d.plan.status === "halt")) return "halt";
  return r.dirs.some(dirFailed) ? "fail" : "pass";
}

export function ciExitCode(r: CiReport): 0 | 1 | 2 {
  return r.outcome === "halt" ? 2 : r.outcome === "fail" ? 1 : 0;
}

const HALT_TEXT: Record<CiHaltReason, string> = {
  missing: "command not found",
  exit: "non-zero exit",
  timeout: "timed out",
  overflow: "output over the cap",
  sha: "the base is not a 40-hex commit",
  cap: `more than ${MAX_TASK_DIRS} task directories changed`,
};

function renderAppendOnly(a: AppendOnly): string {
  if (a.status === "fail") return `A1 fail — ${a.detail}`;
  return a.detail ? `A1 ${a.status} (${a.detail})` : `A1 ${a.status}`;
}

function renderCheck(c: CiCheck): string {
  if (c.status === "ok") return "check ok";
  if (c.status === "fail") return `check FAIL ${c.failed.join(",")}`;
  return `check skip (${c.detail})`;
}

function renderPlanOutcome(p: CiPlan): string {
  if (p.status === "halt") return `plan halt (git ${PLAN_HALT_TEXT[p.reason]})`;
  if (p.status === "ok") return "plan ok";
  if (p.status === "fail") return `plan FAIL ${p.failed.join(",")}`;
  return `plan skip (${p.detail})`;
}

function renderDebtOutcome(d: CiDebt): string {
  if (d.status === "skip") return "debt skip";
  return d.halt ? `debt halt (${d.halt.template} ${d.halt.reason})` : `debt ${d.status}`;
}

/** Plain-text rendering: ids, check ids, counts and keys only. A rejected id is quoted, so it cannot break a line. */
export function renderCi(r: CiReport): string {
  const head = r.outcome.toUpperCase();
  const out = [`pipeline ci ${r.base?.slice(0, 7) ?? "-"}: ${head} (${r.dirs.length} task dir(s))`];
  for (const d of r.dirs) {
    if (d.name === "fail") {
      out.push(`${JSON.stringify(d.id)}: D0 dir.name fail — not ${DIR_ID.source}`);
      continue;
    }
    out.push(`${d.id}: ${renderAppendOnly(d.append_only)}; ${renderCheck(d.check)}; ${renderPlanOutcome(d.plan)}; ${renderDebtOutcome(d.debt)}`);
    if (d.debt.status === "missing" && d.debt.missing.length) {
      out.push("  missing keys, ready to paste:", ...d.debt.missing.map((k) => `    [${k}]`));
      out.push("  a just-registered item may not be indexed yet: wait and rerun the job");
    }
  }
  if (r.halt) out.push(`halt: ${r.halt.template} ${HALT_TEXT[r.halt.reason]}`);
  else if (r.dirs.length === 0) out.push("no task directory changed");
  return out.join("\n");
}
