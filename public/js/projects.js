// Projects: named collections of chats and files (public/js/projects-ui.js
// renders them; this module owns the data and the rules).
//
// A project's record — name, file inventory (with extracted image/document
// metadata), notes, and its per-project cloud knob — is ONE encrypted blob
// (history-store.js `projects` store locally, R2 `projects/{uid}/{id}` in
// cloud mode), exactly the conversation-record pattern. Its files live in
// the same OPFS/R2 file store as attachment originals (encrypted, except
// RAG-indexed documents) and its indexable material (documents AND text
// notes, of any size — project material is reference material, so
// everything indexable IS indexed) goes through the same RAG pipeline as
// large attachments. Images aren't indexable — they contribute their
// extracted EXIF metadata to the chat context instead (see
// project-context.js), which is exactly the capture-time/place/device
// material the research pipeline is meant to use.
//
// Scope is the invariant to protect: a chat inside a project retrieves
// across THAT project's indexed docs plus its own attachments — never
// another project's (retrieval is by explicit docId list, so isolation is
// structural, and the e2e suite asserts it).
//
// The per-project cloud knob is a SCOPED version of the account knob:
// serverStorage !== false means the project follows the account setting;
// an explicit false keeps everything in this project — record,
// conversations, files, RAG index — out of the cloud (dual-writes skip it,
// sync skips it, and flipping it off drains what was already up there;
// public/js/sync.js implements the bulk moves).

import { docExt, isParsableDoc, parseDocFile } from "./docs.js";
import { extractExif, formatExifSummary } from "./exif.js";
import {
  decryptBytes,
  deleteConversation,
  deleteProjectRecord,
  listConversations,
  listProjectRecords,
  saveProjectRecord,
} from "./history-store.js";
import { archiveFile, listOriginals, loadOriginal, purgeFile } from "./opfs.js";
import { buildProjectContext, normalizeProjectName, noteToText, projectDocIds } from "./project-context.js";
import { deleteDoc, indexDocument } from "./rag.js";
import { serverHistoryOn } from "./settings.js";

const MAX_FILES_PER_PROJECT = 100;
const MAX_RAW_BYTES = 25 * 1024 * 1024; // same input cap as attachments
const PARSE_MAX_CHARS = 8_000_000;

const isImageFile = (f) => /^image\//.test(f.type) || /\.(png|jpe?g|webp|gif)$/i.test(f.name);

// ---- cache + change notification --------------------------------------------

let projects = []; // decrypted records, newest first
let loadedOnce = false;
let activeId = null;
const listeners = new Set();

function notify() {
  for (const fn of listeners) {
    try {
      fn();
    } catch {
      // one broken listener must not break the rest
    }
  }
}

export function onProjectsChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export async function refreshProjects() {
  projects = await listProjectRecords();
  loadedOnce = true;
  notify();
  return projects;
}

export async function listProjects() {
  if (!loadedOnce) await refreshProjects();
  return projects;
}

export function getProject(id) {
  return projects.find((p) => p.id === id) || null;
}

// ---- active project (the chat context) ---------------------------------------

export function activeProjectId() {
  return activeId;
}

export function setActiveProject(id) {
  activeId = id || null;
  notify();
}

export function activeProject() {
  return activeId ? getProject(activeId) : null;
}

// The knob answer every storage-touching module asks. Unknown/absent
// project (or none active) means "follow the account setting" — true.
export function projectCloudOn(projectId) {
  if (!projectId) return true;
  const p = getProject(projectId);
  return p ? p.serverStorage !== false : true;
}

export function activeProjectCloudOn() {
  return projectCloudOn(activeId);
}

export function activeProjectDocIds() {
  return projectDocIds(activeProject());
}

export function activeProjectContext() {
  return buildProjectContext(activeProject());
}

// fileId → projectId across every project (sync.js uses this to honor
// cloud-off projects when pushing files/RAG docs).
export function fileProjectMap() {
  const map = new Map();
  for (const p of projects) {
    for (const f of p.files || []) map.set(f.id, p.id);
  }
  return map;
}

// ---- record persistence -------------------------------------------------------

async function persistProject(project) {
  project.updatedAt = Date.now();
  const { id, ...data } = project;
  await saveProjectRecord(id, { ...data }, { cloud: project.serverStorage !== false });
  const i = projects.findIndex((p) => p.id === id);
  if (i >= 0) projects[i] = project;
  else projects.unshift(project);
  notify();
  return project;
}

