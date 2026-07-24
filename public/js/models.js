// Model dropdown: catalog from /api/models, selection persisted in
// localStorage. If the catalog can't load, the dropdown stays hidden and
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

let sel;
let onChange = () => {};
let knownModels = []; // /api/models entries, for vision capability lookup
let onDeviceEntries = []; // downloaded on-device models ({id,label,value,cachedBytes})
let serverDefault = "";

export function initModels(selectEl, opts = {}) {
  sel = selectEl;
  onChange = opts.onChange || onChange;
  sel.addEventListener("change", () => {
    localStorage.setItem("model", sel.value);
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
  localStorage.setItem("model", id);
  onChange();
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
  for (const m of knownModels) {
    const opt = document.createElement("option");
    opt.value = m.id;
    const region = regionForModelEntry(m);
    const base = m.up === false ? m.name + " (unavailable)" : m.name;
    opt.textContent = labelWithFlag(region ? region.flag : "", base);
    if (m.up === false) opt.disabled = true;
    opt.title = [m.pricing, region ? "Processed in " + region.country : ""]
      .filter(Boolean).join(" · ");
    serverHost.appendChild(opt);
  }
  const selectable = (id) => [...sel.options].some((o) => o.value === id && !o.disabled);
  const saved = localStorage.getItem("model");
  // Never auto-default to on-device: without an explicit pick the server
  // default applies, so nobody lands on a phone-speed model by surprise.
  const pick = saved && selectable(saved) ? saved
    : serverDefault && selectable(serverDefault) ? serverDefault
    : ([...sel.options].find((o) => !o.disabled) || sel.options[0]).value;
  sel.value = previous && selectable(previous) ? previous : pick;
  sel.hidden = false;
  onChange();
}
