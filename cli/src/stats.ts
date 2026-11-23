import { claudeRules } from "./exporters.js";
import { loadRoleDefinitions, loadSource } from "./source.js";

export interface TokenItem {
  name: string;
  chars: number;
  estimatedTokens: number;
}

export interface AiStatsReport {
  alwaysOnTokens: number;
  alwaysOnBudget: number;
  /** True when `budgets.always_on` is set: the budget then sets the exit code and `--max-tokens` does not replace it. */
  alwaysOnEnforced: boolean;
  /** Set when an enforced always-on budget is exceeded. */
  alwaysOnViolation: { estimatedTokens: number; budget: number } | null;
  withinBudget: boolean;
  skillsTotalTokens: number;
  skills: TokenItem[];
  violations: TokenItem[];
  /** Role definitions (`.claude/agents/<name>.md`, whole file) with their reference files, largest first. */
  definitions: DefinitionItem[];
  /** Sum of the definition files alone. */
  definitionsTotalTokens: number;
  /** Sum of the definitions plus all their reference files. */
  definitionsWithReferencesTokens: number;
  /** `budgets.definitions` of `.ai/config.yaml`; null when the project sets none. */
  definitionBudgets: Record<string, number> | null;
  /** `budgets.definition_totals`; null when the project sets none. */
  definitionTotals: Record<string, number> | null;
  definitionViolations: DefinitionViolation[];
}

/** A role definition: the file itself, its reference files (`.claude/agents/<role>/<name>.md`) and both together. */
export interface DefinitionItem extends TokenItem {
  references: TokenItem[];
  totalTokens: number;
}

/**
 * kind "definition": the file above `budgets.definitions`, or (budget null) no entry while that map exists.
 * kind "total": the file plus its reference files above `budgets.definition_totals` (or above the definition budget
 * when the role has reference files and no total).
 */
export interface DefinitionViolation {
  name: string;
  kind: "definition" | "total";
  estimatedTokens: number;
  budget: number | null;
}

export function describeDefinitionViolation(v: DefinitionViolation): string {
  if (v.kind === "total") return `definition ${v.name} with reference files: ${v.estimatedTokens} tokens (budget: ${v.budget})`;
  return v.budget === null
    ? `definition ${v.name}: ${v.estimatedTokens} tokens (no entry in budgets.definitions)`
    : `definition ${v.name}: ${v.estimatedTokens} tokens (budget: ${v.budget})`;
}

export interface GuardrailOptions {
  maxTokens?: number;
  ci?: boolean;
}

const ALWAYS_ON_BUDGET = 2500;
const USD_PER_INPUT_MTOK = 3.0;
const MS_PER_INPUT_TOKEN = 0.5;

/** Standard heuristic (~4 chars per token for English/code Markdown). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function estimateUsd(tokens: number): string {
  return ((tokens / 1_000_000) * USD_PER_INPUT_MTOK).toFixed(6);
}

function estimateLatencyMs(tokens: number): string {
  return (tokens * MS_PER_INPUT_TOKEN).toFixed(0);
}

/** Measures the token footprint of always-on rules/memory vs on-demand skills. */
export function computeAiStats(root: string, opts?: GuardrailOptions): AiStatsReport {
  const src = loadSource(root);
  const skillIndexText = src.skills.map((s) => `- **${s.id}**: ${s.description}`).join("\n");
  // With Claude configured, measure what Claude Code loads: CLAUDE.md has no skill or agent index (BASE-079-T5).
  const alwaysOnText = src.agents.includes("claude") ? claudeRules(src.rules) : `${src.rules}\n\n${skillIndexText}`;
  const alwaysOnTokens = estimateTokens(alwaysOnText);

  const skills: TokenItem[] = src.skills
    .map((s) => {
      const full = `${s.description}\n\n${s.body}`;
      return {
        name: s.id,
        chars: full.length,
        estimatedTokens: estimateTokens(full),
      };
    })
    .sort((a, b) => b.estimatedTokens - a.estimatedTokens);

  const skillsTotalTokens = skills.reduce((sum, s) => sum + s.estimatedTokens, 0);

  const maxTokens = opts?.maxTokens;
  const violations: TokenItem[] = [];
  if (maxTokens !== undefined) {
    if (alwaysOnTokens > maxTokens) {
      violations.push({ name: "always-on", chars: alwaysOnText.length, estimatedTokens: alwaysOnTokens });
    }
    for (const s of skills) {
      if (s.estimatedTokens > maxTokens) violations.push(s);
    }
  }

  // Each agent run loads its whole definition, so the whole file is measured, frontmatter included.
  const definitions: DefinitionItem[] = loadRoleDefinitions(root)
    .map((r) => {
      const chars = r.frontmatter.length + r.body.length;
      const estimatedTokens = estimateTokens(r.frontmatter + r.body);
      const references = r.references.map((ref) => ({
        name: `${r.id}/${ref.name}`,
        chars: ref.body.length,
        estimatedTokens: estimateTokens(ref.body),
      }));
      const totalTokens = references.reduce((sum, ref) => sum + ref.estimatedTokens, estimatedTokens);
      return { name: r.id, chars, estimatedTokens, references, totalTokens };
    })
    .sort((a, b) => b.estimatedTokens - a.estimatedTokens);
  const definitionBudgets = src.definitionBudgets ?? null;
  const definitionTotals = src.definitionTotals ?? null;
  const own = (map: Record<string, number> | null, key: string): number | null =>
    map && Object.hasOwn(map, key) ? map[key] : null;
  // Budgets come from the project's config, so they apply with or without --max-tokens.
  const definitionViolations: DefinitionViolation[] = [];
  for (const d of definitions) {
    const budget = own(definitionBudgets, d.name);
    if (definitionBudgets && (budget === null || d.estimatedTokens > budget)) {
      definitionViolations.push({ name: d.name, kind: "definition", estimatedTokens: d.estimatedTokens, budget });
    }
    // Text moved into reference files still counts, so a reduction cannot be had by moving text alone.
    const totalBudget = own(definitionTotals, d.name) ?? (d.references.length > 0 ? budget : null);
    if (totalBudget !== null && d.totalTokens > totalBudget) {
      definitionViolations.push({ name: d.name, kind: "total", estimatedTokens: d.totalTokens, budget: totalBudget });
    }
  }

  // A configured always-on budget is a project decision, so a CLI flag cannot loosen it (BASE-079-T6).
  const alwaysOnEnforced = src.alwaysOnBudget !== undefined;
  const alwaysOnBudget = src.alwaysOnBudget ?? maxTokens ?? ALWAYS_ON_BUDGET;
  const alwaysOnViolation =
    alwaysOnEnforced && alwaysOnTokens > alwaysOnBudget ? { estimatedTokens: alwaysOnTokens, budget: alwaysOnBudget } : null;

  return {
    alwaysOnTokens,
    alwaysOnBudget,
    alwaysOnEnforced,
    alwaysOnViolation,
    withinBudget:
      violations.length === 0 &&
      definitionViolations.length === 0 &&
      alwaysOnViolation === null &&
      alwaysOnTokens <= alwaysOnBudget,
    skillsTotalTokens,
    skills,
    violations,
    definitions,
    definitionsTotalTokens: definitions.reduce((sum, d) => sum + d.estimatedTokens, 0),
    definitionsWithReferencesTokens: definitions.reduce((sum, d) => sum + d.totalTokens, 0),
    definitionBudgets,
    definitionTotals,
    definitionViolations,
  };
}