export async function createProject(name) {
  const project = {
    id: crypto.randomUUID(),
    name: normalizeProjectName(name),
    serverStorage: true, // follow the account default; the knob opts out
    files: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  return persistProject(project);
}

export async function renameProject(id, name) {
  const p = getProject(id);
  if (!p) return null;
  p.name = normalizeProjectName(name);
  return persistProject(p);
}

// Flip the record's knob only — the bulk consequences (push up / drain
// down) are sync.js's pushProjectScope / drainProjectScope, driven by the
// UI so it can show progress.
export async function setProjectCloud(id, on) {
  const p = getProject(id);
  if (!p) return null;
  p.serverStorage = on !== false;
  return persistProject(p);
}

// ---- files & notes -------------------------------------------------------------

// One added file → one inventory entry. Documents and notes are ALWAYS
// indexed (project material is reference material); images contribute
// extracted EXIF instead; anything else is archived (encrypted) without
// indexing. onProgress(label) feeds the panel's status line.
async function addOneFile(project, file, onProgress = () => {}) {
  if ((project.files || []).length >= MAX_FILES_PER_PROJECT) {
    throw new Error(`A project holds at most ${MAX_FILES_PER_PROJECT} files.`);
  }
  if (file.size > MAX_RAW_BYTES) throw new Error(file.name + " is too large (25 MB max).");
  const cloud = project.serverStorage !== false;
  const fileId = crypto.randomUUID();
  const entry = {
    id: fileId,
    name: file.name,
    type: file.type || "application/octet-stream",
    size: file.size,
    kind: "file",
    indexed: false,
    addedAt: Date.now(),
  };

  if (isImageFile(file)) {
    entry.kind = "image";
    try {
      const meta = extractExif(await file.arrayBuffer());
      entry.metadata = formatExifSummary(meta);
      if (meta?.gps) entry.gps = meta.gps;
    } catch {
      // metadata extraction must never block the add
    }
    // A small preview rides INSIDE the encrypted project record (a few KB
    // of JPEG data URL), so the panel can show the picture itself — the
    // OPFS/R2 original is ciphertext and can't be used as an <img> src.
    entry.thumb = await makeThumb(file);
    await archiveFile(fileId, file, { cloud });
    return entry;
  }

  if (isParsableDoc(file)) {
    entry.kind = "doc";
    onProgress(`Reading ${file.name}…`);
    const { text, metadata } = await parseDocFile(file, PARSE_MAX_CHARS);
    entry.ext = docExt(file);
    if (metadata) entry.metadata = metadata;
    try {
      onProgress(`Indexing ${file.name}…`);
      const { chunkCount } = await indexDocument(fileId, file.name, text, {
        cloud,
        onProgress: (done, total) =>
          onProgress(`Indexing ${file.name}… ${Math.round((100 * done) / total)}%`),
      });
      entry.indexed = true;
      entry.chunkCount = chunkCount;
      // Indexed → its original is the one readable class (the index has
      // the text anyway).
      await archiveFile(fileId, file, { plaintext: true, cloud });
    } catch (err) {
      console.warn("projects: indexing failed, storing unindexed", err);
      await archiveFile(fileId, file, { cloud }); // encrypted, unindexed
    }
    return entry;
  }

  // Unsupported for indexing — archived (encrypted) so it's not lost.
  await archiveFile(fileId, file, { cloud });
  return entry;
}

export async function addFilesToProject(id, files, onProgress = () => {}) {
  const p = getProject(id);
  if (!p) throw new Error("Project not found.");
  const errors = [];
  for (const file of files) {
    try {
      const entry = await addOneFile(p, file, onProgress);
      p.files = [...(p.files || []), entry];
      await persistProject(p);
    } catch (err) {
      errors.push(`${file.name}: ${err?.message || "failed"}`);
    }
  }
  return { project: p, errors };
}

// "Text content with header and content" — a note. Stored and indexed as
// a small text document (title leads the indexed text so retrieval can
// match on it), listed in the inventory under its title.
export async function addTextToProject(id, title, content) {
  const p = getProject(id);
  if (!p) throw new Error("Project not found.");
  const text = noteToText(title, content);
  if (!text.trim()) throw new Error("The note needs some content.");
  const cloud = p.serverStorage !== false;
  const fileId = crypto.randomUUID();
  const name = (String(title || "").trim() || "Note").slice(0, 120);
  const entry = {
    id: fileId,
    name,
    type: "text/markdown",
    size: text.length,
    kind: "text",
    indexed: false,
    addedAt: Date.now(),
  };
  try {
    const { chunkCount } = await indexDocument(fileId, name, text, { cloud });
    entry.indexed = true;
    entry.chunkCount = chunkCount;
    await archiveFile(fileId, new File([text], name + ".md", { type: "text/markdown" }), {
      plaintext: true,
      cloud,
    });
  } catch (err) {
    console.warn("projects: note indexing failed, storing encrypted", err);
    await archiveFile(fileId, new File([text], name + ".md", { type: "text/markdown" }), { cloud });
  }
  p.files = [...(p.files || []), entry];
  await persistProject(p);
  return entry;
}

// Thumbnail for the panel's file list: canvas-downscaled to ~112px JPEG,
// capped to a few KB so a project full of photos keeps its record small.
// (Same canvas approach as attachments.js's downscaleImage, tuned for a
// list preview instead of a model input.) Returns null when the bytes
// aren't decodable as an image.
async function makeThumb(blob) {
  try {
    const img = await createImageBitmap(blob).catch(
      () =>
        new Promise((resolve, reject) => {
          const el = new Image();
          el.onload = () => resolve(el);
          el.onerror = reject;
          el.src = URL.createObjectURL(blob);
        }),
    );
    const w = img.width || img.naturalWidth;
    const h = img.height || img.naturalHeight;
    if (!w || !h) return null;
    const scale = Math.min(1, 112 / Math.max(w, h));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(w * scale));
    canvas.height = Math.max(1, Math.round(h * scale));
    canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
    for (const q of [0.75, 0.6, 0.45]) {
      const url = canvas.toDataURL("image/jpeg", q);
      if (url.length <= 24_000) return url;
    }
  } catch {
    // undecodable — the list falls back to the kind icon
  }
  return null;
}

