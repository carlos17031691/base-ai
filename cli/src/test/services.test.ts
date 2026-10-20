import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listServices, serviceAdd, serviceNew, serviceRemove, syncServices } from "../services.js";

const git = (args: string[], cwd: string) => execFileSync("git", args, { cwd, stdio: "ignore" });

function root(): string {
  const d = mkdtempSync(join(tmpdir(), "base-ai-svc-"));
  mkdirSync(join(d, ".ai"), { recursive: true });
  writeFileSync(join(d, ".ai/rules.md"), "# Reglas");
  writeFileSync(join(d, "services.yaml"), "# comentario\nversion: 1\nservices: []\n");
  mkdirSync(join(d, "templates/service"), { recursive: true });
  writeFileSync(join(d, "templates/service/README.md"), "# {{name}}");
  return d;
}

function remote(): string {
  const r = mkdtempSync(join(tmpdir(), "base-ai-remote-"));
  git(["init", "-q", "-b", "main"], r);
  writeFileSync(join(r, "x.txt"), "1");
  git(["add", "."], r);
  git(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "init"], r);
  return r;
}

test("service new crea desde plantilla, registra y exporta IA", () => {
  const d = root();
  const dest = serviceNew(d, "api");
  assert.equal(readFileSync(join(dest, "README.md"), "utf8"), "# api");
  assert.ok(existsSync(join(dest, ".git")));
  assert.ok(existsSync(join(dest, "AGENTS.md")));
  assert.deepEqual(listServices(d).map((s) => s.name), ["api"]);
  assert.match(readFileSync(join(d, "services.yaml"), "utf8"), /# comentario/);
  assert.throws(() => serviceNew(d, "api"), /ya existe/);
});

test("valida nombres y repos", () => {
  const d = root();
  assert.throws(() => serviceNew(d, "../evil"), /inválido/);
  assert.throws(() => serviceAdd(d, "x", "--upload-pack=evil"), /inválida/);
});

test("service add clona y sync es idempotente", () => {
  const d = root();
  const r = remote();
  serviceAdd(d, "web", r);
  assert.ok(existsSync(join(d, "src/web/x.txt")));
  assert.equal(syncServices(d)[0].action, "updated");
  writeFileSync(join(d, "src/web/x.txt"), "local");
  assert.equal(syncServices(d)[0].action, "skipped");
});

test("service remove --purge respeta cambios locales", () => {
  const d = root();
  serviceAdd(d, "web", remote());
  writeFileSync(join(d, "src/web/x.txt"), "local");
  assert.throws(() => serviceRemove(d, "web", true), /sin commitear/);
});
