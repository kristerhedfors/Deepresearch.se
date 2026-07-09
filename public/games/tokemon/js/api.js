// Thin fetch wrappers for /api/tokemon/* — every call returns the parsed
// JSON body; non-2xx throws an Error carrying the server's message so the
// UI can toast it verbatim.

async function call(path, opts) {
  const res = await fetch(`/api/tokemon/${path}`, opts);
  let body = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (!res.ok) {
    const err = new Error(body?.error || `HTTP ${res.status}`);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

const post = (path, payload) =>
  call(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload ?? {}),
  });

export const getState = () => call("state");
export const chooseStarter = (starter) => post("starter", { starter });
export const getSpawns = (lat, lng) => call(`spawns?lat=${lat.toFixed(6)}&lng=${lng.toFixed(6)}`);
export const encounter = (spawnId, lat, lng) => post("encounter", { spawnId, lat, lng });
export const collect = (spawnId, lat, lng) => post("collect", { spawnId, lat, lng });
export const battleAction = (action) => post("battle", { action });
export const heal = () => post("heal");
export const party = (payload) => post("party", payload);
