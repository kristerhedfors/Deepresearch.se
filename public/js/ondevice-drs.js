// The ON-DEVICE inference tier's Se/rver-side glue (2026-07-24): the same
// phone-local Bonsai engine Se/cure ships (ondevice-engine.js — see
// docs/BONSAI-27B-PHONE-INFERENCE.md) surfaced in the signed-in app. This
// module owns the DRS pieces DRC keeps inside drc.js: the browser-local
// enable knob, the account panel's Settings section (download with the
// exact-size consent, cancel/resume, delete, capability verdicts), and the
// cached-model listing the composer dropdown (models.js) renders.
//
// The knob is deliberately localStorage, NOT /api/settings: the weights live
// in THIS device's OPFS, so "on-device models here" is a per-device fact —
// an account-wide flag would light up dropdown groups on devices that hold
// no weights. Same LAZY contract as everywhere else this feature appears:
// with the knob off nothing here imports the engine, and no download ever
// starts outside the explicit size-labeled consent button (UX-4 — dismissal
// is a NO).
//
// What a send does with a pick from this group lives in stream.js
// (runOnDeviceExchange): the whole exchange runs the client-side pipeline
// (drc-research.js) against the in-browser engine — /api/chat is never
// called for it.

import { onDeviceModel, onDeviceOptionValue } from "./ondevice-core.js";
import { isolateForSandbox } from "./sandbox-mode.js";

const KNOB_KEY = "dr_ondevice";

// ---- the knob ---------------------------------------------------------------

export function onDeviceEnabled() {
  try {
    return localStorage.getItem(KNOB_KEY) === "1";
  } catch {
    return false;
  }
}

/**
 * Persist the knob. It lives in localStorage (per-device — the weights are in
 * THIS device's OPFS), AND is mirrored into a `dr_ondevice` cookie so the SERVER
 * serves the /rver shell cross-origin isolated for this device: the engine's
 * ONNX runtime spawns pthread workers that need SharedArrayBuffer, exactly like
 * the sandbox (src/assets.js onDeviceIsolationWanted). Both writes fail soft.
 * @param {boolean} on
 */
export function setOnDeviceEnabled(on) {
  try {
    localStorage.setItem(KNOB_KEY, on ? "1" : "0");
  } catch {
    /* storage blocked — the knob just won't persist */
  }
  try {
    document.cookie = on
      ? "dr_ondevice=1; path=/; max-age=31536000; SameSite=Lax"
      : "dr_ondevice=; path=/; max-age=0; SameSite=Lax";
  } catch {
    /* no document/cookie here — the knob still works, just not isolation */
  }
}

// ---- lazy engine ------------------------------------------------------------

let engineModule = null;

/** The engine façade (ondevice-engine.js), imported on first use only. */
export async function loadOnDeviceEngine() {
  if (!engineModule) engineModule = await import("/js/ondevice-engine.js");
  return engineModule;
}

/** The catalog label for a model id (falls back to the id itself). @param {string} id */
export function onDeviceModelLabel(id) {
  return onDeviceModel(id)?.label || id;
}

/**
 * The models the composer dropdown may list: ONLY weights already on this
 * device (picking a model must never trigger a multi-GB surprise download —
 * downloads live in Settings behind the consent). [] with the knob off, and
 * [] fail-soft when the engine can't answer.
 * @returns {Promise<Array<{id: string, label: string, value: string, cachedBytes: number}>>}
 */
export async function cachedOnDeviceModels() {
  if (!onDeviceEnabled()) return [];
  try {
    const eng = await loadOnDeviceEngine();
    return (await eng.listCachedModels())
      .filter((c) => c.cachedBytes)
      .map((c) => ({
        id: c.id,
        label: onDeviceModelLabel(c.id),
        value: onDeviceOptionValue(c.id),
        cachedBytes: c.cachedBytes,
      }));
  } catch {
    return []; // engine unavailable — the dropdown just goes without the group
  }
}

