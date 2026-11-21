import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDoctor } from "../doctor.js";
import { serviceNew } from "../services.js";
import { aiSync } from "../sync.js";

const git = (args: string[], cwd: string) => execFileSync("git", args, { cwd, stdio: "ignore" });

function fixture(): string {
  const d = mkdtempSync(join(tmpdir(), "base-ai-doc-"));
  mkdirSync(join(d, ".ai"), { recursive: true });
  writeFileSync(join(d, ".ai/rules.md"), "# Rules");
  writeFileSync(join(d, "services.yaml"), "version: 1\nservices: []\n");
  mkdirSync(join(d, "templates/service"), { recursive: true });
  writeFileSync(join(d, "templates/service/README.md"), "# {{name}}");
  return d;
}

test("runDoctor passes on clean project + service and catches hook/remote/env issues", () => {
  const d = fixture();
  const svc = serviceNew(d, "api", "git@example.com:org/api.git");
  assert.deepEqual(runDoctor(d).issues, []);

  // Misconfigure remote and track a forbidden .env and .tfstate file
  git(["remote", "set-url", "origin", "git@example.com:org/wrong.git"], svc);
  writeFileSync(join(svc, ".env"), "SECRET=1");
  writeFileSync(join(svc, "terraform.tfstate"), "{}");
  git(["add", "-f", ".env", "terraform.tfstate"], svc);

  const report = runDoctor(d);
  assert.ok(report.issues.some((i) => i.includes("does not match services.yaml")));
  assert.ok(report.issues.some((i) => i.includes("forbidden secret/env file tracked in Git: .env")));
  assert.ok(report.issues.some((i) => i.includes("forbidden secret/env file tracked in Git: terraform.tfstate")));
});

test("runDoctor covers role definitions exported to services (BASE-046-D1)", () => {
  const d = fixture();
  mkdirSync(join(d, ".claude/agents"), { recursive: true });
  writeFileSync(join(d, ".claude/agents/qa.md"), "---\nname: qa\ndescription: Verifies criteria\n---\n\nBody\n");
  const svc = serviceNew(d, "api", "git@example.com:org/api.git");
  assert.match(readFileSync(join(svc, ".claude/agents/qa.md"), "utf8"), /Source: root \.claude\/agents\//);
  assert.deepEqual(runDoctor(d).issues, []);

  writeFileSync(join(d, ".claude/agents/qa.md"), "---\nname: qa\ndescription: Verifies criteria\n---\n\nChanged\n");
  assert.ok(runDoctor(d).issues.some((i) => i.endsWith("AI artefact out of date: .claude/agents/qa.md") && i.includes("api")));
  aiSync(d);
  assert.deepEqual(runDoctor(d).issues, []);
});
