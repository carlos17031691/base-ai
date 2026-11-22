import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { MAX_FILE_BYTES, type FileRead, type TaskInput } from "./pipeline-check.js";

/**
 * Reads a regular task file of at most `max` bytes. Never throws: a missing, oversized, non-regular or unreadable
 * file is reported. The limit is enforced while reading, through one descriptor, so a file that grows after the
 * size check, or a device or FIFO, cannot make the read unbounded.
 */
export function readBounded(path: string, max = MAX_FILE_BYTES): FileRead {
  let fd: number | undefined;
  try {
    // O_NONBLOCK: opening a FIFO for reading would otherwise wait for a writer.
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
    const st = fstatSync(fd);
    if (st.isDirectory()) return { kind: "error", reason: "is a directory" };
    if (!st.isFile()) return { kind: "error", reason: "is not a regular file" };
    if (st.size > max) return { kind: "error", reason: `larger than ${max} bytes` };
    const buf = Buffer.alloc(max + 1);
    let n = 0;
    for (let r = -1; r !== 0 && n <= max; n += r) r = readSync(fd, buf, n, max + 1 - n, null);
    if (n > max) return { kind: "error", reason: `larger than ${max} bytes` };
    return { kind: "ok", text: buf.subarray(0, n).toString("utf8") };
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return { kind: "missing" };
    return { kind: "error", reason: code === "EISDIR" ? "is a directory" : `cannot be read (${code ?? "error"})` };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Loads the task files of `taskDir` (resolved against `root`). */
export function loadTask(root: string, taskDir: string): TaskInput {
  const absPath = resolve(root, taskDir);
  const read = (name: string) => readBounded(join(absPath, name));
  return {
    dirName: basename(absPath),
    absPath,
    status: read("status.json"),
    plan: read("plan.md"),
    review: read("review-report.md"),
    qa: read("qa-report.md"),
    decisions: read("decisions.md"),
  };
}
