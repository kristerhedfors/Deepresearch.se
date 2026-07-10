import test from "node:test";
import assert from "node:assert/strict";
import {
  ARCHIVE_KIND,
  b64ToBytes,
  bytesToB64,
  decodeCrockford,
  decryptVaultArchive,
  deriveVaultLocator,
  encodeCrockford,
  encryptVaultArchive,
  generateVaultSecret,
  normalizeVaultSecret,
  validateVaultArchive,
  vaultSecretValid,
} from "./vault.js";

// ---- secret generation ---------------------------------------------------------

test("generated secrets have the documented copy-safe format", () => {
  for (let i = 0; i < 50; i++) {
    const s = generateVaultSecret();
    // DR1- prefix + 8 groups of 4 Crockford chars (no I, L, O, U anywhere).
    assert.match(s, /^DR1(-[0-9ABCDEFGHJKMNPQRSTVWXYZ]{4}){8}$/);
    assert.doesNotMatch(s.slice(4), /[ILOU]/);
    assert.equal(vaultSecretValid(s), true);
  }
});

test("generated secrets are unique (160 bits of CSPRNG entropy)", () => {
  const seen = new Set();
  for (let i = 0; i < 200; i++) seen.add(generateVaultSecret());
  assert.equal(seen.size, 200);
});

test("secret payloads use the full alphabet over many draws", () => {
  // Sanity check against a broken encoder that only ever emits a few
  // symbols: 200 secrets × 32 chars must cover (almost) all 32 symbols.
  const chars = new Set();
  for (let i = 0; i < 200; i++) {
    for (const c of normalizeVaultSecret(generateVaultSecret())) chars.add(c);
  }
  assert.ok(chars.size >= 30, `only ${chars.size} distinct symbols seen`);
});

// ---- normalization (the copy-safety promises) -----------------------------------

test("normalization forgives case, separators, and the classic misreads", () => {
  const secret = generateVaultSecret();
  const bare = normalizeVaultSecret(secret);
  assert.equal(bare.length, 32);
  // lowercase, mixed separators, extra whitespace
  assert.equal(normalizeVaultSecret(secret.toLowerCase()), bare);
  assert.equal(normalizeVaultSecret(secret.replace(/-/g, " ")), bare);
  assert.equal(normalizeVaultSecret("  " + secret.replace(/-/g, "_") + "  "), bare);
  // pasted without the prefix
  assert.equal(normalizeVaultSecret(bare), bare);
  // O read for 0, I/l read for 1
  const mangled = secret.replace(/0/g, "O").replace(/1/g, "i");
  assert.equal(normalizeVaultSecret(mangled), bare);
  assert.equal(vaultSecretValid(mangled), true);
});

test("a bare payload that happens to start with DR1 is not mis-stripped", () => {
  const bare = "DR1" + "A".repeat(29); // exactly 32 chars, no prefix intended
  assert.equal(normalizeVaultSecret(bare), bare);
  assert.equal(vaultSecretValid(bare), true);
});

test("invalid secrets are rejected", () => {
  assert.equal(vaultSecretValid(""), false);
  assert.equal(vaultSecretValid("DR1-TOO-SHORT"), false);
  assert.equal(vaultSecretValid("A".repeat(31)), false);
  assert.equal(vaultSecretValid("A".repeat(33)), false);
  assert.equal(vaultSecretValid("U".repeat(32)), false); // U is not in the alphabet
});

// ---- the Crockford codec ---------------------------------------------------------

test("encode/decode round-trips arbitrary bytes", () => {
  for (const len of [1, 5, 20, 33, 64]) {
    const bytes = crypto.getRandomValues(new Uint8Array(len));
    const decoded = decodeCrockford(encodeCrockford(bytes));
    assert.deepEqual(decoded.subarray(0, len), bytes, `len ${len}`);
  }
});

test("20 bytes encode to exactly 32 chars (bit-exact, no padding)", () => {
  assert.equal(encodeCrockford(new Uint8Array(20)).length, 32);
  assert.equal(encodeCrockford(new Uint8Array(20)), "0".repeat(32));
});

// ---- key/id derivation ------------------------------------------------------------