// ---- the Settings section -----------------------------------------------------
//
// Rendered by account-settings.js inside the gear panel. Markup mirrors the
// panel's settingRow shape (settings-item / settings-row / switch) so the row
// lines up with its neighbours; the info popover is wired by the panel's own
// wireSettingPopovers pass. The per-model rows are the drc.js on-device
// section's states, DRS-shaped: Download (consent inline, exact live size in
// the button) / Cancel / Delete / "isn't published yet" / the self-explaining
// capability verdict.

const ONDEVICE_INFO = `<strong>On-device models (Bonsai)</strong><br>
  Runs a 1-bit Bonsai model <b>inside this browser</b> on WebGPU. When you pick
  one in the composer's model dropdown, the whole exchange — planning,
  drafting, review — runs on this device: your question is never sent to any
  AI provider, and this site's server pipeline isn't involved in answering
  (so those chats also never appear in the server's interaction log).<br>
  <b>What still applies:</b> your conversation history is saved under this
  tier's normal rules (encrypted, in the cloud), so it follows your account.
  Live web search and the server-side integrations (Shodan, Google Maps,
  document retrieval) don't run in this mode — the model answers from what it
  knows plus the text you attach.<br>
  <b>The download:</b> one time per model, straight from huggingface.co to
  this device's private browser storage — delete it here any time. Expect
  phone-speed answers: the first token can take a minute while the model
  compiles.`;

/** The section markup account-settings.js drops into the panel. */
export function onDeviceSettingsMarkup() {
  const checked = onDeviceEnabled() ? " checked" : "";
  return `
    <div class="settings-item">
      <div class="settings-row">
        <span class="settings-label">On-device models (Bonsai) <span class="exp-badge">Experimental</span>
          <button type="button" class="setting-info" data-pop="odpop" aria-label="More about “On-device models (Bonsai)”">ⓘ</button>
        </span>
        <label class="switch">
          <input type="checkbox" id="odknob"${checked}>
          <span class="switch-track"><span class="switch-thumb"></span></span>
        </label>
      </div>
      <div class="setting-pop" id="odpop" hidden>${ONDEVICE_INFO}</div>
    </div>
    <div id="odrows" hidden></div>
    <p id="odstatus" class="muted setting-note" hidden></p>`;
}

const odDownloading = new Set(); // modelIds with a download in flight (UI state)
// modelId → the last download failure, shown IN the model's row (the
// 2026-07-17 Se/cure iPhone lesson: a status line elsewhere reads as
// "nothing happened"). Cleared on the next attempt.
const odErrors = new Map();

/**
 * Wires the section: the knob reveal, and the per-model rows' full state
 * machine. `onModelsChanged` fires after a completed download or delete so
 * the composer dropdown can refresh its on-device group.
 * @param {{onModelsChanged?: () => void}} [opts]
 */
export function wireOnDeviceSettings(opts = {}) {
  const knob = /** @type {HTMLInputElement | null} */ (document.getElementById("odknob"));
  if (!knob) return;
  const modelsChanged = () => {
    try {
      opts.onModelsChanged?.();
    } catch {
      /* the dropdown refresh must never break the panel */
    }
  };
  knob.addEventListener("change", () => {
    setOnDeviceEnabled(knob.checked);
    if (knob.checked) {
      // The engine needs a cross-origin-isolated page (SharedArrayBuffer for the
      // ONNX pthread workers). setOnDeviceEnabled set the cookie that makes the
      // SERVER send COEP; reload into the isolated shell so it applies this
      // session too — mirrors the sandbox knob (account-views.js wireSandboxKnob).
      // A no-op when the page is already isolated (e.g. the sandbox is also on),
      // in which case just show the model rows.
      if (!globalThis.crossOriginIsolated) {
        setStatus("On-device enabled — reloading so the model engine can run…");
        setTimeout(() => {
          if (!isolateForSandbox(true, { resetGuard: true })) renderRows(modelsChanged).catch(() => {});
        }, 500);
        return;
      }
      renderRows(modelsChanged).catch(() => {});
      return;
    }
    renderRows(modelsChanged).catch(() => {});
    modelsChanged(); // the dropdown group hides with the knob
  });
  renderRows(modelsChanged).catch(() => {});
}

