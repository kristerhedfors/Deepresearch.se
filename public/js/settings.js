// Per-account settings (GET/PUT /api/settings — src/settings.js). Knobs
// today: server_history (cloud storage), shodan_mcp (Shodan host-intel
// enrichment), and the three Google Maps photo-feature knobs (street_view,
// nearby_places, map_context). The cached copy answers the hot-path question every
// storage-touching module asks — "is cloud storage on?" — without a fetch
// per call; the answer only ever changes through updateSetting below (this
// tab) or on the next page load (another tab or device flipped it — an
// accepted, self-healing staleness window: the server rejects writes that
// its own copy of the knob forbids).

let settings = null; // {server_history, shodan_mcp, street_view, nearby_places, map_context, available:{storage, rag, shodan, maps}}
let loadPromise = null;

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

// Generic partial update: PUT any subset of the knobs, refresh the cache
// from the server's authoritative (effective) response. Exported for the
// account panel's per-row handlers (the named setters below stay for the
// call sites that predate it).
export async function setSettings(patch) {
  return updateSetting(patch);
}

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

export function setServerHistory(on) {
  return updateSetting({ server_history: on });
}

export function setShodanMcp(on) {
  return updateSetting({ shodan_mcp: on });
}
