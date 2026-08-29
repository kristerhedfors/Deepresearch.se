// @ts-check
// The cross-search source registry: every search result the pipeline
// collects lands here — deduped by URL, numbered in arrival order so [n]
// citations stay stable between synthesis and validation, and diversity-
// capped per domain. Pure data logic (no fetches, no model calls), extracted
// from pipeline.js so the registry rules are readable and testable on their
// own (sources.test.js). The prompt-facing rendering of that registry — the
// budgeted numbered-source digest — is its companion source-digest.js.

import { platformDiversityKey } from "./search-sources.js";

/** @typedef {import('./types.js').SourceEntry} SourceEntry */

/**
 * An incoming search-result item (Exa's or an auxiliary source's shape).
 * @typedef {{ url: string, title?: string, highlights?: string[] }} SourceItem
 */

/**
 * The registry slice of the per-request state this module owns (the full
 * shape is import('./types.js').RequestState): `domainCounts` and
 * `sourceOverflow` are lazily created here and read nowhere else.
 * @typedef {{
 *   sources: SourceEntry[],
 *   byUrl: Map<string, SourceEntry>,
 *   plan: { maxSources: number },
 *   domainCounts?: Map<string, number>,
 *   sourceOverflow?: (SourceItem | null | undefined)[],
 *   overflowUrls?: Set<string>,
 * }} SourceRegistryState
 */

// A round 7 assessment found that MORE and DEEPER searches don't
// automatically buy more independent verification — a genuinely
// well-researched, 19-search "deep" run on a company's own product still
// ended up citing that company's own site 4 of 6 times, because Exa's
// relevance ranking naturally surfaces whoever has published the most
// content about themselves. This is the classic relevance-vs-diversity
// tension search engines have long addressed with result diversification
// (Carbonell & Goldstein's Maximal Marginal Relevance is the canonical
// technique) — capping how many results from one origin can dominate a
// result set, independent of how a caller phrases its queries. Doing it
// here as a hard cap (not a prompt instruction) guarantees it regardless
// of whether a given model reliably follows the softer prompt-level asks
// in prompts.js (the query-plan node's mandatory independent-source query,
// the reflect node's dominance check) — belt and suspenders, not either/or.
const DOMAIN_CAP = 3;

/**
 * @param {string} url
 * @returns {string} The hostname (www. stripped), or the raw string when unparseable.
 */
export function hostnameOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

// The diversity-cap key for a URL. Normally the hostname — but a
// search-source integration can declare a PLATFORM host whose URLs are
// keyed per owner namespace instead (src/search-sources.js's
// platformDiversityKey; huggingface.co is the canonical case — see
// src/hf.js hfDiversityKey for the full rationale): a hub hosting millions
// of independently-authored repos must not be capped as one origin, while
// the cap's real job (no single AUTHOR dominating) still holds.
/**
 * @param {string} url
 * @returns {string}
 */
export function diversityKeyOf(url) {
  const host = hostnameOf(url);
  return platformDiversityKey(host, url) || host;
}

// Adds search-result items to the registry. Sources beyond DOMAIN_CAP for
// their origin are held in an overflow list rather than dropped outright —
// backfillOverflowSources() uses them if the capped registry ends up short
// of maxSources (a niche topic with genuinely few distinct domains
// shouldn't be starved just to enforce diversity that isn't available).
/**
 * @param {SourceRegistryState} state
 * @param {(SourceItem | null | undefined)[] | null | undefined} items
 */
export function addSources(state, items) {
  state.domainCounts ||= new Map();
  state.sourceOverflow ||= [];
  state.overflowUrls ||= new Set();
  for (const item of items || []) {
    if (!item?.url || state.byUrl.has(item.url)) continue;
    if (state.sources.length >= state.plan.maxSources) return;
    const key = diversityKeyOf(item.url);
    const count = state.domainCounts.get(key) || 0;
    if (count >= DOMAIN_CAP) {
      // Deduped like the registry itself. Without this a later wave that
      // re-finds the same capped URLs would look like new ground to
      // sourceProgress(), and the gap loop's genuine-saturation exit — the
      // thing that stops it spinning rounds against the same sources — would
      // never fire.
      if (!state.overflowUrls.has(item.url)) {
        state.overflowUrls.add(item.url);
        state.sourceOverflow.push(item);
      }
      continue;
    }
    state.domainCounts.set(key, count + 1);
    pushSource(state, item);
  }
}

