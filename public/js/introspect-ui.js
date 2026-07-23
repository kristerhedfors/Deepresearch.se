// Introspection mode's user-facing side: TIN — the titanium-white robot
// mascot — slides in along the top (the landing ghost-mascot pattern:
// travel transition on the wrapper, dance keyframes on the body, wave on
// the arm) with a speech bubble explaining the mode, and (on DRS) the
// ANSWER-ROUTE PICKER: the user's own provider keys (browser-direct — the
// private, recommended choice, highlighted) vs this site's server models
// (clearly labeled REMOTE). Titanium white is deliberately this agent's own
// palette — the blue tier, the khaki DRC, and now titanium for the
// introspection character.
//
// Served on BOTH tiers (in isPublicAsset for the /cure graph), so the
// component injects its own scoped styles instead of leaning on either
// tier's stylesheet — one look, no dual-CSS drift (the sandbox panel
// precedent). DOM/browser glue by design (no @ts-check, like sandbox.js);
// the grouping/choice logic it renders is the Node-tested pure core
// (introspect-core.js groupIntrospectionModels/parseIntrospectionChoice).
//
// Storage (DRS): the picked route in localStorage `dr_introspect_choice`,
// the user's provider keys in `dr_introspect_keys` — browser-local only,
// never sent to this site's server (a private-route question goes straight
// from the browser to the provider; the server is not in the path at all).
// On DRC keys already live inside the sealed project state, so the panel
// there is informational: everything is private by construction.

import {
  groupIntrospectionModels,
  introspectionIntent,
  parseIntrospectionChoice,
} from "./introspect-core.js";
import { DRC_PROVIDERS, detectDrcProvider, drcProvider, foreignDrcKeyHint, listDrcModels } from "./drc-providers.js";

const CHOICE_KEY = "dr_introspect_choice";
const KEYS_KEY = "dr_introspect_keys";

let tier = "drs"; // "drs" | "drc"
let mascotEl = null;
let bubbleEl = null;
let visible = false;
let dismissedAt = 0;
let shownThisLoad = false;
let serverModels = []; // /api/models entries (DRS)

// ---- storage ----------------------------------------------------------------

function storedKeys() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEYS_KEY) || "{}");
    return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  } catch {
    return {};
  }
}

function saveStoredKey(providerId, key) {
  const keys = storedKeys();
  if (key) keys[providerId] = key;
  else delete keys[providerId];
  try {
    localStorage.setItem(KEYS_KEY, JSON.stringify(keys));
  } catch { /* storage full/blocked — the key just won't persist */ }
}

function storedChoice() {
  try {
    return localStorage.getItem(CHOICE_KEY) || "";
  } catch {
    return "";
  }
}

function saveChoice(value) {
  try {
    localStorage.setItem(CHOICE_KEY, value);
  } catch { /* non-fatal */ }
}

// ---- the route stream.js asks about ------------------------------------------

/**
 * The private (browser-direct) route, when the user picked one and its key
 * is stored: { providerId, apiKey, model, label } — else null (server path).
 */
export function privateIntrospectionRoute() {
  const choice = parseIntrospectionChoice(storedChoice());
  if (!choice || choice.kind !== "private") return null;
  const apiKey = storedKeys()[choice.providerId];
  const provider = drcProvider(choice.providerId);
  if (!apiKey || !provider) return null;
  return { providerId: choice.providerId, apiKey, model: choice.model, label: provider.label };
}

/** The remote model explicitly picked in the panel (overrides the composer dropdown for introspection sends), or "". */
export function introspectionRemoteModel() {
  const choice = parseIntrospectionChoice(storedChoice());
  return choice && choice.kind === "server" ? choice.model : "";
}

/**
 * A short label for the composer-row route chip (app.js #introroute) — the
 * SAME private-vs-remote decision the send path consults, worded for a
 * ~9-char-wide pill. On the secure tier every call is already private by
 * construction (no picker there — see bubbleHtml), so the label is fixed.
 * Pure over localStorage, like the two accessors above — no DOM.
 * @returns {string}
 */
