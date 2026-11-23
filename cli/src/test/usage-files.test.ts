import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { EventEmitter } from "node:events";
import { appendLines, guardHookProcess, readBranch, readStdin, readTranscript, readUsageReport, readUsageText, runUsageRecord } from "../usage-files.js";
import { AGENT_LINES, MAIN_LINES, PAYLOADS } from "./usage-fixtures.js";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "index.js");
const jsonl = (lines: readonly unknown[]) => lines.map((l) => JSON.stringify(l)).join("\n") + "\n";

// Every test works in its own temp dirs: never ~/.claude or the repository's .ai/tasks.
function sandbox() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "usage-")));
  const root = join(base, "repo");
  const cfg = join(base, "claude");
  const proj = join(cfg, "projects", "p");
  mkdirSync(join(root, ".git"), { recursive: true });
  mkdirSync(proj, { recursive: true });
  const main = join(proj, "main.jsonl");
  const agent = join(proj, "s", "subagents", "agent-a.jsonl");
  mkdirSync(dirname(agent), { recursive: true });
  writeFileSync(main, jsonl(MAIN_LINES));
  writeFileSync(agent, jsonl(AGENT_LINES));
  const task = (id: string, status?: unknown) => {
    mkdirSync(join(root, ".ai", "tasks", id), { recursive: true });
    if (status) writeFileSync(join(root, ".ai", "tasks", id, "status.json"), JSON.stringify(status));
  };
  const branch = (name: string) => writeFileSync(join(root, ".git", "HEAD"), `ref: refs/heads/${name}\n`);
  return { base, root, cfg, proj, main, agent, task, branch, done: () => rmSync(base, { recursive: true, force: true }) };
}
type Box = ReturnType<typeof sandbox>;

const stopPayload = (b: Box, path = b.main) => JSON.stringify({ ...PAYLOADS.stopTurn2, transcript_path: path });
const subPayload = (b: Box, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ ...PAYLOADS.subagentStop, transcript_path: b.main, agent_transcript_path: b.agent, ...extra });

