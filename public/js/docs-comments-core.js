// @ts-check
// The documentation reader's COMMENT MODE — pure core (owner directive,
// 2026-07-25). Dependency-free so both the /docs viewer and the Worker can
// use it, and so the format a comment is stored in is defined in exactly one
// place.
//
// WHAT A DOC COMMENT IS. The /docs viewer has two modes: read and comment
// (the Word convention). In comment mode an admin marks a passage and writes
// a note against it. The note is NOT primarily a remark about prose. This
// repo keeps documentation and implementation describing the SAME system —
// docs/CODE-LAYOUT.md mirrors src/, the docs-drift-validation loop exists to
// catch the two disagreeing — so a comment on a documented claim is an
// instruction about the system: bring the document AND the code it describes
// into agreement with what the comment says. "This clarifies how the key
// hierarchy actually works" applies to docs/ENCRYPTION.md and to
// src/history-key.js. An architectural remark on docs/ARCHITECTURE.md is a
// request to move the architecture, not to reword a paragraph. High-level
// documents bind more loosely than a module-level one — the loop weighs that
// — but the direction is the same in both.
//
// WHERE IT GOES. Nowhere new. There is ONE pipeline for free-form human
// instructions to the development loop — the feedback pipeline (src/feedback.js,
// the feedback-loop skill) — and a doc comment is an entry in it, marked with
// the "doc" SCOPE (public/js/feedback-core.js docPageTag) so the loop reads it
// as a doc⇄code coherence instruction rather than a session bug report. The
// dialogue thread, the status lifecycle, and the agent's replies are the
// pipeline's, unchanged. See docs/DECISION-BOARD-LOOPS.md §1a for the map of
// every instruction inbox and why this is not another one.
//
// ANCHORING. A comment is anchored to the text it was written against by
// QUOTING it — no ids stored in the Markdown, nothing to keep in sync with a
// file the doc pipelines rewrite. Re-locating the quote in the current
// document is how the reader puts the comment back beside its passage, and
// FAILING to locate it is the signal the admin asked for: the text this
// comment was written against has been replaced, so the card says so and the
// admin can read the agent's reply against the new wording.

/** Longest quoted passage stored with a comment. */
export const QUOTE_MAX = 600;
/** Longest section heading stored with a comment. */
export const SECTION_MAX = 200;
/** Longest note body. Sits inside FEEDBACK_CAPS.comment (4000) with the frame. */
export const NOTE_MAX = 3000;

/** The marker a truncated quote ends with. */
export const QUOTE_TRUNCATION = " […]";

/** The first line of every doc comment — what makes the type visible at a glance. */
export const DOC_COMMENT_PREFIX = "DOC COMMENT";

/**
 * A comment's anchor + note, before it becomes a feedback entry.
 * @typedef {{ path: string, section: string, quote: string, note: string }} DocComment
 */

/** @param {unknown} s */
function str(s) {
  return typeof s === "string" ? s : "";
}

/**
 * Collapse runs of whitespace so a quote taken from RENDERED text still
 * matches the Markdown source it came from (hard-wrapped lines, list
 * indentation, a soft break inside a sentence).
 * @param {unknown} s
 * @returns {string}
 */
export function normalizeQuote(s) {
  return str(s).replace(/\s+/g, " ").trim();
}

/**
 * Trim a selection to the stored quote length, marking the cut so a truncated
 * quote never reads as the whole passage.
 * @param {unknown} s
 * @returns {string}
 */
export function clipQuote(s) {
  const q = normalizeQuote(s);
  if (q.length <= QUOTE_MAX) return q;
  return q.slice(0, QUOTE_MAX - QUOTE_TRUNCATION.length).trimEnd() + QUOTE_TRUNCATION;
}

/**
 * Whether a selection is substantial enough to comment on. A stray click
 * leaves an empty or one-character selection; anchoring to that would produce
 * a comment nobody can place.
 * @param {unknown} s
 * @returns {boolean}
 */
export function isCommentableSelection(s) {
  return normalizeQuote(s).length >= 3;
}

