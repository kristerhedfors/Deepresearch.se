// @ts-check
// Per-user settings (users.settings_json, additive D1 column) — the opt-in
// feature knobs (see DEFAULTS below).
//
// CLOUD STORAGE IS NOT A KNOB (2026-07-16 owner directive — the TIER is the
// choice): on the signed-in Se/rver tier every conversation and project is
// stored in the cloud, implicitly and always (whenever the server has the
// R2 binding to store into); the tier where nothing rests server-side is
// Se/cure (/cure), where the server is in no data path at all. There used
// to be a per-account `server_history` opt-out (the founding knob, default
// ON) — removed so the two tiers' storage stories stay structurally
// distinct instead of overlapping via a switch.
//
// What "stored in the cloud" means
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
// The client keeps working local-first (public/js/sync.js reconciles: a
// diff-only push at boot plus pullNewer on the sidebar), with the cloud as
// the account-wide copy that follows the account across devices.

import { getDb } from "./db.js";
import { jsonResponse } from "./http.js";
import {
  extensionAvailability,
  extensionPayloadExtras,
  extensionSettingDefaults,
  extensionSettingSpecs,
} from "./extensions.js";

/** @typedef {import('./types.js').Env} Env */
/** @typedef {import('./types.js').Logger} Logger */

/**
 * A D1 `users` row as it rides on the identity (src/accounts.js). Loose by
 * design: columns are additive and several are nullable.
 * @typedef {{ id: number | string, email?: string | null, name?: string | null, role?: string, status?: string, quota_json?: string | null, quota_reset_at?: number | null, settings_json?: string | null }} UserRow
 */
/**
 * The resolved request identity (src/auth.js `identify`): either a D1-backed
 * account (`user` set) or the break-glass admin (`isSecretAdmin: true`, no
 * user row — which is why per-user settings don't apply to it).
 * @typedef {{ id: string, role: "admin" | "user", email: string | null, name: string | null, pending?: boolean, isSecretAdmin?: boolean, user?: UserRow | null }} Identity
 */
/**
 * The effective per-account knob state parseSettings coerces to: the two
 * core knobs below plus one boolean per registered extension (today
 * `shodan_mcp` and `google_maps` — src/extensions.js).
 * @typedef {{ bash_lite_mcp: boolean, developer_mode: boolean } & Record<string, boolean>} Settings
 */
/**
 * What the server can offer this identity right now (see featureAvailability):
 * the core entries plus one per registered extension (today `shodan` and
 * `google_maps`).
 * @typedef {{ storage: boolean, rag: boolean, bash_lite: boolean, developer: boolean } & Record<string, boolean>} FeatureAvailability
 */

// The CORE knobs. Cloud storage is deliberately NOT among them (see the
// header note; it is implicit whenever storage is available). Feedback is NOT
// a knob either (as of 2026-07-18): feedback is given straight from the chat —
// a message that opens with "feedback" is routed to the feedback pipeline
// (src/feedback.js feedbackIntent, src/pipeline.js runFeedbackCapture) — so
// there is nothing per-account to switch.
//
// Every knob backed by a THIRD-PARTY service is an extension and is declared
// in src/extensions.js instead — this module never names one. Extensions
// default OFF by construction (an extension reaches outside, so it is opt-in;
// only an explicit stored `true` enables it), which is why the registry's
// defaults are merged in below rather than listed here.
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
const CORE_DEFAULTS = { bash_lite_mcp: false, developer_mode: false };
/** @type {Settings} */
const DEFAULTS = { ...extensionSettingDefaults(), ...CORE_DEFAULTS };
/** Every knob key this server understands — core plus registered extensions. */
const KNOB_KEYS = Object.keys(DEFAULTS);

// Tolerant parse of a stored settings_json value: unknown keys are dropped
// (a legacy stored server_history flag simply falls away), known keys are
// coerced to their expected type, anything unreadable means defaults. Every
// knob is off unless an explicit stored `true` enables it. Exported for
// unit tests.
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
  return /** @type {Settings} */ (
    Object.fromEntries(KNOB_KEYS.map((key) => [key, raw[key] === true]))
  );
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

// The full availability map reported to the client: storage/rag, the core
// browser capabilities, and one entry per registered EXTENSION — each of
// which needs its own backing secret and, like every per-user setting, a D1
// user row to persist the knob against (break-glass has none). Which
// extensions exist and what each needs is entirely src/extensions.js's
// business; this function just merges what the registry reports. Kept
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
    ...extensionAvailability(env, !!identity.user),
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

// Convenience for gating the storage/RAG endpoints: cloud storage is
// IMPLICIT on the Se/rver tier (no per-account opt-out — see the header
// note), so the only question is availability: the R2 binding plus a D1
// user row to namespace under.
/**
 * @param {Env} env
 * @param {Identity} identity
 * @returns {boolean}
 */
export function cloudStorageEnabled(env, identity) {
  return storageAvailability(env, identity).storage;
}

