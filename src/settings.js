// @ts-check
// Per-user settings (users.settings_json, additive D1 column) — four knobs
// today (see DEFAULTS below). The founding knob is `server_history`, default
// ON (a product decision made as the feature shipped: cloud history is the
// normal mode, switching it OFF is the explicit per-account opt-out).
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
import { googleMapsAvailable, googleMapsEmbedKey } from "./googlemaps.js";

/** @typedef {import('./types.js').Env} Env */
/** @typedef {import('./types.js').Logger} Logger */

/**
 * A D1 `users` row as it rides on the identity (src/accounts.js). Loose by
 * design: columns are additive and several are nullable.
 * @typedef {{ id: number | string, email?: string | null, name?: string | null, role?: string, status?: string, quota_json?: string | null, settings_json?: string | null }} UserRow
 */
/**
 * The resolved request identity (src/auth.js `identify`): either a D1-backed
 * account (`user` set) or the break-glass admin (`isSecretAdmin: true`, no
 * user row — which is why per-user settings don't apply to it).
 * @typedef {{ id: string, role: "admin" | "user", email: string | null, name: string | null, pending?: boolean, isSecretAdmin?: boolean, user?: UserRow | null }} Identity
 */
/**
 * The effective per-account knob state parseSettings coerces to.
 * @typedef {{ server_history: boolean, shodan_mcp: boolean, google_maps: boolean, feedback_mode: boolean, bash_lite_mcp: boolean, developer_mode: boolean }} Settings
 */
/**
 * What the server can offer this identity right now (see featureAvailability).
 * @typedef {{ storage: boolean, rag: boolean, shodan: boolean, google_maps: boolean, feedback: boolean, bash_lite: boolean, developer: boolean }} FeatureAvailability
 */

// Four knobs today:
//  - server_history: default ON  (only an explicit stored `false` opts out).
//  - shodan_mcp:     default OFF (opt-in — enriching a query with Shodan
//    sends the host/IP to a third party, so it stays off until asked for;
//    only an explicit stored `true` enables it).
//  - google_maps:    default OFF (opt-in — a named address / photo location is
//    sent to Google Maps Platform (Places + Street View + Static Maps) and the
//    imagery fetches are billed, so it stays off until asked for; only an
//    explicit stored `true` enables it).
//  - feedback_mode:  default OFF (opt-in — switches a Feedback button onto
//    every assistant reply, existing ones included; a submission stores the
//    comment PLUS that reply's question/answer readable server-side for the
//    development loop (src/feedback.js), so it stays off until the user
//    asks for it; only an explicit stored `true` enables it).
//  - bash_lite_mcp:  default OFF (opt-in, EXPERIMENTAL — enables the
//    in-browser Linux execution sandbox (CheerpX) and the agentic bash tool
//    (src/bash-agent.js): when a task "wants a shell" the model proposes
//    commands, the BROWSER runs them in a WASM x86 Linux VM (the server
//    never runs a shell), and the transcript feeds synthesis. Purely a
//    browser capability, so it needs no server secret — only a user row to
//    persist the knob; only an explicit stored `true` enables it).
//  - developer_mode: default OFF (opt-in — unlocks INTROSPECTION MODE:
//    conversations that ask about this site's own implementation get the
//    deployed source snapshot as context (src/introspect.js), and — with the
//    sandbox knob also on — the source tree mounted at /src in the VM. The
//    source is public on GitHub anyway; the knob keeps the mode out of
//    ordinary users' way, not out of reach. No server secret; only an
//    explicit stored `true` enables it).
const DEFAULTS = { server_history: true, shodan_mcp: false, google_maps: false, feedback_mode: false, bash_lite_mcp: false, developer_mode: false };

// Tolerant parse of a stored settings_json value: unknown keys are dropped,
// known keys are coerced to their expected type, anything unreadable means
// defaults. server_history is on unless an explicit stored `false` says
// otherwise; shodan_mcp and google_maps are off unless an explicit stored
// `true` enables them (their opposite defaults are why each tests against its
// own literal). Exported for unit tests.
/**
 * @param {unknown} json the stored settings_json string (or a pre-parsed object)
 * @returns {Settings}
 */
export function parseSettings(json) {
  /** @type {any} */
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
    feedback_mode: raw.feedback_mode === true,
    bash_lite_mcp: raw.bash_lite_mcp === true,
    developer_mode: raw.developer_mode === true,
  };
}

// What the server can actually offer this identity right now. `storage`
// needs the R2 binding plus a D1 user row to hang the setting on (the
// break-glass identity has neither a row nor a personal history to sync);
// `rag` additionally needs the Vectorize binding for server-side retrieval.
/**
 * @param {Env} env
 * @param {Identity} identity
 * @returns {{ storage: boolean, rag: boolean }}
 */
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
/**
 * @param {Env} env
 * @param {Identity} identity
 * @returns {FeatureAvailability}
 */
