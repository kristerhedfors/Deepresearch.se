// @ts-check
// Sanitized markdown rendering, wrapping the vendored globals `marked` and
// `DOMPurify` (loaded as classic scripts before the app module). Falls back
// to plain text if either is missing.

/**
 * Repairs a class of malformed markdown some answer models emit — GLM-4.7 in
 * particular streamed a whole GFM table with its rows JOINED by "||" and no
 * blank line before it, so CommonMark rendered it as literal "| … |" text
 * instead of a table (the reported bug). This normalizes ONLY tables and is
 * a no-op on well-formed markdown (and on text with no table at all), so it's
 * safe to run on every render. Pure (no DOM) — unit-tested in Node.
 * @param {string} text
 * @returns {string}
 */
export function normalizeLlmMarkdown(text) {
  if (typeof text !== "string" || !text) return text;
  // Anchor on a GFM separator row (|---|---|): without one there's no table
  // to repair, so leave the text completely untouched.
  if (!/\|\s*:?-{2,}:?\s*\|/.test(text)) return text;

  // (a) A whole table emitted on one line, rows joined by "||": split each
  //     row onto its own line. "||" is not meaningful in prose, and we've
  //     already confirmed a table is present, so this is safe.
  const out = text.replace(/\|\|/g, "|\n|");

  // (b) Line pass: break a table header glued to the end of the preceding
  //     paragraph, and guarantee a blank line before the table — CommonMark
  //     only starts a table block when one precedes it.
  const isSep = (/** @type {string} */ l) => /^\s*\|(\s*:?-{2,}:?\s*\|)+\s*$/.test(l);
  const isRow = (/** @type {string} */ l) => /^\s*\|.*\|\s*$/.test(l);
  const lines = out.split("\n");
  /** @type {string[]} */
  const result = [];
  const pushBlankBefore = () => {
    if (result.length && result[result.length - 1].trim() !== "") result.push("");
  };
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const nextIsSep = i + 1 < lines.length && isSep(lines[i + 1]);
    if (nextIsSep && !isRow(l)) {
      // Prose then a header row on the same line ("…text| a | b |"): split.
      const m = l.match(/^(.*?\S)\s*(\|(?:[^|\n]*\|)+)\s*$/);
      if (m) {
        result.push(m[1], "", m[2]);
        continue;
      }
    }
    if (nextIsSep && isRow(l)) pushBlankBefore(); // clean header, ensure blank line before
    result.push(l);
  }
  return result.join("\n");
}

/**
 * Render markdown into an element, sanitized; plain text when the vendored
 * libs are missing.
 * @param {HTMLElement} el
 * @param {string} text
 */
export function renderMarkdownInto(el, text) {
  // The vendored classic-script globals aren't in lib.dom's Window type.
  const { marked, DOMPurify } = /** @type {any} */ (window);
  if (!(marked && DOMPurify)) {
    el.textContent = text;
    return;
  }
  // FORBID img: beyond XSS, a rendered <img> from answer text would fire
  // third-party requests (tracking pixels) — sources stay links.
  el.innerHTML = DOMPurify.sanitize(marked.parse(normalizeLlmMarkdown(text)), { FORBID_TAGS: ["img"] });
  for (const a of el.querySelectorAll("a")) {
    a.target = "_blank";
    a.rel = "noopener";
  }
}
