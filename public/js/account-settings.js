// The account panel's "settings" view — the cloud-storage / Shodan / Google
// Maps knobs, each disabled (with a note) when the server can't back it.
// Built from account-views.js's shared settingRow/wireSettingPopovers
// building blocks; the panel shell (showView) lives in account.js. The
// summary's Feedback-mode and execution-sandbox knobs are NOT here — they sit
// directly on the summary (account-views.js).

import { settingRow, wireSettingPopovers } from "./account-views.js";
import { loadSettings, setGoogleMaps, setServerHistory, setShodanMcp } from "./settings.js";
import { syncToClient, syncToServer } from "./sync.js";

/** @typedef {import("./account.js").PanelCtx} PanelCtx */

// ---- setting-knob info popover texts ----------------------------------------

const CLOUD_INFO = `<strong>Store history in the cloud</strong><br>
  <b>On (default):</b> conversations, attached files and the document index are
  kept in this site's Cloudflare storage, so your history follows your account
  across devices. Conversations <b>and</b> attached files (images included) stay
  <b>encrypted</b> with the same key mechanism they have in this browser; the
  readable exceptions are what's indexed for search — large documents, project
  files and notes, and chats inside a project (indexed so the project's other
  chats can draw on them) — plus the search index itself, since retrieval
  needs readable text.<br>
  <b>Off:</b> everything lives only in this browser — switching off downloads it
  all here and deletes the cloud copies.`;

const SHODAN_INFO = `<strong>Shodan host intelligence (MCP)</strong><br>
  <b>On:</b> when a question mentions an IP address or hostname, the site looks it
  up on <a href="https://www.shodan.io" target="_blank" rel="noopener">Shodan</a>
  and adds what it finds — open ports, running services, organization/ASN,
  hosting location and known CVEs — to the research so the answer can use and
  cite it.<br>
  <b>Off (default):</b> nothing is sent to Shodan.<br>
  <b>Privacy:</b> only the IP/hostname itself is sent to Shodan — never your
  question or anything about your account. It runs only when your message
  actually names a host, and independently of the web-search switch.`;

const GOOGLEMAPS_INFO = `<strong>Google Maps &amp; Street View</strong><br>
  <b>On:</b> when your message names a street address (or you attach a photo
  with GPS location), the site looks it up on Google
  <a href="https://developers.google.com/maps" target="_blank" rel="noopener">Maps
  Platform</a> — resolving it with the Places API (name, address, type,
  rating), confirming Street View coverage and its capture date, and pulling
  a road map — then adds those details and clickable Maps/Street View links
  to the research, handing the Street View and map images to a vision-capable
  model to describe.<br>
  <b>Off (default):</b> nothing is sent to Google.<br>
  <b>Privacy:</b> only the address itself (or a photo's coordinates) is sent
  to Google — never your whole question or anything about your account. It
  runs only when your message names an address or you attach a located photo,
  and independently of the web-search switch.`;

/**
 * Fetches fresh settings and renders the Settings sub-view: the
 * cloud-storage, Shodan, and Google Maps knobs, each disabled (with a
 * note) when the server can't back it.
 * @param {PanelCtx} ctx
 */