async function renderRows(modelsChanged) {
  const wrap = document.getElementById("odrows");
  const status = document.getElementById("odstatus");
  if (!wrap) return;
  const on = onDeviceEnabled();
  wrap.hidden = !on;
  if (status) status.hidden = true;
  if (!on) {
    wrap.innerHTML = "";
    return;
  }
  if (!wrap.childElementCount) wrap.innerHTML = '<p class="muted setting-note">Checking this device…</p>';
  try {
    const eng = await loadOnDeviceEngine();
    const probe = await eng.probeOnDevice();
    const cached = await eng.listCachedModels();
    if (!document.getElementById("odrows")) return; // the panel view changed mid-check
    wrap.innerHTML = "";
    for (const m of eng.ONDEVICE_MODELS) {
      const entry = cached.find((c) => c.id === m.id);
      const verdict = eng.capabilityVerdict(probe, m);
      wrap.appendChild(modelRow(eng, m, entry, verdict, modelsChanged));
    }
  } catch (err) {
    // The engine's deadline errors NAME the failing stage — show them
    // verbatim (textContent: the message can carry a worker error string).
    wrap.innerHTML = '<p class="muted setting-note"></p>';
    wrap.firstElementChild.textContent =
      /** @type {{message?: string}} */ (err)?.message || "The on-device engine failed to load — try reloading the page.";
  }
}

/** One model's row: label + state note + its single action button. */
function modelRow(eng, m, entry, verdict, modelsChanged) {
  const row = document.createElement("div");
  row.className = "settings-item";
  row.dataset.od = m.id;
  const inner = document.createElement("div");
  inner.className = "settings-row";
  const label = document.createElement("span");
  label.className = "settings-label";
  label.textContent = m.label;
  const btn = document.createElement("button");
  btn.type = "button";
  const note = document.createElement("p");
  note.className = "muted setting-note od-note";
  if (odDownloading.has(m.id)) {
    note.textContent = "Downloading…";
    btn.textContent = "Cancel";
    btn.onclick = async () => (await loadOnDeviceEngine()).cancelDownload(m.id);
  } else if (entry?.cachedBytes) {
    note.textContent = "On this device · " + eng.fmtBytes(entry.cachedBytes) + " — pick it in the composer's model dropdown.";
    btn.textContent = "Delete";
    btn.onclick = async () => {
      btn.disabled = true;
      // A failed delete must not strand a disabled button — re-render either
      // way; the row then shows the model's true current state.
      await (await loadOnDeviceEngine()).deleteModel(m.id).catch(() => {});
      modelsChanged();
      await renderRows(modelsChanged);
    };
  } else if (verdict.verdict === "unsupported") {
    note.textContent = verdict.reason;
    btn.hidden = true;
  } else {
    const fail = odErrors.get(m.id);
    note.textContent = fail
      ? fail
      : "~" + eng.fmtBytes(m.approxBytes) + " one-time download" + (verdict.verdict === "marginal" ? " — " + verdict.reason : "");
    btn.textContent = fail ? "Retry download…" : "Download…";
    btn.onclick = () => openConsent(m, row, modelsChanged).catch(() => {});
  }
  inner.append(label, btn);
  row.append(inner, note);
  return row;
}

