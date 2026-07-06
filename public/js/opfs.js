// Original attached files, stored in OPFS (Origin Private File System) —
// every file the user attaches (image or document) keeps its ORIGINAL
// bytes here, keyed by a generated file id. IndexedDB holds only the
// small metadata rows (name/type/size — in the shared dr_rag database,
// public/js/rag.js's `files` store); the bytes themselves live in OPFS,
// which is the storage layer actually built for file-sized data (real
// file handles, streaming writes, no structured-clone copies of
// multi-MB blobs through the IDB transaction machinery).
//
// NOT encrypted — unlike conversation records (history-store.js), these
// are the raw inputs to document indexing, and the RAG design needs
// readable bytes/text (disclosed in the settings UI). What's stored here
// never leaves the browser unless the user's cloud-storage knob is ON
// (public/js/sync.js mirrors originals to R2 then).
//
// Fails soft everywhere: no OPFS (older Safari) just means originals
// aren't archived — attachments keep working exactly as before.

import { filesMetaStore } from "./rag.js";

const DIR = "originals";

async function dir(create) {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(DIR, { create });
}

export async function opfsAvailable() {
  try {
    if (!navigator.storage?.getDirectory) return false;
    const d = await dir(true);
    // createWritable is the main-thread write path; Safari gained it late.
    const handle = await d.getFileHandle(".probe", { create: true });
    const ok = typeof handle.createWritable === "function";
    await d.removeEntry(".probe").catch(() => {});
    return ok;
  } catch {
    return false;
  }
}

// Store one original file. `meta` = {name, type, size} — kept in IndexedDB
// so listing never has to walk OPFS.
export async function saveOriginal(id, blob, meta) {
  const d = await dir(true);
  const handle = await d.getFileHandle(id, { create: true });
  const writable = await handle.createWritable();
  await writable.write(blob);
  await writable.close();
  await filesMetaStore.put({
    id,
    name: meta?.name || id,
    type: meta?.type || blob.type || "application/octet-stream",
    size: blob.size,
    addedAt: Date.now(),
  });
}

export async function loadOriginal(id) {
  try {
    const d = await dir(false);
    const handle = await d.getFileHandle(id);
    return await handle.getFile();
  } catch {
    return null;
  }
}

export async function deleteOriginal(id) {
  try {
    const d = await dir(false);
    await d.removeEntry(id);
  } catch {
    // already gone — deletion is idempotent
  }
  await filesMetaStore.delete(id);
}

export async function listOriginals() {
  return filesMetaStore.getAll();
}
