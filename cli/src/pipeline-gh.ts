/**
 * The process runner for `pipeline debt` (BASE-071-P2): one call at a time, no shell, stdin ignored,
 * with a timeout and an output cap. Errors are mapped to a class; stderr is never returned.
 */
import { spawnSync } from "node:child_process";
import type { Runner } from "./pipeline-registration.js";

export const CALL_TIMEOUT_MS = 60_000;
export const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

export function spawnRunner(timeoutMs = CALL_TIMEOUT_MS, maxBytes = MAX_OUTPUT_BYTES): Runner {
  return (cmd, args) => {
    const r = spawnSync(cmd, args, {
      encoding: "utf8",
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: timeoutMs,
      maxBuffer: maxBytes,
    });
    if (r.error) {
      const code = (r.error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return { kind: "error", reason: "missing" };
      if (code === "ETIMEDOUT") return { kind: "error", reason: "timeout" };
      if (code === "ENOBUFS") return { kind: "error", reason: "overflow" };
      return { kind: "error", reason: "exit" };
    }
    if (r.status !== 0) return { kind: "error", reason: "exit" };
    return { kind: "ok", stdout: r.stdout };
  };
}