// The consent step, inline in the row (the panel has no modal layer): states
// the EXACT one-time size from the repo's live file listing — never the
// catalog guess — plus free space and a cellular warning, and downloads ONLY
// from the size-labeled button. "Not now" (or navigating away) is a NO.
async function openConsent(m, row, modelsChanged) {
  const eng = await loadOnDeviceEngine();
  const note = row.querySelector(".od-note");
  const btn = row.querySelector("button");
  if (!note || !btn) return;
  btn.disabled = true;
  note.textContent = "Checking the exact size…";
  const plan = await eng
    .planModelDownload(m.id)
    .catch((err) => ({ published: false, reason: "engine", message: err?.message || "" }));
  btn.disabled = false;
  if (!row.isConnected) return; // the panel view changed while the listing loaded
  if (!plan?.published || !plan.totalBytes) {
    // Three different truths, three messages: "not published" is about the
    // model, "couldn't reach" about the connection, an engine failure about
    // this device (its text names the failing stage).
    note.textContent =
      plan?.reason === "network"
        ? "Couldn't reach huggingface.co to compute the download size — check your connection and try again. Nothing was downloaded."
        : plan?.reason === "engine"
          ? (plan.message || "The on-device engine failed.") + " Nothing was downloaded."
          : m.label + "'s browser build isn't published yet — this entry lights up the moment onnx-community ships it. Nothing was downloaded.";
    return;
  }
  const size = eng.fmtBytes(plan.totalBytes);
  let freeLine = "";
  try {
    const est = await navigator.storage.estimate();
    if (est?.quota) freeLine = " Free space here: ~" + eng.fmtBytes(Math.max(0, est.quota - (est.usage || 0))) + ".";
  } catch {
    /* estimate unavailable — the line is optional */
  }
  const cellular = /** @type {any} */ (navigator).connection?.type === "cellular";
  note.textContent =
    "This downloads the model ONCE (" + size + ") and stores it only on this device — delete it any time here." +
    freeLine +
    (cellular ? " You appear to be on CELLULAR data — Wi-Fi is strongly recommended." : " Wi-Fi recommended.") +
    " Once downloaded, the model itself answers with no network at all.";
  const actions = document.createElement("span");
  const yes = document.createElement("button");
  yes.type = "button";
  yes.textContent = "Download " + size;
  const no = document.createElement("button");
  no.type = "button";
  no.textContent = "Not now";
  actions.append(yes, document.createTextNode(" "), no);
  btn.replaceWith(actions);
  no.onclick = () => renderRows(modelsChanged).catch(() => {});
  yes.onclick = () => runDownload(m, modelsChanged).catch(() => {});
}

// The download itself (post-consent): worker-side fetch → streaming SHA-256
// → OPFS, resumable — a cancel or lost connection keeps the verified bytes
// and the next Download continues where it stopped.
async function runDownload(m, modelsChanged) {
  const eng = await loadOnDeviceEngine();
  odErrors.delete(m.id);
  odDownloading.add(m.id);
  await renderRows(modelsChanged);
  let sawBytes = false;
  try {
    await eng.downloadModel(m.id, (p) => {
      sawBytes = sawBytes || p.loaded > 0;
      const el = document.querySelector('[data-od="' + m.id + '"] .od-note');
      if (el) el.textContent = "Downloading… " + p.pct + "% · " + eng.fmtBytes(p.loaded) + " of " + eng.fmtBytes(p.total);
    });
    setStatus(m.label + " is on this device — pick it in the composer's model dropdown. Questions you ask it never leave this browser.");
    modelsChanged();
  } catch (err) {
    const raw = /** @type {{message?: string}} */ (err)?.message || "The download failed.";
    if (/cancel|abort/i.test(raw)) {
      // A user-initiated stop is not a failure — say what the Cancel kept.
      setStatus("Download stopped — verified parts are kept; Download again to resume.");
    } else {
      // The resume hint is true only once some bytes actually landed.
      odErrors.set(m.id, raw + (sawBytes ? " Already-verified parts are kept — Download again to resume." : ""));
    }
  } finally {
    odDownloading.delete(m.id);
    await renderRows(modelsChanged);
  }
}

function setStatus(text) {
  const status = document.getElementById("odstatus");
  if (!status) return;
  status.hidden = false;
  status.textContent = text;
}
