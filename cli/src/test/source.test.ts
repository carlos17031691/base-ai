import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_EDITOR_URL, loadDashboardConfig, parseEditorUrl } from "../source.js";

// BASE-101-D2 H2: `dashboard.editor_url`, read once at start and served by /api/meta.
const F = "cfg.yaml";

test("parseEditorUrl: absent gives vscode://file/{path}; editor schemes with {path} once are accepted", () => {
  assert.equal(DEFAULT_EDITOR_URL, "vscode://file/{path}");
  assert.equal(parseEditorUrl(undefined, F), DEFAULT_EDITOR_URL);
  assert.equal(parseEditorUrl(null, F), DEFAULT_EDITOR_URL);
  for (const ok of ["vscode://file/{path}", "cursor://file/{path}:1", "idea://open?file={path}", "subl://open?url={path}", "x-editor+v2.1://{path}"]) {
    assert.equal(parseEditorUrl(ok, F), ok, ok);
  }
});

test("parseEditorUrl: script, data, web and file schemes, a missing or repeated {path}, non-strings and long values throw naming the key", () => {
  const bad: unknown[] = [
    "javascript:alert(1)//{path}",
    "data:text/html,{path}",
    "vbscript:{path}",
    "blob:{path}",
    "file://{path}",
    "http://evil.test/{path}",
    "https://evil.test/{path}",
    "JAVASCRIPT:{path}",
    "vscode://file/",
    "vscode://{path}/{path}",
    "{path}",
    " vscode://file/{path}",
    42,
    ["vscode://file/{path}"],
    `vscode://file/{path}${"x".repeat(200)}`,
  ];
  for (const v of bad) assert.throws(() => parseEditorUrl(v, F), /^Error: cfg\.yaml: "dashboard\.editor_url" must be/, String(v));
});

test("loadDashboardConfig reads .ai/config.yaml once: no file, no key, a value, and a non-mapping dashboard", () => {
  const r = mkdtempSync(join(tmpdir(), "src-cfg-"));
  try {
    mkdirSync(join(r, ".ai"));
    assert.deepEqual(loadDashboardConfig(r), { editorUrl: DEFAULT_EDITOR_URL });
    writeFileSync(join(r, ".ai", "config.yaml"), "agents: all\n");
    assert.deepEqual(loadDashboardConfig(r), { editorUrl: DEFAULT_EDITOR_URL });
    writeFileSync(join(r, ".ai", "config.yaml"), "dashboard:\n  editor_url: cursor://file/{path}\n");
    assert.deepEqual(loadDashboardConfig(r), { editorUrl: "cursor://file/{path}" });
    writeFileSync(join(r, ".ai", "config.yaml"), "dashboard: yes\n");
    assert.throws(() => loadDashboardConfig(r), /"dashboard" must be a mapping/);
  } finally {
    rmSync(r, { recursive: true, force: true });
  }
});
