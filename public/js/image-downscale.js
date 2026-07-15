// Canvas image downscaling — the one client-side compressor behind chat
// image attachments (attachments.js) and feedback screenshots
// (feedback-attach.js). Moved out of attachments.js 2026-07-15 so the
// feedback pipeline could reuse it — byte-identical behavior.

// Phone photos are several MB but the LLM provider rejects request bodies
// over ~1 MB — resize to max 1280px and walk JPEG quality (then dimensions)
// down until the data URL fits the budget.
export async function downscaleImage(file, budgetChars) {
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
