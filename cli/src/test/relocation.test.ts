import { test } from "node:test";
import assert from "node:assert/strict";
import { checkDeletionMap, compareRelocation, parseDeletionMap, resolveRanges, type DeletionEntry } from "../relocation.js";

const BEFORE = ["# Role", "", "Rule A stays.", "Block one.", "Block two.", "", "## List", "- item x", "- item y", "Rule A stays."].join("\n");

test("a pure move gives no missing line and ordered true", () => {
  const core = { file: "core.md", text: "# Role\n\nRule A stays.\n→ pointer\n\n## List\n- item x\n- item y\nRule A stays.\n" };
  const refs = [{ file: "ref.md", text: "# Ref header\nBlock one.\nBlock two.\n" }];
  const r = compareRelocation(BEFORE, core, refs);
  assert.deepEqual(r.missing, []);
  assert.equal(r.ordered, true);
  assert.equal(r.kept, 6);
  assert.equal(r.moved, 2);
  assert.deepEqual(r.added, [
    { file: "core.md", line: "→ pointer" },
    { file: "ref.md", line: "# Ref header" },
  ]);
});

test("a reworded line is missing and the new wording is added", () => {
  const r = compareRelocation(BEFORE, { file: "c", text: BEFORE.replace("Block two.", "Block 2.") }, []);
  assert.deepEqual(r.missing, ["Block two."]);
  assert.deepEqual(r.added, [{ file: "c", line: "Block 2." }]);
});

test("a duplicated line dropped once is missing once; trailing whitespace and blank lines are ignored", () => {
  const core = BEFORE.replace(/\nRule A stays\.$/, "").replace("Block one.", "Block one.   ") + "\n\n\n";
  const r = compareRelocation(BEFORE, { file: "c", text: core }, []);
  assert.deepEqual(r.missing, ["Rule A stays."]);
  assert.deepEqual(r.added, []);
});

test("a reordered core or reference file gives ordered false", () => {
  const swapped = BEFORE.replace("Block one.\nBlock two.", "Block two.\nBlock one.");
  assert.equal(compareRelocation(BEFORE, { file: "c", text: swapped }, []).ordered, false);
  const core = { file: "c", text: BEFORE.replace("Block one.\nBlock two.\n", "") };
  assert.equal(compareRelocation(BEFORE, core, [{ file: "r", text: "Block two.\nBlock one." }]).ordered, false);
});

// Deletable range: lines 8-9 of BEFORE ("- item x", "- item y").
const RANGES: [number, number][] = [[8, 9]];

test("a deletion map that matches the missing lines and has kept carriers passes", () => {
  const core = BEFORE.replace("- item y\n", "");
  const r = compareRelocation(BEFORE, { file: "c", text: core }, []);
  const map: DeletionEntry[] = [{ deleted: "- item y", carriers: ["Rule A"], where: "intro" }];
  assert.deepEqual(checkDeletionMap(BEFORE, core, r, map, RANGES), []);
});

test("map check (a): a missing line not in the map, and a map entry still present, are problems", () => {
  const core = BEFORE.replace("- item y\n", "");
  const r = compareRelocation(BEFORE, { file: "c", text: core }, []);
  const p = checkDeletionMap(BEFORE, core, r, [{ deleted: "- item x", carriers: ["Rule A"] }], RANGES);
  assert.ok(p.some((x) => x.entry === null && x.problem.includes("not matched by the map") && x.problem.includes("- item y")));
  assert.ok(p.some((x) => x.entry === null && x.problem.includes("not missing from the new text") && x.problem.includes("- item x")));
});

test("map check (b): a deleted line outside the ranges or not a list item is a problem", () => {
  const core = BEFORE.replace("Block one.\n", "");
  const r = compareRelocation(BEFORE, { file: "c", text: core }, []);
  const p = checkDeletionMap(BEFORE, core, r, [{ deleted: "Block one.", carriers: ["Rule A"] }], RANGES);
  assert.equal(p.length, 1);
  assert.equal(p[0].entry, 0);
  assert.match(p[0].problem, /not a "- " line inside lines 8-9/);
});

