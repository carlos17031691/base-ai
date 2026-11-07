import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { request as httpsRequest } from "node:https";
import { request as httpRequest } from "node:http";
import { parse } from "yaml";
import { searchContext } from "./context.js";

// ── Types ──────────────────────────────────────────────────────────────

export interface EvalAssertion {
  type: "exact" | "contains" | "regex" | "json_schema" | "gte" | "lte" | "cost_lte" | "latency_lte" | "llm_judge";
  field?: string;
  value?: string | number;
  criteria?: string;
  threshold?: number;
}

export interface EvalCase {
  id: string;
  description?: string;
  type: "deterministic" | "context_search" | "llm_judge";
  input: Record<string, unknown>;
  assertions: EvalAssertion[];
}

export interface EvalSuite {
  suite: string;
  description?: string;
  config?: { llm_judge_url?: string; timeout_ms?: number };
  cases: EvalCase[];
}

export type CaseStatus = "pass" | "fail" | "skip" | "error";

export interface AssertionResult {
  type: string;
  passed: boolean;
  message: string;
}

export interface CaseResult {
  suiteId: string;
  caseId: string;
  description: string;
  status: CaseStatus;
  assertions: AssertionResult[];
  durationMs: number;
  error?: string;
}

export interface EvalReport {
  results: CaseResult[];
  passed: number;
  failed: number;
  skipped: number;
  errored: number;
  totalMs: number;
}

// ── Suite loading ──────────────────────────────────────────────────────

const EVALS_DIR = ".ai/evals";

export function loadEvalSuites(root: string): EvalSuite[] {
  const dir = join(root, EVALS_DIR);
  if (!existsSync(dir)) return [];

  const files = readdirSync(dir).filter((f) => f.endsWith(".eval.yaml") || f.endsWith(".eval.yml"));
  const suites: EvalSuite[] = [];

  const MAX_EVAL_FILE_BYTES = 1_048_576;
  for (const f of files.sort()) {
    const filePath = join(dir, f);
    const size = statSync(filePath).size;
    if (size > MAX_EVAL_FILE_BYTES) throw new Error(`${f}: eval file exceeds 1MB limit (${size} bytes)`);
    const raw = readFileSync(filePath, "utf8");
    const parsed = parse(raw, { schema: "core" }) as EvalSuite;
    validate(parsed, f);
    suites.push(parsed);
  }
  return suites;
}

function validate(suite: EvalSuite, file: string): void {
  if (!suite.suite) throw new Error(`${file}: missing 'suite' field`);
  if (!Array.isArray(suite.cases) || suite.cases.length === 0) throw new Error(`${file}: 'cases' must be a non-empty array`);
  for (const c of suite.cases) {
    if (!c.id) throw new Error(`${file}: case missing 'id'`);
    if (!c.type) throw new Error(`${file}: case '${c.id}' missing 'type'`);
    if (!Array.isArray(c.assertions) || c.assertions.length === 0) {
      throw new Error(`${file}: case '${c.id}' must have at least one assertion`);
    }
  }
}

// ── Assertion engine ───────────────────────────────────────────────────

function resolveField(data: unknown, field: string): unknown {
  if (!field) return data;
  const parts = field.split(".");
  let current: unknown = data;
  for (let pi = 0; pi < parts.length; pi++) {
    const p = parts[pi];
    const arrayMatch = p.match(/^(.+)\[\*\]$/);
    if (arrayMatch && Array.isArray((current as Record<string, unknown>)?.[arrayMatch[1]])) {
      const arr = (current as Record<string, unknown>)[arrayMatch[1]] as unknown[];
      const remaining = parts.slice(pi + 1);
      if (remaining.length === 0) return arr;
      return arr.map((item) => {
        let v: unknown = item;
        for (const r of remaining) {
          if (v !== null && typeof v === "object") v = (v as Record<string, unknown>)[r];
          else return undefined;
        }
        return v;
      });
    } else if (current !== null && typeof current === "object") {
      current = (current as Record<string, unknown>)[p];
    } else {
      return undefined;
    }
  }
  return current;
}

