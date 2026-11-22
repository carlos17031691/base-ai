/**
 * Relocation check (BASE-079-T2): proves that a role definition was slimmed only by moving lines byte for byte
 * into its reference files and, with a deletion map, by deleting listed lines whose rule another kept line states.
 * Pure functions; the I/O (git show, reading the files) lives in scripts/check-relocation.mjs.
 */

export interface RelocationFile {
  file: string;
  text: string;
}

export interface AddedLine {
  file: string;
  line: string;
}

export interface RelocationResult {
  /** Lines of `before` found in neither the core nor a reference file (with multiplicity). */
  missing: string[];
  /** Lines of the core and reference files not found in `before`, with their file. */
  added: AddedLine[];
  /** True when the core and each reference file, without their added lines, are subsequences of `before`. */
  ordered: boolean;
  /** Lines of `before` still in the core, and those now in a reference file. */
  kept: number;
  moved: number;
}

/** Lines compared exactly after removing trailing whitespace; blank lines are ignored. */
export function significantLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+$/, ""))
    .filter((l) => l !== "");
}

function counts(lines: string[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const l of lines) m.set(l, (m.get(l) ?? 0) + 1);
  return m;
}

function isSubsequence(seq: string[], of: string[]): boolean {
  let i = 0;
  for (const l of of) if (i < seq.length && seq[i] === l) i++;
  return i === seq.length;
}

export function compareRelocation(before: string, core: RelocationFile, references: RelocationFile[]): RelocationResult {
  const pool = counts(significantLines(before));
  const added: AddedLine[] = [];
  let kept = 0;
  let moved = 0;
  // Each file takes lines from the pool of `before`; what is left over in the pool is missing.
  const consumed = (f: RelocationFile, isCore: boolean): string[] => {
    const own: string[] = [];
    for (const line of significantLines(f.text)) {
      const n = pool.get(line) ?? 0;
      if (n > 0) {
        pool.set(line, n - 1);
        own.push(line);
        if (isCore) kept++;
        else moved++;
      } else {
        added.push({ file: f.file, line });
      }
    }
    return own;
  };
  const beforeLines = significantLines(before);
  const ordered = [consumed(core, true), ...references.map((r) => consumed(r, false))].every((own) =>
    isSubsequence(own, beforeLines),
  );
  const missing = [...pool.entries()].flatMap(([line, n]) => Array<string>(n).fill(line));
  return { missing, added, ordered, kept, moved };
}

export interface DeletionEntry {
  deleted: string;
  carriers: string[];
  where?: string;
}

/** Inclusive 1-based line ranges of `before` in which list items (`- `) may be deleted. */
export type LineRange = [number, number];

/** Validates and returns a deletion map read from JSON; throws naming the entry on a malformed one. */
export function parseDeletionMap(raw: unknown): DeletionEntry[] {
  if (!Array.isArray(raw)) throw new Error("deletion map: expected a JSON array");
  return raw.map((e, i) => {
    const ok =
      typeof e === "object" &&
      e !== null &&
      typeof (e as DeletionEntry).deleted === "string" &&
      Array.isArray((e as DeletionEntry).carriers) &&
      (e as DeletionEntry).carriers.length > 0 &&
      (e as DeletionEntry).carriers.every((c) => typeof c === "string" && c.trim() !== "");
    if (!ok) throw new Error(`deletion map entry ${i}: needs "deleted" (string) and non-empty "carriers" (strings)`);
    return e as DeletionEntry;
  });
}

export interface MapProblem {
  entry: number | null;
  problem: string;
}

/**
 * With a deletion map: (a) the missing lines equal the deleted entries as multisets; (b) each deleted line is a
 * `- ` line of `before` inside `ranges`; (c) each carrier occurs in a line of the new core that does not come from
 * `ranges` (so not in what is left of the deletable lists), never only in a reference file.
 */
export function checkDeletionMap(
  before: string,
  core: string,
  result: RelocationResult,
  map: DeletionEntry[],
  ranges: LineRange[],
): MapProblem[] {
  const problems: MapProblem[] = [];
  const norm = (l: string) => l.replace(/\s+$/, "");

  const missing = counts(result.missing);
  const deleted = counts(map.map((e) => norm(e.deleted)));
  for (const [line, n] of missing) {
    if ((deleted.get(line) ?? 0) !== n) problems.push({ entry: null, problem: `missing line not matched by the map ${n}x: ${line}` });
  }
  for (const [line, n] of deleted) {
    if ((missing.get(line) ?? 0) !== n) problems.push({ entry: null, problem: `map entry not missing from the new text ${n}x: ${line}` });
  }

  const beforeLines = before.split(/\r?\n/).map(norm);
  const inRange = (i: number) => ranges.some(([a, b]) => i + 1 >= a && i + 1 <= b);
  const deletable = counts(beforeLines.filter((l, i) => inRange(i) && l.startsWith("- ")));

  // Carriers must sit in core lines that do not come from the deletable ranges, matched by content.
  const rangeLines = new Set(beforeLines.filter((_, i) => inRange(i)));
  const carrierLines = core
    .split(/\r?\n/)
    .map(norm)
    .filter((l) => l !== "" && !rangeLines.has(l));

  map.forEach((e, i) => {
    const line = norm(e.deleted);
    if (!line.startsWith("- ") || (deletable.get(line) ?? 0) === 0) {
      problems.push({ entry: i, problem: `deleted line is not a "- " line inside lines ${ranges.map((r) => r.join("-")).join(", ")} of the base: ${line}` });
    }
    for (const c of e.carriers) {
      if (!carrierLines.some((l) => l.includes(c))) {
        problems.push({ entry: i, problem: `carrier not found in a core line outside the deletable ranges: ${c}` });
      }
    }
  });
  return problems;
}
