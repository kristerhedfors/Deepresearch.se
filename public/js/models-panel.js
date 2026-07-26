// @ts-check
// THE MODEL LIFECYCLE BOARD — the Models agent's left sidebar, and its cards
// rendered inline in a turn.
//
// Every other mode's left sidebar is chat history. In Models mode it is the
// board instead (mode-theme.js `panel: "models"`), because in this agent the
// models ARE the session: what exists, what it costs, what it passed, and what
// it would take to let the rest of the platform use it.
//
// Three lanes, in lifecycle order (models-core.js LIFECYCLE):
//
//   ENABLED     you turned it on; it is in every mode's dropdown. Each card
//               carries its VERIFICATION CHECKLIST — one box per established
//               check, in three states. The boxes are not gates and never grey
//               anything out: a model failing four checks is still selectable.
//               They record what is known, which is a different job from
//               deciding what is allowed, and conflating the two would turn a
//               useful disclosure into a silent ban.
//   AVAILABLE   a configured provider ships it; already selectable, nothing to
//               enable. It can still be verified, and usually should be.
//   DISCOVERED  an open provider's catalog lists it. Enable to promote.
//
// Verification runs server-side (POST /api/models/verify → src/model-checks.js)
// and takes real time against a real provider, so the card shows per-check
// progress rather than a spinner over the whole thing: a nine-check run is nine
// visible answers, not one long wait.
//
// Everything here is fail-soft: an unreachable catalog leaves a spelled-out
// note and the already-enabled models keep working, which is exactly what the
// server does one layer down.

import {
  allowanceLine,
  badges,
  checkGlyph,
  checkTitle,
  estimateLine,
  filterRows,
  groupByState,
  primaryAction,
  providersLine,
  rateLine,
  verifyAction,
} from "./models-core.js";
import { reloadModels, selectModel } from "./models.js";

/** @typedef {import('./models-core.js').ModelRow} ModelRow */

/** @type {HTMLElement|null} */ let panel = null;
/** @type {HTMLElement|null} */ let listEl = null;
/** @type {HTMLInputElement|null} */ let searchEl = null;
/** @type {HTMLElement|null} */ let allowanceEl = null;
/** @type {HTMLElement|null} */ let noteEl = null;
/** @type {ModelRow[]} */
let rows = [];
/** @type {any} */
let allowance = null;
/** @type {any[]} */
let providers = [];
/** @type {{ prompt: number, completion: number } | null} */
let turn = null;
let loaded = false;
/** Model ids with a verification run in flight, so a second press can't start
 * a second run against the same provider key. */
const verifying = new Set();

/**
 * Wire the board. Every element is optional — a page without the markup simply
 * has no board, and the inline cards still work.
 * @param {{ button?: HTMLElement|null, panel?: HTMLElement|null, close?: HTMLElement|null,
 *   list?: HTMLElement|null, search?: HTMLInputElement|null, allowance?: HTMLElement|null,
 *   note?: HTMLElement|null }} els
 */
