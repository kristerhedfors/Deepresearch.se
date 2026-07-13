// @ts-check
// Document RAG, server side.
//
// Large attached documents (hundreds/thousands of pages) can't ride inline
// in the message the way small ones do (32K message cap) — instead they are
// chunked and embedded, and each question retrieves only the most relevant
// excerpts. Embeddings come from Berget's embedding model in BOTH storage
// modes (the API token is a Worker secret, so the client always embeds
// through POST /api/embed here); the browser index is ALWAYS present, and
// where it ALSO lives follows storage availability (src/settings.js —
// `serverHistoryEnabled`, now availability, not a knob):
//
//   storage unavailable (break-glass, no R2 binding) — the index lives only
//     in the browser (IndexedDB, public/js/rag.js does its own cosine
//     top-k). This endpoint file only supplies the embedding proxy.
//   storage available (the normal Se/rver case) — the index ALSO lives here:
//     vectors in Vectorize (binding `RAG_INDEX` — similarity search runs
//     off-Worker instead of burning the isolate's CPU budget), chunk text
//     riding in vector metadata, and one exportable JSON copy per document
//     in R2 (`rag/{uid}/{docId}`, chunks + vectors) so the account-wide
//     drain (DELETE /api/storage) can pull the whole index back to the
//     client without re-embedding (and re-paying).
//
// The RAG index is NOT encrypted — retrieval needs readable chunk text —
// which is why conversations (encrypted, src/storage.js) and the index are
// stored as separate families with separate guarantees. Disclosed in the
// settings UI.
//
// The Vectorize index is created once with the embedding model's dimension
// count (see wrangler.toml's setup notes); ids are `{uid}:{docId}:{seq}`
// and every vector carries metadata {u, d, seq, text} with a metadata
// index on `u` for per-user filtering.

import { embedModel, embedTexts, rawModelEntry } from "./berget.js";
import { quotaBlockedResponse } from "./chat.js";
import { getConfig } from "./config.js";
import { jsonResponse } from "./http.js";
import {
  effectiveQuota,
  getUsage,
  inflightLimitResponse,
  quotaExceeded,
  recordUsage,
  releaseInflight,
  reserveInflight,
} from "./quota.js";
import { serverHistoryEnabled, storageAvailability } from "./settings.js";

/** @typedef {import('./types.js').Env} Env */
/** @typedef {import('./types.js').Logger} Logger */
/** @typedef {import('./settings.js').Identity} Identity */
/** @typedef {{ seq: number, text: string }} RagChunk */
/**
 * validateRagIndexPayload's success shape (`error` absent) — the hardened
 * document ready for Vectorize upsert + the R2 export copy.
 * @typedef {{ error?: undefined, docId: string, name: string, chunks: RagChunk[], vectors: Float32Array[], dims: number }} RagIndexPayload
 */

// e5-family input convention: documents are "passage: …", questions are
// "query: …". Applied here at embed time (never stored), so client and
// server can't drift apart on it.
const PASSAGE_PREFIX = "passage: ";
const QUERY_PREFIX = "query: ";

const MAX_EMBED_TEXTS = 48;
const MAX_EMBED_TEXT_CHARS = 4000;
const MAX_EMBED_TOTAL_CHARS = 160_000;
const MAX_CHUNKS_PER_DOC = 6000;
const MAX_DIMS = 4096;
const MAX_QUERY_CHARS = 2000;
const MAX_TOP_K = 12;
const METADATA_TEXT_CHARS = 1800; // Vectorize caps metadata at 10 KiB/vector

/** @param {unknown} s */
const idOk = (s) => typeof s === "string" && /^[A-Za-z0-9_-]{1,80}$/.test(s);
/** @param {number | string} uid @param {string} docId */
const ragKey = (uid, docId) => `rag/${uid}/${docId}`;
/** @param {number | string} uid @param {string} docId @param {number} seq */
const vectorId = (uid, docId, seq) => `${uid}:${docId}:${seq}`;

// The storageAvailability/`available.rag` gates in handleRag guarantee the
// bindings exist on every path below them.
/** @param {Env} env @returns {R2Bucket} */
const bucket = (env) => /** @type {R2Bucket} */ (env.STORAGE);
/** @param {Env} env @returns {VectorizeIndex} */
const vectorIndex = (env) => /** @type {VectorizeIndex} */ (env.RAG_INDEX);

