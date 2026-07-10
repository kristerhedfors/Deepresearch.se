import test from "node:test";
import assert from "node:assert/strict";
import {
  deriveFreeProfile,
  deriveFreeTitle,
  emptyFreeState,
  freeSecretValid,
  generateFreeSecret,
  openFreeState,
  openKeyBundleLocal,
  sealFreeState,
  sealKeyBundle,
  validateFreeState,
} from "./free-core.js";
import { deriveVaultLocator } from "./vault.js";

test("one secret, deterministic derivation, format-insensitive input", async () => {
  const secret = generateFreeSecret();
  assert.equal(freeSecretValid(secret), true);
  const a = await deriveFreeProfile(secret);
  const b = await deriveFreeProfile(secret.toLowerCase().replace(/-/g, " "));
  assert.deepEqual(
    { refHash: a.refHash, blobId: a.blobId, keysId: a.keysId, unlock: a.unlock },
    { refHash: b.refHash, blobId: b.blobId, keysId: b.keysId, unlock: b.unlock },
  );
  // Shapes: a short lowercase public reference; long server-acceptable ids.
  assert.match(a.refHash, /^[0-9a-z]{16}$/);
  assert.match(a.blobId, /^[0-9A-Z]{32}$/);
  assert.match(a.keysId, /^[0-9A-Z]{32}$/);
  assert.equal(atob(a.unlock).length, 32);
});

test("every derived value is independent — and independent of the vault's", async () => {
  const secret = generateFreeSecret();
  const p = await deriveFreeProfile(secret);
  const values = [p.refHash.toUpperCase(), p.blobId, p.keysId];
  assert.equal(new Set(values).size, values.length);
  // The SAME secret used as a project-vault secret derives a DIFFERENT id —
  // the info strings partition the derivation spaces.
  const vault = await deriveVaultLocator(secret);
  assert.ok(!values.includes(vault.id));
});

test("different secrets never collide", async () => {
  const a = await deriveFreeProfile(generateFreeSecret());
  const b = await deriveFreeProfile(generateFreeSecret());
  assert.notEqual(a.blobId, b.blobId);
  assert.notEqual(a.refHash, b.refHash);
  assert.notEqual(a.unlock, b.unlock);
});

test("key bundle seals and opens under the unlock key; wrong key opens nothing", async () => {
  const { unlock } = await deriveFreeProfile(generateFreeSecret());
  const sealed = await sealKeyBundle({ berget: "sk-b", openai: "sk-o" }, unlock);
  assert.equal(typeof sealed.iv, "string");
  assert.equal(typeof sealed.ciphertext, "string");
  assert.equal(sealed.ciphertext.includes("sk-b"), false); // actually encrypted
  assert.deepEqual(await openKeyBundleLocal(sealed, unlock), { berget: "sk-b", openai: "sk-o" });

  const { unlock: other } = await deriveFreeProfile(generateFreeSecret());
  assert.equal(await openKeyBundleLocal(sealed, other), null);
  assert.equal(await openKeyBundleLocal(null, unlock), null);
});

test("project state round-trips sealed under the blob key", async () => {
  const { blobKey } = await deriveFreeProfile(generateFreeSecret());
  const state = emptyFreeState();
  state.conversations.push({
    id: "c1",
    title: "Test",
    messages: [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ],
    createdAt: 1,
    updatedAt: 2,
  });
  const bytes = await sealFreeState(state, blobKey);
  const back = await openFreeState(bytes, blobKey);
  assert.equal(validateFreeState(back), true);
  assert.deepEqual(back, state);

  const { blobKey: wrong } = await deriveFreeProfile(generateFreeSecret());
  await assert.rejects(openFreeState(bytes, wrong));
});

test("validateFreeState rejects foreign shapes", () => {
  assert.equal(validateFreeState(emptyFreeState()), true);
  assert.equal(validateFreeState(null), false);
  assert.equal(validateFreeState({}), false);
  assert.equal(validateFreeState({ ...emptyFreeState(), kind: "other" }), false);
  assert.equal(validateFreeState({ ...emptyFreeState(), conversations: [{ id: "c" }] }), false);
  assert.equal(
    validateFreeState({ ...emptyFreeState(), conversations: [{ id: "c", messages: [{ role: 1, content: "x" }] }] }),
    false,
  );
});

test("deriveFreeTitle uses the first non-empty user line", () => {
  assert.equal(deriveFreeTitle([{ role: "user", content: "\n  What is HKDF?\nmore" }]), "What is HKDF?");
  assert.equal(deriveFreeTitle([{ role: "assistant", content: "hi" }]), "New chat");
  assert.equal(deriveFreeTitle([{ role: "user", content: "x".repeat(200) }]).length, 80);
});
