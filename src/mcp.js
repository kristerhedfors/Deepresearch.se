// POST /mcp — exposes the deep-research pipeline AS an MCP server so other
// agents (Claude, Cursor, any MCP client) can call it as a single tool.
//
// Transport: modern **Streamable HTTP** — JSON-RPC 2.0 over a single POST.
// The protocol surface is tiny, so it's hand-rolled (no dependency): the
// three methods a minimal server needs (`initialize`, `tools/list`,
// `tools/call`) plus a no-op ack for `notifications/initialized`.
//
// The route is wired in src/index.js AFTER the identity gate, so MCP inherits
// the SAME access control as the rest of the site (break-glass Basic Auth via
// header works; a signed-in session works too).
//
// FILE LAYOUT — deliberate, so src/mcp.test.js can unit-test the protocol
// without loading the pipeline: the PURE JSON-RPC helpers, envelope builders,
// tool schema, and initialize payload are exported at the TOP with no heavy
// imports. The single heavy import — the pipeline and its deps — is a DYNAMIC
// import() INSIDE the tools/call handler, so importing this module (as the
// test does) never pulls in pipeline.js/berget.js/etc.

import { jsonResponse } from "./http.js";

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

// The `tools/list` result: our one tool.
export function toolsListResult() {
  return { tools: [DEEP_RESEARCH_TOOL] };
}

// Build an MCP tools/call result envelope (text content + isError flag).
export function toolResult(text, isError = false) {
  return { content: [{ type: "text", text: String(text) }], isError: !!isError };
}

// JSON-RPC 2.0 success envelope. `id` of undefined normalizes to null
// (should not happen for a request, but keeps the envelope well-formed).
export function jsonRpcResult(id, result) {
  return { jsonrpc: "2.0", id: id === undefined ? null : id, result };
}

// JSON-RPC 2.0 error envelope.
export function jsonRpcError(id, code, message, data) {
  const error = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: "2.0", id: id === undefined ? null : id, error };
}

// Validate + shape a parsed JSON-RPC message. Returns
// { valid, id, method, params, isNotification } or { valid:false, id, error }.
// A message WITHOUT an `id` is a notification (no response is expected).
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

  switch (parsed.method) {
    case "initialize":
      return jsonResponse(jsonRpcResult(parsed.id, initializeResult()));
    case "tools/list":
      return jsonResponse(jsonRpcResult(parsed.id, toolsListResult()));
    case "tools/call":
      return handleToolCall(parsed, env, log, identity, ctx, requestId);
    default:
      return jsonResponse(
        jsonRpcError(parsed.id, RPC_METHOD_NOT_FOUND, `Method not found: ${parsed.method}`),
      );
  }
}

// tools/call dispatcher. Only `deep_research` exists; anything else is an
// invalid-params error. The tool itself fails soft: any pipeline error comes
// back as an MCP result with isError:true (a protocol-level success carrying
// a tool-level failure), never a transport error.
async function handleToolCall(parsed, env, log, identity, ctx, requestId) {
  const { id, params } = parsed;
  const name = params?.name;
  const args = params?.arguments && typeof params.arguments === "object" ? params.arguments : {};

  if (name !== TOOL_NAME) {
    return jsonResponse(jsonRpcError(id, RPC_INVALID_PARAMS, `Unknown tool: ${name ?? "(none)"}`));
  }

  const question = typeof args.question === "string" ? args.question.trim() : "";
  if (!question) {
    return jsonResponse(
      jsonRpcResult(id, toolResult("The `question` argument is required and must be a non-empty string.", true)),
    );
  }

  try {
    const text = await runDeepResearch(env, log, identity, requestId, args, question);
    return jsonResponse(jsonRpcResult(id, toolResult(text, false)));
  } catch (err) {
    const message = err?.message || String(err);
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
      web_search: args.web_search !== false,
    });
    return jsonResponse(jsonRpcResult(id, toolResult("Research failed: " + message, true)));
  }
}

