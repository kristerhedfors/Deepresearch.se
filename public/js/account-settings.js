// The account panel's "settings" view — ALL configuration in one place
// (2026-07-11 directive; also opened straight from the header's gear
// icon): the Shodan / Google Maps knobs, each disabled (with a note) when
// the server can't back it, plus the Feedback-mode and execution-sandbox
// knobs (rows + wiring from account-views.js), and — first — the
// cloud-storage DISCLOSURE row: cloud storage is implicit on Se/rver
// (2026-07-16 owner directive, no per-account opt-out), so the row informs
// instead of switching; the tier without cloud storage is Se/cure. Built from
// account-views.js's shared settingRow / wireSettingPopovers building blocks;
// the panel shell (showView) lives in account.js.

import { renderConfigKnobs, settingRow, wireDeveloperKnob, wireFeedbackKnob, wireSandboxKnob, wireSettingPopovers } from "./account-views.js";
import { loadSettings, setGoogleMaps, setShodanMcp } from "./settings.js";
import { openBundle } from "./proxy-bundle.js";
import { buildWorkspacePayload, generateWorkspacePassword, sealWorkspace, workspaceLink } from "./workspace-core.js";

/** @typedef {import("./account.js").PanelCtx} PanelCtx */

// ---- setting-knob info popover texts ----------------------------------------

const CLOUD_INFO = `<strong>History is stored in the cloud</strong><br>
  On this signed-in tier, conversations, projects, attached files and the
  document index are <b>always</b> kept in this site's Cloudflare storage —
  there is no switch — so your history follows your account across devices.
  Conversations <b>and</b> attached files (images included) stay
  <b>encrypted</b> with the same key mechanism they have in this browser; the
  readable exceptions are what's indexed for search — large documents, project
  files and notes, and chats inside a project (indexed so the project's other
  chats can draw on them) — plus the search index itself, since retrieval
  needs readable text.<br>
  For work that must never rest on a server at all, use
  DeepResearch.<b>Se<span class="sl">/</span>cure</b> (the ghost button) —
  there the server is in no data path and everything stays in your
  browser.`;

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
 * Fetches fresh settings and renders the Settings sub-view: the cloud
 * storage disclosure row (always on — informational, not a switch), then
 * the Shodan and Google Maps knobs, each disabled (with a note) when the
 * server can't back it.
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
  const cloudRow = `
    <div class="settings-item" id="cloudrow">
      <div class="settings-row">
        <span class="settings-label">History is stored in the cloud
          <button type="button" class="setting-info" data-pop="cloudpop" aria-label="More about “History is stored in the cloud”">ⓘ</button>
        </span>
        <span class="muted">${usable ? "always on" : "unavailable"}</span>
      </div>
      <div class="setting-pop" id="cloudpop" hidden>${CLOUD_INFO}</div>
    </div>
    ${usable ? "" : `<p class="muted setting-note">Cloud storage isn't configured on this server, so history stays in this browser only.</p>`}`;
  const shodanNote = shodanUsable
    ? ""
    : `<p class="muted setting-note">Shodan isn't configured on this server (no API key), so this stays off.</p>`;
  const googleMapsNote = googleMapsUsable
    ? ""
    : `<p class="muted setting-note">Google Maps isn't configured on this server (no Google Maps API key), so this stays off.</p>`;

  ctx.body.innerHTML = `
    <button id="settingsbackbtn" type="button" class="back-link">← Back</button>
    <p class="section-lbl">Settings</p>
    ${cloudRow}
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
    ${renderConfigKnobs(ctx.me)}
    ${workspaceShareSection(!!ctx.me?.email)}
    ${note ? `<p class="muted setting-note">${note}</p>` : ""}`;
  document.getElementById("settingsbackbtn").addEventListener("click", () => ctx.show("summary"));
  wireSettingPopovers(ctx.body);
  wireFeedbackKnob(ctx);
  wireSandboxKnob(ctx);
  wireDeveloperKnob(ctx);
  if (ctx.me?.email) wireWorkspaceShare();

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

// ---- the secure-workspace share (Se/cure workspaces, minted from Se/rver) ----
//
// Packages this account's TEMPORARY, QUOTA-BOUND grants (the ghost-crossover
// web-search grant + secure-research-space bundle — the same allowances the
// ghost button lends) into ONE OFFLINE Se/cure workspace link:
// /cure/workspace#w=<ciphertext>. The sealing happens ENTIRELY in this
// browser (public/js/workspace-core.js — the hacka.re-cloned mechanism): the
// server mints the grant tokens through the two existing authed endpoints
// and never sees the password or the assembled link. The minter keeps
// control afterwards: each embedded token's quota can be raised, lowered,
// paused, or revoked (POST /api/websearch/adjust, /api/proxy/adjust — or the
// admin panel) while the link itself never changes.

