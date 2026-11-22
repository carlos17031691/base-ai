// Proves that a role definition was slimmed only by moving lines into its reference files and, with --map,
// by deleting mapped list items whose rule a kept core line still states (BASE-079-T2). Writes nothing.
// Usage (from cli/): npm run check:relocation -- <base-commit> <role> [--map <deletion-map.json>]
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkDeletionMap, compareRelocation, parseDeletionMap, resolveRanges } from "../dist/relocation.js";

// Ranges for the bare array map form of BASE-079-T2 only (qa.md at 47ead24). Newer maps carry their own
// "base", "role" and "ranges", which the script checks against its arguments (BASE-079-T3).
const DELETION_RANGES = { qa: [[536, 566], [579, 624]] };

const args = process.argv.slice(2);
const mapAt = args.indexOf("--map");
const mapFile = mapAt >= 0 ? args[mapAt + 1] : undefined;
const [commit, role] = args.filter((_, i) => mapAt < 0 || (i !== mapAt && i !== mapAt + 1));
if (!commit || !role || (mapAt >= 0 && !mapFile)) {
  console.error("usage: check-relocation.mjs <base-commit> <role> [--map <deletion-map.json>]");
  process.exit(2);
}

const repo = fileURLToPath(new URL("../../", import.meta.url));
const before = execFileSync("git", ["show", `${commit}:.claude/agents/${role}.md`], { cwd: repo, encoding: "utf8" });
const corePath = `.claude/agents/${role}.md`;
const core = { file: corePath, text: readFileSync(join(repo, corePath), "utf8") };
const refDir = join(repo, ".claude/agents", role);
const references = existsSync(refDir)
  ? readdirSync(refDir)
      .filter((f) => f.endsWith(".md"))
      .sort()
      .map((f) => ({ file: `.claude/agents/${role}/${f}`, text: readFileSync(join(refDir, f), "utf8") }))
  : [];

const result = compareRelocation(before, core, references);
let failed = !result.ordered;
let carriers = 0;
let deleted = 0;

if (mapFile) {
  const map = parseDeletionMap(JSON.parse(readFileSync(resolve(process.cwd(), mapFile), "utf8")));
  const resolved = execFileSync("git", ["rev-parse", "--verify", `${commit}^{commit}`], { cwd: repo, encoding: "utf8" }).trim();
  let ranges;
  try {
    ranges = resolveRanges(map, resolved, role, DELETION_RANGES[role]);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
  deleted = map.entries.length;
  carriers = map.entries.reduce((n, e) => n + e.carriers.length, 0);
  const problems = checkDeletionMap(before, core.text, result, map.entries, ranges);
  for (const p of problems) console.log(`map problem${p.entry === null ? "" : ` (entry ${p.entry})`}: ${p.problem}`);
  if (problems.length) failed = true;
} else {
  for (const l of result.missing) console.log(`missing: ${l}`);
  if (result.missing.length) failed = true;
}

for (const a of result.added) console.log(`added (${a.file}): ${a.line}`);
console.log(
  `relocation ${role} vs ${commit}: kept ${result.kept}, moved ${result.moved}, deleted ${deleted}, added ${result.added.length}, carriers ${carriers}; ` +
    `missing ${result.missing.length}, ordered ${result.ordered}${mapFile ? ", map checked" : ""}`,
);
console.log(failed ? "relocation check FAILED" : "relocation check passed");
process.exit(failed ? 1 : 0);
