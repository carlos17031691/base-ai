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

export interface AiSource {
  rules: string;
  agents: Agent[];
  lang: string;
  skills: Skill[];
}

/** Separa el frontmatter YAML del cuerpo Markdown. */
export function splitFrontmatter(text: string): { data: Record<string, unknown>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) return { data: {}, body: text };
  return { data: (parse(m[1]) ?? {}) as Record<string, unknown>, body: m[2] };
}

function parseTargets(raw: unknown, file: string): Agent[] {
  if (raw === undefined || raw === "all") return [...AGENTS];
  const list = Array.isArray(raw) ? raw : [raw];
  for (const t of list) {
    if (!AGENTS.includes(t as Agent)) throw new Error(`${file}: target desconocido "${t}"`);
  }
  return list as Agent[];
}

/** Carga la fuente única de IA desde <dir>/.ai. */
export function loadSource(dir: string): AiSource {
  const ai = join(dir, ".ai");
  if (!existsSync(ai)) throw new Error(`No existe ${ai}`);

  const cfgPath = join(ai, "config.yaml");
  const cfg = existsSync(cfgPath) ? ((parse(readFileSync(cfgPath, "utf8")) ?? {}) as Record<string, unknown>) : {};
  const agents = parseTargets(cfg.agents ?? "all", cfgPath);

  const rulesPath = join(ai, "rules.md");
  const rules = existsSync(rulesPath) ? readFileSync(rulesPath, "utf8").trim() : "";

  const skills: Skill[] = [];
  const skillsDir = join(ai, "skills");
  if (existsSync(skillsDir)) {
    for (const entry of readdirSync(skillsDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory()) continue;
      const file = join(skillsDir, entry.name, "skill.md");
      if (!existsSync(file)) continue;
      const { data, body } = splitFrontmatter(readFileSync(file, "utf8"));
      const id = String(data.id ?? entry.name);
      if (!/^[a-z0-9-]+$/.test(id)) throw new Error(`${file}: id inválido "${id}"`);
      if (!data.description) throw new Error(`${file}: falta "description"`);
      skills.push({
        id,
        description: String(data.description).trim(),
        targets: parseTargets(data.targets, file),
        body: body.trim(),
      });
    }
  }
  return { rules, agents, lang: String(cfg.lang ?? "es"), skills };
}

/** Extiende la fuente de la raíz con la local de un servicio: las reglas se concatenan y los skills locales tienen prioridad. */
export function mergeSource(base: AiSource, local: AiSource | null): AiSource {
  if (!local) return base;
  const skills = new Map(base.skills.map((s) => [s.id, s]));
  for (const s of local.skills) skills.set(s.id, s);
  return {
    rules: [base.rules, local.rules && `## Reglas del servicio (prioritarias)\n\n${local.rules}`].filter(Boolean).join("\n\n"),
    agents: local.agents,
    lang: local.lang,
    skills: [...skills.values()].sort((a, b) => a.id.localeCompare(b.id)),
  };
}
