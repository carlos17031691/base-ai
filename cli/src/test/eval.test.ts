import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkAssertion, loadEvalSuites, runEvals, renderEvalReport } from "../eval.js";

function makeEvalProject(suiteYaml: string): string {
  const d = mkdtempSync(join(tmpdir(), "base-ai-eval-"));
  mkdirSync(join(d, ".ai/evals"), { recursive: true });
  mkdirSync(join(d, ".ai/skills/adr"), { recursive: true });
  writeFileSync(join(d, ".ai/rules.md"), "# Rules\n- Keep it simple.");
  writeFileSync(join(d, ".ai/skills/adr/skill.md"), "---\nid: adr\ndescription: Record decisions\n---\nWrite an ADR.");
  writeFileSync(join(d, ".ai/evals/test.eval.yaml"), suiteYaml);
  return d;
}

test("loadEvalSuites returns empty array when no evals directory exists", () => {
  const d = mkdtempSync(join(tmpdir(), "base-ai-eval-"));
  const suites = loadEvalSuites(d);
  assert.deepEqual(suites, []);
});

test("loadEvalSuites parses valid YAML eval suite", () => {
  const yaml = `suite: test-suite
description: A test suite
cases:
  - id: case-001
    type: deterministic
    input:
      value: "hello world"
    assertions:
      - type: contains
        value: "hello"
`;
  const d = makeEvalProject(yaml);
  const suites = loadEvalSuites(d);
  assert.equal(suites.length, 1);
  assert.equal(suites[0].suite, "test-suite");
  assert.equal(suites[0].cases.length, 1);
  assert.equal(suites[0].cases[0].id, "case-001");
});

test("loadEvalSuites rejects malformed suite (missing suite field)", () => {
  const yaml = `cases:
  - id: case-001
    type: deterministic
    input: { value: "x" }
    assertions:
      - type: exact
        value: "x"
`;
  const d = makeEvalProject(yaml);
  assert.throws(() => loadEvalSuites(d), /missing 'suite' field/);
});

test("loadEvalSuites rejects case without assertions", () => {
  const yaml = `suite: bad
cases:
  - id: no-assert
    type: deterministic
    input: { value: "x" }
    assertions: []
`;
  const d = makeEvalProject(yaml);
  assert.throws(() => loadEvalSuites(d), /must have at least one assertion/);
});

test("checkAssertion: exact match pass and fail", () => {
  const pass = checkAssertion({ type: "exact", value: "hello" }, "hello");
  assert.equal(pass.passed, true);

  const fail = checkAssertion({ type: "exact", value: "hello" }, "world");
  assert.equal(fail.passed, false);
});

test("checkAssertion: contains on string and array", () => {
  const strPass = checkAssertion({ type: "contains", value: "world" }, "hello world");
  assert.equal(strPass.passed, true);

  const arrPass = checkAssertion({ type: "contains", value: "b" }, ["a", "b", "c"]);
  assert.equal(arrPass.passed, true);

  const arrFail = checkAssertion({ type: "contains", value: "z" }, ["a", "b"]);
  assert.equal(arrFail.passed, false);
});

test("checkAssertion: regex match", () => {
  const pass = checkAssertion({ type: "regex", value: "^## \\w+" }, "## Skills");
  assert.equal(pass.passed, true);

  const fail = checkAssertion({ type: "regex", value: "^## \\d+" }, "## Skills");
  assert.equal(fail.passed, false);
});

test("checkAssertion: gte and lte", () => {
  assert.equal(checkAssertion({ type: "gte", value: 3 }, 5).passed, true);
  assert.equal(checkAssertion({ type: "gte", value: 10 }, 5).passed, false);
  assert.equal(checkAssertion({ type: "lte", value: 10 }, 5).passed, true);
  assert.equal(checkAssertion({ type: "lte", value: 3 }, 5).passed, false);
});

test("checkAssertion: json_schema validates objects", () => {
  assert.equal(checkAssertion({ type: "json_schema" }, { key: "val" }).passed, true);
  assert.equal(checkAssertion({ type: "json_schema" }, '{"key":"val"}').passed, true);
  assert.equal(checkAssertion({ type: "json_schema" }, "not json{").passed, false);
});

test("checkAssertion: field resolution with nested paths", () => {
  const data = { results: [{ id: "adr-001" }], length: 1 };
  const result = checkAssertion({ type: "gte", value: 1, field: "length" }, data);
  assert.equal(result.passed, true);
});

test("checkAssertion: field resolution with array wildcard", () => {
  const data = { results: ["a", "b", "c"] };
  const result = checkAssertion({ type: "contains", value: "b", field: "results[*]" }, data);
  assert.equal(result.passed, true);
});

