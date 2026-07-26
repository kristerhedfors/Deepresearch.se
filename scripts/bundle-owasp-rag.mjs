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
// Embeddings must match the model the SERVER embeds the query with — Berget
// intfloat/multilingual-e5-large (1024-d), passage prefix. Needs BERGET_API_KEY
// (or the older BERGET_API_TOKEN). The corpus is small (~20 docs / ~140 chunks),
// so this is a single fast full build — no delta, no concurrency pool needed.
//
//   npm run fetch:owasp        # refresh the corpus first
//   npm run bundle:owasp-rag   # then this
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
import { describeProviders, embedAll } from "./embed-providers.mjs";
import { truncateChars } from "./embed-truncate.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CORPUS = "public/introspect/owasp-corpus.json";
const OUT = "public/introspect/owasp-rag.json";

const EMBED_MODEL = "intfloat/multilingual-e5-large";
const PASSAGE_PREFIX = "passage: ";
const MAX_CHUNK_CHARS = 1200; // pre-truncate for e5's 512-token window (see bundle-source-rag.mjs)
const BATCH = Number(process.env.INTROSPECT_EMBED_BATCH) || 256;
const PROVIDER = process.env.EMBED_PROVIDER || "";

const fileHash = (text) => createHash("sha256").update(String(text ?? "")).digest("hex").slice(0, 16);

async function main() {
  const corpus = validateSnapshot(JSON.parse(readFileSync(join(ROOT, CORPUS), "utf8")));
  if (!corpus) throw new Error(`${CORPUS} missing or invalid — run \`npm run fetch:owasp\` first.`);

  /** @type {Array<{ p: string, ci: number, text: string }>} */
  const toEmbed = [];
  const hashes = {};
  for (const f of corpus.files) {
    hashes[f.p] = fileHash(f.t);
    const pieces = chunkSourceText(f.t);
    pieces.forEach((text, ci) => toEmbed.push({ p: f.p, ci, text: truncateChars(text, MAX_CHUNK_CHARS) }));
  }
  console.log(`${corpus.files.length} docs, ${toEmbed.length} chunks — ${describeProviders(PROVIDER)} …`);

  /** @type {string[]} */
  const vectors = [];
  /** @type {Array<{ p: string, ci: number }>} */
  const map = [];
  let dims = 0;
  for (let i = 0; i < toEmbed.length; i += BATCH) {
    const batch = toEmbed.slice(i, i + BATCH);
    const vecs = (await embedAll(batch.map((c) => PASSAGE_PREFIX + c.text), { model: EMBED_MODEL, provider: PROVIDER })).vectors;
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
  console.error("bundle-owasp-rag failed:", err.message);
  process.exit(1);
});
