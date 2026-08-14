// @ts-check
// The search-source registry: every auxiliary deep-research source that
// runs ALONGSIDE Exa in the search waves plugs in HERE, and only here.
//
// WHY A REGISTRY: parallel sessions routinely work on different sources at
// the same time (observed 2026-07-08: an HF Hub session and an imagery
// session pushing to `main` within minutes of each other). Before this
// existed, one source's integration touched FOUR shared files —
// pipeline.js (imports + a bespoke maybeXxxSearch), prompts.js (planner
// vocabulary), sources.js (diversity keying), plus its own module — so two
// source-sessions were guaranteed to collide in the shared orchestrator.
// Now a source is: ONE self-contained module (src/<source>.js, no imports
// from other src/ modules) + ONE entry in this list + its own test file.
// pipeline.js, prompts.js, and sources.js iterate the registry and never
// name an individual source.
//
// The entry contract is the SearchSource typedef below (see the
// **add-research-source** skill for the full integration playbook — intent
// design, empirical API probing, the validation ladder). Everything a
// source contributes is DATA in its entry — the orchestration (wave
// timing, dedup, caps, SSE events, fail-soft) lives once in pipeline.js's
// runAuxSearches and is identical for every source.

import {
  ARXIV_LEAD_MAX_PER_REQUEST,
  ARXIV_MAX_PER_REQUEST,
  arxivDiversityKey,
  arxivIntent,
  arxivLeadIntent,
  arxivPickQuery,
  arxivPromptNote,
  arxivSearch,
  arxivTermKey,
} from "./arxiv.js";
import {
  EUROPEPMC_LEAD_MAX_PER_REQUEST,
  EUROPEPMC_MAX_PER_REQUEST,
  europepmcDiversityKey,
  europepmcIntent,
  europepmcLeadIntent,
  europepmcPickQuery,
  europepmcPromptNote,
  europepmcSearch,
  europepmcTermKey,
} from "./europepmc.js";
import { hfDiversityKey, hfIntent, hfPickQuery, hfPromptNote, hfSearch, hfTermKey } from "./hf.js";
import { capHasContext } from "./agent-spec.js";
import {
  SCHOLAR_LEAD_MAX_PER_REQUEST,
  SCHOLAR_MAX_PER_REQUEST,
  scholarDiversityKey,
  scholarIntent,
  scholarLeadIntent,
  scholarPickQuery,
  scholarPromptNote,
  scholarSearch,
  scholarTermKey,
} from "./scholar.js";

/**
 * One search result an auxiliary source returns, in the same shape Exa
 * items take so sources.js can register them unchanged.
 * @typedef {{ url: string, title: string, highlights?: string[] }} SearchSourceItem
 */

/**
 * What a source's `search` call resolves to. `usedKeys` lists the attempt
 * keys this call consumed (hit or miss), recorded by the orchestrator so a
 * later wave's ladder skips them instead of re-fetching identical results.
 *
 * `spend` is the OPTIONAL provider bill this call ran up at Berget — the
 * dense-retrieval tally from src/dense-rag.js. Most sources spend nothing
 * there (a plain HTTP query to a free API) and omit it; the literature legs
 * with a hosted tier embed the query and run a cross-encoder over 50 candidates
 * per corpus, which is real money, and the orchestrator accumulates it across
 * every leg of the request so src/billing.js can price it into the one usage
 * row (pipeline.js runOneAuxSearch). Declared HERE rather than in either
 * source, because the orchestrator reads it generically and must never name a
 * source — the same rule the rest of this contract follows.
 * @typedef {{ items: SearchSourceItem[], durationMs: number, usedKeys?: string[], spend?: import('./dense-rag.js').RetrievalSpend }} SearchSourceResult
 */

