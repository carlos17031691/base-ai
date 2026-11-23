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

// --- Pricing and cost (BASE-101-U2). Cost is computed on read and never stored in usage.jsonl. ---

/** USD per million tokens for each counter, keyed by exact model id in `usage.pricing`. */
export interface Price {
  input: number;
  cache_write: number;
  cache_read: number;
  output: number;
}
export type Pricing = Record<string, Price>;
const PRICE_KEYS = ["input", "cache_write", "cache_read", "output"] as const;

/** Validates `usage.pricing`; absent or empty means no prices (P-5). Throws naming `usage.pricing.<model>[.<key>]`. */
export function parsePricing(raw: unknown, file: string): Pricing {
  if (raw === undefined || raw === null) return {};
  if (!isObj(raw)) throw new Error(`${file}: "usage.pricing" must be a map of model id to prices`);
  const out: Pricing = {};
  for (const [model, price] of Object.entries(raw)) {
    const at = `${file}: "usage.pricing.${model}"`;
    if (!MESSAGE_ID.test(model)) throw new Error(`${at} is not a valid model id`);
    if (!isObj(price)) throw new Error(`${at} must be a map with ${PRICE_KEYS.join(", ")}`);
    for (const k of Object.keys(price)) {
      if (!(PRICE_KEYS as readonly string[]).includes(k)) throw new Error(`${file}: "usage.pricing.${model}.${k}" is not a price key`);
    }
    for (const k of PRICE_KEYS) {
      const v = price[k];
      if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
        throw new Error(`${file}: "usage.pricing.${model}.${k}" must be a number >= 0 (USD per million tokens)`);
      }
    }
    out[model] = price as unknown as Price;
  }
  return out;
}

/**
 * Rounds once to 4 decimals, half away from zero. The scaled value is first cut to 15 significant digits, so a
 * decimal tie stored just below .5 in binary (1.00005 × 1e4 = 10000.499999999998) still rounds up at any size.
 */
export function round4(x: number): number {
  const scaled = Number((Math.abs(x) * 1e4).toPrecision(15));
  return (Math.sign(x) * Math.round(scaled)) / 1e4;
}

type Counters = Pick<UsageRecord, (typeof COUNTERS)[number]>;

/** Unrounded USD: Σ tokens × price / 1e6 over the four counters. */
function rawCost(c: Counters, p: Price): number {
  return (
    (c.input_tokens * p.input +
      c.cache_creation_input_tokens * p.cache_write +
      c.cache_read_input_tokens * p.cache_read +
      c.output_tokens * p.output) /
    1e6
  );
}

/** A record's cost rounded to 4 decimals, or null when its model has no price: never 0. */
export function recordCost(r: Counters & { model: string }, pricing: Pricing): number | null {
  const p = Object.hasOwn(pricing, r.model) ? pricing[r.model] : undefined;
  return p === undefined ? null : round4(rawCost(r, p));
}

/** The fields of a usage.jsonl line that a report reads. */
export type ReportRecord = Counters & { agent: string; model: string; messages: number };

/** A usage.jsonl line as read: the report fields plus `ts` when it is a valid UTC timestamp, else null (BASE-101-D1). */
export type UsageLine = ReportRecord & { ts: string | null };
const RECORD_TS = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/;

/** One usage.jsonl line as a record, or null when it is not one (the line is skipped and counted). */
export function parseUsageLine(line: string): UsageLine | null {
  let r: unknown;
  try {
    r = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isObj(r) || r.schema !== 1 || typeof r.agent !== "string" || typeof r.model !== "string") return null;
  if (!COUNTERS.every((c) => isCount(r[c])) || !isCount(r.messages)) return null;
  const n = (k: string) => r[k] as number;
  return {
    ts: typeof r.ts === "string" && RECORD_TS.test(r.ts) ? r.ts : null,
    agent: r.agent,
    model: r.model,
    messages: n("messages"),
    input_tokens: n("input_tokens"),
    cache_creation_input_tokens: n("cache_creation_input_tokens"),
    cache_read_input_tokens: n("cache_read_input_tokens"),
    output_tokens: n("output_tokens"),
  };
}