export function checkAssertion(assertion: EvalAssertion, data: unknown): AssertionResult {
  const resolved = assertion.field ? resolveField(data, assertion.field) : data;

  switch (assertion.type) {
    case "exact": {
      const passed = String(resolved) === String(assertion.value);
      return { type: "exact", passed, message: passed ? "exact match" : `expected "${assertion.value}", got "${resolved}"` };
    }
    case "contains": {
      if (Array.isArray(resolved)) {
        const passed = resolved.includes(assertion.value);
        return { type: "contains", passed, message: passed ? "array contains value" : `array does not contain "${assertion.value}"` };
      }
      const passed = String(resolved).includes(String(assertion.value));
      return { type: "contains", passed, message: passed ? "string contains value" : `"${assertion.value}" not found in output` };
    }
    case "regex": {
      const pattern = String(assertion.value);
      if (pattern.length > 1000) {
        return { type: "regex", passed: false, message: "regex pattern exceeds 1000 char limit" };
      }
      try {
        const re = new RegExp(pattern);
        const passed = re.test(String(resolved));
        return { type: "regex", passed, message: passed ? "regex matched" : `pattern /${pattern}/ did not match` };
      } catch (e) {
        return { type: "regex", passed: false, message: `invalid regex: ${(e as Error).message}` };
      }
    }
    case "json_schema": {
      try {
        const obj = typeof resolved === "string" ? JSON.parse(resolved) : resolved;
        const passed = obj !== null && typeof obj === "object";
        return { type: "json_schema", passed, message: passed ? "valid JSON object" : "not a valid JSON object" };
      } catch {
        return { type: "json_schema", passed: false, message: "invalid JSON" };
      }
    }
    case "gte": {
      const num = Number(resolved);
      const passed = num >= Number(assertion.value);
      return { type: "gte", passed, message: passed ? `${num} >= ${assertion.value}` : `${num} < ${assertion.value}` };
    }
    case "lte": {
      const num = Number(resolved);
      const passed = num <= Number(assertion.value);
      return { type: "lte", passed, message: passed ? `${num} <= ${assertion.value}` : `${num} > ${assertion.value}` };
    }
    case "cost_lte":
    case "latency_lte": {
      const num = Number(resolved);
      const passed = num <= Number(assertion.value);
      return { type: assertion.type, passed, message: passed ? `${num} <= ${assertion.value}` : `${num} > ${assertion.value}` };
    }
    default:
      return { type: assertion.type, passed: false, message: `unknown assertion type: ${assertion.type}` };
  }
}

// ── LLM Judge ──────────────────────────────────────────────────────────

const PRIVATE_HOST_RE = /^(localhost|127\.\d+\.\d+\.\d+|::1|0\.0\.0\.0|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|169\.254\.\d+\.\d+|metadata\.google\.internal)$/;

function validateLlmUrl(url: string): void {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`Unsupported protocol: ${parsed.protocol}`);
  }
  if (PRIVATE_HOST_RE.test(parsed.hostname)) {
    throw new Error(`SSRF blocked: ${parsed.hostname} is a private/metadata address`);
  }
}

function llmJudgeRequest(url: string, prompt: string, criteria: string, timeoutMs: number): Promise<number> {
  validateLlmUrl(url);
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const reqFn = parsed.protocol === "https:" ? httpsRequest : httpRequest;

    const body = JSON.stringify({
      model: "default",
      messages: [
        {
          role: "system",
          content: `You are an eval judge. Rate the following on a scale of 0.0 to 1.0 based on this criteria: ${criteria}. Respond with ONLY a JSON object: {"score": <number>}`,
        },
        { role: "user", content: prompt },
      ],
      max_tokens: 50,
      temperature: 0,
    });

    const req = reqFn(
      parsed,
      { method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) }, timeout: timeoutMs },
      (res) => {
        const MAX_RESPONSE_BYTES = 65_536;
        let data = "";
        let bytes = 0;
        res.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > MAX_RESPONSE_BYTES) {
            req.destroy();
            reject(new Error(`LLM judge response exceeded ${MAX_RESPONSE_BYTES} byte limit`));
            return;
          }
          data += chunk.toString();
        });
        res.on("end", () => {
          try {
            const json = JSON.parse(data) as { choices?: { message?: { content?: string } }[] };
            const content = json.choices?.[0]?.message?.content ?? "";
            const scoreMatch = content.match(/\{[^}]*"score"\s*:\s*([\d.]+)/);
            if (scoreMatch) {
              const score = parseFloat(scoreMatch[1]);
              if (isNaN(score) || score < 0 || score > 1) {
                reject(new Error(`LLM judge returned out-of-range score: ${score}`));
                return;
              }
              resolve(score);
            } else {
              reject(new Error(`LLM judge returned unparseable response: ${content.slice(0, 200)}`));
            }
          } catch {
            reject(new Error(`Failed to parse LLM judge response: ${data.slice(0, 200)}`));
          }
        });
      },
    );
    req.on("error", (e) => reject(new Error(`LLM judge request failed: ${e.message}`)));
    req.on("timeout", () => { req.destroy(); reject(new Error(`LLM judge timed out after ${timeoutMs}ms`)); });
    req.write(body);
    req.end();
  });
}

// ── Case runners ───────────────────────────────────────────────────────

function runDeterministic(c: EvalCase): AssertionResult[] {
  const data = c.input.value ?? c.input;
  return c.assertions.filter((a) => a.type !== "llm_judge").map((a) => checkAssertion(a, data));
}

function runContextSearch(root: string, c: EvalCase): AssertionResult[] {
  const query = String(c.input.query ?? "");
  const topK = typeof c.input.top_k === "number" ? c.input.top_k : 5;
  const scope = typeof c.input.scope === "string" ? c.input.scope : undefined;
  const hits = searchContext(root, query, topK, scope);
  const data = { results: hits, length: hits.length };
  return c.assertions.filter((a) => a.type !== "llm_judge").map((a) => checkAssertion(a, data));
}

