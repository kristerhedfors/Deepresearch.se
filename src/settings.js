// Per-user settings (users.settings_json, additive D1 column) — currently a
// single knob: `server_history`, default OFF.
//
// OFF (the default) is the original posture: conversations live only in the
// browser's encrypted IndexedDB, attached files in its OPFS, the RAG index
// in its IndexedDB — nothing conversation-derived is stored server-side.
//
// ON is an explicit per-account opt-in to Cloudflare-side storage
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

const DEFAULTS = { server_history: false };

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
  return { server_history: raw.server_history === true };
}

// What the server can actually offer this identity right now. `storage`
// needs the R2 binding plus a D1 user row to hang the setting on (the
// break-glass identity has neither a row nor a personal history to sync);
// `rag` additionally needs the Vectorize binding for server-side retrieval.
export function storageAvailability(env, identity) {
  const storage = !!(env.STORAGE && identity.user);
  return { storage, rag: !!(storage && env.RAG_INDEX) };
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

async function saveSettings(env, userId, settings) {
  const db = await getDb(env);
  if (!db) throw new Error("Database not configured.");
  await db
    .prepare("UPDATE users SET settings_json = ? WHERE id = ?")
    .bind(JSON.stringify(settings), userId)
    .run();
}

function settingsPayload(env, identity, settings) {
  return {
    server_history: settings.server_history,
    available: storageAvailability(env, identity),
  };
}

// GET /api/settings
export async function handleSettingsGet(env, identity) {
  return jsonResponse(settingsPayload(env, identity, getSettings(identity)));
}

// PUT /api/settings — body {server_history: boolean}. Turning it on
// requires the storage backing to actually exist; a knob that can be
// switched on with nowhere to store anything would silently lose data.
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
  if (typeof body?.server_history !== "boolean") {
    return jsonResponse({ error: "Expected {server_history: boolean}." }, 400);
  }
  const available = storageAvailability(env, identity);
  if (body.server_history && !available.storage) {
    return jsonResponse(
      { error: "Cloud storage is not configured on this server (R2 binding missing)." },
      503,
    );
  }
  const settings = { ...getSettings(identity), server_history: body.server_history };
  await saveSettings(env, identity.user.id, settings);
  log.info("settings.updated", { user_id: identity.id, server_history: settings.server_history });
  return jsonResponse(settingsPayload(env, identity, settings));
}
