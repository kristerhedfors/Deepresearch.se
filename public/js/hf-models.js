// @ts-check
// THE MODEL SHELF — the Hugging Face agent's own piece of UI.
//
// Every other mode picks its answer model from a fixed dropdown. This one opens
// the whole Hugging Face router catalog: search it, read what each model costs
// per 1M tokens and per research turn, and press Enable. Enabling is the part
// that reaches outside this mode — an enabled model joins the account's catalog
// (POST /api/hf/models → src/user-models.js), so the next thing that happens is
// the ordinary model dropdown gains it, in EVERY chat mode. That is the whole
// promotion pipeline, and the card says so in as many words.
//
// Two surfaces, one renderer:
//   · the SHELF — a side panel opened from the composer's 🤗 button, showing
//     the account's enabled models first and the searchable catalog under them.
//   · INLINE CARDS — when a turn's `hf_models` SSE event arrives (the agent
//     answered a model-shopping question), the same cards render inside the
//     answer, so the choice is offered where the reasoning about it is.
//
// Everything here is fail-soft: an unreachable catalog leaves a spelled-out
// note and the already-enabled models keep working, which is exactly what the
// server does one layer down.

import {
  allowanceLine,
  badges,
  estimateLine,
  filterRows,
  primaryAction,
  rateLine,
} from "./hf-models-core.js";
import { reloadModels, selectModel } from "./models.js";

/** @typedef {import('./hf-models-core.js').HfRow} HfRow */

/** @type {HTMLElement|null} */ let panel = null;
/** @type {HTMLElement|null} */ let listEl = null;
/** @type {HTMLInputElement|null} */ let searchEl = null;
/** @type {HTMLElement|null} */ let allowanceEl = null;
/** @type {HTMLElement|null} */ let noteEl = null;
/** @type {HfRow[]} */
let rows = [];
/** @type {any} */
let allowance = null;
/** @type {{ prompt: number, completion: number } | null} */
let turn = null;
let loaded = false;

/**
 * Wire the shelf. Every element is optional — a page without the panel markup
 * simply has no shelf, and the inline cards still work.
 * @param {{ button?: HTMLElement|null, panel?: HTMLElement|null, close?: HTMLElement|null,
 *   list?: HTMLElement|null, search?: HTMLInputElement|null, allowance?: HTMLElement|null,
 *   note?: HTMLElement|null }} els
 */
export function initHfModels(els) {
  panel = els.panel || null;
  listEl = els.list || null;
  searchEl = els.search || null;
  allowanceEl = els.allowance || null;
  noteEl = els.note || null;
  els.button?.addEventListener("click", () => toggleHfShelf());
  els.close?.addEventListener("click", () => closeHfShelf());
  searchEl?.addEventListener("input", () => {
    // Typing filters what is already on screen instantly; the round trip is
    // debounced behind it so a longer query still reaches the server's ranking.
    render();
    debouncedFetch(searchEl?.value || "");
  });
}

let debounceTimer = 0;
/** @param {string} q */
function debouncedFetch(q) {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => { void loadCatalog(q); }, 350);
}

/** Open the shelf (loading the catalog the first time). */
export function openHfShelf() {
  if (!panel) return;
  panel.hidden = false;
  if (!loaded) void loadCatalog(searchEl?.value || "");
}

/** Close the shelf. */
export function closeHfShelf() {
  if (panel) panel.hidden = true;
}

/** Toggle it. */
export function toggleHfShelf() {
  if (!panel) return;
  if (panel.hidden) openHfShelf();
  else closeHfShelf();
}

/**
 * Fetch a page of the catalog.
 * @param {string} q
 */
async function loadCatalog(q) {
  if (!listEl) return;
  if (!loaded) listEl.textContent = "Loading the Hugging Face catalog…";
  try {
    const res = await fetch("/api/hf/models?q=" + encodeURIComponent(q || ""));
    const data = await res.json();
    if (!res.ok) {
      rows = [];
      setNote(data?.error || "The model catalog is unavailable.");
      render();
      return;
    }
    loaded = true;
    rows = Array.isArray(data.models) ? data.models : [];
    allowance = data.allowance || null;
    turn = data.turn || null;
    setNote(data.note || refreshNote(data.refresh));
    render();
  } catch {
    setNote("Could not reach the model catalog.");
  }
}

