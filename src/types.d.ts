// Shared, load-bearing types for the Worker, as JSDoc-importable
// declarations. tsconfig always includes this `.d.ts`; no `// @ts-check`
// opt-in is needed for it. Annotated `.js` files reference these from JSDoc
// via `@param {import('./types.js').Env} env` — the `.js` specifier resolves
// to this `.d.ts` under `moduleResolution: bundler`.
//
// This is a module (each type is `export`ed), not a set of ambient globals,
// so nothing here leaks into unannotated files — a file only sees these
// types when it explicitly imports them. The Cloudflare runtime globals it
// references (Fetcher, D1Database, R2Bucket, VectorizeIndex) come from
// `@cloudflare/workers-types` via tsconfig's `types`.
//
// It emits no runtime code and must never be imported at runtime. It doubles
// as machine-readable documentation of the SSE protocol (`SseEvent`) and the
// per-request `state` shape.

// ---- Worker bindings & secrets ---------------------------------------------
// The `env` object Cloudflare hands every request. Bindings (ASSETS, DB,
// STORAGE, RAG_INDEX) are declared by wrangler.toml; the rest are dashboard
// secrets/vars read as `env.NAME`. Optional because several are feature gates
// whose absence disables a feature (see src/settings.js and the extension
// registry src/extensions.js) rather than breaking the request.
export interface Env {
  /** Static-assets binding (public/) — always present. */
  ASSETS: Fetcher;
  /** D1 database — optional; absent means break-glass-auth-only, no quotas. */
  DB?: D1Database;
  /** R2 bucket for cloud conversation/file/RAG storage (implicit on Se/rver — no per-account knob). */
  STORAGE?: R2Bucket;
  /** Vectorize index for server-side RAG retrieval. */
  RAG_INDEX?: VectorizeIndex;
  /**
   * Durable Object namespace for the SERVER-SIDE execution environment — one
   * ephemeral Cloudflare Container per research session (src/exec-container.js).
   * OPTIONAL: the binding only exists where wrangler.toml declares the
   * container + DO block AND a deploy has carried it, because a binding whose
   * resource doesn't exist fails every deploy. Absent means the environment
   * reports itself unavailable and the Settings picker omits it.
   */
  EXEC_SANDBOX?: DurableObjectNamespace;
  /** Display-only: the instance type the health body reports, when set. */
  EXEC_INSTANCE_TYPE?: string;

  // Primary LLM provider (Berget) — see src/berget.js.
  BERGET_API_TOKEN?: string;
  BERGET_MODEL?: string;
  BERGET_EMBED_MODEL?: string;
  /** Test-only override pointing the Berget client at a mock. */
  BERGET_URL?: string;

  // Second LLM provider (Anthropic/Claude) — see src/anthropic.js. The key
  // gates the feature: absent, the claude-* models don't appear at all.
  ANTHROPIC_API_KEY?: string;
  /** Test-only override pointing the Anthropic client at a mock. */
  ANTHROPIC_URL?: string;

  // Third LLM provider (OpenAI/GPT) — see src/openai.js. Same key-gating
  // convention: absent, the gpt-* models don't appear at all.
  OPENAI_API_KEY?: string;
  /** Test-only override pointing the OpenAI client at a mock. */
  OPENAI_URL?: string;

  // Web search (Exa) — see src/exa.js.
  EXA_API_KEY?: string;

  // The peer-reviewed literature source (src/scholar.js). ALL THREE ARE
  // OPTIONAL and the source works with none of them set — Europe PMC's
  // peer-reviewed slice needs no key at all, which is what keeps the Deep
  // Science agent working on a bare deployment.
  //
  /** OpenAlex. Unkeyed it works until a small daily budget is spent and then
   * answers 429; on Cloudflare's shared egress that budget is effectively
   * always spent, so this is what makes the widest backend real in production. */
  OPENALEX_API_KEY?: string;
  /** A LICENSED Google Scholar search API (SerpApi's `google_scholar` engine).
   * Google publishes no Scholar API and robots-disallows /scholar, so this is
   * the only supported route to Scholar's own ranking. Absent, the leg is
   * simply off and the open backends carry the source. */
  SERPAPI_KEY?: string;
  /** Semantic Scholar. Unkeyed the Graph API answers 429 immediately, so the
   * backend is skipped rather than tried and failed. */
  SEMANTIC_SCHOLAR_API_KEY?: string;

