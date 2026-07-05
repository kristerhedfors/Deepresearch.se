// Pending attachments: images (vision models) + documents (pdf/docx/md/txt).
// Owns the attachment state and the card row at the bottom of the composer;
// images are downscaled client-side to fit the provider's ~1 MB body limit,
// documents are parsed to text via docs.js. The send path collects both
// with takeAttachments().

import { docExt, isParsableDoc, parseDocFile } from "./docs.js";
import { currentModel, selectModel, visionFallback } from "./models.js";

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

let attachBtn;
let pendingBox;
let attachments = []; // {kind:"image",name,dataUrl} | {kind:"doc",name,ext,text,truncated}

const isImageFile = (f) => /^image\//.test(f.type) || /\.(png|jpe?g|webp|gif)$/i.test(f.name);
const images = () => attachments.filter((a) => a.kind === "image");
const docs = () => attachments.filter((a) => a.kind === "doc");

export function initAttachments(attachBtnEl, fileInputEl, pendingBoxEl) {
  attachBtn = attachBtnEl;
  pendingBox = pendingBoxEl;
  attachBtn.addEventListener("click", () => fileInputEl.click());
  fileInputEl.addEventListener("change", async () => {
    const files = [...fileInputEl.files];
    fileInputEl.value = "";
    for (const file of files) {
      if (file.size > MAX_RAW_BYTES) {
        alert(file.name + " is too large.");
        continue;
      }
      if (isImageFile(file)) await addImageFile(file);
      else if (isParsableDoc(file)) await addDocFile(file);
      else alert(file.name + ": unsupported type. Use images or pdf, docx, md, txt.");
    }
  });
  syncAttachState();
}

export function hasPending() {
  return attachments.length > 0;
}

// Hand over everything pending for a send and clear the row.
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
    sub.textContent = a.kind === "image" ? "image" : a.ext + (a.truncated ? " · truncated" : "");
    meta.append(name, sub);
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
    const dataUrl = await downscaleImage(file, budget);
    if (!dataUrl) {
      alert("Could not compress " + file.name + " enough to send.");
      return;
    }
    attachments.push({ kind: "image", name: file.name, dataUrl });
    renderPending();
  } catch {
    alert("Could not read " + file.name + " as an image.");
  }
}

async function addDocFile(file) {
  if (docs().length >= MAX_DOCS) {
    alert("Max " + MAX_DOCS + " documents per message.");
    return;
  }
  try {
    const { text, truncated } = await parseDocFile(file, PER_DOC_CHARS);
    attachments.push({ kind: "doc", name: file.name, ext: docExt(file), text, truncated });
    renderPending();
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
