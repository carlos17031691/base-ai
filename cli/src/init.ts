import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { aiSync } from "./sync.js";

/** Plantilla raíz: `template/` empaquetada en npm o, en desarrollo, el propio repo base-ai. */
export function templateRoot(): string {
  const pkg = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const bundled = join(pkg, "template");
  return existsSync(bundled) ? bundled : resolve(pkg, "..");
}

/** Qué se copia de la plantilla: fuente de IA, plantillas de servicio y el esqueleto de docs (solo .gitkeep). */
function shouldCopy(src: string, base: string): boolean {
  const rel = relative(base, src);
  if (rel === "") return true;
  const [top] = rel.split(sep);
  if (top === ".ai") return !rel.endsWith("generated.json");
  if (top === "templates") return true;
  if (top === "docs") return !rel.endsWith(".md");
  return false;
}

const SERVICES = `# Registro de servicios (ver docs). Cada uno es un repo independiente en src/<name>.
version: 1
services: []
#  - name: api
#    repo: git@github.com:org/api.git
#    branch: main
#    template: service
#    ai: inherit
`;

const GITIGNORE = "src/*\n!src/.gitkeep\n";

const CI = `name: ci
on:
  push:
    branches: [main]
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
      - name: Artefactos de IA sincronizados con .ai/
        run: npx --yes base-ai doctor
`;

const readme = (name: string) => `# ${name}

Proyecto inicializado con [base-ai](https://www.npmjs.com/package/base-ai).

- La **raíz** contiene solo la capa de IA (\`.ai/\`), las decisiones transversales (\`docs/\`) y el registro de servicios (\`services.yaml\`).
- Cada **servicio** vive en \`src/<nombre>\` como un repositorio independiente.

\`\`\`bash
npx base-ai service new api        # crea un servicio desde templates/service
npx base-ai service add web <repo>  # registra y clona un repo existente
npx base-ai sync                    # clona/actualiza todos los servicios
npx base-ai ai sync                 # regenera los artefactos de IA tras editar .ai/
\`\`\`
`;

/** init: crea un proyecto nuevo en <dir> (debe no existir o estar vacío). */
export function init(rawDir: string | undefined): string {
  if (!rawDir) throw new Error("Indica el directorio: base-ai init <dir>");
  const dir = resolve(rawDir);
  if (existsSync(dir) && readdirSync(dir).length) throw new Error(`${dir} existe y no está vacío`);
  const tpl = templateRoot();
  if (!existsSync(join(tpl, ".ai"))) throw new Error(`Plantilla inválida en ${tpl}`);

  mkdirSync(dir, { recursive: true });
  cpSync(tpl, dir, { recursive: true, filter: (s) => shouldCopy(s, tpl) });
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src/.gitkeep"), "");
  mkdirSync(join(dir, ".github/workflows"), { recursive: true });
  writeFileSync(join(dir, ".github/workflows/ci.yml"), CI);
  writeFileSync(join(dir, "services.yaml"), SERVICES);
  writeFileSync(join(dir, ".gitignore"), GITIGNORE);
  writeFileSync(join(dir, "README.md"), readme(basename(dir)));
  aiSync(dir);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir, stdio: "ignore" });
  return dir;
}
