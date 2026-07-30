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

import { CHAT_MODES, DEFAULT_CHAT_MODE, normalizeChatMode } from "./chat-modes.js";
import { getDb } from "./db.js";
import { jsonResponse, readJsonBody } from "./http.js";
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
 * The effective per-account setting state parseSettings coerces to: the core
 * knob below, one boolean per registered extension (today `shodan_mcp` and
 * `google_maps` — src/extensions.js), plus the account's persisted
 * `chat_mode` — the one non-boolean setting, and the reason the boolean-only
 * key list (KNOB_KEYS) is kept separate from this shape.
 * @typedef {{ bash_lite_mcp: boolean, memory: boolean, chat_mode: string } & Record<string, any>} Settings
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
//
// There used to be a second core knob, `developer_mode` (default OFF), whose
// job was to unlock INTROSPECTION MODE. It is GONE as of 2026-07-26: the
// account's `chat_mode` below replaced it. The knob had degenerated into
// derived state — the Chat mode dropdown wrote it on every mode change, so it
// only ever said "the picked mode is not Normal" — while ALSO being the sole
// activation signal for introspection (which had no request flag of its own)
// and the name of the availability gate. Three jobs, one boolean, mirrored in
// three stores. Now the MODE is stored and everything is derived from it; see
// public/js/chat-mode-core.js for the table and the resolution rules.
//  - memory: default OFF (opt-in — builds the account's durable note graph
//    from finished turns and keeps it server-side; src/memory.js,
//    docs/ACCOUNT-MEMORY.md). Off by default because it is the one knob that
//    creates a NEW long-lived record of what a person researched, distilled
//    and linked; the tier already stores conversations, but a memory note
//    outlives the chat it came from and is far easier to read at a glance.
//    Se/rver-tier only, and never written for an incognito turn.
const CORE_DEFAULTS = { bash_lite_mcp: false, memory: false };
/** @type {Record<string, boolean>} */
const KNOB_DEFAULTS = { ...extensionSettingDefaults(), ...CORE_DEFAULTS };
/**
 * Every BOOLEAN knob key this server understands — core plus registered
 * extensions. `chat_mode` is deliberately not here: it is a string, and the PUT
 * handler's "must be a boolean" validation walks this list.
 */
const KNOB_KEYS = Object.keys(KNOB_DEFAULTS);
// The cast is needed because the extension defaults arrive as an open
// Record<string, boolean>, which loses the literal `bash_lite_mcp` key the
// Settings shape requires by name.
const DEFAULTS = /** @type {Settings} */ ({ ...KNOB_DEFAULTS, chat_mode: DEFAULT_CHAT_MODE });

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
  return /** @type {Settings} */ ({
    ...Object.fromEntries(KNOB_KEYS.map((key) => [key, raw[key] === true])),
    chat_mode: storedChatModeFrom(raw),
  });
}

// The account's persisted chat mode, read out of a raw settings_json object.
//
// MIGRATION (2026-07-26): rows written before the collapse carry the old
// `developer_mode` boolean and no `chat_mode`. An account that had it ON was,
// by definition, in a non-Normal mode — and introspection is the mode it
// started as and the one the client's own pre-dropdown fallback assumed — so it
// reads as `introspection`. Everything else reads as `normal`. The old key is
// simply not written any more; a stored copy is ignored once `chat_mode` exists,
// and mergeStoredSettings leaves the dead key alone rather than rewriting rows
// (it costs nothing and a failed migration write would be worse than a stale
// key nobody reads).
/**
 * @param {any} raw a parsed settings_json object
 * @returns {string}
 */
