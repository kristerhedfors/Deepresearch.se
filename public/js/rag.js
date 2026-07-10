// @ts-check
// Client-side document RAG: lets a conversation carry documents far past
// the 32K inline-message cap (hundreds or thousands of pages). A large
// attachment is chunked here, embedded through POST /api/embed (Berget's
// embedding model — the API token is a Worker secret, so embedding always
// goes through the server; the DOCUMENT TEXT of a locally-indexed file
// still transits the server only per-chunk for embedding and is not
// stored there), and indexed. Each question then retrieves only the most
// relevant excerpts into the outgoing message (stream.js).
//
// Where the index lives follows the account's cloud-storage knob
// (settings.js):
//   OFF (default) — IndexedDB in this browser (database `dr_rag`):
//     chunk text + Float32Array vectors, cosine top-k computed right here.
//     Nothing is stored server-side.
//   ON — ALSO pushed to the server (Vectorize + an exportable R2 copy,
//     src/rag.js), and queries prefer the server index (works across
//     devices); the local copy stays as a lazy cache and fallback.
//
// The RAG index is NOT encrypted (in either location): retrieval needs
// readable chunk text. Conversations outside projects stay encrypted
// regardless (history-store.js); PROJECT chats are themselves indexed
// (chat-rag.js) and therefore follow the same readable-when-indexed rule
// as documents — the settings UI spells out this split.
//
// The pure helpers (chunkText, cosineSim, topKChunks, f32/b64 codecs) are
// exported for the Node unit suite — keep this module import-safe outside
// a browser (no top-level DOM/IDB access).

import { serverHistoryOn, serverRagAvailable } from "./settings.js";

const DB_NAME = "dr_rag";
const DB_VERSION = 1;

const EMBED_BATCH = 32; // server allows 48/call — headroom for prefixes
const MAX_CHUNKS = 6000; // matches the server's per-doc cap
export const CHUNK_TARGET_CHARS = 1400;
export const CHUNK_OVERLAP_CHARS = 200;

/**
 * One piece of a chunked document, in document order.
 * @typedef {{seq: number, text: string}} Chunk
 */

/**
 * The `docs` store row: per-document bookkeeping (the chunk text/vectors
 * live in the `chunks` store). Extra fields ride along via appendToDoc's
 * `meta` (chat-rag.js keeps its srcMsgs counter here).
 * @typedef {object} DocRow
 * @property {string} id
 * @property {string} name
 * @property {number} chunkCount
 * @property {number} dims embedding dimensions
 * @property {number} chars total source characters indexed
 * @property {number} addedAt epoch ms
 * @property {number} [srcMsgs]
 */

/**
 * The `chunks` store row: one embedded chunk, keyed `<docId>:<seq>`.
 * @typedef {{key: string, docId: string, seq: number, text: string, vector: Float32Array}} ChunkRow
 */

/**
 * One retrieval hit, best-first.
 * @typedef {{docId: string, seq: number, text: string, score: number}} Match
 */

// ---- pure helpers (unit-tested) ---------------------------------------------

/**
 * Sliding chunker: ~targetChars pieces, preferring paragraph/sentence/line
 * breaks in the back half of the window, with overlapChars of continuity
 * between consecutive chunks so a fact straddling a boundary is still
 * retrievable.
 * @param {string | null | undefined} text
 * @param {{targetChars?: number, overlapChars?: number}} [opts]
 * @returns {Chunk[]}
 */
export function chunkText(text, { targetChars = CHUNK_TARGET_CHARS, overlapChars = CHUNK_OVERLAP_CHARS } = {}) {
  const clean = String(text || "")
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (!clean) return [];
  /** @type {string[]} */
  const chunks = [];
  let start = 0;
  while (start < clean.length && chunks.length < MAX_CHUNKS) {
    let end = Math.min(start + targetChars, clean.length);
    if (end < clean.length) {
      const window = clean.slice(start, end);
      const brk = Math.max(
        window.lastIndexOf("\n\n"),
        window.lastIndexOf(". "),
        window.lastIndexOf("\n"),
      );
      if (brk > targetChars * 0.5) end = start + brk + 1;
    }
    const piece = clean.slice(start, end).trim();
    if (piece) chunks.push(piece);
    if (end >= clean.length) break;
    start = Math.max(end - overlapChars, start + 1);
  }
  return chunks.map((t, seq) => ({ seq, text: t }));
}

/**
 * @param {ArrayLike<number>} a
 * @param {ArrayLike<number>} b
 * @returns {number} cosine similarity over the shared prefix (0 when a norm is 0)
 */
