// @ts-check
// The EXECUTION ENVIRONMENT chooser's Se/rver-side glue — the execution
// counterpart of ondevice-drs.js (which owns the on-device MODEL choice). Same
// question, different axis: the model dropdown already lets a user say "run the
// thinking here, not in the cloud"; this lets them say "run the COMMANDS on my
// machine, not in the browser emulator".
//
// The shared pure core is public/js/exec-backends-core.js (the DREE/1 client,
// also used by Se/cure through drc.js). This module owns only the DRS pieces:
// the browser-local config, the account panel's Settings section, and the
// runner the send path hands to the shell pass.
//
// WHY localStorage AND NOT /api/settings — the same reasoning as the on-device
// knob, and it matters more here. A runner lives at `http://localhost:8100` on
// ONE machine. An account-wide setting would point this user's phone at a
// service that exists only on their laptop, and every send from the phone would
// probe a dead address. "Where can I execute" is a per-device fact, so it is
// stored per device. It also means the runner's URL and key never reach the
// server — which is the honest posture for a setting whose entire purpose is
// that commands and their output stay on the user's own machine.
//
// The knob is inert until configured: with no local runner set up, selectRunner
// hands back the browser VM bridge untouched and every sandbox path is
// byte-identical to before this module existed.

import {
  DEFAULT_RUNNER_URL,
  EXEC_BACKENDS,
  normalizeExecBackend,
  probeRunner,
  runnerStatusLine,
  usesLocalRunner,
} from "./exec-backends-core.js";

const CFG_KEY = "dr_exec_env";

// ---- the browser-local config ------------------------------------------------

/**
 * This device's execution-environment choice, normalized. Defaults to the
 * in-browser VM — including when storage is unavailable (private mode), which
 * is the safe direction: the tier's original behavior.
 * @returns {{backend: string, baseUrl: string, key: string}}
 */
export function execEnvCfg() {
  try {
    return normalizeExecBackend(JSON.parse(localStorage.getItem(CFG_KEY) || "null"));
  } catch {
    return normalizeExecBackend(null);
  }
}

/**
 * Persist this device's choice. Fail-soft: blocked storage means the setting
 * doesn't stick, never that the panel throws.
 * @param {{backend?: string, baseUrl?: string, key?: string}} cfg
 * @returns {{backend: string, baseUrl: string, key: string}} what was stored
 */
export function setExecEnvCfg(cfg) {
  const clean = normalizeExecBackend(cfg);
  try {
    localStorage.setItem(CFG_KEY, JSON.stringify(clean));
  } catch {
    /* storage blocked — the choice just won't persist past this page */
  }
  return clean;
}

/** Whether this device is set up to run commands on a local runner. */
export function localRunnerActive() {
  return usesLocalRunner(execEnvCfg());
}

// ---- the Settings section ----------------------------------------------------
//
// Rendered by account-settings.js inside the gear panel. Markup mirrors the
// panel's settingRow shape (settings-item / settings-row / setting-pop) so the
// row lines up with its neighbours; the ⓘ popover is wired by the panel's own
// wireSettingPopovers pass. It follows the execution-sandbox knob's group,
// because it answers that knob's next question: enabled — but running where?

const EXEC_INFO = `<strong>Execution environment</strong><br>
  Chooses <b>where</b> the assistant's shell commands run when the execution
  sandbox is on.<br>
  <b>In-browser Linux VM</b> (default) boots a real Linux inside this page. It
  never leaves your device, but it is an emulator: slow to start, slow to run,
  one fixed image, and it cannot see the machine you are sitting at.<br>
  <b>Local runner</b> points at a small service you start on your own computer.
  Each research session gets a <b>throwaway container</b> — native speed, any
  image and toolchain you like, and your own files if you mount them. This
  browser calls it directly on <code>localhost</code>: no command, no output and
  no file passes through this site's server, and the runner prints every command
  it runs so you can watch.<br>
  <b>Per device.</b> A runner exists on one machine, so this setting is stored in
  <b>this browser</b> only — it is never sent to the server and doesn't follow
  your account to your phone.<br>
  <b>Setup:</b> one line to start it —
  <a href="/cure/local-exec/" target="_blank" rel="noopener">the setup page</a>
  has the recipes for macOS, Linux and Windows, plus the DREE/1 wire if you would
  rather point at your own.`;

