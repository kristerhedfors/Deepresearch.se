// The project vault: store a whole project — record, conversations,
// original file bytes, and its slice of the RAG index (the dr_rag vector
// "database", vectors included so nothing re-embeds) — as ONE archive,
// encrypted IN THIS BROWSER under a secret only the user holds, and parked
// server-side (PUT /api/vault/:id, src/vault.js). Every Se/rver project is
// already stored in the cloud as ciphertext the server COULD decrypt (it can
// re-derive the history key); the vault is the strictest tier on top of that
// — a copy the server can NEVER read (no names, no text, no index, not even
// which project it is) and can carry across devices with the secret alone.
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
// The pure core (secret generation/normalization, the Crockford codec, key
// derivation, archive encrypt/decrypt/validation, the base64 helpers) lives
// in vault-core.js — import-safe, dependency-free, Node-tested
// (vault.test.js), and re-exported here so DRS consumers keep one import
// surface. It is a SEPARATE module because DRC's drc-core.js builds on those
// primitives and /cure's module graph must not drag in this file's DRS
// storage imports (history-store/opfs/projects — not public assets; a 401 in
// the graph kills the whole client tier). The store/load orchestration below
// touches IndexedDB/OPFS/fetch and is DRS-only.

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
import {
  ARCHIVE_KIND,
  b64ToBytes,
  bytesToB64,
  decryptVaultArchive,
  deriveVaultLocator,
  encryptVaultArchive,
  generateVaultSecret,
  validateVaultArchive,
  vaultSecretValid,
} from "./vault-core.js";

export {
  ARCHIVE_KIND,
  b64ToBytes,
  bytesToB64,
  decodeCrockford,
  decryptVaultArchive,
  deriveVaultLocator,
  encodeCrockford,
  encryptVaultArchive,
  generateVaultSecret,
  normalizeVaultSecret,
  validateVaultArchive,
  vaultSecretValid,
} from "./vault-core.js";

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
 * missing. The imported project takes the normal Se/rver posture (stored in
 * the cloud like everything else); the readable/encrypted split of its files
 * is unchanged (RAG-indexed docs readable, the rest encrypted under the
 * history key).
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
  const imported = { record: false, conversations: 0, files: 0, docs: 0 };

  // The record — LWW against any local copy of the same project.
  onProgress("Importing the project…");
  const existing = getProject(project.id);
  if (!existing || (existing.updatedAt || 0) < (project.updatedAt || 0)) {
    const { id, ...data } = project;
    await saveProjectRecord(id, data);
    imported.record = true;
  }

  // Conversations — each LWW by updatedAt; project chats store readable
  // ({data}) exactly as saveConversation always does for projectId records.
  const existingConvs = new Map(
    (await conversationsOfProject(project.id).catch(() => [])).map((c) => [c.id, c.updatedAt || 0]),
  );
  for (const c of archive.conversations) {
    if ((existingConvs.get(c.id) || 0) >= (c.data.updatedAt || 0)) continue;
    await saveConversation(c.id, { ...c.data, projectId: project.id });
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