async function run(b: Box, stdin: string | PassThrough, opts: { env?: NodeJS.ProcessEnv; now?: () => number; deadlineMs?: number } = {}) {
  const err: string[] = [];
  let stream: PassThrough;
  if (typeof stdin === "string") {
    stream = new PassThrough();
    stream.end(stdin);
  } else {
    stream = stdin;
  }
  await runUsageRecord({
    root: b.root,
    stdin: stream,
    env: { CLAUDE_CONFIG_DIR: b.cfg, ...opts.env },
    now: opts.now ?? (() => Date.UTC(2026, 10, 22)),
    stderr: (l) => err.push(l),
    deadlineMs: opts.deadlineMs,
  });
  return err;
}
const records = (file: string) => (existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const usageOf = (b: Box, id: string) => join(b.root, ".ai", "tasks", id, "usage.jsonl");

test("run attributed to an existing ticket (branch), then the hook fires again with no new messages", async () => {
  const b = sandbox();
  try {
    b.task("BASE-071-P1");
    b.branch("feat/BASE-071-P1-pipeline-check");
    assert.deepEqual(await run(b, stopPayload(b)), []);
    const rs = records(usageOf(b, "BASE-071-P1"));
    assert.equal(rs.length, 1);
    assert.deepEqual(
      [rs[0].ticket, rs[0].agent, rs[0].attribution, rs[0].messages, rs[0].input_tokens, rs[0].cache_creation_input_tokens, rs[0].cache_read_input_tokens, rs[0].output_tokens],
      ["BASE-071-P1", "coordinator", "branch", 3, 6, 20368, 75651, 282],
    );
    assert.deepEqual(await run(b, stopPayload(b)), []);
    assert.equal(records(usageOf(b, "BASE-071-P1")).length, 1, "nothing appended");
  } finally {
    b.done();
  }
});

test("two turns of the main session: the second record covers only turn 2", async () => {
  const b = sandbox();
  try {
    b.task("BASE-071-P1");
    b.branch("feat/BASE-071-P1-pipeline-check");
    writeFileSync(b.main, jsonl(MAIN_LINES.slice(0, 5)));
    await run(b, stopPayload(b));
    writeFileSync(b.main, jsonl(MAIN_LINES));
    await run(b, stopPayload(b));
    const rs = records(usageOf(b, "BASE-071-P1"));
    assert.deepEqual(rs.map((r) => [r.first_message_id, r.last_message_id, r.messages]), [
      ["msg_main_turn1_a", "msg_main_turn1_b", 2],
      ["msg_main_turn2_a", "msg_main_turn2_a", 1],
    ]);
  } finally {
    b.done();
  }
});

test("SubagentStop: parses the subagent's own transcript with its type; env attribution; a later Stop is unaffected", async () => {
  const b = sandbox();
  try {
    b.task("ENV-1");
    assert.deepEqual(await run(b, subPayload(b), { env: { BASE_AI_TICKET: "ENV-1" } }), []);
    await run(b, stopPayload(b), { env: { BASE_AI_TICKET: "ENV-1" } });
    const rs = records(usageOf(b, "ENV-1"));
    assert.deepEqual(rs.map((r) => [r.agent, r.attribution, r.messages]), [["general-purpose", "env", 1], ["coordinator", "env", 3]]);
  } finally {
    b.done();
  }
});

test("SubagentStop without type or own transcript: role from status.json, the payload transcript", async () => {
  const b = sandbox();
  try {
    b.task("BASE-071-P1", { transitions: [{ agent: "planner" }, { agent: "reviewer" }] });
    b.branch("feat/BASE-071-P1-pipeline-check");
    await run(b, subPayload(b, { agent_type: undefined, agent_transcript_path: undefined }));
    const rs = records(usageOf(b, "BASE-071-P1"));
    assert.deepEqual(rs.map((r) => [r.agent, r.messages]), [["reviewer", 3]]);
  } finally {
    b.done();
  }
});

test("no ticket resolved: .ai/usage/unattributed.jsonl with attribution none; an invalid BASE_AI_TICKET warns once", async () => {
  const b = sandbox();
  try {
    b.branch("main");
    const err = await run(b, stopPayload(b), { env: { BASE_AI_TICKET: ".." } });
    assert.deepEqual(err, ["base-ai usage: BASE_AI_TICKET ignored (invalid or no such task directory)"]);
    const rs = records(join(b.root, ".ai", "usage", "unattributed.jsonl"));
    assert.deepEqual(rs.map((r) => [r.ticket, r.attribution]), [[null, "none"]]);
    assert.equal(existsSync(join(b.root, ".ai", "usage.jsonl")), false, ".. never escapes .ai/tasks");
  } finally {
    b.done();
  }
});

test("worktree: the branch is read through the .git gitdir file; detached or missing HEAD gives no branch", () => {
  const b = sandbox();
  try {
    rmSync(join(b.root, ".git"), { recursive: true });
    mkdirSync(join(b.base, "wt"), { recursive: true });
    writeFileSync(join(b.base, "wt", "HEAD"), "ref: refs/heads/feat/BASE-101-U1-usage-record\n");
    writeFileSync(join(b.root, ".git"), "gitdir: ../wt\n");
    assert.equal(readBranch(b.root), "feat/BASE-101-U1-usage-record");
    writeFileSync(join(b.root, ".git"), "nonsense\n");
    assert.equal(readBranch(b.root), null);
    rmSync(join(b.root, ".git"));
    assert.equal(readBranch(b.root), null);
  } finally {
    b.done();
  }
});

test("invalid input or unreadable transcript: nothing written, one stderr line, normal return", async () => {
  const b = sandbox();
  try {
    b.task("BASE-071-P1");
    b.branch("feat/BASE-071-P1-pipeline-check");
    const big = join(b.proj, "big.jsonl");
    writeFileSync(big, "");
    truncateSync(big, 50 * 1024 * 1024 + 1);
    const link = join(b.proj, "link.jsonl");
    symlinkSync(b.main, link);
    const realDir = join(b.proj, "real");
    mkdirSync(realDir);
    writeFileSync(join(realDir, "t.jsonl"), jsonl(MAIN_LINES));
    symlinkSync(realDir, join(b.proj, "linkdir"));
    const outside = join(b.base, "outside.jsonl");
    writeFileSync(outside, jsonl(MAIN_LINES));
    const cases: [string, RegExp][] = [
      ["not json", /payload is not valid/],
      ["x".repeat(1024 * 1024 + 1), /stdin is unreadable or over 1 MiB/],
      [JSON.stringify({ ...PAYLOADS.stopTurn2, transcript_path: undefined }), /payload is not valid/],
      [stopPayload(b, join(b.proj, "nope.jsonl")), /transcript rejected/],
      [stopPayload(b, big), /transcript rejected/],
      [stopPayload(b, link), /transcript rejected/],
      [stopPayload(b, join(b.proj, "linkdir", "t.jsonl")), /transcript rejected/],
      [stopPayload(b, outside), /transcript rejected/],
      [stopPayload(b, b.proj), /transcript rejected/],
    ];
    for (const [stdin, re] of cases) {
      const err = await run(b, stdin);
      assert.equal(err.length, 1, String(re));
      assert.match(err[0], re);
      assert.doesNotMatch(err[0], /\/|jsonl|msg_/);
    }
    assert.equal(existsSync(usageOf(b, "BASE-071-P1")), false);
    assert.equal(readTranscript("relative.jsonl", join(b.cfg, "projects")), null);
    assert.equal(readTranscript(b.main, join(b.base, "no-such-projects")), null);
  } finally {
    b.done();
  }
});

test("a symlinked usage.jsonl target is refused; an unwritable .ai/usage is a write failure", async () => {
  const b = sandbox();
  try {
    b.task("BASE-071-P1");
    b.branch("feat/BASE-071-P1-pipeline-check");
    const victim = join(b.base, "victim.txt");
    writeFileSync(victim, "keep");
    symlinkSync(victim, usageOf(b, "BASE-071-P1"));
    // The scan already refuses the symlinked usage file (O_NOFOLLOW), before any write.
    assert.deepEqual(await run(b, stopPayload(b)), ["base-ai usage: a usage file is unreadable or over 50 MiB; nothing written"]);
    assert.equal(appendLines(usageOf(b, "BASE-071-P1"), ["x"]), false, "the append refuses a symlinked target too");
    assert.equal(readFileSync(victim, "utf8"), "keep");
    rmSync(usageOf(b, "BASE-071-P1"));
    b.branch("main");
    mkdirSync(join(b.root, ".ai"), { recursive: true });
    writeFileSync(join(b.root, ".ai", "usage"), "a file, not a directory");
    assert.deepEqual(await run(b, stopPayload(b)), ["base-ai usage: usage file could not be written"]);
  } finally {
    b.done();
  }
});

test("time limit: stdin that never ends, and a clock past the deadline, write nothing", async () => {
  const b = sandbox();
  try {
    b.task("BASE-071-P1");
    b.branch("feat/BASE-071-P1-pipeline-check");
    // A real stdin keeps the process alive; this interval stands in for it, since the deadline timer is unref'd.
    const alive = setInterval(() => {}, 1_000);
    try {
      assert.deepEqual(await run(b, new PassThrough(), { deadlineMs: 30 }), ["base-ai usage: time limit reached; nothing written"]);
    } finally {
      clearInterval(alive);
    }
    let t = 0;
    assert.deepEqual(await run(b, stopPayload(b), { now: () => (t += 3_000) }), ["base-ai usage: time limit reached; nothing written"]);
    // Passes the parse (8 clock reads: start + one per transcript line), then is late before the write.
    let calls = 0;
    const lines = jsonl(MAIN_LINES).split("\n").length;
    assert.deepEqual(await run(b, stopPayload(b), { now: () => (++calls <= 1 + lines + 1 ? 0 : 10_000) }), ["base-ai usage: time limit reached; nothing written"]);
    assert.equal(existsSync(usageOf(b, "BASE-071-P1")), false);
  } finally {
    b.done();
  }
});

test("readStdin: string chunks, a stream error; appendLines appends one line per write through O_APPEND", async () => {
  const s = new PassThrough({ encoding: "utf8" });
  s.end("ab");
  assert.deepEqual(await readStdin(s), { kind: "ok", text: "ab" });
  const e = new PassThrough();
  const p = readStdin(e);
  e.emit("error", new Error("x"));
  assert.deepEqual(await p, { kind: "error", reason: "stdin" });
  const b = sandbox();
  try {
    const f = join(b.base, "u.jsonl");
    assert.equal(appendLines(f, ['{"a":1}']), true);
    assert.equal(appendLines(f, ['{"a":2}', '{"a":3}']), true);
    assert.deepEqual(records(f).map((r) => r.a), [1, 2, 3]);
    assert.equal(appendLines(join(b.base, "missing", "u.jsonl"), ["x"]), false);
  } finally {
    b.done();
  }
});

test("spawned CLI: garbage stdin and a valid payload both exit 0 with empty stdout", () => {
  const b = sandbox();
  try {
    b.task("BASE-071-P1");
    b.branch("feat/BASE-071-P1-pipeline-check");
    const env = { ...process.env, CLAUDE_CONFIG_DIR: b.cfg, BASE_AI_TICKET: "" };
    const garbage = spawnSync(process.execPath, [CLI, "usage", "record", "--root", b.root], { input: "garbage", env, encoding: "utf8" });
    assert.deepEqual([garbage.status, garbage.stdout], [0, ""]);
    assert.equal(garbage.stderr.trim().split("\n").length, 1);
    const ok = spawnSync(process.execPath, [CLI, "usage", "record", "--root", b.root], { input: stopPayload(b), env, encoding: "utf8" });
    assert.deepEqual([ok.status, ok.stdout, ok.stderr], [0, "", ""]);
    assert.equal(records(usageOf(b, "BASE-071-P1")).length, 1);
  } finally {
    b.done();
  }
});

test("worktree end to end: the branch through a .git gitdir file attributes the record", async () => {
  const b = sandbox();
  try {
    b.task("BASE-101-U1");
    rmSync(join(b.root, ".git"), { recursive: true });
    mkdirSync(join(b.base, "wt"));
    writeFileSync(join(b.base, "wt", "HEAD"), "ref: refs/heads/feat/BASE-101-U1-usage-record\n");
    writeFileSync(join(b.root, ".git"), "gitdir: ../wt\n");
    assert.deepEqual(await run(b, stopPayload(b)), []);
    assert.deepEqual(records(usageOf(b, "BASE-101-U1")).map((r) => [r.ticket, r.attribution]), [["BASE-101-U1", "branch"]]);
  } finally {
    b.done();
  }
});

test("a symlinked task directory is not a ticket; an unreadable usage file stops the write", async () => {
  const b = sandbox();
  try {
    mkdirSync(join(b.root, ".ai", "tasks"), { recursive: true });
    mkdirSync(join(b.base, "elsewhere"));
    symlinkSync(join(b.base, "elsewhere"), join(b.root, ".ai", "tasks", "BASE-071-P1"));
    b.branch("feat/BASE-071-P1-pipeline-check");
    assert.deepEqual(await run(b, stopPayload(b)), []);
    assert.equal(existsSync(join(b.base, "elsewhere", "usage.jsonl")), false, "nothing written through the symlink");
    assert.equal(records(join(b.root, ".ai", "usage", "unattributed.jsonl")).length, 1);
    b.task("TK-9");
    const big = usageOf(b, "TK-9");
    writeFileSync(big, "");
    truncateSync(big, 50 * 1024 * 1024 + 1);
    writeFileSync(b.main, jsonl(MAIN_LINES) + jsonl([{ type: "assistant", message: { id: "msg_new", model: "m", usage: { input_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1 } } }]));
    assert.deepEqual(await run(b, stopPayload(b)), ["base-ai usage: a usage file is unreadable or over 50 MiB; nothing written"]);
    assert.equal(records(join(b.root, ".ai", "usage", "unattributed.jsonl")).length, 1, "no second record");
  } finally {
    b.done();
  }
});

test("spawned CLI: a synchronous failure before dispatch still exits 0 for usage record", () => {
  const b = sandbox();
  try {
    const gone = join(b.base, "gone");
    mkdirSync(gone);
    const r = spawnSync("/bin/sh", ["-c", `cd "${gone}" && rmdir "${gone}" && exec "${process.execPath}" "${CLI}" usage record`], { input: "{}", encoding: "utf8" });
    assert.deepEqual([r.status, r.stdout], [0, ""]);
    assert.match(r.stderr, /^base-ai usage: internal error; nothing written\n$/);
  } finally {
    b.done();
  }
});

// --- usage report, guard and L6 (BASE-101-U2) ---

const REC = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    schema: 1,
    agent: "qa",
    model: "claude-x",
    messages: 2,
    input_tokens: 1_000_000,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    output_tokens: 0,
    ...over,
  });
