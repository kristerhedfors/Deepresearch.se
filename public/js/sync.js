// Bidirectional storage sync, driven by the account's cloud-storage knob
// (settings.js / src/settings.js) and — since projects — by each project's
// own knob (projects.js):
//
//   account knob ON  → syncToServer(): push every eligible local record —
//     conversations and project records in their STORED FORM (encrypted
//     ciphertext moved as-is; project chats rest readable because they're
//     RAG-indexed — history-store.js), OPFS-stored original files (also in
//     storage form: encrypted except RAG-indexed docs), and locally-indexed
//     RAG documents including chat docs (vectors included, so nothing is
//     re-embedded). "Eligible" excludes everything belonging to a project
//     whose own knob is OFF. Local copies STAY — they're the lazy cache
//     the app keeps reading first.
//   account knob OFF → syncToClient(): pull everything down (newer
//     records, missing files, missing RAG docs), then wipe the server
//     side with one DELETE /api/storage.
//   project knob ON  → pushProjectScope(): syncToServer restricted to that
//     one project's record, conversations, files and index.
//   project knob OFF → drainProjectScope(): pull that project's items down
//     where missing, then delete ONLY its cloud objects, item by item —
//     the rest of the account's cloud storage is untouched.
//
// While knobs are on, steady-state writes don't come through here —
// history-store.js dual-writes each record as it's saved and rag.js
// mirrors each document as it's indexed; sync.js covers the bulk moves and
// reconciliation (pullNewer on sidebar open / boot).
//
// Everything is last-write-wins by updatedAt and per-item fail-soft: one
// failed item is counted and skipped, never a wedged sync.

import { chatConvId, chatDocId } from "./chat-rag.js";
import {
  encryptBytes,
  exportEncryptedProjectRecords,
  exportEncryptedRecords,
  importEncryptedProjectRecord,
  importEncryptedRecord,
} from "./history-store.js";
import { listOriginals, loadOriginal, opfsAvailable, saveOriginal } from "./opfs.js";
import { fileProjectMap, getProject, listProjects, projectCloudOn, refreshProjects } from "./projects.js";
import { hasDoc, importDoc, listDocs, pushDocToServer } from "./rag.js";
import { serverHistoryOn, serverRagAvailable } from "./settings.js";

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

// ---- knob ON: local → server -------------------------------------------------

