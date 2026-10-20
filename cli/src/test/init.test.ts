import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { init } from "../init.js";
import { aiSync } from "../sync.js";

test("init crea un proyecto limpio y sincronizado", () => {
  const dir = join(mkdtempSync(join(tmpdir(), "base-ai-init-")), "demo");
  init(dir);
  for (const f of [".ai/rules.md", ".ai/skills/adr/skill.md", "templates/service/README.md", "services.yaml", "AGENTS.md", ".agents/skills/adr/SKILL.md", ".git", "src/.gitkeep", ".github/workflows/ci.yml", "docs/architecture/adrs/.gitkeep"]) {
    assert.ok(existsSync(join(dir, f)), f);
  }
  assert.ok(!existsSync(join(dir, "cli")), "no copia el CLI");
  assert.ok(!existsSync(join(dir, "docs/architecture/adrs/ADR-0001-arquitectura-base-ai.md")), "no copia ADRs de base-ai");
  assert.equal(aiSync(dir, true)[0].written.length, 0);
});

test("init rechaza directorios no vacíos", () => {
  const dir = mkdtempSync(join(tmpdir(), "base-ai-init-"));
  writeFileSync(join(dir, "x"), "");
  assert.throws(() => init(dir), /no está vacío/);
});
