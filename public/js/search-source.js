// @ts-check
// WHO runs your web searches — the per-user search-SOURCE preference, shared by
// both tiers and surfaced as ONE settings knob: "Exa web search".
//
// The composer's web knob answers exactly one question — "should this question
// be researched live?" — and nothing else (owner directive, 2026-07-26). WHO
// does the searching is a configuration decision, so it lives in Settings:
//
//   Exa web search ON (default)   searches run on Exa, a hosted research index
//                                 — the strongest results, and a third party
//                                 that retains the query.
//   Exa web search OFF            this site's own Cloudflare Worker does the
//                                 searching (src/websearch-cf.js): it fetches a
//                                 no-JS SERP and the result pages from
//                                 Cloudflare's edge. No search API, no
//                                 third-party account, nothing retained by one
//                                 — at the cost of ranking quality, since it
//                                 reads a public SERP rather than a
//                                 research-grade index.
//
// The knob is a boolean; the WIRE value is unchanged — the two ids below are
// the server's USER_SEARCH_SOURCES (src/websearch-backends.js) verbatim, and
// the server re-validates the string it receives and ignores anything else, so
// this module is a preference, never a trust boundary. A self-hosted backend is
// deliberately NOT one of them — it names an operator's own service and stays
// an admin (Se/rver) or settings-drawer (Se/cure) decision.
//
// The pick is a browser-local preference (localStorage, this device): it is a
// preference about where a query goes, not conversation content, and Se/cure
// keeps it out of the sealed workspace state for the same reason the grant
// toggles are — nothing about it should travel in a shared workspace link.

/** Exa, the default: the hosted research index. */
export const EXA_SOURCE = "exa";
/** This site's own Worker — where searches go when Exa is switched off. */
export const WORKER_SOURCE = "cloudflare";

/** The two source ids the server accepts, in display order. */
export const SEARCH_SOURCES = [EXA_SOURCE, WORKER_SOURCE];

export const DEFAULT_SEARCH_SOURCE = EXA_SOURCE;
// The localStorage key. Prefixed like the rest of this project's client keys.
export const SEARCH_SOURCE_KEY = "dr_search_source";

/**
 * Coerces any value to a known source id, or "" when it is not one. Pure — the
 * mirror of the server's normalizeSearchSource.
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeSearchSource(value) {
  const v = typeof value === "string" ? value.trim().toLowerCase() : "";
  return SEARCH_SOURCES.includes(v) ? v : "";
}

/**
 * This device's stored source, defaulting to Exa. Never throws — a browser with
 * storage disabled just gets the default.
 * @returns {string}
 */
export function getSearchSource() {
  try {
    return normalizeSearchSource(localStorage.getItem(SEARCH_SOURCE_KEY)) || DEFAULT_SEARCH_SOURCE;
  } catch {
    return DEFAULT_SEARCH_SOURCE;
  }
}

/**
 * Stores a source. Unknown ids are ignored rather than stored. Never throws.
 * @param {string} id
 * @returns {string} the effective source after the write
 */
export function setSearchSource(id) {
  const next = normalizeSearchSource(id) || DEFAULT_SEARCH_SOURCE;
  try {
    localStorage.setItem(SEARCH_SOURCE_KEY, next);
  } catch {
    /* storage disabled: the pick just doesn't persist */
  }
  return next;
}

/**
 * The settings knob's state: is Exa web search enabled on this device? True by
 * default — anything other than Exa means the Worker backend.
 * @returns {boolean}
 */
export function getExaEnabled() {
  return getSearchSource() === EXA_SOURCE;
}

/**
 * Flips the settings knob. Off means the Worker does the searching.
 * @param {boolean} on
 * @returns {boolean} the effective state after the write
 */
export function setExaEnabled(on) {
  return setSearchSource(on ? EXA_SOURCE : WORKER_SOURCE) === EXA_SOURCE;
}

/**
 * The knob's info-popover text, shared by both tiers so the explanation of what
 * switching Exa off actually does is written once. HTML, in the same
 * `<strong>` + `<b>On:</b>/<b>Off:</b>` shape as the other settings popovers.
 */
export const EXA_SETTING_INFO = `<strong>Exa web search</strong><br>
  <b>On (default):</b> live web searches run on
  <a href="https://exa.ai" target="_blank" rel="noopener">Exa</a>, a hosted
  research index — the strongest results. Only the search query is sent; Exa
  retains it by default.<br>
  <b>Off:</b> this site's own Cloudflare Worker does the searching instead — it
  reads a public results page and the result pages themselves from Cloudflare's
  edge. No search company is involved and no search account retains the query;
  ranking is weaker than Exa's.<br>
  Either way this is only about <b>who</b> runs a search. Whether a question is
  researched live at all stays the web knob next to the composer.`;

/**
 * The status line under the knob, per state. Shared for the same reason the
 * popover text is.
 * @param {boolean} on
 * @returns {string}
 */
export function exaStatusText(on) {
  return on
    ? "Exa is on — live web searches run on Exa's hosted index."
    : "Exa is off — searches run from this site's own Cloudflare Worker instead.";
}
