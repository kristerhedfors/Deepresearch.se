// Encrypted, fully client-side chat history: every past conversation is
// stored in this browser's IndexedDB, AES-256-GCM encrypted with a key
// this module fetches from GET /api/history-key (src/history-key.js) and
// keeps ONLY in memory for the life of the page — never written to
// localStorage, sessionStorage, or IndexedDB itself.
//
// What this buys (documented in full for users at /help/):
//   - Offline extraction of this browser's storage (a stolen device, a
//     disk image) recovers only ciphertext — the key that unlocks it was
//     never persisted anywhere on disk.
//   - A server compromise recovers the server-side secret the key is
//     derived from, but never the ciphertext itself, since conversations
//     never leave this browser.
//   - History does not sync across browsers/devices — each one holds its
//     own encrypted copy — and clearing this browser's site data deletes
//     it for good; there is no server-side copy to recover it from.
//
// IndexedDB (not localStorage) because conversations — especially with
// attached images — can be large, and its async, structured API is the
// modern standard for exactly this amount of client-side data.

// Cloud copies (opt-in): when the account's server_history knob is ON
// (settings.js), every locally-saved record is ALSO mirrored — as the
// same opaque {iv, ciphertext} blob, still unreadable without the key —
// to the server's R2 store (src/storage.js), and deletes propagate. The
// local IndexedDB copy always stays (lazy cache + the only copy when the
// knob is off). Bulk moves in either direction live in sync.js; this
// module only dual-writes the record it just touched.
//
// THE ONE EXCEPTION — project chats rest READABLE, in both locations.
// Conversations inside a project are RAG-indexed (chat-rag.js) so the
// project's other chats can retrieve from them, and this app's storage
// rule is that indexed material rests readable (the index already holds
// its text in the clear — encrypting the record would protect nothing
// the index doesn't expose; same rule as RAG-indexed documents). Their
// records are stored as {data} instead of {iv, ciphertext}. Everything
// outside a project keeps the encrypted-always posture above.

import { serverHistoryOn } from "./settings.js";

const DB_NAME = "dr_history";
// v2 adds the "projects" store (public/js/projects.js): one encrypted
// record per project, same {iv, ciphertext} shape as a conversation.
const DB_VERSION = 2;
const STORE = "conversations";
const PROJECTS = "projects";

let dbPromise = null;
let keyPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: "id" });
        store.createIndex("updatedAt", "updatedAt");
      }
      if (!db.objectStoreNames.contains(PROJECTS)) {
        db.createObjectStore(PROJECTS, { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

// Fetched once per page load and held only in this module-level variable —
// never written to disk-backed storage. A reload re-fetches it (cheap: one
// authenticated GET), which is the point — nothing persists at rest.
function historyKey() {
  if (!keyPromise) {
    keyPromise = fetch("/api/history-key")
      .then((res) => {
        if (!res.ok) throw new Error("history key unavailable");
        return res.json();
      })
      .then(({ key }) =>
        crypto.subtle.importKey("raw", base64ToBytes(key), { name: "AES-GCM" }, false, [
          "encrypt",
          "decrypt",
        ]),
      )
      .catch((err) => {
        keyPromise = null; // let a later call retry instead of caching the failure
        throw err;
      });
  }
  return keyPromise;
}

// Whether encrypted history is usable at all right now (server configured
// it, IndexedDB exists in this browser). The sidebar hides itself when this
// is false rather than offering a feature that silently can't persist.
export async function historyAvailable() {
  if (typeof indexedDB === "undefined") return false;
  try {
    await historyKey();
    return true;
  } catch {
    return false;
  }
}

async function encryptRecord(key, obj) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plain = new TextEncoder().encode(JSON.stringify(obj));
  const cipher = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plain);
  return { iv: bytesToBase64(iv), ciphertext: bytesToBase64(new Uint8Array(cipher)) };
}

async function decryptRecord(key, iv, ciphertext) {
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64ToBytes(iv) },
    key,
    base64ToBytes(ciphertext),
  );
  return JSON.parse(new TextDecoder().decode(plain));
}

// Raw-bytes variants for original attached files (attachments.js /
// sync.js): same key, same AES-GCM, but binary in/out — the 12-byte IV is
// prepended to the ciphertext so one opaque byte blob is the whole stored
// form. Throws when the key is unavailable; callers must then store
// NOTHING rather than fall back to plaintext (same fail-closed rule as
// the conversation store).
export async function encryptBytes(buf) {
  const key = await historyKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, buf));
  const out = new Uint8Array(12 + cipher.length);
  out.set(iv, 0);
  out.set(cipher, 12);
  return out;
}

export async function decryptBytes(bytes) {
  const key = await historyKey();
  const iv = bytes.slice(0, 12);
  return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, bytes.slice(12)));
}

function reqToPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// One stored row → its conversation data, whichever form it rests in:
// readable {data} for project chats (see the header), encrypted
// {iv, ciphertext} for everything else.
async function readRecordData(r) {
  if (r.data) return r.data;
  const key = await historyKey();
  return decryptRecord(key, r.iv, r.ciphertext);
}

// Sidebar listing: every encrypted conversation must be decrypted just to
// read its title (the title lives inside the ciphertext, same as the rest
// of the content — it can reveal the topic, so it isn't left in the
// clear). Fine at the scale a single person's chat history reaches; a
// record that fails to decrypt (corrupted, or encrypted under a
// since-rotated secret) is skipped rather than crashing the whole list.
/**
 * @returns {Promise<Array<{id: string, title: string, updatedAt: number,
 *   projectId: ?string}>>} newest first; undecryptable rows are skipped
 *   (counted by undecryptableConversations)
 */
export async function listConversations() {
  const db = await openDb();
  const records = await reqToPromise(db.transaction(STORE, "readonly").objectStore(STORE).getAll());
  const items = [];
  lastUndecryptable = 0;
  for (const r of records) {
    try {
      const data = await readRecordData(r);
      items.push({ id: r.id, title: data.title, updatedAt: r.updatedAt, projectId: r.projectId || null });
    } catch {
      // Undecryptable — leave it out of the list rather than break the
      // sidebar, but COUNT it so the sidebar can say "N conversations can't
      // be decrypted" instead of presenting a silently empty list (an
      // undecryptable store looks identical to an empty one otherwise —
      // that ambiguity cost real debugging time on 2026-07-08).
      lastUndecryptable++;
    }
  }
  items.sort((a, b) => b.updatedAt - a.updatedAt);
  return items;
}

// How many stored conversations the LAST listConversations() call had to
// skip because they wouldn't decrypt (corrupted, or written under a
// different key). 0 until a list has run.
let lastUndecryptable = 0;
export function undecryptableConversations() {
  return lastUndecryptable;
}

/**
 * @param {string} id
 * @returns {Promise<?object>} the decrypted conversation data (stream.js
 *   ConversationRecord), or null when no row exists
 */
export async function loadConversation(id) {
  const db = await openDb();
  const r = await reqToPromise(db.transaction(STORE, "readonly").objectStore(STORE).get(id));
  if (!r) return null;
  return readRecordData(r);
}

// data: {title, messages, model, budgetS, webSearch, createdAt, updatedAt,
// ragDocs, projectId}. The row keeps projectId OUTSIDE the ciphertext —
// LOCALLY ONLY (never uploaded; the cloud body below carries just the
// stored form + timestamps): it's a random uuid revealing grouping, not
// content, and sync needs it to honor a project's cloud-off knob without
// decrypting every record. A conversation WITH a projectId is a project
// chat — RAG-indexed for cross-chat retrieval, so its record rests
// readable ({data}) instead of encrypted (the header explains the rule).
// opts.cloud=false skips the cloud mirror even when the account knob is
// on — that's the per-project opt-out (public/js/projects.js decides).
/**
 * @param {string} id
 * @param {object} data  the conversation record (stream.js ConversationRecord)
 * @param {{cloud?: boolean}} [opts]
 */
export async function saveConversation(id, data, { cloud = true } = {}) {
  const db = await openDb();
  let stored;
  let body;
  if (data.projectId) {
    stored = { data };
    body = { data, updatedAt: data.updatedAt, createdAt: data.createdAt };
  } else {
    const key = await historyKey();
    const enc = await encryptRecord(key, data);
    stored = { iv: enc.iv, ciphertext: enc.ciphertext };
    body = { iv: enc.iv, ciphertext: enc.ciphertext, updatedAt: data.updatedAt, createdAt: data.createdAt };
  }
  const record = {
    id,
    updatedAt: data.updatedAt,
    projectId: data.projectId || null,
    ...stored,
  };
  await reqToPromise(
    db.transaction(STORE, "readwrite").objectStore(STORE).put(record),
  );
  // Cloud mirror (fire-and-forget): a failed push must never surface as a
  // chat error — sync.js reconciles by updatedAt on the next opportunity.
  if (serverHistoryOn() && cloud) {
    fetch("/api/convos/" + encodeURIComponent(id), {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }).catch(() => {});
  }
}

export async function deleteConversation(id) {
  const db = await openDb();
  await reqToPromise(db.transaction(STORE, "readwrite").objectStore(STORE).delete(id));
  if (serverHistoryOn()) {
    fetch("/api/convos/" + encodeURIComponent(id), { method: "DELETE" }).catch(() => {});
  }
}

// ---- raw (storage-form) record access for sync.js ---------------------------
// Sync moves records in their stored form as-is — ciphertext blobs without
// a decrypt/re-encrypt round trip (no need for the key on the bulk path),
// readable {data} records (project chats) verbatim.

