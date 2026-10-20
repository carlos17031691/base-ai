import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parse } from "yaml";
import { MARKER, render } from "./exporters.js";
import { loadSource, mergeSource, type AiSource } from "./source.js";

const LOCK = ".ai/generated.json";

export interface SyncResult {
  target: string;
  written: string[];
  removed: string[];
  unchanged: string[];
}

function readLock(dir: string): string[] {
  const p = join(dir, LOCK);
  return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as { files: string[] }).files : [];
}

/** Escribe (o, con check=true, solo compara) los artefactos de un directorio. Idempotente. */
export function syncDir(dir: string, src: AiSource, check: boolean): SyncResult {
  const files = render(src);
  const res: SyncResult = { target: dir, written: [], removed: [], unchanged: [] };
  const produced = new Set(files.map((f) => f.path));

  for (const f of files) {
    const abs = join(dir, f.path);
    if (existsSync(abs)) {
      const current = readFileSync(abs, "utf8");
      if (current === f.content) {
        res.unchanged.push(f.path);
        continue;
      }
      if (!current.includes(MARKER)) {
        throw new Error(`${abs} existe y no fue generado por base-ai; muévelo a .ai/ o bórralo`);
      }
    }
    res.written.push(f.path);
    if (!check) {
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, f.content);
    }
  }

  // Borra los artefactos obsoletos (skill o agente eliminado) que sigan llevando la marca.
  for (const old of readLock(dir)) {
    if (produced.has(old)) continue;
    const abs = join(dir, old);
    if (existsSync(abs) && readFileSync(abs, "utf8").includes(MARKER)) {
      res.removed.push(old);
      if (!check) rmSync(abs);
    }
  }

  if (!check) {
    mkdirSync(join(dir, ".ai"), { recursive: true });
    writeFileSync(join(dir, LOCK), JSON.stringify({ files: [...produced] }, null, 2) + "\n");
  }
  return res;
}

interface ServiceEntry {
  name: string;
  ai?: "inherit" | "none";
}

/** ai sync: raíz + servicios con ai: inherit presentes en src/. */
export function aiSync(root: string, check = false): SyncResult[] {
  const base = loadSource(root);
  const results = [syncDir(root, base, check)];

  const manifest = join(root, "services.yaml");
  if (!existsSync(manifest)) return results;
  const services = ((parse(readFileSync(manifest, "utf8")) ?? {}).services ?? []) as ServiceEntry[];

  for (const s of services) {
    if (s.ai === "none") continue;
    const dir = join(root, "src", s.name);
    if (!existsSync(dir)) continue; // aún no clonado: `base-ai sync`
    const local = existsSync(join(dir, ".ai")) ? loadSource(dir) : null;
    results.push(syncDir(dir, mergeSource(base, local), check));
  }
  return results;
}
