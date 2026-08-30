// @ts-check
// THE RESEARCH TOOLBOX — the tools a model selects from itself on the research
// path, as schemas and nothing else.
//
// This module is to the research loop what src/extension-tools.js is to the MCP
// surface, and it exists for the same hard reason: **a tool NAME is a service
// name.** `street_view_look` matches src/extensions.test.js's SERVICE_TOKENS
// (`/street[_ ]?view/i`), so a bare list of tool names inside a core module —
// src/pipeline.js, src/chat.js, src/enrichment.js — fails the core-purity guard
// on its own, with no import and no call. Invariant 7 is therefore held the way
// it already is for MCP: the orchestrator asks THIS registry which tools exist,
// which context block each one needs and which of them spend money, and never
// writes a service's name down itself.
//
// **Do not add this file to src/extensions.test.js's CORE_MODULES.** It is a
// registry module, not core; the guard's list is hand-written and adding this
// one would fail the build for doing exactly what it was built to do.
//
// PURE, like every schema module here. Nothing below reaches a network, a
// binding or an env: `src/research-tools-run.js` owns every execution path and
// is loaded behind a dynamic import so this half stays cheap to hold. The
// definitions are written in Anthropic's `{name, description, input_schema}`
// shape, which is this repository's one tool shape (src/tool-run.js translates
// at the wire, so a tool is never written twice).
//
// ---- what the DESCRIPTIONS are for ----------------------------------------
//
// They are the only instructions the model gets about a tool, and on this path
// they replace a deterministic phase that used to make the same decision. Two
// properties are load-bearing and both are learned:
//
//   · BATCH THE ANGLES. `web_search` and `literature_search` take several
//     queries per call and run them in parallel for the latency of one. A model
//     told nothing issues them one at a time and spends the whole budget on
//     round trips (the same latency lesson feedback #44 taught the wave path).
//   · AN EMPTY RESULT IS NOT A FAILURE. The retrieval layer distinguishes
//     "asked, nothing cleared the relevance floor" (`[]`) from "could not ask"
//     (`null`), and that distinction has to survive into WORDS or the model
//     reports absence of evidence for a floor miss. src/literature-tools.js
//     already wrote that sentence for the corpora — RETRIEVAL_NOTE — so it is
//     quoted here rather than paraphrased.

import { EXTENSION_MCP_TOOLS, EXTENSION_SPENDING_TOOLS, EXTENSION_TOOL_EXTENSION, EXTENSION_TOOL_FAMILIES } from "./extension-tools.js";
import { LITERATURE_TOOLS, RETRIEVAL_NOTE } from "./literature-tools.js";
import { SEARCH_SOURCES } from "./search-sources.js";

/** @typedef {{ name: string, description: string, input_schema: any }} ToolDef */

// ---------------------------------------------------------------------------
// Bounds. Every one is about what a single model-issued CALL may cost, not
// about what the subsystem underneath can serve — the per-request ceilings stay
// where they were (plan.maxSearches, a source's own maxPerRequest), and
// src/tool-admission.js is what enforces both against a call.
// ---------------------------------------------------------------------------

/** Queries per web_search call. They run in parallel, so this is a fan-out
 * bound: four angles cost one angle's latency and four angles' money. */
export const MAX_WEB_QUERIES = 4;
/** URLs per read_pages call, matching MAX_NAMED_URLS' reasoning in
 * src/named-urls.js: a pasted wall of links must not become an unbounded
 * fan-out on the user's wall clock. */
export const MAX_READ_URLS = 4;
/** Rows one ancient_samples call may return. The corpus block itself shows 30
 * (BLOCK_ROWS); a model asking for the tail can have more, bounded. */
export const MAX_SAMPLE_ROWS = 100;

// ---------------------------------------------------------------------------
// (A) + (B) the open web
// ---------------------------------------------------------------------------

