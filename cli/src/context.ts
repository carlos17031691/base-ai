import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, join, relative, sep } from "node:path";
import { parse } from "yaml";

export type DocKind = "adr" | "rfc" | "runbook" | "postmortem" | "contract" | "service" | "memory" | "doc";

export interface ContextChunk {
  id: string;
  scope: string; // "root" or "service:<name>"
  kind: DocKind;
  path: string; // relative to root
  title: string;
  section: string;
  status?: string;
  startLine: number;
  endLine: number;
  snippet: string;
}

export interface ContextIndex {
  version: 1;
  chunks: ContextChunk[];
}

const INDEX_PATH = ".ai/context-index.json";
const CONTRACT_RE = /^(openapi|asyncapi|swagger|schema)\.(ya?ml|json)$|\.(proto|graphql|gql)$/i;

function classify(relPath: string): DocKind {
  const norm = relPath.split(sep).join("/");
  if (norm.endsWith(".ai/memory.md")) return "memory";
  if (norm.includes("/adrs/")) return "adr";
  if (norm.includes("/rfcs/")) return "rfc";
  if (norm.includes("/runbooks/")) return "runbook";
  if (norm.includes("/postmortems/")) return "postmortem";
  if (CONTRACT_RE.test(basename(norm))) return "contract";
  if (basename(norm).toLowerCase() === "readme.md" && norm.startsWith("src/")) return "service";
  return "doc";
}

function extractStatus(text: string): string | undefined {
  const m = /^\s*-\s*\*\*(?:Status|Estado):\*\*\s*(.+)$/im.exec(text);
  return m ? m[1].trim() : undefined;
}

/** Splits a Markdown or contract file into structure-aware chunks by H1/H2 headings with line numbers. */
function chunkFile(root: string, absPath: string, scope: string): ContextChunk[] {
  const relPath = relative(root, absPath).split(sep).join("/");
  const raw = readFileSync(absPath, "utf8").trim();
  if (!raw) return [];

  const kind = classify(relPath);
  const status = extractStatus(raw);
  const lines = raw.split(/\r?\n/);
  const h1 = lines.find((l) => /^#\s+/.test(l))?.replace(/^#\s+/, "").trim() ?? basename(relPath);

  if (!relPath.endsWith(".md")) {
    return [
      {
        id: `${relPath}#L1`,
        scope,
        kind,
        path: relPath,
        title: h1,
        section: basename(relPath),
        startLine: 1,
        endLine: lines.length,
        snippet: lines.slice(0, 25).join("\n").slice(0, 600),
      },
    ];
  }

  const sections: { section: string; start: number; end: number; body: string[] }[] = [];
  let current = { section: h1, start: 1, end: lines.length, body: [] as string[] };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = /^##\s+(.+)$/.exec(line);
    if (m && current.body.length > 0) {
      current.end = i;
      sections.push(current);
      current = { section: m[1].trim(), start: i + 1, end: lines.length, body: [] };
    } else {
      current.body.push(line);
    }
  }
  current.end = lines.length;
  sections.push(current);

  return sections
    .map((s) => {
      const clean = s.body
        .filter((l) => !/^<!--.*-->$/.test(l.trim()))
        .join("\n")
        .trim();
      return {
        id: `${relPath}#L${s.start}-L${s.end}`,
        scope,
        kind,
        path: relPath,
        title: h1,
        section: s.section,
        ...(status ? { status } : {}),
        startLine: s.start,
        endLine: s.end,
        snippet: clean.slice(0, 600),
      };
    })
    .filter((c) => c.snippet.length > 0);
}

function walkDocsAndContracts(dir: string, out: string[]): void {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir)) {
    if (entry === ".git" || entry === "node_modules" || entry === "dist" || entry.startsWith(".")) continue;
    const abs = join(dir, entry);
    const st = statSync(abs);
    if (st.isDirectory()) {
      walkDocsAndContracts(abs, out);
    } else if (entry.endsWith(".md") || CONTRACT_RE.test(entry)) {
      out.push(abs);
    }
  }
}

