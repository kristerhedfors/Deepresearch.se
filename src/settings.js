// Per-user settings (users.settings_json, additive D1 column) — currently a
// single knob: `server_history`, default ON (a product decision made as the
// feature shipped: cloud history is the normal mode, switching it OFF is
// the explicit per-account opt-out).
//
// OFF is the original local-only posture: conversations live only in the
// browser's encrypted IndexedDB, attached files in its OPFS, the RAG index
// in its IndexedDB — nothing conversation-derived is stored server-side.
//
// ON is Cloudflare-side storage
// (src/storage.js + src/rag.js): conversation records are stored in R2
// STILL ENCRYPTED with the same client-held AES-GCM key mechanism (the
// server stores ciphertext it cannot read without also deriving the key —
// the same combination-required threat model as src/history-key.js
// documents), attached original files land in R2 as-is, and the document
// RAG index lives in Vectorize + R2. Files and the RAG index are
// necessarily NOT encrypted (the server must read file bytes and chunk
// text to index and retrieve) — that asymmetry is deliberate and disclosed
// in the UI, not hidden.
//
// The knob itself is remembered server-side so it follows the account, and
// flipping it drives a client-side sync in each direction
// (public/js/sync.js): on → push everything up (and keep lazy local
// copies); off → pull everything down, then the client wipes the
// server-side copies.

import { getDb } from "./db.js";
import { jsonResponse } from "./http.js";
import { shodanAvailable } from "./shodan.js";
import { googleMapsAvailable } from "./googlemaps.js";

// Three knobs today:
//  - server_history: default ON  (only an explicit stored `false` opts out).
//  - shodan_mcp:     default OFF (opt-in — enriching a query with Shodan
//    sends the host/IP to a third party, so it stays off until asked for;
//    only an explicit stored `true` enables it).
//  - google_maps:    default OFF (opt-in — a named address / photo location is
//    sent to Google Maps Platform (Places + Street View + Static Maps) and the
//    imagery fetches are billed, so it stays off until asked for; only an
//    explicit stored `true` enables it).
const DEFAULTS = { server_history: true, shodan_mcp: false, google_maps: false };

// Tolerant parse of a stored settings_json value: unknown keys are dropped,
// known keys are coerced to their expected type, anything unreadable means
// defaults. server_history is on unless an explicit stored `false` says
// otherwise; shodan_mcp and google_maps are off unless an explicit stored
// `true` enables them (their opposite defaults are why each tests against its
// own literal). Exported for unit tests.
export function parseSettings(json) {
  let raw = {};
  try {
    const parsed = typeof json === "string" ? JSON.parse(json) : json;
    if (parsed && typeof parsed === "object") raw = parsed;
  } catch {
    raw = {};
  }
  return {
    server_history: raw.server_history !== false,
    shodan_mcp: raw.shodan_mcp === true,
    google_maps: raw.google_maps === true,
  };
}

// What the server can actually offer this identity right now. `storage`
// needs the R2 binding plus a D1 user row to hang the setting on (the
// break-glass identity has neither a row nor a personal history to sync);
// `rag` additionally needs the Vectorize binding for server-side retrieval.
export function storageAvailability(env, identity) {
  const storage = !!(env.STORAGE && identity.user);
  return { storage, rag: !!(storage && env.RAG_INDEX) };
}

// The full availability map reported to the client: storage/rag plus the
// Shodan and Google Maps features. Each third-party feature needs its secret
// (SHODAN_API_KEY / GOOGLE_MAPS_API_KEY) and — like every per-user setting —
// a D1 user row to persist the knob against (break-glass has none). Kept
// separate from storageAvailability so that function's tested shape stays
// stable.
export function featureAvailability(env, identity) {
  return {
    ...storageAvailability(env, identity),
    shodan: !!(shodanAvailable(env) && identity.user),
    google_maps: !!(googleMapsAvailable(env) && identity.user),
  };
}

export function getSettings(identity) {
  if (!identity?.user) return { ...DEFAULTS };
  return parseSettings(identity.user.settings_json);
}

// Convenience for gating the storage/RAG endpoints: the caller's current
// server_history state, availability included (a knob left on in D1 after
// the R2 binding was removed must read as off).
export function serverHistoryEnabled(env, identity) {
  return storageAvailability(env, identity).storage && getSettings(identity).server_history;
}

