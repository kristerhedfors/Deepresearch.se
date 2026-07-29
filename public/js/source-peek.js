// SOURCE PEEK — the view half of tappable file references (feedback #10,
// 2026-07-24). Introspection answers cite the site's own files constantly;
// this module makes each inline-code mention of a repo file a tap target
// that opens the file from the COMMITTED source snapshot in a popover:
// syntax highlighted (the dependency-free tokenizer in source-peek-core.js),
// rendered when markdown, scrolled to a `:line` range when the reference
// carries one. Introspection is about ease of access to internals — the
// reference itself becomes the door.
//
// Served on BOTH tiers (isPublicAsset — the /cure module graph imports it),
// so like introspect-ui.js it injects its own scoped styles (`spk-`) and
// leans on neither tier's stylesheet. The snapshot is fetched lazily — only
// on the FIRST tap, never at render time — and cached for the page. DOM
// glue by design (no @ts-check, the sandbox.js/introspect-ui.js precedent);
// the parsing/resolution/tokenizing it renders is the Node-tested pure core.
//
// Fail-soft everywhere: with the gate off nothing is wired; a fetch failure
// or an unknown path shows an honest note inside the popover; nothing here
// can break the answer it decorates. Highlighted code is built with
// textContent-only spans — no answer text or file text ever meets innerHTML.

import { SNAPSHOT_PATH, validateSnapshot } from "./introspect-core.js";
import { escapeHtml, renderMarkdownInto } from "./markdown.js";
import {
  highlightLines,
  isMarkdownPath,
  languageForPath,
  parseSourceRef,
  resolveSourcePath,
} from "./source-peek-core.js";

// The tier wires its own gate (DRS: whether the picked chat mode carries the
// source — chat-mode-core.js modeCarriesSource; DRC: the sealed state's
// developerMode). Default off — an unwired page never marks anything up.
let enabledGate = () => false;

export function initSourcePeek(opts = {}) {
  if (typeof opts.enabled === "function") enabledGate = opts.enabled;
}

// ---- snapshot (page-lifetime cache, fetched on first tap) --------------------

let snapPromise = null;
function loadSnapshot() {
  if (!snapPromise) {
    snapPromise = fetch(SNAPSHOT_PATH)
      .then(async (res) => (res.ok ? validateSnapshot(await res.json()) : null))
      .catch(() => null);
    // A transient failure shouldn't poison the page: retry on the next tap.
    snapPromise.then((s) => {
      if (!s) snapPromise = null;
    });
  }
  return snapPromise;
}

// ---- wiring rendered answers -------------------------------------------------

/**
 * Scans a rendered answer for inline-code file references and makes each one
 * a tap target. Cheap (a regex per short code span, no snapshot fetch) and
 * idempotent — safe to call on every re-render of the same element.
 * @param {HTMLElement} root
 */
export function wireSourcePeek(root) {
  if (!root || !enabledGate()) return;
  for (const code of root.querySelectorAll("code")) {
    if (code.classList.contains("spk-ref")) continue;
    if (code.closest("pre, a")) continue; // fenced blocks and links stay as they are
    const ref = parseSourceRef(code.textContent || "");
    if (!ref) continue;
    code.classList.add("spk-ref");
    code.setAttribute("role", "button");
    code.setAttribute("tabindex", "0");
    code.title = "Open " + ref.path + " from the deployed source";
    code.addEventListener("click", (e) => {
      e.preventDefault();
      openSourcePeek(ref);
    });
    code.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        openSourcePeek(ref);
      }
    });
  }
}

// ---- styles (scoped, injected once) ------------------------------------------

