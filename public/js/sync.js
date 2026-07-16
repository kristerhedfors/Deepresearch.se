// Cloud-storage reconciliation. Cloud storage is IMPLICIT on the signed-in
// Se/rver tier (2026-07-16 owner directive — no account knob, no per-project
// knob; the never-cloud tier is Se/cure), so there are no flip-driven bulk
// moves anymore. What remains is keeping the two rests converged:
//
//   syncToServer(): push every local record the cloud is missing or has
//     older — conversations and project records in their STORED FORM
//     (encrypted ciphertext moved as-is; project chats rest readable
//     because they're RAG-indexed — history-store.js), OPFS-stored
//     original files (also in storage form: encrypted except RAG-indexed
//     docs), and locally-indexed RAG documents including chat docs
//     (vectors included, so nothing is re-embedded). Run at boot as the
//     quiet background reconcile (app.js). Local copies STAY — they're
//     the lazy cache the app keeps reading first.
//   pullNewer(): the cheap "anything newer up there?" pass — boot and
//     sidebar-open — that brings down records written from other devices.
//
// Steady-state writes don't come through here — history-store.js
// dual-writes each record as it's saved and rag.js mirrors each document
// as it's indexed; sync.js covers the reconciliation. (DELETE /api/storage
// still exists server-side as the account's data-deletion tool; nothing in
// the normal flow calls it.)
//
// Everything is last-write-wins by updatedAt and per-item fail-soft: one
// failed item is counted and skipped, never a wedged sync.

import { chatConvId } from "./chat-rag.js";
import {
  encryptBytes,
  exportEncryptedProjectRecords,
  exportEncryptedRecords,
  importEncryptedProjectRecord,
  importEncryptedRecord,
} from "./history-store.js";
import { listOriginals, loadOriginal, opfsAvailable, saveOriginal } from "./opfs.js";
import { refreshProjects } from "./projects.js";
import { listDocs, pushDocToServer } from "./rag.js";
import { serverRagAvailable, storageAvailable } from "./settings.js";

async function jsonOrNull(res) {
  return res.ok ? res.json().catch(() => null) : null;
}

// Records move in their stored form: encrypted {iv, ciphertext} for
// everything except project chats, which rest readable ({data}) because
// they're RAG-indexed (history-store.js explains the rule).
const putRecord = (family, rec) =>
  fetch(`/api/${family}/` + encodeURIComponent(rec.id), {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(
      rec.data
        ? { data: rec.data, updatedAt: rec.updatedAt }
        : { iv: rec.iv, ciphertext: rec.ciphertext, updatedAt: rec.updatedAt },
    ),
  });

// ---- local → server ----------------------------------------------------------

/**
 * Bulk local → server push (boot's background reconcile — and the
 * self-healing path for anything a dual-write missed).
 * @param {(msg: string) => void} [onProgress]  status-line narration
 * @returns {Promise<{pushed: number, errors: string[]}>}
 */
