import test from "node:test";
import assert from "node:assert/strict";
import {
  deriveDrcProfile,
  deriveDrcTitle,
  emptyDrcState,
  drcSecretValid,
  generateDrcSecret,
  migrateDrcState,
  openDrcState,
  sealDrcState,
  validateDrcState,
  DRC_STATE_KIND,
  DRC_STATE_V,
} from "./drc-core.js";
import { deriveVaultLocator } from "./vault-core.js";

test("one secret, deterministic derivation, format-insensitive input", async () => {
  const secret = generateDrcSecret();
  assert.equal(drcSecretValid(secret), true);
  const a = await deriveDrcProfile(secret);
  const b = await deriveDrcProfile(secret.toLowerCase().replace(/-/g, " "));
  assert.equal(a.refHash, b.refHash);
  assert.equal(a.blobId, b.blobId);
  // Shapes: a short lowercase public reference; a long server-acceptable id.
  assert.match(a.refHash, /^[0-9a-z]{16}$/);
  assert.match(a.blobId, /^[0-9A-Z]{32}$/);
});

test("derived values are independent — and independent of the vault's", async () => {
  const secret = generateDrcSecret();
  const p = await deriveDrcProfile(secret);
  assert.notEqual(p.refHash.toUpperCase(), p.blobId);
  // The SAME secret used as a project-vault secret derives a DIFFERENT id —
  // the info strings partition the derivation spaces.
  const vault = await deriveVaultLocator(secret);
  assert.notEqual(vault.id, p.blobId);
});

test("different secrets never collide", async () => {
  const a = await deriveDrcProfile(generateDrcSecret());
  const b = await deriveDrcProfile(generateDrcSecret());
  assert.notEqual(a.blobId, b.blobId);
  assert.notEqual(a.refHash, b.refHash);
});

test("project state round-trips sealed under the blob key — API keys inside", async () => {
  const { blobKey } = await deriveDrcProfile(generateDrcSecret());
  const state = emptyDrcState();
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
  state.rag = {
    embedder: { provider: "openai", model: "text-embedding-3-small", dims: 512 },
    docs: [{ id: "chat-c1", name: "Test", kind: "chat", srcMsgs: 2, updatedAt: 2, chunks: [{ seq: 0, text: "hi hello", m: 2 }], vectors: ["AAAA"] }],
  };
  const bytes = await sealDrcState(state, blobKey);
  // The keys are actually sealed — not readable in the stored form. Same
  // for the RAG index: DRC's chunk text rests as ciphertext (stricter than
  // DRS's readable-when-indexed exception — no server ever needs it).
  const stored = new TextDecoder().decode(bytes);
  assert.equal(stored.includes("sk-test-openai"), false);
  assert.equal(stored.includes("hi hello"), false);
  const back = await openDrcState(bytes, blobKey);
  assert.equal(validateDrcState(back), true);
  assert.deepEqual(back, state);

  const { blobKey: wrong } = await deriveDrcProfile(generateDrcSecret());
  await assert.rejects(openDrcState(bytes, wrong));
});

test("validateDrcState accepts v1/v2/v3, rejects foreign shapes", () => {
  assert.equal(validateDrcState(emptyDrcState()), true);
  // A v1 blob (stored before keys moved into the state) still opens…
  const v1 = { v: 1, kind: DRC_STATE_KIND, updatedAt: 1, conversations: [] };
  assert.equal(validateDrcState(v1), true);
  // …as does a v2 blob (stored before the RAG index existed)…
  const v2 = { v: 2, kind: DRC_STATE_KIND, updatedAt: 1, keys: {}, conversations: [] };
  assert.equal(validateDrcState(v2), true);
  // …and both migrate to the current shape, gaining an empty RAG index.
  for (const old of [v1, v2]) {
    const migrated = migrateDrcState({ ...old });
    assert.equal(migrated.v, DRC_STATE_V);
    assert.deepEqual(migrated.keys, {});
    assert.equal(migrated.research, true);
    assert.deepEqual(migrated.rag, { docs: [] });
  }

  assert.equal(validateDrcState(null), false);
  assert.equal(validateDrcState({}), false);
  assert.equal(validateDrcState({ ...emptyDrcState(), kind: "other" }), false);
  assert.equal(validateDrcState({ ...emptyDrcState(), keys: [] }), false);
  assert.equal(validateDrcState({ ...emptyDrcState(), rag: [] }), false);
  assert.equal(validateDrcState({ ...emptyDrcState(), rag: { docs: null } }), false);
  assert.equal(validateDrcState({ ...emptyDrcState(), conversations: [{ id: "c" }] }), false);
});

test("deriveDrcTitle uses the first non-empty user line", () => {
  assert.equal(deriveDrcTitle([{ role: "user", content: "\n  What is HKDF?\nmore" }]), "What is HKDF?");
  assert.equal(deriveDrcTitle([{ role: "assistant", content: "hi" }]), "New chat");
  assert.equal(deriveDrcTitle([{ role: "user", content: "x".repeat(200) }]).length, 80);
});
