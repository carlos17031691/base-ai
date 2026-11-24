import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { RULE } from "../pipeline-check.js";

// The supervisor accepts only the rule id the CLI reports (BASE-071-P4, D3). A mechanical rule change must change
// RULE and supervisor.md in the same PR, so drift between the two fails here instead of halting a real run.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const SUPERVISOR = readFileSync(join(ROOT, ".claude", "agents", "supervisor.md"), "utf8");

const count = (haystack: string, needle: string): number => haystack.split(needle).length - 1;

test("P4 supervisor.md states the CLI's RULE exactly once", () => {
  assert.equal(count(SUPERVISOR, RULE), 1, `expected ${RULE} once in .claude/agents/supervisor.md`);
});

test("P4 supervisor.md runs the pipeline check JSON template", () => {
  assert.ok(SUPERVISOR.includes("pipeline check '<task dir>' --json"), "pipeline check template missing from supervisor.md");
});