export interface UsageTotals extends Counters {
  records: number;
  messages: number;
  /** Rounded once over the priced records; null when none is priced. */
  cost_usd: number | null;
  unpriced_records: number;
}
export interface UsageGroup extends UsageTotals {
  agent: string;
  model: string;
}

function totals(records: ReportRecord[], pricing: Pricing): UsageTotals {
  const sum = (k: keyof ReportRecord) => records.reduce((n, r) => n + (r[k] as number), 0);
  let cost = 0;
  let priced = 0;
  for (const r of records) {
    const p = Object.hasOwn(pricing, r.model) ? pricing[r.model] : undefined;
    if (p === undefined) continue;
    cost += rawCost(r, p);
    priced++;
  }
  return {
    records: records.length,
    messages: sum("messages"),
    input_tokens: sum("input_tokens"),
    cache_creation_input_tokens: sum("cache_creation_input_tokens"),
    cache_read_input_tokens: sum("cache_read_input_tokens"),
    output_tokens: sum("output_tokens"),
    cost_usd: priced === 0 ? null : round4(cost),
    unpriced_records: records.length - priced,
  };
}

/** Groups by agent and model in order of first appearance, plus the total (H5). */
export function summarizeUsage(records: ReportRecord[], pricing: Pricing): { groups: UsageGroup[]; total: UsageTotals } {
  const byKey = new Map<string, ReportRecord[]>();
  for (const r of records) {
    const key = JSON.stringify([r.agent, r.model]);
    byKey.set(key, [...(byKey.get(key) ?? []), r]);
  }
  const groups = [...byKey.values()].map((rs) => ({ agent: rs[0].agent, model: rs[0].model, ...totals(rs, pricing) }));
  return { groups, total: totals(records, pricing) };
}

/** `$x.xxxx`, `$x.xxxx (+n records with no price)`, or `no price` when nothing is priced: never `$0.0000` for an unpriced model. */
export function formatCost(t: Pick<UsageTotals, "cost_usd" | "unpriced_records">): string {
  if (t.cost_usd === null) return "no price";
  const extra = t.unpriced_records > 0 ? ` (+${t.unpriced_records} record${t.unpriced_records === 1 ? "" : "s"} with no price)` : "";
  return `$${t.cost_usd.toFixed(4)}${extra}`;
}

export interface UsageReport {
  schema: 1;
  ticket: string;
  records: number;
  skipped_lines: number;
  groups: UsageGroup[];
  total: UsageTotals;
}

/** The records of a usage.jsonl text in file order. Blank lines are ignored; other unreadable lines are counted. */
export function parseUsageLines(text: string): { records: UsageLine[]; skipped: number } {
  const records: UsageLine[] = [];
  let skipped = 0;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const r = parseUsageLine(line);
    if (r === null) skipped++;
    else records.push(r);
  }
  return { records, skipped };
}

/** The report of one task's usage.jsonl text. */
export function buildUsageReport(ticket: string, text: string, pricing: Pricing): UsageReport {
  const { records, skipped } = parseUsageLines(text);
  const { groups, total } = summarizeUsage(records, pricing);
  return { schema: 1, ticket, records: records.length, skipped_lines: skipped, groups, total };
}

const counters = (t: Counters) =>
  `in ${t.input_tokens}, cache write ${t.cache_creation_input_tokens}, cache read ${t.cache_read_input_tokens}, out ${t.output_tokens}`;

/** The text form of `usage report`. Agent and model come from a versioned file, so control characters are stripped. */
export function renderUsageReport(r: UsageReport): string {
  const skipped = r.skipped_lines > 0 ? ` (${r.skipped_lines} unreadable line${r.skipped_lines === 1 ? "" : "s"} skipped)` : "";
  if (r.records === 0) return `usage ${r.ticket}: no usage data${skipped}`;
  // C0, DEL, C1 (an 8-bit CSI is U+009B) and the bidi embedding, override and isolate controls.
  const clean = (s: string) => s.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, "?");
  const lines = [`usage ${r.ticket}: ${r.records} record${r.records === 1 ? "" : "s"}${skipped}`];
  for (const g of r.groups) lines.push(`  ${clean(g.agent)} / ${clean(g.model)}: ${counters(g)}; ${formatCost(g)}`);
  lines.push(`  total: ${counters(r.total)}; ${formatCost(r.total)}`);
  return lines.join("\n");
}