/** @type {ToolDef} */
export const WEB_SEARCH_TOOL = {
  name: "web_search",
  description:
    "Search the open web through this site's configured search provider and get numbered results " +
    "with title, URL and highlight snippets. SEND SEVERAL DISTINCT ANGLES IN ONE CALL: they run in " +
    "parallel for the latency of one, and near-duplicate queries waste your budget. Results are " +
    "registered as citable sources [n]; cite them by number. Identical queries within 10 minutes are " +
    "served from cache at no cost. An EMPTY result means the provider found nothing — not that the " +
    "search failed; a call that could not run at all says so in words.",
  input_schema: {
    type: "object",
    properties: {
      queries: {
        type: "array",
        items: { type: "string" },
        maxItems: MAX_WEB_QUERIES,
        description: `Up to ${MAX_WEB_QUERIES} self-contained search queries, run in parallel. Distinct angles beat near-duplicates.`,
      },
      depth: {
        type: "string",
        enum: ["auto", "deep"],
        default: "auto",
        description: "`deep` costs more and is only worth it when a shallow pass already missed.",
      },
      num_results: { type: "number", minimum: 1, maximum: 10, default: 5 },
    },
    required: ["queries"],
  },
};

/** @type {ToolDef} */
export const READ_PAGES_TOOL = {
  name: "read_pages",
  description:
    "Fetch the full extracted text of pages you already have a URL for — a search result worth " +
    "reading properly, or a link the user pasted. Up to " + MAX_READ_URLS + " URLs per call, ~6000 " +
    "characters each. A page that cannot be extracted is simply absent from the result; nothing is " +
    "invented. Cheaper first: the highlights on a search result often already answer the question.",
  input_schema: {
    type: "object",
    properties: {
      urls: {
        type: "array",
        items: { type: "string" },
        maxItems: MAX_READ_URLS,
        description: "Absolute http(s) URLs.",
      },
    },
    required: ["urls"],
  },
};

/** The open-web pair, in the order a run should reach for them. */
export const WEB_TOOLS = [WEB_SEARCH_TOOL, READ_PAGES_TOOL];

// ---------------------------------------------------------------------------
// (C) the auxiliary source registry, as ONE tool
// ---------------------------------------------------------------------------

/**
 * The `source_search` definition for a given registry.
 *
 * GENERATED, deliberately. The `source` enum and the per-source guidance are
 * built from each entry's own `service` and `promptNote`, so adding a search
 * source touches no orchestrator file and no tool definition — the same
 * property src/search-sources.js's registry already gives the wave path.
 *
 * It also carries invariant 6 across the change. The deterministic `intent`
 * gates that used to route a Swedish message to the right corpus do not run on
 * this path, but the bilingual vocabulary those sources wrote for the PLANNER
 * ("ALWAYS in English even when the conversation is in Swedish — the indexed
 * titles and abstracts are English") is exactly the guidance a self-selecting
 * model needs, and it survives here verbatim instead of being lost with the
 * gate.
 *
 * @param {import('./search-sources.js').SearchSource[]} sources
 * @returns {ToolDef}
 */
export function buildSourceSearchTool(sources) {
  const usable = (Array.isArray(sources) ? sources : []).filter((s) => s && typeof s.id === "string");
  const catalog = usable
    .map((s) => {
      const note = (s.promptNote || "").trim();
      return `· ${s.id} — ${s.service}.${note ? ` ${note}` : ""}`;
    })
    .join("\n");
  return {
    name: "source_search",
    description:
      "Search ONE named specialist source rather than the open web. Each one indexes a different " +
      "record and ranks by meaning, so a question the web answers badly often has a source that " +
      "answers it directly. Results are registered as citable sources [n].\n\n" +
      catalog +
      "\n\n" +
      RETRIEVAL_NOTE +
      "\nA source you are not permitted to consult, or one this deployment cannot reach, says so in " +
      "words when you call it — it never returns a silent empty result.",
    input_schema: {
      type: "object",
      properties: {
        source: {
          type: "string",
          enum: usable.map((s) => s.id),
          description: "Which source to search.",
        },
        query: {
          type: "string",
          description:
            "A natural-language question or topic statement. Not keywords — these sources retrieve by meaning first.",
        },
      },
      required: ["source", "query"],
    },
  };
}

