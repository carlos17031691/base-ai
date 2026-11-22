/**
 * Per-run token usage from Claude Code hooks (BASE-101-U1, epic #101). Pure: no I/O and an injected clock.
 * usage-files.ts does the reading and the append.
 *
 * Only counters and identifiers reach a record; prompt and response text is never read into it.
 */

export const DEADLINE_MS = 5_000;
export const MAX_STDIN_BYTES = 1024 * 1024;
export const MAX_TRANSCRIPT_BYTES = 50 * 1024 * 1024;

/** Reason classes for the single stderr line; never payload, path or transcript content. */
export type Reason = "stdin" | "payload" | "transcript" | "usage-file" | "deadline" | "write" | "ticket-env" | "internal";
export const REASON_TEXT: Record<Reason, string> = {
  stdin: "stdin is unreadable or over 1 MiB",
  payload: "hook payload is not valid",
  transcript: "transcript rejected (missing, not a regular file, symlinked, over 50 MiB or outside the projects directory)",
  "usage-file": "a usage file is unreadable or over 50 MiB; nothing written",
  deadline: "time limit reached; nothing written",
  write: "usage file could not be written",
  "ticket-env": "BASE_AI_TICKET ignored (invalid or no such task directory)",
  internal: "internal error; nothing written",
};
export const stderrLine = (r: Reason) => `base-ai usage: ${REASON_TEXT[r]}`;

export interface HookPayload {
  event: "Stop" | "SubagentStop";
  sessionId: string;
  transcriptPath: string;
  agentTranscriptPath?: string;
  agentType?: string;
}

const SESSION = /^[A-Za-z0-9._-]{1,128}$/;
const ROLE = /^[a-z][a-z0-9_-]{0,63}$/;
const TICKET = /^[A-Za-z0-9#._-]+$/;
// message.id and message.model reach a versioned file, so both are bounded to a safe charset.
const MESSAGE_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isAbs = (v: unknown): v is string => typeof v === "string" && v.startsWith("/") && !v.includes("\0");

/** Validates the untrusted hook stdin. Unknown keys are ignored. */
export function parsePayload(text: string): HookPayload | null {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isObj(v)) return null;
  const event = v.hook_event_name;
  if (event !== "Stop" && event !== "SubagentStop") return null;
  if (typeof v.session_id !== "string" || !SESSION.test(v.session_id)) return null;
  if (!isAbs(v.transcript_path)) return null;
  const p: HookPayload = { event, sessionId: v.session_id, transcriptPath: v.transcript_path };
  if (event === "SubagentStop") {
    if (v.agent_transcript_path !== undefined) {
      if (!isAbs(v.agent_transcript_path)) return null;
      p.agentTranscriptPath = v.agent_transcript_path;
    }
    if (typeof v.agent_type === "string") p.agentType = v.agent_type;
  }
  return p;
}

/** The transcript to parse: the subagent's own file when given, else the payload's transcript (P-1). */
export const transcriptFor = (p: HookPayload) => p.agentTranscriptPath ?? p.transcriptPath;

export interface Message {
  id: string;
  model: string;
  input_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  output_tokens: number;
}
const COUNTERS = ["input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens", "output_tokens"] as const;
const isCount = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

/**
 * Assistant messages in order of first appearance, each `message.id` once with the maximum of each counter
 * over its lines (H3). Returns "deadline" when the clock passes `deadline` between lines.
 */
export function parseTranscript(text: string, now: () => number, deadline: number): Message[] | "deadline" {
  const byId = new Map<string, Message>();
  for (const line of text.split("\n")) {
    if (now() > deadline) return "deadline";
    if (!line.trim()) continue;
    let d: unknown;
    try {
      d = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isObj(d) || d.type !== "assistant" || !isObj(d.message)) continue;
    const m = d.message;
    if (typeof m.id !== "string" || !MESSAGE_ID.test(m.id) || !isObj(m.usage)) continue;
    const u = m.usage;
    if (!COUNTERS.every((c) => isCount(u[c]))) continue;
    const prev = byId.get(m.id);
    if (!prev) {
      byId.set(m.id, {
        id: m.id,
        model: typeof m.model === "string" && MESSAGE_ID.test(m.model) ? m.model : "unknown",
        input_tokens: u.input_tokens as number,
        cache_creation_input_tokens: u.cache_creation_input_tokens as number,
        cache_read_input_tokens: u.cache_read_input_tokens as number,
        output_tokens: u.output_tokens as number,
      });
    } else {
      for (const c of COUNTERS) prev[c] = Math.max(prev[c], u[c] as number);
    }
  }
  return [...byId.values()];
}

