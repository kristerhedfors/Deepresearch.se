// The project vault: store a whole project — record, conversations,
// original file bytes, and its slice of the RAG index (the dr_rag vector
// "database", vectors included so nothing re-embeds) — as ONE archive,
// encrypted IN THIS BROWSER under a secret only the user holds, and parked
// server-side (PUT /api/vault/:id, src/vault.js). This is how a LOCAL-ONLY
// project (its cloud knob off, or the whole account knob off) gets a
// backup / cross-device transport without giving up its privacy posture:
// the server stores one opaque blob — no names, no text, no index, not
// even which project it is.
//
// The secret is the whole key hierarchy:
//   secret (160 bits, CSPRNG)
//     ├─ HKDF-SHA-256(info="…vault id v1")  → the storage id (locator)
//     └─ HKDF-SHA-256(info="…vault key v1") → the AES-256-GCM key
// Knowing the secret is both finding the blob and decrypting it; the
// server never sees the secret or the key (unlike the history-key model,
// where the server could re-derive the key — here it holds nothing that
// decrypts anything). Losing the secret loses the copy — there is no
// recovery path, by design.
//
// Secret format (generateVaultSecret): "DR1-" + 8 groups of 4 chars from
// the Crockford base32 alphabet (no I, L, O, U — nothing that misreads as
// 1 or 0), 160 bits from crypto.getRandomValues. Copy-safe by
// construction: case-insensitive, separators ignored, and the classic
// transcription mistakes (O for 0, I/l for 1) are mapped back on input
// (normalizeVaultSecret) — a secret read over the phone or retyped from
// paper still works.
//
// Re-storing a project rotates the secret: the new archive goes up under
// the NEW secret's id, the record's remembered vaultId is updated, and the
// old blob is deleted — the previous secret stops working.
//
// The pure core (secret generation/normalization, the Crockford codec,
// archive validation) is import-safe and Node-tested (vault.test.js); the
// store/load orchestration at the bottom touches IndexedDB/OPFS/fetch.

import { chatDocId } from "./chat-rag.js";
import {
  decryptBytes,
  encryptBytes,
  loadConversation,
  saveConversation,
  saveProjectRecord,
} from "./history-store.js";
import { listOriginals, loadOriginal, opfsAvailable, saveOriginal } from "./opfs.js";
import {
  conversationsOfProject,
  getProject,
  refreshProjects,
  setProjectVaultId,
} from "./projects.js";
import { exportDoc, hasDoc, importDoc } from "./rag.js";

// ---- the secret (pure core) ---------------------------------------------------

// Crockford base32: digits + uppercase letters minus I, L, O, U. 32 symbols
// = 5 bits each; 32 chars = 160 bits.
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const SECRET_BYTES = 20; // 160 bits
const SECRET_CHARS = (SECRET_BYTES * 8) / 5; // 32
const PREFIX = "DR1"; // marks what the string is; not part of the entropy

/** 160 bits from the CSPRNG, formatted "DR1-XXXX-XXXX-…" (8 groups of 4). */
export function generateVaultSecret() {
  const bytes = crypto.getRandomValues(new Uint8Array(SECRET_BYTES));
  const chars = encodeCrockford(bytes);
  return PREFIX + "-" + (chars.match(/.{4}/g) || []).join("-");
}

/**
 * Forgiving input normalization: uppercase, every separator dropped, the
 * "DR1" prefix stripped when present, and the classic misreads mapped back
 * (O→0, I→1, L→1). Returns the bare 32-char payload for a well-formed
 * secret; anything else comes back as-is-cleaned for vaultSecretValid to
 * reject.
 * @param {string} input
 * @returns {string}
 */
export function normalizeVaultSecret(input) {
  let s = String(input || "").toUpperCase().replace(/[^0-9A-Z]/g, "");
  // Map misreads BEFORE the prefix check, so even a mangled prefix
  // ("DRl-…", "DRi-…") is recognized and stripped.
  s = s.replace(/O/g, "0").replace(/[IL]/g, "1");
  if (s.length === SECRET_CHARS + PREFIX.length && s.startsWith(PREFIX)) s = s.slice(PREFIX.length);
  return s;
}