// ---------------------------------------------------------------------------
// The deep_research tool: mirrors src/chat.js's per-request setup (WITHOUT
// editing it) and runs the pipeline to completion, collecting the streamed
// answer into a single string.
//
// Every heavy dependency is dynamically imported HERE so the pure helpers
// above stay import-safe for the unit test.
// ---------------------------------------------------------------------------
async function runDeepResearch(env, log, identity, requestId, args, question) {
  if (!env.BERGET_API_TOKEN) {
    throw new Error("Server not configured: BERGET_API_TOKEN secret is missing.");
  }

  const [
    { resolveModel, validateMessages },
    { clampBudget, planResearch, CONTENTS_COST_MULTIPLIER },
    { adminDefaultModelValid, DEFAULT_MODEL },
    { listChatModels },
    { runPipeline },
    { getConfig },
    { getUsage, quotaExceeded, effectiveQuota, recordUsage, bergetCost },
  ] = await Promise.all([
    import("./validation.js"),
    import("./budget.js"),
    import("./berget.js"),
    import("./providers.js"),
    import("./pipeline.js"),
    import("./config.js"),
    import("./quota.js"),
  ]);

  // Minimal single-turn conversation — the same {role, content} shape chat.js
  // validates and forwards.
  const conversation = [{ role: "user", content: question }];
  const invalid = validateMessages(conversation);
  if (invalid) throw new Error(invalid);

  // Model resolution against the catalog (fail-soft: degrade to default if
  // unreachable) — mirrors chat.js.
  let catalog = null;
  try {
    catalog = await listChatModels(env);
  } catch (err) {
    log.warn("mcp.model_catalog_unavailable", { error: err?.message || String(err) });
  }
  const config = await getConfig(env);

  const body = { messages: conversation, model: typeof args.model === "string" ? args.model : undefined };
  if (!body.model && adminDefaultModelValid(config, catalog)) body.model = config.default_model;
  const resolved = resolveModel(body, catalog, env, log);
  if (resolved.error) throw new Error(resolved.error);
  const model = resolved.model;
  const jsonModel = resolveJsonModel(catalog, model, DEFAULT_MODEL);

  // Budget: default 120s, clamped to the slider range then the site max —
  // exactly chat.js's two-step clamp.
  let budgetS = clampBudget(args.time_budget_s ?? 120);
  budgetS = Math.min(budgetS, config.max_time_budget_s);
  const webSearch = args.web_search !== false; // default on

  // Research quota — the SAME gate /api/chat enforces (src/chat.js). Admins
  // are never blocked; every regular user is checked against their four-window
  // budget BEFORE any spend. Without this, /mcp would be an unmetered bypass of
  // the quota /api/chat applies (each call runs the full pipeline for real
  // Berget + Exa money), and the spend would also be invisible to the usage
  // bars and admin cost totals — see the recordUsage below.
  const quota =
    identity?.isSecretAdmin || identity?.role === "admin"
      ? null
      : effectiveQuota(config, identity?.user);
  if (quota) {
    const usage = await getUsage(env, identity.id);
    const blocked = quotaExceeded(usage, quota);
    if (blocked) {
      log.info("mcp.quota_blocked", { user_id: identity?.id, period: blocked.period, kind: blocked.kind });
      const when = `${new Date(blocked.reset_at).toISOString().slice(0, 16).replace("T", " ")} UTC`;
      throw new Error(`Research quota exceeded (${blocked.period}). It resets at ${when}.`);
    }
  }

  const state = newRequestState(model, jsonModel, webSearch, budgetS, planResearch(model, budgetS, jsonModel));

  // Collect the pipeline's streamed text deltas (and honor discard_text, the
  // post-validation reset) into one string — the MCP result is non-streaming.
  const answer = { text: "" };
  let emittedError = null;
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
      let prompt_tokens = 0;
      let completion_tokens = 0;
      let berget_cost = 0;
      for (const [modelId, totals] of [
        [state.model, state.totals],
        [state.jsonModel, state.jsonTotals],
        [state.visionModel, state.visionTotals],
      ]) {
        prompt_tokens += totals.prompt_tokens;
        completion_tokens += totals.completion_tokens;
        berget_cost += bergetCost(catalog?.find((m) => m.id === modelId), totals.prompt_tokens, totals.completion_tokens);
      }
      const billedSearches = Math.max(0, state.searchCount - (state.cachedSearchCount || 0));
      const exa_cost =
        billedSearches * config.exa_cost_per_search_eur * (state.plan.searchDepth?.costMultiplier || 1) +
        (state.fetchedUrls?.size || 0) * config.exa_cost_per_search_eur * CONTENTS_COST_MULTIPLIER;
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
    } catch (err) {
      log.warn("mcp.usage_record_failed", { error: err?.message || String(err) });
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

// Which model runs the JSON planning phases — replicated from chat.js's
// resolveJsonModel (kept inline so this module never has to import chat.js,
// which would pull the whole handler graph in). The reliable DEFAULT_MODEL
// unless it's explicitly down in the catalog, in which case fall back to the
// user's model. Catalog unreachable → optimistic (fail-soft).
function resolveJsonModel(catalog, userModel, DEFAULT_MODEL) {
  if (userModel === DEFAULT_MODEL) return DEFAULT_MODEL;
  if (!Array.isArray(catalog)) return DEFAULT_MODEL;
  const entry = catalog.find((m) => m.id === DEFAULT_MODEL);
  if (!entry) return userModel;
  return entry.up === false ? userModel : DEFAULT_MODEL;
}

// The synthesis prompt already appends its own "Sources:" list, so only add a
// structured one when the answer text doesn't already carry it — guarantees
// an MCP consumer always gets the source list without double-printing it.
function withSources(text, sources) {
  if (!sources?.length) return text;
  if (/(^|\n)\s*sources\s*:/i.test(text)) return text;
  const list = sources.map((s) => `[${s.n}] ${s.title} — ${s.url}`).join("\n");
  return `${text}\n\nSources:\n${list}`;
}

// Per-request pipeline state — the same shape src/chat.js's newRequestState
// builds. The opt-in enrichments (Shodan / Google Maps / vision) are left off
// for this v1 MCP surface (no per-user knobs are applied), which the pipeline
// treats exactly as a request with those knobs disabled.
function newRequestState(model, jsonModel, webSearch, budgetS, plan) {
  return {
    startedAt: Date.now(),
    model,
    jsonModel,
    webSearch,
    shodan: false,
    shodanCount: 0,
    googleMaps: false,
    mapsCount: 0,
    vision: false,
    visionModel: null,
    visionModels: [],
    visionTotals: { prompt_tokens: 0, completion_tokens: 0 },
    imageLocations: [],
    streetViewPov: null,
    plan,
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