/** @type {ToolDef} */
export const SOURCE_SEARCH_TOOL = buildSourceSearchTool(SEARCH_SOURCES);

// ---------------------------------------------------------------------------
// (D) the committed corpus
// ---------------------------------------------------------------------------

/** @type {ToolDef} */
export const ANCIENT_SAMPLES_TOOL = {
  name: "ancient_samples",
  description:
    "Query the committed corpus of published ancient-DNA individuals by geography, date window, " +
    "haplogroup prefix, coverage floor and sex. Returns exact rows and counts, never a citation URL: " +
    "the honest citation is the dataset plus the study key. Contacts nothing — the corpus is a build " +
    "artifact of this deployment. Dates are BP with BP=1950 and are INTERVALS. Haplogroup matching is " +
    "one-way PREFIX matching. `Ignore_`-flagged individuals are excluded unless include_ignored is set.",
  input_schema: {
    type: "object",
    properties: {
      near: {
        type: "string",
        description:
          "A place or country to centre a radius on. Resolved against the corpus's own gazetteer — " +
          "there is no geocoder here, so a location with no published individuals cannot anchor a radius, " +
          "and the result says so rather than dropping the filter silently.",
      },
      radius_km: { type: "number", default: 250 },
      from_year: { type: "number", description: "Calendar year, negative for BCE." },
      to_year: { type: "number" },
      y_haplogroup: { type: "string" },
      mt_haplogroup: { type: "string" },
      group: { type: "string", description: "A segment of the population label, e.g. \"yamnaya\"." },
      sex: { type: "string", enum: ["M", "F"] },
      min_coverage: { type: "number" },
      include_ignored: { type: "boolean", default: false },
      limit: { type: "number", default: 30, maximum: MAX_SAMPLE_ROWS },
    },
    required: [],
  },
};

export const CORPUS_TOOLS = [ANCIENT_SAMPLES_TOOL];

// ---------------------------------------------------------------------------
// (E) computation
// ---------------------------------------------------------------------------

/** @type {ToolDef} */
export const RUN_PYTHON_TOOL = {
  name: "run_python",
  description:
    "Run a short Python program and get its stdout, stderr and exit code back. Use it to COMPUTE " +
    "rather than to guess: parse a table you fetched, do the arithmetic behind a claim, reduce a JSON " +
    "blob. The program runs in a Linux sandbox with no network. Keep it under a few seconds — a " +
    "program that runs too long is killed and you get nothing. The interpreter may be a SUBSET of " +
    "Python: if it refuses (exit 90, one `<engine>: unsupported: <kind>: <detail>` line), the same " +
    "program is retried automatically on full CPython and you are told which engine answered. A " +
    "refusal is information, not a failure.",
  input_schema: {
    type: "object",
    properties: {
      source: { type: "string", description: "The complete program. Print what you want to see." },
      stdin: { type: "string", description: "Optional text on stdin." },
    },
    required: ["source"],
  },
};

export const PYTHON_TOOLS = [RUN_PYTHON_TOOL];

// ---------------------------------------------------------------------------
// The whole toolbox
// ---------------------------------------------------------------------------

/** The extension families' definitions in this repository's tool shape
 * (`input_schema`), which is what a model is handed. EXTENSION_MCP_TOOLS below
 * is the same set in MCP's `inputSchema` shape and is re-exported verbatim for
 * callers that speak that wire. */
export const EXTENSION_RESEARCH_TOOLS = EXTENSION_TOOL_FAMILIES.flatMap((f) => f.tools);

