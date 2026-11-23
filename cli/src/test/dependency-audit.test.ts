import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

// BASE-124-A: the dependency audit policy script shipped with the service template, and the two CI steps
// that run it. Fixtures are cut from a real OSV-Scanner 2.7.1 run (evidence/e0.md). No network, no process.
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const SCRIPT = join(root, "templates/service/.github/scripts/dependency-audit.cjs");
const require = createRequire(import.meta.url);
const { audit, sanitize, renderText, renderMarkdown, main, DEV_GROUPS } = require(SCRIPT);

const TODAY = "2026-11-23";
type Group = { ids?: unknown; aliases?: unknown; max_severity?: unknown };
const group = (max_severity: unknown, id = "GHSA-35jh-r3h4-6jhm", alias = "CVE-2021-23337"): Group => ({ ids: [id], aliases: [alias, id], max_severity });
const pkg = (groups: Group[], dependency_groups?: unknown, name = "lodash") => ({
  package: { name, version: "4.17.20", ecosystem: "npm" },
  ...(dependency_groups === undefined ? {} : { dependency_groups }),
  groups,
});
const scanOf = (...packages: unknown[]) => ({ results: [{ source: { path: "package-lock.json", type: "lockfile" }, packages }] });
const run = (scan: unknown, accepted: unknown = [], scannerExit = 1) => audit({ scan, accepted, scannerExit, today: TODAY });
const entry = (o: Record<string, unknown> = {}) => ({
  id: "GHSA-35jh-r3h4-6jhm",
  reason: "not reachable: the template function is never given untrusted input",
  accepted: "2026-11-01",
  expires: "2026-12-01",
  ...o,
});
const whys = (list: { why: string }[]) => list.map((f) => f.why);

test("High or Critical in a production dependency fails: 7.0, 9.8 and 10 block; a missing, empty or non-numeric score blocks as unscored", () => {
  for (const score of ["7.0", "7.2", "9.8", "10", 7, 10]) {
    const r = run(scanOf(pkg([group(score)])));
    assert.equal(r.ok, false, String(score));
    assert.deepEqual(whys(r.blocking), ["high-or-critical"], String(score));
    assert.deepEqual([r.reported, r.accepted, r.errors], [[], [], []]);
  }
  for (const score of [undefined, "", "  ", "HIGH", null, {}]) {
    const r = run(scanOf(pkg([group(score)])));
    assert.deepEqual([r.ok, whys(r.blocking)], [false, ["unscored"]], String(score));
    assert.equal(r.blocking[0].severity, null);
  }
  const f = run(scanOf(pkg([group("8.1")]))).blocking[0];
  assert.deepEqual(f, { id: "GHSA-35jh-r3h4-6jhm", package: "lodash", version: "4.17.20", ecosystem: "npm", source: "package-lock.json", severity: 8.1, why: "high-or-critical" });
});

test("below High does not fail: 6.9 and 0.1 are reported, and exit status 1 with only reported findings stays ok", () => {
  for (const score of ["6.9", "0.1", "5.3", 0]) {
    const r = run(scanOf(pkg([group(score)])), [], 1);
    assert.deepEqual([r.ok, whys(r.reported), r.blocking], [true, ["below-high"], []], String(score));
  }
  // The real lodash fixture: two groups block, two are reported.
  const mixed = run(scanOf(pkg([group("5.3", "GHSA-29mw-wpgm-hmr9"), group("7.2"), group("8.1", "GHSA-r5fr-rjxr-66jc"), group("6.9", "GHSA-xxjr-mmjv-4gpg")])));
  assert.deepEqual([mixed.ok, mixed.blocking.length, mixed.reported.length], [false, 2, 2]);
});

test("production dependencies only: a High finding in a dev-only package is reported as dev-only; mixed groups, no groups and no key are production", () => {
  assert.deepEqual(DEV_GROUPS, ["dev"]);
  const dev = run(scanOf(pkg([group("9.8"), group(undefined, "GHSA-xvch-5gv4-984h")], ["dev"], "minimist")));
  assert.deepEqual([dev.ok, whys(dev.reported), dev.blocking], [true, ["dev-only", "dev-only"], []]);
  for (const groups of [["dev", "prod"], [], undefined, "dev", ["optional"]]) {
    const r = run(scanOf(pkg([group("9.8")], groups)));
    assert.deepEqual([r.ok, whys(r.blocking)], [false, ["high-or-critical"]], JSON.stringify(groups));
  }
});

