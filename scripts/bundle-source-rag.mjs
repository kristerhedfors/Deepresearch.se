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
//   1. BERGET_API_KEY (or the older BERGET_API_TOKEN) set → call Berget's
//      embeddings API directly. This is the FAST path: batches are dispatched
//      through a bounded concurrency pool (default 8 in flight) with no
//      inter-batch throttle, so a full ~2100-chunk build finishes in ~20-30 s
//      instead of minutes. Berget takes 8-16 concurrent embedding requests
//      without rate-limiting (measured 2026-07-12).
//   2. else → POST the live site's /api/embed with the break-glass creds
//      (BASIC_AUTH_USER / BASIC_AUTH_PASS) — production holds the key. This is
//      how the index is regenerated from an environment without the raw key.
//      That endpoint is SHARED and throttles under bursts, so this path stays
//      serial with a steady inter-batch delay.
//
// Tunables (env): INTROSPECT_EMBED_CONCURRENCY (in-flight batches; default 8
// direct / 1 via site), INTROSPECT_EMBED_DELAY_MS (inter-batch pause; default
// 0 direct / 700 via site), INTROSPECT_EMBED_BATCH (chunks per request).
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
// Pre-truncate each chunk before embedding. e5's window is 512 TOKENS, and
// dense code runs ~2.4 chars/token, so a full 1400-char code chunk overflows
// (~540 tokens) and 400s. 1200 is the chunker's ADVANCE (target 1400 − overlap
// 200): capping AT the advance keeps every byte of source covered by at least
// one chunk's vector (no gaps) while trimming only the last ~200 chars of the
// densest chunks. The retrieved TEXT is always the FULL chunk (re-chunked from
// the snapshot), so this only trims a chunk's vector tail, never what the user
// sees. The rare chunk still over 512 tokens at 1200 chars is shrunk further
// on demand (embedResilient), so nothing is ever dropped.
const MAX_CHUNK_CHARS = 1200;

// The raw Berget key, if present (the fast direct path). Accept the current
// env name (BERGET_API_KEY) and the older BERGET_API_TOKEN interchangeably.
const BERGET_KEY = process.env.BERGET_API_KEY || process.env.BERGET_API_TOKEN;

const BATCH = Number(process.env.INTROSPECT_EMBED_BATCH) || 32; // ≤ the server's MAX_EMBED_TEXTS (48)
// Direct Berget serves many concurrent requests, so fan out; the shared
// /api/embed 502s under bursts, so that path stays serial (concurrency 1).
const CONCURRENCY = Number(process.env.INTROSPECT_EMBED_CONCURRENCY) || (BERGET_KEY ? 8 : 1);
// Berget enforces 300 requests/MINUTE; the site /api/embed throttles under
// bursts. A single global min-interval gate on request STARTS keeps us under
// the ceiling no matter how many retries/shrinks a build triggers — this is
// the correctness guarantee against 429s (which, untamed, cost skipped chunks
// and a 4m40s build). 230ms ≈ 260 req/min, a safe margin under Berget's 300.
const MIN_REQUEST_INTERVAL_MS =
  process.env.INTROSPECT_EMBED_INTERVAL_MS !== undefined
    ? Number(process.env.INTROSPECT_EMBED_INTERVAL_MS)
    : BERGET_KEY
      ? 230
      : 700;

const SITE = process.env.INTROSPECT_SITE || "https://deepresearch.se";

