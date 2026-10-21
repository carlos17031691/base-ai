// Copies the root template (.ai, templates, docs) into cli/template for npm publishing.
import { cpSync, existsSync, renameSync, rmSync } from "node:fs";
import { basename } from "node:path";

const out = new URL("../template/", import.meta.url);
rmSync(out, { recursive: true, force: true });

cpSync(new URL("../../.ai", import.meta.url), new URL(".ai", out), {
  recursive: true,
  filter: (src) => !src.endsWith("generated.json") && !src.endsWith("context-index.json"),
});

cpSync(new URL("../../templates", import.meta.url), new URL("templates", out), { recursive: true });
// npm strips files named `.gitignore` from tarballs; rename to `_gitignore` and restore on scaffold.
const svcGitignore = new URL("templates/service/.gitignore", out);
if (existsSync(svcGitignore)) renameSync(svcGitignore, new URL("templates/service/_gitignore", out));

cpSync(new URL("../../docs", import.meta.url), new URL("docs", out), {
  recursive: true,
  filter: (src) => !src.endsWith(".md") || basename(src).startsWith("_"),
});

cpSync(new URL("../../README.md", import.meta.url), new URL("../README.md", import.meta.url));
cpSync(new URL("../../.coderabbit.yaml", import.meta.url), new URL(".coderabbit.yaml", out));
cpSync(new URL("../../sonar-project.properties", import.meta.url), new URL("sonar-project.properties", out));