export async function syncToServer(onProgress = () => {}) {
  const errors = [];
  let pushed = 0;

  // Project records (same encrypted-record push as conversations).
  onProgress("Uploading project records…");
  try {
    const remote = (await jsonOrNull(await fetch("/api/projects")))?.projects || [];
    const remoteAt = new Map(remote.map((p) => [p.id, p.updatedAt]));
    for (const rec of await exportEncryptedProjectRecords()) {
      if ((remoteAt.get(rec.id) || 0) >= rec.updatedAt) continue;
      const res = await putRecord("projects", rec);
      if (res.ok) pushed++;
      else errors.push("project " + rec.id.slice(0, 8));
    }
  } catch {
    errors.push("project list");
  }

  // Conversations: push records the server doesn't have, or has older.
  onProgress("Uploading conversations…");
  try {
    const remote = (await jsonOrNull(await fetch("/api/convos")))?.conversations || [];
    const remoteAt = new Map(remote.map((c) => [c.id, c.updatedAt]));
    for (const rec of await exportEncryptedRecords()) {
      if ((remoteAt.get(rec.id) || 0) >= rec.updatedAt) continue;
      const res = await putRecord("convos", rec);
      if (res.ok) pushed++;
      else errors.push("conversation " + rec.id.slice(0, 8));
      onProgress(`Uploading conversations… ${pushed}`);
    }
  } catch {
    errors.push("conversation list");
  }

  // Original files (OPFS → R2, in storage form — encrypted for everything
  // except RAG-indexed documents). This pass is also the self-healing
  // migration for that rule: a file stored readable before the rule
  // existed (or by an older client) is re-encrypted in place first, and a
  // remote copy whose form doesn't match gets re-uploaded. A file that
  // SHOULD be encrypted but can't be (no key) is skipped entirely, never
  // uploaded readable.
  onProgress("Uploading files…");
  try {
    if (await opfsAvailable()) {
      const remoteFiles = (await jsonOrNull(await fetch("/api/files")))?.files || [];
      const remoteEnc = new Map(remoteFiles.map((f) => [f.id, f.enc === true]));
      const ragIds = new Set((await listDocs()).map((d) => d.id));
      for (const meta of await listOriginals()) {
        let enc = meta.enc === true;
        if (!enc && !ragIds.has(meta.id)) {
          try {
            const plain = await loadOriginal(meta.id);
            if (!plain) continue;
            const stored = new Blob([await encryptBytes(await plain.arrayBuffer())], {
              type: "application/octet-stream",
            });
            await saveOriginal(meta.id, stored, { ...meta, enc: true });
            enc = true;
          } catch {
            continue; // no key — leave it local-only rather than upload readable
          }
        }
        if (remoteEnc.get(meta.id) === enc) continue; // present, and in the right form
        const blob = await loadOriginal(meta.id);
        if (!blob) continue;
        const res = await fetch("/api/files/" + encodeURIComponent(meta.id), {
          method: "PUT",
          headers: {
            "content-type": "application/octet-stream",
            "x-file-name": encodeURIComponent(meta.name || meta.id),
            "x-file-type": meta.type || "application/octet-stream",
            "x-file-enc": enc ? "1" : "0",
          },
          body: blob,
        });
        if (res.ok) pushed++;
        else errors.push("file " + (meta.name || meta.id));
      }
    }
  } catch {
    errors.push("file upload");
  }

  // RAG index (vectors ride along — no re-embedding). Chat docs
  // (`chat-<convId>` — indexed project-chat turns, chat-rag.js) whose
  // conversation no longer exists locally are orphans and stay local.
  if (serverRagAvailable()) {
    onProgress("Uploading document index…");
    try {
      let convIds = new Set();
      try {
        convIds = new Set((await exportEncryptedRecords()).map((r) => r.id));
      } catch {
        // chat docs simply won't push this pass; files still do
      }
      const docOk = (docId) => {
        const cid = chatConvId(docId);
        return cid === null || convIds.has(cid);
      };
      const remoteDocs = (await jsonOrNull(await fetch("/api/rag/docs")))?.docs || [];
      const remoteIds = new Set(remoteDocs.map((d) => d.id));
      for (const doc of await listDocs()) {
        if (!docOk(doc.id)) continue;
        if (remoteIds.has(doc.id)) continue;
        try {
          await pushDocToServer(doc.id);
          pushed++;
        } catch {
          errors.push("index for " + (doc.name || doc.id));
        }
      }
    } catch {
      errors.push("document index");
    }
  }

  return { pushed, errors };
}

// ---- steady-state reconciliation ----------------------------------------------

// Cheap "anything newer up there?" pass, run at boot and when the history
// sidebar opens: downloads only records another device (or a recovered
// session) wrote — project records included. This is what makes cloud
// history sync across devices without a heavyweight sync loop.
// `checked` counts the cloud's conversation records, `pulled` those
// actually brought down (projects included), `failed` conversations that
// SHOULD have come down but didn't (fetch error, import error). The result
// stays truthy-compatible with the old count-only return via `pulled`.
// Callers that only care whether anything changed keep reading `.pulled`;
// the history sidebar reads the rest to explain an empty pane instead of
// leaving it silent.
/** @returns {Promise<{ran: boolean, checked: number, pulled: number, failed: number}>} */
export async function pullNewer() {
  if (!storageAvailable()) return { ran: false, checked: 0, pulled: 0, failed: 0 };
  let pulled = 0;
  let checked = 0;
  let failed = 0;
  try {
    const remote = (await jsonOrNull(await fetch("/api/convos")))?.conversations || [];
    checked = remote.length;
    const localAt = new Map((await exportEncryptedRecords()).map((r) => [r.id, r.updatedAt]));
    for (const item of remote) {
      if ((localAt.get(item.id) || 0) >= item.updatedAt) continue;
      // Per-record fail-soft: one bad record must not silently abort the
      // rest of the restore (it used to — the whole loop died on the first
      // import that threw, leaving the device missing everything after it).
      try {
        const record = await jsonOrNull(await fetch("/api/convos/" + encodeURIComponent(item.id)));
        if (record && (await importEncryptedRecord(item.id, record))) pulled++;
        else failed++;
      } catch {
        failed++;
      }
    }
  } catch {
    // offline or misconfigured — the local list is still authoritative enough
    failed++;
  }
  try {
    const remote = (await jsonOrNull(await fetch("/api/projects")))?.projects || [];
    const localAt = new Map((await exportEncryptedProjectRecords()).map((r) => [r.id, r.updatedAt]));
    let changed = 0;
    for (const item of remote) {
      if ((localAt.get(item.id) || 0) >= item.updatedAt) continue;
      const record = await jsonOrNull(await fetch("/api/projects/" + encodeURIComponent(item.id)));
      if (record && (await importEncryptedProjectRecord(item.id, record))) changed++;
    }
    if (changed) {
      await refreshProjects();
      pulled += changed;
    }
  } catch {
    // same fail-soft rule
  }
  return { ran: true, checked, pulled, failed };
}
