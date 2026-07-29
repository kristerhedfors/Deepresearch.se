#!/usr/bin/env node
// Builds the committed DENSE RAG index for the HELP documentation corpus:
//
//   public/introspect/docs-rag.json
//
// One int8-quantized embedding per (doc path, chunk index) of the committed
// docs corpus (public/introspect/docs-corpus.json, scripts/bundle-docs.mjs),
// so the introspection HELP layer (src/introspect.js) can RETRIEVE the
// documentation passages relevant to a question and give the model the actual
// doc text — images, captions, symbol references and all — to quote near-
// verbatim. Identical index FORMAT to source-rag.json / owasp-rag.json —
// vectors ONLY, keyed by {p, ci}; retrieval re-chunks the corpus with the SAME
// deterministic chunker to resolve text, so vectors and text can never
// silently drift (the freshness check in src/introspect.test.js enforces the
// chunk counts line up).
//
// The build itself is scripts/corpus-rag.mjs, shared with the OWASP index so
// the two formats cannot drift apart. Embeddings must match the model the
// SERVER embeds the query with — Berget intfloat/multilingual-e5-large
// (1024-d), passage prefix. Needs BERGET_API_KEY (or the older
// BERGET_API_TOKEN). The corpus is ~19 docs / a few hundred chunks — a single
// full build well under Berget's 300 req/min cap at the default batch size, so
// no delta machinery and no pacing gate.
//
//   npm run bundle:docs        # refresh the corpus first
//   npm run bundle:docs-rag    # then this
// Not part of `npm run bundle` and not run in CI (no key / network).

import { buildCorpusRagIndex } from "./corpus-rag.mjs";

buildCorpusRagIndex({
  corpus: "public/introspect/docs-corpus.json",
  out: "public/introspect/docs-rag.json",
  refresh: "npm run bundle:docs",
}).catch((err) => {
  console.error("bundle-docs-rag failed:", err.message);
  process.exit(1);
});
