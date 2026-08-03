// @ts-check
// POST /mcp — exposes the deep-research pipeline AS an MCP server so other
// agents (Claude, Cursor, any MCP client) can call it as a single tool.
//
// Transport: modern **Streamable HTTP** — JSON-RPC 2.0 over a single POST.
// The protocol surface is tiny, so it's hand-rolled (no dependency): the
// three methods a minimal server needs (`initialize`, `tools/list`,
// `tools/call`) plus a no-op ack for `notifications/initialized`.
//
// TWO WAYS IN, both resolving to a real account before this module runs:
//   - Behind the identity gate (src/index.js routeApi), so a signed-in browser
//     session or the break-glass Basic secrets work exactly as they always did.
//   - With an MCP KEY (src/mcp-key.js) — the bearer credential an external
//     client such as Claude Code carries, resolved above the gate by
//     src/mcp-api.js's resolveMcpKeyIdentity and scoped to this endpoint alone.
//
// WHAT is exposed is per-account configuration (src/mcp-config.js, edited in
// Settings → "MCP server"): the tool list is filtered by it, dispatch enforces
// it, and the research tool's arguments are reconciled against the account's
// defaults and override policy.
//
// FILE LAYOUT — deliberate, so src/mcp.test.js can unit-test the protocol
// without loading the pipeline: the PURE JSON-RPC helpers, envelope builders,
// tool schema, and initialize payload are exported at the TOP with no heavy
// imports. The single heavy import — the pipeline and its deps — is a DYNAMIC
// import() INSIDE the tools/call handler, so importing this module (as the
// test does) never pulls in pipeline.js/berget.js/etc.

import { emptyExtensionState } from "./extensions.js";
import { jsonResponse } from "./http.js";
// A leaf module (imports nothing), so this static import does NOT pull the
// pipeline graph in — the file-layout rule above (heavy deps stay dynamic) is
// preserved. Shares the split-model-routing decision with src/chat.js.
import { resolveJsonModel } from "./model-routing.js";
// DistillSDK's pure core (via the src/sdk-tools.js façade): manifest
// operations + the provider-neutral sdk_* tool definitions. Pure and
// dependency-light (no pipeline/berget imports), so a static import keeps the
// file-layout rule intact; only the SNAPSHOT loading (tools/call time) is a
// dynamic import of ./introspect.js below.
import { SDK_TOOLS, SDK_TOOL_NAMES, manifestFromSnapshot, runSdkTool, snapshotFileCheck } from "./sdk-tools.js";
// The LITERATURE family: the two hosted scientific corpora (arXiv, PubMed) as
// directly searchable knowledge bases. Only the SCHEMAS are imported here —
// src/literature-tools.js imports nothing at all, so the file-layout rule holds;
// everything that touches a Vectorize binding or the embedder lives in
// src/literature-run.js, loaded by a dynamic import in the dispatch below.
import { LITERATURE_TOOLS, LITERATURE_TOOL_NAMES } from "./literature-tools.js";
// WHAT this server exposes is per-account configuration (Settings → "MCP
// server"). A pure leaf module — catalog, parse, filter, argument resolution —
// so this static import keeps the file-layout rule above intact.
import { defaultMcpConfig, filterMcpTools, parseMcpConfig, resolveResearchArgs, toolExposed } from "./mcp-config.js";

/** @typedef {import('./types.js').Env} Env */
/** @typedef {import('./types.js').Logger} Logger */
/** @typedef {import('./settings.js').Identity} Identity */
/**
 * A parsed JSON-RPC message (parseJsonRpc's success shape).
 * @typedef {{ valid: true, id: unknown, method: string, params: any, isNotification: boolean }} ParsedRpc
 */
/**
 * The per-request pipeline state THIS module builds (newRequestState below):
 * the same shape the pipeline consumes and extends as phases run. A JSDoc
 * import is type-only, so referencing pipeline.js here does NOT defeat this
 * module's keep-imports-light rule.
 * @typedef {import('./pipeline.js').PipelineState} McpRequestState
 */

// ---------------------------------------------------------------------------
// PURE protocol helpers (no heavy imports) — unit-tested in src/mcp.test.js
// ---------------------------------------------------------------------------

