import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { aiSync } from "../sync.js";

function fixture(): string {
  const d = mkdtempSync(join(tmpdir(), "base-ai-"));
  mkdirSync(join(d, ".ai/skills/adr"), { recursive: true });
  writeFileSync(join(d, ".ai/rules.md"), "# Reglas\n- regla");
  writeFileSync(join(d, ".ai/skills/adr/skill.md"), "---\nid: adr\ndescription: Crea ADRs\n---\nCuerpo ADR");
  return d;
}

test("genera artefactos para todos los agentes", () => {
  const d = fixture();
  aiSync(d);
  for (const f of ["AGENTS.md", "CLAUDE.md", ".agents/skills/adr/SKILL.md", ".cursor/rules/adr.mdc", ".github/prompts/adr.prompt.md", ".claude/commands/adr.md"]) {
    assert.ok(existsSync(join(d, f)), f);
  }
  assert.match(readFileSync(join(d, ".agents/skills/adr/SKILL.md"), "utf8"), /^---\nname: "adr"/);
});

test("es idempotente y doctor detecta derivas", () => {
  const d = fixture();
  aiSync(d);
  assert.equal(aiSync(d, true)[0].written.length, 0);
  writeFileSync(join(d, ".ai/rules.md"), "# Cambiado");
  assert.ok(aiSync(d, true)[0].written.length > 0);
});

test("elimina artefactos obsoletos", () => {
  const d = fixture();
  aiSync(d);
  rmSync(join(d, ".ai/skills/adr"), { recursive: true });
  aiSync(d);
  assert.ok(!existsSync(join(d, ".agents/skills/adr/SKILL.md")));
});

test("no sobrescribe archivos no generados", () => {
  const d = fixture();
  writeFileSync(join(d, "CLAUDE.md"), "manual");
  assert.throws(() => aiSync(d), /no fue generado/);
});

test("servicios heredan y extienden reglas", () => {
  const d = fixture();
  writeFileSync(join(d, "services.yaml"), "version: 1\nservices:\n  - name: api\n");
  mkdirSync(join(d, "src/api/.ai"), { recursive: true });
  writeFileSync(join(d, "src/api/.ai/rules.md"), "Regla local");
  aiSync(d);
  const agents = readFileSync(join(d, "src/api/AGENTS.md"), "utf8");
  assert.match(agents, /# Reglas[\s\S]*Regla local/);
});
