// Pending attachments: images (vision models) + documents (pdf/docx/md/txt).
// Owns the attachment state and the card row at the bottom of the composer;
// images are downscaled client-side to fit the provider's ~1 MB body limit,
// documents are parsed to text via docs.js. The send path collects both
// with takeAttachments().

import { docExt, isParsableDoc, parseDocFile } from "./docs.js";
import { extractExif, formatExifSummary } from "./exif.js";
import { currentModel, selectModel, visionFallback } from "./models.js";
import { archiveFile } from "./opfs.js";
import { activeProjectCloudOn } from "./projects.js";
import { indexDocument } from "./rag.js";

const MAX_IMAGES = 4;
const MAX_DOCS = 3;
const MAX_RAW_BYTES = 25 * 1024 * 1024; // sanity cap on input files
// The LLM provider rejects request bodies over ~1 MB, so images are
// downscaled to JPEG data URLs within these budgets before attaching.
const PER_IMAGE_CHARS = 280000;
const TOTAL_IMAGE_CHARS = 700000;
// Documents become extracted text inside the message; the server caps a
// message at 32K chars, so each doc gets a slice of that.
const PER_DOC_CHARS = 9000;
// Documents past the inline budget go through RAG instead of truncation
// (public/js/rag.js): parsed in full up to this ceiling (~ thousands of
// pages), chunked, embedded, and retrieved per question.
const RAG_PARSE_MAX_CHARS = 8_000_000;

let attachBtn;
let cameraBtn;
let pendingBox;
// {kind:"image",name,dataUrl,metadata,metadataSensitive,gps} |
// {kind:"doc",name,ext,text,truncated,metadata,metadataSensitive}
// `metadata` is a formatted summary string (EXIF for images, docProps/
// tracked-changes/comments for docx, Info-dict for pdf) or null — see
// exif.js / docs.js. Included in the outgoing message by stream.js. `gps`
// (images only) is the raw {lat,lon}, sent separately to the server for
// reverse geocoding (src/geocode.js) rather than resolved client-side.
let attachments = [];

const isImageFile = (f) => /^image\//.test(f.type) || /\.(png|jpe?g|webp|gif)$/i.test(f.name);
const images = () => attachments.filter((a) => a.kind === "image");
const docs = () => attachments.filter((a) => a.kind === "doc");

/**
 * One-time wiring from app.js.
 * @param {HTMLElement} attachBtnEl   the paperclip button
 * @param {HTMLInputElement} fileInputEl  hidden file input (any supported type)
 * @param {HTMLElement} pendingBoxEl  the pending-card row container
 * @param {?HTMLElement} cameraBtnEl  the camera button (optional)
 * @param {?HTMLInputElement} cameraInputEl  hidden image-only capture input (optional)
 */
export function initAttachments(attachBtnEl, fileInputEl, pendingBoxEl, cameraBtnEl, cameraInputEl) {
  attachBtn = attachBtnEl;
  cameraBtn = cameraBtnEl;
  pendingBox = pendingBoxEl;
  attachBtn.addEventListener("click", () => fileInputEl.click());
  wireFileInput(fileInputEl, { imagesOnly: false });
  // Camera: an image-only input carrying capture="environment", so a phone
  // opens the camera directly to snap a photo (desktop falls back to an
  // image picker). A snapped photo is just an image attachment — it reuses
  // the exact same downscale / EXIF / vision-fallback path as a picked one.
  if (cameraBtn && cameraInputEl) {
    cameraBtn.addEventListener("click", () => cameraInputEl.click());
    wireFileInput(cameraInputEl, { imagesOnly: true });
  }
  syncAttachState();
}

// Wire one hidden <input type=file> to the ingest path. `imagesOnly` (the
// camera input) rejects non-image captures instead of trying to parse them
// as documents.
function wireFileInput(inputEl, { imagesOnly }) {
  inputEl.addEventListener("change", async () => {
    const files = [...inputEl.files];
    inputEl.value = "";
    for (const file of files) {
      if (file.size > MAX_RAW_BYTES) {
        alert(file.name + " is too large.");
        continue;
      }
      if (isImageFile(file)) await addImageFile(file);
      else if (imagesOnly) alert(file.name + ": not an image.");
      else if (isParsableDoc(file)) await addDocFile(file);
      else alert(file.name + ": unsupported type. Use images or pdf, docx, md, txt.");
    }
  });
}

export function hasPending() {
  return attachments.length > 0;
}

// True while a large document is still being chunked/embedded — the send
// button waits for this (app.js) so a question can't outrun its own
// attachment's index.
export function indexingBusy() {
  return attachments.some((a) => a.indexing);
}

