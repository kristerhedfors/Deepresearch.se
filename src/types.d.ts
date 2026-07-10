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
// whose absence disables a feature (see src/settings.js, src/shodan.js,
// src/googlemaps.js) rather than breaking the request.
export interface Env {
  /** Static-assets binding (public/) — always present. */
  ASSETS: Fetcher;
  /** D1 database — optional; absent means break-glass-auth-only, no quotas. */
  DB?: D1Database;
  /** R2 bucket for cloud conversation/file/RAG storage (the server_history knob). */
  STORAGE?: R2Bucket;
  /** Vectorize index for server-side RAG retrieval. */
  RAG_INDEX?: VectorizeIndex;

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

  // Enrichment secrets — see src/shodan.js, src/googlemaps.js.
  SHODAN_API_KEY?: string;
  GOOGLE_MAPS_API_KEY?: string;
  /** Optional browser-exposed Embed-API key; defaults to GOOGLE_MAPS_API_KEY. */
  GOOGLE_MAPS_EMBED_KEY?: string;

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
}

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
 * A validated Street View point-of-view (src/validation.js) — where the user
 * has panned/moved the inline panorama to (body.street_view_pov), so a
 * follow-up can capture exactly the frame on their screen.
 */
export interface StreetViewPov {
  /** The panorama the user is standing in ("" when unknown). */
  panoId: string;
  lat: number;
  lng: number;
  /** Degrees clockwise from north, wrapped into [0, 360). */
  heading: number;
  /** Degrees up/down, clamped to [-90, 90]. */
  pitch: number;
  /** Field of view in degrees, clamped to Street View Static's [10, 120]. */
  fov: number;
}
/**
 * The mutable per-request object threaded through chat.js and pipeline.js.
 * Token usage is split three ways — `totals` (user's answer model),
 * `jsonTotals` (the fixed JSON model), `visionTotals` (the Street View
 * describe helper) — each billed at its own model's catalog rate.
 */
export interface RequestState {
  startedAt: number;
  /** The user's chosen answer/synthesis model. */
  model: string;
  /** The fixed reliable model the JSON planning phases run on. */
  jsonModel: string;
  webSearch: boolean;
  shodan: boolean;
  /** Hosts Shodan returned data for. */
  shodanCount: number;
  googleMaps: boolean;
  /** 1 when Google Maps data was folded in. */
  mapsCount: number;
  vision: boolean;
  /** Helper model to describe Street View for a non-vision answer model. */
  visionModel: string | null;
  /** Ranked describe-helper candidates (first = visionModel) for failover. */
  visionModels: string[];
  visionTotals: TokenTotals;
  imageLocations: ImageLocation[];
  /** The user's current panorama view, for the capture-what-they-see path. */
  streetViewPov: StreetViewPov | null;
  plan: BudgetPlan;
  searchCount: number;
  /** Searches served from the Exa result cache (not billed). */
  cachedSearchCount: number;
  /** Search waves that ran (initial + gap rounds). */
  iterations: number;
  /** Queries already issued this request, for in-request dedup. */
  ranQueries: Set<string>;
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
/** The effective per-account knob state parseSettings coerces to. */
export interface Settings {
  /** Cloud storage of history (default ON — explicit false opts out). */
  server_history: boolean;
  /** Shodan host-intelligence enrichment (default OFF — opt-in). */
  shodan_mcp: boolean;
  /** Google Maps / Street View enrichment (default OFF — opt-in). */
  google_maps: boolean;
  /** Per-reply feedback buttons + the account panel's Feedback view (default OFF — opt-in). */
  feedback_mode: boolean;
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
  /** Names the phase/service: plan|gap1…|synth|validate|geocode|shodan|maps. */
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
}
/** Google Maps resolved a Street-View-covered location for an inline embed. */
export interface StatusStreetViewEmbed {
  type: "streetview_embed";
  lat: number;
  lng: number;
}
/**
 * The snapped Street View frames the vision helper reasoned about, for the
 * client to render beside the answer (direction-labeled JPEG data URLs).
 * Bulky by design — the client strips the data URLs out of its research log.
 */
export interface StatusStreetViewFrames {
  type: "streetview_frames";
  query: string;
  /** Each frame carries a cardinal `dir` ("north") OR a free-form `label`
   * ("your current view" — the POV capture path). */
  frames: Array<{ dir: string; label?: string; url: string }>;
}
/** Post-validation rejected the draft: clear streamed text and keep waiting. */
export interface StatusDiscardText {
  type: "discard_text";
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
/** The discriminated union of every `status` event payload. */
export type SseStatus =
  | StatusStepStart
  | StatusStepDone
  | StatusSearchStart
  | StatusSearchDone
  | StatusStreetViewEmbed
  | StatusStreetViewFrames
  | StatusDiscardText
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
