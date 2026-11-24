import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseDocument } from "yaml";
import { aiSync } from "./sync.js";
import { isShippedPath } from "./shipped.js";
import { MEMORY_HEADER } from "./memory.js";
import { bootstrapGitBaseline, writeServiceHooks } from "./services.js";

export const CI_PROVIDERS = ["none", "github", "gitlab"] as const;
export type CiProvider = (typeof CI_PROVIDERS)[number];

/** Root template: `template/` bundled in the npm package or, in development, the base-ai repo itself. */
export function templateRoot(): string {
  const pkg = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const bundled = join(pkg, "template");
  return existsSync(bundled) ? bundled : resolve(pkg, "..");
}

/** What gets copied: the paths `isShippedPath` accepts (AI source, service and task templates,
 * the role definitions, the docs skeleton and the state-machine doc). */
function shouldCopy(src: string, base: string): boolean {
  return isShippedPath(relative(base, src));
}

const SERVICES = `# Service registry. Each service is an independent repo cloned into src/<name>.
version: 1
services: []
#  - name: api
#    repo: git@example.com:org/api.git
#    branch: main        # optional, defaults to the remote's default branch
#    template: service   # optional, template used by \`service new\`
#    ai: inherit         # inherit | none
`;

// Eight task files are versioned (BASE-071-P3 D1; plan-review.md since BASE-140-C D6), so CI can check them on the PR; evidence/ and anything else stay local.
const GITIGNORE = [
  "src/*",
  "!src/.gitkeep",
  ".ai/context-index.json",
  ".ai/tasks/*",
  "!.ai/tasks/*/",
  ".ai/tasks/*/*",
  "!.ai/tasks/*/usage.jsonl",
  "!.ai/tasks/*/status.json",
  "!.ai/tasks/*/plan.md",
  "!.ai/tasks/*/review-report.md",
  "!.ai/tasks/*/qa-report.md",
  "!.ai/tasks/*/decisions.md",
  "!.ai/tasks/*/improvement-report.md",
  "!.ai/tasks/*/plan-review.md",
  ".ai/usage/",
  "",
].join("\n");

/**
 * A new project starts with the usage hook off (H2): its hook command needs base-ai installed in node_modules,
 * which a fresh project does not have yet. BASE-101-D4 H13: it also starts without `usage.pricing`, because
 * base-ai's own prices are a maintainer choice, not a default for other projects. Comments in the copied config
 * are kept.
 */
export function disableUsageHook(dir: string): void {
  const cfgPath = join(dir, ".ai", "config.yaml");
  if (!existsSync(cfgPath)) return;
  const doc = parseDocument(readFileSync(cfgPath, "utf8"));
  doc.setIn(["usage", "hook"], "none");
  doc.deleteIn(["usage", "pricing"]);
  writeFileSync(cfgPath, doc.toString());
}

const CI: Record<Exclude<CiProvider, "none">, { path: string; content: string }> = {
  github: {
    path: ".github/workflows/base-ai.yml",
    content: `name: base-ai
on:
  push:
  pull_request:
permissions:
  contents: read
jobs:
  ai-doctor:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - name: AI artefacts in sync with .ai/
        run: npx --yes @carlos17031691/base-ai doctor
`,
  },
  gitlab: {
    path: ".gitlab-ci.yml",
    content: `ai-doctor:
  image: node:20
  script:
    - npx --yes @carlos17031691/base-ai doctor
`,
  },
};

const readme = (name: string) => `# ${name}

Project initialised with base-ai.

- The **root** holds only the AI layer (\`.ai/\`), cross-cutting decisions (\`docs/\`) and the service registry (\`services.yaml\`).
- Each **service** lives in \`src/<name>\` as an independent repository with its own architecture, infrastructure and CI/CD.

\`\`\`bash
npx @carlos17031691/base-ai service new api <repo>  # scaffold a service from templates/service (requires its own repo)
npx @carlos17031691/base-ai service add web <repo>  # register and clone an existing repo
npx @carlos17031691/base-ai sync                    # clone/update all services and install git hooks
npx @carlos17031691/base-ai ai sync                 # regenerate AI artefacts after editing .ai/
npx @carlos17031691/base-ai doctor                  # validate services.yaml and fail if AI artefacts are out of date
\`\`\`
`;

/** init: creates a new project in <dir> (must not exist or be empty). */
export function init(rawDir: string | undefined, ci: string = "none"): string {
  if (!rawDir) throw new Error("Missing directory: base-ai init <dir>");
  if (!CI_PROVIDERS.includes(ci as CiProvider)) throw new Error(`Unknown CI provider "${ci}" (${CI_PROVIDERS.join(" | ")})`);
  const dir = resolve(rawDir);
  if (existsSync(dir) && readdirSync(dir).length) throw new Error(`${dir} exists and is not empty`);
  const tpl = templateRoot();
  if (!existsSync(join(tpl, ".ai"))) throw new Error(`Invalid template at ${tpl}`);

  mkdirSync(dir, { recursive: true });
  cpSync(tpl, dir, { recursive: true, filter: (s) => shouldCopy(s, tpl) });
  const packedGitignore = join(dir, "templates", "service", "_gitignore");
  if (existsSync(packedGitignore)) renameSync(packedGitignore, join(dir, "templates", "service", ".gitignore"));
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src/.gitkeep"), "");
  if (ci !== "none") {
    const { path, content } = CI[ci as Exclude<CiProvider, "none">];
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  writeFileSync(join(dir, "services.yaml"), SERVICES);
  writeFileSync(join(dir, ".gitignore"), GITIGNORE);
  writeFileSync(join(dir, "README.md"), readme(basename(dir)));
  writeFileSync(join(dir, ".ai", "memory.md"), MEMORY_HEADER);
  disableUsageHook(dir);
  writeServiceHooks(dir);
  aiSync(dir);
  bootstrapGitBaseline(dir, "chore: initial base-ai scaffold");
  return dir;
}
