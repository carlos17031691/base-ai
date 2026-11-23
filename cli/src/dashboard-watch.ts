/**
 * Live change detection for `base-ai dashboard` (BASE-101-D3, epic #101).
 *
 * One non-recursive watcher on `.ai/tasks/` plus one per task directory (recursive `fs.watch` needs Node >= 20 on
 * Linux, and `engines` is >=18). Raw events carry no trusted information: their type and filename are ignored
 * (the filename can be null and macOS repeats events). They only open a 250 ms window per key, after which one
 * `task` (with the id) or `list` event is emitted. Ids come from `listTaskIds`, never from a filename, so no path
 * reaches a client.
 */
import { lstatSync, watch as fsWatch } from "node:fs";
import { join } from "node:path";
import { listTaskIds } from "./dashboard-data.js";

/** The part of an `fs.FSWatcher` used here; injectable so tests drive events by hand. */
export interface WatchHandle {
  close(): void;
  on(event: "error", listener: (e: Error) => void): unknown;
}
export type WatchFn = (path: string, listener: () => void) => WatchHandle;

/** Timer functions; injectable so tests control the clock. */
export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

export const realTimers: Timers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (h) => clearInterval(h as NodeJS.Timeout),
};

export const realWatch: WatchFn = (path, listener) => fsWatch(path, { persistent: false }, () => listener());

export type LiveEvent = { kind: "task"; id: string } | { kind: "list" };

export interface TaskWatcherOptions {
  root: string;
  onEvent: (e: LiveEvent) => void;
  err: (line: string) => void;
  watch?: WatchFn;
  timers?: Timers;
  /** The debounce window (H2): fixed, opened by the first raw event of a key. */
  windowMs?: number;
}

/** The inode of a task directory, or null when it cannot be read (it then counts as changed next time). */
function inode(path: string): number | null {
  try {
    return lstatSync(path).ino;
  } catch {
    return null;
  }
}

/** Starts the watchers; `close()` stops every watcher and clears every pending window. */
export function startTaskWatcher(o: TaskWatcherOptions): { close(): void } {
  const watch = o.watch ?? realWatch;
  const timers = o.timers ?? realTimers;
  const windowMs = o.windowMs ?? 250;
  const tasksDir = join(o.root, ".ai", "tasks");
  const tasks = new Map<string, { handle: WatchHandle | null; ino: number | null }>();
  const windows = new Map<string, unknown>();
  const reported = new Set<string>();
  let rootHandle: WatchHandle | null = null;
  let aiHandle: WatchHandle | null = null;
  let closed = false;

  const LIST = "\u0000list"; // cannot collide with a task id, which passes isTaskId

  /** H2: the first raw event of a key opens its window; later ones inside it are absorbed. */
  const fire = (key: string) => {
    if (closed || windows.has(key)) return;
    windows.set(
      key,
      timers.setTimeout(() => {
        windows.delete(key);
        if (!closed) o.onEvent(key === LIST ? { kind: "list" } : { kind: "task", id: key });
      }, windowMs),
    );
  };

  /** `watch`, or null. A missing directory is silent; any other code is reported once, without a path. */
  const tryWatch = (path: string, listener: () => void, onError: () => void): WatchHandle | null => {
    try {
      const h = watch(path, listener);
      h.on("error", onError);
      return h;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code ?? "error";
      if (code !== "ENOENT" && code !== "ENOTDIR" && !reported.has(code)) {
        reported.add(code);
        o.err(`base-ai dashboard: live updates limited (${code})`);
      }
      return null;
    }
  };

  const closeTask = (id: string) => {
    tasks.get(id)?.handle?.close();
    tasks.delete(id);
  };

  const openTask = (id: string) => {
    const handle = tryWatch(
      join(tasksDir, id),
      () => fire(id),
      () => {
        // A failed watcher is closed and kept as unwatched; the next root event re-opens it.
        const t = tasks.get(id);
        if (t !== undefined) {
          t.handle?.close();
          t.handle = null;
        }
      },
    );
    tasks.set(id, { handle, ino: inode(join(tasksDir, id)) });
  };

  /** Re-lists the task directories with D1's filter and brings the watchers in line; `list` fires on a change. */
  const reconcile = (initial: boolean) => {
    if (closed) return;
    const ids = new Set(listTaskIds(o.root).ids);
    let changed = false;
    for (const id of Array.from(tasks.keys())) {
      if (!ids.has(id)) {
        closeTask(id);
        changed = true;
      }
    }
    for (const id of ids) {
      const known = tasks.get(id);
      if (known === undefined) {
        openTask(id);
        changed = true;
      } else if (known.handle === null || known.ino !== inode(join(tasksDir, id))) {
        // Deleted and re-created, renamed in place, or a watcher that failed: watch the directory again.
        closeTask(id);
        openTask(id);
        fire(id);
      }
    }
    if (changed && !initial) fire(LIST);
  };

  const startAi = () => {
    if (aiHandle !== null || closed) return;
    aiHandle = tryWatch(
      join(o.root, ".ai"),
      () => {
        if (rootHandle === null && startRoot()) {
          reconcile(false);
          fire(LIST);
        }
      },
      () => {
        aiHandle?.close();
        aiHandle = null;
      },
    );
  };

  /** Watches `.ai/tasks/`; without it, `.ai/` is watched until it appears. */
  const startRoot = (): boolean => {
    rootHandle = tryWatch(
      tasksDir,
      () => reconcile(false),
      () => {
        rootHandle?.close();
        rootHandle = null;
        fire(LIST);
        startAi();
      },
    );
    if (rootHandle === null) {
      startAi();
      return false;
    }
    aiHandle?.close();
    aiHandle = null;
    return true;
  };

  startRoot();
  reconcile(true);

  return {
    close() {
      closed = true;
      for (const h of windows.values()) timers.clearTimeout(h);
      windows.clear();
      for (const id of Array.from(tasks.keys())) closeTask(id);
      rootHandle?.close();
      rootHandle = null;
      aiHandle?.close();
      aiHandle = null;
    },
  };
}