function storedChatModeFrom(raw) {
  const named = normalizeChatMode(raw?.chat_mode, "");
  if (named) return named;
  return raw?.developer_mode === true ? "introspection" : DEFAULT_CHAT_MODE;
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
    // Whether the NON-NORMAL CHAT MODES (introspection, Agent Studio,
    // Orchestrator, Outrospection, Models) are available to this identity at
    // all. Mirrors bash_lite exactly: no server secret — the source snapshot is
    // a committed public artifact — and the break-glass admin (an explicit
    // operator identity with no D1 row) gets it, which keeps the modes
    // end-to-end testable with the break-glass credentials.
    //
    // This is AVAILABILITY, not a per-account opt-in: it is true for every
    // signed-in account, so it gates nothing a caller could not grant itself.
    // It is a "does this deployment/identity have the feature" answer, in the
    // same family as `storage` and `bash_lite`. The key keeps its historical
    // `developer` name because the agent specs declare it as a required grant
    // (`requires: ["developer_mode"]` — sdk/AGENTS.json), and that is a
    // published data format.
    developer: !!(identity.user || identity.isSecretAdmin),
    // WHERE the sandbox's commands may run. The two shipped environments (the
    // in-browser VM, a runner on the user's own machine) need nothing from the
    // server, but the third — an ephemeral container this platform starts
    // (src/exec-container.js) — needs the optional EXEC_SANDBOX binding, which
    // wrangler.toml deliberately does not declare by default. False on an
    // unconfigured deploy, and the client then omits the option entirely.
    // Se/rver only by construction: this endpoint lives behind the identity
    // gate, and Se/cure has no identity.
    exec_container: !!(/** @type {any} */ (env).EXEC_SANDBOX && (identity.user || identity.isSecretAdmin)),
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

/**
 * Whether this turn should feed the account's memory (src/memory.js).
 *
 * Unlike the knobs above there is NO break-glass fallback to `true`: memory is
 * account-scoped durable state, so an identity without a user row has nowhere
 * to put it and no business writing under a shared operational credential.
 * A missing D1 binding also means no, since there would be nothing to write to.
 * @param {Env} env
 * @param {Identity} identity
 * @returns {boolean}
 */
export function memoryEnabled(env, identity) {
  if (!env?.DB || !identity?.user) return false;
  return getSettings(identity).memory === true;
}

// Whether this identity may use the non-normal chat modes at all. The whole
// answer is availability (see featureAvailability's `developer` note) — there is
// no per-account opt-in left to consult. WHICH mode a given request runs in is
// resolved per request from the mode field, the legacy flags and the stored
// pick below; that decision lives in chat-mode-core.js resolveBodyChatMode, not
// here.
/**
 * @param {Env} env
 * @param {Identity} identity
 * @returns {boolean}
 */
export function chatModesAvailable(env, identity) {
  return featureAvailability(env, identity).developer;
}

// The chat mode this account last picked — the durable half of the choice, so
// the mode follows the account across devices (the browser's localStorage copy
// is a first-paint CACHE of this, not a second authority). Normal for the
// break-glass admin: it has no D1 row to persist a pick in, so each request
// says which mode it wants and gets plain deep research when it says nothing.
// That is a deliberate change from the old knob, which read as permanently ON
// for break-glass and made every unflagged operator request introspection.
/**
 * @param {Identity} identity
 * @returns {string}
 */
export function storedChatMode(identity) {
  return identity?.user ? getSettings(identity).chat_mode : DEFAULT_CHAT_MODE;
}

// settings_json is not knobs-only any more. `parseSettings` deliberately drops
// every key it doesn't recognize (that is what makes a legacy flag fall away),
// so writing its output straight back would DELETE anything else the column
// carries — today the accepted-model list src/user-models.js keeps there, which
// would mean "turn on the sandbox" silently un-enabled the models an account
// had accepted. This merge is the fix: knobs are replaced, everything else in
// the stored object survives untouched. Pure and exported for unit tests, and
// for user-models.js, which writes the other half through it.
/**
 * @param {unknown} storedJson the current settings_json (string or object)
 * @param {Record<string, any>} patch the keys to replace
 * @returns {Record<string, any>} the object to store
 */
export function mergeStoredSettings(storedJson, patch) {
  /** @type {Record<string, any>} */
  let stored = {};
  try {
    const parsed = typeof storedJson === "string" ? JSON.parse(storedJson) : storedJson;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) stored = parsed;
  } catch {
    stored = {};
  }
  return { ...stored, ...patch };
}

/**
 * @param {Env} env
 * @param {Identity} identity
 * @param {Settings} settings
 */
