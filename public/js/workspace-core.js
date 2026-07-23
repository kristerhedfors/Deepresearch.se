// @ts-check
// SECURE WORKSPACES' pure core — the "whole workspace in one link" crypto and
// payload logic behind /cure/workspace. A workspace is a fully configured
// Se/cure session (provider API keys, settings, conversations, and any
// borrowed quota-bound grant tokens) sealed into CIPHERTEXT that rides the
// URL ANCHOR: `…/cure/workspace#w=<blob>`. The fragment never leaves the
// browser (anchors are not sent in HTTP requests and are stripped from
// referrers), so the workspace is COMPLETELY OFFLINE — the link IS the
// storage; the server serves the static page and nothing else.
//
// MECHANISM PROVENANCE (owner directive, 2026-07-15): cloned as closely as
// possible from github.com/kristerhedfors/hacka.re (the owner's prior
// project; see its CRYPTO_SPEC.md and js/utils/crypto-utils.js). What is
// copied VERBATIM:
//   - the binary wire format  [salt(10)][nonce(10)][ciphertext]  in a
//     URL-SAFE BASE64 fragment ("base64url" — the URL-safe alphabet the
//     owner asked for; base85 isn't URL-safe, base64url is the standard);
//   - the KDF: ITERATIVE SHA-512, 8192 rounds, keeping ALL 64 bytes each
//     round and slicing to 32 only at the end ("computational
//     irreducibility" — hacka.re's deriveDecryptionKey, byte-for-byte the
//     same algorithm);
//   - the DUAL-KEY architecture: the LINK key = KDF(password ‖ salt) opens
//     the blob; a SEPARATE MASTER key = KDF(password ‖ salt ‖ nonce) — never
//     transmitted, derivable only by someone who can already open the link —
//     is reserved for local at-rest storage of the opened workspace, so
//     nothing stored on disk is decryptable from the link blob alone;
//   - the NAMESPACE: the first 8 hex chars of SHA-256(blob) identify a
//     workspace locally (same link → same namespace, different links stay
//     isolated) without revealing anything about its contents;
//   - the password: 12+ alphanumeric chars, generated or user-chosen,
//     shared out-of-band, NEVER part of the link.
// The ONE deliberate substitution: hacka.re's XSalsa20-Poly1305 (TweetNaCl)
// becomes AES-256-GCM — this repo ships no crypto dependency (minimal-deps
// invariant) and WebCrypto has no Salsa; both are AEAD, and the 10-byte
// stored nonce is expanded by a single SHA-512 exactly as hacka.re does
// (first 24 bytes for NaCl there; first 12 bytes for the GCM IV here).
//
// WebCrypto only (crypto.subtle + getRandomValues) — import-safe and
// Node-testable unchanged, same as proxy-bundle.js / vault-core.js. Opening
// is FAIL-SOFT by contract: openWorkspace returns null on any problem (bad
// base64, wrong password, tampered ciphertext, malformed JSON) — never throws.

import { b64urlDecode, b64urlEncode } from "./proxy-bundle.js";

// hacka.re's constants, verbatim.
const SALT_LENGTH = 10; // 80-bit salt
const NONCE_LENGTH = 10; // 80-bit stored nonce (expanded before use)
const KEY_LENGTH = 32; // AES-256
const KEY_ITERATIONS = 8192; // KDF rounds (power of 2, like the original)
const GCM_IV_LENGTH = 12; // AES-GCM standard IV (the NaCl-24 substitution)

export const WORKSPACE_KIND = "drc-workspace";
export const WORKSPACE_V = 1;
export const WORKSPACE_HASH_PARAM = "w"; // …/cure/workspace#w=<blob>
export const WORKSPACE_PATH = "/cure/workspace";

const te = new TextEncoder();
const td = new TextDecoder();

