// The /docs viewer: lists every repo doc and renders it, with the shared
// Original ⇄ Cleaned pill (doc-variant.js) swapping between the authoritative
// original (docs-corpus.json) and the de-smelled review candidate
// (docs-corpus-clean.json). Candidates exist for docs/*.md and README; other
// files (CLAUDE.md, catalogs, ledgers) show original only.

import { renderMarkdownInto } from "/js/markdown.js";
import { getDocVariant, onDocVariantChange } from "/js/doc-variant.js";

const listEl = /** @type {HTMLElement} */ (document.getElementById("list"));
const docEl = /** @type {HTMLElement} */ (document.getElementById("doc"));
const statusEl = /** @type {HTMLElement} */ (document.getElementById("status"));
const filterEl = /** @type {HTMLInputElement} */ (document.getElementById("filter"));

/** @type {Map<string, string>} original text by path */
const orig = new Map();
/** @type {Map<string, string>} cleaned candidate text by path */
const clean = new Map();
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
      const badge = clean.has(p) ? '<span class="badge">cleaned</span>' : "";
      const active = p === current ? " active" : "";
      html += `<a class="doc-link${active}" data-path="${encodeURIComponent(p)}" href="#${encodeURIComponent(p)}">`
        + `<span>${escapeHtml(titleFor(p))}</span>${badge}</a>`;
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
  if (!current || !orig.has(current)) {
    docEl.innerHTML = '<p class="empty">Select a document from the list.</p>';
    statusEl.hidden = true;
    return;
  }
  const variant = getDocVariant();
  const hasClean = clean.has(current);
  const showClean = variant === "clean" && hasClean;
  const text = showClean ? /** @type {string} */ (clean.get(current)) : /** @type {string} */ (orig.get(current));

  if (variant === "clean" && !hasClean) {
    statusEl.innerHTML = `Showing the <b>original</b> — no cleaned candidate exists for <code>${escapeHtml(current)}</code> yet.`;
    statusEl.hidden = false;
  } else if (showClean) {
    statusEl.innerHTML = `Showing the <b>cleaned candidate</b> (AI-smell removed) for <code>${escapeHtml(current)}</code>. The original stays authoritative — flip the pill to compare.`;
    statusEl.hidden = false;
  } else {
    statusEl.innerHTML = `Showing the <b>original</b> <code>${escapeHtml(current)}</code>.${hasClean ? " A cleaned candidate exists — flip the pill to compare." : ""}`;
    statusEl.hidden = false;
  }

  renderMarkdownInto(docEl, text);
  for (const a of listEl.querySelectorAll("a.doc-link")) {
    a.classList.toggle("active", decodeURIComponent(a.getAttribute("data-path") || "") === current);
  }
  document.title = `${titleFor(current)} — DeepResearch.se docs`;
  docEl.scrollIntoView({ block: "start" });
}

function selectFromHash() {
  const h = decodeURIComponent((location.hash || "").replace(/^#/, ""));
  if (h && orig.has(h)) current = h;
  else if (!current) current = paths.includes("README.md") ? "README.md" : paths[0] || "";
  render();
}

async function load() {
  try {
    const [oRes, cRes] = await Promise.all([
      fetch("/introspect/docs-corpus.json"),
      fetch("/introspect/docs-corpus-clean.json").catch(() => null),
    ]);
    const o = await oRes.json();
    for (const f of o.files || []) orig.set(f.p, f.t);
    for (const [p, meta] of Object.entries(o.sources || {})) {
      if (meta && typeof meta === "object" && "title" in meta) titles.set(p, /** @type {any} */ (meta).title);
    }
    if (cRes && cRes.ok) {
      const c = await cRes.json();
      for (const f of c.files || []) clean.set(f.p, f.t);
    }
    // Order: root docs first (README leads), then docs/ alphabetically.
    const root = [...orig.keys()].filter(isRoot).sort((a, b) => (a === "README.md" ? -1 : b === "README.md" ? 1 : a.localeCompare(b)));
    const design = [...orig.keys()].filter((p) => !isRoot(p)).sort();
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
onDocVariantChange(() => { buildList(filterEl.value); render(); });

load();