  // Break-glass Basic Auth + session signing — see src/auth.js.
  ADMIN_USER?: string;
  ADMIN_PASS?: string;
  BASIC_AUTH_USER?: string;
  BASIC_AUTH_PASS?: string;
  SESSION_SECRET?: string;
  /** Derives the client's encrypted-history key — see src/history-key.js. */
  HISTORY_KEY_SECRET?: string;

  // Google OIDC sign-in — see src/google.js.
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  /** Test-only overrides pointing the OAuth flow at a mock. */
  GOOGLE_AUTH_URL?: string;
  GOOGLE_TOKEN_URL?: string;
  /** Plaintext dashboard var: the account that is granted the admin role. */
  ADMIN_EMAIL?: string;

  // EXTENSION secrets are NOT declared here. Which third-party services this
  // deployment can reach — and which secret each needs — is entirely
  // src/extensions.js's business (each descriptor names its own `secret`),
  // and the index signature below already admits any var, so an extension
  // can be added or dropped without touching the core Env shape.

  /** debug|info|warn|error (default info) — see src/log.js. */
  LOG_LEVEL?: string;

  // Forward-compatible: other string vars/secrets may be present.
  [key: string]: unknown;
}

// ---- Logger (src/log.js) ---------------------------------------------------
/** A single structured-log call: `event` plus a bag of metadata fields. */
export type LogFn = (event: string, fields?: Record<string, unknown>) => void;
export interface Logger {
  debug: LogFn;
  info: LogFn;
  warn: LogFn;
  error: LogFn;
}

// ---- Conversation / message shapes (src/conversation.js) -------------------
/** An OpenAI-style content part: a text span or an image data URL. */
export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };
/** Message content is a plain string or a multimodal array of parts. */
export type MessageContent = string | ContentPart[];
/** One turn in the OpenAI-style message array. */
export interface Message {
  role: "user" | "assistant" | "system";
  content: MessageContent;
}
/** The conversation is the message array `/api/chat` receives. */
export type Conversation = Message[];

// ---- Model catalog (src/providers.js) ---------------------------------------
/**
 * One entry of the chat-capable model catalog `/api/models` exposes and
 * validation/pricing consume (`listChatModels` — Berget's live catalog
 * merged with the key-gated secondary-provider entries). `price_in`/
 * `price_out` are raw EUR-per-token prices used for quota cost accounting.
 */
export interface ModelCatalogEntry {
  id: string;
  name: string;
  /** Human-readable pricing tooltip, or null when unpriced. */
  pricing: string | null;
  price_in: number;
  price_out: number;
  /** False when the provider reports the model down/in maintenance. */
  up: boolean;
  /** True when the model accepts image input. */
  vision: boolean;
  /** Which provider serves it ("anthropic" | "openai"); absent for Berget entries. */
  provider?: string;
}
export type ModelCatalog = ModelCatalogEntry[];

// ---- Per-model profile (src/model-profiles.js) -----------------------------
/** The five pipeline phase types the budget planner and EWMA track. */
export type PhaseName = "triage" | "search" | "gap" | "synth" | "validate";
/** Per-phase numeric map (durations in ms, or max_tokens), keyed by phase. */
export type PhaseDurations = Partial<Record<PhaseName, number>>;
/**
 * Evidence-driven per-model overrides layered over model-agnostic defaults.
 * `getModelProfile` returns a fully-populated object (DEFAULT merged with any
 * override), so scalar fields are always present; the nested lookup fields
 * are null when unset.
 */
export interface ModelProfile {
  /** Per-phase duration priors (ms), or null to fall back to global priors. */
  priorsMs: PhaseDurations | null;
  /** Splice a "JSON object only" reinforcement line into JSON-mode prompts. */
  jsonReinforcement: boolean;
  /** Per-phase max_tokens bump for completeJson calls, or null. */
  maxTokensOverride: PhaseDurations | null;
  /** Stop attempting the post-validation phase for this model. */
  skipValidation: boolean;
  /** Total attempts on a clean-but-empty completion (2 = one retry). */
  maxCompletionAttempts: number;
  /** Most images the model accepts per request at Berget, or null (no known limit). */
  maxImages: number | null;
}