/** The section markup account-settings.js drops into the panel. */
export function execEnvSettingsMarkup() {
  const cfg = execEnvCfg();
  const options = EXEC_BACKENDS.map(
    (b) => `<option value="${b.id}"${b.id === cfg.backend ? " selected" : ""}>${b.label}</option>`,
  ).join("");
  return `
    <div class="settings-item" id="execenvrow">
      <div class="settings-row">
        <span class="settings-label">Execution environment <span class="exp-badge">Experimental</span>
          <button type="button" class="setting-info" data-pop="execenvpop" aria-label="More about “Execution environment”">ⓘ</button>
        </span>
      </div>
      <div class="setting-pop" id="execenvpop" hidden>${EXEC_INFO}</div>
      <label class="setting-note" style="display:block;margin-top:.4rem">Where shell commands run
        <select id="execenvsel" style="width:100%;margin-top:.2rem">${options}</select>
      </label>
      <div id="execenvdirect"${cfg.backend === "local" ? "" : " hidden"} style="margin-top:.4rem;display:flex;flex-direction:column;gap:.4rem">
        <label class="setting-note">Runner URL
          <input id="execenvurl" type="url" placeholder="${DEFAULT_RUNNER_URL}" value="${escapeAttr(cfg.baseUrl)}" style="width:100%;margin-top:.2rem"></label>
        <label class="setting-note">API key <span class="muted">(optional)</span>
          <input id="execenvkey" type="password" autocomplete="off" placeholder="only if your runner needs one" value="${escapeAttr(cfg.key)}" style="width:100%;margin-top:.2rem"></label>
        <button type="button" id="execenvtest" style="align-self:flex-start">Test connection</button>
      </div>
      <p id="execenvstatus" class="muted setting-note"></p>
    </div>`;
}

/**
 * Values go into an HTML attribute — a URL or key must never break out of it.
 * @param {string} s
 */
function escapeAttr(s) {
  return String(s || "").replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * The idle status line: what this device will actually do on the next send.
 * Deliberately concrete — "which environment ran my command" is the first
 * question when an answer looks wrong.
 * @param {{backend: string, baseUrl: string, key: string}} cfg
 * @returns {string}
 */
export function execEnvStatusText(cfg) {
  if (cfg.backend !== "local") {
    return "Commands run in the Linux VM inside this browser.";
  }
  return cfg.baseUrl
    ? "Commands will run on your machine, through " + cfg.baseUrl + ". Press Test connection to check it."
    : "Enter your runner's URL — until then, commands keep running in this browser.";
}

/** Wires the section: the picker, the two fields, and the connection test. */
export function wireExecEnvSettings() {
  const sel = /** @type {HTMLSelectElement | null} */ (document.getElementById("execenvsel"));
  if (!sel) return;
  const direct = document.getElementById("execenvdirect");
  const urlEl = /** @type {HTMLInputElement | null} */ (document.getElementById("execenvurl"));
  const keyEl = /** @type {HTMLInputElement | null} */ (document.getElementById("execenvkey"));
  const status = document.getElementById("execenvstatus");
  const testBtn = document.getElementById("execenvtest");

  const show = (/** @type {string} */ text) => {
    if (!status) return;
    status.hidden = false;
    status.textContent = text;
  };

  const persist = () => {
    const cfg = setExecEnvCfg({ backend: sel.value, baseUrl: urlEl?.value, key: keyEl?.value });
    if (direct) direct.hidden = cfg.backend !== "local";
    // Write the fields back from the NORMALIZED config, so a pasted URL with a
    // trailing slash visibly becomes the one that will actually be called.
    if (urlEl) urlEl.value = cfg.baseUrl;
    show(execEnvStatusText(cfg));
    return cfg;
  };

  sel.addEventListener("change", persist);
  urlEl?.addEventListener("change", persist);
  keyEl?.addEventListener("change", persist);
  // "Test connection" answers the one question the user has — is anything
  // there? — and names the cause when not (runner down / CORS / Safari's
  // mixed-content block), which a bare "Failed to fetch" never does.
  testBtn?.addEventListener("click", async () => {
    const cfg = persist();
    if (!cfg.baseUrl) return;
    show("Checking " + cfg.baseUrl + " …");
    show(runnerStatusLine(await probeRunner(cfg)));
  });
  show(execEnvStatusText(execEnvCfg()));
}
