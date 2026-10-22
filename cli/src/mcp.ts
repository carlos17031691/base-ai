import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { searchContext } from "./context.js";
import { runDoctor } from "./doctor.js";
import { memoryAdd, memoryList } from "./memory.js";
import { listServices } from "./services.js";
import { computeAiStats } from "./stats.js";

export const MCP_SERVER_INFO = {
  name: "base-ai",
  version: "0.7.2",
};

export const MCP_PROTOCOL_VERSION = "2024-11-05";

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export const TOOLS: McpToolDefinition[] = [
  {
    name: "search_context",
    description: "Search ranked ADRs, RFCs, Runbooks, Memory, and Contracts in the project using hybrid keyword search.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Natural language or keyword search query" },
        scope: { type: "string", description: "Optional filter: 'root' or 'service:<name>'" },
        topK: { type: "number", description: "Maximum number of results to return (default: 5)" },
      },
      required: ["query"],
    },
  },
  {
    name: "get_memory",
    description: "Read persistent cross-session project memory notes and architectural learnings.",
    inputSchema: {
      type: "object",
      properties: {
        service: { type: "string", description: "Optional service name to read service-specific memory" },
      },
    },
  },
  {
    name: "add_memory",
    description: "Persist a cross-session learning or architectural decision to .ai/memory.md and auto-sync all agent files.",
    inputSchema: {
      type: "object",
      properties: {
        note: { type: "string", description: "Learning or rule to persist (zero secrets allowed)" },
        ticket: { type: "string", description: "Optional Story/Ticket ID (e.g. PROJ-123, BASE-008)" },
        tag: { type: "string", description: "Optional topic tag (e.g. #sdlc, #security, #ai-ops)" },
        service: { type: "string", description: "Optional service name" },
      },
      required: ["note"],
    },
  },
  {
    name: "check_health",
    description: "Run base-ai doctor to validate project health, service manifest, git hooks, and detect AI rules drift.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "get_ai_stats",
    description: "Inspect token footprint of always-on rules vs on-demand skills (AI FinOps telemetry).",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "list_services",
    description: "List all registered independent microservices from services.yaml.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
];

export const RESOURCES = [
  {
    uri: "base-ai://rules",
    name: "Global AI Rules",
    description: "Active architectural and SDLC engineering rules from .ai/rules.md",
    mimeType: "text/markdown",
  },
  {
    uri: "base-ai://memory",
    name: "Project Memory",
    description: "Persistent cross-session architectural learnings from .ai/memory.md",
    mimeType: "text/markdown",
  },
  {
    uri: "base-ai://manifest",
    name: "Services Manifest",
    description: "Registered microservices configuration from services.yaml",
    mimeType: "text/yaml",
  },
];

export const PROMPTS = [
  {
    name: "sdlc_review",
    description: "Guide a PR review against base-ai quality gates, clean code, security, and severity triage.",
    arguments: [
      {
        name: "pr_diff",
        description: "The code diff or description of changes to review",
        required: true,
      },
    ],
  },
  {
    name: "architecture_adr",
    description: "Template and instructions to draft an immutable Architecture Decision Record (ADR).",
    arguments: [
      {
        name: "decision_title",
        description: "Title of the architecture decision",
        required: true,
      },
    ],
  },
];