// Titanium palette on purpose — the popover is part of introspection's
// identity (TIN's white/slate), distinct from either tier's chrome.
//
// ONE TYPE SCALE for the whole panel (feedback #51, 2026-07-29). It used to
// carry seven unrelated sizes (.72/.74/.76/.8/.82/.85/.86rem) that measured
// out as four near-identical steps inside 1.3px of each other — read as
// inconsistency rather than hierarchy — and the code listing was the
// SMALLEST text in a popover whose entire job is showing code. Two roles
// now, and only two: `--spk-ui` for chrome and code, `--spk-doc` for prose.
// Rendered markdown layers its heading ratios on top of --spk-doc and
// nothing else does. Keep it that way: a new raw font-size here is the bug
// coming back, and the type-scale guard in source-peek-core.test.js fails
// the build on one.
const CSS = `
.spk-ref { cursor: pointer; text-decoration: underline dotted; text-underline-offset: 2px; }
.spk-ref:hover, .spk-ref:focus-visible { text-decoration-style: solid; outline: none; }
#spk-overlay {
  position: fixed; inset: 0; z-index: 70; background: rgba(30, 35, 42, .45);
  display: flex; align-items: center; justify-content: center;
  padding: max(10px, env(safe-area-inset-top, 0px)) 10px max(10px, env(safe-area-inset-bottom, 0px));
}
#spk-overlay[hidden] { display: none; }
#spk-panel {
  --spk-ui: .8rem;
  --spk-doc: .875rem;
  display: flex; flex-direction: column; overflow: hidden;
  width: min(860px, 100%); max-height: min(52rem, 100%);
  color: #2a2f36; background: linear-gradient(165deg, #fdfdfe 0%, #f1f3f6 100%);
  border: 1px solid #c6ccd4; border-radius: 12px;
  box-shadow: 0 14px 40px rgba(40, 48, 58, .4);
}
#spk-head {
  display: flex; align-items: center; gap: .5rem; flex-wrap: wrap;
  padding: .55rem .7rem; border-bottom: 1px solid #d7dce2;
  background: linear-gradient(#fdfdfe, #eef1f4);
}
#spk-path {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: var(--spk-ui); font-weight: 600; word-break: break-all; margin-right: auto;
}
/* Same size as the path — the badge is set apart by its muted colour and
   chip background, not by being a third of a step smaller than everything. */
#spk-head .spk-badge {
  font-size: var(--spk-ui); color: #48505a; background: rgba(140, 150, 162, .16);
  border-radius: 6px; padding: .1rem .4rem; white-space: nowrap;
}
#spk-head button {
  border: 1px solid #c6ccd4; background: linear-gradient(#ffffff, #e8ebef);
  color: #2a2f36; border-radius: 8px; padding: .25rem .55rem;
  font-size: var(--spk-ui); cursor: pointer;
}
#spk-body { overflow: auto; overscroll-behavior: contain; flex: 1; }
#spk-body .spk-note { padding: .9rem; font-size: var(--spk-doc); line-height: 1.5; }
#spk-body .spk-note code {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  background: rgba(140, 150, 162, .18); border-radius: 4px; padding: 0 .25em;
}
.spk-pick { display: block; width: 100%; text-align: left; border: 0; cursor: pointer;
  background: none; padding: .45rem .9rem; font-size: var(--spk-ui); color: #2a2f36;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.spk-pick:hover, .spk-pick:focus-visible { background: rgba(140, 150, 162, .14); outline: none; }
#spk-code {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: var(--spk-ui); line-height: 1.45; padding: .5rem 0 .75rem; min-width: max-content;
}
.spk-line { display: flex; white-space: pre; }
.spk-line.spk-hl { background: rgba(255, 213, 128, .38); }
.spk-ln {
  flex: none; width: 3.2em; padding-right: .8em; text-align: right;
  color: #98a0aa; user-select: none;
}
.spk-lt { flex: none; padding-right: 1em; }
.spk-lt .c { color: #7a8391; font-style: italic; }
.spk-lt .s { color: #1f6b3a; }
.spk-lt .k { color: #7a3ea0; font-weight: 600; }
.spk-lt .n { color: #a05a1f; }
/* The rendered-markdown view. Its headings MUST size themselves here: the
   box used to be tagged .md in the hope of inheriting the tier's markdown
   styles, but every one of those rules is scoped .content.md, so none ever
   matched and the headings fell through to the UA defaults — an h1 rendered
   at 2em (27.5px against 13.8px body text) and, worse, an inline code span
   inside an h2 compounded to 19px while the identical span in a paragraph
   sat at 12.7px. Same element, same document, 50% apart. The ratios below
   mirror .content.md in css/app.css so a doc reads the same in the popover
   as it does in an answer bubble; keep the two in step. */
#spk-md { padding: .4rem .95rem .9rem; font-size: var(--spk-doc); line-height: 1.55; }
#spk-md > :first-child { margin-top: 0; }
#spk-md > :last-child { margin-bottom: 0; }
#spk-md p, #spk-md ul, #spk-md ol { margin: .5em 0; }
#spk-md ul, #spk-md ol { padding-left: 1.4em; }
#spk-md img { max-width: 100%; height: auto; }
#spk-md pre { overflow-x: auto; background: rgba(140, 150, 162, .12); border-radius: 8px; padding: .6rem; }
#spk-md code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: .9em; }
#spk-md table { display: block; overflow-x: auto; border-collapse: collapse; }
#spk-md th, #spk-md td { border: 1px solid #d7dce2; padding: .25rem .5rem; }
#spk-md blockquote { border-left: 3px solid #d7dce2; margin: .5em 0; padding-left: .7em; color: #5a626c; }
#spk-md hr { border: 0; border-top: 1px solid #d7dce2; }
#spk-md h1, #spk-md h2, #spk-md h3, #spk-md h4 { margin: .8em 0 .4em; line-height: 1.25; }
#spk-md h1 { font-size: 1.25em; }
#spk-md h2 { font-size: 1.15em; }
#spk-md h3, #spk-md h4 { font-size: 1.05em; }
@media (prefers-reduced-motion: no-preference) {
  #spk-panel { animation: spk-in .18s ease-out; }
  @keyframes spk-in { from { transform: translateY(10px); opacity: 0; } }
}`;