/** @param {string} input @returns {boolean} */
export function vaultSecretValid(input) {
  const s = normalizeVaultSecret(input);
  return s.length === SECRET_CHARS && [...s].every((c) => ALPHABET.includes(c));
}

/** @param {Uint8Array} bytes @returns {string} bit-exact base32, no padding */
export function encodeCrockford(bytes) {
  let out = "";
  let acc = 0;
  let nbits = 0;
  for (const b of bytes) {
    acc = (acc << 8) | b;
    nbits += 8;
    while (nbits >= 5) {
      out += ALPHABET[(acc >>> (nbits - 5)) & 31];
      nbits -= 5;
    }
  }
  if (nbits > 0) out += ALPHABET[(acc << (5 - nbits)) & 31];
  return out;
}

/** @param {string} s normalized base32 @returns {Uint8Array} */
export function decodeCrockford(s) {
  const out = new Uint8Array(Math.floor((s.length * 5) / 8));
  let acc = 0;
  let nbits = 0;
  let i = 0;
  for (const c of s) {
    const v = ALPHABET.indexOf(c);
    if (v < 0) throw new Error("Invalid character in secret: " + c);
    acc = (acc << 5) | v;
    nbits += 5;
    if (nbits >= 8) {
      out[i++] = (acc >>> (nbits - 8)) & 0xff;
      nbits -= 8;
    }
  }
  return out;
}

// ---- key derivation & the encrypted blob ---------------------------------------

// HKDF-SHA-256 over the secret's raw 160 bits, two independent outputs by
// info string. No salt needed: the IKM is itself uniform CSPRNG output.
/**
 * @param {string} secret
 * @returns {Promise<{id: string, key: CryptoKey}>}
 */
export async function deriveVaultLocator(secret) {
  if (!vaultSecretValid(secret)) throw new Error("That doesn't look like a valid vault secret.");
  const ikm = decodeCrockford(normalizeVaultSecret(secret));
  const master = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits", "deriveKey"]);
  const salt = new Uint8Array(32);
  const idBits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt, info: new TextEncoder().encode("deepresearch.se vault id v1") },
    master,
    160,
  );
  const key = await crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt, info: new TextEncoder().encode("deepresearch.se vault key v1") },
    master,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
  return { id: encodeCrockford(new Uint8Array(idBits)), key };
}

/**
 * Archive object → one opaque byte blob: 12-byte IV + AES-256-GCM
 * ciphertext (tag included). The stored form and the wire form are the
 * same bytes.
 * @param {object} archive
 * @param {CryptoKey} key
 * @returns {Promise<Uint8Array>}
 */
export async function encryptVaultArchive(archive, key) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plain = new TextEncoder().encode(JSON.stringify(archive));
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plain));
  const out = new Uint8Array(12 + cipher.length);
  out.set(iv, 0);
  out.set(cipher, 12);
  return out;
}

/**
 * @param {Uint8Array} bytes
 * @param {CryptoKey} key
 * @returns {Promise<object>} throws on tamper/wrong key (GCM authenticates)
 */
export async function decryptVaultArchive(bytes, key) {
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: bytes.slice(0, 12) },
    key,
    bytes.slice(12),
  );
  return JSON.parse(new TextDecoder().decode(plain));
}

// ---- the archive shape (pure core) ----------------------------------------------

// {v: 1, kind, exportedAt, project: {id, name, files, serverStorage, …},
//  conversations: [{id, data}], files: [{id, name, type, bytes(b64)}],
//  ragDocs: [{docId, name, chunks, vectors}]}
export const ARCHIVE_KIND = "deepresearch-project";

/**
 * Structural check on a decrypted archive before anything is imported.
 * @param {any} a
 * @returns {boolean}
 */