// ---- base64 <-> Float32Array (vectors travel as base64 in JSON: ~3x
// smaller than digit arrays and losslessly round-trippable) ----------------

/**
 * @param {Float32Array | number[]} arr
 * @returns {string}
 */
export function f32ToB64(arr) {
  const bytes = new Uint8Array(Float32Array.from(arr).buffer);
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/**
 * @param {string} b64
 * @returns {Float32Array}
 */
export function b64ToF32(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Float32Array(bytes.buffer);
}

// ---- request validation (pure, unit-tested) --------------------------------

// POST /api/rag/index body: {docId, name, chunks:[{seq,text}], vectors:[b64]}.
// Vectors are REQUIRED — the client always embeds first (locally-indexed
// docs already have them), so the server never re-embeds a whole document
// inside one request. Chunk seqs must be exactly 0..n-1: the wipe path
// reconstructs vector ids from a stored chunk count alone.
/**
 * @param {any} body
 * @returns {{ error: string } | RagIndexPayload}
 */
export function validateRagIndexPayload(body) {
  if (!body || typeof body !== "object") return { error: "Expected a JSON body." };
  if (!idOk(body.docId)) return { error: "Invalid docId." };
  const name = typeof body.name === "string" ? body.name.slice(0, 200) : "";
  const chunks = body.chunks;
  if (!Array.isArray(chunks) || chunks.length === 0) return { error: "Expected non-empty chunks." };
  if (chunks.length > MAX_CHUNKS_PER_DOC) return { error: `Too many chunks (max ${MAX_CHUNKS_PER_DOC}).` };
  if (!Array.isArray(body.vectors) || body.vectors.length !== chunks.length) {
    return { error: "vectors must match chunks 1:1." };
  }
  const outChunks = [];
  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i];
    if (!c || c.seq !== i || typeof c.text !== "string" || !c.text.trim()) {
      return { error: `Chunk ${i} is malformed (seq must equal its index; text required).` };
    }
    if (c.text.length > MAX_EMBED_TEXT_CHARS) {
      return { error: `Chunk ${i} exceeds ${MAX_EMBED_TEXT_CHARS} chars.` };
    }
    outChunks.push({ seq: i, text: c.text });
  }
  let dims = 0;
  const vectors = [];
  for (let i = 0; i < body.vectors.length; i++) {
    let v;
    try {
      v = b64ToF32(body.vectors[i]);
    } catch {
      return { error: `Vector ${i} is not valid base64 float32 data.` };
    }
    if (i === 0) dims = v.length;
    if (!v.length || v.length > MAX_DIMS || v.length !== dims) {
      return { error: `Vector ${i} has inconsistent dimensions.` };
    }
    vectors.push(v);
  }
  return { docId: body.docId, name, chunks: outChunks, vectors, dims };
}

// ---- quota + usage accounting ----------------------------------------------

// Embeddings spend real Berget money (very little — €0.03/1M tokens — but
// the accounting discipline here is all-spend-is-visible), so the same
// quota gate as /api/chat applies, and every embed call records a usage
// event priced from the raw catalog entry.
/**
 * @param {Env} env
 * @param {Identity} identity
 * @returns {Promise<ReturnType<typeof quotaExceeded>>} the breach, or null
 */
async function quotaGate(env, identity) {
  const config = await getConfig(env);
  const usage = await getUsage(env, identity.id);
  const quota =
    identity.isSecretAdmin || identity.role === "admin"
      ? null
      : effectiveQuota(config, identity.user);
  return quota ? quotaExceeded(usage, quota) : null;
}

/**
 * @param {Env} env
 * @param {Logger} log
 * @param {Identity} identity
 * @param {{ prompt_tokens?: number } | null | undefined} usage the provider's token report
 * @param {string} model
 * @param {number} durationMs
 */
async function recordEmbedUsage(env, log, identity, usage, model, durationMs) {
  const promptTokens = usage?.prompt_tokens || 0;
  const entry = await rawModelEntry(env, model);
  const price = typeof entry?.pricing?.input === "number" ? entry.pricing.input : 0;
  await recordUsage(env, log, {
    user_id: identity.id,
    model,
    prompt_tokens: promptTokens,
    completion_tokens: 0,
    searches: 0,
    berget_cost: promptTokens * price,
    exa_cost: 0,
    duration_ms: durationMs,
  });
}