// MCP protocol revision we implement. `initialize` reports this back so the
// client can confirm compatibility.
export const PROTOCOL_VERSION = "2025-06-18";
export const SERVER_INFO = { name: "deepresearch.se", version: "1.0.0" };

// JSON-RPC 2.0 standard error codes (subset we use).
export const RPC_PARSE_ERROR = -32700;
export const RPC_INVALID_REQUEST = -32600;
export const RPC_METHOD_NOT_FOUND = -32601;
export const RPC_INVALID_PARAMS = -32602;
export const RPC_INTERNAL_ERROR = -32603;

// The single tool this server exposes. Its handler runs the full research
// pipeline and returns the synthesized answer text.
export const TOOL_NAME = "deep_research";
export const DEEP_RESEARCH_TOOL = {
  name: TOOL_NAME,
  description:
    "Run a deep-research query through DeepResearch.se: it plans search " +
    "angles, searches the web, audits coverage for gaps, and synthesizes a " +
    "cited answer built only from the sources it found. Returns the final " +
    "answer text with inline [n] citations and a Sources list. Best for " +
    "questions that benefit from current, multi-source web research.",
  inputSchema: {
    type: "object",
    properties: {
      question: {
        type: "string",
        description: "The research question to answer.",
      },
      time_budget_s: {
        type: "number",
        description:
          "Wall-clock research budget in seconds. Larger budgets buy more " +
          "search angles and gap rounds. Clamped to the site's allowed range.",
        default: 120,
        minimum: 15,
        maximum: 600,
      },
      model: {
        type: "string",
        description:
          "Optional Berget model id to synthesize the answer with. Omit to " +
          "use the site default. (JSON planning phases always run on a fixed " +
          "reliable model regardless.)",
      },
      web_search: {
        type: "boolean",
        description:
          "Whether to run web searches (default true). When false, the model " +
          "answers directly without contacting the search provider.",
        default: true,
      },
    },
    required: ["question"],
  },
};

// The `initialize` result: protocol version, server identity, and the
// capabilities we advertise (only tools).
export function initializeResult() {
  return {
    protocolVersion: PROTOCOL_VERSION,
    serverInfo: SERVER_INFO,
    capabilities: { tools: {} },
  };
}

// DistillSDK's manifest tools, exposed over MCP too (2026-07-18) so
// an external agent can plan against the SDK — list/show/plan/validate —
// WITHOUT shelling into the in-browser execution sandbox to run
// `node sdk/pair-cli.mjs`: the same pure core answers directly. The shared
// definitions carry Anthropic's `input_schema` key; MCP wants `inputSchema`.
export const SDK_MCP_TOOLS = SDK_TOOLS.map(({ name, description, input_schema }) => ({
  name,
  description,
  inputSchema: input_schema,
}));

// The literature family, same rename. These are the only tools here that reach
// a data store rather than committed data, which is why their runner is loaded
// dynamically even though their definitions are static.
export const LITERATURE_MCP_TOOLS = LITERATURE_TOOLS.map(({ name, description, input_schema }) => ({
  name,
  description,
  inputSchema: input_schema,
}));

// Every tool this server CAN serve, in a stable order. What a given caller
// actually sees is this list filtered by the account's exposure config —
// src/mcp-config.js's catalog mirrors it exactly, a correspondence its unit
// test enforces, so no tool can ship without a switch to turn it off.
//
// The literature family sits directly behind deep_research because the two are
// the same capability at different grain: deep_research answers a question,
// literature_* hands an agent the corpus to answer it from. A client scanning
// the list top-down should meet them together.
export const ALL_MCP_TOOLS = [DEEP_RESEARCH_TOOL, ...LITERATURE_MCP_TOOLS, ...SDK_MCP_TOOLS];

// The `tools/list` result, narrowed to what this account exposes. Called with
// no argument it reports the full set (the default config) — which is what an
// identity with no account row, notably the break-glass operator, gets.
/**
 * @param {import('./mcp-config.js').McpConfig} [config]
 */
