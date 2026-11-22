import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

export const AGENTS = ["antigravity", "claude", "cursor", "copilot", "codex"] as const;
export type Agent = (typeof AGENTS)[number];

export interface Skill {
  id: string;
  description: string;
  targets: Agent[];
  body: string;
}

/** A reference file of a role (`.claude/agents/<role>/<name>.md`): part of that definition, read when its case occurs. */
export interface RoleReference {
  name: string;
  body: string;
}

/** A pipeline role definition (`.claude/agents/<id>.md`): the raw frontmatter block, the body and its reference files. */
export interface RoleDefinition {
  id: string;
  frontmatter: string;
  body: string;
  references: RoleReference[];
}

export interface AiSource {
  rules: string;
  agents: Agent[];
  lang: string;
  skills: Skill[];
  /** Role definitions exported to services; empty for the root, where `.claude/agents/` is the source. */
  roles: RoleDefinition[];
  /** `budgets.definitions` of config.yaml: estimated-token cap per role definition; absent when not configured. */
  definitionBudgets?: Record<string, number>;
  /** `budgets.definition_totals`: cap per role on the definition plus its reference files; absent when not configured. */
  definitionTotals?: Record<string, number>;
}

/** Splits YAML frontmatter from the Markdown body. */
export function splitFrontmatter(text: string): { data: Record<string, unknown>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) return { data: {}, body: text };
  return { data: (parse(m[1]) ?? {}) as Record<string, unknown>, body: m[2] };
}

function parseTargets(raw: unknown, file: string): Agent[] {
  if (raw === undefined || raw === "all") return [...AGENTS];
  const list = Array.isArray(raw) ? raw : [raw];
  for (const t of list) {
    if (!AGENTS.includes(t as Agent)) throw new Error(`${file}: unknown target "${t}"`);
  }
  return list as Agent[];
}

/** Reads `budgets.<key>` (role -> positive integer); throws naming the key on any other value. */
function parseRoleBudgets(cfg: Record<string, unknown>, key: string, file: string): Record<string, number> | undefined {
  if (cfg.budgets === undefined) return undefined;
  const isMap = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
  if (!isMap(cfg.budgets)) throw new Error(`${file}: "budgets" must be a map`);
  const defs = cfg.budgets[key];
  if (defs === undefined) return undefined;
  if (!isMap(defs)) throw new Error(`${file}: "budgets.${key}" must be a map of role to tokens`);
  for (const [role, value] of Object.entries(defs)) {
    if (!Number.isInteger(value) || (value as number) <= 0) {
      throw new Error(`${file}: "budgets.${key}.${role}" must be a positive integer`);
    }
  }
  return defs as Record<string, number>;
}

/** Loads the single AI source from <dir>/.ai. */
export function loadSource(dir: string): AiSource {
  const ai = join(dir, ".ai");
  if (!existsSync(ai)) throw new Error(`${ai} not found`);

  const cfgPath = join(ai, "config.yaml");
  const cfg = existsSync(cfgPath) ? ((parse(readFileSync(cfgPath, "utf8")) ?? {}) as Record<string, unknown>) : {};
  const agents = parseTargets(cfg.agents ?? "all", cfgPath);
  const definitionBudgets = parseRoleBudgets(cfg, "definitions", cfgPath);
  const definitionTotals = parseRoleBudgets(cfg, "definition_totals", cfgPath);

  const rulesPath = join(ai, "rules.md");
  const baseRules = existsSync(rulesPath) ? readFileSync(rulesPath, "utf8").trim() : "";
  const memoryPath = join(ai, "memory.md");
  const memEntries = existsSync(memoryPath)
    ? readFileSync(memoryPath, "utf8")
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l.startsWith("- "))
    : [];
  const rules = [baseRules, memEntries.length ? `## Project memory\n\n${memEntries.join("\n")}` : ""].filter(Boolean).join("\n\n");

  const skills: Skill[] = [];
  const skillsDir = join(ai, "skills");
  if (existsSync(skillsDir)) {
    for (const entry of readdirSync(skillsDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory()) continue;
      const file = join(skillsDir, entry.name, "skill.md");
      if (!existsSync(file)) continue;
      const { data, body } = splitFrontmatter(readFileSync(file, "utf8"));
      const id = String(data.id ?? entry.name);
      if (!/^[a-z0-9-]+$/.test(id)) throw new Error(`${file}: invalid id "${id}"`);
      if (!data.description) throw new Error(`${file}: missing "description"`);
      skills.push({
        id,
        description: String(data.description).trim(),
        targets: parseTargets(data.targets, file),
        body: body.trim(),
      });
    }
  }
  return {
    rules,
    agents,
    lang: String(cfg.lang ?? "en"),
    skills,
    roles: [],
    ...(definitionBudgets ? { definitionBudgets } : {}),
    ...(definitionTotals ? { definitionTotals } : {}),
  };
}