/** @param {Uint8Array[]} parts @returns {Uint8Array} */
function concatBytes(parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/** @param {Uint8Array} bytes @returns {Promise<Uint8Array>} SHA-512, 64 bytes */
async function sha512(bytes) {
  return new Uint8Array(await crypto.subtle.digest("SHA-512", new Uint8Array(bytes)));
}

/** @param {Uint8Array} bytes @returns {string} lowercase hex */
export function bytesToHex(bytes) {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

// ---- the KDF (hacka.re's algorithm, byte-for-byte) ------------------------------

/**
 * The LINK (decryption) key: 8192 rounds of SHA-512(previous ‖ salt), all 64
 * bytes kept each round, sliced to 32 at the very end. This is the key the
 * blob is sealed under — deriving it needs the password AND the salt that
 * rides inside the blob itself.
 * @param {string} password
 * @param {Uint8Array} salt
 * @returns {Promise<Uint8Array>} 32 bytes
 */
export async function deriveLinkKey(password, salt) {
  let result = /** @type {Uint8Array} */ (te.encode(String(password)));
  for (let i = 0; i < KEY_ITERATIONS; i++) {
    result = await sha512(concatBytes([result, salt]));
  }
  return result.slice(0, KEY_LENGTH);
}

/**
 * The MASTER key (hacka.re's dual-key second half): 8192 rounds of
 * SHA-512(previous ‖ salt ‖ nonce). NEVER transmitted and never part of the
 * blob's own sealing — it exists for the RECEIVING side to encrypt the opened
 * workspace at rest locally, so on-disk data is not decryptable from the link
 * blob alone. Same link + password always re-derives the same master key
 * (multi-tab / reopen), which is the property hacka.re builds its persistent
 * namespaces on.
 * @param {string} password
 * @param {Uint8Array} salt
 * @param {Uint8Array} nonce
 * @returns {Promise<string>} 32 bytes as lowercase hex (hacka.re returns hex)
 */
export async function deriveMasterKeyHex(password, salt, nonce) {
  let result = /** @type {Uint8Array} */ (te.encode(String(password)));
  for (let i = 0; i < KEY_ITERATIONS; i++) {
    result = await sha512(concatBytes([result, salt, nonce]));
  }
  return bytesToHex(result.slice(0, KEY_LENGTH));
}

/**
 * The workspace NAMESPACE: first 8 hex chars of SHA-256(blob) — hacka.re's
 * localStorage namespace derivation. Same link → same namespace; reveals
 * nothing (it hashes ciphertext).
 * @param {string} blob the base64url fragment payload
 * @returns {Promise<string>}
 */
export async function workspaceNamespace(blob) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", te.encode(String(blob))));
  return bytesToHex(digest).slice(0, 8);
}

// ---- seal / open -----------------------------------------------------------------

/** @param {Uint8Array} nonce @returns {Promise<Uint8Array>} the expanded GCM IV */
async function expandNonce(nonce) {
  // hacka.re expands the 10-byte stored nonce with ONE SHA-512 and slices to
  // the cipher's nonce size (24 for NaCl). Same expansion, GCM's 12 here.
  return (await sha512(nonce)).slice(0, GCM_IV_LENGTH);
}

/** @param {Uint8Array} raw @param {"encrypt"|"decrypt"} usage */
function importAesKey(raw, usage) {
  return crypto.subtle.importKey("raw", new Uint8Array(raw), { name: "AES-GCM" }, false, [usage]);
}

/**
 * Seal a workspace payload under a password into the URL-fragment blob:
 * base64url( [salt(10)][nonce(10)][AES-256-GCM ciphertext] ). Fresh random
 * salt + nonce every call, so the same workspace sealed twice yields two
 * unlinkable blobs.
 * @param {any} payload JSON-serializable workspace payload
 * @param {string} password
 * @returns {Promise<string>} the blob (goes after `#w=`)
 */
export async function sealWorkspace(payload, password) {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_LENGTH));
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_LENGTH));
  const keyBytes = await deriveLinkKey(password, salt);
  const key = await importAesKey(keyBytes, "encrypt");
  const iv = await expandNonce(nonce);
  const plaintext = te.encode(JSON.stringify(payload));
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: new Uint8Array(iv) }, key, new Uint8Array(plaintext)));
  return b64urlEncode(concatBytes([salt, nonce, cipher]));
}

/**
 * Open a sealed workspace blob. Returns `{ payload, masterKeyHex, salt, nonce }`
 * or null on ANY failure (never throws): bad base64, blob too small, wrong
 * password (GCM authentication fails), tampered ciphertext, malformed JSON.
 * The masterKeyHex is the dual-key second half, for local at-rest use.
 * @param {string} blob
 * @param {string} password
 * @returns {Promise<{payload: any, masterKeyHex: string} | null>}
 */