// The effective Shodan-MCP state for a request: the knob must be on AND the
// server must actually be able to run it (SHODAN_API_KEY set, real user
// row). A knob left on in D1 after the secret was removed reads as off, so
// the pipeline never attempts a lookup it can't perform.
export function shodanEnabled(env, identity) {
  return featureAvailability(env, identity).shodan && getSettings(identity).shodan_mcp;
}

// The effective Google Maps state for a request: the knob on AND the server
// able to run it (GOOGLE_MAPS_API_KEY set, real user row). A knob left on in
// D1 after the secret was removed reads as off.
export function googleMapsEnabled(env, identity) {
  return featureAvailability(env, identity).google_maps && getSettings(identity).google_maps;
}

async function saveSettings(env, userId, settings) {
  const db = await getDb(env);
  if (!db) throw new Error("Database not configured.");
  await db
    .prepare("UPDATE users SET settings_json = ? WHERE id = ?")
    .bind(JSON.stringify(settings), userId)
    .run();
}

// The payload reports the EFFECTIVE state, not the raw stored flags: with
// the default ON for server_history, an identity that can't actually use
// cloud storage (break-glass, or a server without the R2 binding) must read
// as off — otherwise every such client would dutifully dual-write into
// 503s. shodan_mcp is likewise forced off when the feature is unavailable
// (no SHODAN_API_KEY / break-glass), so the UI never shows a knob that
// would do nothing.
function settingsPayload(env, identity, settings) {
  const available = featureAvailability(env, identity);
  return {
    server_history: available.storage && settings.server_history,
    shodan_mcp: available.shodan && settings.shodan_mcp,
    google_maps: available.google_maps && settings.google_maps,
    available,
  };
}

// GET /api/settings
export async function handleSettingsGet(env, identity) {
  return jsonResponse(settingsPayload(env, identity, getSettings(identity)));
}

// PUT /api/settings — body may carry either knob (partial updates allowed):
// {server_history?: boolean, shodan_mcp?: boolean}. Turning a knob ON
// requires its backing to actually exist — cloud storage needs the R2
// binding, Shodan needs the SHODAN_API_KEY secret — so a knob can't be
// switched on with nothing behind it (which would silently lose data or do
// nothing).
export async function handleSettingsPut(request, env, log, identity) {
  if (!identity.user) {
    return jsonResponse({ error: "Settings need a signed-in account (not break-glass)." }, 403);
  }
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Request body must be valid JSON." }, 400);
  }
  const hasHistory = body?.server_history !== undefined;
  const hasShodan = body?.shodan_mcp !== undefined;
  const hasGoogleMaps = body?.google_maps !== undefined;
  if (!hasHistory && !hasShodan && !hasGoogleMaps) {
    return jsonResponse(
      { error: "Expected {server_history?: boolean, shodan_mcp?: boolean, google_maps?: boolean}." },
      400,
    );
  }
  if (hasHistory && typeof body.server_history !== "boolean") {
    return jsonResponse({ error: "server_history must be a boolean." }, 400);
  }
  if (hasShodan && typeof body.shodan_mcp !== "boolean") {
    return jsonResponse({ error: "shodan_mcp must be a boolean." }, 400);
  }
  if (hasGoogleMaps && typeof body.google_maps !== "boolean") {
    return jsonResponse({ error: "google_maps must be a boolean." }, 400);
  }
  const available = featureAvailability(env, identity);
  if (hasHistory && body.server_history && !available.storage) {
    return jsonResponse(
      { error: "Cloud storage is not configured on this server (R2 binding missing)." },
      503,
    );
  }
  if (hasShodan && body.shodan_mcp && !available.shodan) {
    return jsonResponse(
      { error: "Shodan is not configured on this server (SHODAN_API_KEY missing)." },
      503,
    );
  }
  if (hasGoogleMaps && body.google_maps && !available.google_maps) {
    return jsonResponse(
      { error: "Google Maps is not configured on this server (GOOGLE_MAPS_API_KEY missing)." },
      503,
    );
  }
  const settings = { ...getSettings(identity) };
  if (hasHistory) settings.server_history = body.server_history;
  if (hasShodan) settings.shodan_mcp = body.shodan_mcp;
  if (hasGoogleMaps) settings.google_maps = body.google_maps;
  await saveSettings(env, identity.user.id, settings);
  log.info("settings.updated", {
    user_id: identity.id,
    server_history: settings.server_history,
    shodan_mcp: settings.shodan_mcp,
    google_maps: settings.google_maps,
  });
  return jsonResponse(settingsPayload(env, identity, settings));
}
