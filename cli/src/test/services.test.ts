import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listServices, serviceAdd, serviceNew, serviceRemove, syncServices } from "../services.js";

const git = (args: string[], cwd: string) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

function root(): string {
  const d = mkdtempSync(join(tmpdir(), "base-ai-svc-"));
  mkdirSync(join(d, ".ai"), { recursive: true });
  writeFileSync(join(d, ".ai/rules.md"), "# Rules");
  writeFileSync(join(d, "services.yaml"), "# comment\nversion: 1\nservices: []\n");
  mkdirSync(join(d, "templates/service"), { recursive: true });
  writeFileSync(join(d, "templates/service/README.md"), "# {{name}}");
  return d;
}

function remote(bare = false): string {
  const r = mkdtempSync(join(tmpdir(), "base-ai-remote-"));
  if (bare) {
    git(["init", "-q", "--bare", "-b", "main"], r);
    return r;
  }
  git(["init", "-q", "-b", "main"], r);
  writeFileSync(join(r, "x.txt"), "1");
  git(["add", "."], r);
  git(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "init"], r);
  return r;
}

test("service new requires a remote repo, scaffolds template, configures origin & git hooks", () => {
  const d = root();
  assert.throws(() => serviceNew(d, "api", undefined), /every service requires a remote repository/);
  const dest = serviceNew(d, "api", "git@example.com:org/api.git");
  assert.equal(readFileSync(join(dest, "README.md"), "utf8"), "# api");
  assert.ok(existsSync(join(dest, ".git")));
  assert.ok(existsSync(join(dest, ".githooks/pre-commit")));
  assert.ok(existsSync(join(dest, "AGENTS.md")));
  assert.equal(git(["remote", "get-url", "origin"], dest).trim(), "git@example.com:org/api.git");
  assert.equal(git(["config", "core.hooksPath"], dest).trim(), ".githooks");
  assert.deepEqual(listServices(d).map((s) => s.name), ["api"]);
  assert.match(readFileSync(join(d, "services.yaml"), "utf8"), /# comment/);
  assert.throws(() => serviceNew(d, "api", "git@example.com:org/api.git"), /already exists/);
});

test("validates names, repos and branches", () => {
  const d = root();
  assert.throws(() => serviceNew(d, "../evil", "git@example.com:org/x.git"), /Invalid service name/);
  assert.throws(() => serviceAdd(d, "x", "--upload-pack=evil"), /Invalid repository URL/);
  assert.throws(() => serviceAdd(d, "x", "https://example.com/x.git", "--evil"), /Invalid branch/);
  assert.throws(() => serviceNew(d, "api", "git@example.com:org/api.git", { cloud: "invalid" }), /Invalid cloud provider/);
  assert.throws(() => serviceNew(d, "api", "git@example.com:org/api.git", { iac: "invalid" }), /Invalid IaC tool/);
});

test("service new with --cloud and --iac scaffolds infrastructure layout and records metadata", () => {
  const d = root();
  const dest = serviceNew(d, "billing", "git@example.com:org/billing.git", { cloud: "aws", iac: "opentofu" });
  assert.ok(existsSync(join(dest, "infrastructure/modules/.gitkeep")));
  assert.ok(existsSync(join(dest, "infrastructure/staging/.gitkeep")));
  assert.ok(existsSync(join(dest, "infrastructure/production/.gitkeep")));
  assert.match(readFileSync(join(dest, "infrastructure/README.md"), "utf8"), /aws \/ opentofu/);
  const [svc] = listServices(d);
  assert.equal(svc.cloud, "aws");
  assert.equal(svc.iac, "opentofu");
});

test("service add clones default remote branch and sync is idempotent", () => {
  const d = root();
  const r = remote();
  serviceAdd(d, "web", r);
  assert.ok(existsSync(join(d, "src/web/x.txt")));
  assert.equal(syncServices(d)[0].action, "updated");
  writeFileSync(join(d, "src/web/x.txt"), "local");
  assert.equal(syncServices(d)[0].action, "skipped");
});

test("git hooks enforce working branch, ticket ID in branch & commit, and block direct push to main/master/development", () => {
  const d = root();
  const bare = remote(true);
  const dest = serviceNew(d, "payments", bare);
  git(["config", "user.email", "t@t"], dest);
  git(["config", "user.name", "t"], dest);
  writeFileSync(join(dest, "a.txt"), "1");
  git(["add", "a.txt"], dest);

  // 1. Direct commit on main is blocked
  git(["checkout", "-q", "-B", "main"], dest);
  assert.throws(() => git(["commit", "-m", "feat(PROJ-123): init"], dest), /Direct commits on 'main' are forbidden/);

  // 2. Branch without ticket ID is blocked
  git(["checkout", "-q", "-b", "feat/no-ticket"], dest);
  assert.throws(() => git(["commit", "-m", "feat(PROJ-123): init"], dest), /must include a Story\/Epic\/Task ID/);

  // 3. Valid working branch with ticket ID, but commit message without ticket ID is blocked
  git(["checkout", "-q", "-b", "feat/PROJ-123-payment-flow"], dest);
  assert.throws(() => git(["commit", "-m", "add payment flow"], dest), /Commit message must reference a Story\/Epic\/Task ID/);

  // 4. Valid branch + valid commit message succeeds
  git(["commit", "-m", "feat(PROJ-123): add payment flow"], dest);

  // 5. Direct push to main, master or development is blocked
  assert.throws(() => git(["push", "origin", "HEAD:refs/heads/main"], dest), /Direct push to 'main' is forbidden/);
  assert.throws(() => git(["push", "origin", "HEAD:refs/heads/master"], dest), /Direct push to 'master' is forbidden/);
  assert.throws(() => git(["push", "origin", "HEAD:refs/heads/development"], dest), /Direct push to 'development' is forbidden/);

  // 6. Push of working branch for PR succeeds
  git(["push", "-q", "origin", "HEAD"], dest);
});

test("service remove --purge respects uncommitted changes", () => {
  const d = root();
  serviceAdd(d, "web", remote());
  writeFileSync(join(d, "src/web/x.txt"), "local");
  assert.throws(() => serviceRemove(d, "web", true), /uncommitted changes/);
});