export async function loadSettingsView(ctx) {
  ctx.body.innerHTML = `
    <button id="settingsbackbtn" type="button" class="back-link">← Back</button>
    <p class="section-lbl">Settings</p>
    <p class="muted">Loading…</p>`;
  document.getElementById("settingsbackbtn").addEventListener("click", () => ctx.show("summary"));

  let s = null;
  if (ctx.me?.email) {
    try {
      s = await loadSettings(true); // fresh — another device may have flipped it
    } catch {
      s = null;
    }
  }
  const usable = !!s?.available?.storage;
  const shodanUsable = !!s?.available?.shodan;
  const googleMapsUsable = !!s?.available?.google_maps;
  const note = !ctx.me?.email
    ? "Settings need a signed-in account (break-glass sessions have none)."
    : s === null
      ? "Could not load settings — try again in a moment."
      : "";
  const cloudNote = usable
    ? ""
    : `<p class="muted setting-note">Cloud storage isn't configured on this server, so history stays in this browser only.</p>`;
  const shodanNote = shodanUsable
    ? ""
    : `<p class="muted setting-note">Shodan isn't configured on this server (no API key), so this stays off.</p>`;
  const googleMapsNote = googleMapsUsable
    ? ""
    : `<p class="muted setting-note">Google Maps isn't configured on this server (no Google Maps API key), so this stays off.</p>`;

  ctx.body.innerHTML = `
    <button id="settingsbackbtn" type="button" class="back-link">← Back</button>
    <p class="section-lbl">Settings</p>
    ${settingRow({
      id: "cloudknob",
      label: "Store history in the cloud",
      checked: usable && s?.server_history,
      disabled: !usable,
      popId: "cloudpop",
      info: CLOUD_INFO,
    })}
    ${cloudNote}
    <p id="syncstatus" class="muted setting-note" hidden></p>
    ${settingRow({
      id: "shodanknob",
      label: "Shodan host intelligence",
      checked: shodanUsable && s?.shodan_mcp,
      disabled: !shodanUsable,
      popId: "shodanpop",
      info: SHODAN_INFO,
    })}
    ${shodanNote}
    <p id="shodanstatus" class="muted setting-note" hidden></p>
    ${settingRow({
      id: "gmapsknob",
      label: "Google Maps & Street View",
      checked: googleMapsUsable && s?.google_maps,
      disabled: !googleMapsUsable,
      popId: "gmapspop",
      info: GOOGLEMAPS_INFO,
    })}
    ${googleMapsNote}
    <p id="gmapsstatus" class="muted setting-note" hidden></p>
    ${note ? `<p class="muted setting-note">${note}</p>` : ""}`;
  document.getElementById("settingsbackbtn").addEventListener("click", () => ctx.show("summary"));
  wireSettingPopovers(ctx.body);

  if (usable) wireCloudStorageKnob();
  if (shodanUsable) {
    wireSimpleKnob("shodanknob", "shodanstatus", setShodanMcp, {
      on: "Shodan is on — IPs and hostnames you mention are looked up during research.",
      off: "Shodan is off — nothing is sent to Shodan.",
    });
  }
  if (googleMapsUsable) {
    wireSimpleKnob("gmapsknob", "gmapsstatus", setGoogleMaps, {
      on: "Google Maps is on — addresses you mention (and located photos) are looked up on Google Maps & Street View.",
      off: "Google Maps is off — nothing is sent to Google.",
    });
  }
}

// The cloud knob is the one setting whose flip triggers a bulk move
// (sync.js): ON pushes everything local up, OFF drains everything down and
// wipes the cloud — the status line narrates progress and the outcome.
function wireCloudStorageKnob() {
  const knob = document.getElementById("cloudknob");
  const status = document.getElementById("syncstatus");
  const progress = (msg) => { status.textContent = msg; };
  knob.addEventListener("change", async () => {
    const on = knob.checked;
    knob.disabled = true;
    status.hidden = false;
    try {
      await setServerHistory(on);
      if (on) {
        const r = await syncToServer(progress);
        status.textContent =
          `Cloud storage is on — ${r.pushed} item(s) uploaded.` +
          (r.errors.length ? ` ${r.errors.length} item(s) failed and will retry on the next sync.` : "");
      } else {
        const r = await syncToClient(progress);
        status.textContent = r.wiped
          ? r.checked
            ? `Cloud storage is off — all ${r.checked} cloud item(s) are in this browser` +
              ` (${r.pulled} newly downloaded, the rest were already here); cloud copies removed.`
            : "Cloud storage is off — the cloud held nothing to download; cloud copies removed."
          : "Downloaded what was reachable, but some items failed — the cloud copies were kept. Toggle again to retry.";
      }
    } catch (err) {
      knob.checked = !on; // the setting didn't change server-side
      status.textContent = err?.message || "Could not update the setting.";
    } finally {
      knob.disabled = false;
    }
  });
}

/**
 * Wires a settings knob whose flip is a single /api/settings write (the
 * Shodan and Google Maps rows): optimistic toggle, status text on the
 * outcome, revert on failure.
 * @param {string} knobId    checkbox element id
 * @param {string} statusId  status <p> element id
 * @param {(on: boolean) => Promise<any>} setter  settings.js write
 * @param {{on: string, off: string}} texts  status line per new state
 */
function wireSimpleKnob(knobId, statusId, setter, texts) {
  const knob = document.getElementById(knobId);
  const status = document.getElementById(statusId);
  knob.addEventListener("change", async () => {
    const on = knob.checked;
    knob.disabled = true;
    status.hidden = false;
    try {
      await setter(on);
      status.textContent = on ? texts.on : texts.off;
    } catch (err) {
      knob.checked = !on;
      status.textContent = err?.message || "Could not update the setting.";
    } finally {
      knob.disabled = false;
    }
  });
}
