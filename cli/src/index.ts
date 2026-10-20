#!/usr/bin/env node
import { resolve } from "node:path";
import { init } from "./init.js";
import { serviceAdd, serviceNew, serviceRemove, syncServices } from "./services.js";
import { aiSync } from "./sync.js";

const USAGE = `base-ai <command> [--root <dir>]

Commands:
  init <dir> [--ci none|github|gitlab]          Create a new project from the base-ai template
  ai sync                                       Export .ai/ to every agent's format (root and services)
  doctor                                        Fail if AI artefacts are out of date (for CI)
  service new <name> [--template t] [--repo url]   Create src/<name> from templates/<t> (git init)
  service add <name> <repo> [--branch b]        Register an existing repo in services.yaml and clone it
  service remove <name> [--purge]               Remove it from services.yaml (--purge deletes src/<name> if clean)
  sync                                          Clone/fast-forward all services, then run ai sync
`;

function parseArgs(argv: string[]) {
  const flags: Record<string, string | true> = {};
  const pos: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) flags[a.slice(2)] = argv[++i];
      else flags[a.slice(2)] = true;
    } else pos.push(a);
  }
  return { flags, pos };
}

const str = (v: string | true | undefined) => (typeof v === "string" ? v : undefined);

function main(argv: string[]): number {
  const { flags, pos } = parseArgs(argv);
  const root = resolve(str(flags.root) ?? process.cwd());
  const [cmd, sub, ...rest] = pos;

  if (cmd === "init") {
    console.log(`✔ Project created at ${init(sub, str(flags.ci))}`);
    return 0;
  }

  if ((cmd === "ai" && sub === "sync") || cmd === "doctor") {
    const check = cmd === "doctor";
    let drift = 0;
    for (const r of aiSync(root, check)) {
      r.written.forEach((f) => console.log(`  ${check ? "out of date" : "written"}: ${f}`));
      r.removed.forEach((f) => console.log(`  ${check ? "stale" : "removed"}: ${f}`));
      drift += r.written.length + r.removed.length;
      console.log(`✔ ${r.target}: ${r.written.length} changed, ${r.removed.length} removed, ${r.unchanged.length} unchanged`);
    }
    if (check && drift) {
      console.error("✖ AI artefacts are out of date. Run: base-ai ai sync");
      return 1;
    }
    return 0;
  }

  if (cmd === "service" && sub === "new") {
    console.log(`✔ Service created at ${serviceNew(root, rest[0], str(flags.template), str(flags.repo))}`);
    return 0;
  }
  if (cmd === "service" && sub === "add") {
    console.log(`✔ Service cloned at ${serviceAdd(root, rest[0], rest[1], str(flags.branch))}`);
    return 0;
  }
  if (cmd === "service" && sub === "remove") {
    serviceRemove(root, rest[0], flags.purge === true);
    console.log(`✔ Service "${rest[0]}" removed from services.yaml`);
    return 0;
  }
  if (cmd === "sync") {
    for (const r of syncServices(root)) console.log(`  ${r.name}: ${r.action}${r.reason ? ` (${r.reason})` : ""}`);
    console.log("✔ sync complete");
    return 0;
  }

  console.log(USAGE);
  return cmd ? 1 : 0;
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (e) {
  console.error(`✖ ${(e as Error).message}`);
  process.exitCode = 1;
}
