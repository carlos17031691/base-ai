/**
 * Registration cross-check of a task's To register keys against GitHub issues (BASE-071-P2, issue #71):
 * supervisor.md C16 "Repository" and supervisor/registration-match.md "Match".
 *
 * Pure: every process call goes through the injected `Runner` (pipeline-gh.ts is the real one), so the
 * matching logic is tested with a fake runner and no network.
 */
import { RULE, checkTask, type CheckReport } from "./pipeline-check.js";
import { loadTask } from "./pipeline-files.js";

export type RunResult = { kind: "ok"; stdout: string } | { kind: "error"; reason: RunFailure };
export type RunFailure = "missing" | "exit" | "timeout" | "overflow";
/** Async (BASE-101-D4 H3) so a long check never blocks the dashboard's event loop. */
export type Runner = (cmd: string, args: string[]) => Promise<RunResult>;

export const MAX_GH_CALLS = 60;

export type HaltReason = RunFailure | "json" | "remote" | "cap";
export type Template = "T5" | "T6" | "T7";

export interface DebtKey {
  key: string;
  file: string;
  line: number;
  status: "registered" | "missing" | "unchecked";
  issue?: number;
  state?: "open" | "closed";
}

export interface DebtReport {
  schema: 1;
  rule: string;
  ticket: string | null;
  repo: string | null;
  outcome: "registered" | "missing" | "halt";
  halt?: { template: Template; reason: HaltReason };
  /** Number of `gh` calls made (T6 + T7). */
  calls: number;
  keys: DebtKey[];
}

const PART = /^[A-Za-z0-9._-]+$/;

/** `owner/name` of a github.com remote URL in an accepted form, or null. Never returns the URL itself. */
export function parseRemote(url: string): string | null {
  const u = url.trim();
  const m =
    /^https:\/\/(?:[^@/\s]+@)?github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(u) ??
    /^git@github\.com:([^/\s]+)\/([^/\s]+?)(?:\.git)?$/.exec(u) ??
    /^ssh:\/\/git@github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?$/.exec(u);
  if (!m || !PART.test(m[1]) || !PART.test(m[2])) return null;
  return `${m[1]}/${m[2]}`;
}

