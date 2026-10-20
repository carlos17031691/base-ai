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
}

const ALWAYS_ON_BUDGET = 2500;

/** Standard heuristic (~4 chars per token for English/code Markdown). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Measures the token footprint of always-on rules/memory vs on-demand skills. */
export function computeAiStats(root: string): AiStatsReport {
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

  return {
    alwaysOnTokens,
    alwaysOnBudget: ALWAYS_ON_BUDGET,
    withinBudget: alwaysOnTokens <= ALWAYS_ON_BUDGET,
    skillsTotalTokens,
    skills,
  };
}