test("a reviewed advisory is accepted until it expires: by id or alias, ignoring case; expiry today applies, yesterday does not; a stale entry changes nothing", () => {
  const scan = scanOf(pkg([group("7.2")]));
  for (const id of ["GHSA-35jh-r3h4-6jhm", "ghsa-35JH-r3h4-6jhm", "cve-2021-23337"]) {
    const r = run(scan, [entry({ id })]);
    assert.deepEqual([r.ok, r.blocking, r.errors, r.stale], [true, [], [], []], id);
    assert.deepEqual([r.accepted.length, r.accepted[0].why, r.accepted[0].expires, r.accepted[0].reason], [1, "high-or-critical", "2026-12-01", entry().reason]);
  }
  assert.equal(run(scan, [entry({ accepted: "2026-10-01", expires: TODAY })]).ok, true, "expires today still applies");
  const expired = run(scan, [entry({ accepted: "2026-10-01", expires: "2026-11-22" })]);
  assert.deepEqual([expired.ok, whys(expired.blocking), expired.accepted, expired.errors], [false, ["acceptance-expired"], [], []]);
  const stale = run({ results: [] }, [entry({ id: "GHSA-aaaa-bbbb-cccc" })], 0);
  assert.deepEqual([stale.ok, stale.stale], [true, ["GHSA-aaaa-bbbb-cccc"]]);
  // An acceptance never hides a different advisory of the same package.
  const other = run(scanOf(pkg([group("7.2"), group("8.1", "GHSA-r5fr-rjxr-66jc", "CVE-2026-4800")])), [entry()]);
  assert.deepEqual([other.ok, other.blocking.map((f: { id: string }) => f.id), other.accepted.length], [false, ["GHSA-r5fr-rjxr-66jc"], 1]);
});

test("a malformed acceptance cannot pass: every format error makes the audit fail even with no finding, and accepts nothing", () => {
  const clean = { results: [] };
  const bad: [string, unknown][] = [
    ["not JSON", null],
    ["not an array", {}],
    ["a string entry", ["GHSA-35jh-r3h4-6jhm"]],
    ["a missing key", [{ id: "GHSA-35jh-r3h4-6jhm", accepted: "2026-11-01", expires: "2026-12-01" }]],
    ["an unknown key", [entry({ owner: "someone" })]],
    ["a wrong type", [entry({ expires: 20261201 })]],
    ["a 19-character reason", [entry({ reason: "x".repeat(19) })]],
    ["a padded short reason", [entry({ reason: `   ${"x".repeat(19)}   ` })]],
    ["an id with a space", [entry({ id: "GHSA 35jh" })]],
    ["a 2-character id", [entry({ id: "ab" })]],
    ["2026-02-30", [entry({ accepted: "2026-02-30" })]],
    ["a date in another format", [entry({ expires: "01/12/2026" })]],
    ["accepted after today", [entry({ accepted: "2026-11-24", expires: "2026-12-01" })]],
    ["accepted after expires", [entry({ accepted: "2026-11-20", expires: "2026-11-19" })]],
    ["91 days", [entry({ accepted: "2026-09-01", expires: "2026-12-01" })]],
    ["the same id twice in different case", [entry(), entry({ id: "ghsa-35jh-r3h4-6JHM" })]],
  ];
  for (const [name, accepted] of bad) {
    const r = run(clean, accepted, 0);
    assert.equal(r.ok, false, name);
    assert.ok(r.errors.length >= 1 && r.errors.every((e: string) => e.startsWith("accepted file")), name);
  }
  assert.equal(run(clean, [entry({ accepted: "2026-09-02", expires: "2026-12-01" })], 0).ok, true, "exactly 90 days passes");
  assert.equal(run(clean, [entry({ reason: "x".repeat(20) })], 0).ok, true, "a 20-character reason passes");
  // One broken entry disables the valid ones too: a finding they would cover stays blocking.
  const mixed = run(scanOf(pkg([group("7.2")])), [entry(), entry({ id: "GHSA-aaaa-bbbb-cccc", reason: "short" })]);
  assert.deepEqual([mixed.ok, mixed.accepted, whys(mixed.blocking)], [false, [], ["high-or-critical"]]);
});