interface ViewedIssue {
  number: number;
  state: "open" | "closed";
  texts: string[];
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function parseJson(stdout: string): unknown {
  try {
    return JSON.parse(stdout);
  } catch {
    return undefined;
  }
}

/** The T7 shape: number, state, title, body and comments[].body. */
function parseView(stdout: string): ViewedIssue | null {
  const v = parseJson(stdout);
  if (!isObj(v) || typeof v.number !== "number" || typeof v.state !== "string" || typeof v.body !== "string") return null;
  if (!Array.isArray(v.comments) || !v.comments.every((c) => isObj(c) && typeof c.body === "string")) return null;
  const state = v.state.toLowerCase();
  if (state !== "open" && state !== "closed") return null;
  return { number: v.number, state, texts: [v.body, ...v.comments.map((c) => (c as { body: string }).body)] };
}

/** The T6 shape: an array of objects with a numeric `number`. */
function parseList(stdout: string): number[] | null {
  const v = parseJson(stdout);
  if (!Array.isArray(v) || !v.every((x) => isObj(x) && typeof x.number === "number")) return null;
  return v.map((x) => (x as { number: number }).number);
}

const isRegistered = (k: DebtKey) => k.status === "registered";

class Halt extends Error {
  constructor(
    readonly template: Template,
    readonly reason: HaltReason,
  ) {
    super(`${template} ${reason}`);
  }
}

/** Runs C16 for the keys of a passing `pipeline check` report. `issues` are the invocation-named issues. */
export async function checkRegistration(report: CheckReport, issues: number[], run: Runner): Promise<DebtReport> {
  const keys: DebtKey[] = report.keys.map((k) => ({ ...k, status: "unchecked" }));
  const out: DebtReport = { schema: 1, rule: RULE, ticket: report.ticket, repo: null, outcome: "registered", calls: 0, keys };
  if (keys.length === 0) return out;

  const viewed = new Set<number>();
  const gh = async (template: Template, args: string[]): Promise<string> => {
    if (out.calls >= MAX_GH_CALLS) throw new Halt(template, "cap");
    out.calls++;
    const r = await run("gh", args);
    if (r.kind === "error") throw new Halt(template, r.reason);
    return r.stdout;
  };
  const view = async (n: number) => {
    if (viewed.has(n)) return;
    viewed.add(n);
    const issue = parseView(await gh("T7", ["issue", "view", String(n), "--repo", out.repo as string, "--json", "number,state,title,body,comments"]));
    if (!issue) throw new Halt("T7", "json");
    for (const k of keys) {
      if (k.status !== "registered" && issue.texts.some((text) => text.includes(`[${k.key}]`))) {
        Object.assign(k, { status: "registered", issue: issue.number, state: issue.state });
      }
    }
  };

  try {
    const remote = await run("git", ["-C", report.taskDir, "remote", "get-url", "origin"]);
    if (remote.kind === "error") throw new Halt("T5", remote.reason);
    out.repo = parseRemote(remote.stdout);
    if (out.repo === null) throw new Halt("T5", "remote");

    for (const n of issues) await view(n);
    for (const k of keys) {
      if (k.status === "registered") continue;
      const search = `"${k.key}" in:body,comments`;
      const found = parseList(await gh("T6", ["issue", "list", "--repo", out.repo, "--state", "all", "--search", search, "--json", "number,state,title", "--limit", "20"]));
      if (!found) throw new Halt("T6", "json");
      // Every candidate not yet viewed is viewed once (registration-match.md step 2), so the call count matches the supervisor's.
      for (const n of found) await view(n);
      // view() mutates k.status, so re-read it through a function call.
      if (!isRegistered(k)) k.status = "missing";
    }
  } catch (e) {
    if (!(e instanceof Halt)) throw e;
    out.outcome = "halt";
    out.halt = { template: e.template, reason: e.reason };
    return out;
  }
  out.outcome = keys.every((k) => k.status === "registered") ? "registered" : "missing";
  return out;
}

const HALT_TEXT: Record<HaltReason, string> = {
  missing: "command not found",
  exit: "non-zero exit (not authenticated, network error, rate limit or unresolvable issue)",
  timeout: "timed out",
  overflow: "output over the cap",
  json: "output is not the expected JSON",
  remote: "origin is not a github.com remote in an accepted form",
  cap: `the next call would exceed ${MAX_GH_CALLS} gh calls`,
};

/** The halt explanation shared by the CLI and the dashboard (BASE-101-D4 H7). */
export function haltText(reason: HaltReason): string {
  return HALT_TEXT[reason];
}

/** The task's check report when its keys are computed (K16 passes), or K16's status: `pipeline debt`'s gate. */
export type TaskKeys = { kind: "keys"; status: string } | { kind: "ready"; report: CheckReport };

export function taskKeys(root: string, dir: string): TaskKeys {
  const report = checkTask(loadTask(root, dir));
  const k16 = report.checks.find((c) => c.id === "K16");
  return k16?.status === "pass" ? { kind: "ready", report } : { kind: "keys", status: k16?.status ?? "missing" };
}

/** `pipeline debt`'s sequence, shared with the dashboard (BASE-101-D4): the K16 gate, then the registration check. */
export type DebtOutcome = { kind: "keys"; status: string } | { kind: "debt"; report: DebtReport };

export async function debtForTask(root: string, dir: string, issues: number[], run: Runner): Promise<DebtOutcome> {
  const keys = taskKeys(root, dir);
  if (keys.kind === "keys") return keys;
  return { kind: "debt", report: await checkRegistration(keys.report, issues, run) };
}

/** Plain-text rendering: keys, issue numbers and states only; never a URL, stderr or issue text. */
export function renderDebt(r: DebtReport): string {
  const head = r.outcome === "registered" ? "REGISTERED" : r.outcome === "missing" ? "MISSING" : "HALT";
  const out = [`pipeline debt ${r.ticket ?? "(unknown)"}: ${head} (repo ${r.repo ?? "-"}, ${r.calls} gh call(s))`];
  for (const k of r.keys) {
    out.push(k.status === "registered" ? `  ${k.key} — registered #${k.issue} (${k.state})` : `  ${k.key} — ${k.status}`);
  }
  if (r.halt) out.push(`halt: ${r.halt.template} ${haltText(r.halt.reason)}; could not check, so nothing unchecked counts as registered`);
  const missing = r.keys.filter((k) => k.status === "missing");
  if (missing.length) {
    out.push("missing keys, ready to paste:", ...missing.map((k) => `  [${k.key}]`));
    out.push("a just-registered item may not be indexed yet: wait and run again, or pass --issues <n,…>");
  }
  return out.join("\n");
}