function ensureStyles() {
  if (document.getElementById("spk-css")) return;
  const style = document.createElement("style");
  style.id = "spk-css";
  style.textContent = CSS;
  document.head.appendChild(style);
}

// ---- the popover -------------------------------------------------------------

let overlayEl = null;
let pathEl, badgeEl, toggleBtn, bodyEl;
let currentFile = null; // { path, text, ref } once a file is shown
let mdMode = false; // markdown files: rendered (true) vs raw lines (false)

function ensureOverlay() {
  ensureStyles();
  if (overlayEl) return;
  overlayEl = document.createElement("div");
  overlayEl.id = "spk-overlay";
  overlayEl.hidden = true;
  overlayEl.innerHTML = `
    <div id="spk-panel" role="dialog" aria-modal="true" aria-labelledby="spk-path">
      <div id="spk-head">
        <span id="spk-path"></span>
        <span class="spk-badge" id="spk-badge" hidden></span>
        <button type="button" id="spk-toggle" hidden></button>
        <button type="button" id="spk-close" aria-label="Close">✕</button>
      </div>
      <div id="spk-body"></div>
    </div>`;
  document.body.appendChild(overlayEl);
  pathEl = overlayEl.querySelector("#spk-path");
  badgeEl = overlayEl.querySelector("#spk-badge");
  toggleBtn = overlayEl.querySelector("#spk-toggle");
  bodyEl = overlayEl.querySelector("#spk-body");
  overlayEl.querySelector("#spk-close").addEventListener("click", closeSourcePeek);
  overlayEl.addEventListener("pointerdown", (e) => {
    if (e.target === overlayEl) closeSourcePeek();
  });
  toggleBtn.addEventListener("click", () => {
    if (!currentFile) return;
    mdMode = !mdMode;
    showFileBody();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && overlayEl && !overlayEl.hidden) closeSourcePeek();
  });
}

export function closeSourcePeek() {
  if (overlayEl) overlayEl.hidden = true;
  currentFile = null;
}

function note(html) {
  bodyEl.innerHTML = `<div class="spk-note">${html}</div>`;
}

/**
 * Opens the popover for a parsed reference: resolve against the snapshot,
 * then show the file (unique match), a picker (ambiguous basename), or an
 * honest not-found note.
 * @param {{ path: string, start: number|null, end: number|null }} ref
 */
