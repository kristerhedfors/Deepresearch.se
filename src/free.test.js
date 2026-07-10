import test from "node:test";
import assert from "node:assert/strict";
import { freeIdOk, handleFreeApi, FREE_BLOB_MIN_BYTES, FREE_BLOB_MAX_BYTES } from "./free.js";

// Free mode's server surface is deliberately tiny: ONE capability-addressed
// ciphertext store. Everything else (provider calls, the research pipeline)
// runs in the browser — tested in public/js/free-*.test.js.

function mockBucket() {
  const store = new Map();
  return {
    async get(key) {
      const v = store.get(key);
      return v ? { body: v.bytes, customMetadata: v.meta } : null;
    },
    async put(key, bytes, opts) {
      store.set(key, { bytes: new Uint8Array(bytes), meta: opts?.customMetadata || {} });
    },
    async delete(key) {
      store.delete(key);
    },
    _store: store,
  };
}

const log = { debug() {}, info() {}, warn() {}, error() {} };
const VALID_ID = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function call(env, method, path, body, headers = {}) {
  const url = new URL("https://example.test" + path);
  return handleFreeApi(new Request(url, { method, body, headers }), env, url, log);
}

test("freeIdOk mirrors the vault id shape", () => {
  assert.equal(freeIdOk(VALID_ID), true);
  assert.equal(freeIdOk("short"), false);
  assert.equal(freeIdOk("a/b----------------"), false);
  assert.equal(freeIdOk(null), false);
});

test("503 without the R2 binding", async () => {
  const res = await call({}, "GET", "/api/free/blob/" + VALID_ID);
  assert.equal(res.status, 503);
});

test("blob PUT/GET/DELETE round-trip; the body is opaque bytes", async () => {
  const env = { STORAGE: mockBucket() };
  const blob = crypto.getRandomValues(new Uint8Array(64));

  const put = await call(env, "PUT", "/api/free/blob/" + VALID_ID, blob);
  assert.equal(put.status, 200);
  assert.equal((await put.json()).ok, true);

  const get = await call(env, "GET", "/api/free/blob/" + VALID_ID);
  assert.equal(get.status, 200);
  assert.equal(get.headers.get("content-type"), "application/octet-stream");
  assert.ok(get.headers.get("x-free-updated"));
  assert.deepEqual(new Uint8Array(await get.arrayBuffer()), blob);

  const del = await call(env, "DELETE", "/api/free/blob/" + VALID_ID);
  assert.equal(del.status, 204);
  assert.equal((await call(env, "GET", "/api/free/blob/" + VALID_ID)).status, 404);
});

test("size floor and declared-length ceiling are enforced", async () => {
  const env = { STORAGE: mockBucket() };
  const tiny = await call(env, "PUT", "/api/free/blob/" + VALID_ID, new Uint8Array(FREE_BLOB_MIN_BYTES - 1));
  assert.equal(tiny.status, 400);

  const url = new URL("https://example.test/api/free/blob/" + VALID_ID);
  const res = await handleFreeApi(
    {
      method: "PUT",
      headers: new Headers({ "content-length": String(FREE_BLOB_MAX_BYTES + 1) }),
      arrayBuffer: async () => {
        throw new Error("body must not be read");
      },
    },
    env,
    url,
    log,
  );
  assert.equal(res.status, 413);
});

test("invalid ids and unknown kinds are rejected", async () => {
  const env = { STORAGE: mockBucket() };
  assert.equal((await call(env, "GET", "/api/free/blob/short")).status, 400);
  assert.equal((await call(env, "GET", "/api/free/keys/" + VALID_ID)).status, 404); // the old keys family is gone
  assert.equal((await call(env, "POST", "/api/free/chat", "{}")).status, 404); // no server chat path exists
  assert.equal((await call(env, "GET", "/api/free/blob/" + VALID_ID + "/extra")).status, 404);
});
