import type { Agent, AiSource, Skill } from "./source.js";

export interface OutFile {
  path: string;
  content: string;
}
export type Exporter = (src: AiSource) => OutFile[];

export const MARKER = "generado por base-ai";
const HEADER = `<!-- ${MARKER}: no editar. Fuente: .ai/ -->`;

/** Crea un archivo Markdown con cabecera de "generado"; si hay frontmatter, la cabecera va justo después. */
function md(path: string, body: string, frontmatter?: Record<string, string | boolean>): OutFile {
  const fm = frontmatter
    ? `---\n${Object.entries(frontmatter)
        .map(([k, v]) => `${k}: ${typeof v === "string" ? JSON.stringify(v) : v}`)
        .join("\n")}\n---\n`
    : "";
  return { path, content: `${fm}${HEADER}\n\n${body.trim()}\n` };
}

const forAgent = (src: AiSource, a: Agent): Skill[] => src.skills.filter((s) => s.targets.includes(a));

function skillIndex(skills: Skill[]): string {
  if (!skills.length) return "";
  return `\n\n## Skills disponibles\n\n${skills.map((s) => `- **${s.id}**: ${s.description}`).join("\n")}`;
}

/** AGENTS.md lo comparten Antigravity y Codex. */
const agentsMd = (src: AiSource, a: Agent) => md("AGENTS.md", src.rules + skillIndex(forAgent(src, a)));

export const exporters: Record<Agent, Exporter> = {
  antigravity: (src) => [
    agentsMd(src, "antigravity"),
    ...forAgent(src, "antigravity").map((s) =>
      md(`.agents/skills/${s.id}/SKILL.md`, s.body, { name: s.id, description: s.description }),
    ),
  ],
  codex: (src) => [agentsMd(src, "codex")],
  claude: (src) => [
    md("CLAUDE.md", src.rules + skillIndex(forAgent(src, "claude"))),
    ...forAgent(src, "claude").map((s) => md(`.claude/commands/${s.id}.md`, s.body, { description: s.description })),
  ],
  cursor: (src) => [
    md(".cursor/rules/base-ai.mdc", src.rules, { description: "Reglas globales del proyecto", alwaysApply: true }),
    ...forAgent(src, "cursor").map((s) =>
      md(`.cursor/rules/${s.id}.mdc`, s.body, { description: s.description, alwaysApply: false }),
    ),
  ],
  copilot: (src) => [
    md(".github/copilot-instructions.md", src.rules + skillIndex(forAgent(src, "copilot"))),
    ...forAgent(src, "copilot").map((s) =>
      md(`.github/prompts/${s.id}.prompt.md`, s.body, { description: s.description }),
    ),
  ],
  windsurf: (src) => [
    md(
      ".windsurfrules",
      src.rules +
        forAgent(src, "windsurf")
          .map((s) => `\n\n## Skill: ${s.id}\n\n${s.description}\n\n${s.body}`)
          .join(""),
    ),
  ],
};

/** Ejecuta los exportadores habilitados; si dos producen la misma ruta, el contenido debe coincidir. */
export function render(src: AiSource): OutFile[] {
  const out = new Map<string, string>();
  for (const a of src.agents) {
    for (const f of exporters[a](src)) {
      const prev = out.get(f.path);
      if (prev !== undefined && prev !== f.content) {
        // AGENTS.md compartido: se usa la unión del índice de skills (el de antigravity/codex suelen coincidir).
        if (f.content.length > prev.length) out.set(f.path, f.content);
        continue;
      }
      out.set(f.path, f.content);
    }
  }
  return [...out.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([path, content]) => ({ path, content }));
}
