import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { aiSync } from "./sync.js";
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

/** What gets copied: AI source, service templates and the docs skeleton (.gitkeep only). */
function shouldCopy(src: string, base: string): boolean {
  const rel = relative(base, src);
  if (rel === "") return true;
  const [top] = rel.split(sep);
  if (top === ".ai") return !rel.endsWith("generated.json") && !rel.endsWith("context-index.json");
  if (top === "templates") return true;
  if (top === "docs") return !rel.endsWith(".md");
  return false;
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

const GITIGNORE = "src/*\n!src/.gitkeep\n.ai/context-index.json\n";

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
  writeServiceHooks(dir);
  aiSync(dir);
  bootstrapGitBaseline(dir, "chore: initial base-ai scaffold");
  return dir;
}
