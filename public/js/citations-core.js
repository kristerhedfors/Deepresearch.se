// @ts-check
// Deterministic reconciliation of an answer's `[n]` markers against the
// numbered source registry that produced it.
//
// Until now nothing in either tier did this. `public/js/markdown.js`
// extracts `[n]` to build anchors and SILENTLY LEAVES an unknown bracket as
// plain text; `validatePrompt` asks a 24B model to eyeball every marker as
// one of four checks in a single JSON call. So a `[7]` in a six-source answer
// — a citation the reader cannot follow, and indistinguishable from a
// fabricated one — reached the user unremarked and unlogged.
//
// This is the cheap half of that problem: which numbers were cited, which of
// them exist, and which retrieved sources went unused. It costs no model call
// and cannot fail the request — every function here is pure and total.
//
// What it deliberately does NOT do is edit anything. A dangling marker is a
// FINDING, handed to the validation phase and the log. Deterministically
// stripping a citation would mean deleting the one signal that says the answer
// went wrong, which is the opposite of the point.
//
// Shared core (CLAUDE.md "Code layout"): Se/cure imports this module directly
// in the browser, the Worker re-exports it through `src/citations.js`.

// The closing source list, as every report tier's structure asks for it
// ("End with a 'Sources:' section"). Matched through the heading decorations
// models actually write — `### Sources:`, `**Sources:**`, `- Sources:` — and
// in Swedish as well as English, because a Swedish answer ends with `Källor:`
// and a gate that only knows the English form silently treats the whole list
// as body prose (CLAUDE.md invariant 6).
const SOURCES_HEADING = /(^|\n)[ \t]*(?:[#>*_\-–—]|\d+[.)])*[ \t]*\**[ \t]*(?:sources|källor|kallor)\b[ \t]*\**[ \t]*:?[ \t]*\**[ \t]*(?:\n|$)/gi;

/**
 * Split an answer into the prose that makes claims and the source list that
 * backs them. The LAST heading wins: an answer that discusses its sources
 * mid-text and then lists them still splits at the list.
 *
 * @param {string} text
 * @returns {{ body: string, tail: string }}
 */
export function splitSourcesTail(text) {
  const s = String(text ?? "");
  SOURCES_HEADING.lastIndex = 0;
  let at = -1;
  let m;
  while ((m = SOURCES_HEADING.exec(s))) at = m.index;
  return at < 0 ? { body: s, tail: "" } : { body: s.slice(0, at), tail: s.slice(at) };
}

/**
 * Every distinct `[n]` marker in a chunk of text, ascending.
 * @param {string} text
 * @returns {number[]}
 */
export function citationNumbers(text) {
  /** @type {Set<number>} */
  const seen = new Set();
  for (const m of String(text ?? "").matchAll(/\[(\d{1,3})\]/g)) seen.add(Number(m[1]));
  return [...seen].sort((a, b) => a - b);
}

/**
 * Reconcile an answer against the registry it was written from.
 *
 * - `dangling` — cited in the prose, absent from the registry. A hard error
 *   signal: the answer points at a source that does not exist.
 * - `unused` — retrieved and numbered, never cited. NOT an error (the
 *   diversity cap and the digest bound both mean some sources legitimately go
 *   uncited) — it is the retrieval-efficiency number, how much of what we paid
 *   to fetch reached the answer.
 * - `listed` — parsed from the printed tail, so an answer that cites `[7]`
 *   without listing it is visible too.
 *
 * @param {string} text the full answer, body and source list
 * @param {{ n: number }[]} sources the numbered registry (state.sources)
 */
export function citationAudit(text, sources) {
  const known = new Set(
    (Array.isArray(sources) ? sources : []).map((s) => Number(s?.n)).filter((n) => Number.isFinite(n)),
  );
  const { body, tail } = splitSourcesTail(text);
  const cited = citationNumbers(body);
  const listed = citationNumbers(tail);
  return {
    cited,
    listed,
    dangling: cited.filter((n) => !known.has(n)),
    unused: [...known].filter((n) => !cited.includes(n)).sort((a, b) => a - b),
  };
}

/**
 * The line handed to the fact-checker when the audit found something.
 *
 * This is the whole reason the audit runs BEFORE validation rather than after
 * it. `validatePrompt`'s check (2) — "every [n] citation and URL matches the
 * provided source list" — asks a small model to scan every bracket in an
 * 8 KB report while also doing three other checks. Here the work is already
 * done, exactly, for free: the prompt stops asking the model to FIND the
 * problem and hands it the numbers.
 *
 * Empty string when there is nothing to say, so the prompt is byte-identical
 * to today on the answers that are already clean.
 *
 * @param {{ dangling: number[] }} audit
 * @returns {string}
 */
export function citationNote(audit) {
  const dangling = audit?.dangling || [];
  if (!dangling.length) return "";
  const list = dangling.map((n) => `[${n}]`).join(", ");
  return (
    `Deterministic citation check (already performed, treat as ground truth): the draft cites ` +
    `${list}, which ${dangling.length === 1 ? "is" : "are"} NOT in the numbered source list above. ` +
    `Each one must be corrected to a source that is listed, or the claim removed.\n\n`
  );
}