export function initModelsPanel(els) {
  panel = els.panel || null;
  listEl = els.list || null;
  searchEl = els.search || null;
  allowanceEl = els.allowance || null;
  noteEl = els.note || null;
  els.button?.addEventListener("click", () => toggleModelsBoard());
  els.close?.addEventListener("click", () => closeModelsBoard());
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

/** Open the board (loading the catalog the first time). */
export function openModelsBoard() {
  if (!panel) return;
  panel.hidden = false;
  if (!loaded) void loadCatalog(searchEl?.value || "");
}

/** Close it. */
export function closeModelsBoard() {
  if (panel) panel.hidden = true;
}

/** Toggle it. */
export function toggleModelsBoard() {
  if (!panel) return;
  if (panel.hidden) openModelsBoard();
  else closeModelsBoard();
}

/**
 * Fetch the catalog.
 * @param {string} q
 */
async function loadCatalog(q) {
  if (!listEl) return;
  if (!loaded) listEl.textContent = "Loading the model catalog…";
  try {
    const res = await fetch("/api/models/catalog?q=" + encodeURIComponent(q || ""));
    const data = await res.json();
    if (!res.ok) {
      rows = [];
      setNote(data?.error || "The model catalog is unavailable.");
      render();
      return;
    }
    loaded = true;
    adopt(data);
    setNote(data.note || refreshNote(data.refresh));
    render();
  } catch {
    setNote("Could not reach the model catalog.");
  }
}

/** @param {any} data */
function adopt(data) {
  if (Array.isArray(data?.models)) rows = data.models;
  if (data?.allowance) allowance = data.allowance;
  if (Array.isArray(data?.providers)) providers = data.providers;
  if (data?.turn) turn = data.turn;
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
  if (gone.length) parts.push(`${gone.join(", ")} is no longer served`);
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
  if (allowanceEl) {
    allowanceEl.replaceChildren();
    const a = document.createElement("div");
    a.textContent = allowanceLine(allowance);
    const p = document.createElement("div");
    p.className = "mdl-providers";
    p.textContent = providersLine(providers);
    allowanceEl.append(a, p);
  }
  const visible = filterRows(rows, searchEl?.value || "");
  listEl.replaceChildren();
  if (!visible.length) {
    const p = document.createElement("p");
    p.className = "muted";
    p.textContent = loaded ? "No models match that." : "Loading the model catalog…";
    listEl.appendChild(p);
    return;
  }
  for (const group of groupByState(visible)) {
    const head = document.createElement("div");
    head.className = "mdl-lane";
    const h = document.createElement("strong");
    h.textContent = `${group.label} · ${group.rows.length}`;
    const b = document.createElement("span");
    b.className = "mdl-lane-blurb";
    b.textContent = group.blurb;
    head.append(h, b);
    listEl.appendChild(head);
    for (const row of group.rows) listEl.appendChild(card(row));
  }
}

/**
 * One model card.
 * @param {ModelRow} row
 * @returns {HTMLElement}
 */
function card(row) {
  const el = document.createElement("div");
  el.className = `mdl-card mdl-${row.state}` + (row.enableable || row.state !== "discovered" ? "" : " mdl-blocked");
  el.dataset.model = row.id;

  const head = document.createElement("div");
  head.className = "mdl-card-head";
  const title = row.url ? document.createElement("a") : document.createElement("span");
  if (row.url && title instanceof HTMLAnchorElement) {
    title.href = row.url;
    title.target = "_blank";
    title.rel = "noopener";
    title.title = "Open the model's page";
  }
  title.className = "mdl-id";
  title.textContent = row.name || row.id;
  const prov = document.createElement("span");
  prov.className = "mdl-provider";
  prov.textContent = row.providerLabel;
  head.append(title, prov);
  el.appendChild(head);

  const meta = document.createElement("div");
  meta.className = "mdl-badges";
  for (const b of badges(row)) {
    const span = document.createElement("span");
    span.className = "mdl-badge";
    span.textContent = b;
    meta.appendChild(span);
  }
  if (meta.childElementCount) el.appendChild(meta);

  // The cost, always both ways round: the provider's own per-1M rate (the
  // number you can check on their pricing page) and what that means for one
  // turn here (the number that decides anything).
  const price = document.createElement("div");
  price.className = "mdl-price";
  price.textContent = rateLine(row);
  el.appendChild(price);
  const est = estimateLine(row, turn || undefined);
  if (est) {
    const e = document.createElement("div");
    e.className = "mdl-est";
    e.textContent = est;
    el.appendChild(e);
  }

  el.appendChild(checklist(row));

  const actions = document.createElement("div");
  actions.className = "mdl-actions";
  const action = primaryAction(row);
  if (action.action !== "none") {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "mdl-btn" + (row.state === "enabled" ? " mdl-btn-on" : "");
    btn.textContent = action.label;
    btn.title = action.title;
    btn.disabled = action.disabled;
    btn.addEventListener("click", () => {
      void (action.action === "enable" ? setEnabled(row, true, btn) : setEnabled(row, false, btn));
    });
    actions.appendChild(btn);
  }

  const verify = verifyAction(row);
  if (verify.shown) {
    const vb = document.createElement("button");
    vb.type = "button";
    vb.className = "mdl-btn mdl-btn-ghost";
    vb.textContent = verifying.has(row.id) ? "Verifying…" : "Verify";
    vb.title = verify.title;
    vb.disabled = verifying.has(row.id);
    vb.addEventListener("click", () => { void runVerify(row, vb); });
    actions.appendChild(vb);
  }

  // "Use now" only for a model that is actually selectable: enabling spends
  // allowance and lasts, using is this conversation only, and the two are
  // deliberately not collapsed into one button.
  if (row.usable) {
    const use = document.createElement("button");
    use.type = "button";
    use.className = "mdl-btn mdl-btn-ghost";
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
  el.appendChild(actions);

  if (row.state === "discovered" && !row.enableable && row.reason) {
    const why = document.createElement("div");
    why.className = "mdl-why";
    why.textContent = row.reason;
    el.appendChild(why);
  }
  return el;
}

/**
 * The verification checklist — the row of boxes that is the point of the
 * sidebar. Three states per box, each with the full explanation on hover, and
 * a summary line that says plainly these are not blockers.
 * @param {ModelRow} row
 * @returns {HTMLElement}
 */
function checklist(row) {
  const wrap = document.createElement("div");
  wrap.className = "mdl-checks";
  const boxes = document.createElement("div");
  boxes.className = "mdl-checkboxes";
  for (const c of row.checks || []) {
    const box = document.createElement("span");
    box.className = `mdl-check mdl-check-${c.state}`;
    box.title = checkTitle(c);
    const glyph = document.createElement("span");
    glyph.className = "mdl-check-glyph";
    glyph.textContent = checkGlyph(c.state);
    const label = document.createElement("span");
    label.className = "mdl-check-label";
    label.textContent = c.label;
    box.append(glyph, label);
    boxes.appendChild(box);
  }
  wrap.appendChild(boxes);
  const sum = document.createElement("div");
  sum.className = "mdl-check-sum";
  sum.textContent = row.verification?.label || "";
  sum.title = "Verification status only — these are not blockers. A failing check is a known limitation, not a ban; an untried one is a question nobody has asked yet.";
  wrap.appendChild(sum);
  return wrap;
}

/**
 * Run the checks. Per-check progress lands on the card as it arrives, because a
 * nine-check run against a real provider takes real time and one long spinner
 * would hide which check is slow.
 * @param {ModelRow} row
 * @param {HTMLButtonElement} btn
 */
async function runVerify(row, btn) {
  if (verifying.has(row.id)) return;
  verifying.add(row.id);
  btn.disabled = true;
  btn.textContent = "Verifying…";
  try {
    const res = await fetch("/api/models/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: row.id }),
    });
    const data = await res.json();
    if (!res.ok) {
      setNote(data?.error || "Could not verify that model.");
      return;
    }
    adopt(data);
    if (data.model) replaceRow(data.model);
    const passed = (data.results || []).filter((/** @type {any} */ r) => r.pass).length;
    setNote(`${row.name}: ${passed}/${(data.results || []).length} checks passed. Failing checks are limitations, not blockers — it stays selectable.`);
  } catch {
    setNote("Could not reach the server.");
  } finally {
    verifying.delete(row.id);
    render();
    for (const host of inlineHosts) renderInto(host);
  }
}

/**
 * Enable or disable a model. On success the ordinary model dropdown is
 * reloaded, which is the moment the change becomes visible in every other mode.
 * @param {ModelRow} row
 * @param {boolean} on
 * @param {HTMLButtonElement} btn
 */
async function setEnabled(row, on, btn) {
  btn.disabled = true;
  const was = btn.textContent;
  btn.textContent = on ? "Enabling…" : "Removing…";
  try {
    const res = await fetch(on ? "/api/models/enable" : "/api/models/disable", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: row.id }),
    });
    const data = await res.json();
    if (!res.ok) {
      btn.textContent = was;
      btn.disabled = false;
      setNote(data?.error || "Could not change that model.");
      return;
    }
    adopt(data);
    if (data.model) replaceRow(data.model);
    await reloadModels();
    if (on) setNote(`${row.name} is enabled — it is now in the model dropdown in every chat mode.`);
    render();
    for (const host of inlineHosts) renderInto(host);
  } catch {
    btn.textContent = was;
    btn.disabled = false;
    setNote("Could not reach the server.");
  }
}

