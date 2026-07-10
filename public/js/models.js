// Model dropdown: catalog from /api/models, selection persisted in
// localStorage. If the catalog can't load, the dropdown stays hidden and
// the server default applies. Models the provider reports as down render
// disabled and become selectable again when they come back.

let sel;
let onChange = () => {};
let knownModels = []; // /api/models entries, for vision capability lookup

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
 * The catalog entry for the current selection (undefined until loaded).
 * @returns {object|undefined} /api/models entry ({id, name, vision, up, pricing})
 */
export function currentModel() {
  return knownModels.find((m) => m.id === sel.value);
}

/**
 * The id to send with /api/chat — empty while the dropdown is hidden
 * (catalog unavailable), letting the server default apply.
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

async function loadModels() {
  try {
    const res = await fetch("/api/models");
    if (!res.ok) return;
    const data = await res.json();
    const models = data.models || [];
    if (models.length === 0) return;
    knownModels = models;
    sel.replaceChildren();
    for (const m of models) {
      const opt = document.createElement("option");
      opt.value = m.id;
      opt.textContent = m.up === false ? m.name + " (unavailable)" : m.name;
      if (m.up === false) opt.disabled = true;
      if (m.pricing) opt.title = m.pricing;
      sel.appendChild(opt);
    }
    const usable = (m) => m.up !== false;
    const saved = localStorage.getItem("model");
    const pick = models.some((m) => m.id === saved && usable(m)) ? saved
      : models.some((m) => m.id === data.default && usable(m)) ? data.default
      : (models.find(usable) || models[0]).id;
    sel.value = pick;
    sel.hidden = false;
    onChange();
  } catch { /* keep dropdown hidden; server default applies */ }
}