// ---- Time-budget plan (src/budget.js) --------------------------------------
/** The Exa search-depth tier chosen for a budget (src/budget.js). */
export interface SearchDepth {
  /** Results requested per Exa search. */
  numResults: number;
  /** Exa search mode: "auto" or the thorough "deep" tier. */
  type: string;
  /** Exa price multiplier vs the standard tier, for honest cost accounting. */
  costMultiplier: number;
}
/** The static allocation `planResearch` returns for a request. */
export interface BudgetPlan {
  budgetMs: number;
  budgetS: number;
  /** Initial search angles to run. */
  queries: number;
  /** Gap-check rounds the budget affords. */
  gapIterations: number;
  /** Follow-up queries per gap round. */
  followups: number;
  /** Whether the post-validation quality gate is reserved. */
  validate: boolean;
  /** Hard cap on total searches across all rounds. */
  maxSearches: number;
  /** Cap on the numbered source registry. */
  maxSources: number;
  /** Char cap on the synthesis digest. */
  digestCap: number;
  /** Per-phase duration estimates the plan was built from. */
  estimates: Record<PhaseName, number>;
  searchDepth: SearchDepth;
  /** Output comprehensiveness tier the slider bought (src/budget.js reportTierFor). */
  reportTier: ReportTier;
  /** max_tokens for the synthesis stream, scaled to the report tier. */
  synthMaxTokens: number;
  /** max_tokens for validate/revise JSON calls (revised_answer holds the whole report). */
  validateMaxTokens: number;
}

/**
 * The slider-driven output-comprehensiveness tier: how structured and
 * comprehensive the delivered answer should be, from an annotated
 * search-results brief up to a full research report.
 */
export type ReportTier = "brief" | "standard" | "extended" | "full";

// ---- Per-request state (src/chat.js newRequestState) -----------------------
/** Prompt/completion token tally for one billing bucket. */
export interface TokenTotals {
  prompt_tokens: number;
  completion_tokens: number;
}
/** A numbered source in the registry synthesis cites from. */
export interface SourceEntry {
  n: number;
  title: string;
  url: string;
  highlights?: string[];
}
/** A validated attached-photo GPS coordinate (src/validation.js). */
export interface ImageLocation {
  name: string;
  lat: number;
  lon: number;
}
/**
 * The EXTENSION state bag: one namespaced slice per registered third-party
 * integration (src/extensions.js), keyed by extension id. Core code carries
 * it and never looks inside — each extension declares and owns the shape of
 * its own slice next to its runner (e.g. maps-enrichment.js `MapsSlice`,
 * shodan-enrichment.js `ShodanState`). That is the whole point of the cut:
 * this file describes the agent architecture, so no individual service's
 * vocabulary may appear in it.
 */
export type ExtensionState = Record<string, any>;
/**
 * The mutable per-request object threaded through chat.js and pipeline.js.
 * Token usage is split three ways — `totals` (user's answer model),
 * `jsonTotals` (the fixed JSON model), `visionTotals` (the image-describe
 * helper) — each billed at its own model's catalog rate, plus `denseTotals`
 * for the retrieval models the search wave spends on (not chat models, so
 * priced from Berget's raw catalog instead).
 */
