import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startTaskWatcher, type LiveEvent, type Timers, type WatchFn, type WatchHandle } from "../dashboard-watch.js";

// BASE-101-D3: every test works in a temp root. The fake watch and timers make the timing deterministic (H8).

function sandbox(...ids: string[]) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "dash-watch-")));
  const tasks = join(root, ".ai", "tasks");
  mkdirSync(tasks, { recursive: true });
  for (const id of ids) mkdirSync(join(tasks, id));
  return { root, tasks, done: () => rmSync(root, { recursive: true, force: true }) };
}

/** A fake `watch`: records each watcher by path, lets a test fire raw events and errors, and can throw codes. */
function fakeWatch() {
  const live = new Map<string, { fire: () => void; error: () => void; closed: boolean }>();
  const opened: string[] = [];
  const throwFor = new Map<string, string>();
  const watch: WatchFn = (path, listener) => {
    const code = throwFor.get(path);
    if (code !== undefined) throw Object.assign(new Error(`watch ${path}`), { code });
    if (!existsSync(path)) throw Object.assign(new Error(`watch ${path}`), { code: "ENOENT" });
    let onError: (e: Error) => void = () => {};
    const entry = { fire: listener, error: () => onError(new Error("boom")), closed: false };
    const handle: WatchHandle = {
      close: () => {
        entry.closed = true;
        if (live.get(path) === entry) live.delete(path);
      },
      on: (_event, fn) => {
        onError = fn;
        return handle;
      },
    };
    opened.push(path);
    live.set(path, entry);
    return handle;
  };
  return { watch, live, opened, throwFor };
}

/** Fake timers: `tick(ms)` runs every due timeout in order. */
function fakeTimers() {
  let now = 0;
  let seq = 0;
  const pending = new Map<number, { at: number; fn: () => void }>();
  const timers: Timers = {
    setTimeout: (fn, ms) => {
      pending.set(++seq, { at: now + ms, fn });
      return seq;
    },
    clearTimeout: (h) => void pending.delete(h as number),
    setInterval: () => 0,
    clearInterval: () => {},
  };
  const tick = (ms: number) => {
    now += ms;
    for (const [id, t] of Array.from(pending).sort((a, b) => a[1].at - b[1].at)) {
      if (t.at <= now) {
        pending.delete(id);
        t.fn();
      }
    }
  };
  return { timers, tick, pending };
}

function start(root: string, w = fakeWatch(), t = fakeTimers()) {
  const events: LiveEvent[] = [];
  const errs: string[] = [];
  const watcher = startTaskWatcher({ root, onEvent: (e) => events.push(e), err: (l) => errs.push(l), watch: w.watch, timers: t.timers });
  return { events, errs, watcher, w, t };
}

test("status change: raw events in a task directory give one task event after the 250 ms window; bursts collapse", () => {
  const b = sandbox("BASE-071-P1", "TK-2");
  try {
    const { events, w, t } = start(b.root);
    assert.deepEqual(w.opened.sort(), [b.tasks, join(b.tasks, "BASE-071-P1"), join(b.tasks, "TK-2")].sort());
    const p1 = w.live.get(join(b.tasks, "BASE-071-P1"));
    for (let i = 0; i < 5; i++) p1?.fire();
    t.tick(249);
    assert.deepEqual(events, [], "nothing before the window closes");
    t.tick(1);
    assert.deepEqual(events, [{ kind: "task", id: "BASE-071-P1" }]);
    // H2: a fixed window opened by the first event: continuous writes still deliver every 250 ms.
    p1?.fire();
    t.tick(100);
    p1?.fire();
    t.tick(150);
    assert.equal(events.length, 2);
    // Two ids have independent windows.
    p1?.fire();
    t.tick(100);
    w.live.get(join(b.tasks, "TK-2"))?.fire();
    t.tick(150);
    assert.deepEqual(events.slice(2), [{ kind: "task", id: "BASE-071-P1" }]);
    t.tick(100);
    assert.deepEqual(events.slice(3), [{ kind: "task", id: "TK-2" }]);
  } finally {
    b.done();
  }
});