const PRICES = { "claude-x": { input: 3, cache_write: 0, cache_read: 0, output: 0 } };

test("readUsageReport: priced, unpriced and corrupt lines; a missing file is no usage data; a symlink is refused", () => {
  const b = sandbox();
  try {
    b.task("T-1");
    const file = join(b.root, ".ai", "tasks", "T-1", "usage.jsonl");
    assert.equal(readUsageReport(b.root, ".ai/tasks/T-1", PRICES).records, 0, "missing file");
    writeFileSync(file, `${REC()}\n${REC({ model: "other" })}\ngarbage\n`);
    const r = readUsageReport(b.root, ".ai/tasks/T-1", PRICES);
    assert.deepEqual([r.ticket, r.records, r.skipped_lines, r.total.cost_usd, r.total.unpriced_records], ["T-1", 2, 1, 3, 1]);
    assert.equal(readUsageReport(b.base, join(b.root, ".ai", "tasks", "T-1"), PRICES).records, 2, "absolute task dir");
    assert.throws(() => readUsageReport(b.root, ".ai/tasks/NOPE", PRICES), /task directory not found: \.ai\/tasks\/NOPE/);

    b.task("T-2");
    symlinkSync(file, join(b.root, ".ai", "tasks", "T-2", "usage.jsonl"));
    assert.throws(() => readUsageReport(b.root, ".ai/tasks/T-2", PRICES), /not a regular file/);
  } finally {
    b.done();
  }
});