// Archival of originals lives in opfs.js's archiveFile (encrypted except
// RAG-indexed docs). Attachments made inside a project chat inherit that
// project's cloud opt-out — a cloud-off project's attachments never reach
// R2, matching the per-project knob's promise.
function archiveOriginal(fileId, file, { plaintext = false } = {}) {
  return archiveFile(fileId, file, { plaintext, cloud: activeProjectCloudOn() });
}

/**
 * Hand over everything pending for a send and clear the row.
 * @returns {{images: object[], docs: object[]}} the pending attachment
 *   objects (shapes documented at the `attachments` declaration above)
 */
export function takeAttachments() {
  const taken = { images: images(), docs: docs() };
  attachments = [];
  renderPending();
  return taken;
}

// Re-check vision capability after a model change: documents attach on
// every model; images need vision. The button stays fully active either
// way — the vision question is handled per-file.
export function syncAttachState() {
  const vision = !!currentModel()?.vision;
  attachBtn.title = vision
    ? "Attach images or documents (pdf, docx, md, txt)"
    : "Attach documents (pdf, docx, md, txt) — images need a vision model";
  // The camera only ever produces images; on a non-vision model it stays
  // tappable (the snap path offers a one-tap switch) but dims to signal it.
  if (cameraBtn) {
    cameraBtn.title = vision ? "Take a photo" : "Take a photo — needs a vision model";
    cameraBtn.classList.toggle("dim", !vision);
  }
  if (!vision && images().length) {
    attachments = attachments.filter((a) => a.kind !== "image");
    renderPending();
  }
}

// Each attachment renders as a rounded card (thumb or file icon + name)
// with a white circular × in its upper-right corner — on their own line
// at the bottom of the glass pane.
function renderPending() {
  pendingBox.replaceChildren();
  attachments.forEach((a, i) => {
    const card = document.createElement("div");
    card.className = "att-card";
    if (a.kind === "image") {
      const img = document.createElement("img");
      img.src = a.dataUrl;
      img.alt = a.name;
      card.appendChild(img);
    } else {
      const icon = document.createElement("span");
      icon.className = "icon";
      icon.textContent = "📄";
      card.appendChild(icon);
    }
    const meta = document.createElement("div");
    meta.className = "meta";
    const name = document.createElement("div");
    name.className = "name";
    name.textContent = a.name;
    name.title = a.name;
    const sub = document.createElement("div");
    sub.className = "sub";
    if (a.kind === "image") sub.textContent = "image";
    else if (a.indexing) sub.textContent = `${a.ext} · indexing… ${a.progress || 0}%`;
    else if (a.rag) sub.textContent = `${a.ext} · indexed (${a.chunkCount} parts)`;
    else sub.textContent = a.ext + (a.truncated ? " · truncated" : "");
    meta.append(name, sub);
    if (a.metadata) {
      const badge = document.createElement("div");
      badge.className = "att-meta-badge" + (a.metadataSensitive ? " att-meta-sensitive" : "");
      badge.textContent = a.metadataSensitive
        ? (a.kind === "image" ? "📍 location data included" : "⚠️ tracked changes included")
        : "ℹ️ metadata included";
      badge.title = a.metadata; // full extracted summary, visible on hover/tap-hold
      meta.appendChild(badge);
    }
    card.appendChild(meta);
    const rm = document.createElement("button");
    rm.type = "button";
    rm.className = "att-remove";
    rm.textContent = "✕";
    rm.title = "Remove attachment";
    rm.setAttribute("aria-label", "Remove " + a.name);
    rm.addEventListener("click", () => {
      attachments.splice(i, 1);
      renderPending();
    });
    card.appendChild(rm);
    pendingBox.appendChild(card);
  });
}

async function addImageFile(file) {
  if (!currentModel()?.vision) {
    // Explain and offer a one-tap switch to a vision-capable model.
    const alt = visionFallback();
    if (!alt) {
      alert("Images need a vision-capable model and none is available right now.");
      return;
    }
    if (!confirm("Image attachments need a vision-capable model.\nSwitch to " + alt.name + "?")) return;
    selectModel(alt.id);
  }
  if (images().length >= MAX_IMAGES) {
    alert("Max " + MAX_IMAGES + " images per message.");
    return;
  }
  const used = images().reduce((s, a) => s + a.dataUrl.length, 0);
  const budget = Math.min(PER_IMAGE_CHARS, TOTAL_IMAGE_CHARS - used);
  if (budget < 60000) {
    alert("Image size budget for this message is full — send these first.");
    return;
  }
  try {
    // EXIF must come from the ORIGINAL bytes — downscaleImage's canvas
    // re-encode strips all metadata, so this has to happen first (a File
    // can be read more than once; this doesn't consume what downscaleImage
    // reads afterward).
    const exif = await extractImageMetadata(file);
    const dataUrl = await downscaleImage(file, budget);
    if (!dataUrl) {
      alert("Could not compress " + file.name + " enough to send.");
      return;
    }
    const fileId = crypto.randomUUID();
    archiveOriginal(fileId, file); // fire-and-forget — see above
    attachments.push({
      kind: "image",
      name: file.name,
      fileId,
      dataUrl,
      metadata: exif.summary,
      metadataSensitive: exif.hasGps,
      gps: exif.gps, // raw {lat,lon} — sent to the server for reverse geocoding (src/geocode.js)
    });
    renderPending();
  } catch {
    alert("Could not read " + file.name + " as an image.");
  }
}