test("map check (c): a carrier only in a reference file, or in a kept item of the deletable list, is a problem", () => {
  const core = BEFORE.replace("- item y\n", "");
  const r = compareRelocation(BEFORE, { file: "c", text: core }, [{ file: "ref", text: "only here" }]);
  const p = checkDeletionMap(BEFORE, core, r, [{ deleted: "- item y", carriers: ["only here", "item x"] }], RANGES);
  assert.equal(p.length, 2);
  assert.ok(p.every((x) => x.entry === 0 && x.problem.startsWith("carrier not found")));
});

test("parseDeletionMap rejects malformed entries naming the entry, including a missing where", () => {
  assert.throws(() => parseDeletionMap("x"), /expected a JSON array or object/);
  assert.throws(() => parseDeletionMap([{ deleted: "- x", carriers: [], where: "w" }]), /entry 0/);
  assert.throws(() => parseDeletionMap([{ deleted: "- x", carriers: ["ok"], where: "w" }, { carriers: ["a"] }]), /entry 1/);
  assert.throws(() => parseDeletionMap([{ deleted: "- x", carriers: ["a"] }]), /entry 0.*"where"/);
  assert.throws(() => parseDeletionMap([{ deleted: "- x", carriers: ["a"], where: "  " }]), /entry 0/);
  assert.deepEqual(parseDeletionMap([{ deleted: "- x", carriers: ["a"], where: "Step 1" }]), {
    entries: [{ deleted: "- x", carriers: ["a"], where: "Step 1" }],
  });
});

const ENTRY = { deleted: "- x", carriers: ["a"], where: "Step 1" };

test("the object map form carries base, role and ranges, each validated", () => {
  const ok = parseDeletionMap({ base: "1b79e9f", role: "reviewer", ranges: [[3, 4], [9, 9]], entries: [ENTRY] });
  assert.deepEqual(ok, { base: "1b79e9f", role: "reviewer", ranges: [[3, 4], [9, 9]], entries: [ENTRY] });
  assert.throws(() => parseDeletionMap({ base: "main", role: "reviewer", ranges: [[1, 2]], entries: [] }), /"base"/);
  assert.throws(() => parseDeletionMap({ base: "1b79e9f", role: "Rev!", ranges: [[1, 2]], entries: [] }), /"role"/);
  for (const ranges of [[], [[2, 1]], [[0, 3]], [[1.5, 2]], [[1]], "1-2"]) {
    assert.throws(() => parseDeletionMap({ base: "1b79e9f", role: "reviewer", ranges, entries: [] }), /"ranges"/);
  }
  assert.throws(() => parseDeletionMap({ base: "1b79e9f", role: "reviewer", ranges: [[1, 2]], entries: [{}] }), /entry 0/);
});

test("resolveRanges binds an object map to its base and role, and uses the fallback only for an array map", () => {
  const sha = "1b79e9f1234567890abcdef1234567890abcdef1";
  const obj = parseDeletionMap({ base: "1b79e9f", role: "reviewer", ranges: [[3, 4]], entries: [ENTRY] });
  assert.deepEqual(resolveRanges(obj, sha, "reviewer", [[99, 99]]), [[3, 4]]);
  assert.throws(() => resolveRanges(obj, "47ead24aaaa", "reviewer"), /written for base 1b79e9f, not 47ead24aaaa/);
  assert.throws(() => resolveRanges(obj, sha, "qa"), /written for role "reviewer", not "qa"/);
  const arr = parseDeletionMap([ENTRY]);
  assert.deepEqual(resolveRanges(arr, sha, "qa", [[536, 566]]), [[536, 566]]);
  assert.throws(() => resolveRanges(arr, sha, "reviewer"), /no deletion ranges for role "reviewer"/);
});
