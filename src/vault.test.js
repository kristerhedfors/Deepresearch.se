import test from "node:test";
import assert from "node:assert/strict";
import { handleVault, vaultIdOk, MAX_VAULT_OBJECTS, VAULT_MIN_BYTES } from "./vault.js";

// In-memory stand-in for the R2 binding — just enough surface for vault.js.
function mockBucket() {
  const store = new Map();
  return {
    async get(key) {
      const v = store.get(key);
      return v ? { body: v.bytes, customMetadata: v.meta } : null;
    },
    async head(key) {
      return store.has(key) ? {} : null;
    },
    async put(key, bytes, opts) {
      store.set(key, { bytes, meta: opts?.customMetadata || {} });
    },
    async delete(key) {
      store.delete(key);
    },
    async list({ prefix }) {
      const objects = [...store.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key }));
      return { objects, truncated: false };
    },
    _store: store,
  };
}

const log = { debug() {}, info() {}, warn() {}, error() {} };
const VALID_ID = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // 32 chars, the client's Crockford shape

function makeEnv() {
  return { STORAGE: mockBucket() };
}

function identityFor(settingsJson = null) {
  return { id: "user:7", role: "user", email: null, name: null, user: { id: 7, settings_json: settingsJson } };
}

function call(env, identity, method, id, body) {
  const url = new URL("https://example.test/api/vault/" + encodeURIComponent(id));
  const request = new Request(url, { method, body });
  return handleVault(request, env, url, log, identity);
}

test("vaultIdOk accepts the client's derived-id shape and rejects junk", () => {
  assert.equal(vaultIdOk(VALID_ID), true);
  assert.equal(vaultIdOk("a".repeat(16)), true);
  assert.equal(vaultIdOk("a".repeat(80)), true);
  assert.equal(vaultIdOk("short"), false); // too short to be a derived id
  assert.equal(vaultIdOk("a".repeat(81)), false);
  assert.equal(vaultIdOk("has/slash-in-it-1"), false);
  assert.equal(vaultIdOk("has.dot-in-it-123"), false);
  assert.equal(vaultIdOk(""), false);
  assert.equal(vaultIdOk(null), false);
});

test("503 when the R2 binding is missing or the identity has no user row", async () => {
  const noBinding = await call({}, identityFor(), "GET", VALID_ID);
  assert.equal(noBinding.status, 503);
  const breakGlass = await call(makeEnv(), { id: "admin", role: "admin", user: null }, "GET", VALID_ID);
  assert.equal(breakGlass.status, 503);
});

test("invalid vault id is rejected before touching storage", async () => {
  const res = await call(makeEnv(), identityFor(), "GET", "short");
  assert.equal(res.status, 400);
});

test("PUT then GET round-trips the opaque bytes; DELETE removes them", async () => {
  const env = makeEnv();
  const identity = identityFor();
  const blob = crypto.getRandomValues(new Uint8Array(64)); // opaque ciphertext stand-in

  const put = await call(env, identity, "PUT", VALID_ID, blob);
  assert.equal(put.status, 200);
  const putBody = await put.json();
  assert.equal(putBody.ok, true);
  assert.equal(putBody.size, 64);

  const get = await call(env, identity, "GET", VALID_ID);
  assert.equal(get.status, 200);
  assert.equal(get.headers.get("content-type"), "application/octet-stream");
  assert.ok(get.headers.get("x-vault-updated"));
  assert.deepEqual(new Uint8Array(await get.arrayBuffer()), blob);

  const del = await call(env, identity, "DELETE", VALID_ID);
  assert.equal(del.status, 204);
  const gone = await call(env, identity, "GET", VALID_ID);
  assert.equal(gone.status, 404);
});

test("GET of a never-stored id is a 404", async () => {
  const res = await call(makeEnv(), identityFor(), "GET", VALID_ID);
  assert.equal(res.status, 404);
});

test("a body too small to be an AES-GCM blob is rejected", async () => {
  const res = await call(makeEnv(), identityFor(), "PUT", VALID_ID, new Uint8Array(VAULT_MIN_BYTES - 1));
  assert.equal(res.status, 400);
});

test("an over-cap declared content-length is rejected without reading the body", async () => {
  const env = makeEnv();
  const url = new URL("https://example.test/api/vault/" + VALID_ID);
  // Duck-typed request: a real Request recomputes content-length from the
  // body, so the declared-length path needs a hand-rolled header.
  const request = {
    method: "PUT",
    headers: new Headers({ "content-length": String(200 * 1024 * 1024) }),
    arrayBuffer: async () => {
      throw new Error("body must not be read");
    },
  };
  const res = await handleVault(request, env, url, log, identityFor());
  assert.equal(res.status, 413);
});

test("the vault ignores legacy settings flags — it is consent-per-PUT, not knob-gated", async () => {
  const env = makeEnv();
  const identity = identityFor(JSON.stringify({ server_history: false }));
  const put = await call(env, identity, "PUT", VALID_ID, new Uint8Array(64));
  assert.equal(put.status, 200);
  const get = await call(env, identity, "GET", VALID_ID);
  assert.equal(get.status, 200);
});

test("per-user object cap blocks NEW ids but allows overwriting an existing one", async () => {
  const env = makeEnv();
  const identity = identityFor();
  for (let i = 0; i < MAX_VAULT_OBJECTS; i++) {
    env.STORAGE._store.set(`vault/7/existing-${String(i).padStart(12, "0")}`, {
      bytes: new Uint8Array(64),
      meta: {},
    });
  }
  const blocked = await call(env, identity, "PUT", VALID_ID, new Uint8Array(64));
  assert.equal(blocked.status, 409);
  const overwrite = await call(env, identity, "PUT", "existing-000000000001", new Uint8Array(64));
  assert.equal(overwrite.status, 200);
});

test("objects are namespaced per user — another account cannot read them", async () => {
  const env = makeEnv();
  await call(env, identityFor(), "PUT", VALID_ID, new Uint8Array(64));
  const other = { id: "user:8", role: "user", user: { id: 8 } };
  const res = await call(env, other, "GET", VALID_ID);
  assert.equal(res.status, 404);
});
