import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { init } from "../init.js";
import { aiSync } from "../sync.js";

test("init creates a clean, synced project without CI by default", () => {
  const dir = join(mkdtempSync(join(tmpdir(), "base-ai-init-")), "demo");
  init(dir);
  for (const f of [".ai/rules.md", ".ai/skills/adr/skill.md", "templates/service/README.md", "services.yaml", "AGENTS.md", ".agents/skills/adr/SKILL.md", ".git", "src/.gitkeep", "docs/architecture/adrs/.gitkeep"]) {
    assert.ok(existsSync(join(dir, f)), f);
  }
  assert.ok(!existsSync(join(dir, ".github/workflows")), "no CI by default");
  assert.ok(!existsSync(join(dir, "cli")), "does not copy the CLI");
  assert.ok(!existsSync(join(dir, "docs/architecture/adrs/ADR-0001-arquitectura-base-ai.md")), "does not copy base-ai ADRs");
  assert.equal(aiSync(dir, true)[0].written.length, 0);
});

test("init supports --ci github and gitlab", () => {
  const base = mkdtempSync(join(tmpdir(), "base-ai-init-"));
  const gh = join(base, "gh");
  const gl = join(base, "gl");
  init(gh, "github");
  init(gl, "gitlab");
  assert.ok(existsSync(join(gh, ".github/workflows/base-ai.yml")));
  assert.ok(existsSync(join(gl, ".gitlab-ci.yml")));
});

test("init rejects non-empty directories", () => {
  const dir = mkdtempSync(join(tmpdir(), "base-ai-init-"));
  writeFileSync(join(dir, "x"), "");
  assert.throws(() => init(dir), /not empty/);
});
