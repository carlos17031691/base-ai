#!/usr/bin/env node
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { buildContextIndex, searchContext } from "./context.js";
import { runDoctor } from "./doctor.js";
import { init } from "./init.js";
import { memoryAdd, memoryList } from "./memory.js";
import { listServices, serviceAdd, serviceNew, serviceRemove, syncServices } from "./services.js";
import { computeAiStats, describeDefinitionViolation, renderCiReport } from "./stats.js";
import { aiSync } from "./sync.js";
import { startMcpServer } from "./mcp.js";
import { parsePort, startDashboard } from "./dashboard.js";
import { runEvals, renderEvalReport } from "./eval.js";
import { runWizard } from "./wizard.js";
import { devUp, devStop, devStatus } from "./dev.js";
import { checkTask, renderText } from "./pipeline-check.js";
import { loadTask } from "./pipeline-files.js";
import { spawnRunner } from "./pipeline-gh.js";
import { checkRegistration, renderDebt } from "./pipeline-registration.js";
import { loadUsageConfig } from "./source.js";
import { guardHookProcess, readUsageReport, runUsageRecord } from "./usage-files.js";
import { renderUsageReport, stderrLine } from "./usage.js";

const USAGE = `base-ai <command> [--root <dir>]

Commands:
  init <dir> [--ci none|github|gitlab]              Create a new project from the base-ai template
  ai sync                                           Export .ai/ to every agent's format and refresh context index
  ai stats [--max-tokens N] [--ci]                   Report token footprint (context, skills, role definitions and their reference files);
                                                     fails if --max-tokens or a budgets.definitions / budgets.definition_totals entry
                                                     of .ai/config.yaml is exceeded; --ci outputs Markdown
  doctor                                            Validate services.yaml and fail if AI artefacts are out of date
  context index                                     Build/refresh .ai/context-index.json across root and src/<name>
  context search <query> [--scope s] [--top k]      Retrieve ranked chunks (ADRs, RFCs, runbooks, contracts, memory)
  memory add "<note>" [--ticket id] [--tag t] [--service s]  Persist a cross-session memory note and sync agents
  memory list [--service s]                         List persisted project memory notes
  service new <name> <repo> [--cloud c] [--iac i] [--template t]  Create src/<name> with its own git repo, hooks & optional IaC layout
  service add <name> <repo> [--branch b]            Register an existing repo in services.yaml, clone it & install hooks
  service remove <name> [--purge]                   Remove it from services.yaml (--purge deletes src/<name> if clean)
  sync                                              Clone/fast-forward all services, install hooks and run ai sync
  eval [--ci] [--suite name]                         Run AI eval suites from .ai/evals/; --ci outputs Markdown
  dev [--service name]                               Start local dev mesh (Docker Compose from services.yaml)
  dev stop                                           Stop the local dev mesh
  dev status                                         Show running dev mesh containers
  mcp                                               Start Model Context Protocol (MCP) server over stdio for AI agents
  wizard                                            Interactive guided setup for new projects and services
  pipeline check <task-dir> [--json]                Verify a pipeline task directory deterministically (status, lock,
                                                     rounds, verdict binding, decisions.md coverage, To register keys); exits 1
                                                     naming each failed check. Offline.
  pipeline debt <task-dir> [--issues n,…] [--json]  Check each To register key against GitHub issues (opt-in network, gh);
                                                     exit 0 registered, 1 missing, 2 could not check
  dashboard [--port N]                              Serve a read-only local JSON API over .ai/tasks/ on 127.0.0.1 (default port 4747)
  usage record                                      Record a Claude Code turn's tokens from a Stop/SubagentStop hook (stdin) into
                                                     .ai/tasks/<ticket>/usage.jsonl; always exits 0, nothing on stdout
  usage report <task-dir> [--json]                  Show a task's recorded tokens per agent and model, with USD cost from
                                                     usage.pricing of .ai/config.yaml, or "no price". Offline, read-only
`;

// Flags that never take a value, so `--json <task-dir>` keeps the path positional.
const BOOLEAN_FLAGS = new Set(["json"]);