export async function openSourcePeek(ref) {
  ensureOverlay();
  overlayEl.hidden = false;
  currentFile = null;
  pathEl.textContent = ref.path;
  badgeEl.hidden = true;
  toggleBtn.hidden = true;
  note("Loading the deployed source snapshot…");

  const snapshot = await loadSnapshot();
  if (!overlayEl || overlayEl.hidden) return; // closed while loading
  if (!snapshot) {
    note("Couldn't load the source snapshot right now — please try again.");
    return;
  }
  const matches = resolveSourcePath(snapshot.files.map((f) => f.p), ref.path);
  if (!matches.length) {
    note(`<code>${escapeHtml(ref.path)}</code> isn't in the deployed source snapshot —
      it may be generated, renamed, or not a repo file.`);
    return;
  }
  if (matches.length > 1) {
    bodyEl.innerHTML = `<div class="spk-note">Several files match — pick one:</div>`;
    for (const p of matches) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "spk-pick";
      b.textContent = p;
      b.addEventListener("click", () => openSourcePeek({ ...ref, path: p }));
      bodyEl.appendChild(b);
    }
    return;
  }
  const path = matches[0];
  const file = snapshot.files.find((f) => f.p === path);
  pathEl.textContent = path;
  currentFile = { path, text: file.t, ref };
  // Markdown renders by default; a line reference opens raw so the cited
  // lines are actually visible and marked.
  mdMode = isMarkdownPath(path) && ref.start === null;
  showFileBody();
}

function showFileBody() {
  const { path, text, ref } = currentFile;
  const isMd = isMarkdownPath(path);
  const lineCount = text.split("\n").length;
  badgeEl.textContent =
    ref.start !== null
      ? ref.end !== ref.start
        ? `lines ${ref.start}–${ref.end} of ${lineCount}`
        : `line ${ref.start} of ${lineCount}`
      : `${lineCount} lines`;
  badgeEl.hidden = false;
  toggleBtn.hidden = !isMd;
  toggleBtn.textContent = mdMode ? "View source" : "View rendered";

  if (isMd && mdMode) {
    const box = document.createElement("div");
    box.id = "spk-md";
    // No `md` class: every tier rule for it is scoped `.content.md`, so the
    // tag matched nothing on either tier while reading as if the tier styled
    // this box — which is how the headings ended up at UA defaults (#51).
    // #spk-md styles itself, per this module's own no-tier-stylesheet rule.
    renderMarkdownInto(box, text);
    bodyEl.replaceChildren(box);
    bodyEl.scrollTop = 0;
    return;
  }

  const codeBox = document.createElement("div");
  codeBox.id = "spk-code";
  const start = ref.start !== null ? Math.min(ref.start, lineCount) : null;
  const end = ref.start !== null ? Math.min(ref.end ?? start, lineCount) : null;
  const lines = highlightLines(text, languageForPath(path));
  let scrollTarget = null;
  for (let i = 0; i < lines.length; i++) {
    const n = i + 1;
    const row = document.createElement("div");
    row.className = "spk-line";
    if (start !== null && n >= start && n <= end) {
      row.classList.add("spk-hl");
      if (n === start) scrollTarget = row;
    }
    const ln = document.createElement("span");
    ln.className = "spk-ln";
    ln.textContent = String(n);
    const lt = document.createElement("span");
    lt.className = "spk-lt";
    for (const tok of lines[i]) {
      if (!tok.c) {
        lt.appendChild(document.createTextNode(tok.t));
      } else {
        const span = document.createElement("span");
        span.className = tok.c;
        span.textContent = tok.t;
        lt.appendChild(span);
      }
    }
    if (!lines[i].length) lt.textContent = " "; // keep empty lines their height
    row.append(ln, lt);
    codeBox.appendChild(row);
  }
  bodyEl.replaceChildren(codeBox);
  if (scrollTarget) scrollTarget.scrollIntoView({ block: "center" });
  else bodyEl.scrollTop = 0;
}