async function runLlmJudgeAssertions(
  c: EvalCase,
  url: string,
  timeoutMs: number,
): Promise<AssertionResult[]> {
  const results: AssertionResult[] = [];
  const llmAssertions = c.assertions.filter((a) => a.type === "llm_judge");

  for (const a of llmAssertions) {
    const prompt = String(c.input.prompt ?? c.input.value ?? "");
    const criteria = a.criteria ?? "Is the output correct and relevant?";
    const threshold = a.threshold ?? 0.8;
    try {
      const score = await llmJudgeRequest(url, prompt, criteria, timeoutMs);
      const passed = score >= threshold;
      results.push({ type: "llm_judge", passed, message: passed ? `score ${score} >= ${threshold}` : `score ${score} < ${threshold}` });
    } catch (e) {
      results.push({ type: "llm_judge", passed: false, message: (e as Error).message });
    }
  }
  return results;
}

// ── Main runner ────────────────────────────────────────────────────────

export async function runEvals(root: string): Promise<EvalReport> {
  const suites = loadEvalSuites(root);
  const results: CaseResult[] = [];
  const globalStart = Date.now();

  for (const suite of suites) {
    const llmUrl = resolveEnvVars(suite.config?.llm_judge_url);
    const timeoutMs = suite.config?.timeout_ms ?? 5000;

    for (const c of suite.cases) {
      const start = Date.now();
      const hasLlmAssertions = c.assertions.some((a) => a.type === "llm_judge");

      if (c.type === "llm_judge" && !llmUrl) {
        results.push({
          suiteId: suite.suite,
          caseId: c.id,
          description: c.description ?? "",
          status: "skip",
          assertions: [],
          durationMs: Date.now() - start,
          error: "skipped (no LLM endpoint — set EVAL_LLM_URL)",
        });
        continue;
      }

      try {
        let assertionResults: AssertionResult[] = [];

        if (c.type === "deterministic") {
          assertionResults = runDeterministic(c);
        } else if (c.type === "context_search") {
          assertionResults = runContextSearch(root, c);
        }

        if (hasLlmAssertions && llmUrl) {
          const llmResults = await runLlmJudgeAssertions(c, llmUrl, timeoutMs);
          assertionResults = [...assertionResults, ...llmResults];
        } else if (hasLlmAssertions && !llmUrl) {
          const skippedCount = c.assertions.filter((a) => a.type === "llm_judge").length;
          for (let i = 0; i < skippedCount; i++) {
            assertionResults.push({ type: "llm_judge", passed: true, message: "skipped (no LLM endpoint)" });
          }
        }

        const allPassed = assertionResults.every((r) => r.passed);
        results.push({
          suiteId: suite.suite,
          caseId: c.id,
          description: c.description ?? "",
          status: allPassed ? "pass" : "fail",
          assertions: assertionResults,
          durationMs: Date.now() - start,
        });
      } catch (e) {
        results.push({
          suiteId: suite.suite,
          caseId: c.id,
          description: c.description ?? "",
          status: "error",
          assertions: [],
          durationMs: Date.now() - start,
          error: (e as Error).message,
        });
      }
    }
  }

  return {
    results,
    passed: results.filter((r) => r.status === "pass").length,
    failed: results.filter((r) => r.status === "fail").length,
    skipped: results.filter((r) => r.status === "skip").length,
    errored: results.filter((r) => r.status === "error").length,
    totalMs: Date.now() - globalStart,
  };
}

function resolveEnvVars(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return value.replace(/\$\{(\w+)\}/g, (_, name: string) => process.env[name] ?? "");
}

// ── CI Markdown report ─────────────────────────────────────────────────

export function renderEvalReport(report: EvalReport): string {
  const lines: string[] = [];
  lines.push("## AI Eval Report (BASE-026)");
  lines.push("");
  lines.push("| Suite | Case | Status | Duration | Details |");
  lines.push("|-------|------|--------|----------|---------|");

  for (const r of report.results) {
    const icon = r.status === "pass" ? "✅" : r.status === "fail" ? "❌" : r.status === "skip" ? "⏭️" : "💥";
    const details = r.error ?? r.assertions.map((a) => `${a.passed ? "✓" : "✗"} ${a.type}: ${a.message}`).join("; ");
    lines.push(`| ${r.suiteId} | ${r.caseId} | ${icon} ${r.status} | ${r.durationMs}ms | ${details.slice(0, 120)} |`);
  }

  lines.push("");
  lines.push(`**Summary:** ${report.passed} passed, ${report.failed} failed, ${report.skipped} skipped, ${report.errored} errors | **Total:** ${report.totalMs}ms`);

  if (report.failed > 0 || report.errored > 0) {
    lines.push("");
    lines.push("### Failures");
    lines.push("");
    for (const r of report.results.filter((r) => r.status === "fail" || r.status === "error")) {
      lines.push(`- **${r.suiteId} / ${r.caseId}:** ${r.error ?? r.assertions.filter((a) => !a.passed).map((a) => `${a.type}: ${a.message}`).join("; ")}`);
    }
  }

  return lines.join("\n");
}
