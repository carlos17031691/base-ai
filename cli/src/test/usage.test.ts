import { test } from "node:test";
import assert from "node:assert/strict";
import {
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
