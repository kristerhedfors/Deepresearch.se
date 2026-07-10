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
//
// The provider API keys (OpenAI / Groq) live INSIDE the sealed state and
// go straight from the browser to the provider (free-providers.js) — the
// Deepresearch server never sees them in any form, encrypted or not, and
// is never in the chat path at all. The state blob reuses the vault's
// archive sealing verbatim (encryptVaultArchive/decryptVaultArchive —
// 12-byte IV + AES-256-GCM).

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
export const FREE_STATE_V = 2; // v2 moved the provider keys into the sealed state

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
 * @returns {Promise<{refHash: string, blobId: string, blobKey: CryptoKey}>}
 */
export async function deriveFreeProfile(secret) {
  if (!vaultSecretValid(secret)) {
    throw new Error("That doesn't look like a valid secret (DR1-… with 32 characters).");
  }
  const master = await hkdfMaster(secret);
  const bits = (info, n) => crypto.subtle.deriveBits(HKDF(info), master, n);
  const refHash = encodeCrockford(new Uint8Array(await bits("deepresearch.se free ref v1", 80))).toLowerCase();
  const blobId = encodeCrockford(new Uint8Array(await bits("deepresearch.se free blob id v1", 160)));
  const blobKey = await crypto.subtle.deriveKey(
    HKDF("deepresearch.se free blob key v1"),
    master,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
  return { refHash, blobId, blobKey };
}

// ---- the project state --------------------------------------------------------

// {v, kind, updatedAt, keys: {openai?, groq?}, providerId?, model?,
//  research, conversations: [{id, title, messages, createdAt, updatedAt}]}
// — everything the page persists, the provider API keys included, sealed
// as one blob under blobKey. Conversations are plain {role, content} text
// turns.
export function emptyFreeState() {
  return {
    v: FREE_STATE_V,
    kind: FREE_STATE_KIND,
    updatedAt: Date.now(),
    keys: {},
    providerId: null,
    model: null,
    research: true,
    conversations: [],
  };
}

/** @param {any} s @returns {boolean} */
export function validateFreeState(s) {
  const ok = !!(
    s &&
    typeof s === "object" &&
    (s.v === 1 || s.v === FREE_STATE_V) && // v1 blobs (no keys field) still open
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
  return ok && (s.keys === undefined || (s.keys && typeof s.keys === "object" && !Array.isArray(s.keys)));
}

/** Upgrades any accepted stored shape to the current one, in place. */
export function migrateFreeState(s) {
  s.v = FREE_STATE_V;
  if (!s.keys || typeof s.keys !== "object") s.keys = {};
  if (s.research === undefined) s.research = true;
  if (s.providerId === undefined) s.providerId = null;
  return s;
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