test("task added or removed: one list event, and the watcher is opened or closed; a symlink or a bad name is never watched", () => {
  const b = sandbox("TK-1");
  try {
    const { events, w, t } = start(b.root);
    mkdirSync(join(b.tasks, "TK-2"));
    symlinkSync(join(b.tasks, "TK-1"), join(b.tasks, "LINK"));
    mkdirSync(join(b.tasks, "a b"));
    w.live.get(b.tasks)?.fire();
    w.live.get(b.tasks)?.fire();
    t.tick(250);
    assert.deepEqual(events, [{ kind: "list" }]);
    assert.ok(w.live.has(join(b.tasks, "TK-2")));
    assert.ok(!w.opened.some((p) => p.endsWith("LINK") || p.endsWith("a b")));

    rmSync(join(b.tasks, "TK-1"), { recursive: true });
    w.live.get(b.tasks)?.fire();
    t.tick(250);
    assert.deepEqual(events.slice(1), [{ kind: "list" }]);
    assert.ok(!w.live.has(join(b.tasks, "TK-1")), "the vanished task's watcher is closed");

    w.live.get(b.tasks)?.fire(); // nothing changed
    t.tick(250);
    assert.equal(events.length, 2, "a root event with no change in the set sends nothing");
  } finally {
    b.done();
  }
});

test("a task directory deleted and re-created (new inode) is watched again and fires task; a null filename still fires", () => {
  const b = sandbox("TK-1");
  try {
    const { events, w, t } = start(b.root);
    const first = w.live.get(join(b.tasks, "TK-1"));
    renameSync(join(b.tasks, "TK-1"), join(b.root, "moved"));
    mkdirSync(join(b.tasks, "TK-1"));
    w.live.get(b.tasks)?.fire();
    t.tick(250);
    assert.equal(first?.closed, true);
    assert.equal(w.opened.filter((p) => p === join(b.tasks, "TK-1")).length, 2);
    assert.deepEqual(events, [{ kind: "task", id: "TK-1" }], "same set: a task event, not a list event");
  } finally {
    b.done();
  }
});

test("a task watcher error closes it; the next root event re-opens it without a list event", () => {
  const b = sandbox("TK-1");
  try {
    const { events, w, t } = start(b.root);
    w.live.get(join(b.tasks, "TK-1"))?.error();
    assert.ok(!w.live.has(join(b.tasks, "TK-1")));
    w.live.get(b.tasks)?.fire();
    t.tick(250);
    assert.ok(w.live.has(join(b.tasks, "TK-1")));
    assert.deepEqual(events, [{ kind: "task", id: "TK-1" }]);
  } finally {
    b.done();
  }
});

test("EMFILE or ENOSPC from watch: one stderr line per code with no path; the other directories still work", () => {
  const b = sandbox("TK-1", "TK-2", "TK-3");
  try {
    const w = fakeWatch();
    w.throwFor.set(join(b.tasks, "TK-1"), "EMFILE");
    w.throwFor.set(join(b.tasks, "TK-2"), "EMFILE");
    w.throwFor.set(join(b.tasks, "TK-3"), "ENOSPC");
    mkdirSync(join(b.tasks, "TK-4"));
    const { errs, events, t } = start(b.root, w);
    assert.deepEqual(errs, ["base-ai dashboard: live updates limited (EMFILE)", "base-ai dashboard: live updates limited (ENOSPC)"]);
    assert.ok(errs.every((l) => !l.includes(b.root)));
    w.live.get(join(b.tasks, "TK-4"))?.fire();
    t.tick(250);
    assert.deepEqual(events, [{ kind: "task", id: "TK-4" }]);
    w.throwFor.clear();
    w.live.get(b.tasks)?.fire();
    t.tick(250);
    assert.ok(w.live.has(join(b.tasks, "TK-1")), "an unwatched directory is retried on the next root event");
  } finally {
    b.done();
  }
});

