import test from "node:test";
import assert from "node:assert/strict";
import {
  deleteSealedProject,
  drcStoreAvailable,
  getSealedProject,
  listSealedProjects,
  putSealedProject,
} from "./drc-store.js";

// A Storage-shaped mock (the adapter's injectable backend — in the browser
// it's localStorage).
function mockStorage() {
  const map = new Map();
  return {
    get length() {
      return map.size;
    },
    key: (i) => [...map.keys()][i] ?? null,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    _map: map,
  };
}

test("availability follows the backend", () => {
  assert.equal(drcStoreAvailable(mockStorage()), true);
  assert.equal(drcStoreAvailable(null), false);
});

test("put/get/delete round-trip sealed bytes", () => {
  const s = mockStorage();
  const bytes = new Uint8Array(100_000); // chunk-boundary territory
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31) & 0xff;
  assert.equal(putSealedProject("BLOB1BLOB1BLOB1BLOB1", bytes, s), true);
  assert.deepEqual(getSealedProject("BLOB1BLOB1BLOB1BLOB1", s), bytes);
  deleteSealedProject("BLOB1BLOB1BLOB1BLOB1", s);
  assert.equal(getSealedProject("BLOB1BLOB1BLOB1BLOB1", s), null);
});

test("only ciphertext-bearing base64 rests in the backend", () => {
  const s = mockStorage();
  putSealedProject("IDID", new TextEncoder().encode("this is sealed input"), s);
  const stored = [...s._map.values()][0];
  assert.match(stored, /^[A-Za-z0-9+/=]+$/); // base64, not raw text
});

test("listSealedProjects returns only this adapter's ids", () => {
  const s = mockStorage();
  s.setItem("unrelated", "x");
  putSealedProject("AAAA", new Uint8Array(32), s);
  putSealedProject("BBBB", new Uint8Array(32), s);
  assert.deepEqual(listSealedProjects(s).sort(), ["AAAA", "BBBB"]);
});

test("fail-soft: no backend, quota errors, and corrupted rows never throw", () => {
  assert.equal(putSealedProject("X", new Uint8Array(8), null), false);
  assert.equal(getSealedProject("X", null), null);
  assert.deepEqual(listSealedProjects(null), []);
  deleteSealedProject("X", null); // no throw

  const full = mockStorage();
  full.setItem = () => {
    throw new Error("QuotaExceededError");
  };
  assert.equal(putSealedProject("X", new Uint8Array(8), full), false);

  const corrupt = mockStorage();
  corrupt.setItem("drc:project:BAD", "%%%not-base64%%%");
  assert.equal(getSealedProject("BAD", corrupt), null);
});