export function featureAvailability(env, identity) {
  return {
    ...storageAvailability(env, identity),
    shodan: !!(shodanAvailable(env) && identity.user),
    google_maps: !!(googleMapsAvailable(env) && identity.user),
    // Feedback needs D1 (the entries/threads live there) and a real user row
    // to attribute entries and route the agent's replies back to.
    feedback: !!(env.DB && identity.user),
    // The bash-lite sandbox is a pure BROWSER capability (CheerpX runs
    // client-side; the server only remembers the knob and, when it's on,
    // serves the app shell cross-origin-isolated so SharedArrayBuffer works).
    // No server secret to gate on. A signed-in account persists the knob in
    // its D1 row; the break-glass admin — an explicit operator identity with
    // no row — also gets it (the sandbox is simply on for it, see
    // bashLiteEnabled), which is what makes the feature reachable and
    // end-to-end testable with the break-glass credentials.
    bash_lite: !!(identity.user || identity.isSecretAdmin),
    // Developer mode (the introspection gate) mirrors bash_lite exactly:
    // no server secret — the source snapshot is a committed public artifact —
    // and the break-glass admin (an explicit operator identity with no D1
    // row) gets it, which keeps introspection end-to-end testable with the
    // break-glass credentials.
    developer: !!(identity.user || identity.isSecretAdmin),
  };
}

/**
 * The identity's stored settings (defaults when there is no user row).
 * @param {Identity | null | undefined} identity
 * @returns {Settings}
 */
export function getSettings(identity) {
  if (!identity?.user) return { ...DEFAULTS };
  return parseSettings(identity.user.settings_json);
}

// Convenience for gating the storage/RAG endpoints: the caller's current
// server_history state, availability included (a knob left on in D1 after
// the R2 binding was removed must read as off).
/**
 * @param {Env} env
 * @param {Identity} identity
 * @returns {boolean}
 */
export function serverHistoryEnabled(env, identity) {
  return storageAvailability(env, identity).storage && getSettings(identity).server_history;
}

// The effective Shodan-MCP state for a request: the knob must be on AND the
// server must actually be able to run it (SHODAN_API_KEY set, real user
// row). A knob left on in D1 after the secret was removed reads as off, so
// the pipeline never attempts a lookup it can't perform.
/**
 * @param {Env} env
 * @param {Identity} identity
 * @returns {boolean}
 */
export function shodanEnabled(env, identity) {
  return featureAvailability(env, identity).shodan && getSettings(identity).shodan_mcp;
}

// The effective Google Maps state for a request: the knob on AND the server
// able to run it (GOOGLE_MAPS_API_KEY set, real user row). A knob left on in
// D1 after the secret was removed reads as off.
/**
 * @param {Env} env
 * @param {Identity} identity
 * @returns {boolean}
 */
export function googleMapsEnabled(env, identity) {
  return featureAvailability(env, identity).google_maps && getSettings(identity).google_maps;
}

// The effective Feedback-mode state: the knob on AND D1 + a real user row
// behind it. Gates creating new entries (src/feedback.js) — replying on an
// existing thread deliberately does NOT check this, so a dialogue survives
// the knob being switched off mid-conversation.
/**
 * @param {Env} env
 * @param {Identity} identity
 * @returns {boolean}
 */
export function feedbackEnabled(env, identity) {
  return featureAvailability(env, identity).feedback && getSettings(identity).feedback_mode;
}

// The effective bash-lite sandbox state. Read by index.js to decide whether
// the DRS app shell is served cross-origin-isolated (COEP) so CheerpX can
// boot, and by chat.js/bash-api.js to accept a shell transcript / run the
// step. A signed-in account gates on its stored knob; the break-glass admin
// has no D1 row to store one, so the sandbox is simply on for it (an explicit
// operator identity — and the path that makes the feature testable).
/**
 * @param {Env} env
 * @param {Identity} identity
 * @returns {boolean}
 */
export function bashLiteEnabled(env, identity) {
  if (!featureAvailability(env, identity).bash_lite) return false;
  return identity?.user ? getSettings(identity).bash_lite_mcp : true;
}

// The effective developer-mode state. Gates INTROSPECTION MODE: the
// source-snapshot enrichment (src/introspect.js) and — client-side — the
// /src sandbox mount. A signed-in account gates on its stored knob; the
// break-glass admin is a developer by definition, so the mode is simply on
// for it (same rationale and same testability path as bashLiteEnabled).
/**
 * @param {Env} env
 * @param {Identity} identity
 * @returns {boolean}
 */
export function developerModeEnabled(env, identity) {
  if (!featureAvailability(env, identity).developer) return false;
  return identity?.user ? getSettings(identity).developer_mode : true;
}

/**
 * @param {Env} env
 * @param {number | string} userId
 * @param {Settings} settings
 */
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
/**
 * @param {Env} env
 * @param {Identity} identity
 * @param {Settings} settings
 */