test("derivation is deterministic and input-format-insensitive", async () => {
  const secret = generateVaultSecret();
  const a = await deriveVaultLocator(secret);
  const b = await deriveVaultLocator(secret.toLowerCase().replace(/-/g, " "));
  assert.equal(a.id, b.id);
  // The id is a 32-char Crockford string — accepted by the server's
  // /^[A-Za-z0-9_-]{16,80}$/ gate and safe in a URL path.
  assert.match(a.id, /^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{32}$/);
});

test("different secrets derive different ids and keys", async () => {
  const a = await deriveVaultLocator(generateVaultSecret());
  const b = await deriveVaultLocator(generateVaultSecret());
  assert.notEqual(a.id, b.id);
});

test("the id is not the secret — deriving rejects malformed input", async () => {
  await assert.rejects(deriveVaultLocator("not-a-secret"), /valid vault secret/);
});

// ---- the encrypted blob -------------------------------------------------------------

test("encrypt/decrypt round-trips an archive; tampering is detected", async () => {
  const { key } = await deriveVaultLocator(generateVaultSecret());
  const archive = { v: 1, kind: ARCHIVE_KIND, project: { id: "p1", name: "Test" }, conversations: [], files: [], ragDocs: [] };
  const blob = await encryptVaultArchive(archive, key);
  assert.ok(blob.length > 12 + 16);
  assert.deepEqual(await decryptVaultArchive(blob, key), archive);

  const tampered = blob.slice();
  tampered[tampered.length - 1] ^= 0x01;
  await assert.rejects(decryptVaultArchive(tampered, key));
});

test("a different secret's key cannot decrypt the blob", async () => {
  const { key } = await deriveVaultLocator(generateVaultSecret());
  const { key: other } = await deriveVaultLocator(generateVaultSecret());
  const blob = await encryptVaultArchive({ hello: "world" }, key);
  await assert.rejects(decryptVaultArchive(blob, other));
});

// ---- archive validation ---------------------------------------------------------------

function minimalArchive() {
  return {
    v: 1,
    kind: ARCHIVE_KIND,
    exportedAt: 1,
    project: { id: "p1", name: "Test" },
    conversations: [{ id: "c1", data: { title: "t", updatedAt: 1 } }],
    files: [{ id: "f1", name: "a.txt", type: "text/plain", bytes: "aGVq" }],
    ragDocs: [{ docId: "f1", name: "a.txt", chunks: [], vectors: [] }],
  };
}

test("validateVaultArchive accepts the documented shape", () => {
  assert.equal(validateVaultArchive(minimalArchive()), true);
  const empty = { ...minimalArchive(), conversations: [], files: [], ragDocs: [] };
  assert.equal(validateVaultArchive(empty), true);
});

test("validateVaultArchive rejects everything else", () => {
  assert.equal(validateVaultArchive(null), false);
  assert.equal(validateVaultArchive({}), false);
  assert.equal(validateVaultArchive({ ...minimalArchive(), v: 2 }), false);
  assert.equal(validateVaultArchive({ ...minimalArchive(), kind: "zip" }), false);
  assert.equal(validateVaultArchive({ ...minimalArchive(), project: null }), false);
  assert.equal(validateVaultArchive({ ...minimalArchive(), project: { id: "", name: "x" } }), false);
  assert.equal(validateVaultArchive({ ...minimalArchive(), conversations: [{ id: "c1" }] }), false);
  assert.equal(validateVaultArchive({ ...minimalArchive(), files: [{ id: "f1" }] }), false);
  assert.equal(validateVaultArchive({ ...minimalArchive(), ragDocs: [{ docId: "d" }] }), false);
});

// ---- base64 helpers ----------------------------------------------------------------------

test("bytesToB64/b64ToBytes round-trip, including chunk-boundary sizes", () => {
  for (const len of [0, 1, 0x8000 - 1, 0x8000, 0x8000 + 1, 200_000]) {
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) bytes[i] = (i * 31) & 0xff;
    assert.deepEqual(b64ToBytes(bytesToB64(bytes)), bytes, `len ${len}`);
  }
});