export function toolsListResult(config) {
  return { tools: filterMcpTools(config || defaultMcpConfig(), ALL_MCP_TOOLS) };
}

// Build an MCP tools/call result envelope (text content + isError flag).
/**
 * @param {unknown} text
 * @param {boolean} [isError]
 */
export function toolResult(text, isError = false) {
  return { content: [{ type: "text", text: String(text) }], isError: !!isError };
}

// JSON-RPC 2.0 success envelope. `id` of undefined normalizes to null
// (should not happen for a request, but keeps the envelope well-formed).
/**
 * @param {unknown} id
 * @param {unknown} result
 */
export function jsonRpcResult(id, result) {
  return { jsonrpc: "2.0", id: id === undefined ? null : id, result };
}

// JSON-RPC 2.0 error envelope.
/**
 * @param {unknown} id
 * @param {number} code
 * @param {string} message
 * @param {unknown} [data]
 */
export function jsonRpcError(id, code, message, data) {
  /** @type {{ code: number, message: string, data?: unknown }} */
  const error = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: "2.0", id: id === undefined ? null : id, error };
}

// Validate + shape a parsed JSON-RPC message. Returns
// { valid, id, method, params, isNotification } or { valid:false, id, error }.
// A message WITHOUT an `id` is a notification (no response is expected).
/**
 * @param {any} body
 * @returns {ParsedRpc | { valid: false, id: unknown, error: string }}
 */
export function parseJsonRpc(body) {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return { valid: false, id: null, error: "Request must be a JSON-RPC 2.0 object." };
  }
  const hasId = Object.prototype.hasOwnProperty.call(body, "id");
  const id = hasId ? body.id : undefined;
  const isNotification = !hasId;
  if (body.jsonrpc !== "2.0") {
    return { valid: false, id, error: 'Missing or invalid "jsonrpc" version (expected "2.0").' };
  }
  if (typeof body.method !== "string" || !body.method) {
    return { valid: false, id, error: "Missing or invalid `method`." };
  }
  return {
    valid: true,
    id,
    method: body.method,
    params: body.params && typeof body.params === "object" ? body.params : {},
    isNotification,
  };
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

/**
 * @param {Request} request
 * @param {Env} env
 * @param {Logger} log
 * @param {Identity} identity
 * @param {ExecutionContext} ctx
 * @param {string} requestId
 * @returns {Promise<Response>}
 */
export async function handleMcp(request, env, log, identity, ctx, requestId) {
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse(jsonRpcError(null, RPC_PARSE_ERROR, "Parse error: body must be valid JSON."));
  }

  const parsed = parseJsonRpc(body);
  if (!parsed.valid) {
    return jsonResponse(jsonRpcError(parsed.id, RPC_INVALID_REQUEST, parsed.error));
  }

  // Notifications (e.g. notifications/initialized) get no response body —
  // the Streamable HTTP transport answers with 202 Accepted.
  if (parsed.isNotification) {
    return new Response(null, { status: 202 });
  }

  // WHAT this caller sees. A signed-in account's exposure config governs both
  // the listing and the dispatch below; an identity with no D1 row (the
  // break-glass operator) has nowhere to store one and gets the full default
  // set, exactly as before this configuration existed.
  const config = identity?.user ? parseMcpConfig(identity.user.settings_json) : defaultMcpConfig();

  switch (parsed.method) {
    case "initialize":
      return jsonResponse(jsonRpcResult(parsed.id, initializeResult()));
    case "tools/list":
      return jsonResponse(jsonRpcResult(parsed.id, toolsListResult(config)));
    case "tools/call":
      return handleToolCall(parsed, env, log, identity, ctx, requestId, config);
    default:
      return jsonResponse(
        jsonRpcError(parsed.id, RPC_METHOD_NOT_FOUND, `Method not found: ${parsed.method}`),
      );
  }
}

// tools/call dispatcher: the SDK manifest family, then `deep_research`;
// anything else — including a tool this account does not
// expose — is an invalid-params error. The tool itself fails soft: any pipeline
// error comes back as an MCP result with isError:true (a protocol-level success
// carrying a tool-level failure), never a transport error.
/**
 * @param {ParsedRpc} parsed
 * @param {Env} env
 * @param {Logger} log
 * @param {Identity} identity
 * @param {ExecutionContext} ctx
 * @param {string} requestId
 * @param {import('./mcp-config.js').McpConfig} config this account's exposure config
 */
