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
// LEGACY: the removed DRS projects feature (2026-07-12) stored its chats
// READABLE ({data} instead of {iv, ciphertext}) because they were
// RAG-indexed. Old rows in that form still load (readRecordData), and
// re-saving one re-encrypts it — every write is ciphertext now.

import { serverHistoryOn } from "./settings.js";

const DB_NAME = "dr_history";
// v2 added the "projects" store; v3 removes it again (the DRS projects
// feature was removed 2026-07-12 — its records have no reader left).
const DB_VERSION = 3;
const STORE = "conversations";

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
      if (db.objectStoreNames.contains("projects")) {
        db.deleteObjectStore("projects"); // v2 leftover of the removed projects feature
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
// encrypted {iv, ciphertext} normally, readable {data} for legacy chats
// of the removed projects feature (see the header).
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
 * @returns {Promise<Array<{id: string, title: string, updatedAt: number}>>}
 *   newest first; undecryptable rows are skipped
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
      items.push({ id: r.id, title: data.title, updatedAt: r.updatedAt });
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
// ragDocs}. Every write is encrypted — a legacy readable {data} row (the
// removed projects feature) re-encrypts the moment it is re-saved.
/**
 * @param {string} id
 * @param {object} data  the conversation record (stream.js ConversationRecord)
 */
export async function saveConversation(id, data) {
  const db = await openDb();
  const key = await historyKey();
  const enc = await encryptRecord(key, data);
  await reqToPromise(
    db.transaction(STORE, "readwrite").objectStore(STORE).put({
      id,
      updatedAt: data.updatedAt,
      iv: enc.iv,
      ciphertext: enc.ciphertext,
    }),
  );
  // Cloud mirror (fire-and-forget): a failed push must never surface as a
  // chat error — sync.js reconciles by updatedAt on the next opportunity.
  if (serverHistoryOn()) {
    fetch("/api/convos/" + encodeURIComponent(id), {
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

export async function deleteConversation(id) {
  const db = await openDb();
  await reqToPromise(db.transaction(STORE, "readwrite").objectStore(STORE).delete(id));
  if (serverHistoryOn()) {
    fetch("/api/convos/" + encodeURIComponent(id), { method: "DELETE" }).catch(() => {});
  }
}

// ---- raw (storage-form) record access for sync.js ---------------------------
// Sync moves records in their stored form as-is — ciphertext blobs without
// a decrypt/re-encrypt round trip (no need for the key on the bulk path);
// legacy readable {data} rows (the removed projects feature) verbatim.

export async function exportEncryptedRecords() {
  const db = await openDb();
  const records = await reqToPromise(db.transaction(STORE, "readonly").objectStore(STORE).getAll());
  return records.map((r) => ({
    id: r.id,
    updatedAt: r.updatedAt,
    iv: r.iv,
    ciphertext: r.ciphertext,
    data: r.data,
  }));
}

// Imports one server-side record (either stored form — {data} is the
// legacy readable form), last-write-wins by updatedAt. Returns true when
// the local store actually changed.
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
  const stored = isPlain
    ? { data: record.data }
    : { iv: record.iv, ciphertext: record.ciphertext };
  await reqToPromise(
    db
      .transaction(STORE, "readwrite")
      .objectStore(STORE)
      .put({ id, updatedAt, ...stored }),
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