export async function openWorkspace(blob, password) {
  try {
    const data = b64urlDecode(String(blob));
    // GCM's tag is 16 bytes, so anything smaller than headers + tag is junk.
    if (data.length < SALT_LENGTH + NONCE_LENGTH + 16) return null;
    const salt = data.slice(0, SALT_LENGTH);
    const nonce = data.slice(SALT_LENGTH, SALT_LENGTH + NONCE_LENGTH);
    const cipher = data.slice(SALT_LENGTH + NONCE_LENGTH);
    const keyBytes = await deriveLinkKey(password, salt);
    const key = await importAesKey(keyBytes, "decrypt");
    const iv = await expandNonce(nonce);
    const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: new Uint8Array(iv) }, key, new Uint8Array(cipher));
    const payload = JSON.parse(td.decode(new Uint8Array(plaintext)));
    if (!payload || typeof payload !== "object") return null;
    const masterKeyHex = await deriveMasterKeyHex(password, salt, nonce);
    return { payload, masterKeyHex };
  } catch {
    return null;
  }
}

// ---- password --------------------------------------------------------------------

/**
 * hacka.re's password generator: alphanumeric, default 12 chars (~71 bits).
 * Modulo bias over 62 symbols is negligible and matches the original.
 * @param {number} [length]
 * @returns {string}
 */
export function generateWorkspacePassword(length = 12) {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const rand = crypto.getRandomValues(new Uint8Array(length));
  let out = "";
  for (let i = 0; i < length; i++) out += chars.charAt(rand[i] % chars.length);
  return out;
}

// ---- link / fragment parsing -------------------------------------------------------

/**
 * The shareable link for a blob. The blob rides the ANCHOR, never the query —
 * anchors are not sent to any server and are stripped from referrers.
 * @param {string} origin e.g. location.origin
 * @param {string} blob
 * @returns {string}
 */
export function workspaceLink(origin, blob) {
  return String(origin).replace(/\/+$/, "") + WORKSPACE_PATH + "#" + WORKSPACE_HASH_PARAM + "=" + blob;
}

/**
 * Pull the workspace blob out of a location.hash (or a whole URL). Accepts
 * `#w=<blob>` anywhere in the fragment. Returns null when absent/malformed.
 * @param {string} hashOrUrl
 * @returns {string | null}
 */
export function parseWorkspaceHash(hashOrUrl) {
  const s = String(hashOrUrl == null ? "" : hashOrUrl);
  const hash = s.includes("#") ? s.slice(s.indexOf("#") + 1) : s;
  const m = hash.match(new RegExp("(?:^|&)" + WORKSPACE_HASH_PARAM + "=([A-Za-z0-9_-]+)"));
  return m ? m[1] : null;
}

/** @param {string} pathname @returns {boolean} the /cure/workspace page (trailing slash tolerated) */
export function isWorkspacePath(pathname) {
  return /^\/cure\/workspace\/?$/.test(String(pathname == null ? "" : pathname));
}

// ---- the payload ------------------------------------------------------------------
//
// What a workspace CARRIES (hacka.re's share-payload counterpart, mapped onto
// the DRC state of drc-core.js). Every field optional except v/kind — a
// workspace can be as small as a settings preset or as full as keys + chats +
// borrowed grants:
//   { v: 1, kind: "drc-workspace",
//     name?,                       // display name for the opened workspace
//     note?,                       // welcome note shown on open (hacka.re's welcomeMessage)
//     keys?: {openai?, groq?, berget?},
//     providerId?, model?,
//     settings?: { research?, bashLite?, developerMode?, searchBackend? },
//     conversations?: [{id?, title?, messages: [{role, content}]}],
//     grants?: { ws?: "wsk1.…",             // web-search grant token (src/websearch.js)
//                proxy?: [{svc, token}],    // proxy grant tokens (src/proxy.js, prg1.…)
//                pool?: "pt1.…" } }         // shared-compute pool token (src/pool.js)
// The pool token is SAFE to embed (like prg1): it authorizes only submitting
// completion jobs to the one pool it names, is quota/revocation-governed
// server-side, and every recipient is shown the shared-compute data-flow
// notice on unlock (public/js/pool-core.js poolDataFlowNotice).
// The grant tokens are the deepresearch.se TEMPORARY QUOTA-BOUND tokens: the
// minting user governs them live (quota can be raised/lowered per token, the
// row revoked) — the link stays fixed while its allowance is administered
// server-side.

