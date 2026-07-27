// Model dropdown: catalog from /api/models, the pick recorded on the SESSION
// (session.js) with the legacy `model` localStorage key kept as the device SEED —
// what a brand-new tab opens on. Before 2026-07-27 the pick was browser-global,
// so reloading one tab adopted whatever model another tab had last chosen. If the catalog can't load, the dropdown stays hidden and
// the server default applies. Models the provider reports as down render
// disabled and become selectable again when they come back. Each option is
// flag-prefixed with its provider's country of processing (data goes where
// the provider resides — Berget/EU vs the US providers).
//
// With the on-device knob on (ondevice-drs.js), a "📱 On-device" group lists
// the Bonsai models already downloaded to THIS device — only those; picking
// a model must never trigger a download. Their option values carry the
// "ondevice::" prefix (ondevice-core.js), which the send path (stream.js)
// reads as "run this exchange in the browser, never /api/chat". When only
// on-device models exist (server catalog unreachable — say, offline), the
// dropdown still shows: that is exactly the situation the tier is for.

import { labelWithFlag, regionForModelEntry } from "./provider-region.js";
import { cachedOnDeviceModels, onDeviceEnabled } from "./ondevice-drs.js";
import { sessionConfig, setSessionConfig } from "./session.js";

let sel;
let onChange = () => {};
let knownModels = []; // /api/models entries, for vision capability lookup
let onDeviceEntries = []; // downloaded on-device models ({id,label,value,cachedBytes})
let serverDefault = "";

/**
 * Record a model pick: the SESSION (what this tab sends with) plus the device
 * seed (what a new tab opens on). Fail-soft on the seed — private mode must not
 * break the dropdown.
 * @param {string} id
 */
function rememberModel(id) {
  setSessionConfig({ model: id });
  try {
    localStorage.setItem("model", id);
  } catch {
    /* the session copy is what the send reads anyway */
  }
}

export function initModels(selectEl, opts = {}) {
  sel = selectEl;
  onChange = opts.onChange || onChange;
  sel.addEventListener("change", () => {
    rememberModel(sel.value);
    onChange();
  });
  loadModels();
}

/**
 * The catalog entry for the current selection (undefined until loaded, and
 * undefined for an on-device pick — those are text-only, so vision gating
 * treats them like any non-vision model).
 * @returns {object|undefined} /api/models entry ({id, name, vision, up, pricing})
 */
export function currentModel() {
  return knownModels.find((m) => m.id === sel.value);
}

/**
 * The id to send with /api/chat — empty while the dropdown is hidden
 * (catalog unavailable), letting the server default apply. An on-device
 * pick rides through as its "ondevice::" value; stream.js routes it
 * browser-local before any request is built.
 * @returns {string}
 */
export function selectedModelId() {
  return !sel.hidden && sel.value ? sel.value : "";
}

/**
 * A usable vision-capable model, for the "switch to attach images?" offer.
 * @returns {object|undefined}
 */
export function visionFallback() {
  return knownModels.find((m) => m.vision && m.up !== false);
}

/**
 * Programmatic selection (loading a saved conversation, the vision-switch
 * offer) — persists and fires onChange like a user pick.
 * @param {string} id
 */
export function selectModel(id) {
  sel.value = id;
  rememberModel(id);
  onChange();
}

/**
 * Re-fetch the whole server catalog. Called after a model is enabled or
 * disabled in the Models agent's lifecycle board (public/js/models-panel.js):
 * enabling is precisely what puts a model in THIS dropdown, so the promotion
 * has to be visible without a reload — that is the pipeline the Models agent
 * advertises.
 */
export async function reloadModels() {
  if (!sel) return;
  await loadModels();
}

/**
 * Re-list the on-device group (the Settings section calls this after a
 * download or delete) — the rest of the dropdown, and the current selection
 * where it survives, stay as they are.
 */
export async function refreshOnDeviceModels() {
  if (!sel) return;
  try {
    onDeviceEntries = await cachedOnDeviceModels();
  } catch {
    onDeviceEntries = [];
  }
  render();
}

async function loadModels() {
  try {
    const res = await fetch("/api/models");
    if (res.ok) {
      const data = await res.json();
      knownModels = data.models || [];
      serverDefault = data.default || "";
    }
  } catch { /* catalog unavailable — an on-device group may still render */ }
  // The engine listing only runs with the knob on (the lazy contract), and
  // any failure just leaves the group off this render.
  try {
    onDeviceEntries = onDeviceEnabled() ? await cachedOnDeviceModels() : [];
  } catch {
    onDeviceEntries = [];
  }
  render();
}

function render() {
  if (!knownModels.length && !onDeviceEntries.length) {
    sel.hidden = true;
    return;
  }
  const previous = sel.hidden ? "" : sel.value;
  sel.replaceChildren();
  if (onDeviceEntries.length) {
    const og = document.createElement("optgroup");
    og.label = "📱 On-device — runs in this browser";
    for (const m of onDeviceEntries) {
      const opt = document.createElement("option");
      opt.value = m.value;
      opt.textContent = m.label;
      opt.title = "Runs on this device — your question is not sent to any AI provider or to this site's research pipeline.";
      og.appendChild(opt);
    }
    sel.appendChild(og);
  }
  // Server models group only when the on-device group shares the dropdown;
  // alone they stay flat, exactly as before the feature existed.
  const serverHost = onDeviceEntries.length && knownModels.length
    ? sel.appendChild(Object.assign(document.createElement("optgroup"), { label: "☁ Server models" }))
    : sel;
  // The models this account ENABLED out of an open provider catalog get their
  // own group. They are catalog entries like any other — same pricing, same
  // routing — but they arrived by a decision the user made in the Models
  // agent, and grouping them is what makes that promotion legible here.
  // Keyed on the provider slug rather than on a name, so a second open
  // marketplace joins the same group without a change here.
  const OPEN_PROVIDERS = new Set(["huggingface"]);
  const hfModels = knownModels.filter((m) => OPEN_PROVIDERS.has(m.provider));
  const rest = knownModels.filter((m) => !OPEN_PROVIDERS.has(m.provider));
  const addOption = (host, m) => {
    const opt = document.createElement("option");
    opt.value = m.id;
    const region = regionForModelEntry(m);
    const base = m.up === false ? m.name + " (unavailable)" : m.name;
    opt.textContent = labelWithFlag(region ? region.flag : "", base);
    if (m.up === false) opt.disabled = true;
    opt.title = [m.pricing, region ? "Processed in " + region.country : ""]
      .filter(Boolean).join(" · ");
    host.appendChild(opt);
  };
  for (const m of rest) addOption(serverHost, m);
  if (hfModels.length) {
    const og = document.createElement("optgroup");
    og.label = "⚖ Enabled by you";
    for (const m of hfModels) addOption(og, m);
    sel.appendChild(og);
  }
  const selectable = (id) => [...sel.options].some((o) => o.value === id && !o.disabled);
  // This SESSION's model first, the device seed second: a reload restores what
  // THIS tab was using, and only a brand-new session falls back to the seed.
  const saved = sessionConfig().model || (() => {
    try {
      return localStorage.getItem("model");
    } catch {
      return null;
    }
  })();
  // Never auto-default to on-device: without an explicit pick the server
  // default applies, so nobody lands on a phone-speed model by surprise.
  const pick = saved && selectable(saved) ? saved
    : serverDefault && selectable(serverDefault) ? serverDefault
    : ([...sel.options].find((o) => !o.disabled) || sel.options[0]).value;
  sel.value = previous && selectable(previous) ? previous : pick;
  sel.hidden = false;
  onChange();
}
