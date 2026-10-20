#!/usr/bin/env node
import { init } from "./init.js";

try {
  const dir = init(process.argv[2]);
  console.log(`✔ Proyecto creado en ${dir}\n\n  cd ${process.argv[2]}\n  npx base-ai service new <nombre>`);
} catch (e) {
  console.error(`✖ ${(e as Error).message}\n\nUso: create-base-ai <dir>`);
  process.exitCode = 1;
}
