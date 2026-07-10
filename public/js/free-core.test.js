import test from "node:test";
import assert from "node:assert/strict";
import {
  deriveFreeProfile,
  deriveFreeTitle,
  emptyFreeState,
  freeSecretValid,
  generateFreeSecret,
  migrateFreeState,
  openFreeState,
  sealFreeState,
  validateFreeState,
  FREE_STATE_KIND,
  FREE_STATE_V,
} from "./free-core.js";
import { deriveVaultLocator } from "./vault.js";

test("one secret, deterministic derivation, format-insensitive input", async () => {
  const secret = generateFreeSecret();
  assert.equal(freeSecretValid(secret), true);
  const a = await deriveFreeProfile(secret);
  const b = await deriveFreeProfile(secret.toLowerCase().replace(/-/g, " "));
  assert.equal(a.refHash, b.refHash);
  assert.equal(a.blobId, b.blobId);
  // Shapes: a short lowercase public reference; a long server-acceptable id.
  assert.match(a.refHash, /^[0-9a-z]{16}$/);
  assert.match(a.blobId, /^[0-9A-Z]{32}$/);
});

test("derived values are independent — and independent of the vault's", async () => {
  const secret = generateFreeSecret();
  const p = await deriveFreeProfile(secret);
  assert.notEqual(p.refHash.toUpperCase(), p.blobId);
  // The SAME secret used as a project-vault secret derives a DIFFERENT id —
  // the info strings partition the derivation spaces.
  const vault = await deriveVaultLocator(secret);
  assert.notEqual(vault.id, p.blobId);
});

test("different secrets never collide", async () => {
  const a = await deriveFreeProfile(generateFreeSecret());
  const b = await deriveFreeProfile(generateFreeSecret());
  assert.notEqual(a.blobId, b.blobId);
  assert.notEqual(a.refHash, b.refHash);
});

test("project state round-trips sealed under the blob key — API keys inside", async () => {
  const { blobKey } = await deriveFreeProfile(generateFreeSecret());
  const state = emptyFreeState();
  state.keys = { openai: "sk-test-openai", groq: "gsk-test-groq" };
  state.providerId = "groq";
  state.model = "llama-3.3-70b-versatile";
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
  // The keys are actually sealed — not readable in the stored form.
  const stored = new TextDecoder().decode(bytes);
  assert.equal(stored.includes("sk-test-openai"), false);
  const back = await openFreeState(bytes, blobKey);
  assert.equal(validateFreeState(back), true);
  assert.deepEqual(back, state);

  const { blobKey: wrong } = await deriveFreeProfile(generateFreeSecret());
  await assert.rejects(openFreeState(bytes, wrong));
});

test("validateFreeState accepts v1 and v2, rejects foreign shapes", () => {
  assert.equal(validateFreeState(emptyFreeState()), true);
  // A v1 blob (stored before keys moved into the state) still opens…
  const v1 = { v: 1, kind: FREE_STATE_KIND, updatedAt: 1, conversations: [] };
  assert.equal(validateFreeState(v1), true);
  // …and migrates to the current shape.
  const migrated = migrateFreeState({ ...v1 });
  assert.equal(migrated.v, FREE_STATE_V);
  assert.deepEqual(migrated.keys, {});
  assert.equal(migrated.research, true);

  assert.equal(validateFreeState(null), false);
  assert.equal(validateFreeState({}), false);
  assert.equal(validateFreeState({ ...emptyFreeState(), kind: "other" }), false);
  assert.equal(validateFreeState({ ...emptyFreeState(), keys: [] }), false);
  assert.equal(validateFreeState({ ...emptyFreeState(), conversations: [{ id: "c" }] }), false);
});

test("deriveFreeTitle uses the first non-empty user line", () => {
  assert.equal(deriveFreeTitle([{ role: "user", content: "\n  What is HKDF?\nmore" }]), "What is HKDF?");
  assert.equal(deriveFreeTitle([{ role: "assistant", content: "hi" }]), "New chat");
  assert.equal(deriveFreeTitle([{ role: "user", content: "x".repeat(200) }]).length, 80);
});
