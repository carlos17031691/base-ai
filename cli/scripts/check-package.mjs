// Fails when a template path referenced by the shipped rules, skills, role definitions or state-machine
// doc is missing from the npm package (BASE-046-D1). Run through `npm run check:package`, which builds
// and bundles first; `--ignore-scripts` keeps prepack output out of the JSON listing.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { extractPathRefs, findMissing } from "../dist/package-check.js";

const cli = fileURLToPath(new URL("../", import.meta.url));
const tpl = join(cli, "template");
if (!existsSync(tpl)) {
  console.error("cli/template not found: run `npm run check:package` (it bundles first)");
  process.exit(1);
}

const [pack] = JSON.parse(
  execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { cwd: cli, encoding: "utf8" }),
);
const packed = pack.files.map((f) => f.path);

const read = (rel) => ({ file: rel, text: readFileSync(join(tpl, rel), "utf8") });
const list = (dir, pick) => (existsSync(join(tpl, dir)) ? readdirSync(join(tpl, dir)).sort().flatMap(pick) : []);
const sources = [
  read(".ai/rules.md"),
  ...list(".ai/skills", (d) => (existsSync(join(tpl, ".ai/skills", d, "skill.md")) ? [read(`.ai/skills/${d}/skill.md`)] : [])),
  ...list(".claude/agents", (f) => (f.endsWith(".md") ? [read(`.claude/agents/${f}`)] : [])),
  ...(existsSync(join(tpl, "docs/task-state-machine.md")) ? [read("docs/task-state-machine.md")] : []),
];

const missing = findMissing(sources, packed);
if (missing.length) {
  for (const m of missing) console.error(`missing from package: ${m.required} (referenced as \`${m.ref}\` in ${m.file})`);
  process.exit(1);
}
const refs = sources.reduce((n, s) => n + extractPathRefs(s.text).length, 0);
console.log(`package check passed: ${refs} refs in ${sources.length} sources, every referenced template path is packed`);