test("scanner failure fails the build: no readable results, an unexpected shape, or an exit status other than 0 or 1", () => {
  for (const scan of [null, undefined, {}, { results: null }, [], "x"]) {
    const r = run(scan, [], 0);
    assert.deepEqual([r.ok, r.blocking, r.errors.length], [false, [], 1], JSON.stringify(scan));
  }
  for (const code of [127, 128, 2, -1, NaN]) {
    const r = run({ results: [] }, [], code);
    assert.equal(r.ok, false, String(code));
    assert.match(r.errors[0], /^scanner failed: exit status /);
  }
  for (const scan of [{ results: [{}] }, { results: [{ packages: [{ package: {} }] }] }, { results: [{ packages: ["x"] }] }]) {
    assert.equal(run(scan, [], 0).ok, false, JSON.stringify(scan));
  }
  assert.equal(audit({ scan: { results: [] }, accepted: [], scannerExit: 0, today: "today" }).ok, false, "a bad clock value fails closed");
});

test("a clean scan passes with empty lists, and an absent accepted file is the empty list", () => {
  assert.deepEqual(run({ results: [] }, [], 0), { ok: true, errors: [], blocking: [], accepted: [], reported: [], stale: [] });
  assert.equal(run({ results: [], experimental_config: {} }, [], 0).ok, true);
});