export interface RequestState {
  startedAt: number;
  /** The user's chosen answer/synthesis model. */
  model: string;
  /** The fixed reliable model the JSON planning phases run on. */
  jsonModel: string;
  webSearch: boolean;
  /**
   * The user's picked web-search SOURCE for this request — who actually runs
   * the searches (the "Exa web search" settings knob): "exa", "cloudflare"
   * (this Worker does the searching itself), or "" for the site default.
   * Validated against websearch-backends.js USER_SEARCH_SOURCES before it gets
   * here, and ignored when the admin pinned the site-wide backend.
   */
  searchSource?: string;
  /** Per-extension state (src/extensions.js) — opaque to core. */
  ext: ExtensionState;
  /** Developer-mode gate for the introspection enrichment (src/introspect.js). */
  introspection: boolean;
  /** 1 when the source snapshot was actually folded into the conversation. */
  introspectionCount: number;
  /**
   * The deployed source snapshot the introspection enrichment loaded, stashed
   * so the pipeline's source-research phase can READ files from it (the agentic
   * read loop) without a second ASSETS fetch. Absent when dev mode is off or
   * the snapshot was unavailable.
   */
  sourceSnapshot?: import("../public/js/introspect-core.js").Snapshot | null;
  /** The chosen answer model can receive images. */
  vision: boolean;
  /** Helper model that describes imagery for a non-vision answer model. */
  visionModel: string | null;
  /** Ranked describe-helper candidates (first = visionModel) for failover. */
  visionModels: string[];
  visionTotals: TokenTotals;
  /**
   * The request's DENSE-RETRIEVAL provider spend, accumulated across every leg
   * of every search wave (src/dense-rag.js RetrievalSpend). A fourth bucket
   * rather than a fourth entry in the three above because it is not a chat
   * model: the cross-encoder and the embedder are absent from the chat catalog,
   * so pricing them needs Berget's raw catalog and is async — src/billing.js
   * denseSpend, folded into the same single usage row.
   */
  denseTotals: import("./dense-rag.js").RetrievalSpend;
  /** Validated GPS coordinates carried by the attached photos. */
  imageLocations: ImageLocation[];
  plan: BudgetPlan;
  searchCount: number;
  /** Searches served from the Exa result cache (not billed). */
  cachedSearchCount: number;
  /** Search waves that ran (initial + gap rounds). */
  iterations: number;
  /** Queries PLANNED this request, for in-request dedup. Written before the
   * wave picks its legs, so it also holds angles nothing was ever asked. */
  ranQueries: Set<string>;
  /** Queries actually DISPATCHED to a provider. The subset of ranQueries that
   * genuinely happened — the only one the answer model may be shown. */
  issuedQueries?: Set<string>;
  /** Numbered source registry, deduped by URL. */
  sources: SourceEntry[];
  /** URL -> registry entry, for dedup. */
  byUrl: Map<string, SourceEntry>;
  totals: TokenTotals;
  jsonTotals: TokenTotals;
}

// ---- Pipeline context (src/pipeline.js runPipeline) ------------------------
/**
 * The bundle `runPipeline` builds once and passes to every phase helper.
 * `emit` writes one SSE event; `step`/`stepDone` are its status-event
 * shorthands; `emitDelta` streams a text chunk.
 */
export interface PipelineCtx {
  env: Env;
  log: Logger;
  emit: (event: SseEvent) => void;
  model: string;
  jsonModel: string;
  state: RequestState;
  profile: ModelProfile;
  jsonProfile: ModelProfile;
  conversation: Conversation;
  reinforceJsonOnly: boolean;
  lastUser: string;
  convText: string;
  imageParts: ContentPart[];
  emitDelta: (text: string) => void;
  step: (id: string, label: string) => void;
  stepDone: (id: string, label: string, details?: string[]) => void;
}

// ---- Per-user settings (src/settings.js parseSettings) ---------------------
/**
 * The effective per-account setting state parseSettings coerces to: the core
 * knob and the picked chat mode below, plus one boolean per registered
 * EXTENSION whose key the registry owns (src/extensions.js) — which is why the
 * index signature is open and no service is named here.
 */
export interface Settings {
  /** The in-browser Linux execution sandbox + bash-lite agent (default OFF — opt-in). */
  bash_lite_mcp: boolean;
  /**
   * The account's picked chat mode — one of public/js/chat-mode-core.js
   * CHAT_MODES, default "normal". Replaced the `developer_mode` boolean knob
   * (2026-07-26): the mode is the unit that selects how a request is answered,
   * and everything else — the source enrichment, the answer phase, the theme —
   * is derived from it.
   */
  chat_mode: string;
  /** One per registered extension, e.g. `shodan_mcp`, `google_maps`. */
  [key: string]: boolean | string;
}

// ---- SSE protocol (/api/chat) ----------------------------------------------
// The wire vocabulary of the streaming endpoint. Clients MUST ignore unknown
// `status` types and unknown fields (forward compatibility), so this union is
// the spec, not an exhaustive closed set.

/** A source shown in an expandable search-result list. */
export interface SseSource {
  title: string;
  url: string;
}