async function handleToolCall(parsed, env, log, identity, ctx, requestId, config) {
  const { id, params } = parsed;
  const name = params?.name;
  const args = params?.arguments && typeof params.arguments === "object" ? params.arguments : {};

  // Exposure is enforced on the CALL, not just on the listing: a client that
  // cached an older tools/list (or guessed a name) must not be able to reach a
  // tool the account has since switched off. Reported as method-not-found
  // rather than as a permission error — from the caller's side an unexposed
  // tool simply does not exist on this server.
  if (typeof name === "string" && !toolExposed(config, name)) {
    return jsonResponse(
      jsonRpcError(id, RPC_INVALID_PARAMS, `Unknown tool: ${name}`),
    );
  }

  // The SDK manifest tools: pure reads over the deployed source snapshot's
  // sdk/MANIFEST.json (the same artifact introspection mode runs on). They
  // fail soft — a missing snapshot/manifest comes back as an isError result.
  if (typeof name === "string" && SDK_TOOL_NAMES.has(name)) {
    try {
      const { loadSourceSnapshot } = await import("./introspect.js");
      const snapshot = await loadSourceSnapshot(env, log);
      const manifest = manifestFromSnapshot(snapshot);
      const text = runSdkTool(manifest, name, args, { fileCheck: snapshotFileCheck(snapshot) });
      log.info("mcp.sdk_tool", { tool: name, user_id: identity?.id });
      return jsonResponse(jsonRpcResult(id, toolResult(text, !manifest)));
    } catch (err) {
      const message = (/** @type {any} */ (err))?.message || String(err);
      log.error("mcp.sdk_tool_failed", { tool: name, error: message });
      return jsonResponse(jsonRpcResult(id, toolResult(`SDK tool failed: ${message}`, true)));
    }
  }

  // The literature family: dense retrieval over the two hosted scientific
  // corpora. Unlike the two families above these reach a data store and spend
  // real (small) provider money, so the two SEARCHING tools sit behind the same
  // research quota /api/chat and deep_research enforce — an exhausted account
  // must not be able to keep hammering the index from a long-lived key.
  // literature_corpora and literature_fetch are deliberately outside the gate:
  // one reads committed facts plus an index description, the other is a direct
  // key read, and an agent that has run out of budget should still be able to
  // learn what exists and resolve an id it was handed.
  if (typeof name === "string" && LITERATURE_TOOL_NAMES.has(name)) {
    try {
      if (name === "literature_search" || name === "literature_similar") {
        const blocked = await researchQuotaBlock(env, log, identity);
        if (blocked) {
          log.info("mcp.quota_blocked", { tool: name, user_id: identity?.id });
          return jsonResponse(jsonRpcResult(id, toolResult(blocked, true)));
        }
      }
      const { runLiteratureTool } = await import("./literature-run.js");
      const result = await runLiteratureTool(env, log, name, args);
      log.info("mcp.literature_tool", {
        tool: name,
        user_id: identity?.id,
        queries: result.queries,
        records: result.records,
        request_id: requestId,
      });
      return jsonResponse(jsonRpcResult(id, toolResult(result.text, result.isError)));
    } catch (err) {
      const message = (/** @type {any} */ (err))?.message || String(err);
      log.error("mcp.literature_tool_failed", { tool: name, error: message });
      return jsonResponse(jsonRpcResult(id, toolResult(`Literature tool failed: ${message}`, true)));
    }
  }

  if (name !== TOOL_NAME) {
    return jsonResponse(jsonRpcError(id, RPC_INVALID_PARAMS, `Unknown tool: ${name ?? "(none)"}`));
  }

  const question = typeof args.question === "string" ? args.question.trim() : "";
  if (!question) {
    return jsonResponse(
      jsonRpcResult(id, toolResult("The `question` argument is required and must be a non-empty string.", true)),
    );
  }

  // The account's defaults and override policy decide the effective arguments:
  // what the caller sent wins only where the account allows it (src/mcp-config.js
  // resolveResearchArgs). Resolved here so the failure path below logs the run
  // that was actually attempted, not the run that was asked for.
  const research = resolveResearchArgs(config, args);

  try {
    const text = await runDeepResearch(env, log, identity, requestId, research, question);
    return jsonResponse(jsonRpcResult(id, toolResult(text, false)));
  } catch (err) {
    const message = (/** @type {any} */ (err))?.message || String(err);
    log.error("mcp.tool_failed", { tool: name, user_id: identity?.id, error: message });
    // Failed interactions land in the full-visibility chat log too (the
    // success path records inside runDeepResearch, where the pipeline state
    // lives). Dynamic import keeps the pure helpers above import-light.
    const { recordChatLog } = await import("./chatlog.js");
    await recordChatLog(env, log, {
      request_id: requestId,
      user_id: String(identity?.id ?? ""),
      channel: "mcp",
      conversation: [{ role: "user", content: question }],
      status: "error",
      error: message,
      web_search: research.web_search,
    });
    return jsonResponse(jsonRpcResult(id, toolResult("Research failed: " + message, true)));
  }
}