/** Scans root docs/README and every service in src/<name> to build `.ai/context-index.json`. */
export function buildContextIndex(root: string): ContextIndex {
  const chunks: ContextChunk[] = [];

  const rootReadme = join(root, "README.md");
  if (existsSync(rootReadme)) chunks.push(...chunkFile(root, rootReadme, "root"));
  const rootMemory = join(root, ".ai", "memory.md");
  if (existsSync(rootMemory)) chunks.push(...chunkFile(root, rootMemory, "root"));

  const rootFiles: string[] = [];
  walkDocsAndContracts(join(root, "docs"), rootFiles);
  for (const f of rootFiles.sort()) chunks.push(...chunkFile(root, f, "root"));

  const manifest = join(root, "services.yaml");
  const serviceNames = new Set<string>();
  if (existsSync(manifest)) {
    const parsed = (parse(readFileSync(manifest, "utf8")) ?? {}) as { services?: { name?: string }[] };
    for (const s of parsed.services ?? []) if (s.name) serviceNames.add(s.name);
  }
  const srcDir = join(root, "src");
  if (existsSync(srcDir)) {
    for (const e of readdirSync(srcDir, { withFileTypes: true })) {
      if (e.isDirectory()) serviceNames.add(e.name);
    }
  }

  for (const name of [...serviceNames].sort()) {
    const svcDir = join(root, "src", name);
    if (!existsSync(svcDir)) continue;
    const scope = `service:${name}`;
    const svcReadme = join(svcDir, "README.md");
    if (existsSync(svcReadme)) chunks.push(...chunkFile(root, svcReadme, scope));
    const svcMemory = join(svcDir, ".ai", "memory.md");
    if (existsSync(svcMemory)) chunks.push(...chunkFile(root, svcMemory, scope));
    const svcFiles: string[] = [];
    walkDocsAndContracts(join(svcDir, "docs"), svcFiles);
    walkDocsAndContracts(join(svcDir, "contracts"), svcFiles);
    walkDocsAndContracts(join(svcDir, "api"), svcFiles);
    for (const f of svcFiles.sort()) chunks.push(...chunkFile(root, f, scope));
  }

  const index: ContextIndex = { version: 1, chunks };
  mkdirSync(join(root, ".ai"), { recursive: true });
  writeFileSync(join(root, INDEX_PATH), JSON.stringify(index, null, 2) + "\n");
  return index;
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9áéíóúñü_-]+/i)
    .filter((t) => t.length >= 2);
}

export interface SearchHit extends ContextChunk {
  score: number;
}

/** Ranks project chunks against a natural-language or keyword query using BM25-style field weighting + IDF. */
export function searchContext(root: string, query: string, topK = 5, scopeFilter?: string): SearchHit[] {
  const idxFile = join(root, INDEX_PATH);
  const index: ContextIndex = existsSync(idxFile)
    ? (JSON.parse(readFileSync(idxFile, "utf8")) as ContextIndex)
    : buildContextIndex(root);

  const terms = [...new Set(tokenize(query))];
  if (!terms.length) return [];

  const pool = scopeFilter ? index.chunks.filter((c) => c.scope === scopeFilter) : index.chunks;
  const N = pool.length || 1;

  const df = new Map<string, number>();
  for (const t of terms) {
    let count = 0;
    for (const c of pool) {
      const hay = `${c.title} ${c.section} ${c.path} ${c.kind} ${c.snippet}`.toLowerCase();
      if (hay.includes(t)) count++;
    }
    df.set(t, count);
  }

  const hits: SearchHit[] = [];
  for (const c of pool) {
    const titleL = c.title.toLowerCase();
    const sectionL = c.section.toLowerCase();
    const pathL = c.path.toLowerCase();
    const bodyTokens = tokenize(c.snippet);
    let score = 0;
    for (const t of terms) {
      const idf = Math.log(1 + (N - (df.get(t) ?? 0) + 0.5) / ((df.get(t) ?? 0) + 0.5));
      const tfBody = bodyTokens.filter((w) => w === t || w.startsWith(t)).length;
      const inTitle = titleL.includes(t) ? 4 : 0;
      const inSection = sectionL.includes(t) ? 3 : 0;
      const inPathOrKind = pathL.includes(t) || c.kind === t || c.scope.includes(t) ? 2.5 : 0;
      const termScore = (inTitle + inSection + inPathOrKind + Math.min(tfBody, 5)) * idf;
      score += termScore;
    }
    if (score > 0) hits.push({ ...c, score: Number(score.toFixed(3)) });
  }

  return hits.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, topK);
}
