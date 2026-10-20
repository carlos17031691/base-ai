#!/usr/bin/env node
import { resolve } from "node:path";
import { buildContextIndex, searchContext } from "./context.js";
import { runDoctor } from "./doctor.js";
import { init } from "./init.js";
import { memoryAdd, memoryList } from "./memory.js";
import { listServices, serviceAdd, serviceNew, serviceRemove, syncServices } from "./services.js";
import { aiSync } from "./sync.js";

const USAGE = `base-ai <command> [--root <dir>]

Commands:
  init <dir> [--ci none|github|gitlab]              Create a new project from the base-ai template
  ai sync                                           Export .ai/ to every agent's format and refresh context index
  doctor                                            Validate services.yaml and fail if AI artefacts are out of date
  context index                                     Build/refresh .ai/context-index.json across root and src/<name>
  context search <query> [--scope s] [--top k]      Retrieve ranked chunks (ADRs, RFCs, runbooks, contracts, memory)
  memory add "<note>" [--ticket id] [--tag t] [--service s]  Persist a cross-session memory note and sync agents
  memory list [--service s]                         List persisted project memory notes
  service new <name> <repo> [--template t]          Create src/<name> from templates/<t> with its own git repo & hooks
  service add <name> <repo> [--branch b]            Register an existing repo in services.yaml, clone it & install hooks
  service remove <name> [--purge]                   Remove it from services.yaml (--purge deletes src/<name> if clean)
  sync                                              Clone/fast-forward all services, install hooks and run ai sync
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

  if (cmd === "ai" && sub === "sync") {
    for (const r of aiSync(root, false)) {
      r.written.forEach((f) => console.log(`  written: ${f}`));
      r.removed.forEach((f) => console.log(`  removed: ${f}`));
      console.log(`✔ ${r.target}: ${r.written.length} changed, ${r.removed.length} removed, ${r.unchanged.length} unchanged`);
    }
    return 0;
  }

  if (cmd === "doctor") {
    const { syncResults, issues } = runDoctor(root);
    for (const r of syncResults) {
      r.written.forEach((f) => console.log(`  out of date: ${f}`));
      r.removed.forEach((f) => console.log(`  stale: ${f}`));
      console.log(`✔ ${r.target}: ${r.written.length} changed, ${r.removed.length} removed, ${r.unchanged.length} unchanged`);
    }
    if (issues.length) {
      issues.forEach((i) => console.error(`✖ ${i}`));
      return 1;
    }
    return 0;
  }

  if (cmd === "context" && sub === "index") {
    const idx = buildContextIndex(root);
    console.log(`✔ Indexed ${idx.chunks.length} chunks into .ai/context-index.json`);
    return 0;
  }

  if (cmd === "memory" && sub === "add") {
    const entry = memoryAdd(root, rest.join(" "), {
      ticket: str(flags.ticket),
      tag: str(flags.tag),
      service: str(flags.service),
    });
    console.log(`✔ Memory recorded: ${entry}`);
    return 0;
  }

  if (cmd === "memory" && sub === "list") {
    const entries = memoryList(root, str(flags.service));
    if (!entries.length) {
      console.log("No memory entries recorded yet.");
      return 0;
    }
    entries.forEach((e) => console.log(e));
    return 0;
  }

  if (cmd === "context" && sub === "search") {
    const query = rest.join(" ").trim();
    if (!query) throw new Error("Missing query: base-ai context search <query>");
    const topK = str(flags.top) ? Number(str(flags.top)) : 5;
    const hits = searchContext(root, query, topK, str(flags.scope));
    if (!hits.length) {
      console.log("No matching context chunks found.");
      return 0;
    }
    for (const h of hits) {
      console.log(`[${h.id}] (${h.scope} | ${h.kind}${h.status ? ` | ${h.status}` : ""} | score=${h.score}) — ${h.title} › ${h.section}`);
      console.log(`  ${h.snippet.replace(/\n+/g, " ").slice(0, 220)}\n`);
    }
    return 0;
  }

  if (cmd === "service" && sub === "new") {
    const repo = rest[1] ?? str(flags.repo);
    console.log(`✔ Service created at ${serviceNew(root, rest[0], repo, str(flags.template))}`);
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