test("spawned CLI: usage report in text and --json exits 0; prices come from .ai/config.yaml; a missing task dir exits 1", () => {
  const b = sandbox();
  try {
    b.task("T-1");
    writeFileSync(join(b.root, ".ai", "tasks", "T-1", "usage.jsonl"), `${REC()}\n${REC({ agent: "reviewer", model: "other", output_tokens: 9 })}\n`);
    mkdirSync(join(b.root, ".ai"), { recursive: true });
    writeFileSync(
      join(b.root, ".ai", "config.yaml"),
      "usage:\n  pricing:\n    claude-x: { input: 3, cache_write: 0, cache_read: 0, output: 0 }\n",
    );
    const run = (...args: string[]) => spawnSync(process.execPath, [CLI, "usage", "report", ...args, "--root", b.root], { encoding: "utf8" });

    const text = run(".ai/tasks/T-1");
    assert.equal(text.status, 0, text.stderr);
    assert.match(text.stdout, /qa \/ claude-x: in 1000000, cache write 0, cache read 0, out 0; calls 2, ctx\/call 500000; \$3\.0000/);
    assert.match(text.stdout, /reviewer \/ other: in 1000000, cache write 0, cache read 0, out 9; calls 2, ctx\/call 500000; no price/);
    assert.match(text.stdout, /total: .*; calls 4, ctx\/call 500000; \$3\.0000 \(\+1 record with no price\)/);

    const js = run(".ai/tasks/T-1", "--json");
    assert.equal(js.status, 0, js.stderr);
    const parsed = JSON.parse(js.stdout);
    assert.deepEqual([parsed.schema, parsed.ticket, parsed.records, parsed.skipped_lines], [1, "T-1", 2, 0]);
    assert.deepEqual(parsed.groups.map((g: { cost_usd: number | null }) => g.cost_usd), [3, null]);
    assert.deepEqual([parsed.total.cost_usd, parsed.total.unpriced_records], [3, 1]);

    b.task("EMPTY");
    const empty = run(".ai/tasks/EMPTY");
    assert.deepEqual([empty.status, empty.stdout], [0, "usage EMPTY: no usage data\n"]);

    const missing = run(".ai/tasks/NOPE");
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /task directory not found/);

    writeFileSync(join(b.root, ".ai", "config.yaml"), "usage:\n  hook: sometimes\n");
    const badCfg = run(".ai/tasks/T-1");
    assert.equal(badCfg.status, 1);
    assert.match(badCfg.stderr, /"usage\.hook" must be "claude-code" or "none"/);
  } finally {
    b.done();
  }
});

