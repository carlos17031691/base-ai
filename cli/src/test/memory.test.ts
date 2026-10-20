import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { searchContext } from "../context.js";
import { memoryAdd, memoryList } from "../memory.js";

function fixture(): string {
  const d = mkdtempSync(join(tmpdir(), "base-ai-mem-"));
  mkdirSync(join(d, ".ai"), { recursive: true });
  writeFileSync(join(d, ".ai/rules.md"), "# Rules");
  return d;
}

test("memoryAdd persists notes, exports to AGENTS.md and indexes for context search", () => {
  const d = fixture();
  memoryAdd(d, "Route LLM calls through OpenRouter with fallback to Claude", {
    ticket: "PROJ-200",
    tag: "integrations",
  });
  const list = memoryList(d);
  assert.equal(list.length, 1);
  assert.match(list[0], /\[PROJ-200\].*#integrations.*OpenRouter/);

  const agents = readFileSync(join(d, "AGENTS.md"), "utf8");
  assert.match(agents, /## Project memory[\s\S]*OpenRouter/);

  const hits = searchContext(d, "OpenRouter fallback");
  assert.equal(hits[0].kind, "memory");
});

test("memoryAdd rejects potential secrets", () => {
  const d = fixture();
  assert.throws(() => memoryAdd(d, "key is sk-or-v1-1234567890abcdefghijkl"), /potential secret/);
});
