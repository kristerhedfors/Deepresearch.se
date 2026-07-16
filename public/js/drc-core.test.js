import test from "node:test";
import assert from "node:assert/strict";
import {
  deriveDrcProfile,
  deriveDrcTitle,
  drcBackupFileName,
  emptyDrcState,
  drcSecretValid,
  generateDrcSecret,
  migrateDrcState,
  openDrcBackup,
  openDrcState,
  sealDrcState,
  validateDrcState,
  DRC_STATE_KIND,
  DRC_STATE_V,
} from "./drc-core.js";
import { deriveVaultLocator } from "./vault.js";

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

test("validateDrcState accepts v1/v2/v3/v4, rejects foreign shapes", () => {
  assert.equal(validateDrcState(emptyDrcState()), true);
  // A v1 blob (stored before keys moved into the state) still opens…
  const v1 = { v: 1, kind: DRC_STATE_KIND, updatedAt: 1, conversations: [] };
  assert.equal(validateDrcState(v1), true);
  // …as does a v2 blob (stored before the RAG index existed)…
  const v2 = { v: 2, kind: DRC_STATE_KIND, updatedAt: 1, keys: {}, conversations: [] };
  assert.equal(validateDrcState(v2), true);
  // …and a v3 blob (stored before the local model server URL existed)…
  const v3 = { v: 3, kind: DRC_STATE_KIND, updatedAt: 1, keys: {}, conversations: [], rag: { docs: [] } };
  assert.equal(validateDrcState(v3), true);
  // …and all migrate to the current shape, gaining an empty RAG index and
  // an unset local server URL.
  for (const old of [v1, v2, v3]) {
    const migrated = migrateDrcState({ ...old });
    assert.equal(migrated.v, DRC_STATE_V);
    assert.deepEqual(migrated.keys, {});
    assert.equal(migrated.research, true);
    assert.deepEqual(migrated.rag, { docs: [] });
    assert.equal(migrated.localBaseUrl, "");
  }

  assert.equal(validateDrcState(null), false);
  assert.equal(validateDrcState({}), false);
  assert.equal(validateDrcState({ ...emptyDrcState(), kind: "other" }), false);
  assert.equal(validateDrcState({ ...emptyDrcState(), keys: [] }), false);
  assert.equal(validateDrcState({ ...emptyDrcState(), rag: [] }), false);
  assert.equal(validateDrcState({ ...emptyDrcState(), rag: { docs: null } }), false);
  assert.equal(validateDrcState({ ...emptyDrcState(), conversations: [{ id: "c" }] }), false);
  assert.equal(validateDrcState({ ...emptyDrcState(), localBaseUrl: 42 }), false);
});

test(".drc backup: filename, round-trip via the secret, wrong-secret/tamper fail-soft", async () => {
  assert.equal(drcBackupFileName("abc123"), "project-abc123.drc");

  const secret = generateDrcSecret();
  const { blobKey } = await deriveDrcProfile(secret);
  const state = emptyDrcState();
  state.keys = { openai: "sk-test-backup" };
  state.conversations.push({
    id: "c1",
    title: "Backup me",
    messages: [{ role: "user", content: "hi" }],
    createdAt: 1,
    updatedAt: 2,
  });
  const bytes = await sealDrcState(state, blobKey);

  // The backup opens with the secret alone — the file IS the sealed blob.
  const opened = await openDrcBackup(bytes, secret);
  assert.ok(opened);
  assert.deepEqual(opened.state.keys, { openai: "sk-test-backup" });
  assert.equal(opened.state.conversations[0].title, "Backup me");
  assert.equal(opened.state.v, DRC_STATE_V); // migrated on open
  const { blobId } = await deriveDrcProfile(secret);
  assert.equal(opened.profile.blobId, blobId); // restorable under the derived id

  // Wrong secret and tampered bytes both fail soft to null, never throw.
  assert.equal(await openDrcBackup(bytes, generateDrcSecret()), null);
  const tampered = new Uint8Array(bytes);
  tampered[tampered.length - 1] ^= 0xff;
  assert.equal(await openDrcBackup(tampered, secret), null);
  assert.equal(await openDrcBackup(bytes, "not-a-secret"), null);
});

test("deriveDrcTitle uses the first non-empty user line", () => {
  assert.equal(deriveDrcTitle([{ role: "user", content: "\n  What is HKDF?\nmore" }]), "What is HKDF?");
  assert.equal(deriveDrcTitle([{ role: "assistant", content: "hi" }]), "New chat");
  assert.equal(deriveDrcTitle([{ role: "user", content: "x".repeat(200) }]).length, 80);
});

test("v5 onDevice: absent (older blobs) migrates to false, non-boolean rejects", () => {
  const v4 = { ...emptyDrcState(), v: 4 };
  delete v4.onDevice;
  assert.equal(validateDrcState(v4), true); // a v4 blob still opens
  const migrated = migrateDrcState({ ...v4 });
  assert.equal(migrated.v, DRC_STATE_V);
  assert.equal(migrated.onDevice, false); // default OFF — the bandwidth guarantee
  assert.equal(validateDrcState({ ...emptyDrcState(), onDevice: true }), true);
  assert.equal(validateDrcState({ ...emptyDrcState(), onDevice: "yes" }), false);
});

test("budgetS (the time slider): absent migrates to the 60 s default, non-number rejects", () => {
  // Additive field, no version bump: absent-reads-as-60s keeps every older
  // sealed blob opening AND behaving exactly as before the slider.
  const older = { ...emptyDrcState() };
  delete older.budgetS;
  assert.equal(validateDrcState(older), true);
  const migrated = migrateDrcState({ ...older });
  assert.equal(migrated.budgetS, 60);
  assert.equal(emptyDrcState().budgetS, 60);
  assert.equal(validateDrcState({ ...emptyDrcState(), budgetS: 480 }), true);
  assert.equal(validateDrcState({ ...emptyDrcState(), budgetS: "long" }), false);
  // The interim depth-tier shape (stored a tier ID for less than a day) maps
  // onto the time scale it stood for — and the stale field is dropped.
  for (const [depth, s] of [["brief", 30], ["standard", 60], ["extended", 240], ["full", 480], ["bogus", 60]]) {
    const interim = { ...emptyDrcState(), depth };
    delete interim.budgetS;
    const out = migrateDrcState(interim);
    assert.equal(out.budgetS, s, depth);
    assert.equal("depth" in out, false, depth);
  }
});