/**
 * The one honest thing to say about snapshotted prices: which enabled models
 * the live catalog now prices differently. Silent when nothing drifted.
 * @param {any[]} refresh
 * @returns {string}
 */
function refreshNote(refresh) {
  if (!Array.isArray(refresh) || !refresh.length) return "";
  const gone = refresh.filter((r) => r.gone).map((r) => r.hfId);
  const moved = refresh.filter((r) => !r.gone);
  const parts = [];
  if (gone.length) parts.push(`${gone.join(", ")} is no longer served through the router`);
  for (const m of moved) {
    parts.push(`${m.hfId} now costs $${m.usd_out}/1M out (you enabled it at $${m.was_usd_out})`);
  }
  return parts.length
    ? parts.join("; ") + ". You keep the price you enabled until you press Enable again."
    : "";
}

/** @param {string} text */
function setNote(text) {
  if (!noteEl) return;
  noteEl.textContent = text || "";
  noteEl.hidden = !text;
}

function render() {
  if (!listEl) return;
  if (allowanceEl) allowanceEl.textContent = allowanceLine(allowance);
  const visible = filterRows(rows, searchEl?.value || "");
  listEl.replaceChildren();
  if (!visible.length) {
    const p = document.createElement("p");
    p.className = "muted";
    p.textContent = loaded ? "No models match that." : "Loading the Hugging Face catalog…";
    listEl.appendChild(p);
    return;
  }
  // Enabled first: the shelf's job is as much "what did I turn on" as "what
  // else is there".
  const ordered = [...visible.filter((r) => r.accepted), ...visible.filter((r) => !r.accepted)];
  for (const row of ordered) listEl.appendChild(card(row, { compact: false }));
}

/**
 * One model card.
 * @param {HfRow} row
 * @param {{ compact: boolean }} opts
 * @returns {HTMLElement}
 */
function card(row, opts) {
  const el = document.createElement("div");
  el.className = "hf-card" + (row.accepted ? " hf-on" : "") + (row.allowed ? "" : " hf-blocked");

  const head = document.createElement("div");
  head.className = "hf-card-head";
  const link = document.createElement("a");
  link.href = row.url;
  link.target = "_blank";
  link.rel = "noopener";
  link.className = "hf-id";
  link.textContent = row.hfId;
  link.title = "Open the model card on huggingface.co";
  head.appendChild(link);
  el.appendChild(head);

  const meta = document.createElement("div");
  meta.className = "hf-badges";
  for (const b of badges(row)) {
    const span = document.createElement("span");
    span.className = "hf-badge";
    span.textContent = b;
    meta.appendChild(span);
  }
  el.appendChild(meta);

  // The cost, always both ways round: the provider's own per-1M rate (the
  // number you can check on huggingface.co) and what that means for one turn
  // here (the number that decides anything).
  const price = document.createElement("div");
  price.className = "hf-price";
  price.textContent = rateLine(row);
  el.appendChild(price);
  const est = estimateLine(row, turn || undefined);
  if (est) {
    const e = document.createElement("div");
    e.className = "hf-est";
    e.textContent = est;
    el.appendChild(e);
  }

  const actions = document.createElement("div");
  actions.className = "hf-actions";
  const action = primaryAction(row);
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "hf-btn" + (row.accepted ? " hf-btn-on" : "");
  btn.textContent = action.label;
  btn.title = action.title;
  btn.disabled = action.disabled;
  btn.addEventListener("click", () => {
    void (action.action === "accept" ? accept(row, btn) : remove(row, btn));
  });
  actions.appendChild(btn);

  // "Use now" only appears once a model is enabled, because until then there is
  // nothing in the dropdown to select — the two steps are deliberately not
  // collapsed into one: enabling spends allowance and lasts, using is this
  // conversation only.
  if (row.accepted) {
    const use = document.createElement("button");
    use.type = "button";
    use.className = "hf-btn hf-btn-ghost";
    use.textContent = "Use now";
    use.title = "Answer with this model from the next message";
    use.addEventListener("click", () => {
      try {
        selectModel(row.id);
        use.textContent = "Selected ✓";
      } catch {
        use.textContent = "Not in the dropdown yet";
      }
    });
    actions.appendChild(use);
  }
  if (!opts.compact && !row.allowed && row.reason) {
    const why = document.createElement("div");
    why.className = "hf-why";
    why.textContent = row.reason;
    el.appendChild(why);
  }
  el.appendChild(actions);
  return el;
}