export function cosineSim(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom ? dot / denom : 0;
}

/**
 * The k most query-similar chunks, best first.
 * @param {Array<{docId: string, seq: number, text: string, vector: ArrayLike<number>}>} chunks
 * @param {ArrayLike<number>} queryVector
 * @param {number} k
 * @returns {Match[]}
 */
export function topKChunks(chunks, queryVector, k) {
  return chunks
    .map((c) => ({ docId: c.docId, seq: c.seq, text: c.text, score: cosineSim(queryVector, c.vector) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}

/**
 * @param {ArrayLike<number>} arr embedding vector
 * @returns {string} base64 of the little-endian float32 bytes
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

// ---- IndexedDB --------------------------------------------------------------

/** @type {Promise<IDBDatabase> | null} */
let dbPromise = null;

/** @returns {Promise<IDBDatabase>} */
function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("docs")) db.createObjectStore("docs", { keyPath: "id" });
      if (!db.objectStoreNames.contains("chunks")) {
        const store = db.createObjectStore("chunks", { keyPath: "key" });
        store.createIndex("docId", "docId");
      }
      // Metadata rows for OPFS-stored original files (public/js/opfs.js).
      if (!db.objectStoreNames.contains("files")) db.createObjectStore("files", { keyPath: "id" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

/**
 * @template T
 * @param {IDBRequest<T>} req
 * @returns {Promise<T>}
 */
const reqToPromise = (req) =>
  new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

/**
 * @param {string} name object store name
 * @param {IDBTransactionMode} mode
 * @returns {Promise<IDBObjectStore>} the store on a fresh single-store transaction
 */
async function store(name, mode) {
  const db = await openDb();
  return db.transaction(name, mode).objectStore(name);
}

// Small facade opfs.js uses for its metadata rows, so the OPFS module never
// has to know this database's layout.
export const filesMetaStore = {
  /** @param {{id: string, [k: string]: unknown}} rec */
  put: async (rec) => reqToPromise((await store("files", "readwrite")).put(rec)),
  /** @param {string} id */
  delete: async (id) => reqToPromise((await store("files", "readwrite")).delete(id)),
  getAll: async () => reqToPromise((await store("files", "readonly")).getAll()),
};

// ---- embedding via the server proxy -----------------------------------------

/**
 * @param {string[]} texts
 * @param {"passage" | "query"} kind embedding prefix the server applies
 * @returns {Promise<{vectors: Float32Array[], dims: number, model: string}>}
 */
async function embedBatch(texts, kind) {
  const res = await fetch("/api/embed", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ texts, kind }),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error || "Embedding failed (" + res.status + ")");
  return { vectors: data.vectors.map(b64ToF32), dims: data.dims, model: data.model };
}

// ---- the index --------------------------------------------------------------

/** @param {string} docId */
export async function hasDoc(docId) {
  return !!(await reqToPromise((await store("docs", "readonly")).get(docId)));
}

/**
 * @param {string} docId
 * @returns {Promise<DocRow | null>}
 */
export async function getDoc(docId) {
  return (await reqToPromise((await store("docs", "readonly")).get(docId))) || null;
}

/** @returns {Promise<DocRow[]>} */
export async function listDocs() {
  return reqToPromise((await store("docs", "readonly")).getAll());
}

/** @param {string} docId */
export async function deleteDoc(docId) {
  const chunks = await chunksForDoc(docId);
  const s = await store("chunks", "readwrite");
  for (const c of chunks) s.delete(c.key);
  await reqToPromise((await store("docs", "readwrite")).delete(docId));
}

/**
 * @param {string} docId
 * @returns {Promise<ChunkRow[]>}
 */
async function chunksForDoc(docId) {
  const s = await store("chunks", "readonly");
  return reqToPromise(s.index("docId").getAll(docId));
}

/**
 * Doc row + all its chunk rows in ONE transaction, so a failure can't leave
 * a doc row pointing at half-written chunks.
 * @param {DocRow} doc
 * @param {Chunk[]} chunks
 * @param {Float32Array[]} vectors parallel to `chunks`
 */
async function putDocLocally(doc, chunks, vectors) {
  const db = await openDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(["docs", "chunks"], "readwrite");
    tx.objectStore("docs").put(doc);
    const cs = tx.objectStore("chunks");
    chunks.forEach((c, i) => {
      cs.put({ key: `${doc.id}:${c.seq}`, docId: doc.id, seq: c.seq, text: c.text, vector: vectors[i] });
    });
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

/**
 * One locally-indexed document in its portable form — the same
 * chunks-plus-b64-vectors shape the server index stores in R2 and
 * importDoc below accepts, so moving a doc never re-embeds. Used by the
 * server push right below and by the project vault archive
 * (public/js/vault.js).
 * @param {string} docId
 * @returns {Promise<?{docId: string, name: string, chunks: Chunk[],
 *   vectors: string[], createdAt: number}>} null when the doc isn't in the
 *   local index
 */
export async function exportDoc(docId) {
  const doc = await reqToPromise((await store("docs", "readonly")).get(docId));
  if (!doc) return null;
  const chunks = (await chunksForDoc(docId)).sort((a, b) => a.seq - b.seq);
  return {
    docId,
    name: doc.name,
    chunks: chunks.map((c) => ({ seq: c.seq, text: c.text })),
    vectors: chunks.map((c) => f32ToB64(c.vector)),
    createdAt: doc.addedAt || Date.now(),
  };
}

/**
 * Push one locally-indexed document to the server index (vectors included,
 * so the server never re-embeds). Used at index time when the knob is on,
 * and by sync.js when it's switched on later.
 * @param {string} docId
 */
export async function pushDocToServer(docId) {
  const data = await exportDoc(docId);
  if (!data) throw new Error("Document not in the local index.");
  const res = await fetch("/api/rag/index", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new Error(data?.error || "Server indexing failed (" + res.status + ")");
  }
}

/**
 * Chunk + embed + store one document. opts.cloud=false skips the server
 * mirror even when the account knob is on — the per-project storage opt-out
 * (public/js/projects.js decides).
 * @param {string} docId
 * @param {string} name display name
 * @param {string} fullText
 * @param {{onProgress?: (done: number, total: number) => void, cloud?: boolean}} [opts]
 *   onProgress drives the attachment card's indexing badge
 * @returns {Promise<{chunkCount: number, truncated: boolean}>}
 */
export async function indexDocument(docId, name, fullText, { onProgress, cloud = true } = {}) {
  const chunks = chunkText(fullText);
  if (!chunks.length) throw new Error("No indexable text.");
  const truncated = chunks.length >= MAX_CHUNKS; // chunker stops there — tail unindexed
  const vectors = new Array(chunks.length);
  for (let i = 0; i < chunks.length; i += EMBED_BATCH) {
    const batch = chunks.slice(i, i + EMBED_BATCH);
    const { vectors: vs } = await embedBatch(batch.map((c) => c.text), "passage");
    vs.forEach((v, j) => { vectors[i + j] = v; });
    onProgress?.(Math.min(i + EMBED_BATCH, chunks.length), chunks.length);
  }
  const doc = {
    id: docId,
    name,
    chunkCount: chunks.length,
    dims: vectors[0].length,
    chars: fullText.length,
    addedAt: Date.now(),
  };
  await putDocLocally(doc, chunks, vectors);
  // Mirror to the server index when cloud storage is on — fail-soft: a
  // hiccup here leaves a perfectly working local index (sync.js re-pushes).
  if (cloud && serverHistoryOn() && serverRagAvailable()) {
    try {
      await pushDocToServer(docId);
    } catch (err) {
      console.warn("rag: server mirror failed, keeping local index", err);
    }
  }
  return { chunkCount: chunks.length, truncated };
}

/**
 * Incrementally extend an indexed doc (creating it on first call) — the
 * growing-source case (project chats, chat-rag.js): only the NEW text is
 * chunked and embedded, appended after the existing chunks. `meta` fields
 * ride on the doc row (chat-rag.js keeps its srcMsgs progress counter
 * there). The server mirror re-pushes the WHOLE doc — /api/rag/index
 * replaces per docId and vectors travel along, so nothing is re-embedded;
 * for turn-sized increments that's bandwidth, not spend.
 * @param {string} docId
 * @param {string} name display name
 * @param {string} text the NEW text only
 * @param {{meta?: object, cloud?: boolean}} [opts]
 * @returns {Promise<{chunkCount: number, appended: number}>}
 */
export async function appendToDoc(docId, name, text, { meta = {}, cloud = true } = {}) {
  const existing = await getDoc(docId);
  const startSeq = existing?.chunkCount || 0;
  const pieces = chunkText(text)
    .map((c) => ({ seq: startSeq + c.seq, text: c.text }))
    .slice(0, Math.max(0, MAX_CHUNKS - startSeq)); // server per-doc cap
  if (!pieces.length) return { chunkCount: startSeq, appended: 0 };
  const vectors = new Array(pieces.length);
  for (let i = 0; i < pieces.length; i += EMBED_BATCH) {
    const batch = pieces.slice(i, i + EMBED_BATCH);
    const { vectors: vs } = await embedBatch(batch.map((c) => c.text), "passage");
    vs.forEach((v, j) => { vectors[i + j] = v; });
  }
  const doc = {
    id: docId,
    name,
    chunkCount: startSeq + pieces.length,
    dims: vectors[0].length,
    chars: (existing?.chars || 0) + text.length,
    addedAt: existing?.addedAt || Date.now(),
    ...meta,
  };
  await putDocLocally(doc, pieces, vectors);
  if (cloud && serverHistoryOn() && serverRagAvailable()) {
    try {
      await pushDocToServer(docId);
    } catch (err) {
      console.warn("rag: server mirror failed, keeping local index", err);
    }
  }
  return { chunkCount: doc.chunkCount, appended: pieces.length };
}

// ---- retrieval --------------------------------------------------------------

/**
 * @param {string[]} docIds
 * @param {string} queryText
 * @param {number} topK
 * @returns {Promise<Match[]>}
 */
async function retrieveLocal(docIds, queryText, topK) {
  const { vectors } = await embedBatch([queryText.slice(0, 2000)], "query");
  /** @type {ChunkRow[]} */
  const all = [];
  for (const docId of docIds) all.push(...(await chunksForDoc(docId)));
  return topKChunks(all, vectors[0], topK);
}

/**
 * @param {string[]} docIds
 * @param {string} queryText
 * @param {number} topK
 * @returns {Promise<Match[]>}
 */
async function retrieveServer(docIds, queryText, topK) {
  const res = await fetch("/api/rag/query", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query: queryText.slice(0, 2000), docIds, topK }),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error || "Retrieval failed (" + res.status + ")");
  return data.matches || [];
}

/**
 * The most relevant chunks for this question across the given documents.
 * Prefers the server index when cloud storage is on (it may hold documents
 * indexed on ANOTHER device); falls back to — and merges nothing from —
 * the local index when the server comes up empty or errors.
 * @param {string[]} docIds
 * @param {string} queryText
 * @param {number} [topK]
 * @returns {Promise<Match[]>}
 */
export async function retrieve(docIds, queryText, topK = 8) {
  if (!docIds.length || !queryText.trim()) return [];
  if (serverHistoryOn() && serverRagAvailable()) {
    try {
      const matches = await retrieveServer(docIds, queryText, topK);
      if (matches.length) return matches;
    } catch (err) {
      console.warn("rag: server retrieval failed, trying local index", err);
    }
  }
  try {
    return await retrieveLocal(docIds, queryText, topK);
  } catch (err) {
    console.warn("rag: retrieval failed", err);
    return [];
  }
}

/**
 * Positional fallback when semantic retrieval is unavailable (embedding
 * endpoint down mid-conversation): the opening chunks still give the model
 * the document's framing rather than nothing at all.
 * @param {string} docId
 * @param {number} [n]
 * @returns {Promise<Match[]>}
 */
export async function firstChunks(docId, n = 4) {
  const chunks = (await chunksForDoc(docId)).sort((a, b) => a.seq - b.seq).slice(0, n);
  return chunks.map((c) => ({ docId: c.docId, seq: c.seq, text: c.text, score: 0 }));
}

// ---- import (sync.js) ---------------------------------------------------------

/**
 * Import a document in the shape the server stores in R2 (src/rag.js) —
 * chunks + b64 vectors — so a cloud→local pull never re-embeds. sync.js's
 * push direction goes through pushDocToServer above.
 * @param {{docId?: string, name?: string, chunks?: Chunk[], vectors?: string[], createdAt?: number} | null | undefined} data
 * @returns {Promise<boolean>} false when the payload isn't importable
 */
export async function importDoc(data) {
  if (!data?.docId || !Array.isArray(data.chunks) || !Array.isArray(data.vectors)) return false;
  const vectors = data.vectors.map(b64ToF32);
  await putDocLocally(
    {
      id: data.docId,
      name: data.name || data.docId,
      chunkCount: data.chunks.length,
      dims: vectors[0]?.length || 0,
      chars: data.chunks.reduce((s, c) => s + (c.text?.length || 0), 0),
      addedAt: data.createdAt || Date.now(),
    },
    data.chunks,
    vectors,
  );
  return true;
}