/** Renders a Markdown cost/latency report suitable for $GITHUB_STEP_SUMMARY. */
export function renderCiReport(report: AiStatsReport): string {
  const lines: string[] = [];
  lines.push("## Token Budget Report (BASE-024)");
  lines.push("");
  lines.push(`| Component | Tokens | Est. USD/call | Est. Latency |`);
  lines.push(`|-----------|-------:|--------------:|-------------:|`);
  lines.push(
    `| **Always-on context** | ${report.alwaysOnTokens} | $${estimateUsd(report.alwaysOnTokens)} | ${estimateLatencyMs(report.alwaysOnTokens)}ms |`,
  );
  for (const s of report.skills) {
    lines.push(`| skill: ${s.name} | ${s.estimatedTokens} | $${estimateUsd(s.estimatedTokens)} | ${estimateLatencyMs(s.estimatedTokens)}ms |`);
  }
  lines.push("");
  const budgetLabel = report.alwaysOnEnforced
    ? `always-on ${report.alwaysOnBudget} tokens (budgets.always_on)`
    : `${report.alwaysOnBudget} tokens/component`;
  lines.push(`**Budget:** ${budgetLabel} | **Pricing basis:** Claude Sonnet input @ $${USD_PER_INPUT_MTOK}/MTok`);

  if (report.definitions.length > 0) {
    lines.push("");
    lines.push("### Role definitions (loaded whole by each agent run)");
    lines.push("");
    lines.push(`| Definition | Chars | Tokens | Budget |`);
    lines.push(`|------------|------:|-------:|-------:|`);
    for (const d of report.definitions) {
      lines.push(`| ${d.name} | ${d.chars} | ${d.estimatedTokens} | ${report.definitionBudgets?.[d.name] ?? "-"} |`);
      for (const ref of d.references) lines.push(`| ↳ ${ref.name} | ${ref.chars} | ${ref.estimatedTokens} | |`);
      if (d.references.length > 0) {
        lines.push(`| ${d.name} with reference files | | ${d.totalTokens} | ${report.definitionTotals?.[d.name] ?? "-"} |`);
      }
    }
    lines.push(`| **Total** (definitions / with reference files) | | ${report.definitionsTotalTokens} / ${report.definitionsWithReferencesTokens} | |`);
  }

  if (report.violations.length > 0 || report.definitionViolations.length > 0 || report.alwaysOnViolation) {
    lines.push("");
    lines.push("### Violations");
    lines.push("");
    if (report.alwaysOnViolation) {
      const v = report.alwaysOnViolation;
      lines.push(`- **always-on context**: ${v.estimatedTokens} tokens (budget: ${v.budget}, budgets.always_on)`);
    }
    for (const v of report.violations) {
      lines.push(`- **${v.name}**: ${v.estimatedTokens} tokens (exceeds ${report.alwaysOnBudget})`);
    }
    for (const v of report.definitionViolations) {
      lines.push(`- ${describeDefinitionViolation(v)}`);
    }
  } else {
    lines.push("");
    lines.push("All components within budget.");
  }

  return lines.join("\n");
}