/** @param {any} w @returns {boolean} */
export function validateWorkspacePayload(w) {
  if (!w || typeof w !== "object" || w.v !== WORKSPACE_V || w.kind !== WORKSPACE_KIND) return false;
  if (w.keys !== undefined && (!w.keys || typeof w.keys !== "object" || Array.isArray(w.keys))) return false;
  if (w.settings !== undefined && (!w.settings || typeof w.settings !== "object" || Array.isArray(w.settings))) return false;
  if (w.conversations !== undefined) {
    if (!Array.isArray(w.conversations)) return false;
    const ok = w.conversations.every(
      (/** @type {any} */ c) =>
        c &&
        typeof c === "object" &&
        Array.isArray(c.messages) &&
        c.messages.every(
          (/** @type {any} */ m) => m && typeof m.role === "string" && typeof m.content === "string",
        ),
    );
    if (!ok) return false;
  }
  if (w.grants !== undefined) {
    const g = w.grants;
    if (!g || typeof g !== "object" || Array.isArray(g)) return false;
    if (g.ws !== undefined && typeof g.ws !== "string") return false;
    if (g.pool !== undefined && typeof g.pool !== "string") return false;
    if (g.proxy !== undefined) {
      if (!Array.isArray(g.proxy)) return false;
      const ok = g.proxy.every(
        (/** @type {any} */ p) =>
          p && typeof p === "object" && (p.svc === "web" || p.svc === "api") && typeof p.token === "string" && p.token.length > 0,
      );
      if (!ok) return false;
    }
  }
  return true;
}

/**
 * Project a DRC state (drc-core.js shape) into a workspace payload, guided by
 * include flags — the hacka.re share-modal checkboxes as a pure function.
 * Omitted sections are absent (not empty), keeping links minimal.
 * @param {any} state a DRC state (emptyDrcState shape)
 * @param {{ keys?: boolean, settings?: boolean, conversations?: boolean,
 *           grants?: {ws?: string|null, proxy?: {svc: string, token: string}[]|null, pool?: string|null} | null,
 *           name?: string, note?: string }} opts
 * @returns {any} a payload passing validateWorkspacePayload
 */
export function buildWorkspacePayload(state, opts = {}) {
  /** @type {any} */
  const w = { v: WORKSPACE_V, kind: WORKSPACE_KIND };
  const s = state && typeof state === "object" ? state : {};
  if (opts.name) w.name = String(opts.name).slice(0, 80);
  if (opts.note) w.note = String(opts.note).slice(0, 2000);
  if (opts.keys && s.keys && typeof s.keys === "object") {
    /** @type {Record<string, string>} */
    const keys = {};
    for (const [prov, key] of Object.entries(s.keys)) {
      if (typeof key === "string" && key.trim()) keys[prov] = key.trim();
    }
    if (Object.keys(keys).length) {
      w.keys = keys;
      if (s.providerId) w.providerId = String(s.providerId);
      if (s.model) w.model = String(s.model);
    }
  }
  if (opts.settings) {
    /** @type {any} */
    const settings = {};
    if (typeof s.research === "boolean") settings.research = s.research;
    if (typeof s.bashLite === "boolean") settings.bashLite = s.bashLite;
    if (typeof s.developerMode === "boolean") settings.developerMode = s.developerMode;
    if (s.searchBackend && typeof s.searchBackend === "object") settings.searchBackend = s.searchBackend;
    if (typeof s.localBaseUrl === "string" && s.localBaseUrl) settings.localBaseUrl = s.localBaseUrl;
    if (Object.keys(settings).length) w.settings = settings;
  }
  if (opts.conversations && Array.isArray(s.conversations) && s.conversations.length) {
    w.conversations = s.conversations.map((/** @type {any} */ c) => ({
      title: typeof c.title === "string" ? c.title.slice(0, 80) : undefined,
      messages: (Array.isArray(c.messages) ? c.messages : [])
        .filter((/** @type {any} */ m) => m && typeof m.role === "string" && typeof m.content === "string")
        .map((/** @type {any} */ m) => ({ role: m.role, content: m.content })),
    }));
  }
  if (opts.grants && (opts.grants.ws || opts.grants.pool || (opts.grants.proxy && opts.grants.proxy.length))) {
    /** @type {any} */
    const grants = {};
    if (opts.grants.ws) grants.ws = String(opts.grants.ws);
    if (opts.grants.pool) grants.pool = String(opts.grants.pool);
    if (opts.grants.proxy && opts.grants.proxy.length) {
      grants.proxy = opts.grants.proxy
        .filter((p) => p && (p.svc === "web" || p.svc === "api") && typeof p.token === "string" && p.token)
        .map((p) => ({ svc: p.svc, token: p.token }));
      if (!grants.proxy.length) delete grants.proxy;
    }
    if (Object.keys(grants).length) w.grants = grants;
  }
  return w;
}

