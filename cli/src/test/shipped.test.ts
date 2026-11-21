import { test } from "node:test";
import assert from "node:assert/strict";
import { isShippedPath, SHIPPED_DOCS } from "../shipped.js";

test("isShippedPath ships the AI source, templates, role definitions and the state-machine doc", () => {
  for (const p of [
    "",
    ".ai",
    ".ai/rules.md",
    ".ai/skills/adr/skill.md",
    "templates",
    "templates/task/plan.md",
    "templates/service/.gitignore",
    ".claude",
    ".claude/agents",
    ".claude/agents/qa.md",
    "docs",
    "docs/architecture/adrs",
    "docs/architecture/adrs/.gitkeep",
    "docs/task-state-machine.md",
    ".coderabbit.yaml",
    "sonar-project.properties",
  ]) {
    assert.equal(isShippedPath(p), true, p);
  }
  assert.deepEqual(SHIPPED_DOCS, ["docs/task-state-machine.md"]);
});

test("isShippedPath excludes local state, generated artefacts and repository-only files", () => {
  for (const p of [
    ".ai/generated.json",
    ".ai/context-index.json",
    ".ai/tasks",
    ".ai/tasks/X/plan.md",
    ".claude/commands/adr.md",
    ".claude/settings.json",
    ".claude/settings.local.json",
    ".claude/agents/sub/x.md",
    ".claude/agents/notes.txt",
    "docs/architecture/adrs/ADR-0001-arquitectura-base-ai.md",
    "docs/contract-testing-gate.md",
    "cli/src/init.ts",
    ".github/workflows/ci.yml",
    "README.md",
  ]) {
    assert.equal(isShippedPath(p), false, p);
  }
});

test("isShippedPath normalises Windows separators and trailing slashes", () => {
  assert.equal(isShippedPath(".claude\\agents\\qa.md"), true);
  assert.equal(isShippedPath(".ai\\tasks\\X\\status.json"), false);
  assert.equal(isShippedPath("docs\\task-state-machine.md"), true);
  assert.equal(isShippedPath(".ai/tasks/"), false);
  assert.equal(isShippedPath("./templates/"), true);
});