/**
 * The research quota gate, shared by every tool on this surface that spends
 * provider money — deep_research and the two searching literature tools.
 *
 * Admins are never blocked; every regular user is checked against their
 * four-window budget BEFORE any spend. Without this, /mcp would be an unmetered
 * bypass of the quota /api/chat applies. Returns the message to hand back, or
 * null when the caller may proceed.
 *
 * @param {Env} env
 * @param {Logger} log
 * @param {Identity} identity
 * @param {any} [config] the site config, when the caller already loaded it
 * @returns {Promise<string | null>}
 */
async function researchQuotaBlock(env, log, identity, config) {
  if (identity?.isSecretAdmin || identity?.role === "admin") return null;
  const [{ getUsage, quotaExceeded, effectiveQuota }, { getConfig }] = await Promise.all([
    import("./quota.js"),
    import("./config.js"),
  ]);
  const settings = config || (await getConfig(env));
  const quota = effectiveQuota(settings, identity?.user);
  if (!quota) return null;
  const usage = await getUsage(env, identity.id, Date.now(), identity?.user?.quota_reset_at);
  const blocked = quotaExceeded(usage, quota);
  if (!blocked) return null;
  log.info("mcp.quota_exceeded", { user_id: identity?.id, period: blocked.period, kind: blocked.kind });
  const when = `${new Date(blocked.reset_at).toISOString().slice(0, 16).replace("T", " ")} UTC`;
  return `Research quota exceeded (${blocked.period}). It resets at ${when}.`;
}

// ---------------------------------------------------------------------------
// The deep_research tool: mirrors src/chat.js's per-request setup (WITHOUT
// editing it) and runs the pipeline to completion, collecting the streamed
// answer into a single string.
//
// Every heavy dependency is dynamically imported HERE so the pure helpers
// above stay import-safe for the unit test.
// ---------------------------------------------------------------------------
/**
 * @param {Env} env
 * @param {Logger} log
 * @param {Identity} identity
 * @param {string} requestId
 * @param {{ time_budget_s: number, web_search: boolean, model: string | undefined }} args
 *   the EFFECTIVE arguments — the caller's, already reconciled with this
 *   account's defaults and override policy (src/mcp-config.js)
 * @param {string} question
 * @returns {Promise<string>} the answer text (with a Sources list appended)
 */
