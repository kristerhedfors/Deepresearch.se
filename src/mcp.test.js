// Unit tests for src/mcp.js's PURE JSON-RPC / MCP protocol helpers.
//
// Critical: this suite must load WITHOUT importing pipeline.js (or any heavy
// dep). mcp.js keeps those behind a dynamic import() inside the tools/call
// path, so importing the module here only pulls in the pure helpers + http.js.
// If that structure ever regresses, this import would drag pipeline.js in and
// (potentially) fail outside a Worker — the test doubling as a guard on it.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

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
  structuredToolResult,
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

test("tools/list returns deep_research first plus the literature, adapter, platform and extension families", () => {
  const r = toolsListResult();
  assert.equal(r.tools.length, 16);
  const tool = r.tools[0];
  assert.equal(tool.name, TOOL_NAME);
  assert.equal(tool.name, "deep_research");
  assert.equal(tool, DEEP_RESEARCH_TOOL);
  // Every family rides along in MCP's schema shape (inputSchema, not
  // Anthropic's input_schema) so external agents can search the hosted corpora
  // without shelling into the execution sandbox. The literature family sits
  // directly behind deep_research — same capability, different grain — and the
  // EXTENSION tools come last, because they are the only ones an account can be
  // unable to use for a second reason (its per-extension knob).
  //
  // The four sdk_* manifest tools were removed on 2026-08-15: this surface is
  // shaped for callers without a screen, and a build-planning tool is the
  // clearest case of one such a caller cannot use.
  //
  // The PLATFORM family (2026-08-16) sits between the outward-looking tools and
  // the extension ones: it asks this server about its own implementation, so it
  // reaches no third party and carries no second gate, but it is also not a
  // question about the world.
  assert.deepEqual(
    r.tools.slice(1).map((t) => t.name),
    [
      "literature_search", "literature_fetch", "literature_similar", "literature_corpora",
      "search", "fetch",
      "explain_internals", "improvement_areas", "platform_map",
      "street_view_look", "place_nearby",
      // The host-intelligence family widened from one tool on 2026-08-16: the
      // lookup answers about machines you can already name, and the three that
      // follow answer about a population, a domain and a vulnerability.
      "host_intel", "host_search", "domain_intel", "cve_intel",
    ],
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
  // The two voice-era arguments: which specialist agent answers, and whether the
  // answer is shaped for a screen or for an ear.
  assert.ok(tool.inputSchema.properties.agent, "agent property");
  assert.deepEqual(tool.inputSchema.properties.style.enum, ["text", "voice"]);
  assert.equal(tool.inputSchema.properties.style.default, "text");
});

test("the literature family keeps its retrieval half behind a dynamic import", () => {
  // The file-layout rule at the top of src/mcp.js: this suite must be able to
  // import the protocol module without dragging the pipeline — or, now, the
  // embedder — in. The literature SCHEMAS are statically imported, which is
  // only safe because src/literature-tools.js imports nothing at all; the half
  // that touches a Vectorize binding lives in src/literature-run.js and is
  // loaded inside tools/call. Both halves of that are pinned here, because the
  // natural "simplification" is to merge the two modules and break it.
  const tools = readFileSync(new URL("./literature-tools.js", import.meta.url), "utf8");
  assert.equal(
    /^import\s/m.test(tools),
    false,
    "src/literature-tools.js must import nothing — it is statically imported by mcp.js",
  );
  const mcp = readFileSync(new URL("./mcp.js", import.meta.url), "utf8");
  assert.match(mcp, /await import\("\.\/literature-run\.js"\)/);
  assert.equal(
    /^import .*from "\.\/literature-run\.js"/m.test(mcp),
    false,
    "the runner must never become a static import",
  );
  // And the runner is the module allowed to reach the corpora.
  const runner = readFileSync(new URL("./literature-run.js", import.meta.url), "utf8");
  assert.match(runner, /from "\.\/dense-rag\.js"/);
});

test("the two adapter tools are named exactly what ChatGPT requires", () => {
  // docs/MCP-CONNECTOR.md §2a: without developer mode, ChatGPT refuses any MCP
  // server whose tool list does not contain tools literally called `search` and
  // `fetch`. There is no aliasing this and no negotiating it, so the names are
  // pinned here — a rename that reads like a tidy-up is a connector that stops
  // connecting, with no error anyone can act on.
  const byName = Object.fromEntries(toolsListResult().tools.map((t) => [t.name, t]));
  const search = byName.search;
  const fetchTool = byName.fetch;
  assert.ok(search && fetchTool, "both adapter tools are served");

  // One query string in; results out.
  assert.deepEqual(search.inputSchema.required, ["query"]);
  assert.equal(search.inputSchema.properties.query.type, "string");
  assert.deepEqual(search.outputSchema.required, ["results"]);
  assert.deepEqual(search.outputSchema.properties.results.items.required, ["id", "title", "url"]);

  // One document id in; the document out.
  assert.deepEqual(fetchTool.inputSchema.required, ["id"]);
  assert.deepEqual(fetchTool.outputSchema.required, ["id", "title", "text", "url"]);
  // `text` is the stored abstract and the description has to say so — the
  // corpora hold no full text at runtime and never will without a re-ingest.
  assert.match(fetchTool.description, /abstract/i);
  assert.match(fetchTool.description, /no body text|not full text/i);
  // MCP's own key, not Anthropic's, on both schemas.
  for (const t of [search, fetchTool]) {
    assert.equal(t.input_schema, undefined);
    assert.equal(t.output_schema, undefined);
  }
});

test("structuredToolResult returns the payload TWICE — structured and as text", () => {
  // The dual return is how ChatGPT reads a tool result at all: the object in
  // `structuredContent`, the same object serialized in the content array. The
  // text is passed in rather than re-serialized so the two can never drift.
  const payload = { results: [{ id: "arxiv:2401.12345", title: "A paper", url: "https://arxiv.org/abs/2401.12345" }] };
  const text = JSON.stringify(payload, null, 2);
  const envelope = structuredToolResult(text, payload, false);
  assert.equal(envelope.structuredContent, payload);
  assert.deepEqual(JSON.parse(envelope.content[0].text), payload);
  assert.equal(envelope.content[0].type, "text");
  assert.equal(envelope.isError, false);
  // An error still carries the shape — a client that asked for a document and
  // got a bare string reports a broken server, not a missing paper.
  assert.equal(structuredToolResult("{}", {}, true).isError, true);
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
