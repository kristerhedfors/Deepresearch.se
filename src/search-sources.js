// The search-source registry: every auxiliary deep-research source that
// runs ALONGSIDE Exa in the search waves plugs in HERE, and only here.
//
// WHY A REGISTRY: parallel sessions routinely work on different sources at
// the same time (observed 2026-07-08: an HF Hub session and a Street View
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
// Entry contract (see the **add-research-source** skill for the full
// integration playbook — intent design, empirical API probing, the
// validation ladder):
//   id            — short slug; also the per-request state bucket name
//                   (state.aux[id]) and the log prefix ("<id>.search").
//   intent(text)  — pure predicate on the LATEST USER MESSAGE deciding
//                   whether this source fires at all. Must be cheap and
//                   conservative; when false the source is fully invisible
//                   (no step, no event, no fetch).
//   search(env, log, query) — the timeout-bounded, fail-soft client call.
//                   Returns { items: [{url, title, highlights}], durationMs };
//                   items join the numbered source registry via addSources.
//   service       — human display name shown on the client's search cards
//                   and carried on the search events as `service` (e.g.
//                   "Hugging Face Hub" — the UI must always make clear
//                   WHICH provider a card came from; plain web cards say
//                   "Web search").
//   dedupKey(query) — optional; normalizes a query for cross-wave dedup
//                   (defaults to lowercased trimmed query text).
//   maxPerRequest — optional wave cap (default 3).
//   promptNote    — optional planner-vocabulary sentence spliced into the
//                   triage AND gap prompts (site-specific abbreviations,
//                   "never clarify X", query-spelling guidance). Starts
//                   with a leading space; keep it ONE sentence.
//   diversityHost / diversityKeyOf(url) — optional pair: when the source's
//                   results live on a PLATFORM domain hosting many
//                   independent authors, sources.js keys that host's URLs
//                   with diversityKeyOf instead of the hostname, so the
//                   per-origin cap doesn't starve platform results while
//                   still capping any single author/namespace.
//
// Everything a source contributes is DATA in its entry — the orchestration
// (wave timing, dedup, caps, SSE events, fail-soft) lives once in
// pipeline.js's runAuxSearches and is identical for every source.

import { hfDiversityKey, hfIntent, hfPromptNote, hfSearch, hfTermKey } from "./hf.js";

export const SEARCH_SOURCES = [
  {
    id: "hf",
    intent: hfIntent,
    search: hfSearch,
    service: "Hugging Face Hub",
    dedupKey: hfTermKey,
    maxPerRequest: 3,
    promptNote: hfPromptNote,
    diversityHost: "huggingface.co",
    diversityKeyOf: hfDiversityKey,
  },
];

// The concatenated planner-vocabulary notes for the triage/gap prompts
// (prompts.js splices this next to its other standing rules). Empty string
// when no source declares one, so the prompts are byte-identical to a
// registry with no notes.
export function sourcePromptNotes() {
  return SEARCH_SOURCES.map((s) => s.promptNote || "").join("");
}

// Platform-aware diversity key override, consulted by sources.js's
// diversityKeyOf: returns the source-declared key for a URL on a declared
// platform host, or null when no source claims the host (→ hostname key).
export function platformDiversityKey(host, url) {
  for (const s of SEARCH_SOURCES) {
    if (s.diversityHost && s.diversityHost === host && typeof s.diversityKeyOf === "function") {
      return s.diversityKeyOf(url);
    }
  }
  return null;
}
