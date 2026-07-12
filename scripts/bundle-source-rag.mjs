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

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  SOURCE_CHUNK_OVERLAP,
  SOURCE_CHUNK_TARGET,
  chunkSourceText,
  int8ToB64,
  quantizeInt8,
  validateRagIndex,
  validateSnapshot,
} from "../public/js/introspect-core.js";

/** Per-file content hash — the delta key. Same input the chunker sees. */
const fileHash = (text) => createHash("sha256").update(String(text ?? "")).digest("hex").slice(0, 16);

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SNAPSHOT = "public/introspect/source-snapshot.json";
const OUT = "public/introspect/source-rag.json";

const EMBED_MODEL = "intfloat/multilingual-e5-large";
const PASSAGE_PREFIX = "passage: ";
const BATCH = 32; // ≤ the server's MAX_EMBED_TEXTS (48); smaller = safer per call
const MAX_CHUNK_CHARS = 3800; // stay under the embed endpoint's 4000-char cap incl. prefix
// The shared /api/embed throttles after a few hundred rapid calls (502s); a
// steady inter-batch delay keeps a full (~2100-chunk) build under the limit so
// it grinds through fewer retry storms. Delta rebuilds embed far fewer chunks,
// so the pacing barely matters there. Override with INTROSPECT_EMBED_DELAY_MS.
const BATCH_DELAY_MS = Number(process.env.INTROSPECT_EMBED_DELAY_MS) || 700;

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

  // Skip test files: they're ~40% of the corpus and low-value for "how does
  // the app work / code examples FROM the project" — the app SOURCE is the
  // target. (They stay in the snapshot, so a user can still name one by path
  // and get its full text; they're just not in the retrieval index.)
  const files = snapshot.files.filter((f) => !/(\.test\.js|(^|\/)tests\/)/.test(f.p));

  // DELTA: reuse vectors for files whose content HASH is unchanged since the
  // last committed index; only NEW or CHANGED files are re-embedded. A full
  // rebuild happens only when there's no prior index, the embed model changed,
  // or the chunker params changed (all vectors would be incomparable). This is
  // what keeps a routine `npm run bundle:rag` after a one-file edit near-free
  // instead of re-embedding all ~2000 chunks.
  const prior = existsSync(join(ROOT, OUT)) ? validateRagIndex(JSON.parse(readFileSync(join(ROOT, OUT), "utf8"))) : null;
  const compatible =
    prior && prior.model === EMBED_MODEL && prior.target === SOURCE_CHUNK_TARGET && prior.overlap === SOURCE_CHUNK_OVERLAP;
  // old file -> ordered [b64,…] by ci (dropping any gaps defensively).
  /** @type {Map<string, string[]>} */
  const priorVecs = new Map();
  if (compatible) {
    for (let i = 0; i < prior.map.length; i++) {
      const { p, ci } = prior.map[i];
      if (!priorVecs.has(p)) priorVecs.set(p, []);
      priorVecs.get(p)[ci] = prior.vectors[i];
    }
  }

  // Decide, per file, reuse vs embed. `plan` holds the FINAL per-file chunk
  // vectors (reused or to-be-filled); `toEmbed` is the flat list of chunks
  // that actually need an embed call.
  const hashes = {};
  /** @type {Array<{ p: string, vecs: (string|null)[], reused: boolean }>} */
  const plan = [];
  /** @type {Array<{ p: string, ci: number, text: string }>} */
  const toEmbed = [];
  let reusedFiles = 0;
  let reusedChunks = 0;
  for (const f of files) {
    const h = fileHash(f.t);
    hashes[f.p] = h;
    const pieces = chunkSourceText(f.t);
    const old = priorVecs.get(f.p);
    const canReuse = compatible && prior.hashes[f.p] === h && old && old.length >= pieces.length && pieces.every((_, ci) => old[ci]);
    if (canReuse) {
      plan.push({ p: f.p, vecs: pieces.map((_, ci) => old[ci]), reused: true });
      reusedFiles++;
      reusedChunks += pieces.length;
    } else {
      const vecs = new Array(pieces.length).fill(null);
      plan.push({ p: f.p, vecs, reused: false });
      pieces.forEach((text, ci) => toEmbed.push({ p: f.p, ci, text: text.slice(0, MAX_CHUNK_CHARS) }));
    }
  }
  const totalChunks = plan.reduce((n, e) => n + e.vecs.length, 0);
  console.log(
    `${files.length} indexable files, ${totalChunks} chunks. ` +
      (compatible
        ? `DELTA: reusing ${reusedFiles} files / ${reusedChunks} chunks; embedding ${toEmbed.length} chunks (${files.length - reusedFiles} changed/new files)`
        : `FULL rebuild (${prior ? "model/chunker changed" : "no prior index"}): embedding ${toEmbed.length} chunks`) +
      ` via ${process.env.BERGET_API_TOKEN ? "Berget" : SITE + "/api/embed"} …`,
  );

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

  // Embed only the changed/new chunks, writing each result back into its
  // file's plan slot (by p+ci). A skipped (unembeddable) chunk stays null.
  const slotOf = new Map(plan.map((e) => [e.p, e]));
  let dims = compatible ? prior.dims : 0;
  let skipped = 0;
  let done = 0;
  for (let i = 0; i < toEmbed.length; i += BATCH) {
    const batch = toEmbed.slice(i, i + BATCH);
    const vecs = await embedResilient(batch);
    for (let j = 0; j < batch.length; j++) {
      const v = vecs[j];
      if (!v || !v.length) {
        skipped++;
        continue;
      }
      dims = v.length;
      slotOf.get(batch[j].p).vecs[batch[j].ci] = int8ToB64(quantizeInt8(v));
    }
    done = Math.min(i + BATCH, toEmbed.length);
    process.stdout.write(`\r  embedded ${done}/${toEmbed.length} (${skipped} skipped)`);
    await sleep(BATCH_DELAY_MS); // pace under the endpoint throttle (see BATCH_DELAY_MS)
  }
  if (toEmbed.length) process.stdout.write("\n");

  // Assemble the flat arrays in stable file/ci order, dropping any null
  // (skipped) chunk so every map entry has a real vector.
  /** @type {string[]} */
  const vectors = [];
  /** @type {Array<{ p: string, ci: number }>} */
  const map = [];
  for (const e of plan) {
    for (let ci = 0; ci < e.vecs.length; ci++) {
      if (e.vecs[ci]) {
        vectors.push(e.vecs[ci]);
        map.push({ p: e.p, ci });
      }
    }
  }

  const index = { v: 1, model: EMBED_MODEL, dims, target: SOURCE_CHUNK_TARGET, overlap: SOURCE_CHUNK_OVERLAP, hashes, vectors, map };
  const json = JSON.stringify(index);
  writeFileSync(join(ROOT, OUT), json + "\n");
  console.log(
    `Wrote ${OUT}: ${vectors.length} vectors × ${dims}d (int8), ${(json.length / 1e6).toFixed(1)} MB` +
      ` (${reusedChunks} reused, ${toEmbed.length - skipped} embedded, ${skipped} skipped)`,
  );
}

main().catch((err) => {
  console.error("bundle-source-rag failed:", err.message);
  process.exit(1);
});