/**
 * Whether a built payload actually CARRIES anything beyond the envelope
 * metadata (`v`/`kind`/`name`) — the share pane's "tick at least one thing"
 * guard. The metadata-key knowledge lives here next to buildWorkspacePayload
 * so a future payload field can't silently drift the check.
 * @param {any} payload a buildWorkspacePayload result
 * @returns {number} the number of content-bearing keys
 */
export function workspacePayloadCarries(payload) {
  const w = payload && typeof payload === "object" ? payload : {};
  return Object.keys(w).filter((k) => k !== "v" && k !== "kind" && k !== "name").length;
}

/**
 * Apply an opened workspace payload onto a DRC state, IN PLACE (the receiving
 * half of buildWorkspacePayload). Conversations are APPENDED with fresh ids
 * (never clobbering the local session); keys/settings overwrite only the
 * fields the workspace actually carries. Grant tokens are NOT applied here —
 * they are returned for the page wiring to hydrate through the existing grant
 * paths (status read / exchange), which stay fail-soft and optional (the
 * workspace itself opens fully offline).
 * @param {any} state a DRC state (mutated)
 * @param {any} payload a validated workspace payload
 * @returns {{ state: any, grants: { ws: string|null, proxy: {svc: string, token: string}[], pool: string|null }, note: string|null, name: string|null }}
 */
export function applyWorkspacePayload(state, payload) {
  const w = payload || {};
  if (w.keys && typeof w.keys === "object") {
    if (!state.keys || typeof state.keys !== "object") state.keys = {};
    for (const [prov, key] of Object.entries(w.keys)) {
      if (typeof key === "string" && key.trim()) state.keys[prov] = key.trim();
    }
    if (typeof w.providerId === "string") state.providerId = w.providerId;
    if (typeof w.model === "string") state.model = w.model;
  }
  const s = w.settings || {};
  if (typeof s.research === "boolean") state.research = s.research;
  if (typeof s.bashLite === "boolean") state.bashLite = s.bashLite;
  if (typeof s.developerMode === "boolean") state.developerMode = s.developerMode;
  if (s.searchBackend && typeof s.searchBackend === "object") state.searchBackend = s.searchBackend;
  if (typeof s.localBaseUrl === "string") state.localBaseUrl = s.localBaseUrl;
  if (Array.isArray(w.conversations)) {
    for (const c of w.conversations) {
      const messages = (Array.isArray(c.messages) ? c.messages : []).filter(
        (/** @type {any} */ m) => m && typeof m.role === "string" && typeof m.content === "string",
      );
      if (!messages.length) continue;
      state.conversations.push({
        id: crypto.randomUUID(),
        title: (typeof c.title === "string" && c.title) || undefined,
        messages,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    }
  }
  return {
    state,
    grants: {
      ws: w.grants && typeof w.grants.ws === "string" ? w.grants.ws : null,
      proxy: w.grants && Array.isArray(w.grants.proxy) ? w.grants.proxy : [],
      pool: w.grants && typeof w.grants.pool === "string" ? w.grants.pool : null,
    },
    note: typeof w.note === "string" ? w.note : null,
    name: typeof w.name === "string" ? w.name : null,
  };
}
