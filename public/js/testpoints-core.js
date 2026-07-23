// @ts-check
// Testable interaction points — the client PURE core (Node-tested in
// public/js/testpoints-core.test.js). The DOM/UI half is public/js/testpoints.js;
// everything import-safe outside a browser lives here.
//
// A "test point" is a declared, linkable place in the app to try a fix (see
// src/testpoints.js and the **testable-interaction-points** skill). This
// module holds the deep-link URL plumbing and the client's view of the
// action grammar — the set of actions THIS build can execute — so an
// unknown action (a point authored against a newer grammar) is surfaced as
// "N steps this build can't run" rather than silently ignored.

// The query param carrying a point id into a landing page.
export const TRY_PARAM = "try";

// Use-case identity — the #UC-<id> tag (owner directive, 2026-07-19). Mirror
// of src/testpoints.js useCaseTag/parseUseCaseRef — keep the two in lockstep.
// The client uses useCaseTag to prepend the tag to a point's composed starter
// prompt (testpoints.js compose action) so a run carries its use-case number;
// the server reads it back off a "feedback #UC-<id> …" message.

/**
 * The canonical display tag for a use case (test point id).
 * @param {number|string} id
 * @returns {string}
 */
export function useCaseTag(id) {
  return `#UC-${id}`;
}

const FEEDBACK_LEAD_RE =
  /^\s*(?:feedback|återkoppling(?:en)?|synpunkt(?:er|en|erna)?)\b[\s:,.\-–—]*/i;
