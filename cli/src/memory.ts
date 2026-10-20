import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { aiSync } from "./sync.js";

const MEMORY_HEADER = `# Project Memory

<!-- Persistent cross-session memory for AI agents (see \`memory\` skill).
     Add entries with \`base-ai memory add "<note>" [--ticket ID] [--tag tag]\` or edit this file directly, then run \`base-ai ai sync\`.
     Never store secrets, API keys or personal data (PII) here. -->
`;

const SECRET_RE = /\b(sk-[A-Za-z0-9_-]{16,}|sk-or-v1-[A-Za-z0-9]{16,}|ghp_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|Bearer\s+[A-Za-z0-9._-]{16,})\b/;

export interface MemoryOptions {
  ticket?: string;
  tag?: string;
  service?: string;
}

function resolveMemoryPath(root: string, service?: string): string {
  if (!service) return join(root, ".ai", "memory.md");
  const svcDir = join(root, "src", service);
  if (!existsSync(svcDir)) throw new Error(`Service directory not found: ${svcDir}`);
  return join(svcDir, ".ai", "memory.md");
}

/** Extracts active bullet entries (`- ...`) from a memory.md file. */
export function extractMemoryEntries(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.startsWith("- "));
}

/** Adds a persistent memory note to `.ai/memory.md` (root or service) and re-syncs AI artefacts + context index. */
export function memoryAdd(root: string, rawNote: string | undefined, opts: MemoryOptions = {}): string {
  const note = rawNote?.trim().replace(/\s+/g, " ");
  if (!note) throw new Error("Missing note: base-ai memory add \"<note>\"");
  if (SECRET_RE.test(note)) throw new Error("Refusing to store a potential secret or token in project memory");

  const file = resolveMemoryPath(root, opts.service);
  mkdirSync(dirname(file), { recursive: true });
  const current = existsSync(file) ? readFileSync(file, "utf8").trimEnd() : MEMORY_HEADER.trimEnd();

  const date = new Date().toISOString().slice(0, 10);
  const meta = [opts.ticket && `\`[${opts.ticket}]\``, opts.tag && `\`#${opts.tag.replace(/^#/, "")}\``]
    .filter(Boolean)
    .join(" ");
  const entry = `- **[${date}]**${meta ? ` ${meta}` : ""} ${note}`;

  writeFileSync(file, `${current}\n${entry}\n`);
  aiSync(root);
  return entry;
}

/** Lists active memory entries from `.ai/memory.md` (root or service). */
export function memoryList(root: string, service?: string): string[] {
  const file = resolveMemoryPath(root, service);
  if (!existsSync(file)) return [];
  return extractMemoryEntries(readFileSync(file, "utf8"));
}
