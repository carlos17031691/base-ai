#!/usr/bin/env node
import { init } from "./init.js";

const args = process.argv.slice(2);
const ciIdx = args.indexOf("--ci");
const ci = ciIdx >= 0 ? args[ciIdx + 1] : undefined;
const dirArg = args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--ci");

try {
  const dir = init(dirArg, ci);
  console.log(`✔ Project created at ${dir}\n\n  cd ${dirArg}\n  npx base-ai service new <name>`);
} catch (e) {
  console.error(`✖ ${(e as Error).message}\n\nUsage: create-base-ai <dir> [--ci none|github|gitlab]`);
  process.exitCode = 1;
}