/**
 * Swap one row in place across both surfaces, so the board and any inline cards
 * agree the moment either one changes something.
 * @param {ModelRow} next
 */
function replaceRow(next) {
  for (const list of [rows, inlineRows]) {
    const i = list.findIndex((r) => r.id === next.id);
    if (i >= 0) list[i] = next;
  }
}

// ---- the inline cards -------------------------------------------------------

/** @type {ModelRow[]} */
let inlineRows = [];
/** @type {HTMLElement[]} */
const inlineHosts = [];

/**
 * Render the `model_cards` SSE event inside a turn. The event carries the same
 * rows the board shows, already ranked against the question the user asked, so
 * the choice appears next to the reasoning about it rather than in a panel the
 * user has to think to open.
 * @param {HTMLElement} turnEl the turn body to append into
 * @param {any} status the SSE `status` object (type "model_cards")
 * @returns {HTMLElement|null}
 */
export function renderModelCardsEvent(turnEl, status) {
  if (!turnEl || !Array.isArray(status?.models) || !status.models.length) return null;
  inlineRows = status.models;
  if (status.allowance) allowance = status.allowance;
  if (Array.isArray(status.providers)) providers = status.providers;
  const host = document.createElement("div");
  host.className = "mdl-embed";
  const head = document.createElement("div");
  head.className = "mdl-embed-head";
  head.textContent = status.query ? `Models for “${status.query}”` : "Models this deployment can reach";
  host.appendChild(head);
  const sub = document.createElement("div");
  sub.className = "mdl-embed-sub muted";
  sub.textContent = allowanceLine(allowance) + " Enabling a model here makes it selectable in every chat mode.";
  host.appendChild(sub);
  const list = document.createElement("div");
  list.className = "mdl-embed-list";
  host.appendChild(list);
  turnEl.appendChild(host);
  inlineHosts.push(host);
  renderInto(host);
  return host;
}

/** @param {HTMLElement} host */
function renderInto(host) {
  const list = host.querySelector(".mdl-embed-list");
  if (!list) return;
  list.replaceChildren();
  for (const row of inlineRows) list.appendChild(card(row));
}
