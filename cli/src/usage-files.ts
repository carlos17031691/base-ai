/**
 * I/O for `base-ai usage record` (BASE-101-U1): bounded stdin, transcript path checks, `.git/HEAD`,
 * the usage-file scan and the O_APPEND write. Every path returns normally; the caller exits 0.
 */
import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readSync, readdirSync, realpathSync, statSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";
import {
  DEADLINE_MS,
  MAX_STDIN_BYTES,
  MAX_TRANSCRIPT_BYTES,
  buildRecords,
  branchFromHead,
  chooseRole,
  chooseTicket,
  newMessages,
  parsePayload,
  parseTranscript,
  recordedIds,
  stderrLine,
  transcriptFor,
  type Reason,
} from "./usage.js";

export type StdinResult = { kind: "ok"; text: string } | { kind: "error"; reason: "stdin" | "deadline" };

/** Reads stdin up to `max` bytes; an unref'd timer ends a stream that never closes. */
export function readStdin(stream: NodeJS.ReadableStream, max = MAX_STDIN_BYTES, ms = DEADLINE_MS): Promise<StdinResult> {
  return new Promise((done) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const finish = (r: StdinResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      done(r);
    };
    const timer = setTimeout(() => finish({ kind: "error", reason: "deadline" }), ms);
    timer.unref();
    stream.on("data", (c: Buffer | string) => {
      const b = typeof c === "string" ? Buffer.from(c) : c;
      size += b.length;
      if (size > max) finish({ kind: "error", reason: "stdin" });
      else chunks.push(b);
    });
    stream.on("end", () => finish({ kind: "ok", text: Buffer.concat(chunks).toString("utf8") }));
    stream.on("error", () => finish({ kind: "error", reason: "stdin" }));
  });
}

/** A regular file of at most `max` bytes, opened without following a final symlink, read through one descriptor. */
function readRegular(path: string, max: number): string | null {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > max) return null;
    const buf = Buffer.alloc(st.size + 1);
    let n = 0;
    for (let r = -1; r !== 0 && n <= st.size; n += r) r = readSync(fd, buf, n, st.size + 1 - n, null);
    return n > st.size ? null : buf.subarray(0, n).toString("utf8");
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** The transcript text, only when the path is under the projects directory with no symlinked component (H5). */
export function readTranscript(path: string, projectsDir: string, max = MAX_TRANSCRIPT_BYTES): string | null {
  try {
    if (!isAbsolute(path)) return null;
    const base = realpathSync(projectsDir);
    const resolved = resolve(path);
    if (realpathSync(resolved) !== resolved || !resolved.startsWith(base + sep)) return null;
    return readRegular(resolved, max);
  } catch {
    return null;
  }
}

/** The branch of `<root>`, following a worktree's `gitdir:` file; no git process. */
export function readBranch(root: string): string | null {
  const dotGit = join(root, ".git");
  let gitDir = dotGit;
  try {
    if (statSync(dotGit).isFile()) {
      const m = /^gitdir:\s*(.+?)\s*$/m.exec(readRegular(dotGit, 4096) ?? "");
      if (!m) return null;
      gitDir = resolve(root, m[1]);
    }
  } catch {
    return null;
  }
  const head = readRegular(join(gitDir, "HEAD"), 4096);
  return head === null ? null : branchFromHead(head);
}

/**
 * Every `.ai/tasks/*\/usage.jsonl` and `.ai/usage/unattributed.jsonl` (H2). Null when one exists but cannot be
 * read within the bound: without it the mark could be lost and the session counted again, so nothing is written.
 */
function usageTexts(root: string): string[] | null {
  const files = [join(root, ".ai", "usage", "unattributed.jsonl")];
  try {
    for (const d of readdirSync(join(root, ".ai", "tasks"), { withFileTypes: true })) {
      if (d.isDirectory()) files.push(join(root, ".ai", "tasks", d.name, "usage.jsonl"));
    }
  } catch {
    // No tasks directory: only unattributed.jsonl is scanned.
  }
  const texts: string[] = [];
  for (const f of files) {
    if (!existsSync(f)) continue;
    const t = readRegular(f, MAX_TRANSCRIPT_BYTES);
    if (t === null) return null;
    texts.push(t);
  }
  return texts;
}

const taskDirExists = (root: string) => (id: string) => {
  try {
    // lstat: a symlinked task directory is refused, matching the scan, which skips symlinks.
    return lstatSync(join(root, ".ai", "tasks", id)).isDirectory();
  } catch {
    return false;
  }
};

/** Appends each line with one write through O_APPEND; a symlinked target is refused by O_NOFOLLOW. */
export function appendLines(target: string, lines: string[]): boolean {
  let fd: number | undefined;
  try {
    fd = openSync(target, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o644);
    for (const l of lines) writeSync(fd, `${l}\n`);
    return true;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export interface UsageDeps {
  root: string;
  stdin: NodeJS.ReadableStream;
  env: NodeJS.ProcessEnv;
  now: () => number;
  stderr: (line: string) => void;
  deadlineMs?: number;
}

/** Runs `usage record` once. Always resolves; every failure writes one stderr line and nothing else. */
export async function runUsageRecord(deps: UsageDeps): Promise<void> {
  const start = deps.now();
  const deadline = start + (deps.deadlineMs ?? DEADLINE_MS);
  const fail = (r: Reason) => deps.stderr(stderrLine(r));
  const late = () => deps.now() > deadline;

  const input = await readStdin(deps.stdin, MAX_STDIN_BYTES, Math.max(0, deadline - start));
  if (input.kind === "error") return fail(input.reason);
  const payload = parsePayload(input.text);
  if (!payload) return fail("payload");

  const projects = deps.env.CLAUDE_CONFIG_DIR ? join(deps.env.CLAUDE_CONFIG_DIR, "projects") : join(homedir(), ".claude", "projects");
  const text = readTranscript(transcriptFor(payload), projects);
  if (text === null) return fail("transcript");
  const messages = parseTranscript(text, deps.now, deadline);
  if (messages === "deadline") return fail("deadline");

  const choice = chooseTicket(deps.env.BASE_AI_TICKET, readBranch(deps.root), taskDirExists(deps.root));
  if (choice.envIgnored) fail("ticket-env");
  const usage = usageTexts(deps.root);
  if (usage === null) return fail("usage-file");
  const fresh = newMessages(messages, recordedIds(usage, payload.sessionId));
  if (fresh.length === 0) return;
  const status = choice.ticket === null ? null : readRegular(join(deps.root, ".ai", "tasks", choice.ticket, "status.json"), 2 * 1024 * 1024);
  const records = buildRecords(fresh, {
    now: deps.now(),
    ticket: choice.ticket,
    agent: chooseRole(payload, status),
    sessionId: payload.sessionId,
    attribution: choice.attribution,
  });
  if (late()) return fail("deadline");

  let target: string;
  if (choice.ticket === null) {
    try {
      mkdirSync(join(deps.root, ".ai", "usage"), { recursive: true });
    } catch {
      return fail("write");
    }
    target = join(deps.root, ".ai", "usage", "unattributed.jsonl");
  } else {
    target = join(deps.root, ".ai", "tasks", choice.ticket, "usage.jsonl");
  }
  // The deadline is not checked again once writing starts.
  if (!appendLines(target, records.map((r) => JSON.stringify(r)))) fail("write");
}
