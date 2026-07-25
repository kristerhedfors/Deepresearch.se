// @ts-check
// WHO runs your web searches — the per-user search-SOURCE choice behind the web
// knob's long-press card (UX-10), shared by both tiers.
//
// The knob has always answered "should this question be researched live?". It
// never answered "and who does the searching?" — the answer was Exa, silently,
// for everyone. It no longer has to be: src/websearch-cf.js makes this site's
// own Cloudflare Worker a search engine, so the same long-press card that
// explains the knob now also lets a person choose between them:
//
//   exa         the default. A hosted third-party index — the best results,
//               and a third party that retains the query.
//   cloudflare  this site's Worker does the searching itself: it fetches a
//               no-JS SERP and the result pages from Cloudflare's edge. No
//               search API, no third-party account, nothing retained by one —
//               at the cost of ranking quality, since it reads a public SERP
//               rather than a research-grade index.
//
// The two ids are the server's USER_SEARCH_SOURCES (src/websearch-backends.js)
// verbatim; the server re-validates the string it receives and ignores anything
// else, so this module is a preference, never a trust boundary. A self-hosted
// backend is deliberately NOT here — it names an operator's own service and
// stays an admin (Se/rver) or settings-drawer (Se/cure) decision.
//
// The pick is a browser-local preference (localStorage, this device): it is a
// preference about where a query goes, not conversation content, and Se/cure
// keeps it out of the sealed workspace state for the same reason the grant
// toggles are — nothing about it should travel in a shared workspace link.

/** @typedef {{ id: string, label: string, note: string }} SearchSourceOption */

/**
 * The user-selectable sources, in display order. Exa first because it is the
 * default; the ids match the server's allowlist exactly.
 * @type {SearchSourceOption[]}
 */
export const SEARCH_SOURCES = [
  {
    id: "exa",
    label: "Exa",
    note: "A hosted research index — the strongest results. Exa receives the search query and retains it.",
  },
  {
    id: "cloudflare",
    label: "This site's Worker",
    note: "Searches run from our own Cloudflare Worker: a public results page plus the pages themselves, read at the edge. No search company involved; ranking is weaker than Exa's.",
  },
];

export const DEFAULT_SEARCH_SOURCE = "exa";
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
  return SEARCH_SOURCES.some((s) => s.id === v) ? v : "";
}

/**
 * This device's stored pick, defaulting to Exa. Never throws — a browser with
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
 * Stores a pick. Unknown ids are ignored rather than stored. Never throws.
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
 * The picker markup for a knob popover — a radio group, so a tap picks and the
 * card stays readable at composer size. Pure (string in, string out) so it
 * unit-tests without a DOM.
 * @param {string} selected the currently effective source id
 * @param {string} [name] radio group name (distinct per tier so the two cards
 *   never share a group if both are ever on one page)
 * @returns {string}
 */
export function searchSourcePickerHtml(selected, name = "searchsrc") {
  const active = normalizeSearchSource(selected) || DEFAULT_SEARCH_SOURCE;
  const rows = SEARCH_SOURCES.map(
    (s) => `<label class="srcopt">
      <input type="radio" name="${name}" value="${s.id}"${s.id === active ? " checked" : ""}>
      <span><b>${s.label}</b><br><span class="srcnote">${s.note}</span></span>
    </label>`,
  ).join("");
  return `<div class="srcpick" role="radiogroup" aria-label="Who runs the web searches">${rows}</div>`;
}

/**
 * Wires a rendered picker: every change reports the new source id. Returns a
 * no-op when the markup isn't there (a stale cached page), so a caller never
 * has to guard.
 * @param {Element | null} root the element the picker markup was rendered into
 * @param {(id: string) => void} onPick
 * @returns {void}
 */
export function wireSearchSourcePicker(root, onPick) {
  const inputs = root ? root.querySelectorAll(".srcpick input[type=radio]") : [];
  for (const input of inputs) {
    input.addEventListener("change", () => {
      const el = /** @type {HTMLInputElement} */ (input);
      if (el.checked) onPick(setSearchSource(el.value));
    });
  }
}
