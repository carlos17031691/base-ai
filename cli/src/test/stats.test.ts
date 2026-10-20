import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeAiStats } from "../stats.js";

test("computeAiStats estimates always-on and per-skill token footprint", () => {
  const d = mkdtempSync(join(tmpdir(), "base-ai-stats-"));
  mkdirSync(join(d, ".ai/skills/adr"), { recursive: true });
  writeFileSync(join(d, ".ai/rules.md"), "# Global Rules\n- Keep functions small.");
  writeFileSync(join(d, ".ai/skills/adr/skill.md"), "---\nid: adr\ndescription: Record decisions\n---\nWrite an ADR.");

  const report = computeAiStats(d);
  assert.ok(report.alwaysOnTokens > 0);
  assert.equal(report.withinBudget, true);
  assert.equal(report.skills.length, 1);
  assert.equal(report.skills[0].name, "adr");
  assert.ok(report.skills[0].estimatedTokens > 0);
});