/**
 * The registry entry contract (pinned by search-sources.test.js).
 * @typedef {Object} SearchSource
 * @property {string} id
 *   Short slug; also the per-request state bucket name (state.aux[id]) and
 *   the log prefix ("<id>.search").
 * @property {(text: string) => boolean} intent
 *   Pure predicate on the LATEST USER MESSAGE deciding whether this source
 *   fires at all. Must be cheap and conservative; when false the source is
 *   fully invisible (no step, no event, no fetch).
 * @property {(text: string) => boolean} [leadIntent]
 *   Pure predicate, strictly narrower than `intent`: does the message name
 *   THIS source as the place to look? When it matches, the source LEADS the
 *   turn — the generic web (Exa) leg stands down, and this source spends the
 *   wave's whole breadth, up to `leadMaxPerRequest` angles instead of one.
 *   Optional: a source that declares none never leads, which is the default.
 *   Fail-soft is the orchestrator's (pipeline.js): a leading source that finds
 *   NOTHING releases the lead and the web leg runs after all, so "arXiv only"
 *   can never mean "no sources at all". Asking for a source by name is a
 *   different act from asking a question that source happens to serve — keep
 *   this tier to the explicit naming, or every research question silently
 *   loses web search.
 * @property {number} [leadMaxPerRequest]
 *   The per-request search ceiling while LEADING (defaults to maxPerRequest).
 *   Higher is the point: with the web leg down, covering only one of the
 *   wave's angles leaves the turn thinner than the un-led one was.
 * @property {(env: import('./types.js').Env, log: import('./types.js').Logger, query: string, opts: { skipKeys?: Set<string>, asked?: string }) => Promise<SearchSourceResult>} search
 *   The timeout-bounded, fail-soft client call. `skipKeys` is the set of
 *   attempt keys earlier waves consumed (skip them — don't re-fetch the
 *   same results). `asked` is the reader's own latest message, clean of any
 *   enrichment prose — for a source whose FILTERING (not just its ranking)
 *   depends on what was asked, and which therefore cannot read it off the
 *   planner's paraphrase of the question. Optional: a source that ignores it
 *   behaves identically whether or not it is passed.
 * @property {string} service
 *   Human display name shown on the client's search cards and carried on
 *   the search events as `service` (e.g. "Hugging Face Hub" — the UI must
 *   always make clear WHICH provider a card came from; plain web cards say
 *   "Web search").
 * @property {(batch: string[], topic: string) => string} [pickQuery]
 *   Picks which of the wave's planned queries this source searches
 *   (default batch[0]). `topic` is the latest user message, so a source can
 *   score the planner's angles against what was actually asked — arxiv does,
 *   because the planner's narrowest angle is not the user's question
 *   (feedback #44). hf picks the most entity/identifier-bearing one instead —
 *   the web→hub insight flow (a gap query learned from web results, like a
 *   CVE id, is exactly what the hub can answer).
 * @property {(query: string) => string} [dedupKey]
 *   Normalizes a query for cross-wave dedup (defaults to lowercased
 *   trimmed query text).
 * @property {number} [maxPerRequest]
 *   Wave cap per request (default 3 — pipeline.js MAX_AUX_SEARCHES_DEFAULT).
 * @property {string} [promptNote]
 *   Planner-vocabulary sentence spliced into the triage AND gap prompts
 *   (site-specific abbreviations, "never clarify X", query-spelling
 *   guidance). Starts with a leading space; keep it ONE sentence.
 * @property {string} [diversityHost]
 *   With diversityKeyOf, an optional pair: when the source's results live
 *   on a PLATFORM domain hosting many independent authors, sources.js keys
 *   that host's URLs with diversityKeyOf instead of the hostname, so the
 *   per-origin cap doesn't starve platform results while still capping any
 *   single author/namespace.
 * @property {(url: string) => string} [diversityKeyOf]
 * @property {string} [requiresContext]
 *   A CONTEXT_BLOCKS id (public/js/agent-spec-core.js) the ANSWERING AGENT must
 *   declare in its capability block for this source to run at all. Declared
 *   here as data, enforced generically by pipeline.js (`sourceAllowed`) — the
 *   orchestrator reads the field and never learns which source it belongs to,
 *   exactly like `intent` and `leadIntent` above.
 *
 *   WHY (owner directive, 2026-08-13): the agent roster became SPECIFIC, with
 *   no general member — the `normal` mode and its `research` agent are gone and
 *   Deep Science is the default and terminal fallback — and with that came a
 *   division of the corpora: Deep Science is the EXCLUSIVE owner of all arXiv
 *   and PubMed capability, and palaeogenomics keeps the life-science leg it was
 *   built on. Before this field the only way to say that was `state.auxOnly`,
 *   which is a per-request narrowing an enrichment writes; a corpus belonging
 *   to an agent is a fact about the AGENT, so it belongs in the agent's spec
 *   (`sdk/AGENTS.json` capability.context) and is read from there. A future
 *   spec edit that hands a literature corpus to another agent is then a visible
 *   one-line diff — and fails src/literature-exclusivity.test.js.
 *
 *   FAIL-SOFT (invariant 2): a NULL capability means "no agent was resolved",
 *   not "an agent declared nothing", so the source RUNS. That is the MCP
 *   channel (src/mcp.js builds its state with no registry) and any deployment
 *   whose registry will not load. Same rule `toolsForRun` applies to a null
 *   capability in src/tool-sets.js, and for the same reason.
 */

