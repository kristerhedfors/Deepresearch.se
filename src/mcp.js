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
// WHAT IT COSTS is bounded twice, and both bounds are the ones /api/chat
// already applies: the four-window research QUOTA (researchQuotaBlock) and the
// per-user CONCURRENCY reservation (SPENDING_TOOL_NAMES + reserveToolSlot).
// Both are scoped to the tools that reach a provider; both refuse inside the
// JSON-RPC envelope rather than at the transport.
//
// FILE LAYOUT — deliberate, so src/mcp.test.js can unit-test the protocol
// without loading the pipeline: the PURE JSON-RPC helpers, envelope builders,
// tool schema, and initialize payload are exported at the TOP with no heavy
// imports. The single heavy import — the pipeline and its deps — is a DYNAMIC
// import() INSIDE the tools/call handler, so importing this module (as the
// test does) never pulls in pipeline.js/berget.js/etc.

import { emptyExtensionState, resolveExtensionState } from "./extensions.js";
import { jsonResponse } from "./http.js";
// A leaf module (imports nothing), so this static import does NOT pull the
// pipeline graph in — the file-layout rule above (heavy deps stay dynamic) is
// preserved. Shares the split-model-routing decision with src/chat.js.
import { resolveJsonModel, resolveVisionModels } from "./model-routing.js";
// The MODERN (stateless) revision — protocol 2026-07-28, served beside the
// handshake revision below. Pure, imports nothing (src/mcp-modern.js).
import {
  DISCOVER_METHOD,
  LEGACY_PROTOCOL_VERSION,
  MODERN_PROTOCOL_VERSION,
  TOOLS_LIST_TTL_MS,
  completeResult,
  discoverResult,
  forbiddenOrigin,
  isModernRequest,
  validateModernRequest,
} from "./mcp-modern.js";
// The EXTENSION tool families (street imagery, host intelligence): their
// schemas only. This module names no third-party service — src/extension-tools.js
// is the registry that does, exactly as src/extensions.js is for the enrichment
// seam (invariant 7), and the runners live behind its dynamic loader.
import {
  EXTENSION_MCP_TOOLS,
  EXTENSION_SPENDING_TOOLS,
  EXTENSION_TOOL_EXTENSION,
  EXTENSION_TOOL_NAMES,
  extensionOffMessage,
} from "./extension-tools.js";
// The LITERATURE family: the two hosted scientific corpora (arXiv, PubMed) as
// directly searchable knowledge bases. Only the SCHEMAS are imported here —
// src/literature-tools.js imports nothing at all, so the file-layout rule holds;
// everything that touches a Vectorize binding or the embedder lives in
// src/literature-run.js, loaded by a dynamic import in the dispatch below.
import {
  LITERATURE_TOOLS,
  LITERATURE_TOOL_NAMES,
  OPENAI_ADAPTER_TOOLS,
  OPENAI_ADAPTER_TOOL_NAMES,
} from "./literature-tools.js";
// WHAT this server exposes is per-account configuration (Settings → "MCP
// server"). A pure leaf module — catalog, parse, filter, argument resolution —
// so this static import keeps the file-layout rule above intact.
import {
  defaultMcpConfig,
  filterMcpTools,
  parseMcpConfig,
  resolveIntrospectArgs,
  resolveResearchArgs,
  toolExposed,
} from "./mcp-config.js";
// The PLATFORM family: asking this server about ITSELF. Schemas and lens notes
// only — src/platform-tools.js imports nothing, so the file-layout rule holds.
// `platform_map` reads committed artifacts through the ASSETS binding, so its
// runner (src/platform-tools-run.js) arrives by dynamic import in the dispatch
// below; the two answering tools need no runner at all, because they ARE
// deep_research with the introspection agent forced and a lens on the question.
import {
  PLATFORM_ANSWERING_TOOLS,
  PLATFORM_MCP_TOOLS,
  PLATFORM_SPENDING_TOOLS,
  PLATFORM_TOOL_NAMES,
  lensQuestion,
  readPlatformQuestion,
} from "./platform-tools.js";
// The FEEDBACK tool — the one WRITE this surface serves. Pure module statically,
// runner (src/feedback-tools-run.js, which reaches D1) by dynamic import in the
// dispatch below, the same shape as platform_map.
import { FEEDBACK_MCP_TOOLS, FEEDBACK_TOOL_NAMES } from "./feedback-tools.js";
// Shaping an answer for a listener rather than a reader (pure, imports nothing).
import { VOICE_NOTE, spokenAnswer } from "./voice-answer.js";

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

// The protocol revision `initialize` reports back — the HANDSHAKE era, which
// this server keeps speaking for every client that has not moved yet. The
// stateless 2026-07-28 revision is served in parallel and selected per request
// (src/mcp-modern.js); neither is a mode the server is "in", because a stateless
// protocol has nothing to be in.
export const PROTOCOL_VERSION = LEGACY_PROTOCOL_VERSION;

// WHY serverInfo CARRIES ICONS. A client that is handed no icon draws one, and
// what it draws is the first letter of `name` on a colour hashed from it — the
// reported "D on a green background". Nothing about that is a broken asset:
// every icon this site ships serves 200, and the connector had simply never
// been told any of them existed.
//
// `icons` and `websiteUrl` are the SEP-973 fields, formalized in protocol
// revision 2025-11-25. We still report `2025-06-18` (bumping that is a much
// larger change — see the stateless-revision section of the mcp-server skill),
// and that is fine here: an unknown field in `serverInfo` is ignored by a
// client that predates it, so this costs nothing on the old revision and works
// the moment a client reads it. Absolute URLs on the apex, not the `mcp.` host
// — the icons live with the site, and a client fetches them unauthenticated
// (which is what the root-icon allowlist in src/assets.js now guarantees).
//
// Some clients ignore it regardless and keep their own placeholder; ChatGPT's
// connector dialog also has an icon field a person can paste a URL into. This
// is the half we control.
export const SERVER_INFO = {
  name: "deepresearch.se",
  title: "DeepResearch.se",
  version: "1.0.0",
  websiteUrl: "https://deepresearch.se",
  icons: [
    { src: "https://deepresearch.se/icons/icon-192.png", mimeType: "image/png", sizes: ["192x192"] },
    { src: "https://deepresearch.se/icons/icon-512.png", mimeType: "image/png", sizes: ["512x512"] },
  ],
};

