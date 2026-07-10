// @ts-check
// Per-account settings (GET/PUT /api/settings — src/settings.js): the
// server_history (cloud storage), shodan_mcp (Shodan host-intel),
// google_maps, and feedback_mode knobs. The cached copy answers the
// hot-path question every storage-touching module asks — "is cloud storage
// on?" — without a fetch per call; the answer only ever changes through
// updateSetting below (this tab) or on the next page load (another tab or
// device flipped it — an accepted, self-healing staleness window: the
// server rejects writes that its own copy of the knob forbids).

/**
 * The server's effective-settings response: the per-user knobs plus which
 * server-side capabilities exist at all (secrets/bindings present).
 * @typedef {object} Settings
 * @property {boolean} [server_history]
 * @property {boolean} [shodan_mcp]
 * @property {boolean} [google_maps]
 * @property {boolean} [feedback_mode]
 * @property {string} [maps_embed_key]
 * @property {{storage?: boolean, rag?: boolean, shodan?: boolean, google_maps?: boolean, feedback?: boolean}} [available]
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
// backend choice). False until loadSettings has resolved — the safe
// default: local-only behavior.
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
export function setServerHistory(on) {
  return updateSetting({ server_history: on });
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
