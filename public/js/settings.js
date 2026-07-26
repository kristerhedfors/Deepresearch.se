// @ts-check
// Per-account settings (GET/PUT /api/settings — src/settings.js): the
// shodan_mcp (Shodan host-intel), google_maps and bash_lite_mcp knobs, plus the
// account's picked `chat_mode` (the one non-boolean setting — it replaced the
// developer_mode knob in 2026-07-26's mode collapse). Feedback is NOT a knob
// (given from the chat — a message opening with "feedback" is routed to the
// feedback pipeline).
// Cloud storage is NOT a knob
// (2026-07-16 owner directive): on this signed-in tier history is always
// cloud-stored whenever the server can store it — the cached
// `available.storage` answers the hot-path question every storage-touching
// module asks ("does the cloud copy exist here?", storageAvailable below)
// without a fetch per call. Knob changes go through updateSetting below
// (this tab) or the next page load (another tab or device flipped one — an
// accepted, self-healing staleness window: the server rejects writes that
// its own copy of a knob forbids).

/**
 * The server's effective-settings response: the per-user knobs plus which
 * server-side capabilities exist at all (secrets/bindings present).
 * @typedef {object} Settings
 * @property {boolean} [shodan_mcp]
 * @property {boolean} [google_maps]
 * @property {boolean} [bash_lite_mcp]
 * @property {string} [chat_mode]
 * @property {string} [maps_embed_key]
 * @property {{storage?: boolean, rag?: boolean, shodan?: boolean, google_maps?: boolean, bash_lite?: boolean, developer?: boolean, exec_container?: boolean}} [available]
 */

/** @type {Settings | null} */
let settings = null;
/** @type {Promise<Settings> | null} */
let loadPromise = null;

/**
 * Fetch (or reuse the in-flight/cached fetch of) the account settings.
 * @param {boolean} [force] drop the cache and refetch
 * @returns {Promise<Settings>}
 */
export function loadSettings(force = false) {
  if (force) loadPromise = null;
  if (!loadPromise) {
    loadPromise = fetch("/api/settings")
      .then((res) => {
        if (!res.ok) throw new Error("settings unavailable");
        return res.json();
      })
      .then((data) => {
        settings = data;
        return data;
      })
      .catch((err) => {
        loadPromise = null; // retry on the next call instead of caching the failure
        throw err;
      });
  }
  return loadPromise;
}

// Whether /api/settings has actually answered this page load. Lets UI
// distinguish "the knob is off" from "we never learned the knob's state"
// (auth or network failure) — the two need opposite user guidance.
export function settingsLoaded() {
  return settings !== null;
}

// Synchronous view for hot paths (persist-after-every-turn, retrieval
// backend choice): whether this server holds the implicit cloud copy at
// all (R2 binding + a signed-in account). False until loadSettings has
// resolved — the safe default: local-only behavior until we know.
export function storageAvailable() {
  return settings?.available?.storage === true;
}

export function serverRagAvailable() {
  return settings?.available?.rag === true;
}

// Shodan host-intelligence enrichment knob (default off; needs the server's
// SHODAN_API_KEY, so it reads unavailable when the server has no key).
export function shodanOn() {
  return settings?.shodan_mcp === true;
}

export function shodanAvailable() {
  return settings?.available?.shodan === true;
}

// Google Maps enrichment knob (Places + Street View + Static Maps; default
// off; needs the server's GOOGLE_MAPS_API_KEY, so it reads unavailable when
// the server has no key).
export function googleMapsOn() {
  return settings?.google_maps === true;
}

export function googleMapsAvailable() {
  return settings?.available?.google_maps === true;
}

// Browser key for the interactive Street View embed iframe (public by design —
// referrer-locked, Embed-API-only). Empty string when not configured; the
// stream renderer then skips the inline embed and the keyless link stands.
export function mapsEmbedKey() {
  return settings?.maps_embed_key || "";
}

/**
 * Generic partial update: PUT one or more knobs, refresh the cache from the
 * server's authoritative (effective) response.
 * @param {Partial<Settings>} patch
 * @returns {Promise<Settings>}
 */
async function updateSetting(patch) {
  const res = await fetch("/api/settings", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error || "Could not update the setting.");
  settings = data;
  loadPromise = Promise.resolve(data);
  return data;
}

/** @param {boolean} on */
export function setShodanMcp(on) {
  return updateSetting({ shodan_mcp: on });
}

/** @param {boolean} on */
export function setGoogleMaps(on) {
  return updateSetting({ google_maps: on });
}

// The experimental bash-lite execution sandbox knob (default off; needs only
// a signed-in account — the sandbox is a pure browser capability). While on,
// a message that "wants a shell" (src/bash-agent.js bashIntent) boots an
// in-browser Linux VM (CheerpX) and runs an agentic command loop whose
// transcript feeds the answer. The app shell is served cross-origin-isolated
// (COEP) when this is on so SharedArrayBuffer is available — set at page load,
// so flipping this knob only takes full effect on the next reload.
export function bashLiteOn() {
  return settings?.bash_lite_mcp === true;
}

// The account's stored chat mode — the authoritative copy of the pick, which is
// why it follows the account across devices. chat-mode.js holds the
// localStorage CACHE of it for first paint; this is the value that replaces the
// cache once /api/settings resolves. Empty string until then (callers should
// read chat-mode.js cachedChatMode for a synchronous answer).
export function serverChatMode() {
  return typeof settings?.chat_mode === "string" ? settings.chat_mode : "";
}

// Whether the non-default chat modes (Introspection, Agent Studio, Orchestrator,
// Outrospection, Models) are available to this account at all — true for any
// signed-in account and the break-glass operator. Availability, not a per-account
// opt-in: there is nothing to switch on any more, only a mode to pick.
export function chatModesAvailable() {
  return settings?.available?.developer === true;
}

/**
 * Persist the picked chat mode. Replaced setDeveloperMode (2026-07-26): the mode
 * IS the setting now, rather than a boolean the dropdown had to keep in step.
 * @param {string} mode
 */
export function setChatMode(mode) {
  return updateSetting({ chat_mode: mode });
}

export function bashLiteAvailable() {
  return settings?.available?.bash_lite === true;
}

// Whether this deploy can run the sandbox's commands SERVER-SIDE, in an
// ephemeral Cloudflare container (src/exec-container.js) — the third execution
// environment, offered in the Settings picker next to the in-browser VM and a
// local runner. False unless the optional container binding exists on this
// deploy, so the option is simply absent from an unconfigured one (the same
// hide-when-unavailable discipline as the key-gated extension knobs). Se/rver
// only: it puts the server in the command path, which Se/cure does not allow.
export function execContainerAvailable() {
  return settings?.available?.exec_container === true;
}

/** @param {boolean} on */
export function setBashLiteMcp(on) {
  return updateSetting({ bash_lite_mcp: on });
}
