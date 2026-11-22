import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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

function addDefinition(dir: string, name: string, bodyChars: number): number {
  mkdirSync(join(dir, ".claude/agents"), { recursive: true });
  const text = `---\nname: ${name}\ndescription: Role ${name}\n---\n${"z".repeat(bodyChars)}`;
  writeFileSync(join(dir, ".claude/agents", `${name}.md`), text);
  return text.length;
}

function setBudgets(dir: string, yaml: string): void {
  writeFileSync(join(dir, ".ai/config.yaml"), `version: 1\n${yaml}`);
}

test("role definitions are reported with whole-file chars and estimated tokens, largest first", () => {
  const d = makeProject();
  const small = addDefinition(d, "planner", 100);
  const big = addDefinition(d, "qa", 4000);

  const report = computeAiStats(d);
  assert.deepEqual(report.definitions, [
    { name: "qa", chars: big, estimatedTokens: Math.ceil(big / 4), references: [], totalTokens: Math.ceil(big / 4) },
    { name: "planner", chars: small, estimatedTokens: Math.ceil(small / 4), references: [], totalTokens: Math.ceil(small / 4) },
  ]);
  assert.equal(report.definitionsTotalTokens, Math.ceil(big / 4) + Math.ceil(small / 4));
});

test("a project with no budgets key gets the definitions report and no violation", () => {
  const d = makeProject();
  addDefinition(d, "qa", 40_000);

  const report = computeAiStats(d, { maxTokens: 5000 });
  assert.equal(report.definitionBudgets, null);
  assert.deepEqual(report.definitionViolations, []);
  assert.equal(report.withinBudget, true);
});

test("a definition above its budget is a violation naming the role and both numbers, without --max-tokens", () => {
  const d = makeProject();
  const chars = addDefinition(d, "qa", 4000);
  setBudgets(d, "budgets:\n  definitions:\n    qa: 10\n");

  const report = computeAiStats(d);
  const tokens = Math.ceil(chars / 4);
  assert.deepEqual(report.definitionViolations, [{ name: "qa", kind: "definition", estimatedTokens: tokens, budget: 10 }]);
  assert.equal(report.withinBudget, false);
  assert.ok(renderCiReport(report).includes(`- definition qa: ${tokens} tokens (budget: 10)`));
});

test("a definition with no entry is a violation when budgets.definitions exists", () => {
  const d = makeProject();
  addDefinition(d, "qa", 100);
  const chars = addDefinition(d, "planner", 100);
  setBudgets(d, "budgets:\n  definitions:\n    qa: 5000\n");

  const report = computeAiStats(d);
  assert.deepEqual(report.definitionViolations, [{ name: "planner", kind: "definition", estimatedTokens: Math.ceil(chars / 4), budget: null }]);
  assert.ok(renderCiReport(report).includes("definition planner:"));
  assert.ok(renderCiReport(report).includes("no entry in budgets.definitions"));
});

test("definitions within their budgets pass and the CI report shows each budget", () => {
  const d = makeProject();
  addDefinition(d, "qa", 100);
  setBudgets(d, "budgets:\n  definitions:\n    qa: 5000\n");

  const report = computeAiStats(d, { maxTokens: 5000 });
  assert.deepEqual(report.definitionViolations, []);
  assert.equal(report.withinBudget, true);
  const md = renderCiReport(report);
  assert.ok(md.includes("### Role definitions"));
  assert.ok(/\| qa \| \d+ \| \d+ \| 5000 \|/.test(md));
  assert.ok(md.includes("All components within budget."));
});

test("an invalid budget value throws naming the key", () => {
  for (const yaml of [
    "budgets:\n  definitions:\n    qa: 0\n",
    "budgets:\n  definitions:\n    qa: 1.5\n",
    "budgets:\n  definitions:\n    qa: many\n",
  ]) {
    const d = makeProject();
    addDefinition(d, "qa", 100);
    setBudgets(d, yaml);
    assert.throws(() => computeAiStats(d), /budgets\.definitions\.qa/);
  }
  const d = makeProject();
  setBudgets(d, "budgets:\n  definitions: 5\n");
  assert.throws(() => computeAiStats(d), /budgets\.definitions/);
});

