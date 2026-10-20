// Copia la plantilla raíz (.ai, templates, docs) a cli/template para publicarla en npm.
import { cpSync, rmSync } from "node:fs";
const out = new URL("../template/", import.meta.url);
rmSync(out, { recursive: true, force: true });
for (const d of [".ai", "templates", "docs"]) cpSync(new URL(`../../${d}`, import.meta.url), new URL(d, out), { recursive: true });
