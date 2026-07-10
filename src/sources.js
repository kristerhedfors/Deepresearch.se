// @ts-check
// The cross-search source registry: every search result the pipeline
// collects lands here — deduped by URL, numbered in arrival order so [n]
// citations stay stable between synthesis and validation, and diversity-
// capped per domain. Pure data logic (no fetches, no model calls), extracted
// from pipeline.js so the registry rules are readable and testable on their
// own (sources.test.js).

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
// in prompts.js (triagePrompt's mandatory independent-source query,
// gapPrompt's dominance check) — belt and suspenders, not either/or.
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
  for (const item of items || []) {
    if (!item?.url || state.byUrl.has(item.url)) continue;
    if (state.sources.length >= state.plan.maxSources) return;
    const key = diversityKeyOf(item.url);
    const count = state.domainCounts.get(key) || 0;
    if (count >= DOMAIN_CAP) {
      state.sourceOverflow.push(item);
      continue;
    }
    state.domainCounts.set(key, count + 1);
    pushSource(state, item);
  }
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

// The numbered-source block handed to the gap-check / synthesis / validation
// prompts, bounded to capChars (the budget plan's digestCap).
/**
 * @param {SourceEntry[]} sources
 * @param {number} capChars
 * @returns {string}
 */
export function sourceDigest(sources, capChars) {
  const blocks = [];
  let used = 0;
  for (const s of sources) {
    const block = `[${s.n}] ${s.title}\n${s.url}\n${(s.highlights || []).join(" … ")}`.trim();
    if (used + block.length > capChars) break;
    blocks.push(block);
    used += block.length + 2;
  }
  return blocks.join("\n\n");
}