/**
 * Enable a model. On success the ordinary model dropdown is reloaded, which is
 * the moment it becomes selectable in every other chat mode.
 * @param {HfRow} row
 * @param {HTMLButtonElement} btn
 */
async function accept(row, btn) {
  btn.disabled = true;
  const was = btn.textContent;
  btn.textContent = "Enabling…";
  try {
    const res = await fetch("/api/hf/models", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hfId: row.hfId, provider: row.provider || undefined }),
    });
    const data = await res.json();
    if (!res.ok) {
      btn.textContent = was;
      btn.disabled = false;
      setNote(data?.error || "Could not enable that model.");
      return;
    }
    applyAccepted(data.accepted, data.allowance);
    await reloadModels();
    setNote(`${row.hfId} is enabled — it is now in the model dropdown in every chat mode.`);
  } catch {
    btn.textContent = was;
    btn.disabled = false;
    setNote("Could not reach the server.");
  }
}

/**
 * @param {HfRow} row
 * @param {HTMLButtonElement} btn
 */
async function remove(row, btn) {
  btn.disabled = true;
  btn.textContent = "Removing…";
  try {
    const res = await fetch("/api/hf/models?id=" + encodeURIComponent(row.id), { method: "DELETE" });
    const data = await res.json();
    if (!res.ok) {
      setNote(data?.error || "Could not remove that model.");
      btn.disabled = false;
      return;
    }
    applyAccepted(data.accepted, data.allowance);
    await reloadModels();
  } catch {
    btn.disabled = false;
    setNote("Could not reach the server.");
  }
}

/**
 * Re-mark the on-screen rows against a fresh accepted list, so both surfaces
 * (shelf and inline cards) agree the moment either one changes something.
 * @param {any[]} accepted
 * @param {any} nextAllowance
 */
function applyAccepted(accepted, nextAllowance) {
  const ids = new Set((Array.isArray(accepted) ? accepted : []).map((m) => m.hfId));
  allowance = nextAllowance || allowance;
  for (const r of rows) r.accepted = ids.has(r.hfId);
  for (const r of inlineRows) r.accepted = ids.has(r.hfId);
  render();
  for (const host of inlineHosts) renderInto(host);
}

// ---- the inline cards -------------------------------------------------------

/** @type {HfRow[]} */
let inlineRows = [];
/** @type {HTMLElement[]} */
const inlineHosts = [];

/**
 * Render the `hf_models` SSE event inside a turn. The event carries the same
 * rows the shelf shows, already ranked against the question the user asked, so
 * the choice appears next to the reasoning about it rather than in a panel the
 * user has to think to open.
 * @param {HTMLElement} turnEl the turn body to append into
 * @param {any} status the SSE `status` object (type "hf_models")
 * @returns {HTMLElement|null} the block, so the caller can record it as an embed
 */
export function renderHfModelsEvent(turnEl, status) {
  if (!turnEl || !Array.isArray(status?.models) || !status.models.length) return null;
  inlineRows = status.models;
  allowance = status.allowance || allowance;
  const host = document.createElement("div");
  host.className = "hf-embed";
  const head = document.createElement("div");
  head.className = "hf-embed-head";
  head.textContent = status.query
    ? `Models on the Hugging Face router for “${status.query}”`
    : "Models on the Hugging Face router";
  host.appendChild(head);
  const sub = document.createElement("div");
  sub.className = "hf-embed-sub muted";
  sub.textContent = allowanceLine(allowance)
    + " Enabling a model here makes it selectable in every chat mode.";
  host.appendChild(sub);
  const list = document.createElement("div");
  list.className = "hf-embed-list";
  host.appendChild(list);
  turnEl.appendChild(host);
  inlineHosts.push(host);
  renderInto(host);
  return host;
}

/** @param {HTMLElement} host */
function renderInto(host) {
  const list = host.querySelector(".hf-embed-list");
  if (!list) return;
  list.replaceChildren();
  for (const row of inlineRows) list.appendChild(card(row, { compact: true }));
}