test("L6 uncaught exception: guardHookProcess writes one stderr line and exits 0, even when stderr throws", () => {
  const fake = Object.assign(new EventEmitter(), { codes: [] as number[], exit(code: number) { this.codes.push(code); } });
  const lines: string[] = [];
  guardHookProcess(fake, (l) => lines.push(l));
  fake.emit("uncaughtException", new Error("boom"));
  fake.emit("unhandledRejection", new Error("again"));
  assert.deepEqual(lines, ["base-ai usage: internal error; nothing written"]);
  assert.deepEqual(fake.codes, [0, 0]);

  const broken = Object.assign(new EventEmitter(), { codes: [] as number[], exit(code: number) { this.codes.push(code); } });
  guardHookProcess(broken, () => {
    throw Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
  });
  broken.emit("uncaughtException", new Error("boom"));
  assert.deepEqual(broken.codes, [0]);
});

test("L6 flag before the command: --root . usage record from a deleted working directory exits 0", () => {
  const b = sandbox();
  try {
    const gone = join(b.base, "gone");
    mkdirSync(gone);
    const r = spawnSync("/bin/sh", ["-c", `cd "${gone}" && rmdir "${gone}" && exec "${process.execPath}" "${CLI}" --root . usage record`], { input: "{}", encoding: "utf8" });
    assert.deepEqual([r.status, r.stdout], [0, ""]);
    assert.match(r.stderr, /^base-ai usage: internal error; nothing written\n$/);
  } finally {
    b.done();
  }
});

test("readUsageText: the text, \"\" for a missing file, and a throw on a symlink or a missing task directory (BASE-101-D1)", () => {
  const b = sandbox();
  try {
    b.task("T-1");
    assert.equal(readUsageText(b.root, ".ai/tasks/T-1"), "");
    const file = join(b.root, ".ai", "tasks", "T-1", "usage.jsonl");
    writeFileSync(file, `${REC()}\n`);
    assert.equal(readUsageText(b.root, ".ai/tasks/T-1"), `${REC()}\n`);
    b.task("T-2");
    symlinkSync(file, join(b.root, ".ai", "tasks", "T-2", "usage.jsonl"));
    assert.throws(() => readUsageText(b.root, ".ai/tasks/T-2"), /^Error: \.ai\/tasks\/T-2\/usage\.jsonl is not a regular file/);
    assert.throws(() => readUsageText(b.root, ".ai/tasks/NOPE"), /task directory not found/);
  } finally {
    b.done();
  }
});