// ---- POST /api/embed --------------------------------------------------------

// The embedding proxy the client-side RAG uses in BOTH storage modes.
// body: {texts: string[], kind: "passage"|"query"} — the e5 prefix is
// applied here so the convention can't drift between client and server.
/**
 * @param {Request} request
 * @param {Env} env
 * @param {Logger} log
 * @param {Identity} identity
 * @returns {Promise<Response>}
 */
export async function handleEmbed(request, env, log, identity) {
  if (!env.BERGET_API_TOKEN) {
    return jsonResponse({ error: "Server not configured: BERGET_API_TOKEN secret is missing." }, 500);
  }
  /** @type {any} */
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Request body must be valid JSON." }, 400);
  }
  const texts = body?.texts;
  if (!Array.isArray(texts) || !texts.length || texts.length > MAX_EMBED_TEXTS) {
    return jsonResponse({ error: `Expected 1-${MAX_EMBED_TEXTS} texts.` }, 400);
  }
  let total = 0;
  for (const t of texts) {
    if (typeof t !== "string" || !t.trim() || t.length > MAX_EMBED_TEXT_CHARS) {
      return jsonResponse({ error: `Each text must be a non-empty string of at most ${MAX_EMBED_TEXT_CHARS} chars.` }, 400);
    }
    total += t.length;
  }
  if (total > MAX_EMBED_TOTAL_CHARS) {
    return jsonResponse({ error: "Texts exceed the per-request size limit." }, 400);
  }
  const blocked = await quotaGate(env, identity);
  if (blocked) return jsonResponse(quotaBlockedResponse(blocked), 429);

  // Per-user concurrency reservation (M-1/M-2), released in the finally below
  // on every exit path. reqId minted locally; fail-soft on any D1 trouble.
  const reqId = crypto.randomUUID();
  const reserved = await reserveInflight(env, identity.id, reqId);
  if (!reserved.ok) return jsonResponse(inflightLimitResponse(reserved), 429);

  const prefix = body.kind === "query" ? QUERY_PREFIX : PASSAGE_PREFIX;
  const startedAt = Date.now();
  try {
    const { vectors, usage, model } = await embedTexts(env, texts.map((t) => prefix + t));
    await recordEmbedUsage(env, log, identity, usage, model, Date.now() - startedAt);
    log.debug("rag.embed", { user_id: identity.id, texts: texts.length, tokens: usage?.prompt_tokens || 0 });
    return jsonResponse({
      vectors: vectors.map(f32ToB64),
      dims: vectors[0]?.length || 0,
      model,
    });
  } catch (err) {
    log.error("rag.embed_failed", { user_id: identity.id, error: (/** @type {any} */ (err))?.message || String(err) });
    return jsonResponse({ error: "Embedding service unavailable." }, 502);
  } finally {
    await releaseInflight(env, reqId);
  }
}

// ---- /api/rag/* router ------------------------------------------------------

/**
 * @param {Request} request
 * @param {Env} env
 * @param {URL} url
 * @param {Logger} log
 * @param {Identity} identity
 * @returns {Promise<Response>}
 */
export async function handleRag(request, env, url, log, identity) {
  const available = storageAvailability(env, identity);
  if (!available.storage || !identity.user) {
    return jsonResponse({ error: "Cloud storage is not configured on this server." }, 503);
  }
  const uid = identity.user.id;
  const parts = url.pathname.split("/").filter(Boolean); // ["api","rag",...]
  const method = request.method;

  if (parts[2] === "index" && method === "POST") return ragIndex(request, env, log, identity, uid, available);
  if (parts[2] === "query" && method === "POST") return ragQuery(request, env, log, identity, uid, available);
  if (parts[2] === "docs" && !parts[3] && method === "GET") return ragList(env, uid);
  if (parts[2] === "docs" && parts[3]) {
    const docId = decodeURIComponent(parts[3]);
    if (!idOk(docId)) return jsonResponse({ error: "Invalid docId." }, 400);
    if (method === "GET") return ragExport(env, uid, docId);
    if (method === "DELETE") return ragDelete(env, log, identity, uid, docId);
  }
  return jsonResponse({ error: "Not found." }, 404);
}

