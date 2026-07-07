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
// readable chunk text. Conversations themselves stay encrypted regardless
// (history-store.js) — the settings UI spells out this split.
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

// ---- pure helpers (unit-tested) ---------------------------------------------

// Sliding chunker: ~targetChars pieces, preferring paragraph/sentence/line
// breaks in the back half of the window, with overlapChars of continuity
// between consecutive chunks so a fact straddling a boundary is still
// retrievable. Returns [{seq, text}].
export function chunkText(text, { targetChars = CHUNK_TARGET_CHARS, overlapChars = CHUNK_OVERLAP_CHARS } = {}) {
  const clean = String(text || "")
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (!clean) return [];
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

// chunks: [{docId, seq, text, vector}] → the k best as
// [{docId, seq, text, score}], best first.
export function topKChunks(chunks, queryVector, k) {
  return chunks
    .map((c) => ({ docId: c.docId, seq: c.seq, text: c.text, score: cosineSim(queryVector, c.vector) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}

export function f32ToB64(arr) {
  const bytes = new Uint8Array(Float32Array.from(arr).buffer);
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

export function b64ToF32(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Float32Array(bytes.buffer);
}

// ---- IndexedDB --------------------------------------------------------------

let dbPromise = null;

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

const reqToPromise = (req) =>
  new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

async function store(name, mode) {
  const db = await openDb();
  return db.transaction(name, mode).objectStore(name);
}

// Small facade opfs.js uses for its metadata rows, so the OPFS module never
// has to know this database's layout.
export const filesMetaStore = {
  put: async (rec) => reqToPromise((await store("files", "readwrite")).put(rec)),
  delete: async (id) => reqToPromise((await store("files", "readwrite")).delete(id)),
  getAll: async () => reqToPromise((await store("files", "readonly")).getAll()),
};

// ---- embedding via the server proxy -----------------------------------------

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

export async function hasDoc(docId) {
  return !!(await reqToPromise((await store("docs", "readonly")).get(docId)));
}

export async function listDocs() {
  return reqToPromise((await store("docs", "readonly")).getAll());
}

export async function deleteDoc(docId) {
  const chunks = await chunksForDoc(docId);
  const s = await store("chunks", "readwrite");
  for (const c of chunks) s.delete(c.key);
  await reqToPromise((await store("docs", "readwrite")).delete(docId));
}

async function chunksForDoc(docId) {
  const s = await store("chunks", "readonly");
  return reqToPromise(s.index("docId").getAll(docId));
}

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

// Push one locally-indexed document to the server index (vectors included,
// so the server never re-embeds). Used at index time when the knob is on,
// and by sync.js when it's switched on later.
export async function pushDocToServer(docId) {
  const doc = await reqToPromise((await store("docs", "readonly")).get(docId));
  if (!doc) throw new Error("Document not in the local index.");
  const chunks = (await chunksForDoc(docId)).sort((a, b) => a.seq - b.seq);
  const res = await fetch("/api/rag/index", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      docId,
      name: doc.name,
      chunks: chunks.map((c) => ({ seq: c.seq, text: c.text })),
      vectors: chunks.map((c) => f32ToB64(c.vector)),
    }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new Error(data?.error || "Server indexing failed (" + res.status + ")");
  }
}

// Chunk + embed + store one document. onProgress(done, total) drives the
// attachment card's indexing badge. Returns {chunkCount, truncated}.
// opts.cloud=false skips the server mirror even when the account knob is
// on — the per-project storage opt-out (public/js/projects.js decides).
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

// ---- retrieval --------------------------------------------------------------

async function retrieveLocal(docIds, queryText, topK) {
  const { vectors } = await embedBatch([queryText.slice(0, 2000)], "query");
  const all = [];
  for (const docId of docIds) all.push(...(await chunksForDoc(docId)));
  return topKChunks(all, vectors[0], topK);
}

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

// The most relevant chunks for this question across the given documents.
// Prefers the server index when cloud storage is on (it may hold documents
// indexed on ANOTHER device); falls back to — and merges nothing from —
// the local index when the server comes up empty or errors.
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

// Positional fallback when semantic retrieval is unavailable (embedding
// endpoint down mid-conversation): the opening chunks still give the model
// the document's framing rather than nothing at all.
export async function firstChunks(docId, n = 4) {
  const chunks = (await chunksForDoc(docId)).sort((a, b) => a.seq - b.seq).slice(0, n);
  return chunks.map((c) => ({ docId: c.docId, seq: c.seq, text: c.text, score: 0 }));
}

// ---- import/export (sync.js) -------------------------------------------------

// The same shape the server stores in R2 (src/rag.js) — chunks + b64
// vectors — so drain/push round-trips without re-embedding.
export async function exportDoc(docId) {
  const doc = await reqToPromise((await store("docs", "readonly")).get(docId));
  if (!doc) return null;
  const chunks = (await chunksForDoc(docId)).sort((a, b) => a.seq - b.seq);
  return {
    docId,
    name: doc.name,
    dims: doc.dims,
    chunkCount: chunks.length,
    chunks: chunks.map((c) => ({ seq: c.seq, text: c.text })),
    vectors: chunks.map((c) => f32ToB64(c.vector)),
  };
}

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
