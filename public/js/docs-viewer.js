// The /docs viewer: lists every repo doc and renders it from the canonical
// corpus (docs-corpus.json). The docs are de-smelled in place by the Clean
// step wired into the doc pipelines, so there is one authoritative version —
// no original/candidate variants.

import { renderMarkdownInto } from "/js/markdown.js";

const listEl = /** @type {HTMLElement} */ (document.getElementById("list"));
const docEl = /** @type {HTMLElement} */ (document.getElementById("doc"));
const statusEl = /** @type {HTMLElement} */ (document.getElementById("status"));
const filterEl = /** @type {HTMLInputElement} */ (document.getElementById("filter"));

/** @type {Map<string, string>} doc text by path */
const docs = new Map();
/** @type {Map<string, string>} title by path */
const titles = new Map();
/** @type {string[]} ordered paths */
let paths = [];
let current = "";

function titleFor(p) {
  return titles.get(p) || p.replace(/^.*\//, "").replace(/\.md$/i, "");
}

function isRoot(p) { return !p.includes("/"); }

function buildList(filter = "") {
  const f = filter.trim().toLowerCase();
  const match = (p) => !f || p.toLowerCase().includes(f) || titleFor(p).toLowerCase().includes(f);
  const root = paths.filter((p) => isRoot(p) && match(p));
  const design = paths.filter((p) => !isRoot(p) && match(p));
  let html = "";
  const section = (label, ps) => {
    if (!ps.length) return;
    html += `<div class="group">${label}</div>`;
    for (const p of ps) {
      const active = p === current ? " active" : "";
      html += `<a class="doc-link${active}" data-path="${encodeURIComponent(p)}" href="#${encodeURIComponent(p)}">`
        + `<span>${escapeHtml(titleFor(p))}</span></a>`;
    }
  };
  section("Overview", root);
  section("Design docs", design);
  listEl.innerHTML = html || '<p class="empty">No matches.</p>';
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] || c));
}

function render() {
  if (!current || !docs.has(current)) {
    docEl.innerHTML = '<p class="empty">Select a document from the list.</p>';
    statusEl.hidden = true;
    return;
  }
  statusEl.innerHTML = `Showing <code>${escapeHtml(current)}</code>.`;
  statusEl.hidden = false;

  renderMarkdownInto(docEl, /** @type {string} */ (docs.get(current)));
  for (const a of listEl.querySelectorAll("a.doc-link")) {
    a.classList.toggle("active", decodeURIComponent(a.getAttribute("data-path") || "") === current);
  }
  document.title = `${titleFor(current)} — DeepResearch.se docs`;
  docEl.scrollIntoView({ block: "start" });
}

function selectFromHash() {
  const h = decodeURIComponent((location.hash || "").replace(/^#/, ""));
  if (h && docs.has(h)) current = h;
  else if (!current) current = paths.includes("README.md") ? "README.md" : paths[0] || "";
  render();
}

async function load() {
  try {
    const oRes = await fetch("/introspect/docs-corpus.json");
    const o = await oRes.json();
    for (const f of o.files || []) docs.set(f.p, f.t);
    for (const [p, meta] of Object.entries(o.sources || {})) {
      if (meta && typeof meta === "object" && "title" in meta) titles.set(p, /** @type {any} */ (meta).title);
    }
    // Order: root docs first (README leads), then docs/ alphabetically.
    const root = [...docs.keys()].filter(isRoot).sort((a, b) => (a === "README.md" ? -1 : b === "README.md" ? 1 : a.localeCompare(b)));
    const design = [...docs.keys()].filter((p) => !isRoot(p)).sort();
    paths = [...root, ...design];
  } catch (e) {
    docEl.innerHTML = '<p class="empty">Could not load the documentation corpus.</p>';
    return;
  }
  buildList();
  selectFromHash();
}

listEl.addEventListener("click", (e) => {
  const a = /** @type {HTMLElement} */ (e.target).closest("a.doc-link");
  if (!a) return;
  // hashchange drives selection; let the anchor's href update the hash.
});
filterEl.addEventListener("input", () => buildList(filterEl.value));
window.addEventListener("hashchange", selectFromHash);

load();
