// @ts-check
// DRCR/1's PURE CORE — the crowd-research (distributed secure workspace)
// result-sealing crypto and QR chunk framing. This is the SEED of the crowd
// model specified in docs/CROWD-RESEARCH.md: an organizer fans out invite
// links (DRSW workspaces carrying a per-campaign project PUBLIC key); each
// participant researches in their own Se/cure session, then SEALS their
// conclusion TO that public key and channels it back (QR / link / file). Only
// the organizer — holder of the matching private key — can open it.
//
// WHY ASYMMETRIC (the one new primitive in the stack). Every other crypto path
// here is symmetric password-KDF: workspace-core.js (hacka.re envelope),
// vault-core.js (HKDF from a shared secret), proxy-bundle.js (a shared AES
// key in the URL anchor). Sealing a result so that ONLY the organizer can
// read it — while the participant, and anyone who photographs the returned QR,
// holds only the public key — needs public-key crypto. This module adds it as
// a COMPOSITION of primitives already in the repo (ECDH → HKDF → AES-256-GCM,
// the vault's HKDF-then-GCM shape made asymmetric), not a new primitive to
// audit. It is a standard ECIES sealed box.
//
// CIPHER SUITE 1 (the only suite in DRCR/1): ECDH P-256 · HKDF-SHA-256 ·
// AES-256-GCM. Chosen because WebCrypto ships all three identically in the
// Worker, the browser, and Node >= 18 — the same constraint that fixed DRSW
// on AES-GCM — and because it adds NO dependency (minimal-deps invariant).
//
// WebCrypto only (crypto.subtle + getRandomValues) — import-safe and
// Node-testable unchanged, same as workspace-core.js / vault-core.js /
// proxy-bundle.js. Opening is FAIL-CLOSED by contract: openResult returns null
// on any problem (bad base64, wrong key, tampered ciphertext, malformed JSON,
// kid mismatch) — never throws, never a partial apply.
//
// Spec + workflow: docs/CROWD-RESEARCH.md. Schema: docs/schemas/drcr-result-1.schema.json.

import { b64urlDecode, b64urlEncode, sha256hex } from "./proxy-bundle.js";

// ---- frozen constants (changing any breaks compatibility with sealed results) ----
const CURVE = "P-256"; // NIST P-256 / secp256r1 — WebCrypto's baseline ECDH curve
const RAW_PUBKEY_LEN = 65; // uncompressed point: 0x04 || X(32) || Y(32)
const SHARED_BITS = 256; // ECDH deriveBits length (the X coordinate, 32 bytes)
const AES_KEY_BYTES = 32; // AES-256
const GCM_IV_BYTES = 12; // AES-GCM standard IV
// HKDF info string — FROZEN. Binds derived keys to this exact use.
const HKDF_INFO = "deepresearch.se/drcr result seal v1";

export const RESULT_KIND = "drcr-result";
export const RESULT_V = 1;
export const RESULT_HASH_PARAM = "r"; // …/campaign/return#r=<envelope-b64url>
export const CHUNK_PREFIX = "drcr1"; // QR chunk framing:  drcr1:<i>/<n>:<slice>

const te = new TextEncoder();
const td = new TextDecoder();

// (sha256hex is imported from proxy-bundle.js — the shared WebCrypto leaf both
// seal cores already sit on; each core keeps its OWN HKDF info / kind binding.)

// ---- the project keypair -------------------------------------------------------

/**
 * Generate a per-campaign project keypair. The PUBLIC key travels in every
 * invite link (campaign.pubkey); the PRIVATE key stays with the organizer and
 * is the only thing that can open returned results.
 * @returns {Promise<CryptoKeyPair>}
 */
export function generateProjectKeypair() {
  return crypto.subtle.generateKey({ name: "ECDH", namedCurve: CURVE }, true, [
    "deriveBits",
  ]);
}

/**
 * Export a project public key as base64url of the raw uncompressed point
 * (65 bytes). This string is what goes into an invite link's campaign.pubkey.
 * @param {CryptoKey} publicKey
 * @returns {Promise<string>}
 */