/** @type {SearchSource[]} */
export const SEARCH_SOURCES = [
  {
    id: "hf",
    intent: hfIntent,
    // Cast: hf.js is unannotated, so hfSearch's inferred item type carries a
    // pre-filter `| null` its own code removes before returning.
    search: /** @type {SearchSource['search']} */ (hfSearch),
    service: "Hugging Face Hub",
    pickQuery: hfPickQuery,
    dedupKey: hfTermKey,
    maxPerRequest: 3,
    promptNote: hfPromptNote,
    diversityHost: "huggingface.co",
    diversityKeyOf: hfDiversityKey,
  },
  {
    id: "arxiv",
    intent: arxivIntent,
    // Naming the archive makes it the place to look, not merely a place —
    // feedback #44, "if asked for arXiv explicitly, start there and do only
    // arxiv unless called for otherwise".
    leadIntent: arxivLeadIntent,
    leadMaxPerRequest: ARXIV_LEAD_MAX_PER_REQUEST,
    search: arxivSearch,
    service: "arXiv",
    pickQuery: arxivPickQuery,
    dedupKey: arxivTermKey,
    // Lower than hf's 3: arXiv publishes a rate limit (1 req / 3 s, single
    // connection) and sells no way past it, so the per-turn request budget is
    // deliberate — see ARXIV_MAX_PER_REQUEST and MAX_ATTEMPTS in arxiv.js.
    maxPerRequest: ARXIV_MAX_PER_REQUEST,
    promptNote: arxivPromptNote,
    // The preprint record belongs to ONE agent (owner directive, 2026-08-13):
    // Deep Science owns arXiv outright, and reaches it only when the reader
    // names the preprint record — see src/scholar-metrics.js, which widens its
    // `auxOnly` for exactly that ask and no other. No other agent declares
    // `literature-arxiv`, so no other agent gets preprints.
    requiresContext: "literature-arxiv",
    diversityHost: "arxiv.org",
    diversityKeyOf: arxivDiversityKey,
  },
  {
    // The life-science literature leg (PubMed / PMC / bioRxiv / medRxiv).
    // arXiv sits above it and covers almost none of the same ground: genetics,
    // palaeogenomics and biomedicine publish in journals and on bioRxiv, so
    // without this a genetics question had only the generic web leg.
    id: "europepmc",
    intent: europepmcIntent,
    leadIntent: europepmcLeadIntent,
    leadMaxPerRequest: EUROPEPMC_LEAD_MAX_PER_REQUEST,
    search: europepmcSearch,
    service: "Europe PMC",
    pickQuery: europepmcPickQuery,
    dedupKey: europepmcTermKey,
    maxPerRequest: EUROPEPMC_MAX_PER_REQUEST,
    promptNote: europepmcPromptNote,
    // The life-science record is owned by Deep Science and SHARED with the
    // palaeogenomics agent, which declares `literature-pubmed` too (owner
    // directive, 2026-08-13). That sharing is deliberate and is the explicit
    // preservation in this change: ancient-DNA questions are answered from
    // Europe PMC and the site's hosted PubMed index — the corpus half of that
    // agent's two legs — and the evalsets tests/evalsets/palaeogenomics.json
    // and tests/needles/*-pubmed.json measure it. Pinned in
    // src/literature-exclusivity.test.js so neither the sharing nor its limit
    // (arXiv, which does not cover the field, is NOT shared) can drift.
    requiresContext: "literature-pubmed",
    // The hits are DOI URLs, so without a platform key every publisher on
    // earth would share the single origin `doi.org` and the per-origin cap
    // would starve the leg to one or two results. Keyed on the registrant
    // prefix instead, which is the publisher (europepmc.js).
    diversityHost: "doi.org",
    diversityKeyOf: europepmcDiversityKey,
  },
  {
    // The PEER-REVIEWED leg: OpenAlex, Europe PMC's peer-reviewed slice,
    // Semantic Scholar and — where a licensed key is configured — Google
    // Scholar itself, merged and then filtered down to records that carry
    // positive evidence of peer review (src/scholar.js).
    //
    // It overlaps the two legs above and differs from both in the way that
    // matters. arXiv is preprints by definition and europepmc includes them on
    // purpose; this source excludes them on purpose, and is cross-domain where
    // europepmc is life-science. It is the only source the Deep Science agent
    // is allowed to consult (state.auxOnly), which is why the exclusion has to
    // live in the source rather than in a prompt — and why, since 2026-08-12,
    // it carries its own hosted-PubMed tier: being the only permitted source
    // meant the site's own corpus was unreachable from the agent whose subject
    // it is, because that corpus hung off europepmc, which auxOnly excludes.
    id: "scholar",
    intent: scholarIntent,
    leadIntent: scholarLeadIntent,
    leadMaxPerRequest: SCHOLAR_LEAD_MAX_PER_REQUEST,
    search: scholarSearch,
    service: "Peer-reviewed literature",
    pickQuery: scholarPickQuery,
    dedupKey: scholarTermKey,
    maxPerRequest: SCHOLAR_MAX_PER_REQUEST,
    promptNote: scholarPromptNote,
    // The peer-reviewed record is Deep Science's alone. It was already so in
    // practice — `state.auxOnly` narrowed that agent's turn to this source —
    // but the reverse direction was never stated: nothing stopped any OTHER
    // agent's turn from firing this leg on a "peer-reviewed" phrasing and
    // spending the reranker budget of the agent whose subject it is not.
    // Declaring it here says it once, in the same place as the other two.
    requiresContext: "literature-peer-reviewed",
    // Same reasoning as europepmc's: the hits are DOI URLs, so without a
    // platform key every publisher on earth shares the origin `doi.org` and
    // the per-origin cap starves the leg. Keyed on the registrant prefix,
    // which is the publisher.
    diversityHost: "doi.org",
    diversityKeyOf: scholarDiversityKey,
  },
];

