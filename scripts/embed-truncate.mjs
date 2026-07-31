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

// THE IMPLEMENTATION MOVED (2026-07-31) to public/js/arxiv-rag-core.js, and
// this module is now the façade over it — the repo's standing convention for a
// pure helper both a browser module and a script need, since the browser can
// only import served modules. It moved because `buildPassage` needed the same
// cut and was still using a plain `.slice()`: a mathematical bold character in
// PMID 41993351's abstract landed exactly on the 1200-char boundary and
// crash-looped a PubMed loader at 96% of the fill (docs/PUBMED-RAG.md §7.2).
// Two copies of this rule is how that happened; there is now one.

export { truncateChars } from "../public/js/arxiv-rag-core.js";