// ---------------------------------------------------------------------------
// The stored body
// ---------------------------------------------------------------------------
//
// The whole comment lives in the feedback entry's `comment` column as ONE
// readable block. No schema change, no side table, and — the point — the
// agent loop reading `scripts/feedback` sees the document, the section, the
// exact passage and the instruction without fetching anything else:
//
//   DOC COMMENT — docs/ENCRYPTION.md
//   SECTION: The key hierarchy
//   QUOTED:
//   > the exact text the admin marked
//
//   the admin's note
//
// parseDocCommentBody is the inverse, so the reader can lay a stored entry
// back beside its passage.

/**
 * Render a doc comment into the feedback entry's comment body.
 * @param {Partial<DocComment>} c
 * @returns {string}
 */
export function buildDocCommentBody(c) {
  const path = str(c?.path).trim();
  const section = normalizeQuote(c?.section).slice(0, SECTION_MAX);
  const quote = clipQuote(c?.quote);
  const note = str(c?.note).trim().slice(0, NOTE_MAX);
  const lines = [`${DOC_COMMENT_PREFIX} — ${path || "(unknown document)"}`];
  if (section) lines.push(`SECTION: ${section}`);
  if (quote) lines.push("QUOTED:", `> ${quote}`);
  lines.push("", note);
  return lines.join("\n");
}

const BODY_RE = new RegExp(
  `^${DOC_COMMENT_PREFIX}\\s+—\\s+(.+?)\\n` + // path
    `(?:SECTION:\\s*(.*?)\\n)?` +
    `(?:QUOTED:\\n>\\s?(.*?)\\n)?` +
    `\\n([\\s\\S]*)$`,
);

/**
 * Read a stored comment body back into its parts — null when the entry is not
 * a doc comment (an ordinary feedback entry, or one written before this
 * format existed).
 * @param {unknown} body
 * @returns {DocComment | null}
 */
export function parseDocCommentBody(body) {
  const m = BODY_RE.exec(str(body).replace(/\r\n/g, "\n").trim() + "\n\n");
  if (!m) return null;
  return {
    path: m[1].trim(),
    section: (m[2] || "").trim(),
    quote: (m[3] || "").trim(),
    note: (m[4] || "").trim(),
  };
}

// ---------------------------------------------------------------------------
// Re-locating a quote in the current document
// ---------------------------------------------------------------------------

/**
 * Where a stored quote sits in the document as it reads NOW.
 *
 * `exact` — found verbatim (whitespace-normalized).
 * `partial` — only the leading part matched, which is what a TRUNCATED quote
 *   can offer and also what survives an edit to the tail of a sentence.
 * `stale` — not found: the text this comment was written against has been
 *   replaced. That is a result, not a failure — it is how the reader tells
 *   the admin their comment landed and the wording moved on.
 *
 * Indices are into the NORMALIZED text (normalizeQuote of the whole
 * document), so callers that need DOM positions map through the same
 * normalization.
 * @typedef {{ match: "exact" | "partial" | "stale", index: number, length: number }} QuoteHit
 */

// A quote has to keep this many leading characters to count as a partial
// match. Short enough that an edited sentence tail still places the comment,
// long enough that "the " never matches half the document.
const PARTIAL_MIN = 24;

/**
 * Locate a stored quote in the current document text.
 * @param {unknown} docText the document as it reads now (raw or normalized)
 * @param {unknown} quote the stored quote
 * @param {{ section?: string }} [opts] the stored section heading — when the
 *   quote occurs more than once, the occurrence inside that section wins
 * @returns {QuoteHit}
 */
export function locateQuote(docText, quote, opts = {}) {
  const hay = normalizeQuote(docText);
  const needle = normalizeQuote(quote).replace(
    new RegExp(`${QUOTE_TRUNCATION.replace(/[[\]]/g, "\\$&")}$`),
    "",
  ).trim();
  const miss = /** @type {QuoteHit} */ ({ match: "stale", index: -1, length: 0 });
  if (!hay || !needle) return miss;

  const from = sectionStart(hay, opts?.section);
  const exact = indexFrom(hay, needle, from);
  if (exact >= 0) return { match: "exact", index: exact, length: needle.length };

  // The tail may have been edited — try the longest leading run that still
  // occurs, down to PARTIAL_MIN characters.
  for (let len = Math.min(needle.length, hay.length); len >= PARTIAL_MIN; len = Math.floor(len * 0.75)) {
    const head = needle.slice(0, len);
    const at = indexFrom(hay, head, from);
    if (at >= 0) return { match: "partial", index: at, length: head.length };
  }
  return miss;
}

