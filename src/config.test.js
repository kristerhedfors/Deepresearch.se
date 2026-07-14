import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CONFIG, mergeConfig } from "./config.js";

// The sandbox-image config branch of mergeConfig (the sanitizer behind the admin
// PUT /api/admin/config). The rest of mergeConfig (quotas/websearch/proxy) is
// exercised via the endpoints; this pins the new sandbox validation.

test("sandbox: registers valid rows, drops malformed ones, caps the list", () => {
  const patch = {
    sandbox: {
      images: [
        { id: "alpine-i386", label: "Alpine", arch: "i386", size_mb: 180, verified: true },
        { id: "BAD ID", label: "x" }, // invalid id → dropped
        { label: "no id" }, // no id → dropped
        { id: "debian-slim", arch: "i386" }, // label defaults to id, size 0, unverified
      ],
    },
  };
  const out = mergeConfig(DEFAULT_CONFIG, patch);
  assert.equal(out.sandbox.images.length, 2);
  assert.deepEqual(out.sandbox.images[0], {
    id: "alpine-i386", label: "Alpine", arch: "i386", size_mb: 180, verified: true,
  });
  assert.deepEqual(out.sandbox.images[1], {
    id: "debian-slim", label: "debian-slim", arch: "i386", size_mb: 0, verified: false,
  });
});

test("sandbox: the selected image must be a registered id, else falls back to ''", () => {
  const withImg = mergeConfig(DEFAULT_CONFIG, {
    sandbox: { images: [{ id: "alpine-i386" }], image: "alpine-i386" },
  });
  assert.equal(withImg.sandbox.image, "alpine-i386");

  const unknown = mergeConfig(DEFAULT_CONFIG, {
    sandbox: { images: [{ id: "alpine-i386" }], image: "ghost" },
  });
  assert.equal(unknown.sandbox.image, ""); // not registered → built-in default
});

test("sandbox: id is lowercased and hostile fields are clamped", () => {
  const out = mergeConfig(DEFAULT_CONFIG, {
    sandbox: {
      images: [{ id: "Alpine-I386", label: "x".repeat(200), arch: "z".repeat(50), size_mb: -5, verified: "yes" }],
    },
  });
  const im = out.sandbox.images[0];
  assert.equal(im.id, "alpine-i386");
  assert.equal(im.label.length, 80);
  assert.equal(im.arch.length, 16);
  assert.equal(im.size_mb, 0); // negatives clamped to 0
  assert.equal(im.verified, false); // only literal true counts
});

test("sandbox: prefetch coerces to boolean; base config is not mutated", () => {
  const before = structuredClone(DEFAULT_CONFIG);
  const out = mergeConfig(DEFAULT_CONFIG, { sandbox: { prefetch: true } });
  assert.equal(out.sandbox.prefetch, true);
  assert.deepEqual(DEFAULT_CONFIG, before); // mergeConfig clones, never mutates base
  assert.equal(out.sandbox.image, ""); // default preserved
  assert.deepEqual(out.sandbox.images, []);
});

test("sandbox: an image list can be cleared by sending an empty array", () => {
  const seeded = mergeConfig(DEFAULT_CONFIG, { sandbox: { images: [{ id: "alpine-i386" }] } });
  const cleared = mergeConfig(seeded, { sandbox: { images: [] } });
  assert.deepEqual(cleared.sandbox.images, []);
});
