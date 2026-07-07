// Bidirectional storage sync, driven by the account's cloud-storage knob
// (settings.js / src/settings.js):
//
//   knob switched ON  → syncToServer(): push every local conversation
//     record (still encrypted — the ciphertext blob moves as-is), every
//     OPFS-stored original file, and every locally-indexed RAG document
//     (vectors included, so nothing is re-embedded) up to Cloudflare.
//     Local copies STAY — they're the lazy cache the app keeps reading
//     from first.
//   knob switched OFF → syncToClient(): pull everything down (newer
//     conversations, missing files, missing RAG docs), then wipe the
//     server side with one DELETE /api/storage. After this the app is
//     exactly back to the local-only posture.
//
// While the knob is on, steady-state writes don't come through here —
// history-store.js dual-writes each record as it's saved and rag.js
// mirrors each document as it's indexed; sync.js covers the bulk moves
// (flipping the knob) and reconciliation (pullNewer on sidebar open, which
// is also what makes a conversation started on another device appear
// here).
//
// Everything is last-write-wins by updatedAt and per-item fail-soft: one
// failed item is counted and skipped, never a wedged sync.

import { encryptBytes, exportEncryptedRecords, importEncryptedRecord } from "./history-store.js";
import { listOriginals, loadOriginal, opfsAvailable, saveOriginal } from "./opfs.js";
import { exportDoc, hasDoc, importDoc, listDocs, pushDocToServer } from "./rag.js";
import { serverHistoryOn, serverRagAvailable } from "./settings.js";

async function jsonOrNull(res) {
  return res.ok ? res.json().catch(() => null) : null;
}

// ---- knob ON: local → server -------------------------------------------------

export async function syncToServer(onProgress = () => {}) {
  const errors = [];
  let pushed = 0;

  // Conversations: push records the server doesn't have, or has older.
  onProgress("Uploading conversations…");
  try {
    const remote = (await jsonOrNull(await fetch("/api/convos")))?.conversations || [];
    const remoteAt = new Map(remote.map((c) => [c.id, c.updatedAt]));
    const local = await exportEncryptedRecords();
    for (const rec of local) {
      if ((remoteAt.get(rec.id) || 0) >= rec.updatedAt) continue;
      const res = await fetch("/api/convos/" + encodeURIComponent(rec.id), {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ iv: rec.iv, ciphertext: rec.ciphertext, updatedAt: rec.updatedAt }),
      });
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
  // remote copy whose form doesn't match gets re-uploaded — so legacy
  // plaintext images heal on the next boot reconcile without any manual
  // step. A file that SHOULD be encrypted but can't be (no key) is
  // skipped entirely, never uploaded readable.
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

  // RAG index (vectors ride along — no re-embedding).
  if (serverRagAvailable()) {
    onProgress("Uploading document index…");
    try {
      const remoteDocs = (await jsonOrNull(await fetch("/api/rag/docs")))?.docs || [];
      const remoteIds = new Set(remoteDocs.map((d) => d.id));
      for (const doc of await listDocs()) {
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

// ---- knob OFF: server → local, then wipe --------------------------------------

// Returns {checked, pulled, errors, wiped}: `checked` counts every cloud
// item examined, `pulled` only those that actually had to come down —
// items the browser already held (the normal case for the device that
// wrote them) are verified present, not re-downloaded. The distinction
// matters for the status line: "0 downloaded" out of 12 checked means
// "everything was already here", not "nothing was preserved".
export async function syncToClient(onProgress = () => {}) {
  const errors = [];
  let pulled = 0;
  let checked = 0;

  onProgress("Downloading conversations…");
  try {
    const remote = (await jsonOrNull(await fetch("/api/convos")))?.conversations || [];
    checked += remote.length;
    for (const item of remote) {
      const record = await jsonOrNull(await fetch("/api/convos/" + encodeURIComponent(item.id)));
      if (record && (await importEncryptedRecord(item.id, record))) pulled++;
      else if (!record) errors.push("conversation " + item.id.slice(0, 8));
      onProgress(`Downloading conversations… ${pulled}`);
    }
  } catch {
    errors.push("conversation list");
  }

  onProgress("Downloading files…");
  try {
    if (await opfsAvailable()) {
      const localIds = new Set((await listOriginals()).map((f) => f.id));
      const remoteFiles = (await jsonOrNull(await fetch("/api/files")))?.files || [];
      checked += remoteFiles.length;
      for (const f of remoteFiles) {
        if (localIds.has(f.id)) continue;
        const res = await fetch("/api/files/" + encodeURIComponent(f.id));
        if (!res.ok) {
          errors.push("file " + (f.name || f.id));
          continue;
        }
        // Bytes move in storage form (encrypted unless it's a RAG doc) —
        // no decrypt/re-encrypt round trip, the enc flag just rides along.
        await saveOriginal(f.id, await res.blob(), {
          name: f.name,
          type: f.type,
          enc: f.enc === true,
        });
        pulled++;
      }
    }
  } catch {
    errors.push("file download");
  }

  onProgress("Downloading document index…");
  try {
    const remoteDocs = (await jsonOrNull(await fetch("/api/rag/docs")))?.docs || [];
    checked += remoteDocs.length;
    for (const d of remoteDocs) {
      if (await hasDoc(d.id)) continue;
      const data = await jsonOrNull(await fetch("/api/rag/docs/" + encodeURIComponent(d.id)));
      if (data && (await importDoc(data))) pulled++;
      else errors.push("index for " + (d.name || d.id));
    }
  } catch {
    errors.push("document index");
  }

  // Only wipe the server once everything above came down clean — a partial
  // pull must never end with the only complete copy deleted.
  if (!errors.length) {
    onProgress("Removing cloud copies…");
    try {
      const res = await fetch("/api/storage", { method: "DELETE" });
      if (!res.ok) errors.push("cloud wipe");
    } catch {
      errors.push("cloud wipe");
    }
  }

  return { checked, pulled, errors, wiped: !errors.length };
}

// ---- steady-state reconciliation ----------------------------------------------

// Cheap "anything newer up there?" pass, run when the history sidebar opens
// while the knob is on: downloads only records another device (or a
// recovered session) wrote. This is what makes cloud history sync across
// devices without a heavyweight sync loop.
export async function pullNewer() {
  if (!serverHistoryOn()) return 0;
  let pulled = 0;
  try {
    const remote = (await jsonOrNull(await fetch("/api/convos")))?.conversations || [];
    const localAt = new Map((await exportEncryptedRecords()).map((r) => [r.id, r.updatedAt]));
    for (const item of remote) {
      if ((localAt.get(item.id) || 0) >= item.updatedAt) continue;
      const record = await jsonOrNull(await fetch("/api/convos/" + encodeURIComponent(item.id)));
      if (record && (await importEncryptedRecord(item.id, record))) pulled++;
    }
  } catch {
    // offline or misconfigured — the local list is still authoritative enough
  }
  return pulled;
}