/** Executes an MCP tool call against the base-ai project. */
export function handleToolCall(root: string, name: string, args: Record<string, unknown> = {}): { text: string; isError?: boolean } {
  try {
    switch (name) {
      case "search_context": {
        const query = String(args.query || "").trim();
        if (!query) return { text: "Error: Missing required query parameter.", isError: true };
        const topK = typeof args.topK === "number" ? args.topK : 5;
        const scope = typeof args.scope === "string" ? args.scope : undefined;
        const hits = searchContext(root, query, topK, scope);
        if (!hits.length) return { text: "No matching context chunks found in project." };
        const formatted = hits
          .map(
            (h) =>
              `### [${h.id}] ${h.title} › ${h.section} (${h.scope} | ${h.kind}${h.status ? ` | ${h.status}` : ""} | score=${h.score.toFixed(2)})\n` +
              `Path: ${h.path} (L${h.startLine}-${h.endLine})\n\n${h.snippet}\n`,
          )
          .join("\n---\n\n");
        return { text: formatted };
      }

      case "get_memory": {
        const service = typeof args.service === "string" ? args.service : undefined;
        const entries = memoryList(root, service);
        if (!entries.length) return { text: "No memory entries found." };
        return { text: entries.join("\n") };
      }

      case "add_memory": {
        const note = String(args.note || "").trim();
        if (!note) return { text: "Error: Missing required note parameter.", isError: true };
        const ticket = typeof args.ticket === "string" ? args.ticket : undefined;
        const tag = typeof args.tag === "string" ? args.tag : undefined;
        const service = typeof args.service === "string" ? args.service : undefined;
        const entry = memoryAdd(root, note, { ticket, tag, service });
        return { text: `✔ Memory added and agents synchronized:\n${entry}` };
      }

      case "check_health": {
        const report = runDoctor(root);
        const syncSummary = report.syncResults
          .map((s) => `  ${s.target}: ${s.written.length} written, ${s.removed.length} removed, ${s.unchanged.length} unchanged`)
          .join("\n");
        const statusText = report.issues.length
          ? `✖ Doctor detected ${report.issues.length} issue(s):\n${report.issues.map((i) => `  - ${i}`).join("\n")}`
          : "✔ All base-ai doctor health checks passed cleanly.";
        return { text: `${statusText}\n\nSync status:\n${syncSummary}` };
      }

      case "get_ai_stats": {
        const stats = computeAiStats(root);
        const topSkills = stats.skills
          .slice(0, 5)
          .map((s) => `  - ${s.name}: ~${s.estimatedTokens} tokens`)
          .join("\n");
        return {
          text:
            `AI Token Footprint (FinOps):\n` +
            `- Always-on rules: ~${stats.alwaysOnTokens} tokens (budget: ${stats.alwaysOnBudget}, within budget: ${stats.withinBudget})\n` +
            `- On-demand skills total: ~${stats.skillsTotalTokens} tokens across ${stats.skills.length} skills\n\n` +
            `Top skills by footprint:\n${topSkills}`,
        };
      }

      case "list_services": {
        const services = listServices(root);
        if (!services.length) return { text: "No services registered in services.yaml." };
        const formatted = services
          .map((s) => `- **${s.name}**: ${s.repo}${s.branch ? ` (branch: ${s.branch})` : ""}${s.cloud ? ` [${s.cloud}/${s.iac ?? "none"}]` : ""}`)
          .join("\n");
        return { text: `Registered Services (${services.length}):\n${formatted}` };
      }

      default:
        return { text: `Unknown tool: "${name}"`, isError: true };
    }
  } catch (err) {
    return { text: `Tool error (${name}): ${(err as Error).message}`, isError: true };
  }
}

/** Reads an MCP resource by URI. */
export function handleResourceRead(root: string, uri: string): { contents: Array<{ uri: string; mimeType: string; text: string }> } | null {
  switch (uri) {
    case "base-ai://rules": {
      const p = join(root, ".ai", "rules.md");
      const text = existsSync(p) ? readFileSync(p, "utf8") : "# No rules found";
      return { contents: [{ uri, mimeType: "text/markdown", text }] };
    }
    case "base-ai://memory": {
      const p = join(root, ".ai", "memory.md");
      const text = existsSync(p) ? readFileSync(p, "utf8") : "# No memory found";
      return { contents: [{ uri, mimeType: "text/markdown", text }] };
    }
    case "base-ai://manifest": {
      const p = join(root, "services.yaml");
      const text = existsSync(p) ? readFileSync(p, "utf8") : "services: []";
      return { contents: [{ uri, mimeType: "text/yaml", text }] };
    }
    default:
      return null;
  }
}