/** @param {string[]} texts @returns {Promise<Float32Array[]>} */
async function embedViaBerget(texts) {
  const res = await fetch("https://api.berget.ai/v1/embeddings", {
    method: "POST",
    headers: { authorization: "Bearer " + BERGET_KEY, "content-type": "application/json" },
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

const embedBatch = BERGET_KEY ? embedViaBerget : embedViaSite;

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
      ` via ${BERGET_KEY ? "Berget" : SITE + "/api/embed"}` +
      ` (batch ${BATCH}, concurrency ${CONCURRENCY}, ≤${Math.round(60000 / MIN_REQUEST_INTERVAL_MS)} req/min) …`,
  );

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Global min-interval gate on request STARTS. Single-threaded JS makes the
  // nextAt read-modify-write atomic across the concurrent workers, so this
  // caps the aggregate request rate — every retry and shrink goes through it,
  // which is what keeps a burst of splits from tripping Berget's 300/min 429.
  let requests = 0;
  let nextAt = 0;
  async function embedGated(texts) {
    const now = Date.now();
    const at = Math.max(now, nextAt);
    nextAt = at + MIN_REQUEST_INTERVAL_MS;
    if (at > now) await sleep(at - now);
    requests++;
    return embedBatch(texts);
  }

  // Error classifiers. A "too long" 400 is PERMANENT — e5's 512-token window,
  // which dense code chunks blow past even at 1200 chars; the only fix is a
  // smaller input. A 429 is rate-limiting — always transient, so we wait and
  // retry, NEVER skip (a skipped chunk is a coverage hole). Everything else
  // (5xx / network) gets a couple of backoff retries.
  const isTooLong = (msg) => /context length|too long|maximum context/i.test(String(msg));
  const isRateLimited = (msg) => /\b429\b|rate.?limit/i.test(String(msg));

  // Embed `items`, returning a vector per item.
  //  - Too-long 400 → shrink EVERY chunk in the batch ×0.8 and retry the batch.
  //    One dense chunk poisons the whole batch, so trimming uniformly resolves
  //    it in ~1 extra request; the alternative (binary-split down to singles)
  //    re-embeds good chunks O(log n) times and, on a dense-file batch, storms
  //    Berget's 300/min limit. Dense chunks cluster in dense files, so the
  //    collateral trim lands mostly on chunks that were code-dense anyway, and
  //    the retrieved TEXT stays full regardless.
  //  - 429 → wait and retry, indefinitely; the gate should prevent it, but if
  //    one slips through we pace down, never drop the chunk.
  //  - Transient 5xx/network → up to 2 backoff retries, then binary split so a
  //    persistently flaky single is isolated and (last resort) skipped.
  /** @param {{text:string,p:string}[]} items @returns {Promise<(Float32Array|null)[]>} */
  async function embedResilient(items) {
    if (!items.length) return [];
    let transientTries = 0;
    for (;;) {
      try {
        const vecs = await embedGated(items.map((c) => c.text));
        if (vecs.length === items.length) return vecs;
        throw new Error(`got ${vecs.length} vectors for ${items.length} texts`);
      } catch (err) {
        const msg = String(/** @type {any} */ (err)?.message || err);
        if (isRateLimited(msg)) {
          await sleep(2000);
          continue; // never counts against the chunk — just pace and retry
        }
        if (isTooLong(msg)) {
          let shrunk = false;
          for (const it of items) {
            if (it.text.length > 400) {
              it.text = it.text.slice(0, Math.floor(it.text.length * 0.8));
              shrunk = true;
            }
          }
          if (shrunk) continue; // retry the (now smaller) batch
          // Already ≤400 chars yet still rejected — fall through to skip/split.
        } else if (transientTries++ < 2) {
          await sleep(1000 * 2 ** (transientTries - 1));
          continue;
        }
        if (items.length > 1) {
          const mid = Math.ceil(items.length / 2);
          const left = await embedResilient(items.slice(0, mid));
          const right = await embedResilient(items.slice(mid));
          return [...left, ...right];
        }
        console.warn(`\n  skipping unembeddable chunk (${items[0].p}): ${msg}`);
        return [null];
      }
    }
  }

  // Embed only the changed/new chunks, writing each result back into its
  // file's plan slot (by p+ci). A skipped (unembeddable) chunk stays null.
  // Each chunk owns a unique (p, ci) slot, so parallel batches never collide —
  // the direct-Berget path fans CONCURRENCY batches out at once; the shared
  // /api/embed path stays serial (CONCURRENCY 1) with a pacing delay.
  const slotOf = new Map(plan.map((e) => [e.p, e]));
  let dims = compatible ? prior.dims : 0;
  let skipped = 0;
  let done = 0;

  // Split into batches up front; a pool of CONCURRENCY workers drains them.
  /** @type {{text:string,p:string,ci:number}[][]} */
  const batches = [];
  for (let i = 0; i < toEmbed.length; i += BATCH) batches.push(toEmbed.slice(i, i + BATCH));

  let next = 0;
  const startedAt = Date.now();
  async function worker() {
    while (next < batches.length) {
      const batch = batches[next++];
      const vecs = await embedResilient(batch);
      for (let j = 0; j < batch.length; j++) {
        const v = vecs[j];
        if (!v || !v.length) {
          skipped++;
          continue;
        }
        dims = v.length;
        slotOf.get(batch[j].p).vecs[batch[j].ci] = int8ToB64(quantizeInt8(v));
        done++;
      }
      process.stdout.write(`\r  embedded ${done}/${toEmbed.length} (${skipped} skipped)`);
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, batches.length) }, () => worker()));
  if (toEmbed.length)
    process.stdout.write(`\n  embedded in ${((Date.now() - startedAt) / 1000).toFixed(1)}s across ${requests} requests\n`);

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