async function saveSettings(env, identity, settings) {
  const db = await getDb(env);
  if (!db) throw new Error("Database not configured.");
  const merged = mergeStoredSettings(identity.user?.settings_json, settings);
  await db
    .prepare("UPDATE users SET settings_json = ? WHERE id = ?")
    .bind(JSON.stringify(merged), identity.user?.id)
    .run();
  if (identity.user) identity.user.settings_json = JSON.stringify(merged);
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
  // The account's persisted chat mode, forced to Normal when the modes are
  // unavailable — so a client never paints a mode it cannot actually run.
  const chatMode = available.developer ? normalizeChatMode(settings.chat_mode) : DEFAULT_CHAT_MODE;
  return {
    ...knobs,
    bash_lite_mcp: available.bash_lite && (identity.user ? settings.bash_lite_mcp : true),
    chat_mode: chatMode,
    // BACK-COMPAT (2026-07-26): the old boolean, now purely derived — "the
    // stored mode is not Normal". A client cached mid-deploy still reads it and
    // gets the right answer; nothing in this repo reads it any more. Removable
    // once no released client does.
    developer_mode: chatMode !== DEFAULT_CHAT_MODE,
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

// PUT /api/settings — body may carry any boolean knob (partial updates
// allowed): the core one plus one per registered extension (today
// {shodan_mcp?, google_maps?, bash_lite_mcp?}), and/or `chat_mode` (a string —
// the account's picked mode). Turning a knob ON requires its backing to
// actually exist — an extension needs its secret — so a knob can't be switched
// on with nothing behind it (which would silently do nothing); the 503 message
// comes from the registry, so this handler never names a service. Cloud storage
// is not a knob and cannot be switched here (see the header note); feedback is
// no longer a knob either (given from the chat — see the DEFAULTS note).
//
// LEGACY (2026-07-26): a `developer_mode` boolean is still accepted and mapped
// onto `chat_mode` — true becomes introspection (what the knob unlocked), false
// becomes normal — so a client cached mid-deploy keeps working. An explicit
// `chat_mode` in the same body wins.
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
  const { body, response } = await readJsonBody(request);
  if (response) return response;
  const present = KNOB_KEYS.filter((key) => body?.[key] !== undefined);
  // The picked mode, from either the current field or the legacy boolean. Kept
  // separate from `present` because it is the one setting that is not a boolean.
  const modeGiven = body?.chat_mode !== undefined || body?.developer_mode !== undefined;
  if (!present.length && !modeGiven) {
    return jsonResponse(
      {
        error: `Expected {${KNOB_KEYS.map((k) => `${k}?: boolean`).join(", ")}, chat_mode?: string}.`,
      },
      400,
    );
  }
  for (const key of present) {
    if (typeof body[key] !== "boolean") {
      return jsonResponse({ error: `${key} must be a boolean.` }, 400);
    }
  }
  /** @type {string | null} */
  let nextMode = null;
  if (body?.chat_mode !== undefined) {
    nextMode = normalizeChatMode(body.chat_mode, "");
    if (!nextMode) {
      return jsonResponse(
        { error: `chat_mode must be one of: ${CHAT_MODES.join(", ")}.` },
        400,
      );
    }
  } else if (body?.developer_mode !== undefined) {
    if (typeof body.developer_mode !== "boolean") {
      return jsonResponse({ error: "developer_mode must be a boolean." }, 400);
    }
    nextMode = body.developer_mode ? "introspection" : DEFAULT_CHAT_MODE;
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
  // A non-Normal mode needs only a user row (the source snapshot is a public
  // artifact) — available is false only for break-glass, which can't reach this
  // handler anyway.
  if (nextMode && nextMode !== DEFAULT_CHAT_MODE && !available.developer) {
    return jsonResponse(
      { error: "The non-default chat modes need a signed-in account." },
      503,
    );
  }
  const settings = { ...getSettings(identity) };
  for (const key of present) settings[key] = body[key];
  if (nextMode) settings.chat_mode = nextMode;
  await saveSettings(env, identity, settings);
  log.info("settings.updated", { user_id: identity.id, ...settings });
  return jsonResponse(settingsPayload(env, identity, settings));
}
