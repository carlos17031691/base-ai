/**
 * The Claude Code usage hook that `ai sync` writes into `.claude/settings.json` (BASE-101-U2, epic #101).
 * Pure: text in, text out. sync.ts does the reading and writing.
 *
 * The file belongs to the user, so only hook objects whose command carries the marker are ever touched,
 * and the file is never listed in `.ai/generated.json` (stale-artefact deletion would remove it whole).
 */
import { MARKER } from "./exporters.js";

export const SETTINGS_PATH = ".claude/settings.json";
export const HOOK_EVENTS = ["SubagentStop", "Stop"] as const;
export const CLI_PACKAGE = "@carlos17031691/base-ai";
export type UsageHook = "claude-code" | "none";
export type HookState = "ok" | "missing" | "stale" | "invalid";

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

/** True when `<root>/cli/package.json` is base-ai's own: the CLI is then built in-tree. */
export function isBaseAiRepo(cliPackageJson: string | null): boolean {
  if (cliPackageJson === null) return false;
  try {
    const pkg: unknown = JSON.parse(cliPackageJson);
    return isObj(pkg) && pkg.name === CLI_PACKAGE;
  } catch {
    return false;
  }
}

/**
 * The hook command, derived only from committed files so every clone and CI compute the same string (H1).
 * It runs `node` on a path under the project, so `base-ai` need not be on PATH.
 */
export function hookCommand(baseAiRepo: boolean): string {
  const cli = baseAiRepo ? "cli/dist/index.js" : `node_modules/${CLI_PACKAGE}/dist/index.js`;
  return `node "$CLAUDE_PROJECT_DIR/${cli}" usage record --root "$CLAUDE_PROJECT_DIR" # ${MARKER}`;
}

export class SettingsError extends Error {}

const isGeneratedHook = (h: unknown) => isObj(h) && typeof h.command === "string" && h.command.includes(MARKER);

/** Parses the settings text; throws SettingsError unless it is an object whose `hooks` and event values have the expected shape. */
export function parseSettings(text: string): Json {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    throw new SettingsError("is not valid JSON");
  }
  if (!isObj(v)) throw new SettingsError("is not a JSON object");
  if (v.hooks !== undefined) {
    if (!isObj(v.hooks)) throw new SettingsError('"hooks" is not an object');
    for (const [event, groups] of Object.entries(v.hooks)) {
      if (!Array.isArray(groups)) throw new SettingsError(`"hooks.${event}" is not an array`);
    }
  }
  return v;
}

/** Removes every generated hook object from one event's groups, dropping groups it emptied. */
function withoutGenerated(groups: unknown[]): { groups: unknown[]; removed: number } {
  let removed = 0;
  const out: unknown[] = [];
  for (const g of groups) {
    if (!isObj(g) || !Array.isArray(g.hooks)) {
      out.push(g);
      continue;
    }
    const kept = g.hooks.filter((h) => !isGeneratedHook(h));
    if (kept.length === g.hooks.length) {
      out.push(g);
      continue;
    }
    removed += g.hooks.length - kept.length;
    if (kept.length > 0) out.push({ ...g, hooks: kept });
  }
  return { groups: out, removed };
}

const serialize = (obj: Json) => JSON.stringify(obj, null, 2) + "\n";

/**
 * Drops generated hook objects from every event, and the event arrays that removal emptied, so a generated hook
 * left under another event is cleaned too (the doctor reports it as stale).
 */
function stripGenerated(hooks: Json): number {
  let removed = 0;
  for (const [event, value] of Object.entries(hooks)) {
    const r = withoutGenerated(value as unknown[]);
    if (r.removed === 0) continue;
    removed += r.removed;
    if (r.groups.length > 0) hooks[event] = r.groups;
    else delete hooks[event];
  }
  return removed;
}

/** `claude-code`: the settings with exactly one fresh generated group appended to each hook event, all else kept in order. */
export function mergeHook(text: string | null, command: string): string {
  const settings = text === null ? {} : parseSettings(text);
  const hooks: Json = isObj(settings.hooks) ? { ...settings.hooks } : {};
  stripGenerated(hooks);
  for (const event of HOOK_EVENTS) {
    hooks[event] = [...((hooks[event] as unknown[] | undefined) ?? []), { hooks: [{ type: "command", command }] }];
  }
  return serialize({ ...settings, hooks });
}

/**
 * `none`: the settings without generated hook objects, dropping the groups, event arrays and `hooks` object
 * that removal emptied. Returns the same text when nothing was generated, and null (delete the file) when
 * removal leaves `{}`.
 */
export function removeHook(text: string | null): string | null {
  if (text === null) return null;
  // Opted out and nothing of ours in the file: it is the user's alone, so it is not even parsed.
  if (!text.includes(MARKER)) return text;
  const settings = parseSettings(text);
  if (!isObj(settings.hooks)) return text;
  const hooks: Json = { ...settings.hooks };
  if (stripGenerated(hooks) === 0) return text;
  const next: Json = { ...settings, hooks };
  if (Object.keys(hooks).length === 0) delete next.hooks;
  return Object.keys(next).length === 0 ? null : serialize(next);
}

/** The commands of the generated hook objects of each event. */
function generatedCommands(settings: Json): Map<string, string[]> {
  const out = new Map<string, string[]>();
  if (!isObj(settings.hooks)) return out;
  for (const [event, groups] of Object.entries(settings.hooks)) {
    for (const g of groups as unknown[]) {
      if (!isObj(g) || !Array.isArray(g.hooks)) continue;
      for (const h of g.hooks) {
        if (!isGeneratedHook(h)) continue;
        const cmd = isObj(h) && h.type === "command" ? (h.command as string) : "";
        out.set(event, [...(out.get(event) ?? []), cmd]);
      }
    }
  }
  return out;
}

/**
 * The doctor's view of the file. `stale` wins over `missing`: a generated hook that differs from the expected
 * one, appears twice, sits under another event, or exists while the hook is `none`.
 */
export function hookState(text: string | null, hook: UsageHook, command: string): HookState {
  if (text === null) return hook === "none" ? "ok" : "missing";
  if (hook === "none" && !text.includes(MARKER)) return "ok";
  let settings: Json;
  try {
    settings = parseSettings(text);
  } catch {
    return "invalid";
  }
  const found = generatedCommands(settings);
  if (hook === "none") return found.size === 0 ? "ok" : "stale";
  const expected = new Set<string>(HOOK_EVENTS);
  for (const [event, cmds] of found) {
    if (!expected.has(event) || cmds.length > 1 || cmds[0] !== command) return "stale";
  }
  return HOOK_EVENTS.every((e) => found.has(e)) ? "ok" : "missing";
}
