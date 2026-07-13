// @ts-check
// Per-account settings (GET/PUT /api/settings — src/settings.js): the
// shodan_mcp (Shodan host-intel), google_maps, feedback_mode, bash_lite_mcp,
// and developer_mode knobs. Cloud storage is NOT a knob — Se/rver always
// stores in the cloud (Se/cure is the client-side tier) — so `server_history`
// is a read-only availability signal here, answering the hot-path question
// every storage-touching module asks: "should I dual-write to the cloud?"
// (yes whenever the server can back it). The cached copy answers without a
// fetch per call; it only changes through updateSetting below (this tab) or
// on the next page load.

/**
 * The server's effective-settings response: the per-user knobs plus which
 * server-side capabilities exist at all (secrets/bindings present).
 * @typedef {object} Settings
 * @property {boolean} [server_history]
 * @property {boolean} [shodan_mcp]
 * @property {boolean} [google_maps]
 * @property {boolean} [feedback_mode]
 * @property {boolean} [bash_lite_mcp]
 * @property {boolean} [developer_mode]
 * @property {string} [maps_embed_key]
 * @property {{storage?: boolean, rag?: boolean, shodan?: boolean, google_maps?: boolean, feedback?: boolean, bash_lite?: boolean, developer?: boolean}} [available]
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

// Synchronous view for hot paths (persist-after-every-turn, retrieval
// backend choice): is cloud storage active for this account? Cloud storage
// is always on when the server can back it (no user knob) — this is that
// availability signal. False until loadSettings has resolved and false when
// the server can't store (break-glass, no R2 binding) — the safe default:
// browser-only behavior.
export function serverHistoryOn() {
  return settings?.server_history === true;
}

// Whether /api/settings has actually answered this page load. Lets UI
// distinguish "the knob is off" from "we never learned the knob's state"
// (auth or network failure) — the two need opposite user guidance.
export function settingsLoaded() {
  return settings !== null;
}

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

// Feedback mode knob (default off; needs the server's D1 database and a
// signed-in account). While on, every assistant reply — existing ones
// included — shows a Feedback button (turns.js; visibility toggled via the
// body's `feedback-mode` class, see applyFeedbackMode in account.js/app.js).
export function feedbackModeOn() {
  return settings?.feedback_mode === true;
}

export function feedbackAvailable() {
  return settings?.available?.feedback === true;
}

/** @param {boolean} on */
export function setFeedbackMode(on) {
  return updateSetting({ feedback_mode: on });
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

// Developer-mode knob (default off; needs only a signed-in account). While
// on, conversations that ask about this site's own implementation enter
// INTROSPECTION MODE: the server appends the deployed source snapshot as
// context (src/introspect.js), and — when the sandbox knob is also on — the
// client mounts the source tree at /src in the in-browser Linux VM
// (public/js/introspect-core.js is the shared gate/plan logic).
export function developerModeOn() {
  return settings?.developer_mode === true;
}

export function developerModeAvailable() {
  return settings?.available?.developer === true;
}

/** @param {boolean} on */
export function setDeveloperMode(on) {
  return updateSetting({ developer_mode: on });
}

export function bashLiteAvailable() {
  return settings?.available?.bash_lite === true;
}

/** @param {boolean} on */
export function setBashLiteMcp(on) {
  return updateSetting({ bash_lite_mcp: on });
}