/** Extends the root source with a service-local one: rules are concatenated and local skills take precedence. */
export function mergeSource(base: AiSource, local: AiSource | null): AiSource {
  if (!local) return base;
  const skills = new Map(base.skills.map((s) => [s.id, s]));
  for (const s of local.skills) skills.set(s.id, s);
  return {
    rules: [base.rules, local.rules && `## Service rules (take precedence)\n\n${local.rules}`].filter(Boolean).join("\n\n"),
    agents: local.agents,
    lang: local.lang,
    skills: [...skills.values()].sort((a, b) => a.id.localeCompare(b.id)),
    roles: base.roles,
  };
}

/**
 * Loads the hand-written role definitions from <dir>/.claude/agents/*.md, sorted by name (none when the
 * directory is missing), with the reference files of `.claude/agents/<role>/*.md`. Throws, naming the path, on
 * a definition that Claude Code could not load, a reference directory with no definition, or a reference file
 * that its definition does not name.
 */
export function loadRoleDefinitions(dir: string): RoleDefinition[] {
  const agentsDir = join(dir, ".claude", "agents");
  if (!existsSync(agentsDir)) return [];
  const entries = readdirSync(agentsDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  const roles: RoleDefinition[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const file = join(agentsDir, entry.name);
    const text = readFileSync(file, "utf8");
    const m = /^(---\r?\n[\s\S]*?\r?\n---\r?\n)([\s\S]*)$/.exec(text);
    if (!m) throw new Error(`${file}: missing frontmatter`);
    let data: Record<string, unknown>;
    try {
      data = splitFrontmatter(text).data;
    } catch (e) {
      throw new Error(`${file}: invalid frontmatter: ${(e as Error).message}`);
    }
    const name = data.name === undefined ? "" : String(data.name);
    if (!name) throw new Error(`${file}: missing "name"`);
    if (!data.description) throw new Error(`${file}: missing "description"`);
    if (!/^[a-z0-9-]+$/.test(name)) throw new Error(`${file}: invalid name "${name}"`);
    const id = entry.name.slice(0, -".md".length);
    if (name !== id) throw new Error(`${file}: name "${name}" does not match the file name "${id}"`);
    roles.push({ id, frontmatter: m[1], body: m[2], references: [] });
  }
  // Reference files: `.claude/agents/<role>/<name>.md`, each named by its definition so the agent is sent to it.
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const refDir = join(agentsDir, entry.name);
    const role = roles.find((r) => r.id === entry.name);
    if (!role) throw new Error(`${refDir}: reference directory with no definition .claude/agents/${entry.name}.md`);
    const files = readdirSync(refDir, { withFileTypes: true })
      .filter((f) => f.isFile() && f.name.endsWith(".md"))
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const f of files) {
      const rel = `.claude/agents/${role.id}/${f.name}`;
      if (!role.body.includes(rel)) throw new Error(`${join(refDir, f.name)}: reference file not named in .claude/agents/${role.id}.md as ${rel}`);
      role.references.push({ name: f.name, body: readFileSync(join(refDir, f.name), "utf8") });
    }
  }
  return roles;
}