// How much NEW ground a wave found: sources admitted to the registry PLUS the
// domain-capped ones parked in overflow. The gap loop's saturation exit reads
// this rather than `sources.length`, and the difference is not academic — a
// question whose answer lives across many pages of one authoritative domain
// (a standards body, a government registry, one publisher's DOI prefix) hits
// DOMAIN_CAP on its third result, so every later find lands in overflow and
// the registry stops growing. Read as `sources.length` alone, that is
// indistinguishable from "the web has no more to say", and the run stops
// researching while it is still finding new pages. Those pages are real:
// backfillOverflowSources promotes them before synthesis.
//
// Monotonic while the gap loop runs — its only consumer, the backfill, runs
// after the loop has finished.
/**
 * @param {SourceRegistryState} state
 * @returns {number}
 */
export function sourceProgress(state) {
  return state.sources.length + (state.sourceOverflow?.length || 0);
}

// Called once before synthesis: if the domain cap left the registry short
// of maxSources (few distinct domains for a niche topic), backfill from
// the overflow — diversity that doesn't exist can't be enforced, and a
// smaller-than-planned source list would otherwise cost the answer real
// grounding for no benefit.
/** @param {SourceRegistryState} state */
export function backfillOverflowSources(state) {
  const overflow = state.sourceOverflow || [];
  while (state.sources.length < state.plan.maxSources && overflow.length) {
    const item = overflow.shift();
    if (!item?.url || state.byUrl.has(item.url)) continue;
    pushSource(state, item);
  }
}

// Shared by addSources/backfillOverflowSources: numbers and registers one
// source entry. Assumes the caller has already checked for a duplicate URL.
/**
 * @param {SourceRegistryState} state
 * @param {SourceItem} item
 */
function pushSource(state, item) {
  const entry = {
    n: state.sources.length + 1,
    title: item.title || item.url,
    url: item.url,
    highlights: (item.highlights || []).slice(0, 3),
  };
  state.byUrl.set(item.url, entry);
  state.sources.push(entry);
}

// The digest itself — how the numbered-source block is budgeted and rendered
// — lives in source-digest.js. Re-exported here so importers keep reaching for
// the registry module they already import.
export { digestShownCount, sourceDigest } from "./source-digest.js";

// A heading a model actually writes when the synthesis prompt asks it to "End
// with a 'Sources:' section". The old test was `/(^|\n)\s*sources\s*:/i`, which
// only matched a bare `Sources:` at the start of a line — so every answer whose
// model reached for `### Sources:` or `**Sources:**`, which the report-tier
// structures in prompts.js explicitly ask for, got the list appended a SECOND
// time. On the MCP surface that shipped two source lists in one answer: the
// model's, built from the (possibly truncated) digest, and the registry's full
// one, with nothing telling the reader which was authoritative.
//
// Swedish is here for the same reason it is in every other routing gate
// (CLAUDE.md invariant 6): an answer written in Swedish ends with `Källor:`,
// and matching only the English form appended an English list under it.
const SOURCE_HEADING = /(^|\n)[ \t]*(?:[#>*_\-–—]|\d+[.)])*[ \t]*\**[ \t]*(?:sources|källor|kallor)\b[ \t]*\**[ \t]*:?[ \t]*\**[ \t]*(?:\n|$)/i;

// One entry of a source list: a bracketed number and a URL on the same line.
// Deliberately loose about what sits between them — the model's own list is
// its own formatting, and this only has to answer "is there a list here".
const SOURCE_ENTRY = /(^|\n)[ \t]*(?:[-*+][ \t]*)?\[\d{1,3}\][^\n]*https?:\/\//i;

// The synthesis prompt already asks for its own "Sources:" list, so only add a
// structured one when the answer text doesn't already carry it — guarantees
// an MCP consumer always gets the source list without double-printing it.
/**
 * @param {string} text
 * @param {SourceEntry[]} sources
 * @returns {string}
 */
export function withSources(text, sources) {
  if (!sources?.length) return text;
  // A heading is not a list. Long generations on this catalogue are recorded
  // stopping early — cleanly, well under the token cap — sometimes right after
  // writing "Sources:" and sometimes mid-URL inside it
  // (tests/EVAL-BENCH-FINDINGS.md). Suppressing on the heading alone would
  // hand an MCP caller an answer with no usable sources at all, which is a
  // worse failure than the double-printing this check exists to stop. So both
  // must hold: the answer says it has a list AND at least one entry survived.
  if (SOURCE_HEADING.test(text) && SOURCE_ENTRY.test(text)) return text;
  const list = sources.map((s) => `[${s.n}] ${s.title} — ${s.url}`).join("\n");
  return `${text}\n\nSources:\n${list}`;
}
