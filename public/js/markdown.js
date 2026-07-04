// Sanitized markdown rendering, wrapping the vendored globals `marked` and
// `DOMPurify` (loaded as classic scripts before the app module). Falls back
// to plain text if either is missing.

export function renderMarkdownInto(el, text) {
  if (!(window.marked && window.DOMPurify)) {
    el.textContent = text;
    return;
  }
  // FORBID img: beyond XSS, a rendered <img> from answer text would fire
  // third-party requests (tracking pixels) — sources stay links.
  el.innerHTML = DOMPurify.sanitize(marked.parse(text), { FORBID_TAGS: ["img"] });
  for (const a of el.querySelectorAll("a")) {
    a.target = "_blank";
    a.rel = "noopener";
  }
}
