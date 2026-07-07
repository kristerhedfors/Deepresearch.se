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
import { mapsAvailable } from "./maps.js";
import { shodanAvailable } from "./shodan.js";

// One row per knob: its default (default-ON knobs opt out via an explicit
// stored `false`; default-OFF knobs opt in via an explicit stored `true` —
// anything else means the default), which availability flag gates turning
// it on, and the 503 text when that backing is missing.
//  - server_history: ON  (cloud history is the normal mode).
//  - shodan_mcp:     OFF (enriching a query with Shodan sends the host/IP
//    to a third party, so it stays off until asked for).
//  - street_view / nearby_places / map_context: ON (the Google Maps photo
//    features, src/maps.js — they only ever send an attached photo's GPS
//    coordinates, which the free OSM lookups already send elsewhere; the
//    knobs are the per-user opt-out).
const MAPS_MISSING = "Google Maps features are not configured on this server (GOOGLE_MAPS_API_KEY missing).";
const KNOBS = [
  { key: "server_history", def: true, needs: "storage", missing: "Cloud storage is not configured on this server (R2 binding missing)." },
  { key: "shodan_mcp", def: false, needs: "shodan", missing: "Shodan is not configured on this server (SHODAN_API_KEY missing)." },
  { key: "street_view", def: true, needs: "maps", missing: MAPS_MISSING },
  { key: "nearby_places", def: true, needs: "maps", missing: MAPS_MISSING },
  { key: "map_context", def: true, needs: "maps", missing: MAPS_MISSING },
];
const DEFAULTS = Object.fromEntries(KNOBS.map((k) => [k.key, k.def]));

// Tolerant parse of a stored settings_json value: unknown keys are dropped,
// known keys are coerced to their expected type, anything unreadable means
// defaults. Exported for unit tests.
export function parseSettings(json) {
  let raw = {};
  try {
    const parsed = typeof json === "string" ? JSON.parse(json) : json;
    if (parsed && typeof parsed === "object") raw = parsed;
  } catch {
    raw = {};
  }
  return Object.fromEntries(
    KNOBS.map(({ key, def }) => [key, def ? raw[key] !== false : raw[key] === true]),
  );
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
// keyed features — Shodan (SHODAN_API_KEY) and the Google Maps photo
// features (GOOGLE_MAPS_API_KEY) — each of which, like every per-user
// setting, needs a D1 user row to persist the knob against (break-glass
// has none; note src/chat.js still grants break-glass the maps DEFAULTS,
// since the features themselves don't need a row). Kept separate from
// storageAvailability so that function's tested shape stays stable.
export function featureAvailability(env, identity) {
  return {
    ...storageAvailability(env, identity),
    shodan: !!(shodanAvailable(env) && identity.user),
    maps: !!(mapsAvailable(env) && identity.user),
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
// 503s. Every other knob is likewise forced off when its feature is
// unavailable, so the UI never shows a knob that would do nothing.
function settingsPayload(env, identity, settings) {
  const available = featureAvailability(env, identity);
  return {
    ...Object.fromEntries(KNOBS.map(({ key, needs }) => [key, !!(available[needs] && settings[key])])),
    available,
  };
}

// GET /api/settings
export async function handleSettingsGet(env, identity) {
  return jsonResponse(settingsPayload(env, identity, getSettings(identity)));
}

// PUT /api/settings — body may carry any subset of the known knobs
// (partial updates), each a boolean. Turning a knob ON requires its
// backing to actually exist — cloud storage needs the R2 binding, Shodan
// its key, the maps features theirs — so a knob can't be switched on with
// nothing behind it (which would silently lose data or do nothing).
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
  const patch = {};
  for (const { key } of KNOBS) {
    if (body?.[key] === undefined) continue;
    if (typeof body[key] !== "boolean") {
      return jsonResponse({ error: `${key} must be a boolean.` }, 400);
    }
    patch[key] = body[key];
  }
  if (!Object.keys(patch).length) {
    return jsonResponse(
      { error: `Expected at least one of: ${KNOBS.map((k) => k.key).join(", ")}.` },
      400,
    );
  }
  const available = featureAvailability(env, identity);
  for (const { key, needs, missing } of KNOBS) {
    if (patch[key] && !available[needs]) return jsonResponse({ error: missing }, 503);
  }
  const settings = { ...getSettings(identity), ...patch };
  await saveSettings(env, identity.user.id, settings);
  log.info("settings.updated", { user_id: identity.id, ...patch });
  return jsonResponse(settingsPayload(env, identity, settings));
}
