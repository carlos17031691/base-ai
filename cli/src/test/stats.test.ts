import { spawnSync } from "node:child_process";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
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

test("T5 B11: with claude configured, always-on is the CLAUDE.md text (no indexes); without it, rules plus the skill index", () => {
  const rules = `# Global Rules\n${"r".repeat(400)}\n\n## Available agents\n\n${"a".repeat(800)}`;
  const skill = `---\nid: adr\ndescription: ${"d".repeat(400)}\n---\nWrite an ADR.`;
  const project = (agents?: string) => {
    const d = makeProject();
    writeFileSync(join(d, ".ai/rules.md"), rules);
    writeFileSync(join(d, ".ai/skills/adr/skill.md"), skill);
    if (agents !== undefined) writeFileSync(join(d, ".ai/config.yaml"), `agents: ${agents}\n`);
    return d;
  };
  const claudeText = `# Global Rules\n${"r".repeat(400)}`;
  const fullText = `${rules}\n\n- **adr**: ${"d".repeat(400)}`;
  assert.equal(computeAiStats(project()).alwaysOnTokens, Math.ceil(claudeText.length / 4), "all agents include claude");
  assert.equal(computeAiStats(project("[claude, cursor]")).alwaysOnTokens, Math.ceil(claudeText.length / 4));
  assert.equal(computeAiStats(project("[cursor, copilot]")).alwaysOnTokens, Math.ceil(fullText.length / 4));
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

// BASE-079-T6: budgets.always_on makes the always-on budget enforceable.
const CLI = resolve(dirname(fileURLToPath(import.meta.url)), "..", "index.js");

test("T6 budgets.always_on exceeded is a violation and withinBudget is false", () => {
  const d = makeProject();
  setBudgets(d, "budgets:\n  always_on: 5\n");
  const report = computeAiStats(d);
  assert.equal(report.alwaysOnEnforced, true);
  assert.equal(report.alwaysOnBudget, 5);
  assert.deepEqual(report.alwaysOnViolation, { estimatedTokens: report.alwaysOnTokens, budget: 5 });
  assert.equal(report.withinBudget, false);
});

test("T6 budgets.always_on not exceeded is no violation", () => {
  const d = makeProject();
  setBudgets(d, "budgets:\n  always_on: 2500\n");
  const report = computeAiStats(d);
  assert.equal(report.alwaysOnEnforced, true);
  assert.equal(report.alwaysOnBudget, 2500);
  assert.equal(report.alwaysOnViolation, null);
  assert.equal(report.withinBudget, true);
});

test("T6 --max-tokens larger than budgets.always_on does not replace it", () => {
  const d = makeProject();
  setBudgets(d, "budgets:\n  always_on: 5\n");
  const report = computeAiStats(d, { maxTokens: 5000 });
  assert.equal(report.alwaysOnBudget, 5);
  assert.notEqual(report.alwaysOnViolation, null);
  assert.deepEqual(report.violations, []);
  assert.equal(report.withinBudget, false);
});

test("T6 without budgets.always_on the figures are as before and nothing is enforced", () => {
  const d = makeProject();
  writeFileSync(join(d, ".ai/rules.md"), "word ".repeat(4000));
  const report = computeAiStats(d);
  assert.ok(report.alwaysOnTokens > 2500);
  assert.equal(report.alwaysOnEnforced, false);
  assert.equal(report.alwaysOnBudget, 2500);
  assert.equal(report.alwaysOnViolation, null);
  assert.equal(report.withinBudget, false);
  assert.equal(computeAiStats(d, { maxTokens: 9000 }).alwaysOnBudget, 9000);
});

test("T6 an invalid budgets.always_on throws naming the key", () => {
  for (const value of ["0", "-1", "1.5", '"x"']) {
    const d = makeProject();
    setBudgets(d, `budgets:\n  always_on: ${value}\n`);
    assert.throws(() => computeAiStats(d), /"budgets\.always_on" must be a positive integer/);
  }
});

test("T6 renderCiReport shows the enforced budget and its violation", () => {
  const d = makeProject();
  setBudgets(d, "budgets:\n  always_on: 5\n");
  const md = renderCiReport(computeAiStats(d));
  assert.match(md, /\*\*Budget:\*\* always-on 5 tokens \(budgets\.always_on\)/);
  assert.match(md, /- \*\*always-on context\*\*: \d+ tokens \(budget: 5, budgets\.always_on\)/);
  assert.doesNotMatch(md, /All components within budget/);
});

test("T6 renderCiReport labels --max-tokens violations with --max-tokens, not budgets.always_on", () => {
  const d = makeProject();
  mkdirSync(join(d, ".ai/skills/big"), { recursive: true });
  writeFileSync(join(d, ".ai/skills/big/skill.md"), `---\nid: big\ndescription: Big skill\n---\n${"x".repeat(20_000)}`);
  setBudgets(d, "budgets:\n  always_on: 2500\n");
  const report = computeAiStats(d, { maxTokens: 1000 });
  assert.equal(report.maxTokens, 1000);
  const md = renderCiReport(report);
  assert.match(md, /- \*\*big\*\*: \d+ tokens \(exceeds 1000\)/);
  assert.doesNotMatch(md, /exceeds 2500/);
});

test("T6 ai stats exits 1 on an enforced excess, with or without --max-tokens and --ci, and 0 without the key", () => {
  const d = makeProject();
  const run = (...args: string[]) => spawnSync(process.execPath, [CLI, "ai", "stats", "--root", d, ...args], { encoding: "utf8" });
  setBudgets(d, "budgets:\n  always_on: 5\n");
  const plain = run();
  assert.equal(plain.status, 1);
  assert.match(plain.stdout, /\(budget: 5, budgets\.always_on\)/);
  assert.match(plain.stdout, /always-on context: \d+ tokens \(budget: 5, budgets\.always_on\)/);
  assert.equal(run("--max-tokens", "5000").status, 1);
  assert.equal(run("--max-tokens", "5000", "--ci").status, 1);
  setBudgets(d, "");
  assert.equal(run().status, 0);
});