export async function exportProjectPublicKey(publicKey) {
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", publicKey));
  return b64urlEncode(raw);
}

/**
 * The campaign key id: first 8 lowercase-hex chars of SHA-256(raw public key).
 * A routing hint only (never a secret, never load-bearing for security — the
 * envelope authenticates cryptographically). Accepts the base64url pubkey
 * string or the raw bytes.
 * @param {string | Uint8Array} pubkey
 * @returns {Promise<string>}
 */
export async function projectKid(pubkey) {
  const raw = typeof pubkey === "string" ? b64urlDecode(pubkey) : pubkey;
  return (await sha256hex(raw)).slice(0, 8);
}

/**
 * Import a base64url raw public key for use as an ECDH recipient key.
 * @param {string} pubkeyB64
 * @returns {Promise<CryptoKey>}
 */
function importPublicKey(pubkeyB64) {
  const raw = b64urlDecode(pubkeyB64);
  if (raw.length !== RAW_PUBKEY_LEN || raw[0] !== 0x04) {
    throw new Error("bad project public key");
  }
  return crypto.subtle.importKey("raw", new Uint8Array(raw), { name: "ECDH", namedCurve: CURVE }, false, []);
}

// ---- the shared HKDF-then-GCM key ----------------------------------------------

/**
 * Derive the AES-256-GCM key from an ECDH shared secret, bound to the
 * ephemeral public key (as HKDF salt) and this use (HKDF info). Identical on
 * both sides — the seal derives it from (eph.private, recipient), the open
 * derives it from (project.private, eph.public); ECDH makes those the same 32
 * bytes.
 * @param {CryptoKey} privateKey @param {CryptoKey} peerPublicKey
 * @param {Uint8Array} ephPublicRaw  the ephemeral public key bytes (HKDF salt)
 * @returns {Promise<CryptoKey>}
 */
async function deriveAesKey(privateKey, peerPublicKey, ephPublicRaw) {
  const shared = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "ECDH", public: peerPublicKey },
      privateKey,
      SHARED_BITS,
    ),
  );
  const hkdfKey = await crypto.subtle.importKey("raw", new Uint8Array(shared), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(ephPublicRaw), info: new Uint8Array(te.encode(HKDF_INFO)) },
    hkdfKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

// ---- seal / open ---------------------------------------------------------------

/**
 * Seal a JSON-serializable result to a project public key. Returns the DRCR/1
 * result envelope object (all base64url fields). A fresh ephemeral keypair per
 * call gives per-result forward secrecy.
 * @param {any} result  the result plaintext (see docs/CROWD-RESEARCH.md §5.3)
 * @param {string} projectPubkeyB64  base64url raw project public key
 * @returns {Promise<{ v: number, kind: string, kid: string, epk: string, iv: string, ct: string }>}
 */
export async function sealResult(result, projectPubkeyB64) {
  const recipient = await importPublicKey(projectPubkeyB64);
  const eph = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: CURVE }, true, [
    "deriveBits",
  ]);
  const ephPublicRaw = new Uint8Array(await crypto.subtle.exportKey("raw", eph.publicKey));
  const key = await deriveAesKey(eph.privateKey, recipient, ephPublicRaw);
  const iv = crypto.getRandomValues(new Uint8Array(GCM_IV_BYTES));
  const pt = te.encode(JSON.stringify(result));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: new Uint8Array(iv) }, key, new Uint8Array(pt)),
  );
  return {
    v: RESULT_V,
    kind: RESULT_KIND,
    kid: await projectKid(b64urlDecode(projectPubkeyB64)),
    epk: b64urlEncode(ephPublicRaw),
    iv: b64urlEncode(iv),
    ct: b64urlEncode(ct),
  };
}