export function validateVaultArchive(a) {
  return !!(
    a &&
    typeof a === "object" &&
    a.v === 1 &&
    a.kind === ARCHIVE_KIND &&
    a.project &&
    typeof a.project === "object" &&
    typeof a.project.id === "string" &&
    a.project.id &&
    typeof a.project.name === "string" &&
    Array.isArray(a.conversations) &&
    a.conversations.every((c) => c && typeof c.id === "string" && c.data && typeof c.data === "object") &&
    Array.isArray(a.files) &&
    a.files.every((f) => f && typeof f.id === "string" && typeof f.bytes === "string") &&
    Array.isArray(a.ragDocs) &&
    a.ragDocs.every((d) => d && typeof d.docId === "string" && Array.isArray(d.chunks) && Array.isArray(d.vectors))
  );
}

// Chunked base64 for file-sized buffers (String.fromCharCode over a whole
// multi-MB array overflows the argument list).
/** @param {Uint8Array} bytes @returns {string} */
export function bytesToB64(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

/** @param {string} b64 @returns {Uint8Array} */
export function b64ToBytes(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// ---- store (project → encrypted archive → server) --------------------------------

/**
 * Packs the project and everything in its scope into one archive, encrypts
 * it under a FRESH secret, uploads it, and rotates: the record remembers
 * the new vault id and the previous blob (old secret) is deleted. The
 * plaintext never leaves the browser — file originals resting encrypted
 * under the history key are decrypted locally first so the archive depends
 * on nothing but the secret.
 * @param {string} projectId
 * @param {(msg: string) => void} [onProgress]
 * @returns {Promise<{secret: string, counts: {conversations: number,
 *   files: number, docs: number}, missingFiles: string[]}>}
 */
export async function storeProjectToVault(projectId, onProgress = () => {}) {
  const p = getProject(projectId);
  if (!p) throw new Error("Project not found.");
  const secret = generateVaultSecret();
  const { id: vaultId, key } = await deriveVaultLocator(secret);
  const previousVaultId = p.vaultId || null;

  onProgress("Packing conversations…");
  const conversations = [];
  for (const c of await conversationsOfProject(projectId)) {
    const data = await loadConversation(c.id).catch(() => null);
    if (data) conversations.push({ id: c.id, data });
  }

  onProgress("Packing files…");
  const files = [];
  const missingFiles = [];
  const metaById = new Map((await listOriginals().catch(() => [])).map((m) => [m.id, m]));
  for (const f of p.files || []) {
    const blob = await loadOriginal(f.id);
    if (!blob) {
      missingFiles.push(f.name || f.id);
      continue;
    }
    let bytes = new Uint8Array(await blob.arrayBuffer());
    if (metaById.get(f.id)?.enc) {
      // Encrypted under the history key — decrypt so the archive is
      // self-contained under the vault secret alone. Requires the key;
      // without it the file is reported missing, never packed unreadable.
      try {
        bytes = await decryptBytes(bytes);
      } catch {
        missingFiles.push(f.name || f.id);
        continue;
      }
    }
    files.push({ id: f.id, name: f.name, type: f.type || "application/octet-stream", bytes: bytesToB64(bytes) });
  }

  onProgress("Packing the document index…");
  const ragDocs = [];
  const docIds = [
    ...(p.files || []).filter((f) => f.indexed).map((f) => f.id),
    ...conversations.map((c) => chatDocId(c.id)),
  ];
  for (const docId of docIds) {
    const doc = await exportDoc(docId).catch(() => null);
    if (doc) ragDocs.push(doc);
  }

  const archive = {
    v: 1,
    kind: ARCHIVE_KIND,
    exportedAt: Date.now(),
    project: { ...p, vaultId },
    conversations,
    files,
    ragDocs,
  };

  onProgress("Encrypting…");
  const blob = await encryptVaultArchive(archive, key);

  onProgress("Uploading the encrypted archive…");
  const res = await fetch("/api/vault/" + encodeURIComponent(vaultId), {
    method: "PUT",
    headers: { "content-type": "application/octet-stream" },
    body: blob,
  });
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new Error(data?.error || "Storing the archive failed (" + res.status + ").");
  }

  // Remember the id (inside the encrypted record) so the next store rotates,
  // and retire the old blob — its secret stops working now.
  await setProjectVaultId(projectId, vaultId);
  if (previousVaultId && previousVaultId !== vaultId) {
    fetch("/api/vault/" + encodeURIComponent(previousVaultId), { method: "DELETE" }).catch(() => {});
  }

  return {
    secret,
    counts: { conversations: conversations.length, files: files.length, docs: ragDocs.length },
    missingFiles,
  };
}

// ---- load (secret → decrypt → import) ---------------------------------------------

/**
 * Fetches and decrypts the archive the secret points at, then imports it —
 * last-write-wins by updatedAt (the app-wide rule), gap-filling everything
 * missing. Import honors the archived project's OWN cloud posture: a
 * local-only project loads as local-only (its dual-writes stay off), so
 * loading never silently uploads anything readable.
 * @param {string} secret
 * @param {(msg: string) => void} [onProgress]
 * @returns {Promise<{projectId: string, name: string,
 *   imported: {record: boolean, conversations: number, files: number, docs: number}}>}
 */
export async function loadProjectFromVault(secret, onProgress = () => {}) {
  if (!vaultSecretValid(secret)) {
    throw new Error("That doesn't look like a vault secret (DR1-… with 32 characters).");
  }
  const { id: vaultId, key } = await deriveVaultLocator(secret);

  onProgress("Fetching the encrypted archive…");
  const res = await fetch("/api/vault/" + encodeURIComponent(vaultId));
  if (res.status === 404) throw new Error("No stored project found for that secret.");
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new Error(data?.error || "Fetching the archive failed (" + res.status + ").");
  }

  onProgress("Decrypting…");
  let archive;
  try {
    archive = await decryptVaultArchive(new Uint8Array(await res.arrayBuffer()), key);
  } catch {
    throw new Error("The archive could not be decrypted — it may be corrupted.");
  }
  if (!validateVaultArchive(archive)) throw new Error("The archive contents are not usable.");

  const project = archive.project;
  const cloud = project.serverStorage !== false; // dual-writes follow the project's own knob
  const imported = { record: false, conversations: 0, files: 0, docs: 0 };

  // The record — LWW against any local copy of the same project.
  onProgress("Importing the project…");
  const existing = getProject(project.id);
  if (!existing || (existing.updatedAt || 0) < (project.updatedAt || 0)) {
    const { id, ...data } = project;
    await saveProjectRecord(id, data, { cloud });
    imported.record = true;
  }

  // Conversations — each LWW by updatedAt; project chats store readable
  // ({data}) exactly as saveConversation always does for projectId records.
  const existingConvs = new Map(
    (await conversationsOfProject(project.id).catch(() => [])).map((c) => [c.id, c.updatedAt || 0]),
  );
  for (const c of archive.conversations) {
    if ((existingConvs.get(c.id) || 0) >= (c.data.updatedAt || 0)) continue;
    await saveConversation(c.id, { ...c.data, projectId: project.id }, { cloud });
    imported.conversations++;
  }

  // Files — gap-fill only (an original never changes under the same id).
  // Restored into their normal STORAGE FORM: readable for RAG-indexed docs,
  // encrypted under the history key for everything else — and if that key
  // is unavailable the file is skipped, never stored readable.
  const indexedIds = new Set(archive.ragDocs.map((d) => d.docId));
  if (await opfsAvailable()) {
    const localIds = new Set((await listOriginals()).map((m) => m.id));
    for (const f of archive.files) {
      if (localIds.has(f.id)) continue;
      const plain = b64ToBytes(f.bytes);
      let stored = plain;
      let enc = false;
      if (!indexedIds.has(f.id)) {
        try {
          stored = await encryptBytes(plain.buffer);
          enc = true;
        } catch {
          continue; // no history key — store nothing rather than plaintext
        }
      }
      await saveOriginal(f.id, new Blob([stored], { type: "application/octet-stream" }), {
        name: f.name,
        type: f.type,
        enc,
      });
      imported.files++;
    }
  }

  // The RAG index — gap-fill; vectors ride along, nothing re-embeds.
  onProgress("Importing the document index…");
  for (const d of archive.ragDocs) {
    if (await hasDoc(d.docId).catch(() => false)) continue;
    if (await importDoc(d).catch(() => false)) imported.docs++;
  }

  await refreshProjects();
  return { projectId: project.id, name: project.name, imported };
}
