// @ts-check
// DRC's storage adapter — BROWSER-LOCAL ONLY, by product definition: DRC
// ("deep research secure", C for CLIENT-side) keeps everything on the
// user's machine. The sealed project state (drc-core.js: AES-256-GCM
// under the secret-derived blob key) rests in this browser's localStorage
// as base64, keyed by the secret-derived blob id — so what's on disk is
// ciphertext exactly like every other at-rest surface of this site, and
// nothing project-derived ever reaches the server (which, for DRC, serves
// static files and public replay JSONs and NOTHING else).
//
// This module is deliberately the SEAM: everything above it (the page
// wiring) speaks get/put/delete-by-id, so a future opt-in remote copy —
// DRS territory — would be a second adapter, not a rewrite. The backend
// is injectable for Node tests (any Storage-shaped object); the default
// is this browser's localStorage.
//
// localStorage over IndexedDB, a deliberate judgement call: DRC states
// are text conversations (no attached-file bytes — those are DRS
// features), so the ~5 MB quota is generous, and the synchronous
// key-value API keeps this adapter small enough to audit at a glance.

const PREFIX = "drc:project:"; // + blobId → base64(sealed bytes)

/** @returns {Storage | null} */
function defaultBackend() {
  try {
    return typeof localStorage !== "undefined" ? localStorage : null;
  } catch {
    return null; // storage blocked (some private modes) — DRC degrades to tab-memory
  }
}

export function drcStoreAvailable(backend = defaultBackend()) {
  return !!backend;
}

/**
 * @param {string} blobId
 * @param {Uint8Array} bytes the sealed state (drc-core sealFreeState output)
 * @param {Storage | null} [backend]
 * @returns {boolean} false when storage is unavailable/full — callers keep
 *   working from memory and say so, never throw at the user
 */
export function putSealedProject(blobId, bytes, backend = defaultBackend()) {
  if (!backend) return false;
  try {
    backend.setItem(PREFIX + blobId, bytesToB64(bytes));
    return true;
  } catch {
    return false; // quota — the tab-memory copy remains authoritative
  }
}

/**
 * @param {string} blobId
 * @param {Storage | null} [backend]
 * @returns {Uint8Array | null}
 */
export function getSealedProject(blobId, backend = defaultBackend()) {
  if (!backend) return null;
  const b64 = backend.getItem(PREFIX + blobId);
  if (!b64) return null;
  try {
    return b64ToBytes(b64);
  } catch {
    return null; // corrupted row — treat as absent rather than crash the open
  }
}

/** @param {string} blobId @param {Storage | null} [backend] */
export function deleteSealedProject(blobId, backend = defaultBackend()) {
  backend?.removeItem(PREFIX + blobId);
}

/**
 * The blob ids stored in this browser — lets the page say "N saved
 * project(s) on this device" without being able to name or read any.
 * @param {Storage | null} [backend]
 * @returns {string[]}
 */
export function listSealedProjects(backend = defaultBackend()) {
  if (!backend) return [];
  const ids = [];
  for (let i = 0; i < backend.length; i++) {
    const key = backend.key(i);
    if (key && key.startsWith(PREFIX)) ids.push(key.slice(PREFIX.length));
  }
  return ids;
}

// Chunked base64 (multi-hundred-KB states are normal; one big
// String.fromCharCode overflows the argument list).
/** @param {Uint8Array} bytes */
function bytesToB64(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    // `apply` over a typed-array view: the arg list is number-like at
    // runtime, but its static type is Uint8Array, not number[].
    binary += String.fromCharCode.apply(null, /** @type {any} */ (bytes.subarray(i, i + 0x8000)));
  }
  return btoa(binary);
}

/** @param {string} b64 */
function b64ToBytes(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