function addReference(dir: string, role: string, name: string, chars: number): number {
  mkdirSync(join(dir, ".claude/agents", role), { recursive: true });
  const text = "r".repeat(chars);
  writeFileSync(join(dir, ".claude/agents", role, name), text);
  // The definition must name its reference file.
  const def = join(dir, ".claude/agents", `${role}.md`);
  writeFileSync(def, `${readFileSync(def, "utf8")}\nSee \`.claude/agents/${role}/${name}\`.\n`);
  return text.length;
}

test("reference files are reported under their definition, with a total per role and overall", () => {
  const d = makeProject();
  addDefinition(d, "qa", 400);
  addReference(d, "qa", "halt.md", 800);
  addReference(d, "qa", "base.md", 400);

  const report = computeAiStats(d);
  const qa = report.definitions[0];
  assert.deepEqual(qa.references, [
    { name: "qa/base.md", chars: 400, estimatedTokens: 100 },
    { name: "qa/halt.md", chars: 800, estimatedTokens: 200 },
  ]);
  assert.equal(qa.totalTokens, qa.estimatedTokens + 300);
  assert.equal(report.definitionsWithReferencesTokens, report.definitionsTotalTokens + 300);
  const md = renderCiReport(report);
  assert.ok(md.includes("| ↳ qa/halt.md | 800 | 200 | |"));
  assert.ok(md.includes("| qa with reference files | |"));
});

test("a definition with reference files above budgets.definition_totals is a violation", () => {
  const d = makeProject();
  addDefinition(d, "qa", 400);
  addReference(d, "qa", "halt.md", 4000);
  setBudgets(d, "budgets:\n  definitions:\n    qa: 5000\n  definition_totals:\n    qa: 1000\n");

  const report = computeAiStats(d);
  const qa = report.definitions[0];
  assert.deepEqual(report.definitionViolations, [{ name: "qa", kind: "total", estimatedTokens: qa.totalTokens, budget: 1000 }]);
  assert.ok(renderCiReport(report).includes(`- definition qa with reference files: ${qa.totalTokens} tokens (budget: 1000)`));
});

test("without a total budget, the definition budget caps the definition plus its reference files", () => {
  const d = makeProject();
  addDefinition(d, "qa", 400);
  addReference(d, "qa", "halt.md", 4000);
  setBudgets(d, "budgets:\n  definitions:\n    qa: 500\n");

  const report = computeAiStats(d);
  assert.deepEqual(report.definitionViolations.map((v) => v.kind), ["total"]);
  assert.equal(report.definitionViolations[0].budget, 500);
});

test("a budget map lookup ignores Object.prototype keys", () => {
  const d = makeProject();
  addDefinition(d, "constructor", 100);
  setBudgets(d, "budgets:\n  definitions:\n    qa: 5000\n");

  const report = computeAiStats(d);
  assert.deepEqual(report.definitionViolations.map((v) => [v.name, v.budget]), [["constructor", null]]);
});

test("a reference file its definition does not name, and a directory with no definition, throw naming the path", () => {
  const unnamed = makeProject();
  addDefinition(unnamed, "qa", 100);
  mkdirSync(join(unnamed, ".claude/agents/qa"), { recursive: true });
  writeFileSync(join(unnamed, ".claude/agents/qa/halt.md"), "text");
  assert.throws(() => computeAiStats(unnamed), /qa[\\/]halt\.md: reference file not named in \.claude\/agents\/qa\.md/);

  const orphan = makeProject();
  addDefinition(orphan, "qa", 100);
  mkdirSync(join(orphan, ".claude/agents/ghost"), { recursive: true });
  assert.throws(() => computeAiStats(orphan), /ghost: reference directory with no definition/);
});

test("an invalid definition_totals value throws naming the key", () => {
  const d = makeProject();
  setBudgets(d, "budgets:\n  definition_totals:\n    qa: -3\n");
  assert.throws(() => computeAiStats(d), /budgets\.definition_totals\.qa/);
});
