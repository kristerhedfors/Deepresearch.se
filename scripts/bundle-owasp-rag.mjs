#!/usr/bin/env node
// Builds the committed DENSE RAG index for the OWASP corpus:
//
//   public/introspect/owasp-rag.json
//
// One int8-quantized embedding per (doc id, chunk index) of the committed OWASP
// corpus (public/introspect/owasp-corpus.json, scripts/fetch-owasp.mjs), so the
// introspection security-assessment enrichment (src/introspect.js) can RETRIEVE
// the OWASP paragraphs relevant to a question and give the model the actual
// OWASP text to quote. Identical index FORMAT to the source-RAG index
// (scripts/bundle-source-rag.mjs) — vectors ONLY, keyed by {p, ci}; retrieval
// re-chunks the corpus with the SAME deterministic chunker to resolve text, so
// vectors and text can never silently drift (the freshness check in
// src/introspect.test.js enforces the chunk counts line up).
//
// The build itself is scripts/corpus-rag.mjs, shared with the docs index so the
// two formats cannot drift apart. Embeddings must match the model the SERVER
// embeds the query with — Berget intfloat/multilingual-e5-large (1024-d),
// passage prefix. Needs BERGET_API_KEY (or the older BERGET_API_TOKEN). The
// corpus is small (~20 docs / ~140 chunks), so this is a single fast full build
// — no delta, no concurrency pool needed.
//
//   npm run fetch:owasp        # refresh the corpus first
//   npm run bundle:owasp-rag   # then this
// Not part of `npm run bundle` and not run in CI (no key / network).

import { buildCorpusRagIndex } from "./corpus-rag.mjs";

buildCorpusRagIndex({
  corpus: "public/introspect/owasp-corpus.json",
  out: "public/introspect/owasp-rag.json",
  refresh: "npm run fetch:owasp",
}).catch((err) => {
  console.error("bundle-owasp-rag failed:", err.message);
  process.exit(1);
});