export function introspectionRouteLabel() {
  if (tier === "drc") return "🔒 Private";
  const route = privateIntrospectionRoute();
  if (route) return `🔒 ${route.label}`;
  const remote = introspectionRemoteModel();
  return remote ? `☁ ${remote}` : "☁ Server";
}

// ---- engagement triggers ------------------------------------------------------

/** One-time setup: which tier this page is. */
export function initIntrospectUi(opts = {}) {
  tier = opts.tier === "drc" ? "drc" : "drs";
}

/** Fires whenever the picked route changes (a select edit, a key save/remove) —
 * the composer-row chip's cue to re-read introspectionRouteLabel(). */
let onRouteChangeCb = () => {};
export function onIntrospectionRouteChange(cb) {
  onRouteChangeCb = typeof cb === "function" ? cb : () => {};
}

/** Force-open the route picker regardless of intent-gating/debounce — the
 * composer-row chip's click target (app.js), so the choice is reachable
 * without first typing something introspection-shaped. */
export function openRoutePicker() {
  showMascot();
}

/**
 * Called as the user types (debounced by the caller) — the mascot slides in
 * the FIRST time a message reads as an introspection ask, so the route can
 * be picked BEFORE the question is sent.
 */
export function noteIntrospectionText(text) {
  if (shownThisLoad || !introspectionIntent(text)) return;
  showMascot();
}

/** Called when a send actually engages the mode — re-shows unless recently dismissed. */
export function engageIntrospection() {
  if (visible || Date.now() - dismissedAt < 120_000) return;
  showMascot();
}

// ---- styles (scoped, injected once) --------------------------------------------

const CSS = `
#iui-mascot {
  position: fixed; left: 0; z-index: 60;
  top: calc(5.6rem + env(safe-area-inset-top, 0px));
  transform: translateX(-110px);
  transition: transform 2.4s cubic-bezier(.45, .08, .35, 1);
  pointer-events: none;
  filter: drop-shadow(0 6px 12px rgba(40, 48, 58, .35));
}
#iui-mascot.drc { top: calc(4.4rem + env(safe-area-inset-top, 0px)); }
#iui-mascot[hidden] { display: none; }
#iui-mascot.bye { transition: opacity .4s ease; opacity: 0; }
.iui-body { animation: iui-dance .55s ease-in-out infinite alternate; transform-origin: 50% 92%; }
@keyframes iui-dance {
  from { transform: translateY(0) rotate(-6deg) scale(1, .98); }
  to   { transform: translateY(-5px) rotate(6deg) scale(1, 1.02); }
}
#iui-mascot.settled .iui-body { animation: iui-bob 1.8s ease-in-out infinite alternate; }
@keyframes iui-bob { from { transform: translateY(0); } to { transform: translateY(-4px); } }
.iui-arm { transform-box: fill-box; transform-origin: 15% 20%; animation: iui-wave 1.1s ease-in-out infinite alternate; }
@keyframes iui-wave { from { transform: rotate(0deg); } to { transform: rotate(-24deg); } }
#iui-bubble {
  position: fixed; left: 12px; z-index: 60;
  width: min(400px, calc(100vw - 24px));
  color: #2a2f36;
  background: linear-gradient(165deg, #fdfdfe 0%, #eef1f4 55%, #e4e8ed 100%);
  border: 1px solid #c6ccd4; border-radius: 4px 14px 14px 14px;
  padding: .75rem .9rem; font-size: .85rem; line-height: 1.5;
  box-shadow: 0 10px 30px rgba(40, 48, 58, .3), inset 0 1px 0 rgba(255, 255, 255, .9);
  transform: scale(.7); transform-origin: top left; opacity: 0;
  transition: transform .3s cubic-bezier(.3, 1.4, .5, 1), opacity .3s ease;
}
#iui-bubble.show { transform: scale(1); opacity: 1; }
#iui-bubble[hidden] { display: none; }
#iui-bubble code { background: rgba(140, 150, 162, .18); border-radius: 4px; padding: 0 .25em; }
#iui-bubble .iui-x {
  position: absolute; top: .35rem; right: .45rem; border: 0; background: none;
  color: #6c7684; font-size: 1rem; line-height: 1; cursor: pointer; padding: .2rem;
}
#iui-bubble label { display: block; margin: .6rem 0 .2rem; font-weight: 600; font-size: .78rem; color: #48505a; }
#iui-bubble select, #iui-bubble input[type="password"] {
  width: 100%; box-sizing: border-box; font-size: .84rem; color: #2a2f36;
  background: #ffffff; border: 1px solid #c6ccd4; border-radius: 8px; padding: .4rem .5rem;
}
#iui-bubble select optgroup[data-kind="private"] { font-style: normal; font-weight: 700; color: #1f6b3a; }
#iui-bubble select optgroup[data-kind="remote"] { font-style: normal; color: #6c7684; }
#iui-note { margin: .45rem 0 0; font-size: .78rem; }
#iui-note.private { color: #1f6b3a; font-weight: 600; }
#iui-note.remote { color: #8a5a1f; }
.iui-keyrow { display: flex; gap: .4rem; margin-top: .45rem; }
.iui-keyrow input { flex: 1; }
.iui-keyrow button, .iui-managed button {
  border: 1px solid #c6ccd4; background: linear-gradient(#ffffff, #e8ebef);
  color: #2a2f36; border-radius: 8px; padding: .35rem .6rem; font-size: .78rem; cursor: pointer;
}
.iui-managed { margin-top: .4rem; font-size: .78rem; color: #48505a; display: flex; flex-wrap: wrap; gap: .4rem; align-items: center; }
.iui-dim { color: #98a0aa; }
@media (prefers-reduced-motion: reduce) {
  #iui-mascot { transition: none; }
  .iui-body, #iui-mascot.settled .iui-body, .iui-arm { animation: none; }
  #iui-bubble { transition: none; }
}`;

