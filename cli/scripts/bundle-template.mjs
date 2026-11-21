// Copies the root template into cli/template for npm publishing: .ai, templates, docs, the role
// definitions in .claude/agents, .coderabbit.yaml and sonar-project.properties, filtered by the same
// isShippedPath predicate that `init` uses (built to dist/ by `npm run build` before this script runs).
import { cpSync, existsSync, renameSync, rmSync } from "node:fs";
import { relative } from "node:path";
import { fileURLToPath } from "node:url";
import { isShippedPath } from "../dist/shipped.js";

const repo = fileURLToPath(new URL("../../", import.meta.url));
const out = new URL("../template/", import.meta.url);
rmSync(out, { recursive: true, force: true });

const filter = (src) => isShippedPath(relative(repo, src));
for (const entry of [".ai", "templates", "docs", ".claude/agents", ".coderabbit.yaml", "sonar-project.properties"]) {
  const src = new URL(entry, new URL("../../", import.meta.url));
  if (existsSync(src)) cpSync(src, new URL(entry, out), { recursive: true, filter });
}

// npm strips files named `.gitignore` from tarballs; rename to `_gitignore` and restore on scaffold.
const svcGitignore = new URL("templates/service/.gitignore", out);
if (existsSync(svcGitignore)) renameSync(svcGitignore, new URL("templates/service/_gitignore", out));

cpSync(new URL("../../README.md", import.meta.url), new URL("../README.md", import.meta.url));
