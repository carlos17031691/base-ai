/**
 * Data for `base-ai dashboard` (BASE-101-D1, epic #101). Every value comes from `checkTask`, `parseStatus` or the
 * U2 usage functions, run in process: this module adds no pipeline rule and no price of its own.
 *
 * Task files are untrusted input. Their text is returned as JSON string data only, never interpreted.
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { checkTask, parseStatus, type CheckReport, type FileRead, type NextActor } from "./pipeline-check.js";
import { loadTask } from "./pipeline-files.js";
import { readUsageText } from "./usage-files.js";
import { buildUsageReport, parseUsageLines, recordCost, type Pricing, type UsageLine, type UsageReport, type UsageTotals } from "./usage.js";

export const TASK_ID = /^[A-Za-z0-9#._-]+$/;
export const isTaskId = (id: string) => TASK_ID.test(id);

const taskPath = (id: string) => `.ai/tasks/${id}`;

/**
 * The task directories, sorted by name: real directories (not symlinks) whose name passes the id regex (H2).
 * Every other entry is counted in `skipped` and never read. A missing `.ai/tasks/` is an empty listing.
 */
export function listTaskIds(root: string): { ids: string[]; skipped: number } {
  let entries;
  try {
    entries = readdirSync(join(root, ".ai", "tasks"), { withFileTypes: true });
  } catch {
    return { ids: [], skipped: 0 };
  }
  const ids: string[] = [];
  let skipped = 0;
  for (const e of entries) {
    if (e.isDirectory() && isTaskId(e.name)) ids.push(e.name);
    else skipped++;
  }
  ids.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return { ids, skipped };
}

export interface TaskEntry {
  id: string;
  /** From the first line of plan.md (H3 of BASE-101-D2); null without a plan or a matching line. */
  title: string | null;
  ticket: string | null;
  state: string | null;
  ok: boolean;
  /** K1's detail when status.json was not accepted, else null. */
  problem: string | null;
  nextActor: NextActor | null;
  review: { rounds: number; verdict: string | null } | null;
  qa: { rounds: number; verdict: string | null } | null;
  updated_at: string | null;
  tokens: UsageTotals | null;
  usage_error: string | null;
}

interface Checked {
  report: CheckReport;
  status: ReturnType<typeof parseStatus>["status"];
  title: string | null;
  reads: Record<(typeof TASK_FILES)[number], FileRead>;
}