test("checkAssertion: field resolution with nested array path (results[*].id)", () => {
  const data = { results: [{ id: "adr-001" }, { id: "adr-002" }] };
  const result = checkAssertion({ type: "contains", value: "adr-001", field: "results[*].id" }, data);
  assert.equal(result.passed, true);

  const fail = checkAssertion({ type: "contains", value: "adr-999", field: "results[*].id" }, data);
  assert.equal(fail.passed, false);
});

test("checkAssertion: regex rejects invalid patterns gracefully", () => {
  const result = checkAssertion({ type: "regex", value: "([" }, "test");
  assert.equal(result.passed, false);
  assert.ok(result.message.includes("invalid regex"));
});

test("checkAssertion: regex rejects patterns over 1000 chars", () => {
  const result = checkAssertion({ type: "regex", value: "a".repeat(1001) }, "test");
  assert.equal(result.passed, false);
  assert.ok(result.message.includes("1000 char limit"));
});

test("runEvals executes deterministic cases and reports pass/fail", async () => {
  const yaml = `suite: deterministic-suite
cases:
  - id: pass-case
    type: deterministic
    input:
      value: "hello world"
    assertions:
      - type: contains
        value: "hello"
      - type: regex
        value: "world$"
  - id: fail-case
    type: deterministic
    input:
      value: "foo"
    assertions:
      - type: exact
        value: "bar"
`;
  const d = makeEvalProject(yaml);
  const report = await runEvals(d);
  assert.equal(report.passed, 1);
  assert.equal(report.failed, 1);
  assert.equal(report.results[0].status, "pass");
  assert.equal(report.results[1].status, "fail");
});

test("runEvals skips llm_judge cases when no endpoint is configured", async () => {
  const yaml = `suite: llm-suite
cases:
  - id: judge-case
    type: llm_judge
    input:
      prompt: "test prompt"
    assertions:
      - type: llm_judge
        criteria: "Is it relevant?"
        threshold: 0.8
`;
  const d = makeEvalProject(yaml);
  const report = await runEvals(d);
  assert.equal(report.skipped, 1);
  assert.equal(report.results[0].status, "skip");
  assert.ok(report.results[0].error?.includes("no LLM endpoint"));
});

test("runEvals returns zero results when no evals directory", async () => {
  const d = mkdtempSync(join(tmpdir(), "base-ai-eval-"));
  const report = await runEvals(d);
  assert.equal(report.results.length, 0);
  assert.equal(report.passed, 0);
  assert.equal(report.failed, 0);
});

test("renderEvalReport produces Markdown table with summary", async () => {
  const yaml = `suite: md-suite
cases:
  - id: ok
    type: deterministic
    input: { value: "x" }
    assertions:
      - type: exact
        value: "x"
  - id: bad
    type: deterministic
    input: { value: "a" }
    assertions:
      - type: exact
        value: "b"
`;
  const d = makeEvalProject(yaml);
  const report = await runEvals(d);
  const md = renderEvalReport(report);
  assert.ok(md.includes("## AI Eval Report"));
  assert.ok(md.includes("| Suite |"));
  assert.ok(md.includes("md-suite"));
  assert.ok(md.includes("1 passed"));
  assert.ok(md.includes("1 failed"));
  assert.ok(md.includes("### Failures"));
});

test("renderEvalReport shows no failures section when all pass", async () => {
  const yaml = `suite: all-pass
cases:
  - id: ok
    type: deterministic
    input: { value: "test" }
    assertions:
      - type: contains
        value: "test"
`;
  const d = makeEvalProject(yaml);
  const report = await runEvals(d);
  const md = renderEvalReport(report);
  assert.ok(!md.includes("### Failures"));
  assert.ok(md.includes("1 passed"));
  assert.ok(md.includes("0 failed"));
});

test("loadEvalSuites rejects files over 1MB", () => {
  const d = mkdtempSync(join(tmpdir(), "base-ai-eval-"));
  mkdirSync(join(d, ".ai/evals"), { recursive: true });
  const bigYaml = "suite: big\ncases:\n  - id: c1\n    type: deterministic\n    input: { value: \"x\" }\n    assertions:\n      - type: exact\n        value: \"" + "x".repeat(1_100_000) + "\"";
  writeFileSync(join(d, ".ai/evals/big.eval.yaml"), bigYaml);
  assert.throws(() => loadEvalSuites(d), /exceeds 1MB limit/);
});

test("runEvals handles context_search type", async () => {
  const yaml = `suite: context-suite
cases:
  - id: search-001
    type: context_search
    input:
      query: "rules"
      top_k: 3
    assertions:
      - type: gte
        field: length
        value: 0
`;
  const d = makeEvalProject(yaml);
  const report = await runEvals(d);
  assert.equal(report.results.length, 1);
  assert.equal(report.results[0].status, "pass");
});