test("no .ai/tasks/: .ai is watched until it appears, then the root watcher starts and list fires; a root error falls back again", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "dash-watch-")));
  try {
    mkdirSync(join(root, ".ai"));
    const w = fakeWatch();
    const { events, t } = start(root, w);
    const tasks = join(root, ".ai", "tasks");
    assert.ok(w.live.has(join(root, ".ai")) && !w.live.has(tasks));
    w.live.get(join(root, ".ai"))?.fire();
    t.tick(250);
    assert.deepEqual(events, [], ".ai changed but .ai/tasks is still missing");
    mkdirSync(join(tasks, "TK-1"), { recursive: true });
    w.live.get(join(root, ".ai"))?.fire();
    t.tick(250);
    assert.deepEqual(events, [{ kind: "list" }]);
    assert.ok(w.live.has(tasks) && w.live.has(join(tasks, "TK-1")) && !w.live.has(join(root, ".ai")));

    w.live.get(tasks)?.error();
    t.tick(250);
    assert.deepEqual(events.slice(1), [{ kind: "list" }]);
    assert.ok(w.live.has(join(root, ".ai")), "back to watching .ai");
    w.live.get(join(root, ".ai"))?.error();
    assert.ok(!w.live.has(join(root, ".ai")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("review r1 L1: .ai/tasks/ deleted at runtime re-arms the root watcher via .ai, and re-creating it sends list again", () => {
  const b = sandbox("TK-1");
  try {
    const { events, w, t } = start(b.root);
    const oldRoot = w.live.get(b.tasks);
    rmSync(b.tasks, { recursive: true });
    oldRoot?.fire();
    t.tick(250);
    assert.deepEqual(events, [{ kind: "list" }], "the task vanished");
    assert.ok(!w.live.has(b.tasks) && w.live.has(join(b.root, ".ai")), "the dead root watcher is closed; .ai is watched");
    mkdirSync(join(b.tasks, "TK-2"), { recursive: true });
    w.live.get(join(b.root, ".ai"))?.fire();
    t.tick(250);
    assert.deepEqual(events.slice(1), [{ kind: "list" }]);
    assert.ok(w.live.has(b.tasks) && w.live.has(join(b.tasks, "TK-2")));
    // Replaced in place (new inode): the root watcher is re-opened on the new directory.
    const before = w.opened.filter((x) => x === b.tasks).length;
    renameSync(b.tasks, join(b.root, "old-tasks"));
    mkdirSync(join(b.tasks, "TK-2"), { recursive: true });
    w.live.get(b.tasks)?.fire();
    t.tick(250);
    assert.equal(w.opened.filter((x) => x === b.tasks).length, before + 1);
  } finally {
    b.done();
  }
});

test("close() closes every watcher and clears every pending window; later raw events send nothing", () => {
  const b = sandbox("TK-1");
  try {
    const { events, w, t, watcher } = start(b.root);
    const task = w.live.get(join(b.tasks, "TK-1"));
    task?.fire();
    assert.equal(t.pending.size, 1);
    watcher.close();
    assert.equal(w.live.size, 0);
    assert.equal(t.pending.size, 0);
    task?.fire();
    t.tick(1000);
    assert.deepEqual(events, []);
  } finally {
    b.done();
  }
});

test("status change, real file system: writing .ai/tasks/BASE-071-P1/status.json delivers task BASE-071-P1 within 2 s", { timeout: 5000 }, async () => {
  const b = sandbox("BASE-071-P1");
  const events: LiveEvent[] = [];
  const watcher = startTaskWatcher({ root: b.root, onEvent: (e) => events.push(e), err: () => {} });
  try {
    // macOS FSEvents registers a new watcher asynchronously; a write before that can go unseen. The 2 s budget
    // is measured from the write, as in the story.
    await new Promise((r) => setTimeout(r, 200));
    const started = Date.now();
    writeFileSync(join(b.tasks, "BASE-071-P1", "status.json"), "{}");
    while (!events.some((e) => e.kind === "task" && e.id === "BASE-071-P1") && Date.now() - started < 2000) {
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.ok(events.some((e) => e.kind === "task" && e.id === "BASE-071-P1"), "task event within 2 s");
  } finally {
    watcher.close();
    b.done();
  }
});
