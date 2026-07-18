// Unit tests for src/mcp.js's PURE JSON-RPC / MCP protocol helpers.
//
// Critical: this suite must load WITHOUT importing pipeline.js (or any heavy
// dep). mcp.js keeps those behind a dynamic import() inside the tools/call
// path, so importing the module here only pulls in the pure helpers + http.js.
// If that structure ever regresses, this import would drag pipeline.js in and
// (potentially) fail outside a Worker — the test doubling as a guard on it.

import test from "node:test";
import assert from "node:assert/strict";

import {
  PROTOCOL_VERSION,
  SERVER_INFO,
  TOOL_NAME,
  DEEP_RESEARCH_TOOL,
  RPC_PARSE_ERROR,
  RPC_INVALID_REQUEST,
  RPC_METHOD_NOT_FOUND,
  initializeResult,
  toolsListResult,
  toolResult,
  jsonRpcResult,
  jsonRpcError,
  parseJsonRpc,
} from "./mcp.js";

test("parseJsonRpc accepts a well-formed request", () => {
  const r = parseJsonRpc({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
  assert.equal(r.valid, true);
  assert.equal(r.id, 1);
  assert.equal(r.method, "tools/list");
  assert.deepEqual(r.params, {});
  assert.equal(r.isNotification, false);
});

test("parseJsonRpc treats a message without id as a notification", () => {
  const r = parseJsonRpc({ jsonrpc: "2.0", method: "notifications/initialized" });
  assert.equal(r.valid, true);
  assert.equal(r.isNotification, true);
  assert.equal(r.id, undefined);
});

test("parseJsonRpc preserves an explicit numeric id of 0 as a request", () => {
  const r = parseJsonRpc({ jsonrpc: "2.0", id: 0, method: "initialize" });
  assert.equal(r.valid, true);
  assert.equal(r.isNotification, false);
  assert.equal(r.id, 0);
});

test("parseJsonRpc rejects non-object bodies", () => {
  for (const bad of [null, "hi", 42, [], true]) {
    const r = parseJsonRpc(bad);
    assert.equal(r.valid, false, `should reject ${JSON.stringify(bad)}`);
    assert.ok(r.error);
  }
});

test("parseJsonRpc rejects a wrong/missing jsonrpc version", () => {
  assert.equal(parseJsonRpc({ id: 1, method: "x" }).valid, false);
  assert.equal(parseJsonRpc({ jsonrpc: "1.0", id: 1, method: "x" }).valid, false);
});

test("parseJsonRpc rejects a missing/invalid method", () => {
  assert.equal(parseJsonRpc({ jsonrpc: "2.0", id: 1 }).valid, false);
  assert.equal(parseJsonRpc({ jsonrpc: "2.0", id: 1, method: "" }).valid, false);
  assert.equal(parseJsonRpc({ jsonrpc: "2.0", id: 1, method: 5 }).valid, false);
});

test("parseJsonRpc defaults params to an object when absent or non-object", () => {
  assert.deepEqual(parseJsonRpc({ jsonrpc: "2.0", id: 1, method: "x" }).params, {});
  assert.deepEqual(parseJsonRpc({ jsonrpc: "2.0", id: 1, method: "x", params: null }).params, {});
});

test("initializeResult has protocolVersion, serverInfo, and tools capability", () => {
  const r = initializeResult();
  assert.equal(r.protocolVersion, PROTOCOL_VERSION);
  assert.deepEqual(r.serverInfo, SERVER_INFO);
  assert.ok(r.capabilities && r.capabilities.tools, "advertises tools capability");
});

test("tools/list returns deep_research first plus the four SDK manifest tools", () => {
  const r = toolsListResult();
  assert.equal(r.tools.length, 5);
  const tool = r.tools[0];
  assert.equal(tool.name, TOOL_NAME);
  assert.equal(tool.name, "deep_research");
  assert.equal(tool, DEEP_RESEARCH_TOOL);
  // The SDK manifest tools ride along in MCP's schema shape (inputSchema, not
  // Anthropic's input_schema) so external agents can plan against the SDK
  // without shelling into the execution sandbox.
  assert.deepEqual(
    r.tools.slice(1).map((t) => t.name),
    ["sdk_list_modules", "sdk_show_module", "sdk_plan", "sdk_validate"],
  );
  for (const t of r.tools.slice(1)) {
    assert.equal(t.inputSchema.type, "object");
    assert.equal(t.input_schema, undefined);
  }
  // Input schema shape.
  assert.equal(tool.inputSchema.type, "object");
  assert.ok(tool.inputSchema.properties.question, "question property");
  assert.equal(tool.inputSchema.properties.question.type, "string");
  assert.deepEqual(tool.inputSchema.required, ["question"]);
  // Optional params exist and carry their defaults.
  assert.equal(tool.inputSchema.properties.time_budget_s.default, 120);
  assert.equal(tool.inputSchema.properties.web_search.default, true);
  assert.ok(tool.inputSchema.properties.model, "model property");
});

test("toolResult builds an MCP text-content envelope with isError", () => {
  const ok = toolResult("hello", false);
  assert.deepEqual(ok, { content: [{ type: "text", text: "hello" }], isError: false });
  const err = toolResult("boom", true);
  assert.equal(err.isError, true);
  assert.equal(err.content[0].text, "boom");
  // Non-string text is stringified.
  assert.equal(toolResult(42).content[0].text, "42");
});

test("jsonRpcResult wraps a result with the id", () => {
  assert.deepEqual(jsonRpcResult(7, { a: 1 }), { jsonrpc: "2.0", id: 7, result: { a: 1 } });
  // undefined id normalizes to null.
  assert.equal(jsonRpcResult(undefined, {}).id, null);
  // id of 0 is preserved.
  assert.equal(jsonRpcResult(0, {}).id, 0);
});

test("jsonRpcError builds a JSON-RPC error envelope", () => {
  const e = jsonRpcError(3, RPC_METHOD_NOT_FOUND, "Method not found: foo");
  assert.deepEqual(e, {
    jsonrpc: "2.0",
    id: 3,
    error: { code: RPC_METHOD_NOT_FOUND, message: "Method not found: foo" },
  });
  // Optional data is attached only when provided.
  assert.equal(jsonRpcError(1, RPC_INVALID_REQUEST, "x").error.data, undefined);
  assert.deepEqual(jsonRpcError(1, RPC_PARSE_ERROR, "x", { hint: "y" }).error.data, { hint: "y" });
  // undefined id → null.
  assert.equal(jsonRpcError(undefined, RPC_INVALID_REQUEST, "x").id, null);
});