// Backfill for images added before thumbnails existed: rebuild the preview
// from the OPFS original (decrypting it — image originals rest encrypted)
// and persist it into the record. Returns true when the record changed.
export async function ensureThumb(projectId, fileId) {
  const p = getProject(projectId);
  const f = (p?.files || []).find((x) => x.id === fileId);
  if (!f || f.kind !== "image" || f.thumb) return false;
  let blob = await loadOriginal(fileId);
  if (!blob) return false;
  try {
    const meta = (await listOriginals()).find((m) => m.id === fileId);
    if (meta?.enc) {
      blob = new Blob([await decryptBytes(new Uint8Array(await blob.arrayBuffer()))], {
        type: f.type || "image/jpeg",
      });
    }
  } catch {
    return false; // key unavailable — keep the icon
  }
  const thumb = await makeThumb(blob);
  if (!thumb) return false;
  f.thumb = thumb;
  await persistProject(p);
  return true;
}

export async function removeFileFromProject(id, fileId) {
  const p = getProject(id);
  if (!p) return;
  const entry = (p.files || []).find((f) => f.id === fileId);
  p.files = (p.files || []).filter((f) => f.id !== fileId);
  await persistProject(p);
  await purgeFile(fileId);
  if (entry?.indexed) {
    await deleteDoc(fileId).catch(() => {});
    if (serverHistoryOn()) {
      fetch("/api/rag/docs/" + encodeURIComponent(fileId), { method: "DELETE" }).catch(() => {});
    }
  }
}

// ---- conversations in a project -------------------------------------------------

export async function conversationsOfProject(id) {
  return (await listConversations()).filter((c) => c.projectId === id);
}

// Deleting a project removes EVERYTHING in its scope: files (both rests),
// its slice of the RAG index (both rests), its conversations (both rests),
// then the record itself. The remote deletes are harmless no-ops for a
// project that was cloud-off (nothing is up there).
export async function deleteProject(id) {
  const p = getProject(id);
  if (!p) return;
  for (const f of [...(p.files || [])]) {
    await removeFileFromProject(id, f.id).catch(() => {});
  }
  for (const c of await conversationsOfProject(id)) {
    await deleteConversation(c.id).catch(() => {});
  }
  await deleteProjectRecord(id);
  projects = projects.filter((x) => x.id !== id);
  if (activeId === id) activeId = null;
  notify();
}
