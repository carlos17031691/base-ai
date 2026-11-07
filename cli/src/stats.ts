import { loadSource } from "./source.js";

export interface TokenItem {
  name: string;
  chars: number;
  estimatedTokens: number;
}

export interface AiStatsReport {
  alwaysOnTokens: number;
  alwaysOnBudget: number;
  withinBudget: boolean;
  skillsTotalTokens: number;
  skills: TokenItem[];
  violations: TokenItem[];
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
  const alwaysOnText = `${src.rules}\n\n${skillIndexText}`;
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

  return {
    alwaysOnTokens,
    alwaysOnBudget: maxTokens ?? ALWAYS_ON_BUDGET,
    withinBudget: violations.length === 0 && alwaysOnTokens <= (maxTokens ?? ALWAYS_ON_BUDGET),
    skillsTotalTokens,
    skills,
    violations,
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
  lines.push(`**Budget:** ${report.alwaysOnBudget} tokens/component | **Pricing basis:** Claude Sonnet input @ $${USD_PER_INPUT_MTOK}/MTok`);

  if (report.violations.length > 0) {
    lines.push("");
    lines.push("### Violations");
    lines.push("");
    for (const v of report.violations) {
      lines.push(`- **${v.name}**: ${v.estimatedTokens} tokens (exceeds ${report.alwaysOnBudget})`);
    }
  } else {
    lines.push("");
    lines.push("All components within budget.");
  }

  return lines.join("\n");
}