// `scopeProjectId` restricts the push to one project (the per-project knob
// flipping ON); without it, everything except cloud-off projects goes.
export async function syncToServer(onProgress = () => {}, scopeProjectId = null) {
  const errors = [];
  let pushed = 0;
  await listProjects(); // make the knob/file maps below answerable
  const fileMap = fileProjectMap();
  // Eligibility under the project knobs: in scoped mode, ONLY the scoped
  // project's items; otherwise everything not owned by a cloud-off project.
  const projectOk = (projectId) =>
    scopeProjectId ? projectId === scopeProjectId : projectCloudOn(projectId || null);
  const fileOk = (fileId) => projectOk(fileMap.get(fileId) || null);

  // Project records (same encrypted-record push as conversations).
  onProgress("Uploading project records…");
  try {
    const remote = (await jsonOrNull(await fetch("/api/projects")))?.projects || [];
    const remoteAt = new Map(remote.map((p) => [p.id, p.updatedAt]));
    for (const rec of await exportEncryptedProjectRecords()) {
      if (!projectOk(rec.id)) continue;
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
      if (scopeProjectId ? rec.projectId !== scopeProjectId : !projectOk(rec.projectId)) continue;
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
        if (!fileOk(meta.id)) continue;
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
  // (`chat-<convId>` — indexed project-chat turns, chat-rag.js) take their
  // eligibility from their conversation's project; one whose conversation
  // no longer exists locally is an orphan and stays local.
  if (serverRagAvailable()) {
    onProgress("Uploading document index…");
    try {
      let convProject = new Map();
      try {
        convProject = new Map((await exportEncryptedRecords()).map((r) => [r.id, r.projectId || null]));
      } catch {
        // chat docs simply won't push this pass; files still do
      }
      const docOk = (docId) => {
        const cid = chatConvId(docId);
        if (cid !== null) return convProject.has(cid) && projectOk(convProject.get(cid));
        return fileOk(docId);
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

export function pushProjectScope(projectId, onProgress = () => {}) {
  return syncToServer(onProgress, projectId);
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

  onProgress("Downloading project records…");
  try {
    const remote = (await jsonOrNull(await fetch("/api/projects")))?.projects || [];
    checked += remote.length;
    for (const item of remote) {
      const record = await jsonOrNull(await fetch("/api/projects/" + encodeURIComponent(item.id)));
      if (record && (await importEncryptedProjectRecord(item.id, record))) pulled++;
      else if (!record) errors.push("project " + item.id.slice(0, 8));
    }
    await refreshProjects();
  } catch {
    errors.push("project list");
  }

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

// Project knob OFF: the scoped version of the drain above. Pull anything
// of this project's the browser is missing (a record written from another
// device, a file uploaded elsewhere), then delete ONLY this project's
// cloud objects — conversations, files, index entries, and the project
// record — leaving the rest of the account's cloud storage untouched.
// Same safety rule: nothing is deleted unless its local copy is confirmed.
export async function drainProjectScope(projectId, onProgress = () => {}) {
  const errors = [];
  let removed = 0;

  // Reconcile first so "local copy exists" below is trustworthy even for
  // items written from another device.
  onProgress("Checking cloud copies…");
  await pullNewer().catch(() => {});
  await listProjects();
  const project = getProject(projectId);

  // Conversations of this project — each one's record, plus its slice of
  // the RAG index (project chats are indexed, chat-rag.js): the chat doc is
  // pulled down first if this browser is missing it, same confirm-then-
  // delete rule as files below.
  try {
    const mine = (await exportEncryptedRecords()).filter((r) => r.projectId === projectId);
    const remoteIds = new Set(
      ((await jsonOrNull(await fetch("/api/convos")))?.conversations || []).map((c) => c.id),
    );
    const remoteDocIds = new Set(
      ((await jsonOrNull(await fetch("/api/rag/docs")))?.docs || []).map((d) => d.id),
    );
    for (const rec of mine) {
      const docId = chatDocId(rec.id);
      if (remoteDocIds.has(docId)) {
        try {
          if (!(await hasDoc(docId))) {
            const data = await jsonOrNull(await fetch("/api/rag/docs/" + encodeURIComponent(docId)));
            if (data) await importDoc(data);
          }
          const delDoc = await fetch("/api/rag/docs/" + encodeURIComponent(docId), { method: "DELETE" });
          if (delDoc.ok || delDoc.status === 404) removed++;
          else errors.push("chat index " + rec.id.slice(0, 8));
        } catch {
          errors.push("chat index " + rec.id.slice(0, 8));
        }
      }
      if (!remoteIds.has(rec.id)) continue;
      const res = await fetch("/api/convos/" + encodeURIComponent(rec.id), { method: "DELETE" });
      if (res.ok || res.status === 404) removed++;
      else errors.push("conversation " + rec.id.slice(0, 8));
    }
  } catch {
    errors.push("conversations");
  }

  // Files + index entries of this project.
  onProgress("Removing project files from the cloud…");
  for (const f of project?.files || []) {
    try {
      // Confirm a local copy before deleting the cloud one.
      const local = await loadOriginal(f.id);
      if (!local) {
        const res = await fetch("/api/files/" + encodeURIComponent(f.id));
        if (res.ok) {
          await saveOriginal(f.id, await res.blob(), {
            name: f.name,
            type: f.type,
            enc: res.headers.get("x-file-enc") === "1",
          });
        } else if (res.status !== 404) {
          errors.push("file " + f.name);
          continue;
        }
      }
      const del = await fetch("/api/files/" + encodeURIComponent(f.id), { method: "DELETE" });
      if (del.ok || del.status === 404) removed++;
      else errors.push("file " + f.name);
      if (f.indexed) {
        if (!(await hasDoc(f.id))) {
          const data = await jsonOrNull(await fetch("/api/rag/docs/" + encodeURIComponent(f.id)));
          if (data) await importDoc(data);
        }
        const delDoc = await fetch("/api/rag/docs/" + encodeURIComponent(f.id), { method: "DELETE" });
        if (delDoc.ok || delDoc.status === 404) removed++;
        else errors.push("index for " + f.name);
      }
    } catch {
      errors.push("file " + (f.name || f.id));
    }
  }

  // The project record itself — last, so a partial drain stays listed in
  // the cloud and can be retried.
  if (!errors.length) {
    onProgress("Removing the project record…");
    try {
      const res = await fetch("/api/projects/" + encodeURIComponent(projectId), { method: "DELETE" });
      if (res.ok || res.status === 404) removed++;
      else errors.push("project record");
    } catch {
      errors.push("project record");
    }
  }

  return { removed, errors, drained: !errors.length };
}

// ---- steady-state reconciliation ----------------------------------------------

// Cheap "anything newer up there?" pass, run at boot and when the history
// sidebar opens while the knob is on: downloads only records another
// device (or a recovered session) wrote — project records included. This
// is what makes cloud history sync across devices without a heavyweight
// sync loop.
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
  return pulled;
}