function ensureStyles() {
  if (document.getElementById("iui-css")) return;
  const style = document.createElement("style");
  style.id = "iui-css";
  style.textContent = CSS;
  document.head.appendChild(style);
}

// ---- the character --------------------------------------------------------------

// TIN, the titanium robot: dome head + antenna, visor eyes, a waving arm.
// All-white/silver fills with slate strokes — nothing borrowed from either
// tier's palette.
const ROBOT_SVG = `
<svg class="iui-body" viewBox="0 0 64 74" width="58" height="67" aria-hidden="true">
  <defs>
    <linearGradient id="iui-ti" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#fdfdfe"/><stop offset=".55" stop-color="#eef1f4"/><stop offset="1" stop-color="#d9dee4"/>
    </linearGradient>
  </defs>
  <line x1="32" y1="10" x2="32" y2="3" stroke="#3a414b" stroke-width="2.2" stroke-linecap="round"/>
  <circle cx="32" cy="3" r="2.6" fill="#fdfdfe" stroke="#3a414b" stroke-width="1.6"/>
  <rect x="12" y="10" width="40" height="30" rx="14" fill="url(#iui-ti)" stroke="#3a414b" stroke-width="2.4"/>
  <circle cx="25" cy="24" r="3" fill="#3a414b"/>
  <circle cx="39" cy="24" r="3" fill="#3a414b"/>
  <path d="M26 31 q6 4 12 0" fill="none" stroke="#3a414b" stroke-width="2" stroke-linecap="round"/>
  <rect x="17" y="42" width="30" height="24" rx="9" fill="url(#iui-ti)" stroke="#3a414b" stroke-width="2.4"/>
  <circle cx="32" cy="52" r="3.4" fill="none" stroke="#8e959e" stroke-width="1.8"/>
  <path d="M17 48 q-6 2 -8 8" fill="none" stroke="#3a414b" stroke-width="2.4" stroke-linecap="round"/>
  <g class="iui-arm">
    <path d="M47 48 q8 -2 10 -9" fill="none" stroke="#3a414b" stroke-width="2.4" stroke-linecap="round"/>
    <circle cx="57" cy="39" r="2.6" fill="#fdfdfe" stroke="#3a414b" stroke-width="1.6"/>
  </g>
</svg>`;

// ---- the bubble content -----------------------------------------------------------