// POST /api/rag/index — store one document's chunks + vectors: Vectorize
// upsert (batched) + the exportable R2 copy. REPLACE semantics per docId:
// a re-push with fewer chunks than the stored copy (a chat doc fully
// re-indexed on another device can chunk on different boundaries —
// public/js/chat-rag.js) also deletes the now-orphaned tail vectors, so
// stale text can't keep matching queries.
/**
 * @param {Request} request
 * @param {Env} env
 * @param {Logger} log
 * @param {Identity} identity
 * @param {number | string} uid
 * @param {{ storage: boolean, rag: boolean }} available
 */
async function ragIndex(request, env, log, identity, uid, available) {
  if (!available.rag) {
    return jsonResponse({ error: "Server-side RAG is not configured (Vectorize binding missing)." }, 503);
  }
  if (!serverHistoryEnabled(env, identity)) {
    return jsonResponse({ error: "Cloud history is switched off for this account." }, 403);
  }
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Request body must be valid JSON." }, 400);
  }
  const parsed = validateRagIndexPayload(body);
  if (parsed.error) return jsonResponse({ error: parsed.error }, 400);
  const { docId, name, chunks, vectors, dims } = /** @type {RagIndexPayload} */ (parsed);

  const rows = chunks.map((c, i) => ({
    id: vectorId(uid, docId, c.seq),
    values: Array.from(vectors[i]),
    metadata: {
      u: String(uid),
      d: docId,
      seq: c.seq,
      text: c.text.slice(0, METADATA_TEXT_CHARS),
    },
  }));
  for (let i = 0; i < rows.length; i += 500) {
    await vectorIndex(env).upsert(rows.slice(i, i + 500));
  }

  // Shrinking replace: drop the previous copy's tail vectors.
  const prev = await bucket(env).head(ragKey(uid, docId));
  const prevCount = Number(prev?.customMetadata?.chunkCount) || 0;
  if (prevCount > chunks.length) {
    const stale = [];
    for (let seq = chunks.length; seq < prevCount; seq++) stale.push(vectorId(uid, docId, seq));
    for (let i = 0; i < stale.length; i += 900) {
      await vectorIndex(env).deleteByIds(stale.slice(i, i + 900));
    }
  }

  await bucket(env).put(
    ragKey(uid, docId),
    JSON.stringify({
      docId,
      name,
      model: embedModel(env),
      dims,
      chunkCount: chunks.length,
      createdAt: Date.now(),
      chunks,
      vectors: vectors.map(f32ToB64),
    }),
    {
      httpMetadata: { contentType: "application/json" },
      customMetadata: { name, chunkCount: String(chunks.length) },
    },
  );
  log.info("rag.indexed", { user_id: identity.id, chunks: chunks.length, dims });
  return jsonResponse({ ok: true, docId, chunks: chunks.length });
}

// POST /api/rag/query — {query, docIds?, topK?} → the most relevant chunks
// across this user's server-indexed documents. Embeds the query (quota-
// gated + usage-recorded like /api/embed), queries Vectorize filtered to
// this user, then narrows to the requested docIds Worker-side.
/**
 * @param {Request} request
 * @param {Env} env
 * @param {Logger} log
 * @param {Identity} identity
 * @param {number | string} uid
 * @param {{ storage: boolean, rag: boolean }} available
 */