// May the answering agent consult this source at all?
//
// The generic reading of the entry's `requiresContext` (see the typedef): a
// source that names a context block runs only for an agent whose capability
// declares that block. Everything else is unchanged — a source declaring
// nothing runs for everyone, exactly as every source did before 2026-08-13.
//
// The NULL capability is the fail-soft case and it means "no agent was
// resolved", which is not the same claim as "an agent declared nothing": the
// MCP channel builds its state without a registry (src/mcp.js), and a
// deployment whose registry will not load resolves nothing either. Both must
// keep every source, because the alternative is an outage that looks like an
// empty answer — invariant 2, and the same treatment `toolsForRun` gives a null
// capability in src/tool-sets.js. Concretely: the literature door at POST /mcp
// is DELIBERATELY not governed by the agent roster, because MCP has no concept
// of an agent to govern it with — the ground-truth batteries
// (tests/dr-eval.mjs over tests/evalsets/*, tests/needles/*) reach both corpora
// through it and must keep doing so.
/**
 * @param {import('./agent-spec.js').AgentCapability | null | undefined} cap
 * @param {SearchSource} source
 * @returns {boolean}
 */
export function capabilityAllowsSource(cap, source) {
  if (!source?.requiresContext) return true;
  if (!cap) return true;
  return capHasContext(cap, source.requiresContext);
}

// The concatenated planner-vocabulary notes for the triage/gap prompts
// (prompts.js splices this next to its other standing rules). Empty string
// when no source declares one, so the prompts are byte-identical to a
// registry with no notes.
//
// CAPABILITY-AWARE since 2026-08-13: a note teaches the JSON planning model the
// vocabulary of a source ("arXiv means arxiv.org, never clarify it", "phrase at
// least one query as the biomedical concepts"). Teaching that for a source the
// answering agent is not allowed to consult is worse than teaching nothing — it
// spends triage's attention shaping queries for a leg that will never run, and
// it invites the planner to promise a corpus the answer cannot cite. The
// capability is threaded in from pipeline.js's two prompt call sites; omitted
// (or null — the MCP channel), every note is composed, which is what this
// function did before the argument existed.
/**
 * @param {import('./agent-spec.js').AgentCapability | null} [cap]
 * @returns {string}
 */
export function sourcePromptNotes(cap = null) {
  return SEARCH_SOURCES.filter((s) => capabilityAllowsSource(cap, s))
    .map((s) => s.promptNote || "")
    .join("");
}

// The ids of every source the message names as THE place to look, in registry
// order. Empty for an ordinary question — the common case, and the one where
// nothing about the wave changes. pipeline.js consumes this generically and
// never names a source (invariant: adding or removing a source touches no
// orchestrator file).
/**
 * @param {string} text the latest user message
 * @returns {string[]}
 */
export function leadSourceIds(text) {
  return SEARCH_SOURCES.filter((s) => typeof s.leadIntent === "function" && s.leadIntent(text)).map((s) => s.id);
}

// Platform-aware diversity key override, consulted by sources.js's
// diversityKeyOf: returns the source-declared key for a URL on a declared
// platform host, or null when no source claims the host (→ hostname key).
/**
 * @param {string} host
 * @param {string} url
 * @returns {string | null}
 */
export function platformDiversityKey(host, url) {
  for (const s of SEARCH_SOURCES) {
    if (s.diversityHost && s.diversityHost === host && typeof s.diversityKeyOf === "function") {
      return s.diversityKeyOf(url);
    }
  }
  return null;
}