/**
 * Open a DRCR/1 result envelope with the organizer's project private key.
 * FAIL-CLOSED: returns null on any problem (malformed envelope, wrong key,
 * tampered ciphertext, malformed JSON) — never throws, never a partial result.
 * @param {any} envelope  the object from sealResult (or JSON.parse of it)
 * @param {CryptoKey} projectPrivateKey
 * @returns {Promise<any | null>}
 */
export async function openResult(envelope, projectPrivateKey) {
  try {
    if (!envelope || envelope.kind !== RESULT_KIND || envelope.v !== RESULT_V) return null;
    if (!envelope.epk || !envelope.iv || !envelope.ct) return null;
    const ephRaw = b64urlDecode(envelope.epk);
    if (ephRaw.length !== RAW_PUBKEY_LEN || ephRaw[0] !== 0x04) return null;
    const ephPublic = await crypto.subtle.importKey(
      "raw",
      new Uint8Array(ephRaw),
      { name: "ECDH", namedCurve: CURVE },
      false,
      [],
    );
    const key = await deriveAesKey(projectPrivateKey, ephPublic, ephRaw);
    const pt = new Uint8Array(
      await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: new Uint8Array(b64urlDecode(envelope.iv)) },
        key,
        new Uint8Array(b64urlDecode(envelope.ct)),
      ),
    );
    return JSON.parse(td.decode(pt));
  } catch {
    return null;
  }
}

/**
 * Structural check of a result envelope (before attempting decrypt). Cheap,
 * throws nothing — a shape gate for the relay endpoint and the QR reader.
 * @param {any} envelope
 * @returns {boolean}
 */
export function validateResultEnvelope(envelope) {
  return !!(
    envelope &&
    envelope.kind === RESULT_KIND &&
    envelope.v === RESULT_V &&
    typeof envelope.kid === "string" &&
    typeof envelope.epk === "string" &&
    typeof envelope.iv === "string" &&
    typeof envelope.ct === "string"
  );
}

// ---- QR chunk framing (docs/CROWD-RESEARCH.md §6.1) ----------------------------

/**
 * Split a string (the base64url envelope) into n QR-sized chunks, each framed
 * `drcr1:<i>/<n>:<slice>` (1-based i). Chunks are order-independent and
 * idempotent on receipt (keyed by i), so a looping QR reel is self-healing.
 * @param {string} text  the payload to carry (e.g. base64url of the envelope)
 * @param {number} [maxSlice=1200]  max slice length per chunk (envelope chars, not counting the frame)
 * @returns {string[]}
 */
export function chunkResult(text, maxSlice = 1200) {
  const s = String(text);
  const size = Math.max(1, Math.floor(maxSlice));
  const n = Math.max(1, Math.ceil(s.length / size));
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push(`${CHUNK_PREFIX}:${i + 1}/${n}:${s.slice(i * size, (i + 1) * size)}`);
  }
  return out;
}

/**
 * Reassemble chunks produced by chunkResult. Accepts them in any order, with
 * duplicates. Returns the concatenated string once ALL 1..n are present, else
 * null (a reader keeps scanning). FAIL-CLOSED on inconsistent framing.
 * @param {string[]} chunks
 * @returns {string | null}
 */
export function reassembleChunks(chunks) {
  if (!Array.isArray(chunks) || chunks.length === 0) return null;
  /** @type {Map<number, string>} */
  const parts = new Map();
  let total = null;
  for (const raw of chunks) {
    const m = /^drcr1:(\d+)\/(\d+):([\s\S]*)$/.exec(String(raw));
    if (!m) return null; // foreign framing → fail closed
    const i = Number(m[1]);
    const n = Number(m[2]);
    if (i < 1 || n < 1 || i > n) return null;
    if (total === null) total = n;
    else if (total !== n) return null; // chunks from different reels
    // idempotent: last write wins, but identical slices are the norm
    parts.set(i, m[3]);
  }
  if (total === null) return null;
  if (parts.size !== total) return null; // still missing frames
  let s = "";
  for (let i = 1; i <= total; i++) {
    if (!parts.has(i)) return null;
    s += parts.get(i);
  }
  return s;
}
