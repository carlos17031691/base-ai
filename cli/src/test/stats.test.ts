import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeAiStats, renderCiReport } from "../stats.js";

function makeProject(): string {
  const d = mkdtempSync(join(tmpdir(), "base-ai-stats-"));
  mkdirSync(join(d, ".ai/skills/adr"), { recursive: true });
  writeFileSync(join(d, ".ai/rules.md"), "# Global Rules\n- Keep functions small.");
  writeFileSync(join(d, ".ai/skills/adr/skill.md"), "---\nid: adr\ndescription: Record decisions\n---\nWrite an ADR.");
  return d;
}

test("computeAiStats estimates always-on and per-skill token footprint", () => {
  const report = computeAiStats(makeProject());
  assert.ok(report.alwaysOnTokens > 0);
  assert.equal(report.withinBudget, true);
  assert.equal(report.skills.length, 1);
  assert.equal(report.skills[0].name, "adr");
  assert.ok(report.skills[0].estimatedTokens > 0);
  assert.deepEqual(report.violations, []);
});

test("--max-tokens detects violations when a skill exceeds the threshold", () => {
  const d = mkdtempSync(join(tmpdir(), "base-ai-stats-"));
  mkdirSync(join(d, ".ai/skills/big"), { recursive: true });
  writeFileSync(join(d, ".ai/rules.md"), "Short rules.");
  const bigBody = "x".repeat(20_000);
  writeFileSync(join(d, ".ai/skills/big/skill.md"), `---\nid: big\ndescription: Big skill\n---\n${bigBody}`);

  const report = computeAiStats(d, { maxTokens: 1000 });
  assert.equal(report.withinBudget, false);
  assert.ok(report.violations.length > 0);
  assert.equal(report.violations[0].name, "big");
  assert.ok(report.violations[0].estimatedTokens > 1000);
});

test("--max-tokens detects always-on context violation", () => {
  const d = mkdtempSync(join(tmpdir(), "base-ai-stats-"));
  mkdirSync(join(d, ".ai/skills"), { recursive: true });
  writeFileSync(join(d, ".ai/rules.md"), "x".repeat(10_000));

  const report = computeAiStats(d, { maxTokens: 500 });
  assert.equal(report.withinBudget, false);
  assert.ok(report.violations.some((v) => v.name === "always-on"));
});

test("--max-tokens passes when all components are within budget", () => {
  const report = computeAiStats(makeProject(), { maxTokens: 5000 });
  assert.equal(report.withinBudget, true);
  assert.deepEqual(report.violations, []);
});

test("renderCiReport produces valid Markdown with cost/latency columns", () => {
  const report = computeAiStats(makeProject(), { maxTokens: 5000 });
  const md = renderCiReport(report);
  assert.ok(md.includes("## Token Budget Report"));
  assert.ok(md.includes("| Component |"));
  assert.ok(md.includes("Est. USD/call"));
  assert.ok(md.includes("Est. Latency"));
  assert.ok(md.includes("Always-on context"));
  assert.ok(md.includes("skill: adr"));
  assert.ok(md.includes("All components within budget."));
});

test("renderCiReport lists violations when present", () => {
  const d = mkdtempSync(join(tmpdir(), "base-ai-stats-"));
  mkdirSync(join(d, ".ai/skills/huge"), { recursive: true });
  writeFileSync(join(d, ".ai/rules.md"), "Short.");
  writeFileSync(join(d, ".ai/skills/huge/skill.md"), `---\nid: huge\ndescription: Huge\n---\n${"y".repeat(8_000)}`);

  const report = computeAiStats(d, { maxTokens: 500 });
  const md = renderCiReport(report);
  assert.ok(md.includes("### Violations"));
  assert.ok(md.includes("**huge**"));
});