/** Processes a single JSON-RPC request and returns the response object (or null for notifications). */
export function processMcpMessage(root: string, req: JsonRpcRequest): JsonRpcResponse | null {
  const id = req.id !== undefined ? req.id : null;

  // Notification without id: do not respond
  if (id === null && req.method.startsWith("notifications/")) {
    return null;
  }

  switch (req.method) {
    case "initialize":
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: MCP_PROTOCOL_VERSION,
          serverInfo: MCP_SERVER_INFO,
          capabilities: {
            tools: {},
            resources: {},
            prompts: {},
          },
        },
      };

    case "ping":
      return { jsonrpc: "2.0", id, result: {} };

    case "tools/list":
      return { jsonrpc: "2.0", id, result: { tools: TOOLS } };

    case "tools/call": {
      const toolName = String(req.params?.name || "");
      const toolArgs = (req.params?.arguments as Record<string, unknown>) || {};
      const out = handleToolCall(root, toolName, toolArgs);
      return {
        jsonrpc: "2.0",
        id,
        result: {
          content: [{ type: "text", text: out.text }],
          isError: out.isError === true,
        },
      };
    }

    case "resources/list":
      return { jsonrpc: "2.0", id, result: { resources: RESOURCES } };

    case "resources/read": {
      const uri = String(req.params?.uri || "");
      const res = handleResourceRead(root, uri);
      if (!res) {
        return {
          jsonrpc: "2.0",
          id,
          error: { code: -32602, message: `Resource not found: ${uri}` },
        };
      }
      return { jsonrpc: "2.0", id, result: res };
    }

    case "prompts/list":
      return { jsonrpc: "2.0", id, result: { prompts: PROMPTS } };

    case "prompts/get": {
      const promptName = String(req.params?.name || "");
      if (promptName === "sdlc_review") {
        const diff = String((req.params?.arguments as Record<string, unknown>)?.pr_diff || "");
        return {
          jsonrpc: "2.0",
          id,
          result: {
            description: "Review this diff against base-ai rules",
            messages: [
              {
                role: "user",
                content: {
                  type: "text",
                  text: `Please review the following code changes according to base-ai SDLC and review rules (classify by [High], [Medium], [Low] severity):\n\n\`\`\`diff\n${diff}\n\`\`\``,
                },
              },
            ],
          },
        };
      }
      return {
        jsonrpc: "2.0",
        id,
        error: { code: -32602, message: `Prompt not found: ${promptName}` },
      };
    }

    default:
      return {
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: `Method not found: ${req.method}` },
      };
  }
}

/** Starts the stdio JSON-RPC server loop. */
export function startMcpServer(root: string): void {
  // Informative start message on stderr (stdout is reserved exclusively for JSON-RPC)
  process.stderr.write(`[base-ai-mcp] Starting MCP server v${MCP_SERVER_INFO.version} (root: ${root})\n`);

  const rl = createInterface({ input: process.stdin, terminal: false });

  rl.on("line", (raw) => {
    const line = raw.trim();
    if (!line) return;

    try {
      const req = JSON.parse(line) as JsonRpcRequest;
      const resp = processMcpMessage(root, req);
      if (resp !== null) {
        process.stdout.write(JSON.stringify(resp) + "\n");
      }
    } catch (err) {
      const errResp: JsonRpcResponse = {
        jsonrpc: "2.0",
        id: null,
        error: {
          code: -32700,
          message: `Parse error: ${(err as Error).message}`,
        },
      };
      process.stdout.write(JSON.stringify(errResp) + "\n");
    }
  });

  rl.on("close", () => {
    process.stderr.write("[base-ai-mcp] Stdio stream closed. Shutting down.\n");
  });
}
