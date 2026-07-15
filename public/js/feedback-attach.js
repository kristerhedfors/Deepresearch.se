// The feedback pipeline's "add a screenshot" widget — shared by the
// Feedback dialog (turns.js) and the account panel's reply boxes
// (account-feedback.js). A button + hidden image input + thumbnail strip;
// picked images are downscaled client-side (image-downscale.js, the same
// canvas walk chat attachments use) to JPEG data URLs that fit the server's
// per-submission caps (src/feedback.js FEEDBACK_IMAGE_CAPS — the client
// budgets sit under them so a valid pick can never 400 on size).

import { downscaleImage } from "./image-downscale.js";

const MAX_IMAGES = 3; // = FEEDBACK_IMAGE_CAPS.count
const PER_IMAGE_CHARS = 400_000; // < FEEDBACK_IMAGE_CAPS.dataChars (500K)
const TOTAL_CHARS = 1_100_000; // < FEEDBACK_IMAGE_CAPS.totalChars (1.2M)

// Returns { el, getImages, busy, reset }: mount `el`, read `getImages()`
// ([{name, data}] — the POST body's `images`) at send time, and check
// `busy()` first (a just-picked photo may still be compressing).
export function createFeedbackAttach() {
  const images = []; // {name, data}
  let compressing = 0;

  const el = document.createElement("div");
  el.className = "fb-attach";
  const row = document.createElement("div");
  row.className = "fb-attach-row";
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "fb-attach-btn";
  btn.textContent = "📷 Add screenshot";
  btn.title = "Attach up to " + MAX_IMAGES + " images — sent to the developers with your feedback";
  const note = document.createElement("span");
  note.className = "muted fb-note";
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "image/*";
  input.multiple = true;
  input.hidden = true;
  const strip = document.createElement("div");
  strip.className = "fb-shots";
  row.append(btn, note);
  el.append(row, input, strip);

  btn.addEventListener("click", () => input.click());
  input.addEventListener("change", async () => {
    const files = Array.from(input.files || []);
    input.value = ""; // re-picking the same file must fire change again
    note.textContent = "";
    for (const file of files) {
      if (images.length + compressing >= MAX_IMAGES) {
        note.textContent = "Up to " + MAX_IMAGES + " images.";
        break;
      }
      const used = images.reduce((n, i) => n + i.data.length, 0);
      const budget = Math.min(PER_IMAGE_CHARS, TOTAL_CHARS - used);
      if (budget < 20_000) {
        note.textContent = "Image size budget is full.";
        break;
      }
      compressing++;
      note.textContent = "Compressing…";
      try {
        const data = await downscaleImage(file, budget);
        if (!data) {
          note.textContent = "Could not compress " + (file.name || "that image") + " enough.";
          continue;
        }
        images.push({ name: file.name || null, data });
        addThumb(data);
        if (note.textContent === "Compressing…") note.textContent = "";
      } catch {
        note.textContent = "Could not read " + (file.name || "that image") + ".";
      } finally {
        compressing--;
      }
    }
  });

  function addThumb(data) {
    const shot = document.createElement("div");
    shot.className = "fb-shot";
    const img = document.createElement("img");
    img.src = data;
    img.alt = "attached screenshot";
    const del = document.createElement("button");
    del.type = "button";
    del.setAttribute("aria-label", "Remove image");
    del.textContent = "✕";
    del.addEventListener("click", () => {
      const idx = images.findIndex((i) => i.data === data);
      if (idx >= 0) images.splice(idx, 1);
      shot.remove();
    });
    shot.append(img, del);
    strip.appendChild(shot);
  }

  return {
    el,
    getImages: () => images.slice(),
    busy: () => compressing > 0,
    reset: () => {
      images.length = 0;
      strip.replaceChildren();
      note.textContent = "";
    },
  };
}
