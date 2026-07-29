// The DENSE RAG INDEX BUILDER shared by the small committed corpora.
//
// scripts/bundle-docs-rag.mjs (the help documentation) and
// scripts/bundle-owasp-rag.mjs (the OWASP paragraphs) were the same
// ninety-line script twice over, differing only in which corpus they read,
// which index they write, and the command that refreshes the corpus. That
// duplication is not cosmetic: the two indexes must share ONE format — vectors
// only, keyed by {p, ci}, re-chunked at retrieval time with the same
// deterministic chunker — because src/introspect.js resolves their text the
// same way and src/introspect.test.js checks the chunk counts line up. A change
// to the quantization, the chunk truncation or the index envelope applied to
// one copy and not the other desynchronizes them silently.
//
// scripts/bundle-source-rag.mjs deliberately stays separate: the source corpus
// is large enough to need delta rebuilds and a pacing gate, which these two
// (a few hundred chunks each) do not.
//
// Embeddings must match the model the SERVER embeds the query with — Berget
// intfloat/multilingual-e5-large (1024-d), passage prefix. Needs BERGET_API_KEY
// (or the older BERGET_API_TOKEN).

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

export const EMBED_MODEL = "intfloat/multilingual-e5-large";
const PASSAGE_PREFIX = "passage: ";
const MAX_CHUNK_CHARS = 1200; // pre-truncate for e5's 512-token window (see bundle-source-rag.mjs)
const BATCH = Number(process.env.INTROSPECT_EMBED_BATCH) || 256;
const PROVIDER = process.env.EMBED_PROVIDER || "";

export const fileHash = (text) => createHash("sha256").update(String(text ?? "")).digest("hex").slice(0, 16);

/**
 * Chunk a validated corpus into the units that get embedded, and hash each
 * file so the index can say which corpus it was built from. Pure and exported
 * so the planning half is testable without a key or a network.
 * @param {{ files: Array<{ p: string, t: string }> }} corpus
 * @returns {{ toEmbed: Array<{ p: string, ci: number, text: string }>, hashes: Record<string, string> }}
 */
export function planCorpusChunks(corpus) {
  /** @type {Array<{ p: string, ci: number, text: string }>} */
  const toEmbed = [];
  /** @type {Record<string, string>} */
  const hashes = {};
  for (const f of corpus.files) {
    hashes[f.p] = fileHash(f.t);
    const pieces = chunkSourceText(f.t);
    pieces.forEach((text, ci) => toEmbed.push({ p: f.p, ci, text: truncateChars(text, MAX_CHUNK_CHARS) }));
  }
  return { toEmbed, hashes };
}

/**
 * Read a committed corpus, embed every chunk, and write the int8 index.
 * @param {{ corpus: string, out: string, refresh: string }} opts
 *   repo-relative corpus path, repo-relative index path, and the npm command
 *   that refreshes the corpus (quoted back at the operator when it is missing).
 */
export async function buildCorpusRagIndex({ corpus: CORPUS, out: OUT, refresh }) {
  const corpus = validateSnapshot(JSON.parse(readFileSync(join(ROOT, CORPUS), "utf8")));
  if (!corpus) throw new Error(`${CORPUS} missing or invalid — run \`${refresh}\` first.`);

  const { toEmbed, hashes } = planCorpusChunks(corpus);
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
