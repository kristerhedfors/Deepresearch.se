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
// Embeddings must match the model the SERVER embeds the query with — Berget
// intfloat/multilingual-e5-large (1024-d), passage prefix. Needs
// BERGET_API_KEY (or the older BERGET_API_TOKEN). The corpus is ~19 docs /
// a few hundred chunks — a single full build well under Berget's 300 req/min
// cap at the default batch size, so no delta machinery and no pacing gate.
//
//   npm run bundle:docs        # refresh the corpus first
//   npm run bundle:docs-rag    # then this
// Not part of `npm run bundle` and not run in CI (no key / network).

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  SOURCE_CHUNK_OVERLAP,
  SOURCE_CHUNK_TARGET,
  chunkSourceText,
  int8ToB64,
  quantizeInt8,
  validateSnapshot,
} from "../public/js/introspect-core.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CORPUS = "public/introspect/docs-corpus.json";
const OUT = "public/introspect/docs-rag.json";

const EMBED_MODEL = "intfloat/multilingual-e5-large";
const PASSAGE_PREFIX = "passage: ";
const MAX_CHUNK_CHARS = 1200; // pre-truncate for e5's 512-token window (see bundle-source-rag.mjs)
const BATCH = Number(process.env.INTROSPECT_EMBED_BATCH) || 32;

const BERGET_KEY = process.env.BERGET_API_KEY || process.env.BERGET_API_TOKEN;

const fileHash = (text) => createHash("sha256").update(String(text ?? "")).digest("hex").slice(0, 16);

/** @param {string[]} texts @returns {Promise<Float32Array[]>} */
async function embedBatch(texts) {
  if (!BERGET_KEY) throw new Error("Set BERGET_API_KEY (or BERGET_API_TOKEN) to embed the docs corpus.");
  const res = await fetch("https://api.berget.ai/v1/embeddings", {
    method: "POST",
    headers: { authorization: "Bearer " + BERGET_KEY, "content-type": "application/json" },
    body: JSON.stringify({ model: EMBED_MODEL, input: texts.map((t) => PASSAGE_PREFIX + t) }),
  });
  if (!res.ok) {
    const err = new Error(`Berget embeddings ${res.status}: ${(await res.text()).slice(0, 200)}`);
    /** @type {any} */ (err).status = res.status;
    throw err;
  }
  const data = await res.json();
  return (data.data || []).map((d) => Float32Array.from(d.embedding));
}

// Markdown tables are token-DENSE (well under 2.4 chars/token), so a chunk can
// still overflow e5's 512-token window at MAX_CHUNK_CHARS. Same remedy as
// bundle-source-rag.mjs: on a too-long 400, shrink EVERY chunk in the batch
// ×0.8 and retry — the vector loses a short tail; the retrieved TEXT is always
// the full chunk (re-chunked from the corpus).
/** @param {string[]} texts @returns {Promise<Float32Array[]>} */
async function embedBatchShrinking(texts) {
  let batch = texts;
  for (let attempt = 0; ; attempt++) {
    try {
      return await embedBatch(batch);
    } catch (/** @type {any} */ err) {
      const tooLong = err.status === 400 && /maximum context length|reduce the length/i.test(err.message);
      if (!tooLong || attempt >= 6) throw err;
      batch = batch.map((t) => t.slice(0, Math.max(200, Math.floor(t.length * 0.8))));
    }
  }
}

async function main() {
  const corpus = validateSnapshot(JSON.parse(readFileSync(join(ROOT, CORPUS), "utf8")));
  if (!corpus) throw new Error(`${CORPUS} missing or invalid — run \`npm run bundle:docs\` first.`);

  /** @type {Array<{ p: string, ci: number, text: string }>} */
  const toEmbed = [];
  const hashes = {};
  for (const f of corpus.files) {
    hashes[f.p] = fileHash(f.t);
    const pieces = chunkSourceText(f.t);
    pieces.forEach((text, ci) => toEmbed.push({ p: f.p, ci, text: text.slice(0, MAX_CHUNK_CHARS) }));
  }
  console.log(`${corpus.files.length} docs, ${toEmbed.length} chunks — embedding via Berget (batch ${BATCH}) …`);

  /** @type {string[]} */
  const vectors = [];
  /** @type {Array<{ p: string, ci: number }>} */
  const map = [];
  let dims = 0;
  for (let i = 0; i < toEmbed.length; i += BATCH) {
    const batch = toEmbed.slice(i, i + BATCH);
    const vecs = await embedBatchShrinking(batch.map((c) => c.text));
    if (vecs.length !== batch.length) throw new Error(`got ${vecs.length} vectors for ${batch.length} texts`);
    for (let j = 0; j < batch.length; j++) {
      dims = vecs[j].length;
      vectors.push(int8ToB64(quantizeInt8(vecs[j])));
      map.push({ p: batch[j].p, ci: batch[j].ci });
    }
    process.stdout.write(`\r  embedded ${vectors.length}/${toEmbed.length}`);
  }
  process.stdout.write("\n");

  const index = { v: 1, model: EMBED_MODEL, dims, target: SOURCE_CHUNK_TARGET, overlap: SOURCE_CHUNK_OVERLAP, hashes, vectors, map };
  const json = JSON.stringify(index);
  writeFileSync(join(ROOT, OUT), json + "\n");
  console.log(`Wrote ${OUT}: ${vectors.length} vectors × ${dims}d (int8), ${(json.length / 1e6).toFixed(2)} MB`);
}

main().catch((err) => {
  console.error("bundle-docs-rag failed:", err.message);
  process.exit(1);
});