/**
 * Every tool the research toolbox can contain, in the order the classes are
 * bound. This is a CATALOG, not a run's tool list: what a given run gets is the
 * agent's declared classes resolved through src/tool-sets.js and then filtered
 * by src/tool-admission.js, so nothing here is handed to a model by existing.
 * @type {ToolDef[]}
 */
export const RESEARCH_TOOLS = [
  ...WEB_TOOLS,
  SOURCE_SEARCH_TOOL,
  ...LITERATURE_TOOLS,
  ...CORPUS_TOOLS,
  ...PYTHON_TOOLS,
  ...EXTENSION_RESEARCH_TOOLS,
];

/** @type {Set<string>} */
export const RESEARCH_TOOL_NAMES = new Set(RESEARCH_TOOLS.map((t) => t.name));

/**
 * Tool name → the CONTEXT_BLOCKS id (public/js/agent-spec-core.js) the
 * answering agent must declare, or null for a tool no agent has to declare.
 *
 * Read by src/tool-admission.js through `capHasContext`, which means a NULL
 * capability — an unresolved agent, the MCP channel, a registry that will not
 * load — is REFUSED a tool that names a block. That direction is deliberate and
 * it is the one src/enrichment.js already takes for the extensions: "no agent
 * was resolved" must not read as "an agent declared nothing" and hand an
 * unaddressed request third-party reach. The mirror case is `source_search`,
 * whose per-source gate is src/search-sources.js's `capabilityAllowsSource` and
 * which KEEPS every source for a null capability, because the alternative there
 * is an outage that looks like an empty answer (the ground-truth batteries name
 * no agent and must keep reaching the corpora). Both asymmetries are asserted
 * in src/tool-admission.test.js.
 *
 * The literature family names no block for the same reason as the sources: it
 * is the /mcp surface's own corpus door, resolved with a null capability on
 * every request there.
 * @type {Record<string, string|null>}
 */
export const RESEARCH_TOOL_CONTEXT = {
  web_search: null,
  read_pages: null,
  source_search: null,
  run_python: null,
  ...Object.fromEntries(LITERATURE_TOOLS.map((t) => [t.name, null])),
  ancient_samples: "ancient-samples",
  // The extension tools inherit their extension's declared block, so this table
  // cannot drift from src/extensions.js — pinned in research-tools.test.js.
  street_view_look: "street-imagery",
  place_nearby: "street-imagery",
  host_intel: "host-intel",
  host_search: "host-intel",
  domain_intel: "host-intel",
  cve_intel: "host-intel",
};

/** Tool name → the src/extensions.js descriptor id that owns it (and therefore
 * the account knob that consents to reaching that third party). Only the
 * extension tools appear; everything else is this platform's own. */
export const RESEARCH_TOOL_EXTENSION = EXTENSION_TOOL_EXTENSION;

/**
 * The tools that reach a metered upstream. A spending tool holds a slot in the
 * per-run tool budget (src/tool-admission.js MAX_SPENDING_CALLS) — the same
 * reasoning src/mcp.js applies to its own spending set: an outbound tool with
 * neither a meter nor a cap is an unbounded one.
 *
 * `run_python` and `ancient_samples` are the two that spend nothing: one runs in
 * a sandbox the request already has, the other reads a build artifact.
 * @type {Set<string>}
 */
export const RESEARCH_SPENDING_TOOLS = new Set([
  "web_search",
  "read_pages",
  "source_search",
  // The corpus legs embed the query and rerank 50 candidates per corpus, which
  // is real Berget money — literature_fetch and literature_corpora are a key
  // read and committed facts, and spend nothing.
  "literature_search",
  "literature_similar",
  ...EXTENSION_SPENDING_TOOLS,
]);

// Verbatim re-exports, so a caller assembling a toolbox needs one import.
export { LITERATURE_TOOLS, EXTENSION_MCP_TOOLS, RETRIEVAL_NOTE };
