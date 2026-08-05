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
  let omitted = 0;
  // Reserve room for the marker up front, so telling the truth about the
  // truncation can never push the digest past the cap the budget planner sized
  // the prompt against. Skipped when the cap could not afford the reserve —
  // at that size (test fixtures; the real caps are 14 000 and up) fitting a
  // source at all matters more than the marker's own budget.
  const budget = capChars > MARKER_RESERVE * 2 ? capChars - MARKER_RESERVE : capChars;
  for (const s of sources) {
    const block = `[${s.n}] ${s.title}\n${s.url}\n${(s.highlights || []).join(" … ")}`.trim();
    if (used + block.length > budget) {
      // `continue`, not `break`. One source with unusually long highlights
      // used to hide EVERY source after it, however short — and the entries
      // are numbered explicitly, so a gap in the sequence costs the reader
      // nothing while a truncated tail costs the answer its grounding.
      omitted++;
      continue;
    }
    blocks.push(block);
    used += block.length + 2;
  }
  const digest = blocks.join("\n\n");
  if (!omitted) return digest;
  // Say it out loud. Silently handing over a partial list invites an answer
  // that claims coverage it does not have, and leaves the validation phase
  // reconciling citations against a list it cannot see all of. At the common
  // budget tier the registry can hold ~32 sources against an 18 000-char cap,
  // so this is a routine truncation, not an edge case.
  return `${digest}\n\n${truncationMarker(omitted)}`;
}

// Sized against the longest string truncationMarker can produce, so the
// reserve above is always enough.
const MARKER_RESERVE = 260;

/** @param {number} omitted */
function truncationMarker(omitted) {
  return (
    `[… ${omitted} further collected source${omitted === 1 ? "" : "s"} omitted here for length. ` +
    `Cite only the numbers listed above, and do not treat this list as the complete evidence ` +
    `base or conclude that a topic is uncovered merely because it is absent from it.]`
  );
}

// How many of `sources` a digest at this cap actually carries — the counter
// the log needs so a request stops reporting the registry size as if it were
// what the model read.
/**
 * @param {SourceEntry[]} sources
 * @param {number} capChars
 * @returns {number}
 */
export function digestShownCount(sources, capChars) {
  const digest = sourceDigest(sources, capChars);
  if (!digest) return 0;
  const blocks = digest.split("\n\n").length;
  return digest.includes("further collected source") ? blocks - 1 : blocks;
}

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
  if (SOURCE_HEADING.test(text)) return text;
  const list = sources.map((s) => `[${s.n}] ${s.title} — ${s.url}`).join("\n");
  return `${text}\n\nSources:\n${list}`;
}