function bubbleHtml() {
  const intro =
    tier === "drc"
      ? `<b>Introspection mode.</b> I can read my own source code here too — ask how
         I'm built, or name a file like <code>src/pipeline.js</code>.
         <p id="iui-note" class="private">🔒 You're on the secure tier: every model call
         already goes straight from this browser on <i>your</i> key — the private choice
         by default.</p>
         <p class="iui-dim" style="margin:.35rem 0 0">☁ Remote server models are a
         DeepResearch.<b>Se<span class="sl">/</span>rver</b> feature — they run on this site's server.</p>`
      : `<b>Introspection mode.</b> I can read my own source code — ask how I'm built,
         or name a file like <code>src/pipeline.js</code>.
         <label for="iui-model">Who answers?</label>
         <select id="iui-model"></select>
         <p id="iui-note"></p>
         <div id="iui-keys"></div>`;
  return `<button type="button" class="iui-x" aria-label="Dismiss">✕</button>${intro}`;
}

// The route explanation under the select — the line that actually carries the
// private-vs-remote understanding (option styling is unreliable on mobile).
function renderNote() {
  const note = document.getElementById("iui-note");
  if (!note) return;
  const route = privateIntrospectionRoute();
  if (route) {
    note.className = "private";
    note.textContent = `🔒 Private: your question goes straight from this browser to ${route.label} on your key — this site's server never sees it.`;
  } else {
    note.className = "remote";
    note.textContent =
      "☁ Remote: answers run through this site's server pipeline and are handled per its normal rules. Add your own API key below for the private route.";
  }
  onRouteChangeCb();
}

function renderKeysRow() {
  const host = document.getElementById("iui-keys");
  if (!host) return;
  const keys = storedKeys();
  const saved = DRC_PROVIDERS.filter((p) => keys[p.id]);
  const managed = saved
    .map((p) => `<span>${p.label} key saved</span><button type="button" data-rm="${p.id}">remove</button>`)
    .join(" ");
  host.innerHTML = `
    ${saved.length ? `<div class="iui-managed">${managed}</div>` : ""}
    <div class="iui-keyrow">
      <input id="iui-key" type="password" autocomplete="off"
             placeholder="sk-… (OpenAI) · gsk_… (Groq) · sk_ber_… (Berget)" aria-label="Provider API key">
      <button type="button" id="iui-savekey">Save</button>
    </div>
    <p class="iui-dim" style="margin:.3rem 0 0">Stored only in this browser; used only for
    browser-direct calls to the provider — never sent to this site's server.</p>`;
  host.querySelector("#iui-savekey").addEventListener("click", async () => {
    const input = host.querySelector("#iui-key");
    const key = (input.value || "").trim();
    // detectDrcProvider returns the ENTRY, not an id — store under .id
    // (passing the object through stringified it to "[object Object]",
    // so keys saved here were never found again).
    const detected = detectDrcProvider(key);
    if (!key || !detected) {
      input.setCustomValidity(foreignDrcKeyHint(key) || "Unrecognized key prefix");
      input.reportValidity?.();
      return;
    }
    saveStoredKey(detected.id, key);
    input.value = "";
    await renderPicker(true); // new private group appears; auto-pick it
  });
  for (const btn of host.querySelectorAll("[data-rm]")) {
    btn.addEventListener("click", async () => {
      saveStoredKey(btn.dataset.rm, "");
      if (privateIntrospectionRoute() === null) saveChoice("");
      await renderPicker(false);
    });
  }
}

