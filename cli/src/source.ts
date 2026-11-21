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

/** A pipeline role definition (`.claude/agents/<id>.md`): the raw frontmatter block and the body. */
export interface RoleDefinition {
  id: string;
  frontmatter: string;
  body: string;
}

export interface AiSource {
  rules: string;
  agents: Agent[];
  lang: string;
  skills: Skill[];
  /** Role definitions exported to services; empty for the root, where `.claude/agents/` is the source. */
  roles: RoleDefinition[];
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

/** Loads the single AI source from <dir>/.ai. */
export function loadSource(dir: string): AiSource {
  const ai = join(dir, ".ai");
  if (!existsSync(ai)) throw new Error(`${ai} not found`);

  const cfgPath = join(ai, "config.yaml");
  const cfg = existsSync(cfgPath) ? ((parse(readFileSync(cfgPath, "utf8")) ?? {}) as Record<string, unknown>) : {};
  const agents = parseTargets(cfg.agents ?? "all", cfgPath);

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
  return { rules, agents, lang: String(cfg.lang ?? "en"), skills, roles: [] };
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
 * directory is missing). Throws, naming the file, on a definition that Claude Code could not load.
 */
export function loadRoleDefinitions(dir: string): RoleDefinition[] {
  const agentsDir = join(dir, ".claude", "agents");
  if (!existsSync(agentsDir)) return [];
  const roles: RoleDefinition[] = [];
  for (const entry of readdirSync(agentsDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
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
    roles.push({ id, frontmatter: m[1], body: m[2] });
  }
  return roles;
}
