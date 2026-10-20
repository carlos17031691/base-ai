import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { listServices } from "./services.js";
import { aiSync, type SyncResult } from "./sync.js";

export interface DoctorReport {
  syncResults: SyncResult[];
  issues: string[];
}

const TRACKED_FORBIDDEN_RE = /(^|\/)\.env(\..+)?$|(^|\/)[^/]+\.(pem|key|p12|pfx)$/i;
const TRACKED_ALLOWED_RE = /(^|\/)\.env\.example$/i;
const SECRET_CONTENT_RE = /\b(sk-or-v1-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{25,}|AKIA[0-9A-Z]{16})\b|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/;

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function checkRepoHygiene(dir: string, label: string, issues: string[]): void {
  if (!existsSync(join(dir, ".git"))) return;
  let tracked: string[] = [];
  try {
    const out = git(["ls-files"], dir);
    tracked = out ? out.split(/\r?\n/) : [];
  } catch {
    return;
  }

  for (const rel of tracked) {
    if (TRACKED_FORBIDDEN_RE.test(rel) && !TRACKED_ALLOWED_RE.test(rel)) {
      issues.push(`${label}: forbidden secret/env file tracked in Git: ${rel}`);
      continue;
    }
    if (rel.endsWith(".test.ts") || rel.endsWith(".test.js") || rel.startsWith("cli/dist/")) continue;
    const abs = join(dir, rel);
    if (!existsSync(abs)) continue;
    try {
      const content = readFileSync(abs, "utf8");
      if (SECRET_CONTENT_RE.test(content)) {
        issues.push(`${label}: potential hardcoded secret detected in tracked file: ${rel}`);
      }
    } catch {
      // Binary or unreadable file; ignore.
    }
  }
}

/** Runs all base-ai health checks: manifest validity, AI artefact drift, service git hooks/remotes and secret hygiene. */
export function runDoctor(root: string): DoctorReport {
  const issues: string[] = [];
  const services = listServices(root);
  const syncResults = aiSync(root, true);

  for (const r of syncResults) {
    for (const f of r.written) issues.push(`${r.target}: AI artefact out of date: ${f}`);
    for (const f of r.removed) issues.push(`${r.target}: stale AI artefact: ${f}`);
  }

  checkRepoHygiene(root, "root", issues);

  for (const s of services) {
    const dest = join(root, "src", s.name);
    if (!existsSync(dest)) continue;
    const label = `service:${s.name}`;

    for (const h of ["pre-commit", "commit-msg", "pre-push"]) {
      if (!existsSync(join(dest, ".githooks", h))) {
        issues.push(`${label}: missing git hook .githooks/${h} (run: base-ai sync)`);
      }
    }

    if (existsSync(join(dest, ".git"))) {
      try {
        const hooksPath = git(["config", "--get", "core.hooksPath"], dest);
        if (hooksPath !== ".githooks") {
          issues.push(`${label}: core.hooksPath is "${hooksPath}" instead of ".githooks" (run: base-ai sync)`);
        }
      } catch {
        issues.push(`${label}: core.hooksPath is not configured (run: base-ai sync)`);
      }

      try {
        const origin = git(["remote", "get-url", "origin"], dest);
        if (origin !== s.repo) {
          issues.push(`${label}: git remote origin (${origin}) does not match services.yaml (${s.repo})`);
        }
      } catch {
        issues.push(`${label}: missing git remote "origin" (expected ${s.repo})`);
      }
    }

    checkRepoHygiene(dest, label, issues);
  }

  return { syncResults, issues };
}