async function runDeepResearch(env, log, identity, requestId, args, question) {
  if (!env.BERGET_API_TOKEN) {
    throw new Error("Server not configured: BERGET_API_TOKEN secret is missing.");
  }

  const [
    { resolveModel, validateMessages },
    { clampBudget, planResearch },
    { adminDefaultModelValid, DEFAULT_MODEL },
    { listChatModels },
    { runPipeline },
    { getConfig },
    { recordUsage, recordModelUsage },
    { summarizeSpend, exaCost, spendByModel },
  ] = await Promise.all([
    import("./validation.js"),
    import("./budget.js"),
    import("./berget.js"),
    import("./providers.js"),
    import("./pipeline.js"),
    import("./config.js"),
    import("./quota.js"),
    import("./billing.js"),
  ]);

  // Minimal single-turn conversation — the same {role, content} shape chat.js
  // validates and forwards.
  /** @type {import('./types.js').Conversation} */
  const conversation = [{ role: "user", content: question }];
  const invalid = validateMessages(conversation);
  if (invalid) throw new Error(invalid);

  // Model resolution against the catalog (fail-soft: degrade to default if
  // unreachable) — mirrors chat.js.
  /** @type {import('./types.js').ModelCatalog | null} */
  let catalog = null;
  try {
    catalog = await listChatModels(env, identity);
  } catch (err) {
    log.warn("mcp.model_catalog_unavailable", { error: (/** @type {any} */ (err))?.message || String(err) });
  }
  const config = await getConfig(env);

  // `args.model` is the account's default or the caller's pick, whichever the
  // exposure config allowed; the admin default only fills in when neither said.
  const body = { messages: conversation, model: args.model || undefined };
  if (!body.model && adminDefaultModelValid(config, catalog)) body.model = config.default_model;
  const resolved = resolveModel(body, catalog, env, log);
  if ("error" in resolved) throw new Error(resolved.error);
  const model = resolved.model;
  const jsonModel = resolveJsonModel(catalog, model, DEFAULT_MODEL);

  // Budget: the effective value (already inside the tool schema's window),
  // clamped to the slider range then the site max — exactly chat.js's two-step
  // clamp, which is what stops an account default from outrunning a later
  // lowering of the site maximum.
  let budgetS = clampBudget(args.time_budget_s);
  budgetS = Math.min(budgetS, config.max_time_budget_s);
  const webSearch = args.web_search;

  // Research quota — the SAME gate /api/chat enforces (src/chat.js), through
  // the shared helper the literature tools also use. Admins are never blocked;
  // every regular user is checked against their four-window budget BEFORE any
  // spend. Without this, /mcp would be an unmetered bypass of the quota
  // /api/chat applies (each call runs the full pipeline for real Berget + Exa
  // money), and the spend would also be invisible to the usage bars and admin
  // cost totals — see the recordUsage below. The config is already loaded here,
  // so it is passed rather than read a second time.
  const blocked = await researchQuotaBlock(env, log, identity, config);
  if (blocked) throw new Error(blocked);

  const state = newRequestState(model, jsonModel, webSearch, budgetS, planResearch(model, budgetS, jsonModel));

  // Collect the pipeline's streamed text deltas (and honor discard_text, the
  // post-validation reset) into one string — the MCP result is non-streaming.
  const answer = { text: "" };
  /** @type {string | null} */
  let emittedError = null;
  /** @param {any} obj an SSE-event object (see types.d.ts's SseEvent) */
  const emit = (obj) => {
    const chunk = obj.choices?.[0]?.delta?.content;
    if (chunk) answer.text += chunk;
    else if (obj.status?.type === "discard_text") answer.text = "";
    else if (obj.error) emittedError = obj.error;
    // status step/search events are ignored — a v1 non-streaming result.
  };

  try {
    await runPipeline(env, log, emit, conversation, model, state);
  } finally {
    // Usage accounting for quotas — recorded even on a partial/failed run,
    // mirroring /api/chat (src/chat.js). Same split-billing math: each model
    // bucket (answer / JSON planning / vision) priced at its own catalog rate,
    // plus live searches at their depth-tier price and the /contents fetch
    // surcharge. Fails soft: a recording error never breaks the tool result.
    try {
      const { prompt_tokens, completion_tokens, berget_cost } = summarizeSpend(state, catalog);
      const billedSearches = Math.max(0, state.searchCount - (state.cachedSearchCount || 0));
      const exa_cost = exaCost(state, config, billedSearches);
      await recordUsage(env, log, {
        user_id: identity?.id,
        model,
        prompt_tokens,
        completion_tokens,
        searches: billedSearches,
        berget_cost,
        exa_cost,
        duration_ms: Date.now() - state.startedAt,
      });
      // Per-model attribution ledger, mirroring /api/chat — see recordModelUsage.
      await recordModelUsage(env, log, {
        user_id: identity?.id,
        request_id: requestId,
        by_model: spendByModel(state, catalog),
      });
    } catch (err) {
      log.warn("mcp.usage_record_failed", { error: (/** @type {any} */ (err))?.message || String(err) });
    }
  }

  log.info("mcp.complete", {
    user_id: identity?.id,
    model,
    json_model: jsonModel,
    rounds: state.iterations,
    searches: state.searchCount,
    sources: state.sources.length,
    request_id: requestId,
  });

  const finalText = answer.text.trim();
  if (!finalText) {
    // Nothing usable came back — surface the soft error if one was emitted.
    throw new Error(emittedError || "The pipeline produced no answer.");
  }
  // withSources lives in sources.js (the source-registry/formatting owner);
  // dynamic-imported like the other heavy-ish deps so mcp.test.js can load
  // this module without pulling the source/search graph.
  const { withSources } = await import("./sources.js");
  const result = withSources(finalText, state.sources);

  // Full-visibility interaction log (src/chatlog.js), same table as
  // /api/chat, channel 'mcp'. MCP has no ghost toggle — every tool call is
  // an explicit machine-to-machine request. Fails soft; dynamic import like
  // the other heavy deps above.
  const { recordChatLog } = await import("./chatlog.js");
  await recordChatLog(env, log, {
    request_id: requestId,
    user_id: String(identity?.id ?? ""),
    channel: "mcp",
    model,
    json_model: jsonModel,
    conversation,
    answer: result,
    status: emittedError ? "error" : "ok",
    error: emittedError,
    web_search: webSearch,
    budget_s: budgetS,
    rounds: state.iterations,
    searches: state.searchCount,
    sources: state.sources.length,
    prompt_tokens: state.totals.prompt_tokens + state.jsonTotals.prompt_tokens,
    completion_tokens: state.totals.completion_tokens + state.jsonTotals.completion_tokens,
    duration_ms: Date.now() - state.startedAt,
    meta: {
      queries: [...state.ranQueries],
      sources: state.sources.map((s) => ({ n: s.n, title: s.title, url: s.url })),
      complexity: state.complexity ?? null,
      subquestions: state.subquestions ?? [],
      cached_searches: state.cachedSearchCount || 0,
    },
  });

  return result;
}

