import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildUsageReport,
  formatCost,
  parsePricing,
  parseUsageLine,
  recordCost,
  renderUsageReport,
  round4,
  summarizeUsage,
  branchFromHead,
  buildRecords,
  chooseRole,
  chooseTicket,
  isTicketId,
  newMessages,
  parsePayload,
  parseTranscript,
  recordedIds,
  stderrLine,
  ticketCandidates,
  transcriptFor,
  type HookPayload,
  type Message,
} from "../usage.js";
import { AGENT_LINES, MAIN_LINES, PAYLOADS } from "./usage-fixtures.js";

const jsonl = (lines: readonly unknown[]) => lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
const clock = () => 0;
const parse = (text: string) => parseTranscript(text, clock, 1) as Message[];
const [T1A, T1B, T2] = ["msg_main_turn1_a", "msg_main_turn1_b", "msg_main_turn2_a"];
const ctx = { now: Date.UTC(2026, 10, 22, 5, 0, 0, 123), ticket: "TK-1", agent: "coordinator", sessionId: "s1", attribution: "branch" as const };
const msg = (id: string, model = "m1", n = 1): Message => ({
  id,
  model,
  input_tokens: n,
  cache_creation_input_tokens: n,
  cache_read_input_tokens: n,
  output_tokens: n,
});

test("P-1 fixtures parse: each message.id once with its counters (max over repeated lines)", () => {
  const main = parse(jsonl(MAIN_LINES));
  assert.deepEqual(main.map((m) => m.id), [T1A, T1B, T2]);
  assert.deepEqual(main[0], { id: T1A, model: "claude-haiku-5-5", input_tokens: 2, cache_creation_input_tokens: 19796, cache_read_input_tokens: 11842, output_tokens: 276 });
  const agent = parse(jsonl(AGENT_LINES));
  assert.deepEqual(agent.map((m) => [m.id, m.output_tokens]), [["msg_agent_1", 4]]);
});

test("a repeated id takes the maximum of each counter, in order of first appearance", () => {
  const line = (id: string, n: number, model?: string) =>
    JSON.stringify({ type: "assistant", message: { id, model, usage: { input_tokens: n, cache_creation_input_tokens: n, cache_read_input_tokens: n, output_tokens: n } } });
  const ms = parse([line("a", 1), line("b", 5), line("a", 3), line("a", 2)].join("\n"));
  assert.deepEqual(ms.map((m) => [m.id, m.output_tokens, m.model]), [["a", 3, "unknown"], ["b", 5, "unknown"]]);
});

test("non-JSON, non-assistant, id-less and bad-counter lines are skipped", () => {
  const good = { type: "assistant", message: { id: "g", model: "m", usage: { input_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1 } } };
  const bad = [
    "not json",
    JSON.stringify([1]),
    JSON.stringify({ type: "user", message: good.message }),
    JSON.stringify({ type: "assistant", message: "x" }),
    JSON.stringify({ type: "assistant", message: { model: "m", usage: good.message.usage } }),
    JSON.stringify({ type: "assistant", message: { id: "x", usage: null } }),
    JSON.stringify({ type: "assistant", message: { id: "x", usage: { ...good.message.usage, output_tokens: -1 } } }),
    JSON.stringify({ type: "assistant", message: { id: "x", usage: { ...good.message.usage, input_tokens: 1.5 } } }),
    JSON.stringify({ type: "assistant", message: { id: "x", usage: { input_tokens: 1 } } }),
    JSON.stringify({ type: "assistant", message: { id: "bad id with spaces", usage: good.message.usage } }),
    JSON.stringify({ type: "assistant", message: { id: "x".repeat(129), usage: good.message.usage } }),
  ];
  assert.deepEqual(parse([...bad, JSON.stringify(good)].join("\n")).map((m) => m.id), ["g"]);
});

