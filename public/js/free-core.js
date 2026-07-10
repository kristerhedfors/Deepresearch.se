// Free mode's pure core (the /free page, public/free/free.js, wires it to
// the DOM): everything derivable and everything cryptographic, built on the
// project-vault primitives (vault.js) so free mode invents no new crypto.
//
// ONE master secret (the vault's DR1-… format — generated with the same
// 160-bit CSPRNG routine, saved in the user's password manager) is the
// user's entire keyring. HKDF-SHA-256 with INDEPENDENT info strings derives
// every downstream value, so no derived value reveals any other or the
// secret itself:
//
//   refHash — 80 bits, the PUBLIC project reference: the <hash> in
//       /free/project-<hash> and the username field the password manager
//       files the secret under. A bookmark label, deliberately NOT a
//       capability — knowing it grants nothing.
//   blobId / blobKey — where the encrypted project state rests
//       (/api/free/blob/:id) and the AES-256-GCM key it is sealed with.
//       The key never leaves the browser in any form.
//   keysId / unlock — where the encrypted provider-key bundle rests
//       (/api/free/keys/:id) and the 256-bit key it is sealed under. The
//       unlock key IS sent to the server, once per chat/models request, so
//       the server can decrypt the bundle transiently in memory and call
//       the provider with the user's own API key (src/free.js) — that is
//       the one deliberate exception to keys-stay-client-side, and it is
//       per-request and never at rest server-side.
//
// The project state blob reuses the vault's archive sealing verbatim
// (encryptVaultArchive/decryptVaultArchive — 12-byte IV + AES-256-GCM).

import {
  bytesToB64,
  decodeCrockford,
  decryptVaultArchive,
  encodeCrockford,
  encryptVaultArchive,
  generateVaultSecret,
  normalizeVaultSecret,
  vaultSecretValid,
} from "./vault.js";

export {
  generateVaultSecret as generateFreeSecret,
  normalizeVaultSecret,
  vaultSecretValid as freeSecretValid,
  bytesToB64,
};

export const FREE_STATE_KIND = "deepresearch-free-project";
export const FREE_STATE_V = 1;

// ---- derivation ---------------------------------------------------------------

async function hkdfMaster(secret) {
  const ikm = decodeCrockford(normalizeVaultSecret(secret));
  return crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits", "deriveKey"]);
}

const HKDF = (info) => ({
  name: "HKDF",
  hash: "SHA-256",
  salt: new Uint8Array(32),
  info: new TextEncoder().encode(info),
});

/**
 * Everything the /free page needs, from the one secret.
 * @param {string} secret
 * @returns {Promise<{refHash: string, blobId: string, blobKey: CryptoKey,
 *   keysId: string, unlock: string}>}
 */
export async function deriveFreeProfile(secret) {
  if (!vaultSecretValid(secret)) {
    throw new Error("That doesn't look like a valid secret (DR1-… with 32 characters).");
  }
  const master = await hkdfMaster(secret);
  const bits = (info, n) => crypto.subtle.deriveBits(HKDF(info), master, n);
  const refHash = encodeCrockford(new Uint8Array(await bits("deepresearch.se free ref v1", 80))).toLowerCase();
  const blobId = encodeCrockford(new Uint8Array(await bits("deepresearch.se free blob id v1", 160)));
  const keysId = encodeCrockford(new Uint8Array(await bits("deepresearch.se free keys id v1", 160)));
  const blobKey = await crypto.subtle.deriveKey(
    HKDF("deepresearch.se free blob key v1"),
    master,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
  const unlock = bytesToB64(new Uint8Array(await bits("deepresearch.se free unlock key v1", 256)));
  return { refHash, blobId, blobKey, keysId, unlock };
}

// ---- the provider-key bundle -----------------------------------------------------

// Seals {berget?, anthropic?, openai?} under the unlock key, client-side —
// the stored form PUT to /api/free/keys/:id. The server decrypts the same
// shape transiently per request (src/free.js openKeyBundle).
/**
 * @param {{berget?: string, anthropic?: string, openai?: string}} keys
 * @param {string} unlockB64
 * @returns {Promise<{iv: string, ciphertext: string}>}
 */
export async function sealKeyBundle(keys, unlockB64) {
  const key = await unlockKey(unlockB64, "encrypt");
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plain = new TextEncoder().encode(JSON.stringify(keys));
  const cipher = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plain);
  return { iv: bytesToB64(iv), ciphertext: bytesToB64(new Uint8Array(cipher)) };
}

// The client-side counterpart, so the page can show WHICH providers have a
// key stored (never the keys themselves) after unlocking on a new device.
/**
 * @param {{iv?: string, ciphertext?: string} | null | undefined} stored
 * @param {string} unlockB64
 * @returns {Promise<{berget?: string, anthropic?: string, openai?: string} | null>}
 */
export async function openKeyBundleLocal(stored, unlockB64) {
  if (typeof stored?.iv !== "string" || typeof stored?.ciphertext !== "string") return null;
  try {
    const key = await unlockKey(unlockB64, "decrypt");
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: b64ToBytes(stored.iv) },
      key,
      b64ToBytes(stored.ciphertext),
    );
    const keys = JSON.parse(new TextDecoder().decode(plain));
    return keys && typeof keys === "object" ? keys : null;
  } catch {
    return null;
  }
}

function unlockKey(unlockB64, usage) {
  const bytes = b64ToBytes(unlockB64);
  if (bytes.length !== 32) throw new Error("Bad unlock key.");
  return crypto.subtle.importKey("raw", bytes, { name: "AES-GCM" }, false, [usage]);
}

function b64ToBytes(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// ---- the project state --------------------------------------------------------

// {v, kind, updatedAt, model?, conversations: [{id, title, messages,
//  createdAt, updatedAt}]} — everything the page persists, sealed as one
// blob under blobKey. Conversations here are plain {role, content} text
// turns (free mode is a direct chat).
export function emptyFreeState() {
  return { v: FREE_STATE_V, kind: FREE_STATE_KIND, updatedAt: Date.now(), model: null, conversations: [] };
}

/** @param {any} s @returns {boolean} */
export function validateFreeState(s) {
  return !!(
    s &&
    typeof s === "object" &&
    s.v === FREE_STATE_V &&
    s.kind === FREE_STATE_KIND &&
    Array.isArray(s.conversations) &&
    s.conversations.every(
      (c) =>
        c &&
        typeof c.id === "string" &&
        Array.isArray(c.messages) &&
        c.messages.every((m) => m && typeof m.role === "string" && typeof m.content === "string"),
    )
  );
}

/**
 * @param {object} state
 * @param {CryptoKey} blobKey
 * @returns {Promise<Uint8Array>} the wire/stored form
 */
export function sealFreeState(state, blobKey) {
  return encryptVaultArchive(state, blobKey);
}

/**
 * @param {Uint8Array} bytes
 * @param {CryptoKey} blobKey
 * @returns {Promise<object>} throws on wrong key/tamper; caller validates shape
 */
export function openFreeState(bytes, blobKey) {
  return decryptVaultArchive(bytes, blobKey);
}

// A conversation's display title: its first user line, like the main app.
/** @param {{role: string, content: string}[]} messages */
export function deriveFreeTitle(messages) {
  const first = messages.find((m) => m.role === "user")?.content || "New chat";
  const line = first.split("\n").find((l) => l.trim()) || "New chat";
  return line.trim().slice(0, 80);
}
