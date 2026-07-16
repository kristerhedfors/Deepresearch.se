// The project vault's PURE CORE: secret generation/normalization, the
// Crockford base32 codec, HKDF locator/key derivation, archive
// encrypt/decrypt, the archive-shape check, and the chunked base64 helpers.
// Split out of vault.js (2026-07-11) so the CLIENT-SIDE tier can use the
// crypto without dragging in the DRS storage stack: DRC's drc-core.js builds
// its derivations on these primitives, and vault.js's store/load
// orchestration statically imports history-store.js / opfs.js / projects.js /
// rag.js — modules that are NOT public assets, so having them in the /cure
// module graph 401s for anonymous visitors and kills the whole client tier's
// JS (the drc-rag.js/bash-agent.js breakage class in src/index.js's
// isPublicAsset; found live 2026-07-11 — /cure served a dead graph with the
// static "d5" stamp because vault.js pulled the DRS chain in). This module
// imports NOTHING, is served publicly (allowlisted), and is import-safe in
// Node (vault.test.js exercises it through vault.js's re-exports).
//
// The secret is the whole key hierarchy:
//   secret (160 bits, CSPRNG)
//     ├─ HKDF-SHA-256(info="…vault id v1")  → the storage id (locator)
//     └─ HKDF-SHA-256(info="…vault key v1") → the AES-256-GCM key
// Knowing the secret is both finding the blob and decrypting it; the server
// never sees the secret or the key. The info strings are FROZEN — changing
// them breaks every stored secret.
//
// Secret format (generateVaultSecret): "DR1-" + 8 groups of 4 chars from the
// Crockford base32 alphabet (no I, L, O, U — nothing that misreads as 1 or
// 0), 160 bits from crypto.getRandomValues. Copy-safe by construction:
// case-insensitive, separators ignored, and the classic transcription
// mistakes (O for 0, I/l for 1) are mapped back on input
// (normalizeVaultSecret) — a secret read over the phone or retyped from
// paper still works.

// ---- the secret -----------------------------------------------------------------

// Crockford base32: digits + uppercase letters minus I, L, O, U. 32 symbols
// = 5 bits each; 32 chars = 160 bits.
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const SECRET_BYTES = 20; // 160 bits
const SECRET_CHARS = (SECRET_BYTES * 8) / 5; // 32
const PREFIX = "DR1"; // marks what the string is; not part of the entropy

/** 160 bits from the CSPRNG, formatted "DR1-XXXX-XXXX-…" (8 groups of 4). */
export function generateVaultSecret() {
  const bytes = crypto.getRandomValues(new Uint8Array(SECRET_BYTES));
  const chars = encodeCrockford(bytes);
  return PREFIX + "-" + (chars.match(/.{4}/g) || []).join("-");
}

/**
 * Forgiving input normalization: uppercase, every separator dropped, the
 * "DR1" prefix stripped when present, and the classic misreads mapped back
 * (O→0, I→1, L→1). Returns the bare 32-char payload for a well-formed
 * secret; anything else comes back as-is-cleaned for vaultSecretValid to
 * reject.
 * @param {string} input
 * @returns {string}
 */
export function normalizeVaultSecret(input) {
  let s = String(input || "").toUpperCase().replace(/[^0-9A-Z]/g, "");
  // Map misreads BEFORE the prefix check, so even a mangled prefix
  // ("DRl-…", "DRi-…") is recognized and stripped.
  s = s.replace(/O/g, "0").replace(/[IL]/g, "1");
  if (s.length === SECRET_CHARS + PREFIX.length && s.startsWith(PREFIX)) s = s.slice(PREFIX.length);
  return s;
}

/** @param {string} input @returns {boolean} */
export function vaultSecretValid(input) {
  const s = normalizeVaultSecret(input);
  return s.length === SECRET_CHARS && [...s].every((c) => ALPHABET.includes(c));
}

/** @param {Uint8Array} bytes @returns {string} bit-exact base32, no padding */
export function encodeCrockford(bytes) {
  let out = "";
  let acc = 0;
  let nbits = 0;
  for (const b of bytes) {
    acc = (acc << 8) | b;
    nbits += 8;
    while (nbits >= 5) {
      out += ALPHABET[(acc >>> (nbits - 5)) & 31];
      nbits -= 5;
    }
  }
  if (nbits > 0) out += ALPHABET[(acc << (5 - nbits)) & 31];
  return out;
}