// What this server is for, in one paragraph a client MAY show its user or hand
// its model. `server/discover` carries it; the handshake era has no field for
// it, which is one of the small things the new revision fixes.
export const SERVER_INSTRUCTIONS =
  "DeepResearch.se runs deep research as a tool: a planned, searched, gap-checked and " +
  "validated answer built only from sources it found (deep_research), direct semantic " +
  "search over hosted arXiv and PubMed indexes (literature_*), questions about this " +
  "platform's own implementation answered from its deployed source (explain_internals, " +
  "improvement_areas, platform_map), and — when the account " +
  "enables them — street-level imagery described in words and internet host intelligence. " +
  "Every answering tool takes a plain question; nothing here needs a browser.";

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
    "questions that benefit from current, multi-source web research. Set " +
    "`style: \"voice\"` when the answer will be SPOKEN: it comes back as plain " +
    "prose with no markdown, no citation numbers and the sources named in a " +
    "closing sentence. `agent` picks the specialist that answers.",
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
      agent: {
        type: "string",
        description:
          "Which specialist agent answers. Each brings its own policy, prompts " +
          "and sources: `scholar` (Deep Science — the peer-reviewed literature " +
          "leads, arXiv + PubMed + Europe PMC; the default), `cyber` " +
          "(cybersecurity and OSINT — host intelligence, street imagery, entity " +
          "and person research, the OWASP corpus), `palaeogenomics` (ancient DNA " +
          "— the published-individuals corpus plus the life-science literature), " +
          "`introspection` (this site's own source and documentation), " +
          "`outrospection` (how this site is seen from outside), `models` (the " +
          "model catalog). Omit for the default. An agent this account may not " +
          "use, or one that does not exist, falls back to the default rather " +
          "than failing the call.",
      },
      style: {
        type: "string",
        enum: ["text", "voice"],
        description:
          "Shape of the answer. `text` (default) returns markdown with inline " +
          "[n] citations and a Sources list. `voice` returns speakable prose: no " +
          "markdown, no bracketed citation markers, no URLs, sources named in a " +
          "closing sentence — for a caller that will read the answer aloud. " +
          "`voice` also lowers the default time budget, because a spoken " +
          "exchange cannot wait two minutes.",
        default: "text",
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

// THE SDK MANIFEST TOOLS ARE GONE (2026-08-15, owner directive). `sdk_list_modules`,
// `sdk_show_module`, `sdk_plan` and `sdk_validate` shipped on this surface on
// 2026-07-18 so an external agent could plan against the Platform SDK without
// shelling into the execution sandbox. They are removed because the surface is
// now shaped for VOICE callers, and a manifest-planning tool is the clearest
// case of a tool a voice caller can never use: its answers are file trees and
// dependency orders, read from a terminal, with a build to run afterwards.
// Nothing is lost — `node sdk/pair-cli.mjs list|show|plan|validate` is the same
// pure core, and Agent Studio drives it in-app.
//
// The precedent this follows is the six-tool browser family deleted on
// 2026-08-02: a tool earns its place here when a caller WITHOUT the app needs
// the answer. Deleting one is cheap; keeping one nothing calls is not.

// The literature family, same rename. These are the only tools here that reach
// a data store rather than committed data, which is why their runner is loaded
// dynamically even though their definitions are static.
export const LITERATURE_MCP_TOOLS = LITERATURE_TOOLS.map(({ name, description, input_schema }) => ({
  name,
  description,
  inputSchema: input_schema,
}));

// The two ADAPTER tools, named `search` and `fetch` because ChatGPT refuses to
// connect to a server without them (docs/MCP-CONNECTOR.md §2a). Same rename,
// plus `outputSchema`: MCP pairs a declared output schema with the
// `structuredContent` these two return, and a client that knows the shape in
// advance is one that cannot mis-read the result.
export const OPENAI_MCP_TOOLS = OPENAI_ADAPTER_TOOLS.map(({ name, description, input_schema, output_schema }) => ({
  name,
  description,
  inputSchema: input_schema,
  outputSchema: output_schema,
}));

// Every tool this server CAN serve, in a stable order. What a given caller
// actually sees is this list filtered by the account's exposure config —
// src/mcp-config.js's catalog mirrors it exactly, a correspondence its unit
// test enforces, so no tool can ship without a switch to turn it off.
//
// The literature family sits directly behind deep_research because the two are
// the same capability at different grain: deep_research answers a question,
// literature_* hands an agent the corpus to answer it from. A client scanning
// the list top-down should meet them together — and the two adapters follow
// them, next to the tools they project.
// The EXTENSION families come last: they are the only tools here that reach a
// third party on the caller's behalf, and they are the only ones an account can
// be unable to use for a second reason (the per-account knob, not just the
// exposure switch). Their definitions arrive from the registry, so this list
// gains and loses tools without this file learning any service's name.
// The PLATFORM family sits after the corpora and before the extensions: it is a
// question about this server rather than about the world, so it does not belong
// among the outward-looking tools, and it reaches no third party, so it does not
// belong among the ones an account can be unable to use for a second reason.
export const ALL_MCP_TOOLS = [
  DEEP_RESEARCH_TOOL,
  ...LITERATURE_MCP_TOOLS,
  ...OPENAI_MCP_TOOLS,
  ...PLATFORM_MCP_TOOLS,
  // FEEDBACK sits beside the platform family for the same reason: it is about
  // this server rather than the world. It is last of the inward-looking tools
  // because it is the only one that WRITES, and a reader of this list should
  // see that boundary rather than have to infer it.
  ...FEEDBACK_MCP_TOOLS,
  ...EXTENSION_MCP_TOOLS,
];

// ---------------------------------------------------------------------------
// The SPENDING set — which tools hold a concurrency slot (P-3, 2026-08-05)
// ---------------------------------------------------------------------------
//
// src/quota.js's reservation exists because the quota gate is check-then-act: a
// request's spend is recorded only when it FINISHES, so N concurrent calls all
// read the same pre-spend usage, all pass, and overspend by ~N×. /api/chat,
// /api/embed, /api/quiz/grade and /api/bash/step have taken a reservation since
// 2026-07-12; this endpoint had not, and it is the one an EXTERNAL bearer key
// drives — no browser, no rate limiter in front of it (docs/MCP-COST.md §4b).
//
// Only the tools that reach a PROVIDER take a slot, and the line is exactly the
// one the quota gate already draws:
//
//   deep_research      the expensive, long-running one (€0.62 at its analytic
//                      ceiling) and the reason this matters at all
//   literature_search  \  the reranker legs — 50 candidates × 900 chars per
//   literature_similar  ) (angle × corpus) — which is the whole cost of the
//   search              /  family; `search` is literature_search projected into
//                          ChatGPT's shape, so it is gated identically or the
//                          adapter becomes the way around the meter
//
// …and every EXTENSION tool, because each one reaches a metered third-party API
// (imagery, places, host records) and, for the ones that describe an image, a
// vision model on top. The registry says which those are, so this file does not
// have to know what any of them talk to.
//
// Everything else is deliberately EXEMPT, because a slot it held would be pure
// denial of service against the caller's own next call: literature_corpora
// answers from committed facts plus describe(), and literature_fetch / fetch are
// key reads. None of them contacts a provider, so none of them can participate
// in the race the cap exists to bound — and an agent whose budget is gone should
// still be able to resolve an id it was handed while another call is in flight.
export const SPENDING_TOOL_NAMES = new Set([
  TOOL_NAME,
  "literature_search",
  "literature_similar",
  "search",
  // The two answering platform tools run the pipeline, so they cost exactly what
  // deep_research costs and are bounded exactly the same way. `platform_map`
  // stays out: it reads committed artifacts of this deploy, and a slot held
  // there could only deny the caller its own next call.
  ...PLATFORM_SPENDING_TOOLS,
  ...EXTENSION_SPENDING_TOOLS,
]);

// The refusal an over-cap caller gets. It is NOT quota.js's inflightLimitResponse:
// that builds an HTTP 429 payload, which is right for /api/chat and wrong here —
// an MCP client reads the JSON-RPC envelope, and a bare 429 reads to it as a
// transport failure (a broken server) rather than as a condition its model can
// act on. So the refusal travels the same way a quota refusal already does, as
// an isError tool result inside a normal JSON-RPC success, worded for the LLM
// caller that will read it: what happened, what to do, and why an immediate
// retry is pointless. Cost figures stay out of it for the same reason
// inflightLimitResponse's doc comment gives — a rate limit is not the place to
// leak what the site pays.
/**
 * @param {{ limit: number, active: number }} limited
 * @returns {string}
 */
export function inflightLimitToolMessage(limited) {
  return (
    `This account already has ${limited.limit} research requests running at once, ` +
    `which is the limit for concurrent calls. Wait for one of them to finish before ` +
    `calling again — retrying straight away will be refused the same way.`
  );
}

// The refusal when the quota gate cannot REACH a decision — an errored D1 while
// reading the site config or the caller's usage windows. The gate fails CLOSED
// (the reasoning is above QUOTA_UNAVAILABLE_STATUS in quota.js), and this is
// how that lands on this surface: a tool result with isError, exactly like the
// quota-exceeded refusal and the concurrency one, never an HTTP 5xx and never
// an escaped throw. Worded so the client's model does the right thing: it says
// the condition is temporary and NOT a limit on the account, because "Research
// quota exceeded" and "quota unreadable" call for opposite next moves — one
// means stop for the day, the other means try again shortly.
/** @returns {string} */
export function quotaUnavailableToolMessage() {
  return (
    "Research quota can't be checked right now — the usage store is temporarily " +
    "unavailable, so this call was not run. This is not a limit on the account and " +
    "nothing was spent. Wait a minute and try the call again."
  );
}

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

// The same envelope for a tool that declares an `outputSchema`: the payload
// travels TWICE — once as `structuredContent`, once as the JSON text of the
// content array. Both, not either. MCP's own spec says a tool with an output
// schema SHOULD also serialize the result into `content` for clients that only
// read text, and ChatGPT's connector contract requires exactly that pair
// (docs/MCP-CONNECTOR.md §2a). The text is passed in rather than re-serialized
// here so the two are the same bytes the runner produced.
/**
 * @param {unknown} text the payload, already serialized
 * @param {unknown} structuredContent the same payload as an object
 * @param {boolean} [isError]
 */
export function structuredToolResult(text, structuredContent, isError = false) {
  return { content: [{ type: "text", text: String(text) }], structuredContent, isError: !!isError };
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

// ---------------------------------------------------------------------------
// PROGRESS over SSE — why a long tool call must say something while it works
// ---------------------------------------------------------------------------
//
// `deep_research` runs for as long as its time budget allows: 120 s by default
// and up to 600 s. Until 2026-08-13 the whole of that was ONE buffered JSON
// response — zero bytes on the wire from the POST until the pipeline finished.
// Observed on 2026-08-13 (Workers Logs, host mcp.deepresearch.se): a voice
// session's two calls ran 86.5 s and 50.5 s, both completed `ok` server-side,
// and the connector immediately tore the connection down and re-`initialize`d
// — the signature of a client that gave up while the server was still working.
// Nothing was logged as an error here because nothing failed here; the failure
// was entirely on the caller's side of a silent connection.
//
// The transport already allows the fix. Streamable HTTP lets the server answer
// a POSTed request with `text/event-stream` instead of `application/json`, send
// notifications "before sending the JSON-RPC response", and close the stream
// after the response (spec 2025-06-18, Transports §"Sending Messages to the
// Server" 5–6). And progress notifications are what a client uses to know work
// is happening: the spec's timeout rule says an implementation MAY reset its
// timeout clock on a progress notification for that request, "as this implies
// that work is actually happening". So a research call that reports a phase
// every few seconds stops looking like a hung server.
//
// Two things travel on that stream and they are not the same thing:
//   * SSE COMMENT keepalives (`: keepalive`) — the same trick /api/chat uses,
//     ignored by every SSE client, which keep the CONNECTION from idling out
//     in a proxy. Sent whether or not the client asked for progress.
//   * `notifications/progress` — sent only when the client supplied a
//     `progressToken`, because the spec forbids referencing a token that was
//     never provided. This is the half a client's timeout can read.
//
// A client that does NOT accept text/event-stream keeps the old buffered JSON
// response byte for byte. Nothing about the tool dispatch, the envelopes, or
// the results changes — this is a transport wrapper, and every existing test
// of the JSON path still describes what those clients get.

// How often the stream says something. Well under the shortest client timeout
// worth designing for (60 s), and far enough apart that a 600 s research call
// sends tens of notifications rather than hundreds — the spec asks both sides
// to rate-limit, and a progress flood is its own kind of broken.
export const PROGRESS_INTERVAL_MS = 10_000;

// Does this client accept an SSE response? The spec REQUIRES a client to send
// `Accept: application/json, text/event-stream` on every POST, so in practice
// this is true — but a header we did not check is a promise we did not verify,
// and answering SSE to a client that only reads JSON would break it outright.
/**
 * @param {string | null | undefined} accept the request's Accept header
 * @returns {boolean}
 */
export function acceptsEventStream(accept) {
  return typeof accept === "string" && accept.toLowerCase().includes("text/event-stream");
}

// The progress token from a request's `params._meta.progressToken`, or null.
// MUST be a string or integer per the spec; anything else is not a token we may
// echo, so it degrades to "no progress notifications" rather than to a guess.
/**
 * @param {any} params the JSON-RPC params object
 * @returns {string | number | null}
 */
export function progressTokenOf(params) {
  const token = params?._meta?.progressToken;
  if (typeof token === "string" && token) return token;
  if (typeof token === "number" && Number.isFinite(token)) return token;
  return null;
}

// A `notifications/progress` message. `progress` MUST increase with every
// notification for the same token — we count elapsed seconds, which does.
/**
 * @param {string | number} token
 * @param {number} progress
 * @param {number | null} total
 * @param {string} [message]
 */
export function progressNotification(token, progress, total, message) {
  /** @type {{ progressToken: string | number, progress: number, total?: number, message?: string }} */
  const params = { progressToken: token, progress };
  if (typeof total === "number" && Number.isFinite(total)) params.total = total;
  if (message) params.message = message;
  return { jsonrpc: "2.0", method: "notifications/progress", params };
}

// One SSE frame carrying a JSON-RPC message.
/** @param {unknown} message */
export function sseFrame(message) {
  return `data: ${JSON.stringify(message)}\n\n`;
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
  // The transport's first security rule, and here it is not about DNS rebinding
  // but about this endpoint's two doors: an external agent arrives with a bearer
  // credential, a browser tab arrives with the site's session cookie. Only the
  // second can be driven by someone else's page, and only a cross-site Origin
  // identifies it. See forbiddenOrigin (src/mcp-modern.js) for why the check is
  // this narrow rather than an allowlist.
  const bearer = !!request.headers.get("authorization");
  const origin = request.headers.get("origin");
  if (forbiddenOrigin(origin, new URL(request.url).hostname, bearer)) {
    log.warn("mcp.origin_refused", { origin });
    return jsonResponse(
      jsonRpcError(null, RPC_INVALID_REQUEST, "Forbidden: cross-site request to the MCP endpoint."),
      403,
    );
  }

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

  // WHICH ERA this request belongs to, decided per request because a stateless
  // protocol leaves nothing to decide it once (src/mcp-modern.js isModernRequest).
  // A modern request is held to the modern rules — required `_meta`, a version we
  // implement, and the three mirrored headers agreeing with the body — and every
  // failure of those is answered with the code and HTTP status the revision
  // assigns it, because clients BRANCH on exactly those to tell a modern server
  // from a legacy one.
  const modern = isModernRequest(parsed, request.headers);
  if (modern) {
    const bad = validateModernRequest(parsed, request.headers);
    if (bad) {
      log.info("mcp.protocol_refused", { code: bad.code, method: parsed.method });
      // A notification gets no JSON-RPC response body, but it does get the HTTP
      // status: "If the server cannot accept it, it MUST return an HTTP error
      // status code … The body MAY comprise a JSON-RPC error response that has
      // no id."
      const id = parsed.isNotification ? null : parsed.id;
      return jsonResponse(jsonRpcError(id, bad.code, bad.message, bad.data), bad.status);
    }
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
    // The mandatory modern RPC: supported versions, capabilities and identity in
    // one request, so a client need not probe three listing methods to learn
    // what this server is. It is a MODERN method, so a call that omits the
    // required `_meta` was already refused above with -32602 — a recognized
    // modern error, which is what a probing client needs in order to conclude
    // "modern server, fix the request" rather than "legacy server".
    case DISCOVER_METHOD:
      return jsonResponse(
        jsonRpcResult(
          parsed.id,
          discoverResult(SERVER_INFO, { tools: {} }, SERVER_INSTRUCTIONS),
        ),
      );
    case "initialize":
      return jsonResponse(jsonRpcResult(parsed.id, mcpResult(initializeResult())));
    case "tools/list":
      // The one listing this server has, and it is per-account (the exposure
      // config filters it), which is what makes its cache scope private.
      return jsonResponse(
        jsonRpcResult(
          parsed.id,
          mcpResult(toolsListResult(config), { ttlMs: TOOLS_LIST_TTL_MS, cacheScope: "private" }),
        ),
      );
    case "tools/call": {
      // The ONE method that can run for minutes, and so the one that needs to
      // say something while it does (see the PROGRESS section above). Every
      // other method answers in milliseconds and stays plain JSON.
      const progress = newProgressSink();
      const run = () => handleToolCall(parsed, env, log, identity, ctx, requestId, config, progress);
      if (!acceptsEventStream(request.headers.get("accept"))) return run();
      return streamToolCall(run, progressTokenOf(parsed.params), progress, log);
    }
    default:
      // 404, not 400, and only for a MODERN caller: "If the server does not
      // implement the requested RPC method, it MUST respond with 404 Not Found
      // and a JSON-RPC error with code -32601", precisely so a client can tell
      // this apart from a plain 404 at a host that serves no MCP endpoint at
      // all. A legacy caller keeps the 200 it has always had, because that
      // revision never asked for anything else.
      return jsonResponse(
        jsonRpcError(parsed.id, RPC_METHOD_NOT_FOUND, `Method not found: ${parsed.method}`),
        modern ? 404 : 200,
      );
  }
}

/**
 * Stamp a result with `resultType` (and, for a listing, its caching hints) plus
 * this server's identity in `_meta` — the fields every 2026-07-28 result
 * carries. Applied on BOTH eras: they are additive, a legacy client ignores
 * them, and one result shape is one thing to test.
 * @param {any} result
 * @param {{ ttlMs?: number, cacheScope?: "public"|"private" }} [cache]
 */
function mcpResult(result, cache) {
  return completeResult(result, SERVER_INFO, cache);
}

/**
 * The running phase label a progress notification reports. A plain mutable
 * holder rather than a callback chain: the pipeline writes the label it just
 * started, the SSE ticker reads whatever is there when it fires. Nothing
 * depends on the two being in step, which is the point — a tool that never
 * writes a label still gets keepalives and elapsed-time progress.
 *
 * @typedef {{ label: string, note: (label: string) => void }} ProgressSink
 * @returns {ProgressSink}
 */
function newProgressSink() {
  const sink = {
    label: "",
    /** @param {string} label */
    note(label) {
      if (typeof label === "string" && label) sink.label = label;
    },
  };
  return sink;
}

/**
 * Run a tool call and answer it as an SSE stream: keepalives and (when the
 * client supplied a token) progress notifications while it works, then the
 * JSON-RPC response as the last frame, then close.
 *
 * The dispatch is untouched — `run` is exactly the handler the JSON path calls,
 * and its Response is unwrapped and re-emitted. So a tool-level failure, a
 * quota refusal and a concurrency refusal all reach the caller through this
 * stream in the same envelope they always had.
 *
 * @param {() => Promise<Response>} run the buffered tool-call handler
 * @param {string | number | null} token the caller's progressToken, if any
 * @param {ProgressSink} progress
 * @param {Logger} log
 * @returns {Response}
 */
function streamToolCall(run, token, progress, log) {
  const encoder = new TextEncoder();
  const started = Date.now();
  const stream = new ReadableStream({
    start(controller) {
      let closed = false;
      /** @param {string} text */
      const write = (text) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(text));
        } catch {
          // The client went away mid-stream. Stop writing; the run itself is
          // left to finish, exactly as /api/chat leaves a disconnected
          // pipeline running — the spend is mostly committed by now, and the
          // chat-log row and usage accounting still want the real result.
          closed = true;
        }
      };

      let ticks = 0;
      const timer = setInterval(() => {
        // The comment line keeps the CONNECTION alive for clients and proxies
        // that count idle bytes; the notification keeps the client's REQUEST
        // timeout alive. They are different mechanisms and both are wanted.
        write(": keepalive\n\n");
        ticks += 1;
        if (token === null) return;
        const elapsed = Math.round((Date.now() - started) / 1000);
        // `progress` must increase every time, so it counts ticks rather than
        // seconds — two notifications inside the same second would otherwise
        // repeat a value. No `total`: the time budget bounds the research, not
        // the call, and reporting a total the run can legitimately overshoot
        // would draw a progress bar that stalls at 100%.
        write(sseFrame(progressNotification(token, ticks, null, progressMessage(progress.label, elapsed))));
      }, PROGRESS_INTERVAL_MS);

      const finish = async () => {
        try {
          const response = await run();
          write(sseFrame(await response.json()));
        } catch (err) {
          // handleToolCall answers its own failures as isError results, so
          // reaching here means something outside the dispatch threw. The
          // stream is already open and a client waiting on it would hang
          // forever, so the response must be an error envelope, not silence.
          const message = (/** @type {any} */ (err))?.message || String(err);
          log.error("mcp.stream_failed", { error: message });
          write(sseFrame(jsonRpcError(null, RPC_INTERNAL_ERROR, `Internal error: ${message}`)));
        } finally {
          clearInterval(timer);
          if (!closed) {
            closed = true;
            try {
              controller.close();
            } catch {
              /* already closed by the client leaving */
            }
          }
        }
      };
      finish();
    },
    cancel() {
      // The client closed the stream. Nothing to unwind here: the interval is
      // cleared by finish()'s `finally`, and enqueue failures already flip the
      // writer off.
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}

// The human-readable half of a progress notification. The phase label when the
// pipeline has reported one, elapsed seconds either way — an agent reading this
// aloud in a voice session should hear something true about what is happening,
// not a spinner.
/**
 * @param {string} label
 * @param {number} elapsedS
 * @returns {string}
 */
export function progressMessage(label, elapsedS) {
  return label ? `${label} (${elapsedS}s)` : `Researching… (${elapsedS}s)`;
}

// tools/call: take a concurrency reservation for the tools that spend real
// money, run the dispatch, and RELEASE the slot on every exit path.
//
// Mirrors src/chat.js's use of the same reservation. Two differences, both
// deliberate:
//
//   * the release is a plain `finally` rather than one kept alive by
//     ctx.waitUntil — this handler returns a single buffered response, so
//     nothing continues after it the way /api/chat's stream does;
//   * a refusal is a JSON-RPC result, not an HTTP 429 (see
//     inflightLimitToolMessage above);
//   * the slot is taken BEFORE the quota gate rather than after it, because on
//     this surface the gate lives inside each tool's own branch. Nothing is
//     lost by the swap and something is gained: a flood of over-quota calls is
//     bounded too, so the D1 reads the gate itself performs are capped at 5 in
//     flight rather than at however many connections a client opened.
//
// ADMINS ARE NOT EXEMPT, and that is the one place this diverges from the quota
// gate a few lines down, which does exempt them. The two limits are different
// kinds of thing: the quota is a SPEND cap, and an operator who is trusted to
// spend without a budget is exactly who should be able to run an expensive
// diagnostic call. The concurrency cap is ABUSE MITIGATION — it bounds the
// check-then-act race and what a single leaked credential can drive in parallel
// — and an admin key is the credential whose leak matters most, not least.
// /api/chat reserves for every identity for the same reason (src/chat.js takes
// the reservation unconditionally, after the quota gate has already let the
// admin through), and CAP=5 concurrent research calls constrains no honest
// operator. Exempting admins here would leave the site's most privileged
// credential the only unbounded one on the surface an external key drives.
/**
 * @param {ParsedRpc} parsed
 * @param {Env} env
 * @param {Logger} log
 * @param {Identity} identity
 * @param {ExecutionContext} ctx
 * @param {string} requestId
 * @param {import('./mcp-config.js').McpConfig} config this account's exposure config
 * @param {ProgressSink} [progress] where a long run reports the phase it is in
 */
async function handleToolCall(parsed, env, log, identity, ctx, requestId, config, progress) {
  const name = parsed.params?.name;
  // A tool this account does not expose, or one that contacts no provider,
  // takes no slot: dispatchToolCall refuses the former as unknown, and holding
  // a slot for the latter would only deny the caller its own next call.
  const spends = typeof name === "string" && SPENDING_TOOL_NAMES.has(name) && toolExposed(config, name);
  if (!spends) return dispatchToolCall(parsed, env, log, identity, ctx, requestId, config, progress);

  const reserved = await reserveToolSlot(env, log, identity, requestId);
  if (!reserved.ok) {
    log.info("mcp.rate_limited", {
      tool: name,
      user_id: identity?.id,
      active: reserved.active,
      limit: reserved.limit,
    });
    return jsonResponse(jsonRpcResult(parsed.id, mcpResult(toolResult(inflightLimitToolMessage(reserved), true))));
  }
  try {
    return await dispatchToolCall(parsed, env, log, identity, ctx, requestId, config, progress);
  } finally {
    // EVERY exit path — a returned result, a tool-level failure, a thrown
    // error, an aborted request. A leaked slot is a self-inflicted denial of
    // service that only clears when INFLIGHT_TTL_MS ages the row out, so this
    // must never be conditional. releaseInflight swallows its own errors.
    await reserved.release();
  }
}

/**
 * Reserve one in-flight slot, fail-soft in every direction. quota.js is reached
 * by a dynamic import for the same reason researchQuotaBlock reaches it that
 * way: the file-layout rule at the top of this module keeps src/mcp.test.js
 * loading without the pipeline graph, and quota.js pulls berget.js in.
 *
 * Invariant 2: a D1 problem — or an import that somehow fails — degrades to
 * "allowed, holding nothing". reserveInflight already fails open on any D1
 * error; this wrapper extends that to the import itself, so no infrastructure
 * failure can turn into a blocked caller or a 500.
 *
 * @param {Env} env
 * @param {Logger} log
 * @param {Identity} identity
 * @param {string} requestId the reservation key — unique per HTTP request, and
 *   one MCP request carries exactly one tool call
 * @returns {Promise<{ ok: true, release: () => Promise<void> } | { ok: false, limit: number, active: number }>}
 */
async function reserveToolSlot(env, log, identity, requestId) {
  const noop = async () => {};
  /** @type {typeof import('./quota.js')} */
  let quota;
  try {
    quota = await import("./quota.js");
  } catch (err) {
    log.warn("mcp.inflight_unavailable", { error: (/** @type {any} */ (err))?.message || String(err) });
    return { ok: true, release: noop };
  }
  const reserved = await quota.reserveInflight(env, identity?.id, requestId);
  if (!reserved.ok) return reserved;
  // A degraded reservation holds no row, so there is nothing to release.
  if (reserved.degraded) return { ok: true, release: noop };
  return { ok: true, release: () => quota.releaseInflight(env, requestId) };
}

// The dispatcher proper, in branch order: the extension families, the literature
// family and its two `search`/`fetch` adapters, the free platform tool
// `platform_map`, then `deep_research` — which the two ANSWERING platform tools
// reach as well, falling through with their arguments forced rather than taking a
// runner of their own;
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
 * @param {ProgressSink} [progress] where a long run reports the phase it is in
 */
async function dispatchToolCall(parsed, env, log, identity, ctx, requestId, config, progress) {
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

  // The EXTENSION tools. Two gates, ANDed, and they mean different things — the
  // same pair the enrichment seam applies (src/extensions.js): the account's
  // exposure switch decides whether the tool exists on this surface at all
  // (already enforced above), and the account's per-extension KNOB decides
  // whether this site may reach that third party on their behalf. The knob is
  // consent, default OFF, and a tool call is not a way around it.
  //
  // Nothing here names the service. The registry resolves a tool to its
  // extension id, settings.js answers whether that id is on, and the runner
  // arrives behind a dynamic import — so this branch reads the same whether the
  // registry holds two integrations or none.
  if (typeof name === "string" && EXTENSION_TOOL_NAMES.has(name)) {
    try {
      const extensionId = EXTENSION_TOOL_EXTENSION[name];
      const { extensionEnabled } = await import("./settings.js");
      if (!extensionEnabled(env, identity, extensionId)) {
        log.info("mcp.extension_tool_off", { tool: name, extension: extensionId, user_id: identity?.id });
        return jsonResponse(jsonRpcResult(id, mcpResult(toolResult(extensionOffMessage(name), true))));
      }
      if (EXTENSION_SPENDING_TOOLS.has(name)) {
        const blocked = await researchQuotaBlock(env, log, identity);
        if (blocked) {
          log.info("mcp.quota_blocked", { tool: name, user_id: identity?.id });
          return jsonResponse(jsonRpcResult(id, mcpResult(toolResult(blocked, true))));
        }
      }
      const { runExtensionTool } = await import("./extension-tools-run.js");
      const result = await runExtensionTool(env, log, name, args, { identity, requestId });
      log.info("mcp.extension_tool", {
        tool: name,
        extension: extensionId,
        user_id: identity?.id,
        request_id: requestId,
        found: result.found,
      });
      return jsonResponse(jsonRpcResult(id, mcpResult(toolResult(result.text, result.isError))));
    } catch (err) {
      const message = (/** @type {any} */ (err))?.message || String(err);
      log.error("mcp.extension_tool_failed", { tool: name, error: message });
      return jsonResponse(jsonRpcResult(id, mcpResult(toolResult(`Lookup failed: ${message}`, true))));
    }
  }

  // The literature family — plus the two `search`/`fetch` adapters that project
  // it into the shapes ChatGPT requires (docs/MCP-CONNECTOR.md §2a), which run
  // the same retrieval and so belong on the same branch and the same gate.
  //
  // Unlike the two families above these reach a data store and spend
  // real (small) provider money, so the SEARCHING tools sit behind the same
  // research quota /api/chat and deep_research enforce — an exhausted account
  // must not be able to keep hammering the index from a long-lived key.
  // literature_corpora, literature_fetch and `fetch` are deliberately outside
  // the gate: one reads committed facts plus an index description, the others
  // are a direct key read, and an agent that has run out of budget should still
  // be able to learn what exists and resolve an id it was handed. `search`
  // retrieves, so it is gated exactly like literature_search — the adapter is a
  // projection, never a way around the meter.
  if (typeof name === "string" && (LITERATURE_TOOL_NAMES.has(name) || OPENAI_ADAPTER_TOOL_NAMES.has(name))) {
    try {
      if (name === "literature_search" || name === "literature_similar" || name === "search") {
        const blocked = await researchQuotaBlock(env, log, identity);
        if (blocked) {
          log.info("mcp.quota_blocked", { tool: name, user_id: identity?.id });
          return jsonResponse(jsonRpcResult(id, mcpResult(toolResult(blocked, true))));
        }
      }
      const { runLiteratureTool } = await import("./literature-run.js");
      // The identity travels with the call so the runner can RECORD what it
      // spent, not just be refused when the account has already overspent. A
      // gate without a meter cannot bite: these tools were checked against the
      // four-window quota from the start and never incremented it, so a key
      // that only called them was unbounded (docs/MCP-COST.md §4b).
      const result = await runLiteratureTool(env, log, name, args, { identity, requestId });
      log.info("mcp.literature_tool", {
        tool: name,
        user_id: identity?.id,
        queries: result.queries,
        records: result.records,
        request_id: requestId,
      });
      // The adapters declare an outputSchema, so their payload goes back both
      // ways; the native literature tools stay text-only, which is what every
      // client already reads them as.
      return jsonResponse(
        jsonRpcResult(
          id,
          mcpResult(
            result.structured
              ? structuredToolResult(result.text, result.payload, result.isError)
              : toolResult(result.text, result.isError),
          ),
        ),
      );
    } catch (err) {
      const message = (/** @type {any} */ (err))?.message || String(err);
      log.error("mcp.literature_tool_failed", { tool: name, error: message });
      // Text-only even for the adapters, and that is correct: MCP requires
      // structuredContent from a tool with an outputSchema EXCEPT on an error
      // result. The runners answer their own failures inside the declared shape
      // (an empty `results`, a named miss); this branch is the one nothing
      // planned for, and inventing a document to describe it would be worse.
      return jsonResponse(jsonRpcResult(id, mcpResult(toolResult(`Literature tool failed: ${message}`, true))));
    }
  }

  // The PLATFORM family — this server asked about itself. Two shapes on one
  // branch, because they share everything except where the work happens.
  //
  // `platform_map` is free: committed artifacts, no provider, no quota, so it
  // answers here and returns. The two answering tools fall THROUGH to
  // deep_research's own path below with their arguments already forced — the
  // introspection agent, no web search, and the lens folded into the question.
  // That is the whole implementation, and it is deliberate: they are the
  // research pipeline pointed at this codebase, so giving them a runner of their
  // own would have meant a second copy of the quota gate, the billing, the
  // progress plumbing and the chat_logs write — four things that must not be
  // able to disagree with the ones deep_research uses.
  if (typeof name === "string" && PLATFORM_TOOL_NAMES.has(name) && !PLATFORM_ANSWERING_TOOLS.has(name)) {
    try {
      const { runPlatformTool } = await import("./platform-tools-run.js");
      const result = await runPlatformTool(env, log, name, args);
      log.info("mcp.platform_tool", {
        tool: name,
        user_id: identity?.id,
        request_id: requestId,
        areas: result.areas,
      });
      return jsonResponse(jsonRpcResult(id, mcpResult(toolResult(result.text, result.isError))));
    } catch (err) {
      const message = (/** @type {any} */ (err))?.message || String(err);
      log.error("mcp.platform_tool_failed", { tool: name, error: message });
      // Named by the TOOL rather than hardcoded to the map: this branch is
      // generic over the free platform tools, and it is right today only because
      // there is one of them.
      return jsonResponse(jsonRpcResult(id, mcpResult(toolResult(`The ${name} tool failed: ${message}`, true))));
    }
  }

  // FEEDBACK — the one write. Free, so it sits here beside the other free tool
  // rather than below the quota gate, and it takes `billing` only for the
  // IDENTITY: a report is filed against an account, and the runner refuses
  // rather than guessing when there is not one.
  if (typeof name === "string" && FEEDBACK_TOOL_NAMES.has(name)) {
    try {
      const { runFeedbackTool } = await import("./feedback-tools-run.js");
      const result = await runFeedbackTool(env, log, name, args, { identity, requestId });
      return jsonResponse(jsonRpcResult(id, mcpResult(toolResult(result.text, result.isError))));
    } catch (err) {
      const message = (/** @type {any} */ (err))?.message || String(err);
      log.error("mcp.feedback_tool_failed", { tool: name, error: message });
      // Says plainly that nothing was stored. A reporter who believes a failed
      // report was filed stops reporting, which costs more than the failure.
      return jsonResponse(
        jsonRpcResult(id, mcpResult(toolResult(`The ${name} tool failed and nothing was recorded: ${message}`, true))),
      );
    }
  }

  const answering = typeof name === "string" && PLATFORM_ANSWERING_TOOLS.has(name);
  if (!answering && name !== TOOL_NAME) {
    return jsonResponse(jsonRpcError(id, RPC_INVALID_PARAMS, `Unknown tool: ${name ?? "(none)"}`));
  }

  // A platform tool's missing `question` gets its own message rather than
  // deep_research's, because the two ask for different things and a caller told
  // to send a research question when it meant to ask about this server would
  // send the wrong one.
  if (answering) {
    const read = readPlatformQuestion(args);
    if (!read.ok) return jsonResponse(jsonRpcResult(id, mcpResult(toolResult(read.error, true))));
    const introspect = resolveIntrospectArgs(config, args);
    return runResearchToolCall(
      env,
      log,
      identity,
      requestId,
      id,
      name,
      introspect,
      lensQuestion(name, read.question),
      progress,
    );
  }

  const question = typeof args.question === "string" ? args.question.trim() : "";
  if (!question) {
    return jsonResponse(
      jsonRpcResult(id, mcpResult(toolResult("The `question` argument is required and must be a non-empty string.", true))),
    );
  }

  // The account's defaults and override policy decide the effective arguments:
  // what the caller sent wins only where the account allows it (src/mcp-config.js
  // resolveResearchArgs). Resolved here so the failure path below logs the run
  // that was actually attempted, not the run that was asked for.
  const research = resolveResearchArgs(config, args);
  return runResearchToolCall(env, log, identity, requestId, id, name, research, question, progress);
}

/**
 * Run one pipeline-backed tool call and turn it into a JSON-RPC result.
 *
 * Shared by `deep_research` and the two platform tools that answer by running
 * the same pipeline with the introspection agent forced. Extracted rather than
 * copied: the failure path writes a `chat_logs` row, and a second copy of that
 * is a second place for the interaction log to fall out of step with what
 * actually ran.
 *
 * @param {Env} env
 * @param {Logger} log
 * @param {Identity} identity
 * @param {string} requestId
 * @param {unknown} id the JSON-RPC request id
 * @param {string} name the tool name, for the log lines
 * @param {{ time_budget_s: number, web_search: boolean, model: string | undefined,
 *   agent: string, style: "text"|"voice", require_agent?: boolean }} args the EFFECTIVE arguments
 * @param {string} question the question as it will reach the model
 * @param {ProgressSink} [progress]
 * @returns {Promise<Response>}
 */
async function runResearchToolCall(env, log, identity, requestId, id, name, args, question, progress) {
  try {
    const text = await runDeepResearch(env, log, identity, requestId, args, question, progress);
    return jsonResponse(jsonRpcResult(id, mcpResult(toolResult(text, false))));
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
      web_search: args.web_search,
    });
    return jsonResponse(jsonRpcResult(id, mcpResult(toolResult("Research failed: " + message, true))));
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
 * FAILS CLOSED when it cannot decide. Every step below reaches D1 — the lazy
 * migration inside getDb, the config row, the usage windows — and any of them
 * can throw. Before 2026-08-05 that throw simply ESCAPED: it surfaced as
 * `Literature tool failed: d1 down` / `Research failed: d1 down`, which is a
 * refusal nobody chose, described in a way no caller can act on. Now the
 * failure is a decision, with its own message and its own log line. Why closed
 * rather than open — and why the concurrency reservation around this call
 * deliberately goes the other way — is written out above
 * QUOTA_UNAVAILABLE_STATUS in quota.js.
 *
 * @param {Env} env
 * @param {Logger} log
 * @param {Identity} identity
 * @param {{ config: any, ok: boolean }} [site] the site config, when the caller
 *   already loaded it (with whether that load actually reached the database)
 * @returns {Promise<string | null>}
 */
async function researchQuotaBlock(env, log, identity, site) {
  if (identity?.isSecretAdmin || identity?.role === "admin") return null;
  /** @type {typeof import('./quota.js')} */
  let quota;
  try {
    quota = await import("./quota.js");
  } catch (err) {
    // Not reachable in practice (a static sibling module), but the gate's
    // promise is that it always DECIDES: an unloadable meter is an unread one.
    log.warn("mcp.quota_unverifiable", { user_id: identity?.id, reason: "import", error: errText(err) });
    return quotaUnavailableToolMessage();
  }
  const settings = site || (await loadSiteConfig(env, log));
  if (!settings.ok) {
    log.warn("mcp.quota_unverifiable", { user_id: identity?.id, reason: "config" });
    return quotaUnavailableToolMessage();
  }
  const limits = quota.effectiveQuota(settings.config, identity?.user);
  // Nothing enforced anywhere → nothing to verify, and an unreadable usage
  // store cannot change an admission no limit would have refused.
  if (!limits || !quota.quotaEnforced(limits)) return null;
  /** @type {import('./quota.js').Usage} */
  let usage;
  try {
    usage = await quota.getUsage(env, identity.id, Date.now(), identity?.user?.quota_reset_at);
  } catch (err) {
    log.warn("mcp.quota_unverifiable", { user_id: identity?.id, reason: "usage", error: errText(err) });
    return quotaUnavailableToolMessage();
  }
  const blocked = quota.quotaExceeded(usage, limits);
  if (!blocked) return null;
  log.info("mcp.quota_exceeded", { user_id: identity?.id, period: blocked.period, kind: blocked.kind });
  const when = `${new Date(blocked.reset_at).toISOString().slice(0, 16).replace("T", " ")} UTC`;
  return `Research quota exceeded (${blocked.period}). It resets at ${when}.`;
}

/**
 * Load the site config, degrading to the SAME defaults config.js falls back to
 * when there is no database at all — but SAYING SO. The distinction is the
 * whole point: "this site has no D1" is a supported configuration whose
 * defaults are the real settings, while "D1 threw" means the real settings are
 * unknown, and the quota gate must not read the second as permission (an admin
 * may have lowered the limits the defaults would hand back).
 *
 * Dynamically imported like everything else heavy on this surface, so
 * src/mcp.test.js keeps loading the module without the pipeline graph.
 * @param {Env} env
 * @param {Logger} log
 * @returns {Promise<{ config: any, ok: boolean }>}
 */
async function loadSiteConfig(env, log) {
  const { DEFAULT_CONFIG, getConfig } = await import("./config.js");
  try {
    return { config: await getConfig(env), ok: true };
  } catch (err) {
    log.warn("mcp.config_unavailable", { error: errText(err) });
    return { config: structuredClone(DEFAULT_CONFIG), ok: false };
  }
}

/**
 * The message of a thrown value, however odd the throw.
 * @param {unknown} err
 * @returns {string}
 */
function errText(err) {
  return (/** @type {any} */ (err))?.message || String(err);
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
 * @param {{ time_budget_s: number, web_search: boolean, model: string | undefined,
 *   agent: string, style: "text"|"voice", require_agent?: boolean }} args
 *   the EFFECTIVE arguments — the caller's, already reconciled with this
 *   account's defaults and override policy (src/mcp-config.js). `require_agent`
 *   turns the agent's fail-soft miss into a refusal; see the guard below.
 * @param {string} question
 * @param {ProgressSink} [progress] the phase label an SSE progress
 *   notification reports; absent on the buffered JSON path, where nothing is
 *   listening
 * @returns {Promise<string>} the answer text (with a Sources list appended)
 */
async function runDeepResearch(env, log, identity, requestId, args, question, progress) {
  if (!env.BERGET_API_TOKEN) {
    throw new Error("Server not configured: BERGET_API_TOKEN secret is missing.");
  }

  const [
    { resolveModel, validateMessages },
    { clampBudget, planResearch },
    { adminDefaultModelValid, DEFAULT_MODEL },
    { listChatModels },
    { runPipeline },
    { recordUsage, recordModelUsage },
    { summarizeSpend, exaCost, spendByModel, denseSpend },
    { newRetrievalSpend },
  ] = await Promise.all([
    import("./validation.js"),
    import("./budget.js"),
    import("./berget.js"),
    import("./providers.js"),
    import("./pipeline.js"),
    import("./quota.js"),
    import("./billing.js"),
    import("./dense-rag.js"),
  ]);

  // Minimal single-turn conversation — the same {role, content} shape chat.js
  // validates and forwards. A VOICE call carries its rendering instruction on
  // the user turn, which is the only place a deterministic pipeline has to put
  // one (invariant 1 rules out a tool-driven detour, and the prompt sets belong
  // to the agent, not to the transport). It is appended, never substituted: the
  // caller's question reaches the model exactly as written.
  const voice = args.style === "voice";
  /** @type {import('./types.js').Conversation} */
  const conversation = [{ role: "user", content: voice ? question + VOICE_NOTE : question }];
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
  // Site settings, fail-soft in SHAPE and fail-closed in ADMISSION: a D1 error
  // here used to throw straight out of the tool as `Research failed: d1 down`.
  // The request can still be shaped against the defaults (model, budget clamp),
  // but `site.ok` travels to the quota gate below, which refuses rather than
  // authorize spend against limits it could not read.
  const site = await loadSiteConfig(env, log);
  const config = site.config;

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
  const blocked = await researchQuotaBlock(env, log, identity, site);
  // Thrown, then caught by dispatchToolCall into an isError tool result: the
  // refusal reaches the caller inside the JSON-RPC envelope either way. (The
  // literature branch returns its message directly, one frame closer.)
  if (blocked) throw new Error(blocked);

  // WHICH AGENT answers. Absent an `agent` argument nothing changes: the request
  // runs exactly as this channel always has, with no capability resolved. Named,
  // it goes through the SAME resolution chat.js uses — the registry, the account's
  // grant, the capability's own validation — so an MCP caller can reach a
  // specialist agent without this module learning what any of them do.
  const agentPick = await resolveMcpAgent(env, log, identity, args.agent);
  if (agentPick?.refused) throw new Error(agentPick.refused);

  // `require_agent` REFUSES where the default path degrades, and the asymmetry is
  // deliberate rather than an inconsistency to tidy away.
  //
  // resolveMcpAgent fails soft: an unreadable registry, a missing grant or an
  // unknown id all fall back to an agentless run (invariant 2 — a research call
  // the caller is paying for should not die because a capability could not be
  // read). For `deep_research` that degradation is honest, because the run still
  // searches the web and still answers from sources.
  //
  // For the PLATFORM tools it is not. Their grounding IS the agent: it is what
  // sets state.introspection, which is what makes the enrichment inject this
  // deployment's own source. Lose it and `web_search: false` is still forced —
  // so the run has no source, no search, and nothing but the model's weights,
  // and it answers "how does the gap check work" about this platform in
  // confident speakable prose with no marker that nothing was ever read. On a
  // voice call there is no Sources list to notice the absence in. That is the
  // exact failure this family was added to fix, arriving from inside it.
  if (args.require_agent && !agentPick?.introspection) {
    log.warn("mcp.platform_ungrounded", { user_id: identity?.id, agent: args.agent });
    throw new Error(
      "This deployment's own source is not available to answer from right now, so the answer " +
        "would be from memory rather than from the code — which on this tool is worse than no " +
        "answer. Nothing was spent. Try again shortly; if it persists, ask the site directly.",
    );
  }

  const state = newRequestState(
    model,
    jsonModel,
    webSearch,
    budgetS,
    planResearch(model, budgetS, jsonModel),
    newRetrievalSpend(),
    agentPick,
    // The describe-helper candidates, resolved from the same catalog through the
    // same leaf chat.js uses. Only an addressed agent needs them — an agentless
    // run reaches no imagery to describe — but without them an agent that CAN
    // reach imagery would fetch it and then say nothing about it, which is the
    // worst of both: billed, and silent.
    agentPick ? resolveVisionModels(catalog, model) : [],
  );

  // SOURCE-FIRST, for the platform tools only. runResearch normally hands a
  // dev-mode turn back to the web wave when the message asks for outside
  // material (externalSourceIntent) — right for a chat turn, and broken here,
  // because these tools force `web_search: false` and so there is no wave to be
  // handed back to: the turn falls to triage and answers from the injected
  // excerpts alone. And it is the CALLER'S phrasing that trips it, not the lens:
  // "how does your sandbox compare to Docker" is an ordinary thing to ask a
  // platform about itself and matches the comparison arm. Same flag shape as the
  // /help escape hatch beside it.
  if (args.require_agent) /** @type {any} */ (state).sourceFirst = true;

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
    // The step labels are the only part of the status vocabulary that leaves
    // this module, and only as the human sentence in a progress notification
    // ("Searching the web (35s)"). The RESULT is still non-streaming: no
    // partial answer text and no step/search events reach the caller.
    else if (progress && obj.status?.type === "step_start") progress.note(obj.status.label);
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
      // The search wave's hosted-index spend, priced from Berget's raw catalog
      // (billing.js denseSpend). Zero, and no catalog request, on a run that
      // touched no hosted index — which is every run before this existed.
      const dense = await denseSpend(env, log, state);
      await recordUsage(env, log, {
        user_id: identity?.id,
        model,
        prompt_tokens: prompt_tokens + dense.prompt_tokens,
        completion_tokens,
        searches: billedSearches,
        berget_cost: berget_cost + dense.berget_cost,
        exa_cost,
        duration_ms: Date.now() - state.startedAt,
      });
      // Per-model attribution ledger, mirroring /api/chat — see recordModelUsage.
      await recordModelUsage(env, log, {
        user_id: identity?.id,
        request_id: requestId,
        by_model: [...spendByModel(state, catalog), ...dense.by_model],
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
  // How the answer is TAILED, and the two are alternatives rather than layers.
  // The screen path appends the numbered Sources list withSources builds
  // (sources.js, the source-registry/formatting owner; dynamic-imported like the
  // other heavy-ish deps so mcp.test.js can load this module without pulling the
  // source/search graph). The voice path strips what a speech engine would
  // pronounce as itself and names the outlets in a closing sentence instead — a
  // numbered URL list is the single least speakable thing this pipeline
  // produces.
  const { withSources } = await import("./sources.js");
  const result = voice ? spokenAnswer(finalText, state.sources) : withSources(finalText, state.sources);

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
      // The MCP channel runs the same pipeline, so it inherits the same blind
      // spot the /api/chat row just closed (feedback #61): sources COLLECTED is
      // not sources the answer could read.
      digest_shown: /** @type {any} */ (state).digestShown,
      complexity: state.complexity ?? null,
      subquestions: state.subquestions ?? [],
      // Same two as the /api/chat row, for the same reason: this channel runs
      // the same synthesis and validation phases, so measuring the revise rate
      // on one channel only would measure the wrong population.
      citations: /** @type {any} */ (state).citations,
      validation: /** @type {any} */ (state).validation,
      cached_searches: state.cachedSearchCount || 0,
      named_urls: state.namedUrlCount || 0,
    },
  });

  return result;
}

// Per-request pipeline state — the same shape src/chat.js's newRequestState
// builds.
//
// WITHOUT an addressed agent this is what it always was: every registered
// EXTENSION off (emptyExtensionState — the registry's own "nothing enabled" bag,
// so this channel never needs updating when an extension is added or removed),
// no capability, no vision. That is the default, and it is deliberate: a client
// that has been calling deep_research for months must not have its answers
// change shape because this argument appeared.
//
// WITH one, three things arrive together and they are a set: the resolved
// capability (which sources and context blocks the agent may reach), its prompt
// set (the voice every phase speaks in), and the account's own extension knobs
// (its consent to reach the third parties the capability allows). Passing any
// two without the third produces a run that claims a capability it cannot
// exercise — which is the exact mismatch this channel already had, where the
// grounded capabilities note listed integrations the enrichment could never run.
/**
 * @param {string} model
 * @param {string} jsonModel
 * @param {boolean} webSearch
 * @param {number} budgetS
 * @param {import('./budget.js').BudgetPlan} plan
 * @param {import('./dense-rag.js').RetrievalSpend} denseTotals the request's
 *   dense-retrieval tally. Passed IN rather than constructed here because
 *   dense-rag.js pulls berget.js, and this module's static half must stay free
 *   of it (the file-layout rule at the top); runDeepResearch already has it
 *   from its dynamic-import block.
 * @param {McpAgentPick | null} [agent] the addressed agent, when one was named
 * @param {string[]} [visionModels] ranked describe-helper candidates, empty
 *   when nothing on this run can reach imagery
 * @returns {McpRequestState}
 */
function newRequestState(model, jsonModel, webSearch, budgetS, plan, denseTotals, agent, visionModels = []) {
  return {
    startedAt: Date.now(),
    model,
    jsonModel,
    webSearch,
    ext: agent?.ext || emptyExtensionState(),
    // The registry-resolved agent, or nothing. Every field here is read through
    // the narrowing accessors in agent-spec-core.js, so an agent can make its own
    // run smaller and can never make it larger.
    answerPhase: agent?.answerPhase || null,
    agentId: agent?.agentId || null,
    promptSet: agent?.promptSet || null,
    capability: agent?.capability || null,
    // Source-carrying agents (introspection) need the site's own source folded
    // in; every other agent leaves this off exactly as this channel always did.
    introspection: !!agent?.introspection,
    introspectionCount: 0,
    // `vision` is whether the ANSWER model takes images; it stays false because
    // this channel never attaches any. The HELPER list is separate and is what
    // an imagery enrichment actually needs.
    vision: false,
    visionModel: visionModels[0] || null,
    visionModels,
    visionTotals: { prompt_tokens: 0, completion_tokens: 0 },
    imageLocations: [],
    // types.d.ts's RequestState documents `plan` against its own BudgetPlan
    // sketch; the live object is budget.js's richer one (see PipelineState).
    plan: /** @type {any} */ (plan),
    searchCount: 0,
    cachedSearchCount: 0,
    namedUrlCount: 0,
    iterations: 1,
    ranQueries: new Set(),
    // Queries actually DISPATCHED, as opposed to ranQueries' planned set. The
    // two diverge whenever a wave's web leg stands down (knob off, or an aux
    // source leading), and only this one may be shown to the answer model.
    issuedQueries: new Set(),
    sources: [],
    byUrl: new Map(),
    totals: { prompt_tokens: 0, completion_tokens: 0 },
    jsonTotals: { prompt_tokens: 0, completion_tokens: 0 },
    // deep_research runs the SAME pipeline as /api/chat, so its search wave
    // reaches the same hosted arXiv/PubMed tiers and spends the same Berget
    // money. Same bucket, priced by the same billing.js denseSpend below.
    denseTotals,
  };
}

/**
 * A resolved agent, ready to be folded into the request state.
 * @typedef {{
 *   agentId: string,
 *   mode: string,
 *   capability: any,
 *   promptSet: string | null,
 *   answerPhase: string | null,
 *   introspection: boolean,
 *   ext: Record<string, any>,
 *   refused?: string,
 * }} McpAgentPick
 */

/**
 * The answer phases an MCP caller may address.
 *
 * `research` and `source-research` are the two that answer a question, and
 * `feed` (Outrospection) answers one from the outward feed — all three take a
 * question and return prose, which is the whole contract of this tool.
 *
 * `build` (Agent Studio) and `workflow` (Orchestrator) are deliberately NOT
 * here, and not because they would fail: they would work, and that is the
 * problem. One publishes a live application at a public URL and the other spawns
 * a team of sub-agents; both are long, expensive and side-effecting, and neither
 * belongs behind a single stateless tool call from a client whose user may be
 * talking to it hands-free. `direct` is excluded for a smaller reason — it is
 * not a research phase at all, and a caller wanting a plain model answer has
 * `web_search: false`.
 */
const MCP_AGENT_PHASES = new Set(["research", "source-research", "feed"]);

/**
 * Resolve the `agent` argument through the same chain a chat turn uses.
 *
 * Returns null when nothing was named (the unchanged default path), a pick when
 * one resolved, or `{ refused }` when the agent exists but may not be addressed
 * here — a refusal, unlike a miss, is worth saying out loud, because the caller
 * asked for something specific and silently answering as someone else would be
 * a lie about who spoke.
 *
 * Fail-soft everywhere else (invariant 2): an unreadable registry, a missing
 * grant, an unknown id — all degrade to the default agent-less run rather than
 * failing a research call the caller is paying for.
 *
 * @param {Env} env
 * @param {Logger} log
 * @param {Identity} identity
 * @param {string} [requested]
 * @returns {Promise<McpAgentPick | null>}
 */
async function resolveMcpAgent(env, log, identity, requested) {
  const named = typeof requested === "string" ? requested.trim() : "";
  if (!named) return null;
  try {
    const [{ loadAgentRegistry }, { resolveRequestAgent, resolvePromptSet }, settings, { modeCarriesSource }] =
      await Promise.all([
        import("./agent-registry.js"),
        import("./agent-spec.js"),
        import("./settings.js"),
        import("./chat-modes.js"),
      ]);
    // The SAME grant chat.js computes. `sandbox` is false by construction: the
    // sandbox is a browser VM, and there is no browser on this channel.
    const granted = { developer_mode: settings.chatModesAvailable(env, identity), sandbox: false };
    const registry = await loadAgentRegistry(env);
    const routed = resolveRequestAgent(registry, { agent: named }, granted, "");
    if (!routed) {
      log.info("mcp.agent_unresolved", { agent: named, user_id: identity?.id });
      return null;
    }
    const phase = String(routed.capability?.answerPhase || "research");
    if (!MCP_AGENT_PHASES.has(phase)) {
      return {
        agentId: "",
        mode: "",
        capability: null,
        promptSet: null,
        answerPhase: null,
        introspection: false,
        ext: emptyExtensionState(),
        refused:
          `The "${named}" agent is not available over this interface: it does not answer questions, it ` +
          `builds or orchestrates, and both are long side-effecting flows that need the app. Ask a research ` +
          `agent instead, or use the site directly.`,
      };
    }
    const mode = String(routed.mode || "");
    log.info("mcp.agent", { agent: routed.agent?.id, mode, phase, user_id: identity?.id });
    return {
      agentId: String(routed.agent?.id || ""),
      mode,
      capability: routed.capability ?? null,
      promptSet: resolvePromptSet(routed.agent),
      // Only an executor phase is dispatched on; `research` and `source-research`
      // stay null so the pipeline's own per-message decision keeps deciding,
      // exactly as it does for a chat turn (src/chat.js's answerPhase).
      answerPhase: phase === "feed" ? phase : null,
      introspection: modeCarriesSource(mode),
      // The account's own extension knobs, which is what lets an agent that
      // declares a third-party context block actually reach it. Both gates
      // still hold: the knob is consent, the capability is permission.
      ext: resolveExtensionState({}, settings.extensionEnabledMap(env, identity)),
    };
  } catch (err) {
    log.warn("mcp.agent_unavailable", { agent: named, error: errText(err) });
    return null;
  }
}
