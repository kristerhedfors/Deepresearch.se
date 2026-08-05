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
  return buildDigest(sources, capChars).digest;
}

// How many of `sources` a digest at this cap actually carries — the counter
// the log needs so a request stops reporting the registry size as if it were
// what the model read. Read straight off the builder rather than re-derived by
// splitting the rendered text on blank lines: a web highlight can itself
// contain a blank line, and the split-based count read those as extra sources.
/**
 * @param {SourceEntry[]} sources
 * @param {number} capChars
 * @returns {number}
 */
export function digestShownCount(sources, capChars) {
  return buildDigest(sources, capChars).shown;
}

// Two chars per block for the "\n\n" join. Counted for the LAST block too:
// deliberately conservative, so the accounting can only ever under-fill.
const SEP_CHARS = 2;

// The smallest slice of the budget a single source is allowed to be squeezed
// into before we stop squeezing and start dropping instead. Below roughly this
// much there is no excerpt left worth reading — a numbered heading, a URL, and
// a sentence fragment — and a wall of stubs is a worse prompt than a shorter
// list of sources the model can actually weigh. When even this floor doesn't
// fit, the loop below falls back to the old drop-and-report behaviour.
const MIN_SHARE = 320;

// Below this many characters an excerpt says nothing; hand over the heading
// and URL alone rather than three words and an ellipsis.
const MIN_TAIL = 40;

// Explicit, and inside the block so the model attributes the cut to THAT
// source rather than to the list.
const CLIP_MARK = " […]";

// Splitting the block in two is what makes a fair share possible at all: the
// head (`[n] title` + URL) is the part that makes a source citable and is
// never cut, the tail (its highlights) is the part that can be.
/**
 * @param {SourceEntry} s
 * @returns {{ head: string, tail: string, len: number }}
 */
function blockParts(s) {
  const head = `[${s.n}] ${s.title}\n${s.url}`;
  const highlights = Array.isArray(s.highlights) ? s.highlights : [];
  const tail = highlights.join(" … ").trim();
  return { head, tail, len: tail ? head.length + 1 + tail.length : head.length };
}

// What one source costs the digest at a given per-source share.
/**
 * @param {{ len: number }[]} parts
 * @param {number} share
 * @returns {number}
 */
function costAt(parts, share) {
  let sum = 0;
  for (const p of parts) sum += Math.min(p.len, share) + SEP_CHARS;
  return sum;
}

// The largest per-source share the budget can afford for EVERY source —
// max-min fairness, the same water-filling a link scheduler does: sources
// shorter than the share pay only what they use and leave their slack to the
// long ones, so a registry of mostly-short blocks with a few monsters still
// gives the monsters most of what they asked for. Returns the longest block
// when nothing needs clipping (the common case: no behaviour change at all),
// and MIN_SHARE when even the floor cannot fit — the caller then drops.
/**
 * @param {{ len: number }[]} parts
 * @param {number} budget
 * @returns {number}
 */
function fairShare(parts, budget) {
  let hi = 0;
  let total = 0;
  for (const p of parts) {
    if (p.len > hi) hi = p.len;
    total += p.len + SEP_CHARS;
  }
  if (total <= budget) return hi;
  if (costAt(parts, MIN_SHARE) > budget) return MIN_SHARE;
  let lo = MIN_SHARE;
  while (lo < hi) {
    const mid = lo + Math.ceil((hi - lo) / 2);
    if (costAt(parts, mid) <= budget) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

// Renders one source at most `share` chars, cutting the highlights only.
/**
 * @param {{ head: string, tail: string }} part
 * @param {number} share
 * @returns {string}
 */
function renderBlock(part, share) {
  const { head, tail } = part;
  const full = tail ? `${head}\n${tail}` : head;
  if (full.length <= share) return full;
  const room = share - head.length - 1 - CLIP_MARK.length;
  if (room < MIN_TAIL) return head;
  return `${head}\n${tail.slice(0, room)}${CLIP_MARK}`;
}

// Builds the digest and reports what it carries.
//
// Filling the budget in pure arrival order was a real production defect
// (feedback #61 / chat_logs #1656): a 600-second run collected 35 sources of
// which [1]-[13] happened to be biomedical records — title, provenance,
// authors and a 900-char abstract, ~1 300 chars each — and those thirteen ate
// the whole 18 000-char window. Synthesis never saw [14]-[35], where the
// alumni page, the trade press and the interview that actually answered the
// question were, and the answer then stated in good faith that no independent
// coverage existed among the numbered sources. The earlier `break`→`continue`
// fix does not touch this case: each of those blocks fits on its own; it is
// their SUM that starves the tail. Arrival order is not relevance order —
// whichever auxiliary source happens to return first should not decide what
// the model gets to read.
//
// So the budget is shared rather than raced for: every source is bounded to a
// fair share of it (fairShare above), and a block over that share has its
// EXCERPT clipped with an explicit marker instead of the source disappearing.
// A source the model can see and cite, with a shortened excerpt, beats one it
// cannot see at all — and the citation numbers stay exactly as they were,
// since nothing is reordered or renumbered. Dropping is still the last resort,
// still reported by the same marker, and the cap is still never exceeded.
/**
 * @param {SourceEntry[]} sources
 * @param {number} capChars
 * @returns {{ digest: string, shown: number, omitted: number }}
 */
function buildDigest(sources, capChars) {
  /** @type {{ head: string, tail: string, len: number }[]} */
  const parts = [];
  for (const s of Array.isArray(sources) ? sources : []) {
    // Fail soft, per source: one malformed entry must not cost the prompt its
    // whole evidence base.
    try {
      if (s) parts.push(blockParts(s));
    } catch {
      /* skip it */
    }
  }
  if (!parts.length) return { digest: "", shown: 0, omitted: 0 };
  // Reserve room for the marker up front, so telling the truth about the
  // truncation can never push the digest past the cap the budget planner sized
  // the prompt against. Skipped when the cap could not afford the reserve —
  // at that size (test fixtures; the real caps are 14 000 and up) fitting a
  // source at all matters more than the marker's own budget.
  const cap = Number.isFinite(capChars) ? capChars : Infinity;
  const budget = cap > MARKER_RESERVE * 2 ? cap - MARKER_RESERVE : cap;
  const share = fairShare(parts, budget);
  const blocks = [];
  let used = 0;
  let omitted = 0;
  for (const part of parts) {
    const block = renderBlock(part, share);
    if (used + block.length > budget) {
      // `continue`, not `break`. One source with unusually long highlights
      // used to hide EVERY source after it, however short — and the entries
      // are numbered explicitly, so a gap in the sequence costs the reader
      // nothing while a truncated tail costs the answer its grounding.
      omitted++;
      continue;
    }
    blocks.push(block);
    used += block.length + SEP_CHARS;
  }
  const digest = blocks.join("\n\n");
  if (!omitted) return { digest, shown: blocks.length, omitted: 0 };
  // Say it out loud. Silently handing over a partial list invites an answer
  // that claims coverage it does not have, and leaves the validation phase
  // reconciling citations against a list it cannot see all of.
  const marker = truncationMarker(omitted);
  return {
    digest: digest ? `${digest}\n\n${marker}` : marker,
    shown: blocks.length,
    omitted,
  };
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