export async function exportEncryptedRecords() {
  const db = await openDb();
  const records = await reqToPromise(db.transaction(STORE, "readonly").objectStore(STORE).getAll());
  return records.map((r) => ({
    id: r.id,
    updatedAt: r.updatedAt,
    projectId: r.projectId || null,
    iv: r.iv,
    ciphertext: r.ciphertext,
    data: r.data,
  }));
}

// Imports one server-side record (either stored form), last-write-wins by
// updatedAt. Returns true when the local store actually changed. For an
// encrypted record the projectId row field is recovered by decrypting the
// incoming blob (this device has the key) — the cloud copy deliberately
// doesn't carry it in the clear; a readable project-chat record carries it
// in its data.
/**
 * @param {string} id
 * @param {object} record  server-side stored form ({iv, ciphertext} or {data})
 * @returns {Promise<boolean>} true when the local store actually changed
 */
export async function importEncryptedRecord(id, record) {
  const isPlain = record?.data && typeof record.data === "object";
  if (!isPlain && (!record?.iv || !record?.ciphertext)) return false;
  const db = await openDb();
  const existing = await reqToPromise(db.transaction(STORE, "readonly").objectStore(STORE).get(id));
  const updatedAt = Number(record.updatedAt) || 0;
  if (existing && existing.updatedAt >= updatedAt) return false;
  let projectId = existing?.projectId || null;
  let stored;
  if (isPlain) {
    projectId = record.data.projectId || null;
    stored = { data: record.data };
  } else {
    stored = { iv: record.iv, ciphertext: record.ciphertext };
    try {
      const key = await historyKey();
      const data = await decryptRecord(key, record.iv, record.ciphertext);
      projectId = data.projectId || null;
    } catch {
      // Undecryptable content still imports (it may decrypt after a key
      // becomes available again); it just can't be project-scoped yet.
    }
  }
  await reqToPromise(
    db
      .transaction(STORE, "readwrite")
      .objectStore(STORE)
      .put({ id, updatedAt, projectId, ...stored }),
  );
  return true;
}

// ---- project records (public/js/projects.js owns the shape) ----------------
// Same encrypted-record pattern as conversations, in their own store and
// their own R2 family. `data`: {name, files, notes?, serverStorage,
// createdAt, updatedAt} — everything, name included, inside the ciphertext.

export async function saveProjectRecord(id, data, { cloud = true } = {}) {
  const key = await historyKey();
  const db = await openDb();
  const enc = await encryptRecord(key, data);
  await reqToPromise(
    db
      .transaction(PROJECTS, "readwrite")
      .objectStore(PROJECTS)
      .put({ id, updatedAt: data.updatedAt, iv: enc.iv, ciphertext: enc.ciphertext }),
  );
  if (serverHistoryOn() && cloud) {
    fetch("/api/projects/" + encodeURIComponent(id), {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        iv: enc.iv,
        ciphertext: enc.ciphertext,
        updatedAt: data.updatedAt,
        createdAt: data.createdAt,
      }),
    }).catch(() => {});
  }
}

export async function listProjectRecords() {
  const key = await historyKey();
  const db = await openDb();
  const records = await reqToPromise(
    db.transaction(PROJECTS, "readonly").objectStore(PROJECTS).getAll(),
  );
  const items = [];
  for (const r of records) {
    try {
      items.push({ id: r.id, ...(await decryptRecord(key, r.iv, r.ciphertext)) });
    } catch {
      // Undecryptable — skip rather than break the projects list.
    }
  }
  items.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  return items;
}

export async function deleteProjectRecord(id, { cloud = true } = {}) {
  const db = await openDb();
  await reqToPromise(db.transaction(PROJECTS, "readwrite").objectStore(PROJECTS).delete(id));
  if (serverHistoryOn() && cloud) {
    fetch("/api/projects/" + encodeURIComponent(id), { method: "DELETE" }).catch(() => {});
  }
}

export async function exportEncryptedProjectRecords() {
  const db = await openDb();
  const records = await reqToPromise(
    db.transaction(PROJECTS, "readonly").objectStore(PROJECTS).getAll(),
  );
  return records.map((r) => ({ id: r.id, updatedAt: r.updatedAt, iv: r.iv, ciphertext: r.ciphertext }));
}

export async function importEncryptedProjectRecord(id, record) {
  if (!record?.iv || !record?.ciphertext) return false;
  const db = await openDb();
  const existing = await reqToPromise(
    db.transaction(PROJECTS, "readonly").objectStore(PROJECTS).get(id),
  );
  const updatedAt = Number(record.updatedAt) || 0;
  if (existing && existing.updatedAt >= updatedAt) return false;
  await reqToPromise(
    db
      .transaction(PROJECTS, "readwrite")
      .objectStore(PROJECTS)
      .put({ id, updatedAt, iv: record.iv, ciphertext: record.ciphertext }),
  );
  return true;
}

function bytesToBase64(bytes) {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function base64ToBytes(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
