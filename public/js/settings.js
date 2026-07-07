// Per-account settings (GET/PUT /api/settings — src/settings.js). One knob
// today: server_history, default OFF. The cached copy answers the hot-path
// question every storage-touching module asks — "is cloud storage on?" —
// without a fetch per call; the answer only ever changes through
// setServerHistory below (this tab) or on the next page load (another tab
// or device flipped it — an accepted, self-healing staleness window: the
// server rejects writes that its own copy of the knob forbids).

let settings = null; // {server_history, street_view, nearby_places, map_context, available:{storage, rag, maps}}
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

// Generic partial update: patch is any subset of the known knobs, e.g.
// {street_view: false}. The server echoes the full effective state back.
export async function setSettings(patch) {
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

export async function setServerHistory(on) {
  return setSettings({ server_history: on });
}