/** The `last_message_id` of every record of `sessionId` in the given usage files' text. */
export function recordedIds(usageTexts: string[], sessionId: string): Set<string> {
  const ids = new Set<string>();
  for (const text of usageTexts) {
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const r: unknown = JSON.parse(line);
        if (isObj(r) && r.session_id === sessionId && typeof r.last_message_id === "string") ids.add(r.last_message_id);
      } catch {
        // A corrupt line is skipped; it cannot move the mark.
      }
    }
  }
  return ids;
}

/** The messages after the high-water mark: the latest position of any recorded id in this transcript. */
export function newMessages(messages: Message[], recorded: Set<string>): Message[] {
  let mark = -1;
  messages.forEach((m, i) => {
    if (recorded.has(m.id)) mark = i;
  });
  return messages.slice(mark + 1);
}

/** Role: "coordinator" for Stop (H4); for SubagentStop the payload type, else the latest status.json agent, else "unknown". */
export function chooseRole(p: HookPayload, statusText: string | null): string {
  if (p.event === "Stop") return "coordinator";
  if (p.agentType !== undefined && ROLE.test(p.agentType)) return p.agentType;
  if (statusText !== null) {
    try {
      const s: unknown = JSON.parse(statusText);
      const t = isObj(s) && Array.isArray(s.transitions) ? s.transitions : [];
      const last: unknown = t[t.length - 1];
      if (isObj(last) && typeof last.agent === "string" && ROLE.test(last.agent)) return last.agent;
    } catch {
      // Fall through to "unknown".
    }
  }
  return "unknown";
}

/** A ticket id usable as a task directory name: the K2 charset, and not "." or "..". */
export const isTicketId = (id: string) => TICKET.test(id) && !/^\.+$/.test(id);

/** The branch name from `.git/HEAD`, or null when detached or unreadable. */
export function branchFromHead(head: string): string | null {
  const m = /^ref: refs\/heads\/(\S+)\s*$/.exec(head);
  return m ? m[1] : null;
}

/** Candidate ids from a branch: the `-`-prefixes of the segment after the last `/`, longest first. */
export function ticketCandidates(branch: string): string[] {
  const parts = branch.slice(branch.lastIndexOf("/") + 1).split("-");
  const out: string[] = [];
  for (let n = parts.length; n >= 1; n--) {
    const id = parts.slice(0, n).join("-");
    if (isTicketId(id)) out.push(id);
  }
  return out;
}

export type Attribution = "env" | "branch" | "none";
export interface TicketChoice {
  ticket: string | null;
  attribution: Attribution;
  /** True when BASE_AI_TICKET was set but ignored (one warning). */
  envIgnored: boolean;
}

/** H1: BASE_AI_TICKET, then the branch, then unattributed. `exists` says whether a task directory exists. */
export function chooseTicket(env: string | undefined, branch: string | null, exists: (id: string) => boolean): TicketChoice {
  let envIgnored = false;
  if (env !== undefined && env !== "") {
    if (isTicketId(env) && exists(env)) return { ticket: env, attribution: "env", envIgnored };
    envIgnored = true;
  }
  for (const id of branch === null ? [] : ticketCandidates(branch)) {
    if (exists(id)) return { ticket: id, attribution: "branch", envIgnored };
  }
  return { ticket: null, attribution: "none", envIgnored };
}

export interface UsageRecord {
  schema: 1;
  ts: string;
  ticket: string | null;
  agent: string;
  model: string;
  session_id: string;
  first_message_id: string;
  last_message_id: string;
  messages: number;
  input_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  output_tokens: number;
  source: "claude-code-hook";
  attribution: Attribution;
}

/** One record per model, in order of first appearance (H6). Key order is fixed. */
export function buildRecords(
  messages: Message[],
  ctx: { now: number; ticket: string | null; agent: string; sessionId: string; attribution: Attribution },
): UsageRecord[] {
  const ts = new Date(ctx.now).toISOString().replace(/\.\d{3}Z$/, "Z");
  const groups = new Map<string, Message[]>();
  for (const m of messages) groups.set(m.model, [...(groups.get(m.model) ?? []), m]);
  return [...groups].map(([model, ms]) => {
    const sum = (c: (typeof COUNTERS)[number]) => ms.reduce((n, m) => n + m[c], 0);
    return {
      schema: 1,
      ts,
      ticket: ctx.ticket,
      agent: ctx.agent,
      model,
      session_id: ctx.sessionId,
      first_message_id: ms[0].id,
      last_message_id: ms[ms.length - 1].id,
      messages: ms.length,
      input_tokens: sum("input_tokens"),
      cache_creation_input_tokens: sum("cache_creation_input_tokens"),
      cache_read_input_tokens: sum("cache_read_input_tokens"),
      output_tokens: sum("output_tokens"),
      source: "claude-code-hook",
      attribution: ctx.attribution,
    };
  });
}