async function ragQuery(request, env, log, identity, uid, available) {
  if (!available.rag) {
    return jsonResponse({ error: "Server-side RAG is not configured (Vectorize binding missing)." }, 503);
  }
  if (!serverHistoryEnabled(env, identity)) {
    return jsonResponse({ error: "Cloud history is switched off for this account." }, 403);
  }
  /** @type {any} */
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Request body must be valid JSON." }, 400);
  }
  const query = typeof body?.query === "string" ? body.query.trim().slice(0, MAX_QUERY_CHARS) : "";
  if (!query) return jsonResponse({ error: "Expected a query string." }, 400);
  const docIds = Array.isArray(body.docIds) ? body.docIds.filter(idOk).slice(0, 20) : [];
  const topK = Math.min(MAX_TOP_K, Math.max(1, Number(body.topK) || 8));

  const blocked = await quotaGate(env, identity);
  if (blocked) return jsonResponse(quotaBlockedResponse(blocked), 429);

  const startedAt = Date.now();
  let qvec;
  try {
    const { vectors, usage, model } = await embedTexts(env, [QUERY_PREFIX + query]);
    qvec = vectors[0];
    await recordEmbedUsage(env, log, identity, usage, model, Date.now() - startedAt);
  } catch (err) {
    log.error("rag.query_embed_failed", { user_id: identity.id, error: (/** @type {any} */ (err))?.message || String(err) });
    return jsonResponse({ error: "Embedding service unavailable." }, 502);
  }

  // returnMetadata "all" caps topK at 20 in Vectorize — stay inside it while
  // over-fetching a little so the docId narrowing below still fills topK.
  const res = await vectorIndex(env).query(qvec, {
    topK: Math.min(20, topK + 8),
    filter: { u: String(uid) },
    returnMetadata: "all",
  });
  const matches = (res?.matches || [])
    .filter((m) => !docIds.length || docIds.includes(m.metadata?.d))
    .slice(0, topK)
    .map((m) => ({
      docId: m.metadata?.d || "",
      seq: Number(m.metadata?.seq) || 0,
      text: String(m.metadata?.text || ""),
      score: m.score,
    }));
  log.debug("rag.query", { user_id: identity.id, matches: matches.length, duration_ms: Date.now() - startedAt });
  return jsonResponse({ matches });
}

// GET /api/rag/docs — list this user's server-indexed documents (metadata
// only, from the R2 listing — no bodies read).
/** @param {Env} env @param {number | string} uid */
async function ragList(env, uid) {
  const out = [];
  let cursor;
  do {
    const page = await bucket(env).list({ prefix: `rag/${uid}/`, cursor, include: ["customMetadata"] });
    for (const o of page.objects) {
      out.push({
        id: o.key.split("/").pop(),
        name: o.customMetadata?.name || "",
        chunkCount: Number(o.customMetadata?.chunkCount) || 0,
        size: o.size,
      });
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return jsonResponse({ docs: out });
}

// GET /api/rag/docs/:id — the full exportable copy (chunks + vectors), used
// by the account-wide drain (DELETE /api/storage) so the client can rebuild
// its local index without re-embedding. Stays readable regardless of storage
// availability — that IS the drain path.
/** @param {Env} env @param {number | string} uid @param {string} docId */
async function ragExport(env, uid, docId) {
  const obj = await bucket(env).get(ragKey(uid, docId));
  if (!obj) return jsonResponse({ error: "Not found." }, 404);
  return new Response(obj.body, { headers: { "content-type": "application/json; charset=utf-8" } });
}

/**
 * @param {Env} env
 * @param {Logger} log
 * @param {Identity} identity
 * @param {number | string} uid
 * @param {string} docId
 */
async function ragDelete(env, log, identity, uid, docId) {
  const head = await bucket(env).head(ragKey(uid, docId));
  const chunkCount = Number(head?.customMetadata?.chunkCount) || 0;
  await deleteVectors(env, uid, docId, chunkCount);
  await bucket(env).delete(ragKey(uid, docId));
  log.info("rag.deleted", { user_id: identity.id, chunks: chunkCount });
  return new Response(null, { status: 204 });
}

/**
 * @param {Env} env
 * @param {number | string} uid
 * @param {string} docId
 * @param {number} chunkCount
 */
async function deleteVectors(env, uid, docId, chunkCount) {
  if (!env.RAG_INDEX || !chunkCount) return;
  const ids = [];
  for (let seq = 0; seq < chunkCount; seq++) ids.push(vectorId(uid, docId, seq));
  for (let i = 0; i < ids.length; i += 900) {
    await env.RAG_INDEX.deleteByIds(ids.slice(i, i + 900));
  }
}

// Full-wipe helper for src/storage.js's DELETE /api/storage: removes every
// rag export AND its vectors for one user. Returns the object count removed.
/**
 * @param {Env} env
 * @param {number | string} uid
 * @returns {Promise<number>}
 */
export async function wipeRagForUser(env, uid) {
  if (!env.STORAGE) return 0;
  let deleted = 0;
  let cursor;
  do {
    const page = await env.STORAGE.list({ prefix: `rag/${uid}/`, cursor, include: ["customMetadata"] });
    for (const o of page.objects) {
      const docId = o.key.split("/").pop() || "";
      await deleteVectors(env, uid, docId, Number(o.customMetadata?.chunkCount) || 0);
      await env.STORAGE.delete(o.key);
      deleted++;
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return deleted;
}
