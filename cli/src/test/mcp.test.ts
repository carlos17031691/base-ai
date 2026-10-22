import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { handleResourceRead, handleToolCall, processMcpMessage, startMcpServer, TOOLS, RESOURCES } from "../mcp.js";
import { init } from "../init.js";

function setupFixture(t: { after(callback: () => void): void }): string {
  const d = mkdtempSync(join(tmpdir(), "base-ai-mcp-test-"));
  t.after(() => rmSync(d, { recursive: true, force: true }));
  init(d);
  return d;
}

test("MCP server: initialize handshake and ping", (t) => {
  const root = setupFixture(t);

  // initialize
  const initResp = processMcpMessage(root, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
  });
  assert.equal(initResp?.id, 1);
  const res = initResp?.result as any;
  assert.equal(res.serverInfo.name, "base-ai");
  assert.equal(res.protocolVersion, "2024-11-05");
  assert.ok(res.capabilities.tools);
  assert.ok(res.capabilities.resources);
  assert.ok(res.capabilities.prompts);

  // ping
  const pingResp = processMcpMessage(root, {
    jsonrpc: "2.0",
    id: 2,
    method: "ping",
  });
  assert.equal(pingResp?.id, 2);
  assert.deepEqual(pingResp?.result, {});

  // notification without id returns null
  const notifResp = processMcpMessage(root, {
    jsonrpc: "2.0",
    method: "notifications/initialized",
  });
  assert.equal(notifResp, null);
});

test("MCP server: tools/list and tools/call execution", (t) => {
  const root = setupFixture(t);

  // tools/list
  const listResp = processMcpMessage(root, {
    jsonrpc: "2.0",
    id: 10,
    method: "tools/list",
  });
  const tools = (listResp?.result as any).tools;
  assert.equal(tools.length, TOOLS.length);
  const toolNames = tools.map((t: any) => t.name);
  assert.ok(toolNames.includes("search_context"));
  assert.ok(toolNames.includes("get_memory"));
  assert.ok(toolNames.includes("add_memory"));
  assert.ok(toolNames.includes("check_health"));
  assert.ok(toolNames.includes("get_ai_stats"));
  assert.ok(toolNames.includes("list_services"));

  // tools/call: search_context
  const searchCall = processMcpMessage(root, {
    jsonrpc: "2.0",
    id: 11,
    method: "tools/call",
    params: {
      name: "search_context",
      arguments: { query: "sdlc" },
    },
  });
  assert.equal(searchCall?.id, 11);
  const searchContent = (searchCall?.result as any).content[0].text;
  assert.ok(searchContent.length > 0);
  assert.equal((searchCall?.result as any).isError, false);

  // tools/call: get_memory
  const memGetCall = processMcpMessage(root, {
    jsonrpc: "2.0",
    id: 12,
    method: "tools/call",
    params: { name: "get_memory" },
  });
  assert.equal(memGetCall?.id, 12);

  // tools/call: add_memory
  const memAddCall = processMcpMessage(root, {
    jsonrpc: "2.0",
    id: 13,
    method: "tools/call",
    params: {
      name: "add_memory",
      arguments: {
        note: "All database queries must use prepared statements",
        ticket: "SEC-101",
        tag: "security",
      },
    },
  });
  assert.equal(memAddCall?.id, 13);
  const memAddContent = (memAddCall?.result as any).content[0].text;
  assert.ok(memAddContent.includes("SEC-101"));

  // tools/call: check_health (doctor)
  const healthCall = processMcpMessage(root, {
    jsonrpc: "2.0",
    id: 14,
    method: "tools/call",
    params: { name: "check_health" },
  });
  assert.equal(healthCall?.id, 14);
  const healthContent = (healthCall?.result as any).content[0].text;
  assert.ok(healthContent.includes("doctor health checks passed cleanly"));

  // tools/call: get_ai_stats
  const statsCall = processMcpMessage(root, {
    jsonrpc: "2.0",
    id: 15,
    method: "tools/call",
    params: { name: "get_ai_stats" },
  });
  assert.equal(statsCall?.id, 15);
  const statsContent = (statsCall?.result as any).content[0].text;
  assert.ok(statsContent.includes("AI Token Footprint"));

  // tools/call: list_services
  const svcCall = processMcpMessage(root, {
    jsonrpc: "2.0",
    id: 16,
    method: "tools/call",
    params: { name: "list_services" },
  });
  assert.equal(svcCall?.id, 16);

  // tools/call: unknown tool
  const unknownCall = processMcpMessage(root, {
    jsonrpc: "2.0",
    id: 17,
    method: "tools/call",
    params: { name: "non_existent_tool" },
  });
  assert.equal((unknownCall?.result as any).isError, true);
});

