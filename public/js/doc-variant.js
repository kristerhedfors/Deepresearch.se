// Shared "Original ⇄ Cleaned" documentation toggle. One floating pill,
// remembered in localStorage, used by two kinds of surface:
//
//   1. Static HTML doc pages that ship BOTH variants inline. Wrap each
//      variant in an element with data-doc-variant="original" | "clean";
//      the pill shows one and hides the other in place.
//   2. The docs viewer (/docs/), which has no inline blocks — it listens for
//      the "doc-variant:change" window event and re-renders the selected doc.
//
// A page opts in by containing any [data-doc-variant] element OR a
// [data-doc-variant-toggle] marker (the viewer uses the latter). No opt-in →
// the module does nothing, so it is inert if ever loaded elsewhere.
//
// The two variants are the ORIGINAL docs and de-smelled REVIEW CANDIDATES
// (the anti-ai-smell pass). Originals stay authoritative; the pill is a
// compare-and-decide tool.

const KEY = "dr_doc_variant";
const VALUES = ["original", "clean"];

/** @returns {"original"|"clean"} */
export function getDocVariant() {
  try {
    const v = localStorage.getItem(KEY);
    if (v === "clean" || v === "original") return v;
  } catch (_) { /* storage blocked — fall through to default */ }
  return "original";
}

/** @param {string} v */
export function setDocVariant(v) {
  const variant = v === "clean" ? "clean" : "original";
  try { localStorage.setItem(KEY, variant); } catch (_) { /* ignore */ }
  apply(variant);
  window.dispatchEvent(new CustomEvent("doc-variant:change", { detail: { variant } }));
  return variant;
}

/** @param {(variant: "original"|"clean") => void} cb */
export function onDocVariantChange(cb) {
  window.addEventListener("doc-variant:change", (e) => {
    const detail = /** @type {CustomEvent} */ (e).detail;
    cb(detail && detail.variant === "clean" ? "clean" : "original");
  });
}

/** @param {"original"|"clean"} variant */
function apply(variant) {
  // Inline surfaces: show the matching variant blocks, hide the other.
  // SKIP the documentElement: apply() reflects the current variant onto <html>
  // as a styling hook (below), which makes the root match this very same
  // [data-doc-variant] selector. Treating it as a content block would set
  // html.hidden=true on any toggle where the previous (reflected) variant
  // differs from the new one — blanking the entire page. That was the
  // "screen turns white when I touch the knob" crash: reload cleared
  // html.hidden, the next toggle re-hid the root, and so on.
  const blocks = document.querySelectorAll("[data-doc-variant]");
  for (const el of blocks) {
    if (el === document.documentElement) continue;
    const want = el.getAttribute("data-doc-variant");
    /** @type {HTMLElement} */ (el).hidden = want !== variant;
  }
  // Reflect state on the pill.
  for (const btn of document.querySelectorAll(".dv-pill button")) {
    const on = btn.getAttribute("data-variant") === variant;
    btn.setAttribute("aria-pressed", on ? "true" : "false");
    btn.classList.toggle("on", on);
  }
  document.documentElement.setAttribute("data-doc-variant", variant);
}

function injectStyles() {
  if (document.getElementById("dv-pill-style")) return;
  const style = document.createElement("style");
  style.id = "dv-pill-style";
  style.textContent = `
  .dv-pill {
    position: fixed; z-index: 2147483000; right: max(1rem, env(safe-area-inset-right));
    bottom: max(1rem, env(safe-area-inset-bottom));
    display: inline-flex; align-items: center; gap: .15rem;
    padding: .2rem; border-radius: 999px;
    background: rgba(17, 24, 39, .92); color: #e5e7eb;
    box-shadow: 0 6px 22px rgba(0,0,0,.32); backdrop-filter: blur(6px);
    font: 600 12px/1 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    user-select: none;
  }
  .dv-pill .dv-label { padding: 0 .5rem 0 .6rem; opacity: .7; letter-spacing: .02em; }
  .dv-pill button {
    appearance: none; border: 0; cursor: pointer; color: inherit;
    background: transparent; padding: .4rem .7rem; border-radius: 999px;
    font: inherit; transition: background .12s, color .12s;
  }
  .dv-pill button:hover { background: rgba(255,255,255,.10); }
  .dv-pill button.on { background: #2563eb; color: #fff; }
  .dv-pill button:focus-visible { outline: 2px solid #93c5fd; outline-offset: 2px; }
  @media print { .dv-pill { display: none; } }
  `;
  document.head.appendChild(style);
}

function buildPill() {
  if (document.querySelector(".dv-pill")) return;
  const pill = document.createElement("div");
  pill.className = "dv-pill";
  pill.setAttribute("role", "group");
  pill.setAttribute("aria-label", "Documentation version");
  pill.innerHTML =
    '<span class="dv-label">Docs:</span>' +
    '<button type="button" data-variant="original" aria-pressed="true">Original</button>' +
    '<button type="button" data-variant="clean" aria-pressed="false">Cleaned</button>';
  pill.addEventListener("click", (e) => {
    const btn = /** @type {HTMLElement} */ (e.target).closest("button[data-variant]");
    if (btn) setDocVariant(btn.getAttribute("data-variant") || "original");
  });
  document.body.appendChild(pill);
}

/**
 * Mount the pill and apply the remembered variant. Safe to call more than
 * once. Honors a ?variant=clean|original query param (and persists it).
 */
export function initDocVariant() {
  injectStyles();
  buildPill();
  let variant = getDocVariant();
  try {
    const q = new URLSearchParams(location.search).get("variant");
    if (q && VALUES.includes(q)) { variant = /** @type {"original"|"clean"} */ (q); }
  } catch (_) { /* ignore */ }
  setDocVariant(variant);
}

// Auto-init on opt-in surfaces.
function maybeAutoInit() {
  if (document.querySelector("[data-doc-variant], [data-doc-variant-toggle]")) initDocVariant();
}
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", maybeAutoInit);
} else {
  maybeAutoInit();
}