/** @param {string} s normalized base32 @returns {Uint8Array} */
export function decodeCrockford(s) {
  const out = new Uint8Array(Math.floor((s.length * 5) / 8));
  let acc = 0;
  let nbits = 0;
  let i = 0;
  for (const c of s) {
    const v = ALPHABET.indexOf(c);
    if (v < 0) throw new Error("Invalid character in secret: " + c);
    acc = (acc << 5) | v;
    nbits += 5;
    if (nbits >= 8) {
      out[i++] = (acc >>> (nbits - 8)) & 0xff;
      nbits -= 8;
    }
  }
  return out;
}

// ---- key derivation & the encrypted blob ---------------------------------------

// HKDF-SHA-256 over the secret's raw 160 bits, two independent outputs by
// info string. No salt needed: the IKM is itself uniform CSPRNG output.
/**
 * @param {string} secret
 * @returns {Promise<{id: string, key: CryptoKey}>}
 */
export async function deriveVaultLocator(secret) {
  if (!vaultSecretValid(secret)) throw new Error("That doesn't look like a valid vault secret.");
  const ikm = decodeCrockford(normalizeVaultSecret(secret));
  const master = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits", "deriveKey"]);
  const salt = new Uint8Array(32);
  const idBits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt, info: new TextEncoder().encode("deepresearch.se vault id v1") },
    master,
    160,
  );
  const key = await crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt, info: new TextEncoder().encode("deepresearch.se vault key v1") },
    master,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
  return { id: encodeCrockford(new Uint8Array(idBits)), key };
}

/**
 * Archive object → one opaque byte blob: 12-byte IV + AES-256-GCM
 * ciphertext (tag included). The stored form and the wire form are the
 * same bytes.
 * @param {object} archive
 * @param {CryptoKey} key
 * @returns {Promise<Uint8Array>}
 */
export async function encryptVaultArchive(archive, key) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plain = new TextEncoder().encode(JSON.stringify(archive));
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plain));
  const out = new Uint8Array(12 + cipher.length);
  out.set(iv, 0);
  out.set(cipher, 12);
  return out;
}

/**
 * @param {Uint8Array} bytes
 * @param {CryptoKey} key
 * @returns {Promise<object>} throws on tamper/wrong key (GCM authenticates)
 */
export async function decryptVaultArchive(bytes, key) {
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: bytes.slice(0, 12) },
    key,
    bytes.slice(12),
  );
  return JSON.parse(new TextDecoder().decode(plain));
}

// ---- the archive shape ------------------------------------------------------------

// {v: 1, kind, exportedAt, project: {id, name, files, …},
//  conversations: [{id, data}], files: [{id, name, type, bytes(b64)}],
//  ragDocs: [{docId, name, chunks, vectors}]}
export const ARCHIVE_KIND = "deepresearch-project";

/**
 * Structural check on a decrypted archive before anything is imported.
 * @param {any} a
 * @returns {boolean}
 */
export function validateVaultArchive(a) {
  return !!(
    a &&
    typeof a === "object" &&
    a.v === 1 &&
    a.kind === ARCHIVE_KIND &&
    a.project &&
    typeof a.project === "object" &&
    typeof a.project.id === "string" &&
    a.project.id &&
    typeof a.project.name === "string" &&
    Array.isArray(a.conversations) &&
    a.conversations.every((c) => c && typeof c.id === "string" && c.data && typeof c.data === "object") &&
    Array.isArray(a.files) &&
    a.files.every((f) => f && typeof f.id === "string" && typeof f.bytes === "string") &&
    Array.isArray(a.ragDocs) &&
    a.ragDocs.every((d) => d && typeof d.docId === "string" && Array.isArray(d.chunks) && Array.isArray(d.vectors))
  );
}

// Chunked base64 for file-sized buffers (String.fromCharCode over a whole
// multi-MB array overflows the argument list).
/** @param {Uint8Array} bytes @returns {string} */
export function bytesToB64(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

/** @param {string} b64 @returns {Uint8Array} */
export function b64ToBytes(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