/** The files `loadTask` reads, in the order the detail lists them. */
const TASK_FILES = ["status.json", "plan.md", "review-report.md", "qa-report.md", "decisions.md"] as const;
const PLAN_TITLE = /^# Plan: .+? [—-] (.+)$/;
// Backticks and C0, DEL, C1 and bidi controls: the title is untrusted text shown in the UI.
const TITLE_STRIP = /[`\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

/** The plan title: the first line's text after "# Plan: <ticket> — ", cleaned and cut to 80 characters. */
export function planTitle(plan: FileRead): string | null {
  if (plan.kind !== "ok") return null;
  const m = PLAN_TITLE.exec(plan.text.split("\n", 1)[0].replace(/\r$/, ""));
  if (m === null) return null;
  const title = m[1].replace(TITLE_STRIP, "").trim();
  if (title === "") return null;
  const chars = Array.from(title);
  return chars.length > 80 ? `${chars.slice(0, 79).join("")}…` : title;
}

function check(root: string, id: string): Checked {
  const input = loadTask(root, taskPath(id));
  const report = checkTask(input);
  const status = input.status.kind === "ok" ? parseStatus(input.status.text).status : undefined;
  const reads = {
    "status.json": input.status,
    "plan.md": input.plan,
    "review-report.md": input.review,
    "qa-report.md": input.qa,
    "decisions.md": input.decisions ?? { kind: "missing" },
  };
  return { report, status, title: planTitle(input.plan), reads };
}

const updatedAt = (status: Checked["status"]) => {
  const v = status === undefined ? undefined : (status as unknown as Record<string, unknown>).updated_at;
  return typeof v === "string" ? v : null;
};

/**
 * The usage text of a task, or the reader's error with the path relative to the root. An errno error (for
 * example EACCES) carries an absolute path in its message, so only its code is kept.
 */
function usageText(root: string, id: string): { text: string } | { error: string } {
  try {
    return { text: readUsageText(root, taskPath(id)) };
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return { error: code === undefined ? (e as Error).message : `${taskPath(id)}/usage.jsonl cannot be read (${code})` };
  }
}

function entry(root: string, id: string, pricing: Pricing): TaskEntry {
  const { report, status, title } = check(root, id);
  const k1 = report.checks.find((c) => c.id === "K1");
  const usage = usageText(root, id);
  const f = report.facts;
  return {
    id,
    title,
    ticket: report.ticket,
    state: f.state,
    ok: report.ok,
    problem: k1 !== undefined && k1.status === "fail" ? k1.detail : null,
    nextActor: f.nextActor,
    review: { rounds: f.review.rounds, verdict: f.review.verdict },
    qa: { rounds: f.qa.rounds, verdict: f.qa.verdict },
    updated_at: updatedAt(status),
    tokens: "text" in usage ? buildUsageReport(id, usage.text, pricing).total : null,
    usage_error: "error" in usage ? usage.error : null,
  };
}

/** `GET /api/tasks`. Each task is built in isolation, so one that throws never affects the others. */
export function listTasks(root: string, pricing: Pricing): { schema: 1; tasks: TaskEntry[]; skipped: number } {
  const { ids, skipped } = listTaskIds(root);
  const tasks = ids.map((id) => {
    try {
      return entry(root, id, pricing);
    } catch {
      const failed: TaskEntry = {
        id,
        title: null,
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
      };
      return failed;
    }
  });
  return { schema: 1, tasks, skipped };
}

export interface TaskDetail {
  schema: 1;
  id: string;
  title: string | null;
  ticket: string | null;
  ok: boolean;
  updated_at: string | null;
  transitions: { from: string | null; to: string; agent: string; timestamp: string; note: string }[];
  checks: CheckReport["checks"];
  facts: CheckReport["facts"];
  keys: { key: string; file: string; line: number }[];
  taskDir: string;
  /** The task files the checks read, with absolute paths; their text is never included (H3 of BASE-101-D2). */
  files: { name: string; path: string; present: boolean }[];
  usage: { report: UsageReport; records: (UsageLine & { cost_usd: number | null })[] } | { error: string };
}

/** `GET /api/tasks/<id>`. The caller has already checked `id` against `listTaskIds`. */
export function taskDetail(root: string, id: string, pricing: Pricing): TaskDetail {
  const { report, status, title, reads } = check(root, id);
  const usage = usageText(root, id);
  let usageOut: TaskDetail["usage"];
  if ("text" in usage) {
    // The same line rule as the report, so the listed records and the totals never disagree.
    const records = parseUsageLines(usage.text).records.map((r) => ({ ...r, cost_usd: recordCost(r, pricing) }));
    usageOut = { report: buildUsageReport(id, usage.text, pricing), records };
  } else {
    usageOut = { error: usage.error };
  }
  return {
    schema: 1,
    id,
    title,
    ticket: report.ticket,
    ok: report.ok,
    updated_at: updatedAt(status),
    transitions: (status?.transitions ?? []).map(({ from, to, agent, timestamp, note }) => ({ from, to, agent, timestamp, note })),
    checks: report.checks,
    facts: report.facts,
    keys: report.keys.map(({ key, file, line }) => ({ key, file, line })),
    taskDir: report.taskDir,
    files: TASK_FILES.map((name) => ({ name, path: join(report.taskDir, name), present: reads[name].kind !== "missing" })),
    usage: usageOut,
  };
}