/**
 * Search from `from`, wrapping to the start of the document — so a section
 * hint biases the result without ever hiding a match that moved out of it.
 * @param {string} hay
 * @param {string} needle
 * @param {number} from
 * @returns {number}
 */
function indexFrom(hay, needle, from) {
  const after = hay.indexOf(needle, from);
  return after >= 0 ? after : hay.indexOf(needle);
}

/**
 * The offset the stored section heading starts at, or 0 when the heading is
 * absent or gone.
 * @param {string} hay normalized document text
 * @param {unknown} section
 * @returns {number}
 */
function sectionStart(hay, section) {
  const s = normalizeQuote(section);
  if (!s) return 0;
  const at = hay.indexOf(s);
  return at >= 0 ? at + s.length : 0;
}

// ---------------------------------------------------------------------------
// When the rail is on screen
// ---------------------------------------------------------------------------

/**
 * Whether the comment rail should be showing.
 *
 * The rail is an OVERLAY — the layer promises the host page no layout
 * cooperation, so it cannot take a column and must float over the prose. On a
 * phone that means it covers the document, and the document is the thing you
 * are reading and marking (feedback #40, 2026-07-26: "the right dark pane is in
 * the way with no clear way to close it. I must see the text when choosing what
 * to comment"). So it opens only when it is the thing you are doing:
 *
 * - `composing` — you are writing a comment and the composer lives in the rail.
 *   Always open; nothing else can win.
 * - `requested` — you pressed the counter to open it or the ✕ to close it.
 *   An explicit act outranks the mode, and survives until the mode changes.
 * - `commenting` — comment mode opens its own workspace, so the "mark a passage"
 *   instruction is there to read.
 * - READ MODE NEVER OPENS IT, even with comments on the page. The counter says
 *   how many there are and opens them on demand; the passages are highlighted
 *   in the prose either way. Opening it by itself is what put a pane over the
 *   documentation of a reader who only wanted to read.
 *
 * @param {{ commenting?: boolean, composing?: boolean, requested?: boolean | null }} s
 * @returns {boolean}
 */
export function railVisible(s = {}) {
  if (s?.composing) return true;
  if (s?.requested === true) return true;
  if (s?.requested === false) return false;
  return !!s?.commenting;
}

// ---------------------------------------------------------------------------
// Reading the feedback queue back as this document's comments
// ---------------------------------------------------------------------------

/**
 * Turn feedback entries into the reader's comment list for one document:
 * doc-scope entries for this path, parsed, each carrying where its quote sits
 * in the document as it reads now. Ordered the way the document reads — top to
 * bottom — with the ones whose passage is gone collected at the end, since
 * they have no place in the margin to sit beside.
 *
 * Entries whose body does not parse are KEPT (as a comment with the raw body
 * as its note and a stale anchor) rather than dropped: an admin who wrote a
 * comment must always be able to find it again, even if the format changed
 * under it.
 *
 * @param {Array<any>} entries projected feedback entries (src/feedback.js)
 * @param {{ path: string, text?: string }} doc the document being read
 * @returns {Array<any>} entry + {anchor: DocComment, hit: QuoteHit}
 */
export function docCommentsFor(entries, doc) {
  const path = str(doc?.path);
  const text = str(doc?.text);
  return (Array.isArray(entries) ? entries : [])
    .filter((e) => e && e.doc === true && (!path || e.doc_path === path))
    .map((e) => {
      const anchor = parseDocCommentBody(e.comment) || {
        path,
        section: "",
        quote: "",
        note: str(e.comment),
      };
      return { ...e, anchor, hit: locateQuote(text, anchor.quote, { section: anchor.section }) };
    })
    .sort((a, b) => {
      // index -1 (stale) sorts last, not first.
      const ai = a.hit.index < 0 ? Infinity : a.hit.index;
      const bi = b.hit.index < 0 ? Infinity : b.hit.index;
      return ai - bi || a.id - b.id;
    });
}