test("sanitize: lockfile-controlled text stays on one line, is cut to 200 characters and cannot start a workflow command", () => {
  const nl = String.fromCharCode(10);
  const hostile = `evil${nl}::error::x`;
  assert.equal(sanitize(hostile), "evil ::error::x");
  assert.equal(sanitize("::set-output name=x::y"), " ::set-output name=x::y");
  assert.equal(sanitize("x".repeat(500)).length, 200);
  for (const code of [0, 13, 27, 127, 133, 8232, 8233]) assert.equal(sanitize(`a${String.fromCharCode(code)}b`), "a b", String(code));
  assert.equal(sanitize(42), "42");

  const scan = { results: [{ source: { path: `p${nl}::warning::w` }, packages: [pkg([group("9.8", `GHSA${nl}::error::id`)], undefined, `<b>|\`${nl}::error::name`)] }] };
  const r = run(scan);
  const text: string = renderText(r, ".github/dependency-audit-accepted.json");
  assert.ok(!text.split(nl).some((line) => line.startsWith("::")), "no output line starts a workflow command");
  assert.equal(text.split(nl).filter((line) => line.includes("::error::")).length, 1, "the hostile values stay inside their own line");
  assert.match(text, /dependency audit: FAIL \(1 blocking, 0 error\(s\)\)$/);
  assert.match(text, /\.github\/dependency-audit-accepted\.json by pull request/);
  const md: string = renderMarkdown(r);
  assert.ok(md.includes("&lt;b&gt;\\|\\`") && !md.includes("<b>"), "Markdown cells are escaped");
  assert.match(renderText(run({ results: [] }, [], 0), "x"), /^dependency audit: PASS$/);
  assert.match(renderMarkdown(run({ results: [] }, [], 0)), /^### Dependency audit: PASS/);
});

test("main: a missing, unknown or repeated option, or a non-integer --scanner-exit, exits 1 with a usage line", () => {
  const original = console.error;
  const seen: string[] = [];
  console.error = (m: string) => void seen.push(m);
  try {
    for (const argv of [[], ["--results", "r"], ["--results", "r", "--accepted", "a", "--scanner-exit", "x"], ["--nope", "1"], ["--results", "r", "--results", "r"], ["--results"]]) {
      assert.equal(main(argv), 1, argv.join(" "));
    }
  } finally {
    console.error = original;
  }
  assert.ok(seen.length === 6 && seen.every((m) => m.startsWith("usage: dependency-audit.cjs")));
});

type Step = { name?: string; if?: unknown; uses?: string; run?: string; env?: Record<string, string>; "continue-on-error"?: unknown };
const STEP = "Dependency audit (High/Critical, production dependencies)";
const steps = (file: string, job: string): Step[] => parse(readFileSync(join(root, file), "utf8")).jobs[job].steps;

test("the same gate in both workflows: one audit step each, the same pinned version and checksum, verified before the scanner runs, and nothing that lets it pass on failure", () => {
  const rootSteps = steps(".github/workflows/ci.yml", "cli");
  const serviceSteps = steps("templates/service/.github/workflows/ci.yml", "service");
  const pins: string[] = [];
  for (const [list, script, accepted] of [
    [rootSteps, "../templates/service/.github/scripts/dependency-audit.cjs", "../.github/dependency-audit-accepted.json"],
    [serviceSteps, ".github/scripts/dependency-audit.cjs", ".github/dependency-audit-accepted.json"],
  ] as const) {
    const found = list.filter((s) => s.name === STEP);
    assert.equal(found.length, 1);
    const step = found[0];
    assert.ok(!("if" in step) && !("continue-on-error" in step) && !("uses" in step));
    const run = step.run ?? "";
    assert.ok(!run.includes("|| true") && !run.includes("||"), "nothing swallows a failure");
    const lines = run.split(String.fromCharCode(10)).map((l) => l.trim());
    const at = (needle: string) => lines.findIndex((l) => l.includes(needle));
    assert.ok(at("curl --fail") === 0, "the download fails on an HTTP error");
    assert.ok(at("sha256sum --check") > 0 && at("sha256sum --check") < at("scan source"), "the checksum is verified before the binary runs");
    assert.ok(at("sha256sum --check") < at("chmod +x"));
    assert.ok(at("set +e") === at("scan source") - 1 && at("set -e") === at("scan source") + 2, "only the scan may exit non-zero");
    const last = lines.filter((l) => l !== "").pop() ?? "";
    assert.ok(last.startsWith(`node ${script} `) && last.includes(`--accepted ${accepted} `) && last.endsWith('--scanner-exit "$scanner_exit"'), last);
    assert.match(step.env?.OSV_SCANNER_VERSION ?? "", /^\d+\.\d+\.\d+$/);
    assert.match(step.env?.OSV_SCANNER_SHA256 ?? "", /^[0-9a-f]{64}$/);
    pins.push(`${step.env?.OSV_SCANNER_VERSION} ${step.env?.OSV_SCANNER_SHA256}`);
  }
  assert.equal(pins[0], pins[1], "the same pin in both workflows");

  // Where each step sits.
  const names = (list: Step[]) => list.map((s) => s.name ?? s.uses ?? s.run ?? "");
  const r = names(rootSteps);
  assert.ok(r.indexOf(STEP) === r.findIndex((n) => n.startsWith("Package ships every referenced file")) + 1 && r.indexOf(STEP) === r.findIndex((n) => n.startsWith("Token Budget Guardrail")) - 1);
  const s = names(serviceSteps);
  assert.ok(s.indexOf(STEP) === s.findIndex((n) => n.startsWith("actions/setup-node@")) + 1 && s.indexOf(STEP) === s.indexOf("Install dependencies") - 1);
  assert.ok(rootSteps.find((x) => x.name === STEP)?.run?.includes("--lockfile package-lock.json"));
  assert.ok(serviceSteps.find((x) => x.name === STEP)?.run?.includes("--recursive --allow-no-lockfiles"));

  // The template's actions stay pinned by commit.
  const uses = serviceSteps.flatMap((x) => (x.uses === undefined ? [] : [x.uses]));
  assert.ok(uses.length >= 3);
  for (const u of uses) assert.match(u, /@[0-9a-f]{40}$/, u);

  // The files the steps read.
  assert.ok(existsSync(SCRIPT));
  assert.ok(!readFileSync(SCRIPT, "utf8").includes("{{name}}"), "service new would replace it");
  for (const f of [".github/dependency-audit-accepted.json", "templates/service/.github/dependency-audit-accepted.json"]) {
    assert.deepEqual(JSON.parse(readFileSync(join(root, f), "utf8")), [], f);
  }
});