test("a sentinel in a line's content never reaches the serialised record", () => {
  const lines = MAIN_LINES.map((l) => {
    const o = l as { type: string; message?: Record<string, unknown> };
    return o.type === "assistant" ? { ...o, message: { ...o.message, content: [{ type: "text", text: "SENTINEL-7f3a" }] }, text: "SENTINEL-7f3a" } : l;
  });
  const records = buildRecords(parse(jsonl(lines)), ctx);
  assert.doesNotMatch(JSON.stringify(records), /SENTINEL/);
});

test("time limit: a clock past the deadline between lines aborts the parse", () => {
  let t = 0;
  assert.equal(parseTranscript(jsonl(MAIN_LINES), () => (t += 2_000), 5_000), "deadline");
  assert.notEqual(parseTranscript(jsonl(MAIN_LINES), () => 0, 5_000), "deadline");
});

test("high-water mark: turn 2 covers only its messages; no new message gives none; other transcripts do not move it", () => {
  const all = parse(jsonl(MAIN_LINES));
  const turn1 = buildRecords(newMessages(all.slice(0, 2), new Set()), ctx);
  assert.equal(turn1.length, 1);
  assert.deepEqual([turn1[0].first_message_id, turn1[0].last_message_id, turn1[0].messages], [T1A, T1B, 2]);
  assert.deepEqual([turn1[0].input_tokens, turn1[0].cache_creation_input_tokens, turn1[0].cache_read_input_tokens, turn1[0].output_tokens], [4, 20329, 43480, 279]);
  const usage = turn1.map((r) => JSON.stringify(r)).join("\n");
  const recorded = recordedIds([usage, "corrupt line", JSON.stringify({ session_id: "other", last_message_id: T2 })], "s1");
  assert.deepEqual([...recorded], [T1B]);
  assert.deepEqual(newMessages(all, recorded).map((m) => m.id), [T2]);
  assert.deepEqual(newMessages(all, new Set([T2])), [], "the hook fires again with no new messages");
  const subagentIds = recordedIds([JSON.stringify({ session_id: "s1", last_message_id: "msg_agent_1" })], "s1");
  assert.equal(newMessages(all, subagentIds).length, 3, "an id from the subagent transcript does not move the main mark");
});

test("buildRecords: one record per model in order of first appearance, fixed key order, UTC ts without ms", () => {
  const rs = buildRecords([msg("a", "m1", 1), msg("b", "m2", 2), msg("c", "m1", 3)], { ...ctx, ticket: null, attribution: "none" });
  assert.deepEqual(rs.map((r) => [r.model, r.first_message_id, r.last_message_id, r.messages, r.output_tokens]), [["m1", "a", "c", 2, 4], ["m2", "b", "b", 1, 2]]);
  assert.deepEqual(Object.keys(rs[0]), [
    "schema", "ts", "ticket", "agent", "model", "session_id", "first_message_id", "last_message_id", "messages",
    "input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens", "output_tokens", "source", "attribution",
  ]);
  assert.equal(rs[0].ts, "2026-11-22T05:00:00Z");
  assert.deepEqual([rs[0].ticket, rs[0].attribution, rs[0].source, rs[0].schema], [null, "none", "claude-code-hook", 1]);
});