// The effective state of ONE extension for a request, by registry id: the
// knob must be on AND the server must actually be able to run it (backing
// secret set, real user row). A knob left on in D1 after the secret was
// removed reads as off, so the pipeline never attempts a lookup it can't
// perform. Generic on purpose — this module resolves knobs; it does not know
// which services back them (src/extensions.js does).
/**
 * @param {Env} env
 * @param {Identity} identity
 * @param {string} id an extension id from src/extensions.js
 * @returns {boolean}
 */
export function extensionEnabled(env, identity, id) {
  const spec = extensionSettingSpecs().find((s) => s.id === id);
  if (!spec) return false;
  return !!(featureAvailability(env, identity)[spec.availability] && getSettings(identity)[spec.key]);
}

// Every extension's effective state at once, keyed by registry id — what
// chat.js hands to resolveExtensionState to build the request's `state.ext`.
/**
 * @param {Env} env
 * @param {Identity} identity
 * @returns {Record<string, boolean>}
 */
export function extensionEnabledMap(env, identity) {
  const available = featureAvailability(env, identity);
  const settings = getSettings(identity);
  return Object.fromEntries(
    extensionSettingSpecs().map((s) => [s.id, !!(available[s.availability] && settings[s.key])]),
  );
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

// The payload reports the EFFECTIVE state, not the raw stored flags: each
// knob is forced off when its feature is unavailable (no secret /
// break-glass), so the UI never shows a knob that would do nothing. Cloud
// storage has no knob — clients read `available.storage` (and `.rag`) to
// learn whether the implicit cloud copy exists on this server; when it's
// false (break-glass, or a server without the R2 binding) they simply run
// local-only instead of dual-writing into 503s.
/**
 * @param {Env} env
 * @param {Identity} identity
 * @param {Settings} settings
 */
function settingsPayload(env, identity, settings) {
  const available = featureAvailability(env, identity);
  /** @type {Record<string, any>} */
  const knobs = {};
  // Extensions: the knob is reported on only when the registry says the
  // server can actually back it.
  for (const spec of extensionSettingSpecs()) {
    knobs[spec.key] = !!(available[spec.availability] && settings[spec.key]);
  }
  return {
    ...knobs,
    bash_lite_mcp: available.bash_lite && (identity.user ? settings.bash_lite_mcp : true),
    developer_mode: available.developer && (identity.user ? settings.developer_mode : true),
    // Whatever extra fields the extensions contribute to this payload (today
    // the Maps embed key — see src/extensions.js payloadExtras).
    ...extensionPayloadExtras(env, available),
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

// PUT /api/settings — body may carry any knob (partial updates allowed): the
// two core ones plus one per registered extension (today {shodan_mcp?,
// google_maps?, bash_lite_mcp?, developer_mode?}). Turning a knob ON requires
// its backing to actually exist — an extension needs its secret — so a knob
// can't be switched on with nothing behind it (which would silently do
// nothing); the 503 message comes from the registry, so this handler never
// names a service. Cloud storage is not a knob and cannot be switched here
// (see the header note); feedback is no longer a knob either (given from the
// chat — see the DEFAULTS note).
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
  const present = KNOB_KEYS.filter((key) => body?.[key] !== undefined);
  if (!present.length) {
    return jsonResponse(
      { error: `Expected {${KNOB_KEYS.map((k) => `${k}?: boolean`).join(", ")}}.` },
      400,
    );
  }
  for (const key of present) {
    if (typeof body[key] !== "boolean") {
      return jsonResponse({ error: `${key} must be a boolean.` }, 400);
    }
  }
  const available = featureAvailability(env, identity);
  // An extension knob can only be switched on when the registry says its
  // backing exists; the message is the registry's, not this handler's.
  for (const spec of extensionSettingSpecs()) {
    if (present.includes(spec.key) && body[spec.key] && !available[spec.availability]) {
      return jsonResponse({ error: spec.unavailableError }, 503);
    }
  }
  // bash_lite needs only a user row (it's a browser capability) — available
  // is false only for break-glass, which can't reach this handler anyway.
  if (present.includes("bash_lite_mcp") && body.bash_lite_mcp && !available.bash_lite) {
    return jsonResponse(
      { error: "The execution sandbox needs a signed-in account." },
      503,
    );
  }
  // developer_mode needs only a user row (the snapshot is a public artifact)
  // — available is false only for break-glass, which can't reach this handler.
  if (present.includes("developer_mode") && body.developer_mode && !available.developer) {
    return jsonResponse(
      { error: "Developer mode needs a signed-in account." },
      503,
    );
  }
  const settings = { ...getSettings(identity) };
  for (const key of present) settings[key] = body[key];
  await saveSettings(env, identity.user.id, settings);
  log.info("settings.updated", { user_id: identity.id, ...settings });
  return jsonResponse(settingsPayload(env, identity, settings));
}