function settingsPayload(env, identity, settings) {
  const available = featureAvailability(env, identity);
  return {
    server_history: available.storage && settings.server_history,
    shodan_mcp: available.shodan && settings.shodan_mcp,
    google_maps: available.google_maps && settings.google_maps,
    feedback_mode: available.feedback && settings.feedback_mode,
    bash_lite_mcp: available.bash_lite && (identity.user ? settings.bash_lite_mcp : true),
    developer_mode: available.developer && (identity.user ? settings.developer_mode : true),
    // Browser key for the interactive Street View embed — public by design,
    // safe because the key is HTTP-referrer-locked to the site. Prefers a
    // dedicated GOOGLE_MAPS_EMBED_KEY, else falls back to GOOGLE_MAPS_API_KEY
    // (see googleMapsEmbedKey). Sent only when the caller can use Maps; empty
    // string otherwise (client then shows the keyless link only).
    maps_embed_key: available.google_maps ? googleMapsEmbedKey(env) : "",
    available,
  };
}

// GET /api/settings
/**
 * @param {Env} env
 * @param {Identity} identity
 * @returns {Promise<Response>}
 */
export async function handleSettingsGet(env, identity) {
  return jsonResponse(settingsPayload(env, identity, getSettings(identity)));
}

// PUT /api/settings — body may carry any knob (partial updates allowed):
// {server_history?, shodan_mcp?, google_maps?, feedback_mode?}. Turning a
// knob ON requires its backing to actually exist — cloud storage needs the
// R2 binding, Shodan needs the SHODAN_API_KEY secret, feedback needs D1 —
// so a knob can't be switched on with nothing behind it (which would
// silently lose data or do nothing).
/**
 * @param {Request} request
 * @param {Env} env
 * @param {Logger} log
 * @param {Identity} identity
 * @returns {Promise<Response>}
 */
export async function handleSettingsPut(request, env, log, identity) {
  if (!identity.user) {
    return jsonResponse({ error: "Settings need a signed-in account (not break-glass)." }, 403);
  }
  /** @type {any} */
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Request body must be valid JSON." }, 400);
  }
  const hasHistory = body?.server_history !== undefined;
  const hasShodan = body?.shodan_mcp !== undefined;
  const hasGoogleMaps = body?.google_maps !== undefined;
  const hasFeedback = body?.feedback_mode !== undefined;
  const hasBashLite = body?.bash_lite_mcp !== undefined;
  const hasDeveloper = body?.developer_mode !== undefined;
  if (!hasHistory && !hasShodan && !hasGoogleMaps && !hasFeedback && !hasBashLite && !hasDeveloper) {
    return jsonResponse(
      {
        error:
          "Expected {server_history?: boolean, shodan_mcp?: boolean, google_maps?: boolean, feedback_mode?: boolean, bash_lite_mcp?: boolean, developer_mode?: boolean}.",
      },
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
  if (hasFeedback && typeof body.feedback_mode !== "boolean") {
    return jsonResponse({ error: "feedback_mode must be a boolean." }, 400);
  }
  if (hasBashLite && typeof body.bash_lite_mcp !== "boolean") {
    return jsonResponse({ error: "bash_lite_mcp must be a boolean." }, 400);
  }
  if (hasDeveloper && typeof body.developer_mode !== "boolean") {
    return jsonResponse({ error: "developer_mode must be a boolean." }, 400);
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
  if (hasFeedback && body.feedback_mode && !available.feedback) {
    return jsonResponse(
      { error: "Feedback is not configured on this server (database missing)." },
      503,
    );
  }
  // bash_lite needs only a user row (it's a browser capability) — available
  // is false only for break-glass, which can't reach this handler anyway.
  if (hasBashLite && body.bash_lite_mcp && !available.bash_lite) {
    return jsonResponse(
      { error: "The execution sandbox needs a signed-in account." },
      503,
    );
  }
  // developer_mode needs only a user row (the snapshot is a public artifact)
  // — available is false only for break-glass, which can't reach this handler.
  if (hasDeveloper && body.developer_mode && !available.developer) {
    return jsonResponse(
      { error: "Developer mode needs a signed-in account." },
      503,
    );
  }
  const settings = { ...getSettings(identity) };
  if (hasHistory) settings.server_history = body.server_history;
  if (hasShodan) settings.shodan_mcp = body.shodan_mcp;
  if (hasGoogleMaps) settings.google_maps = body.google_maps;
  if (hasFeedback) settings.feedback_mode = body.feedback_mode;
  if (hasBashLite) settings.bash_lite_mcp = body.bash_lite_mcp;
  if (hasDeveloper) settings.developer_mode = body.developer_mode;
  await saveSettings(env, identity.user.id, settings);
  log.info("settings.updated", {
    user_id: identity.id,
    server_history: settings.server_history,
    shodan_mcp: settings.shodan_mcp,
    google_maps: settings.google_maps,
    feedback_mode: settings.feedback_mode,
    bash_lite_mcp: settings.bash_lite_mcp,
    developer_mode: settings.developer_mode,
  });
  return jsonResponse(settingsPayload(env, identity, settings));
}
