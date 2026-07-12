#!/usr/bin/env node
// Builds the committed DENSE source-RAG index for introspection mode:
//
//   public/introspect/source-rag.json
//
// One int8-quantized embedding per (file, chunk index) of the committed
// source snapshot, so the DRS enrichment (src/introspect.js) can RETRIEVE the
// source chunks relevant to a question — no brittle intent regex, no VM. The
// index stores vectors ONLY (keyed by {p, ci}); retrieval re-chunks the
// snapshot with the SAME deterministic chunker (introspect-core.js
// chunkSourceText) to resolve text, so vectors and text can never silently
// drift — the freshness check (src/introspect.test.js) enforces the chunk
// counts still line up.
//
// Embeddings must match the model the SERVER embeds the query with at request
// time — Berget intfloat/multilingual-e5-large (1024-d), passage prefix. Two
// ways to get them:
//   1. BERGET_API_TOKEN set → call Berget's embeddings API directly.
//   2. else → POST the live site's /api/embed with the break-glass creds
//      (BASIC_AUTH_USER / BASIC_AUTH_PASS) — production holds the key. This is
//      how the index is regenerated from an environment without the raw key.
//
// Run it whenever bundled source changes (after `npm run bundle`):
//   npm run bundle:rag
// It is NOT part of `npm run bundle` (that stays pure/offline) and NOT run in
// CI (no key) — the freshness check only flags drift; a human re-runs this.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  SOURCE_CHUNK_OVERLAP,
  SOURCE_CHUNK_TARGET,
  int8ToB64,
  quantizeInt8,
  snapshotChunks,
  validateSnapshot,
} from "../public/js/introspect-core.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SNAPSHOT = "public/introspect/source-snapshot.json";
const OUT = "public/introspect/source-rag.json";

const EMBED_MODEL = "intfloat/multilingual-e5-large";
const PASSAGE_PREFIX = "passage: ";
const BATCH = 32; // ≤ the server's MAX_EMBED_TEXTS (48); smaller = safer per call
const MAX_CHUNK_CHARS = 3800; // stay under the embed endpoint's 4000-char cap incl. prefix

const SITE = process.env.INTROSPECT_SITE || "https://deepresearch.se";

/** @param {string[]} texts @returns {Promise<Float32Array[]>} */
async function embedViaBerget(texts) {
  const token = process.env.BERGET_API_TOKEN;
  const res = await fetch("https://api.berget.ai/v1/embeddings", {
    method: "POST",
    headers: { authorization: "Bearer " + token, "content-type": "application/json" },
    body: JSON.stringify({ model: EMBED_MODEL, input: texts.map((t) => PASSAGE_PREFIX + t) }),
  });
  if (!res.ok) throw new Error(`Berget embeddings ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  return (data.data || []).map((d) => Float32Array.from(d.embedding));
}

/** @param {string[]} texts @returns {Promise<Float32Array[]>} */
async function embedViaSite(texts) {
  const u = process.env.BASIC_AUTH_USER;
  const p = process.env.BASIC_AUTH_PASS;
  if (!u || !p) throw new Error("Set BERGET_API_TOKEN, or BASIC_AUTH_USER/BASIC_AUTH_PASS to embed via the live /api/embed.");
  const auth = "Basic " + Buffer.from(`${u}:${p}`).toString("base64");
  const res = await fetch(SITE + "/api/embed", {
    method: "POST",
    headers: { authorization: auth, "content-type": "application/json" },
    // kind:"passage" → the server adds the same passage prefix Berget uses.
    body: JSON.stringify({ texts, kind: "passage" }),
  });
  if (!res.ok) throw new Error(`/api/embed ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  return (data.vectors || []).map((b64) => {
    const buf = Buffer.from(b64, "base64");
    return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  });
}

const embedBatch = process.env.BERGET_API_TOKEN ? embedViaBerget : embedViaSite;

async function main() {
  const snapshot = validateSnapshot(JSON.parse(readFileSync(join(ROOT, SNAPSHOT), "utf8")));
  if (!snapshot) throw new Error(`${SNAPSHOT} missing or invalid — run \`npm run bundle\` first.`);

  const chunks = snapshotChunks(snapshot).map((c) => ({ ...c, text: c.text.slice(0, MAX_CHUNK_CHARS) }));
  console.log(`Embedding ${chunks.length} chunks from ${snapshot.files.length} files via ${process.env.BERGET_API_TOKEN ? "Berget" : SITE + "/api/embed"} …`);

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Embed `items`, returning a vector per item. Resilient to a single bad
  // chunk (a token-dense one Berget rejects, which 502s the WHOLE batch):
  // retry the batch a few times, then split it in half, down to singles — a
  // single that still fails after retries is SKIPPED (returned null) with a
  // warning, so one unembeddable chunk never aborts the whole index.
  /** @param {{text:string}[]} items @returns {Promise<(Float32Array|null)[]>} */
  async function embedResilient(items) {
    if (!items.length) return [];
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const vecs = await embedBatch(items.map((c) => c.text));
        if (vecs.length === items.length) return vecs;
        throw new Error(`got ${vecs.length} vectors for ${items.length} texts`);
      } catch (err) {
        if (attempt < 2) {
          await sleep(1000 * 2 ** attempt);
          continue;
        }
        if (items.length === 1) {
          console.warn(`\n  skipping unembeddable chunk (${items[0].p}): ${err.message}`);
          return [null];
        }
        const mid = Math.ceil(items.length / 2);
        const left = await embedResilient(items.slice(0, mid));
        const right = await embedResilient(items.slice(mid));
        return [...left, ...right];
      }
    }
    return items.map(() => null);
  }

  /** @type {string[]} */
  const vectors = [];
  /** @type {Array<{ p: string, ci: number }>} */
  const map = [];
  let dims = 0;
  let skipped = 0;
  for (let i = 0; i < chunks.length; i += BATCH) {
    const batch = chunks.slice(i, i + BATCH);
    const vecs = await embedResilient(batch);
    for (let j = 0; j < batch.length; j++) {
      const v = vecs[j];
      if (!v || !v.length) {
        skipped++;
        continue;
      }
      dims = v.length;
      vectors.push(int8ToB64(quantizeInt8(v)));
      map.push({ p: batch[j].p, ci: batch[j].ci });
    }
    process.stdout.write(`\r  ${Math.min(i + BATCH, chunks.length)}/${chunks.length} (${skipped} skipped)`);
    await sleep(150); // be gentle on the shared embed endpoint
  }
  process.stdout.write("\n");

  const index = { v: 1, model: EMBED_MODEL, dims, target: SOURCE_CHUNK_TARGET, overlap: SOURCE_CHUNK_OVERLAP, vectors, map };
  const json = JSON.stringify(index);
  writeFileSync(join(ROOT, OUT), json + "\n");
  console.log(`Wrote ${OUT}: ${vectors.length} vectors × ${dims}d (int8), ${(json.length / 1e6).toFixed(1)} MB`);
}

main().catch((err) => {
  console.error("bundle-source-rag failed:", err.message);
  process.exit(1);
});
