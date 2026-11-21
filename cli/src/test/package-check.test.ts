import { test } from "node:test";
import assert from "node:assert/strict";
import { EXEMPT, extractPathRefs, findMissing, requiredPath } from "../package-check.js";

test("extractPathRefs keeps template paths in inline code only", () => {
  const md = [
    "See `docs/task-state-machine.md`, `.claude/agents/<role>.md` and `templates/task/`.",
    "Also `.coderabbit.yaml`, `sonar-project.properties` and `.ai/rules.md`.",
    "Ignored: `/healthz`, `src/<name>`, `cli/**`, `docs/a b.md`, plain docs/x.md, `README.md`.",
    "```",
    "`docs/in-fence.md`",
    "```",
  ].join("\n");
  assert.deepEqual(extractPathRefs(md).sort(), [
    ".ai/rules.md",
    ".claude/agents/<role>.md",
    ".coderabbit.yaml",
    "docs/task-state-machine.md",
    "sonar-project.properties",
    "templates/task/",
  ]);
});

test("requiredPath cuts at the first placeholder segment", () => {
  assert.equal(requiredPath(".ai/tasks/<ticket-id>/plan.md"), ".ai/tasks/");
  assert.equal(requiredPath("docs/architecture/adrs/ADR-XXXX-title.md"), "docs/architecture/adrs/");
  assert.equal(requiredPath(".ai/skills/*/skill.md"), ".ai/skills/");
  assert.equal(requiredPath("templates/{service,task}/"), "templates/");
  assert.equal(requiredPath("docs/task-state-machine.md"), "docs/task-state-machine.md");
});

const packed = [
  "template/.ai/rules.md",
  "template/.claude/agents/qa.md",
  "template/docs/task-state-machine.md",
  "template/templates/task/plan.md",
  "dist/index.js",
];
const src = (text: string) => [{ file: ".ai/rules.md", text }];

test("findMissing returns nothing when every referenced path is packed", () => {
  const text = "`docs/task-state-machine.md` `.claude/agents/<role>.md` `templates/task/` `templates/task` `.ai/tasks/<id>/plan.md`";
  assert.deepEqual(findMissing(src(text), packed), []);
});

test("findMissing reports a removed shipped file with its source file", () => {
  const without = packed.filter((p) => p !== "template/docs/task-state-machine.md");
  assert.deepEqual(findMissing(src("Read `docs/task-state-machine.md`."), without), [
    { ref: "docs/task-state-machine.md", required: "docs/task-state-machine.md", file: ".ai/rules.md" },
  ]);
});

test("findMissing reports a directory with no packed file and exempts only .ai/tasks/", () => {
  assert.deepEqual(Object.keys(EXEMPT), [".ai/tasks/"]);
  const missing = findMissing(src("`templates/service/` and `.ai/tasks/BASE-1/status.json`"), packed);
  assert.deepEqual(missing.map((m) => m.required), ["templates/service/"]);
});