test("MCP server: handleToolCall validation and error paths", (t) => {
  const root = setupFixture(t);

  // empty search query returns error
  const emptyQuery = handleToolCall(root, "search_context", { query: "" });
  assert.equal(emptyQuery.isError, true);
  assert.ok(emptyQuery.text.includes("Missing required query"));

  // topK clamping and valid hits
  const searchHit = handleToolCall(root, "search_context", { query: "base-ai", topK: 100 });
  assert.equal(searchHit.isError, undefined);
  assert.ok(searchHit.text.includes("base-ai"));

  // empty note returns error
  const emptyNote = handleToolCall(root, "add_memory", { note: "" });
  assert.equal(emptyNote.isError, true);
  assert.ok(emptyNote.text.includes("Missing required note"));

  // secret-like note returns error
  const secretNote = handleToolCall(root, "add_memory", { note: "Secret API token sk-1234567890123456" });
  assert.equal(secretNote.isError, true);
  assert.ok(secretNote.text.includes("Refusing to store a potential secret"));

  // invalid ticket format returns error
  const invalidTicket = handleToolCall(root, "add_memory", { note: "Note", ticket: "INVALID TICKET with spaces!" });
  assert.equal(invalidTicket.isError, true);
  assert.ok(invalidTicket.text.includes("Invalid ticket format"));

  // invalid tag format returns error
  const invalidTag = handleToolCall(root, "add_memory", { note: "Note", tag: "bad tag with spaces" });
  assert.equal(invalidTag.isError, true);
  assert.ok(invalidTag.text.includes("Invalid tag format"));

  // invalid service name returns error
  const invalidSvc = handleToolCall(root, "add_memory", { note: "Note", service: "../../escape" });
  assert.equal(invalidSvc.isError, true);
  assert.ok(invalidSvc.text.includes("Invalid service name"));
});

test("MCP server: resources/list and resources/read", (t) => {
  const root = setupFixture(t);

  // resources/list
  const resList = processMcpMessage(root, {
    jsonrpc: "2.0",
    id: 20,
    method: "resources/list",
  });
  const resources = (resList?.result as any).resources;
  assert.equal(resources.length, RESOURCES.length);

  // resources/read: base-ai://rules
  const readRules = processMcpMessage(root, {
    jsonrpc: "2.0",
    id: 21,
    method: "resources/read",
    params: { uri: "base-ai://rules" },
  });
  const rulesContent = (readRules?.result as any).contents[0];
  assert.equal(rulesContent.mimeType, "text/markdown");
  assert.ok(rulesContent.text.includes("Global rules"));

  // resources/read: non-existent URI returns JSON-RPC error
  const readMissing = processMcpMessage(root, {
    jsonrpc: "2.0",
    id: 22,
    method: "resources/read",
    params: { uri: "base-ai://non-existent" },
  });
  assert.equal(readMissing?.error?.code, -32602);
});

test("MCP server: prompts/list and prompts/get", (t) => {
  const root = setupFixture(t);

  const promptList = processMcpMessage(root, {
    jsonrpc: "2.0",
    id: 30,
    method: "prompts/list",
  });
  assert.ok((promptList?.result as any).prompts.length > 0);

  const promptGet = processMcpMessage(root, {
    jsonrpc: "2.0",
    id: 31,
    method: "prompts/get",
    params: {
      name: "sdlc_review",
      arguments: { pr_diff: "+ const secure = true;" },
    },
  });
  assert.ok((promptGet?.result as any).messages[0].content.text.includes("secure = true"));
});

test("MCP server: unknown method and startMcpServer validation", (t) => {
  const root = setupFixture(t);

  const unknownResp = processMcpMessage(root, {
    jsonrpc: "2.0",
    id: 99,
    method: "custom/unknown_method",
  });
  assert.equal(unknownResp?.id, 99);
  assert.equal(unknownResp?.error?.code, -32601);

  // startMcpServer throws if directory is not a base-ai project
  assert.throws(() => {
    startMcpServer(tmpdir());
  }, /missing \.ai/);
});