const USE_CASE_REF_RE = /^(?:#?\s*uc[\s\-]?0*(\d{1,6})|#0*(\d{1,6}))\b/i;

/**
 * Read a use-case reference out of a feedback message (EN + SV parity).
 * Mirror of src/testpoints.js parseUseCaseRef.
 * @param {unknown} text
 * @returns {{ id: number, tag: string } | null}
 */
export function parseUseCaseRef(text) {
  if (typeof text !== "string" || !text) return null;
  const body = text.replace(FEEDBACK_LEAD_RE, "");
  const m = body.match(USE_CASE_REF_RE);
  if (!m) return null;
  const id = Number(m[1] || m[2]);
  return Number.isInteger(id) && id > 0 ? { id, tag: useCaseTag(id) } : null;
}

/**
 * Prepend a use-case tag to a composed starter prompt, once. A prompt that
 * already opens with the tag (author baked it into the compose text) is left
 * as-is, so the tag never doubles up.
 * @param {number|string} id
 * @param {string} text
 * @returns {string}
 */
export function tagStarterPrompt(id, text) {
  const tag = useCaseTag(id);
  const body = typeof text === "string" ? text : "";
  const ref = parseUseCaseRef(body);
  if (ref && ref.id === Number(id)) return body; // already tagged
  return body ? `${tag} ${body}` : tag;
}

// The action types the client executor (testpoints.js) can run. Keep in
// lockstep with ACTION_TYPES in src/testpoints.js and the grammar table in
// the skill.
export const CLIENT_ACTION_TYPES = [
  "note",
  "openAccount",
  "openSettings",
  "openProjects",
  "openHistory",
  "newChat",
  "compose",
  "setSearch",
  "setBudget",
  "selectModel",
  "highlight",
];

// Parse the try-point id out of a location search string ("?try=5&x=1").
// Returns a positive integer, or null when absent/malformed.
/**
 * @param {string} search a URL search string (with or without leading "?")
 * @returns {number | null}
 */
export function parseTryId(search) {
  if (typeof search !== "string" || !search) return null;
  let params;
  try {
    params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  } catch {
    return null;
  }
  const raw = params.get(TRY_PARAM);
  if (raw == null) return null;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

// Remove the try param from a full URL string, preserving everything else —
// used to clean the address bar (history.replaceState) once the banner has
// opened, so a reload doesn't reopen it.
/**
 * @param {string} href a full URL
 * @returns {string} the href without ?try=
 */
export function stripTryParam(href) {
  try {
    const u = new URL(href);
    u.searchParams.delete(TRY_PARAM);
    return u.toString();
  } catch {
    return href;
  }
}

// Merge ?try=<id> into a target path (mirror of src/testpoints.js deepLink),
// preserving the target's own query/hash.
/**
 * @param {string} target
 * @param {number|string} id
 * @returns {string}
 */
export function deepLink(target, id) {
  const [head, hash = ""] = String(target).split("#");
  const sep = head.includes("?") ? "&" : "?";
  const withTry = `${head}${sep}${TRY_PARAM}=${encodeURIComponent(String(id))}`;
  return hash ? `${withTry}#${hash}` : withTry;
}

// Normalize a point's target to its pathname — the "does this point live on
// the current page?" question the queue, the go-navigation, and the
// advance-to-next flow all ask. Falls back to the raw string when the target
// doesn't parse as a URL.
/**
 * @param {string} target a point's target path
 * @param {string} [origin] the origin to resolve relative paths against
 * @returns {string}
 */
export function targetPath(target, origin = "https://local.invalid") {
  try {
    return new URL(String(target), origin).pathname;
  } catch {
    return String(target);
  }
}

// The guidance texts carried by a point's `note` actions — rendered as
// read-before-you-go steps in the queue's detail view (a `note` has no side
// effect, so it is the one action whose content IS the explanation).
/**
 * @param {any[]} actions
 * @returns {string[]}
 */
export function noteTexts(actions) {
  const out = [];
  for (const a of Array.isArray(actions) ? actions : []) {
    if (a && typeof a === "object" && a.type === "note" && typeof a.text === "string" && a.text.trim()) {
      out.push(a.text.trim());
    }
  }
  return out;
}

// Split a point's actions into the ones this build can run and the ones it
// can't (unknown type). Pure — the executor runs `known`, the banner can
// warn about `unknown.length`.
/**
 * @param {any[]} actions
 * @returns {{ known: any[], unknown: any[] }}
 */
export function partitionActions(actions) {
  const known = [];
  const unknown = [];
  for (const a of Array.isArray(actions) ? actions : []) {
    if (a && typeof a === "object" && CLIENT_ACTION_TYPES.includes(a.type)) known.push(a);
    else unknown.push(a);
  }
  return { known, unknown };
}

// ---- queue quick-search (filter + highlight) ------------------------------
//
// The Test queue can carry dozens of use cases, so the overlay offers a
// substring filter. These three pure helpers back it: `useCaseHaystack`
// builds the text a point is matched against, `filterUseCases` narrows a
// list to the matches, and `highlightSegments` splits a string into
// plain/matched runs so the UI can wrap matches in <mark> WITHOUT innerHTML
// (segments are rendered as textContent — never HTML — so a point's label or
// target can't inject markup). All matching is case-insensitive on the
// trimmed query; a blank query is a no-op (list unchanged, nothing marked).

/**
 * The searchable text for one test point — its #UC tag, label, and target
 * joined with spaces. Non-string fields are skipped.
 * @param {any} point
 * @returns {string}
 */
export function useCaseHaystack(point) {
  if (!point || typeof point !== "object") return "";
  return [useCaseTag(point.id), point.label, point.target]
    .filter((s) => typeof s === "string" && s)
    .join(" ");
}

/**
 * Narrow a queue to the points whose haystack contains the query substring
 * (case-insensitive). A blank/whitespace query returns a shallow copy of the
 * whole list.
 * @param {any[]} list
 * @param {string} query
 * @returns {any[]}
 */
export function filterUseCases(list, query) {
  const arr = Array.isArray(list) ? list : [];
  const q = typeof query === "string" ? query.trim().toLowerCase() : "";
  if (!q) return arr.slice();
  return arr.filter((p) => useCaseHaystack(p).toLowerCase().includes(q));
}

/**
 * Split `text` into alternating plain / matched segments for the given query
 * (case-insensitive, every occurrence). Returns `{ text, match }[]`; a blank
 * text yields `[]`, a blank query yields a single non-matching segment. The
 * caller renders each segment's `text` as textContent, wrapping `match` ones
 * in a highlight element.
 * @param {string} text
 * @param {string} query
 * @returns {{ text: string, match: boolean }[]}
 */
export function highlightSegments(text, query) {
  const s = typeof text === "string" ? text : "";
  if (!s) return [];
  const needle = (typeof query === "string" ? query.trim() : "").toLowerCase();
  if (!needle) return [{ text: s, match: false }];
  const lower = s.toLowerCase();
  const segs = [];
  let i = 0;
  let idx;
  while ((idx = lower.indexOf(needle, i)) !== -1) {
    if (idx > i) segs.push({ text: s.slice(i, idx), match: false });
    segs.push({ text: s.slice(idx, idx + needle.length), match: true });
    i = idx + needle.length;
  }
  if (i < s.length) segs.push({ text: s.slice(i), match: false });
  return segs;
}

// Pick the next point to test from a queue: the first `open` one, optionally
// skipping an id just acted on. Returns null when the queue is drained.
/**
 * @param {any[]} queue projected test points (newest-first from the API)
 * @param {number|null} [excludeId]
 * @returns {any | null}
 */
export function nextOpenPoint(queue, excludeId = null) {
  if (!Array.isArray(queue)) return null;
  // Oldest-first so the tester works the backlog in declaration order (the
  // API returns newest-first).
  const open = queue.filter((p) => p && p.status === "open" && p.id !== excludeId);
  open.sort((a, b) => a.id - b.id);
  return open[0] || null;
}
