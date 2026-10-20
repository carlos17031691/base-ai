#!/usr/bin/env node
import { resolve } from "node:path";
import { serviceAdd, serviceNew, serviceRemove, syncServices } from "./services.js";
import { init } from "./init.js";
import { aiSync } from "./sync.js";

const USAGE = `base-ai <comando> [--root <dir>]

Comandos:
  init <dir>                                Crea un proyecto nuevo desde la plantilla base-ai
  ai sync                                   Exporta .ai/ a los formatos de cada agente (raíz y servicios)
  doctor                                    Falla si hay artefactos desactualizados (útil en CI)
  service new <nombre> [--template t] [--repo url]   Crea src/<nombre> desde templates/<t> (git init)
  service add <nombre> <repo> [--branch b]  Registra un repo existente en services.yaml y lo clona
  service remove <nombre> [--purge]         Lo quita de services.yaml (--purge borra src/<nombre> si está limpio)
  sync                                      Clona/actualiza (ff-only) todos los servicios y ejecuta ai sync
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
    console.log(`✔ Proyecto creado en ${init(sub)}`);
    return 0;
  }

  if ((cmd === "ai" && sub === "sync") || cmd === "doctor") {
    const check = cmd === "doctor";
    let drift = 0;
    for (const r of aiSync(root, check)) {
      r.written.forEach((f) => console.log(`  ${check ? "desactualizado" : "escrito"}: ${f}`));
      r.removed.forEach((f) => console.log(`  ${check ? "obsoleto" : "eliminado"}: ${f}`));
      drift += r.written.length + r.removed.length;
      console.log(`✔ ${r.target}: ${r.written.length} cambios, ${r.removed.length} eliminados, ${r.unchanged.length} sin cambios`);
    }
    if (check && drift) {
      console.error("✖ Hay artefactos desactualizados. Ejecuta: base-ai ai sync");
      return 1;
    }
    return 0;
  }

  if (cmd === "service" && sub === "new") {
    console.log(`✔ Servicio creado en ${serviceNew(root, rest[0], str(flags.template), str(flags.repo))}`);
    return 0;
  }
  if (cmd === "service" && sub === "add") {
    console.log(`✔ Servicio clonado en ${serviceAdd(root, rest[0], rest[1], str(flags.branch))}`);
    return 0;
  }
  if (cmd === "service" && sub === "remove") {
    serviceRemove(root, rest[0], flags.purge === true);
    console.log(`✔ Servicio "${rest[0]}" eliminado de services.yaml`);
    return 0;
  }
  if (cmd === "sync") {
    for (const r of syncServices(root)) console.log(`  ${r.name}: ${r.action}${r.reason ? ` (${r.reason})` : ""}`);
    console.log("✔ sync completado");
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
