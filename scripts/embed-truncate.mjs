// Character-budget truncation that never splits a UTF-16 surrogate pair.
//
// WHY THIS EXISTS (2026-07-26, reproduced): the RAG bundlers pre-truncate every
// chunk to MAX_CHUNK_CHARS before embedding, and shrink ×0.8 on a too-long 400.
// A plain `.slice(0, n)` can land BETWEEN the two code units of an astral
// character — an emoji like 👍 in a doc table — leaving a lone high surrogate at
// the end of the string. Berget's HuggingFace tokenizer rejects that batch with
// a 400 that looks nothing like a length problem:
//
//   TextEncodeInput must be Union[TextInputSequence, Tuple[InputSequence, …]]
//
// and because it is not a "too long" 400, the shrink retry can never clear it:
// `npm run bundle:docs-rag` fails outright. It is a landmine any documentation
// edit can step on, since editing prose shifts every later chunk boundary — the
// first real instance was a 👍 in `docs/WORKSPACES.md` landing on the boundary.
//
// Dropping the orphaned unit costs at most one character off a vector's tail;
// the retrieved TEXT is always the full chunk, re-chunked from the corpus.

/**
 * Truncate `text` to at most `max` UTF-16 code units, backing off by one when
 * the cut would orphan a surrogate. Shorter input is returned unchanged.
 * @param {string} text
 * @param {number} max
 * @returns {string}
 */
export function truncateChars(text, max) {
  const s = String(text ?? "");
  if (!(max > 0)) return "";
  if (s.length <= max) return s;
  const last = s.charCodeAt(max - 1);
  // A high surrogate (D800–DBFF) as the final unit means its low half is the
  // character being cut away — drop the orphan too.
  const end = last >= 0xd800 && last <= 0xdbff ? max - 1 : max;
  return s.slice(0, end);
}
