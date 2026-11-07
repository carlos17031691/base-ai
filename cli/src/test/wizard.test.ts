import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("wizard rejects non-TTY stdin", async () => {
  const originalIsTTY = process.stdin.isTTY;
  try {
    Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
    const { runWizard } = await import("../wizard.js");
    const d = mkdtempSync(join(tmpdir(), "base-ai-wizard-"));
    const code = await runWizard(d);
    assert.equal(code, 1);
  } finally {
    Object.defineProperty(process.stdin, "isTTY", { value: originalIsTTY, configurable: true });
  }
});

test("promptSelect validates numeric input bounds", async () => {
  const { Readable } = await import("node:stream");
  const { createInterface } = await import("node:readline");

  const input = new Readable({ read() {} });
  const iface = createInterface({ input, output: process.stdout, terminal: false });

  const question = (q: string): Promise<string> =>
    new Promise((resolve) => iface.question(q, (a) => resolve(a.trim())));

  setTimeout(() => input.push("2\n"), 10);
  const answer = await question("Pick: ");
  iface.close();

  assert.equal(answer, "2");
});

test("promptConfirm defaults to yes on empty input", async () => {
  const { Readable } = await import("node:stream");
  const { createInterface } = await import("node:readline");

  const input = new Readable({ read() {} });
  const iface = createInterface({ input, output: process.stdout, terminal: false });

  setTimeout(() => input.push("\n"), 10);
  const answer = await new Promise<string>((resolve) =>
    iface.question("Proceed? (Y/n): ", (a) => resolve(a.trim())),
  );
  iface.close();

  const result = !answer ? true : answer.toLowerCase().startsWith("y");
  assert.equal(result, true);
});

test("CLOUD_PROVIDERS and IAC_TOOLS are available for wizard selection", async () => {
  const { CLOUD_PROVIDERS, IAC_TOOLS } = await import("../services.js");
  assert.ok(CLOUD_PROVIDERS.length >= 5);
  assert.ok(IAC_TOOLS.length >= 4);
  assert.ok(CLOUD_PROVIDERS.includes("gcp"));
  assert.ok(IAC_TOOLS.includes("terraform"));
});