const WORKSPACE_INFO = `<strong>Share a Se/cure workspace</strong><br>
  Creates a <b>single offline link</b> to a ready-to-use
  <b>Se/cure</b> session carrying a bounded allowance from YOUR account:
  a few server web searches and LLM calls (the same temporary grants the
  ghost button lends you). Everything is <b>encrypted into the link's
  #anchor</b> — browsers never send that part to any server — and the
  password travels separately, so the link alone reveals nothing. You stay
  in control: the allowances are quota-metered per token, and you can add
  or remove quota (or revoke) at any time without changing the link.`;

/** @param {boolean} signedIn */
function workspaceShareSection(signedIn) {
  if (!signedIn) return "";
  return `
    <div class="settings-item" id="wsprow">
      <div class="settings-row">
        <span class="settings-label">Share a Se<span class="sl">/</span>cure workspace
          <button type="button" class="setting-info" data-pop="wsppop" aria-label="More about secure workspaces">ⓘ</button>
        </span>
        <button type="button" id="wspcreate">Create link</button>
      </div>
      <div class="setting-pop" id="wsppop" hidden>${WORKSPACE_INFO}</div>
      <p id="wspstatus" class="muted setting-note" hidden></p>
      <div id="wspresult" hidden>
        <textarea id="wsplink" readonly rows="3" style="width:100%;font-size:.72rem;word-break:break-all"></textarea>
        <div class="row" style="display:flex;gap:.5rem;flex-wrap:wrap">
          <button type="button" id="wspcopylink">Copy link</button>
          <button type="button" id="wspcopypass">Copy password</button>
        </div>
        <p class="muted setting-note" id="wsppassnote"></p>
      </div>
    </div>`;
}

function wireWorkspaceShare() {
  const btn = document.getElementById("wspcreate");
  const status = document.getElementById("wspstatus");
  if (!btn) return;
  let password = "";
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    status.hidden = false;
    status.textContent = "Minting your temporary grants…";
    try {
      // 1. The two existing authed mints (both reuse-per-user; each fail-soft —
      //    a workspace with only one allowance is still a workspace).
      const post = (path) =>
        fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })
          .then((r) => (r.ok ? r.json() : null))
          .catch(() => null);
      const [ws, bundle] = await Promise.all([post("/api/websearch/grant"), post("/api/proxy/grant")]);
      // The proxy bundle's GRANT tokens ride sealed in its blob — open it
      // locally with the key that came alongside (never sent anywhere).
      let proxy = [];
      if (bundle?.blob && bundle?.key) {
        const opened = await openBundle(bundle.blob, bundle.key).catch(() => null);
        if (opened && Array.isArray(opened.grants)) {
          proxy = opened.grants.filter((g) => g && (g.svc === "web" || g.svc === "api") && typeof g.token === "string");
        }
      }
      const grants = { ws: ws?.token || null, proxy };
      if (!grants.ws && !proxy.length) {
        status.textContent = "No grants available right now (the feature may be disabled) — nothing to share.";
        return;
      }
      // 2. Seal + link, entirely in this browser.
      status.textContent = "Sealing the workspace…";
      const payload = buildWorkspacePayload({}, { grants, settings: false, name: "Borrowed research space" });
      password = generateWorkspacePassword();
      const blob = await sealWorkspace(payload, password);
      const link = workspaceLink(location.origin, blob);
      document.getElementById("wsplink").value = link;
      document.getElementById("wsppassnote").textContent =
        `Password: ${password} — share it through a DIFFERENT channel than the link. ` +
        "The allowance is your account's temporary quota; adjust or revoke it any time (the link stays the same).";
      document.getElementById("wspresult").hidden = false;
      status.textContent = "Workspace link ready.";
    } catch (err) {
      status.textContent = err?.message || "Could not create the workspace link.";
    } finally {
      btn.disabled = false;
    }
  });
  document.getElementById("wspcopylink")?.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(document.getElementById("wsplink").value);
      document.getElementById("wspcopylink").textContent = "Copied ✓";
    } catch {
      document.getElementById("wspcopylink").textContent = "Select and copy manually";
    }
  });
  document.getElementById("wspcopypass")?.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(password);
      document.getElementById("wspcopypass").textContent = "Copied ✓";
    } catch {
      document.getElementById("wspcopypass").textContent = "Copy manually";
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