function parseArgs(argv: string[]) {
  const flags: Record<string, string | true> = {};
  const pos: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (BOOLEAN_FLAGS.has(a.slice(2)) && a.startsWith("--")) flags[a.slice(2)] = true;
    else if (a.startsWith("--")) {
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

  if (cmd === "ai" && sub === "stats") {
    const maxTokens = str(flags["max-tokens"]) ? Number(str(flags["max-tokens"])) : undefined;
    const ci = flags.ci === true;
    const st = computeAiStats(root, { maxTokens, ci });

    if (ci) {
      console.log(renderCiReport(st));
    } else {
      const status = st.withinBudget ? "✔ within budget" : "⚠ exceeds budget";
      console.log(`Always-on context (rules + memory + skill index): ~${st.alwaysOnTokens} tokens (budget: ${st.alwaysOnBudget}) [${status}]`);
      console.log(`On-demand skills (${st.skills.length} skills, loaded only when invoked): ~${st.skillsTotalTokens} tokens total\n`);
      for (const s of st.skills) {
        console.log(`  - ${s.name.padEnd(16)} ~${String(s.estimatedTokens).padStart(4)} tokens (${s.chars} chars)`);
      }
      if (st.definitions.length > 0) {
        console.log(
          `\nRole definitions (${st.definitions.length}, each loaded whole by its agent run): ~${st.definitionsTotalTokens} tokens total` +
            (st.definitionsWithReferencesTokens > st.definitionsTotalTokens ? `, ~${st.definitionsWithReferencesTokens} with reference files` : "") +
            "\n",
        );
        for (const d of st.definitions) {
          const budget = st.definitionBudgets?.[d.name];
          console.log(`  - ${d.name.padEnd(16)} ~${String(d.estimatedTokens).padStart(5)} tokens (${d.chars} chars)${budget === undefined ? "" : ` [budget: ${budget}]`}`);
          for (const ref of d.references) {
            console.log(`      ↳ ${ref.name.padEnd(28)} ~${String(ref.estimatedTokens).padStart(5)} tokens (${ref.chars} chars, read when its case occurs)`);
          }
          if (d.references.length > 0) {
            const total = st.definitionTotals?.[d.name];
            console.log(`      = with reference files         ~${String(d.totalTokens).padStart(5)} tokens${total === undefined ? "" : ` [budget: ${total}]`}`);
          }
        }
      }
    }

    if (st.violations.length > 0 || st.definitionViolations.length > 0) {
      if (!ci) {
        console.log("\n✖ Token budget violations:");
        for (const v of st.violations) {
          console.log(`  - ${v.name}: ${v.estimatedTokens} tokens (max: ${maxTokens})`);
        }
        for (const v of st.definitionViolations) {
          console.log(`  - ${describeDefinitionViolation(v)}`);
        }
      }
      return 1;
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
    console.log(
      `✔ Service created at ${serviceNew(root, rest[0], repo, {
        template: str(flags.template),
        cloud: str(flags.cloud),
        iac: str(flags.iac),
      })}`,
    );
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
  if (cmd === "dashboard") {
    const port = parsePort(flags.port);
    if (port === null) {
      console.error("base-ai dashboard: --port must be an integer from 0 to 65535");
      return 1;
    }
    if (!existsSync(join(root, ".ai"))) throw new Error(`Not a base-ai project: ${root} (missing .ai/). Pass --root <dir>.`);
    // Prices are read once at start (H4): a bad config fails here, not on every request.
    const { pricing } = loadUsageConfig(root);
    const dash = startDashboard({
      root,
      port,
      pricing,
      out: (l) => console.log(l),
      err: (l) => console.error(l),
      proc: process,
    });
    dash.ready.catch((e) => {
      console.error((e as Error).message);
      process.exitCode = 1;
    });
    // `stopped` never rejects; `void` marks the chain as deliberately not awaited (Sonar S9383, PR #118).
    void dash.stopped.then(() => process.exit(0));
    return 0;
  }
  if (cmd === "mcp") {
    startMcpServer(root);
    return 0;
  }
  if (cmd === "eval") {
    const ci = flags.ci === true;
    const suiteFilter = str(flags.suite);
    runEvals(root).then((raw) => {
      const filtered = suiteFilter ? raw.results.filter((r) => r.suiteId === suiteFilter) : raw.results;
      const report = suiteFilter ? {
        results: filtered,
        passed: filtered.filter((r) => r.status === "pass").length,
        failed: filtered.filter((r) => r.status === "fail").length,
        skipped: filtered.filter((r) => r.status === "skip").length,
        errored: filtered.filter((r) => r.status === "error").length,
        totalMs: raw.totalMs,
      } : raw;
      if (ci) {
        console.log(renderEvalReport(report));
      } else {
        if (report.results.length === 0) {
          console.log("No eval suites found in .ai/evals/");
        } else {
          for (const r of report.results) {
            const icon = r.status === "pass" ? "✔" : r.status === "fail" ? "✖" : r.status === "skip" ? "⏭" : "!";
            console.log(`  ${icon} ${r.suiteId} / ${r.caseId}: ${r.status}${r.error ? ` — ${r.error}` : ""}`);
          }
          console.log(`\n${report.passed} passed, ${report.failed} failed, ${report.skipped} skipped, ${report.errored} errors (${report.totalMs}ms)`);
        }
      }
      process.exitCode = report.failed > 0 || report.errored > 0 ? 1 : 0;
    }).catch((e) => {
      console.error(`✖ ${(e as Error).message}`);
      process.exitCode = 1;
    });
    return 0;
  }
  if (cmd === "dev" && sub === "stop") {
    devStop(root);
    console.log("✔ Dev mesh stopped");
    return 0;
  }
  if (cmd === "dev" && sub === "status") {
    console.log(devStatus(root));
    return 0;
  }
  if (cmd === "dev") {
    const result = devUp(root, str(flags.service));
    console.log(`✔ Dev mesh started: ${result.services.join(", ")}${result.infra.length ? ` + infra: ${result.infra.join(", ")}` : ""}`);
    if (result.skipped.length) console.log(`  skipped (no Dockerfile): ${result.skipped.join(", ")}`);
    return 0;
  }
  if (cmd === "usage" && sub === "record") {
    // A hook must never fail the agent: every path, an internal error included, exits 0.
    const stderr = (line: string) => process.stderr.write(`${line}\n`);
    guardHookProcess(process, stderr);
    runUsageRecord({ root, stdin: process.stdin, env: process.env, now: Date.now, stderr })
      .catch(() => stderr(stderrLine("internal")))
      .finally(() => process.exit(0));
    return 0;
  }

  if (cmd === "usage" && sub === "report") {
    const dir = rest[0];
    if (!dir) {
      console.error("usage: base-ai usage report <task-dir> [--json] [--root <dir>]");
      return 1;
    }
    const report = readUsageReport(root, dir, loadUsageConfig(root).pricing);
    console.log(flags.json === true ? JSON.stringify(report, null, 2) : renderUsageReport(report));
    return 0;
  }

  if (cmd === "pipeline" && sub === "debt") {
    const usage = "usage: base-ai pipeline debt <task-dir> [--issues <n,…>] [--json] [--root <dir>]";
    const dir = rest[0];
    const issuesArg = flags.issues;
    if (!dir || (issuesArg !== undefined && !/^[1-9]\d*(,[1-9]\d*)*$/.test(str(issuesArg) ?? ""))) {
      console.error(usage);
      return 1;
    }
    const report = checkTask(loadTask(root, dir));
    const k16 = report.checks.find((c) => c.id === "K16");
    if (k16?.status !== "pass") {
      console.error(`keys not computed: K16 ${k16?.status ?? "missing"}`);
      return 1;
    }
    const issues = issuesArg === undefined ? [] : (str(issuesArg) as string).split(",").map(Number);
    const debt = checkRegistration(report, issues, spawnRunner());
    console.log(flags.json === true ? JSON.stringify(debt, null, 2) : renderDebt(debt));
    return debt.outcome === "registered" ? 0 : debt.outcome === "missing" ? 1 : 2;
  }

  if (cmd === "pipeline" && sub === "check") {
    const dir = rest[0];
    if (!dir) {
      console.error("usage: base-ai pipeline check <task-dir> [--json] [--root <dir>]");
      return 1;
    }
    const report = checkTask(loadTask(root, dir));
    console.log(flags.json === true ? JSON.stringify(report, null, 2) : renderText(report));
    return report.ok ? 0 : 1;
  }
  if (cmd === "wizard") {
    runWizard(root).then((code) => { process.exitCode = code; }).catch((e) => {
      console.error(`✖ ${(e as Error).message}`);
      process.exitCode = 1;
    });
    return 0;
  }

  console.log(USAGE);
  return cmd ? 1 : 0;
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (e) {
  // L6 (b): the parsed command, so `--root <dir> usage record` is recognised as well.
  const { pos } = parseArgs(process.argv.slice(2));
  if (pos[0] === "usage" && pos[1] === "record") {
    // A synchronous throw before dispatch (e.g. a deleted working directory) must not fail the agent either.
    process.stderr.write(`${stderrLine("internal")}\n`);
    process.exit(0);
  }
  console.error(`✖ ${(e as Error).message}`);
  process.exitCode = 1;
}