test("parsePayload accepts the P-1 payloads and rejects every bad field", () => {
  const sub = parsePayload(JSON.stringify({ ...PAYLOADS.subagentStop, transcript_path: "/p/main.jsonl", agent_transcript_path: "/p/s/agent.jsonl" })) as HookPayload;
  assert.deepEqual(sub, { event: "SubagentStop", sessionId: PAYLOADS.subagentStop.session_id, transcriptPath: "/p/main.jsonl", agentTranscriptPath: "/p/s/agent.jsonl", agentType: "general-purpose" });
  assert.equal(transcriptFor(sub), "/p/s/agent.jsonl");
  const stop = parsePayload(JSON.stringify({ ...PAYLOADS.stopTurn1, transcript_path: "/p/main.jsonl", agent_type: "ignored" })) as HookPayload;
  assert.deepEqual(stop, { event: "Stop", sessionId: PAYLOADS.stopTurn1.session_id, transcriptPath: "/p/main.jsonl" });
  assert.equal(transcriptFor(stop), "/p/main.jsonl");
  const base = { hook_event_name: "Stop", session_id: "s1", transcript_path: "/p/t.jsonl" };
  for (const bad of [
    "not json",
    "[1]",
    JSON.stringify({ ...base, hook_event_name: "PreToolUse" }),
    JSON.stringify({ ...base, session_id: "../x" }),
    JSON.stringify({ ...base, session_id: 7 }),
    JSON.stringify({ ...base, session_id: "x".repeat(129) }),
    JSON.stringify({ ...base, transcript_path: "relative.jsonl" }),
    JSON.stringify({ ...base, transcript_path: "/p/a\u0000b" }),
    JSON.stringify({ ...base, transcript_path: 3 }),
    JSON.stringify({ ...base, hook_event_name: "SubagentStop", agent_transcript_path: "rel" }),
  ]) {
    assert.equal(parsePayload(bad), null, bad);
  }
});

test("chooseRole: Stop is coordinator; SubagentStop uses the type, else the latest status.json agent, else unknown", () => {
  const p = (agentType?: string): HookPayload => ({ event: "SubagentStop", sessionId: "s", transcriptPath: "/t", agentType });
  const status = JSON.stringify({ transitions: [{ agent: "planner" }, { agent: "reviewer" }] });
  assert.equal(chooseRole({ event: "Stop", sessionId: "s", transcriptPath: "/t", agentType: "qa" }, status), "coordinator");
  assert.equal(chooseRole(p("qa"), status), "qa");
  assert.equal(chooseRole(p("Bad Type!"), status), "reviewer", "an invalid type falls back");
  assert.equal(chooseRole(p(), status), "reviewer");
  assert.equal(chooseRole(p(), JSON.stringify({ transitions: [] })), "unknown");
  assert.equal(chooseRole(p(), JSON.stringify({ transitions: [{ agent: "<x>" }] })), "unknown");
  assert.equal(chooseRole(p(), "{"), "unknown");
  assert.equal(chooseRole(p(), null), "unknown");
});

test("ticket ids, branch parsing and branch prefixes", () => {
  assert.equal(isTicketId("BASE-101-U1"), true);
  for (const bad of ["..", ".", "a/b", "", "x y"]) assert.equal(isTicketId(bad), false, bad);
  assert.equal(branchFromHead("ref: refs/heads/feat/BASE-071-P1-pipeline-check\n"), "feat/BASE-071-P1-pipeline-check");
  assert.equal(branchFromHead("4b825dc642cb6eb9a060e54bf8d69288fbee4904\n"), null, "detached HEAD");
  assert.deepEqual(ticketCandidates("feat/BASE-101-U1-usage-record"), ["BASE-101-U1-usage-record", "BASE-101-U1-usage", "BASE-101-U1", "BASE-101", "BASE"]);
  assert.deepEqual(ticketCandidates("feat/a!b-c"), [], "both prefixes fail the charset");
  assert.deepEqual(ticketCandidates("feat/.."), [], "dots only are never a ticket");
});

test("chooseTicket: env, then branch, then none; an invalid or unknown env is ignored with a warning", () => {
  const exists = (id: string) => id === "BASE-071-P1" || id === "ENV-1";
  assert.deepEqual(chooseTicket("ENV-1", "feat/BASE-071-P1-pipeline-check", exists), { ticket: "ENV-1", attribution: "env", envIgnored: false });
  assert.deepEqual(chooseTicket(undefined, "feat/BASE-071-P1-pipeline-check", exists), { ticket: "BASE-071-P1", attribution: "branch", envIgnored: false });
  assert.deepEqual(chooseTicket("..", "feat/BASE-071-P1-pipeline-check", exists), { ticket: "BASE-071-P1", attribution: "branch", envIgnored: true });
  assert.deepEqual(chooseTicket("NOPE-1", null, exists), { ticket: null, attribution: "none", envIgnored: true });
  assert.deepEqual(chooseTicket("", "main", exists), { ticket: null, attribution: "none", envIgnored: false });
  assert.match(stderrLine("payload"), /^base-ai usage: hook payload is not valid$/);
});