/** Pipeline step spinner turned on. */
export interface StatusStepStart {
  type: "step_start";
  /** Names the phase or service: plan|gap1…|synth|validate|geocode, or a
   * registered extension's id (src/extensions.js). */
  id: string;
  label: string;
}
/** Pipeline step resolved to a checkmark; `details` renders as a list. */
export interface StatusStepDone {
  type: "step_done";
  id: string;
  label: string;
  details?: string[];
}
/** A web search began (may arrive un-paired before its search_done). */
export interface StatusSearchStart {
  type: "search_start";
  round: number;
  query: string;
  /**
   * Orchestrator mode only: the sub-agent whose plan this query came from, so
   * the workflow inspector can attribute it to that node.
   */
  agent?: string;
}
/** A web search finished; `sources` populates the expandable list. */
export interface StatusSearchDone {
  type: "search_done";
  round: number;
  query: string;
  results: number;
  duration_ms: number;
  sources: SseSource[];
  /** True when served from the Exa result cache (not billed). */
  cached?: boolean;
  /** Orchestrator mode only: the sub-agent that planned this query. */
  agent?: string;
}
/** Post-validation rejected the draft: clear streamed text and keep waiting. */
export interface StatusDiscardText {
  type: "discard_text";
}
/**
 * SDK mode published (or republished) this conversation's build
 * (src/pipeline.js runSdkBuild → src/build-pub.js). The client remembers
 * `slug` and sends it back as `build_slug` so an iteration keeps the same
 * live /app/<slug>/ URL; the link itself rides in the answer text.
 */
export interface StatusBuild {
  type: "build";
  slug: string;
  url: string;
  files: number;
  title: string;
}
/**
 * Orchestrator mode's resolved workflow plan (public/js/orchestrator-core.js
 * workflowEvent), emitted once before execution: the sub-agent nodes, their
 * dependency edges, and the resolved parallel waves. The client renders it as
 * the live workflow view (public/js/workflow-viz.js).
 */
export interface StatusWorkflow {
  type: "workflow";
  title: string;
  agents: Array<{
    id: string;
    kind: string;
    name: string;
    task: string;
    deps: string[];
    /** A custom specialist's one-line persona (shown in the node inspector). */
    persona?: string;
    /** A deep_research node's planned queries (shown before they run). */
    queries?: string[];
  }>;
  waves: string[][];
}
/**
 * One Orchestrator sub-agent's lifecycle change (orchestrator-core.js
 * agentUpdateEvent): running → done/failed (skipped reserved). `note` carries
 * a bounded failure reason; `duration_ms`/`chars` ride on completion.
 */
export interface StatusAgentUpdate {
  type: "agent_update";
  id: string;
  status: "pending" | "running" | "done" | "failed" | "skipped";
  note?: string;
  duration_ms?: number;
  chars?: number;
  /**
   * The prompt the node is actually working on, head-clamped to
   * MAX_PROMPT_PREVIEW, emitted as a second `running` update once the node's
   * grounding is assembled. The workflow inspector shows it live.
   */
  prompt?: string;
  /** The full prompt's length, so the inspector can say how much it is showing. */
  prompt_chars?: number;
}
/** Terminal stats footer. */
export interface StatusDone {
  type: "done";
  model: string;
  rounds: number;
  searches: number;
  duration_ms: number;
  prompt_tokens: number;
  completion_tokens: number;
  /** Additional fields may ride along; clients ignore unknown ones. */
  [key: string]: unknown;
}
/**
 * The discriminated union of every CORE `status` event payload.
 *
 * EXTENSIONS emit their own status types too (the Maps runner's
 * `streetview_embed` / `streetview_frames` / `map_embed`, declared next to it
 * in src/maps-enrichment.js). Those are deliberately NOT in this union: the
 * core has no business knowing an integration's wire vocabulary, and an
 * extension's runner types its own `emit` as an open record for exactly that
 * reason. Clients must ignore unknown `status` types anyway (the
 * forward-compatibility rule), so the wire stays additive either way — see
 * docs/ARCHITECTURE.md §4.4 and the sse-protocol skill for the full,
 * extensions-included vocabulary.
 */
export type SseStatus =
  | StatusStepStart
  | StatusStepDone
  | StatusSearchStart
  | StatusSearchDone
  | StatusDiscardText
  | StatusBuild
  | StatusWorkflow
  | StatusAgentUpdate
  | StatusDone;

/** An OpenAI-style text-delta chunk. */
export interface SseDelta {
  choices: Array<{ delta: { content?: string } }>;
}
/** A status event wrapper. */
export interface SseStatusEvent {
  status: SseStatus;
}
/** An error event, shown in the answer bubble. */
export interface SseError {
  error: string;
}
/**
 * Any event written to the `/api/chat` SSE stream: a text delta, a status
 * wrapper, or an error. (The literal `data: [DONE]` terminator is written as
 * a raw line, not an object, so it isn't part of this union.)
 */
export type SseEvent = SseDelta | SseStatusEvent | SseError;
