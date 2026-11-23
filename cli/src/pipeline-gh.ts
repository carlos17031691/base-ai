/**
 * The process runner for `pipeline debt` (BASE-071-P2) and the dashboard's registration check (BASE-101-D4):
 * one call at a time, no shell, stdin ignored, with a timeout and an output cap. Errors are mapped to a class;
 * stderr is drained and never returned. It is async (`spawn` with a callback, never a blocking call) so a check never blocks the
 * dashboard's event loop, and an aborted `signal` kills the running child.
 */
import { spawn } from "node:child_process";
import type { RunResult, Runner } from "./pipeline-registration.js";

export const CALL_TIMEOUT_MS = 60_000;
export const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

export interface RunnerOptions {
  timeoutMs?: number;
  maxBytes?: number;
  /** Aborting it kills the running child and makes every later call return `timeout` without spawning. */
  signal?: AbortSignal;
}

export function spawnRunner(o: RunnerOptions = {}): Runner {
  const timeoutMs = o.timeoutMs ?? CALL_TIMEOUT_MS;
  const maxBytes = o.maxBytes ?? MAX_OUTPUT_BYTES;
  return (cmd, args) =>
    new Promise<RunResult>((resolve) => {
      if (o.signal?.aborted) return resolve({ kind: "error", reason: "timeout" });
      const child = spawn(cmd, args, { shell: false, stdio: ["ignore", "pipe", "pipe"] });
      const chunks: Buffer[] = [];
      let bytes = 0;
      let outcome: RunResult | null = null;
      const finish = (r: RunResult) => {
        if (outcome !== null) return;
        outcome = r;
        clearTimeout(timer);
        o.signal?.removeEventListener("abort", onAbort);
        resolve(r);
      };
      // The first failure wins; the child is killed and its later exit is ignored.
      const kill = (r: RunResult) => {
        finish(r);
        child.kill("SIGKILL");
      };
      const onAbort = () => kill({ kind: "error", reason: "timeout" });
      const timer = setTimeout(() => kill({ kind: "error", reason: "timeout" }), timeoutMs);
      o.signal?.addEventListener("abort", onAbort, { once: true });
      child.stdout.on("data", (c: Buffer) => {
        bytes += c.length;
        if (bytes > maxBytes) return kill({ kind: "error", reason: "overflow" });
        chunks.push(c);
      });
      child.stderr.resume();
      child.on("error", (e: NodeJS.ErrnoException) => finish({ kind: "error", reason: e.code === "ENOENT" ? "missing" : "exit" }));
      child.on("close", (code) => finish(code === 0 ? { kind: "ok", stdout: Buffer.concat(chunks).toString("utf8") } : { kind: "error", reason: "exit" }));
    });
}