// Build the select from the pure grouping: private (recommended) first,
// remote clearly badged. `adopt` picks the recommended private option when
// the user hasn't chosen (or just added their first key) — the obvious choice.
async function renderPicker(adopt) {
  const sel = document.getElementById("iui-model");
  if (!sel) return;
  const keys = storedKeys();
  const privateProviders = [];
  for (const p of DRC_PROVIDERS) {
    if (!keys[p.id]) continue;
    // Static fallback first for an instant list; the live catalog replaces it
    // on the next render if it loads (listDrcModels falls back internally).
    let models = [...p.fallbackModels];
    try {
      models = await listDrcModels(p, keys[p.id]);
    } catch { /* fallback list stands */ }
    privateProviders.push({ id: p.id, label: p.label, models });
  }
  const { groups, recommended } = groupIntrospectionModels(privateProviders, serverModels);
  const current = storedChoice();
  sel.innerHTML = "";
  const def = document.createElement("option");
  def.value = "";
  def.textContent = "☁ Server default — the composer's model (remote)";
  sel.appendChild(def);
  for (const g of groups) {
    const og = document.createElement("optgroup");
    og.label = g.label;
    og.dataset.kind = g.kind;
    for (const o of g.options) {
      const opt = document.createElement("option");
      opt.value = o.value;
      opt.textContent = o.label;
      if (o.disabled) opt.disabled = true;
      og.appendChild(opt);
    }
    sel.appendChild(og);
  }
  const wanted = adopt && recommended ? recommended : current;
  if (wanted && [...sel.options].some((o) => o.value === wanted && !o.disabled)) sel.value = wanted;
  else sel.value = current && [...sel.options].some((o) => o.value === current) ? current : "";
  if (sel.value !== current) saveChoice(sel.value);
  renderNote();
  renderKeysRow();
}

// ---- show / dismiss ----------------------------------------------------------------

async function showMascot() {
  ensureStyles();
  shownThisLoad = true;
  if (!mascotEl) {
    mascotEl = document.createElement("div");
    mascotEl.id = "iui-mascot";
    if (tier === "drc") mascotEl.className = "drc";
    mascotEl.innerHTML = ROBOT_SVG;
    document.body.appendChild(mascotEl);
    bubbleEl = document.createElement("div");
    bubbleEl.id = "iui-bubble";
    bubbleEl.hidden = true;
    document.body.appendChild(bubbleEl);
  }
  mascotEl.hidden = false;
  mascotEl.classList.remove("bye");
  visible = true;

  bubbleEl.innerHTML = bubbleHtml();
  bubbleEl.querySelector(".iui-x").addEventListener("click", dismissMascot);
  if (tier === "drs") {
    // Remote catalog (authed, same-origin) — fail-soft to an empty group.
    try {
      const res = await fetch("/api/models");
      serverModels = res.ok ? (await res.json()).models || [] : serverModels;
    } catch { /* keep whatever we had */ }
    await renderPicker(!storedChoice());
    document.getElementById("iui-model")?.addEventListener("change", (e) => {
      saveChoice(e.target.value);
      renderNote();
    });
  }

  // Slide in, then settle into the calm bob and pop the bubble beneath.
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      mascotEl.style.transform = "translateX(14px)";
    });
  });
  const settle = () => {
    mascotEl.classList.add("settled");
    bubbleEl.hidden = false;
    bubbleEl.style.top = mascotEl.getBoundingClientRect().bottom + 8 + "px";
    requestAnimationFrame(() => bubbleEl.classList.add("show"));
  };
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) settle();
  else {
    let done = false;
    mascotEl.addEventListener("transitionend", function h() {
      if (done) return;
      done = true;
      mascotEl.removeEventListener("transitionend", h);
      settle();
    });
    setTimeout(() => {
      if (!done) {
        done = true;
        settle();
      }
    }, 2800);
  }
  // Outside interactions wave TIN goodbye (the landing-mascot convention);
  // the bubble itself stays interactive.
  setTimeout(() => {
    document.addEventListener("pointerdown", onOutside, true);
  }, 400);
}

function onOutside(e) {
  if (!visible) return;
  if (bubbleEl.contains(e.target) || mascotEl.contains(e.target)) return;
  dismissMascot();
}

export function dismissMascot() {
  if (!visible) return;
  visible = false;
  dismissedAt = Date.now();
  document.removeEventListener("pointerdown", onOutside, true);
  bubbleEl.classList.remove("show");
  mascotEl.classList.add("bye");
  setTimeout(() => {
    bubbleEl.hidden = true;
    mascotEl.hidden = true;
    mascotEl.classList.remove("settled");
    mascotEl.style.transform = "translateX(-110px)";
  }, 450);
}