async function extractImageMetadata(file) {
  try {
    const meta = extractExif(await file.arrayBuffer());
    return { summary: formatExifSummary(meta), hasGps: !!meta?.gps, gps: meta?.gps || null };
  } catch {
    return { summary: null, hasGps: false, gps: null }; // never let metadata extraction block the attach
  }
}

async function addDocFile(file) {
  if (docs().length >= MAX_DOCS) {
    alert("Max " + MAX_DOCS + " documents per message.");
    return;
  }
  try {
    // Parse in full first: whether this goes inline or through RAG depends
    // on how much text actually comes out, not on file size.
    const { text, truncated, metadata, hasTrackedDeletions } = await parseDocFile(file, RAG_PARSE_MAX_CHARS);
    const fileId = crypto.randomUUID();
    // Fire-and-forget archival (see archiveOriginal). Only the RAG path
    // below stores the original readable — an inline doc's original is
    // encrypted like any other file.
    archiveOriginal(fileId, file, { plaintext: text.length > PER_DOC_CHARS });

    if (text.length <= PER_DOC_CHARS) {
      // Small document: the original inline path, unchanged.
      attachments.push({
        kind: "doc",
        name: file.name,
        fileId,
        ext: docExt(file),
        text,
        truncated,
        metadata,
        metadataSensitive: hasTrackedDeletions,
      });
      renderPending();
      return;
    }

    // Large document: index for retrieval instead of truncating to the
    // first ~2 pages. The card shows live indexing progress; sending waits
    // for it (app.js checks indexingBusy). If indexing fails (embedding
    // endpoint down), degrade to exactly the pre-RAG behavior: first
    // PER_DOC_CHARS chars inline, marked truncated.
    const att = {
      kind: "doc",
      name: file.name,
      fileId,
      ext: docExt(file),
      rag: true,
      docId: fileId,
      chars: text.length,
      indexing: true,
      progress: 0,
      metadata,
      metadataSensitive: hasTrackedDeletions,
    };
    attachments.push(att);
    renderPending();
    try {
      const { chunkCount } = await indexDocument(fileId, file.name, text, {
        cloud: activeProjectCloudOn(),
        onProgress: (done, total) => {
          att.progress = Math.round((100 * done) / total);
          renderPending();
        },
      });
      att.chunkCount = chunkCount;
    } catch (err) {
      console.warn("rag: indexing failed, falling back to inline truncation", err);
      att.rag = false;
      att.docId = null;
      att.text = text.slice(0, PER_DOC_CHARS);
      att.truncated = true;
      // Not a RAG doc after all — replace the readable archived copy with
      // an encrypted one (the plaintext exception exists only for indexed
      // documents).
      archiveOriginal(fileId, file);
    } finally {
      att.indexing = false;
      renderPending();
    }
  } catch (err) {
    alert(err?.message || "Could not read " + file.name + ".");
  }
}

// Phone photos are several MB but the LLM provider rejects request bodies
// over ~1 MB — resize to max 1280px and walk JPEG quality (then dimensions)
// down until the data URL fits the budget.
async function downscaleImage(file, budgetChars) {
  const img = await loadImage(file);
  const iw = img.width || img.naturalWidth;
  const ih = img.height || img.naturalHeight;
  if (!iw || !ih) return null;
  let edge = 1280;
  while (edge >= 320) {
    const scale = Math.min(1, edge / Math.max(iw, ih));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(iw * scale));
    canvas.height = Math.max(1, Math.round(ih * scale));
    canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
    for (const q of [0.8, 0.65, 0.5]) {
      const url = canvas.toDataURL("image/jpeg", q);
      if (url.length <= budgetChars) return url;
    }
    edge = Math.round(edge * 0.7);
  }
  return null;
}

function loadImage(file) {
  return createImageBitmap(file).catch(
    () =>
      new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = reject;
        img.src = URL.createObjectURL(file);
      }),
  );
}