test("a model outside the safe charset or over 128 characters is stored as unknown", () => {
  const usage = { input_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1 };
  const ms = parse([
    JSON.stringify({ type: "assistant", message: { id: "a", model: "<script>", usage } }),
    JSON.stringify({ type: "assistant", message: { id: "b", model: "m".repeat(129), usage } }),
  ].join("\n"));
  assert.deepEqual(ms.map((m) => m.model), ["unknown", "unknown"]);
});

// --- Pricing and cost (BASE-101-U2) ---

const P = { input: 3, cache_write: 3.75, cache_read: 0.3, output: 15 };
const PRICING = { "claude-x": P };
const rec = (over: Record<string, unknown> = {}) => ({
  agent: "qa",
  model: "claude-x",
  messages: 1,
  input_tokens: 0,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
  output_tokens: 0,
  ...over,
});

test("cost with configured prices: Σ tokens × price / 1e6", () => {
  assert.equal(recordCost(rec({ input_tokens: 1_000_000 }), PRICING), 3);
  // Hand-computed: 1200×3 + 5000×3.75 + 80000×0.3 + 700×15 = 3600 + 18750 + 24000 + 10500 = 56850 → 0.05685.
  const mixed = rec({ input_tokens: 1200, cache_creation_input_tokens: 5000, cache_read_input_tokens: 80000, output_tokens: 700 });
  assert.equal(recordCost(mixed, PRICING), 0.0569);
});

test("cost is rounded once to 4 decimals, half away from zero", () => {
  assert.equal(round4(0.00005), 0.0001);
  assert.equal(round4(0.00004999), 0);
  assert.equal(round4(1.23456), 1.2346);
  assert.equal(round4(-0.00005), -0.0001);
  // Review r1 L2: decimal ties stored just below .5 in binary still round up above 1 USD and above 1000 USD.
  assert.equal(round4(1.00005), 1.0001);
  assert.equal(round4(2.00005), 2.0001);
  assert.equal(round4(1234.56785), 1234.5679);
  assert.equal(round4(98765.43215), 98765.4322);
  assert.equal(round4(2.00004), 2);
  // 7 output tokens at 15 = 0.000105 → 0.0001.
  assert.equal(recordCost(rec({ output_tokens: 7 }), PRICING), 0.0001);
});

test("model without a price: tokens are shown and the cost is no price, never 0", () => {
  const r = rec({ model: "other", input_tokens: 42 });
  assert.equal(recordCost(r, PRICING), null);
  assert.equal(recordCost(r, {}), null);
  assert.equal(recordCost(rec({ model: "toString" }), PRICING), null, "no prototype lookup");
  const report = buildUsageReport("T-1", JSON.stringify({ schema: 1, ...r }) + "\n", PRICING);
  const text = renderUsageReport(report);
  assert.match(text, /in 42, cache write 0, cache read 0, out 0; no price/);
  assert.doesNotMatch(text, /\$0\.0000|; 0$/m);
  assert.equal(report.total.cost_usd, null);
});