// Per-request pipeline state — the same shape src/chat.js's newRequestState
// builds. This v1 MCP surface applies no per-user knobs, so every registered
// EXTENSION is off (emptyExtensionState — the registry's own "nothing
// enabled" bag, so this channel never needs updating when an extension is
// added or removed) and so is vision, which the pipeline treats exactly as a
// request with those knobs disabled.
/**
 * @param {string} model
 * @param {string} jsonModel
 * @param {boolean} webSearch
 * @param {number} budgetS
 * @param {import('./budget.js').BudgetPlan} plan
 * @returns {McpRequestState}
 */
function newRequestState(model, jsonModel, webSearch, budgetS, plan) {
  return {
    startedAt: Date.now(),
    model,
    jsonModel,
    webSearch,
    ext: emptyExtensionState(),
    // The MCP channel never enters introspection mode (no developer knob on
    // this channel) — the flag exists for the shared RequestState shape.
    introspection: false,
    introspectionCount: 0,
    vision: false,
    visionModel: null,
    visionModels: [],
    visionTotals: { prompt_tokens: 0, completion_tokens: 0 },
    imageLocations: [],
    // types.d.ts's RequestState documents `plan` against its own BudgetPlan
    // sketch; the live object is budget.js's richer one (see PipelineState).
    plan: /** @type {any} */ (plan),
    searchCount: 0,
    cachedSearchCount: 0,
    iterations: 1,
    ranQueries: new Set(),
    sources: [],
    byUrl: new Map(),
    totals: { prompt_tokens: 0, completion_tokens: 0 },
    jsonTotals: { prompt_tokens: 0, completion_tokens: 0 },
  };
}