test("group totals mix priced and unpriced records: priced sum plus unpriced_records", () => {
  const records = [rec({ input_tokens: 1_000_000 }), rec({ model: "other", input_tokens: 5 }), rec({ agent: "reviewer", output_tokens: 100_000 })];
  const { groups, total } = summarizeUsage(records, PRICING);
  assert.deepEqual(groups.map((g) => [g.agent, g.model, g.records, g.cost_usd, g.unpriced_records]), [
    ["qa", "claude-x", 1, 3, 0],
    ["qa", "other", 1, null, 1],
    ["reviewer", "claude-x", 1, 1.5, 0],
  ]);
  assert.deepEqual([total.records, total.input_tokens, total.output_tokens, total.cost_usd, total.unpriced_records], [3, 1_000_005, 100_000, 4.5, 1]);
  assert.equal(formatCost(total), "$4.5000 (+1 record with no price)");
  assert.equal(formatCost({ cost_usd: 1, unpriced_records: 2 }), "$1.0000 (+2 records with no price)");
  assert.equal(formatCost({ cost_usd: null, unpriced_records: 2 }), "no price");
  // The sum is rounded once: two records of 0.00003 each (0.0000 alone) give 0.00006 → 0.0001, not 0.
  const tiny = summarizeUsage([rec({ output_tokens: 2 }), rec({ output_tokens: 2 })], PRICING).total;
  assert.equal(tiny.cost_usd, 0.0001);
});

test("usage report text and lines: corrupt lines are skipped and counted, an empty file is no usage data", () => {
  const good = JSON.stringify({ schema: 1, ...rec({ input_tokens: 1_000_000 }) });
  const report = buildUsageReport("T-2", `${good}\nnot json\n{"schema":2}\n\n`, PRICING);
  assert.deepEqual([report.records, report.skipped_lines, report.total.cost_usd], [1, 2, 3]);
  assert.equal(renderUsageReport(report), [
    "usage T-2: 1 record (2 unreadable lines skipped)",
    "  qa / claude-x: in 1000000, cache write 0, cache read 0, out 0; $3.0000",
    "  total: in 1000000, cache write 0, cache read 0, out 0; $3.0000",
  ].join("\n"));
  assert.equal(renderUsageReport(buildUsageReport("T-3", "", PRICING)), "usage T-3: no usage data");
  assert.equal(parseUsageLine(JSON.stringify({ schema: 1, ...rec({ output_tokens: -1 }) })), null);
  assert.equal(parseUsageLine("[]"), null);
  const ctl = buildUsageReport("T-4", JSON.stringify({ schema: 1, ...rec({ agent: "a\u001b[31m" }) }), {});
  assert.match(renderUsageReport(ctl), /a\?\[31m/);
  // Review r1 L5: C1 (8-bit CSI) and bidi override and isolate controls are stripped too.
  const c1 = buildUsageReport("T-5", JSON.stringify({ schema: 1, ...rec({ agent: "a\u009b31m\u202eb\u2066c" }) }), {});
  assert.match(renderUsageReport(c1), /a\?31m\?b\?c \//);
});

test("pricing validation: missing key, negative or non-numeric value, unknown key, bad model id", () => {
  const f = "cfg.yaml";
  assert.deepEqual(parsePricing(undefined, f), {});
  assert.deepEqual(parsePricing({}, f), {});
  assert.deepEqual(parsePricing({ "claude-x": P }, f), { "claude-x": P });
  assert.throws(() => parsePricing([], f), /"usage\.pricing" must be a map/);
  assert.throws(() => parsePricing({ "claude-x": { input: 1, cache_write: 1, cache_read: 1 } }, f), /"usage\.pricing\.claude-x\.output" must be a number >= 0/);
  assert.throws(() => parsePricing({ "claude-x": { ...P, input: -1 } }, f), /usage\.pricing\.claude-x\.input/);
  assert.throws(() => parsePricing({ "claude-x": { ...P, input: "3" } }, f), /usage\.pricing\.claude-x\.input/);
  assert.throws(() => parsePricing({ "claude-x": { ...P, input: Infinity } }, f), /usage\.pricing\.claude-x\.input/);
  assert.throws(() => parsePricing({ "claude-x": { ...P, batch: 1 } }, f), /"usage\.pricing\.claude-x\.batch" is not a price key/);
  assert.throws(() => parsePricing({ "bad model": P }, f), /"usage\.pricing\.bad model" is not a valid model id/);
  assert.throws(() => parsePricing({ "claude-x": 3 }, f), /"usage\.pricing\.claude-x" must be a map/);
});
