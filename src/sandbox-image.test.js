import test from "node:test";
import assert from "node:assert/strict";
import {
  handleSandboxImage,
  handleSandboxImageConfig,
  imagePath,
  parseRange,
  resolveSelectedImage,
} from "./sandbox-image.js";

// ---- parseRange ------------------------------------------------------------

test("parseRange handles the forms CheerpX issues and rejects junk", () => {
  assert.deepEqual(parseRange("bytes=0-99"), { offset: 0, length: 100 });
  assert.deepEqual(parseRange("bytes=100-100"), { offset: 100, length: 1 });
  assert.deepEqual(parseRange("bytes=500-"), { offset: 500 }); // open-ended → to end
  assert.deepEqual(parseRange("bytes=-256"), { suffix: 256 }); // last N bytes
  assert.equal(parseRange(null), null);
  assert.equal(parseRange(""), null);
  assert.equal(parseRange("bytes=-"), null); // no numbers at all
  assert.equal(parseRange("bytes=abc-def"), null);
  assert.equal(parseRange("bytes=50-10"), null); // end < start
  assert.equal(parseRange("bytes=0-10,20-30"), null); // multi-range → whole object
  assert.equal(parseRange("items=0-10"), null);
});

// ---- resolveSelectedImage --------------------------------------------------

test("resolveSelectedImage returns empty for no config / unknown id, url for a known id", () => {
  assert.deepEqual(resolveSelectedImage({}), { id: "", url: "", prefetch: false });
  const cfg = {
    sandbox: {
      image: "alpine-i386",
      prefetch: true,
      images: [{ id: "alpine-i386", label: "Alpine", arch: "i386", size_mb: 180, verified: true }],
    },
  };
  assert.deepEqual(resolveSelectedImage(cfg), {
    id: "alpine-i386",
    url: "/sandbox/img/alpine-i386.ext2",
    prefetch: true,
  });
  // Selected id not in the registry → degrade to the built-in default.
  const bad = { sandbox: { image: "ghost", prefetch: true, images: [{ id: "alpine-i386" }] } };
  assert.deepEqual(resolveSelectedImage(bad), { id: "", url: "", prefetch: false });
});

test("imagePath maps an id to its served path", () => {
  assert.equal(imagePath("alpine-i386-2026-07"), "/sandbox/img/alpine-i386-2026-07.ext2");
});

// ---- handleSandboxImageConfig ---------------------------------------------

test("GET /api/sandbox-image reports the selection (empty without a DB)", async () => {
  const res = await handleSandboxImageConfig({}); // no DB → getConfig returns defaults
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body, { id: "", url: "", prefetch: false });
  assert.match(res.headers.get("cache-control") || "", /max-age=60/);
});

// ---- handleSandboxImage (R2 stream) ---------------------------------------

function mockBucket(entries = {}) {
  const store = new Map(Object.entries(entries));
  return {
    async get(key, opts) {
      const v = store.get(key);
      if (!v) return null;
      const size = v.length;
      const obj = {
        body: v,
        size,
        httpEtag: '"etag-' + size + '"',
        writeHttpMetadata(h) { h.set("x-r2", "1"); },
        range: null,
      };
      if (opts && opts.range) {
        const r = opts.range;
        const offset = r.suffix != null ? size - r.suffix : r.offset || 0;
        const length = r.suffix != null ? r.suffix : r.length != null ? r.length : size - offset;
        obj.range = { offset, length };
        obj.body = v.slice(offset, offset + length);
      }
      return obj;
    },
  };
}

const IMG = "sandbox-images/alpine-i386.ext2";

test("503 without a STORAGE binding, 400 for a bad id", async () => {
  const req = new Request("https://x.test/sandbox/img/alpine-i386.ext2");
  assert.equal((await handleSandboxImage(req, {}, "alpine-i386")).status, 503);
  const env = { STORAGE: mockBucket() };
  assert.equal((await handleSandboxImage(req, env, "Bad/Id")).status, 400);
});

test("404 for a missing image", async () => {
  const env = { STORAGE: mockBucket() };
  const req = new Request("https://x.test/sandbox/img/alpine-i386.ext2");
  assert.equal((await handleSandboxImage(req, env, "alpine-i386")).status, 404);
});

test("full GET streams the whole image with immutable + range-capable headers", async () => {
  const bytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  const env = { STORAGE: mockBucket({ [IMG]: bytes }) };
  const req = new Request("https://x.test/sandbox/img/alpine-i386.ext2");
  const res = await handleSandboxImage(req, env, "alpine-i386");
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("accept-ranges"), "bytes");
  assert.equal(res.headers.get("content-type"), "application/octet-stream");
  assert.match(res.headers.get("cache-control") || "", /immutable/);
  assert.equal(res.headers.get("cross-origin-resource-policy"), "same-origin");
  assert.equal(res.headers.get("content-length"), "10");
  const out = new Uint8Array(await res.arrayBuffer());
  assert.deepEqual([...out], [...bytes]);
});

test("range GET returns 206 Partial Content with a correct Content-Range", async () => {
  const bytes = new Uint8Array([10, 20, 30, 40, 50, 60, 70, 80]);
  const env = { STORAGE: mockBucket({ [IMG]: bytes }) };
  const req = new Request("https://x.test/sandbox/img/alpine-i386.ext2", {
    headers: { range: "bytes=2-4" },
  });
  const res = await handleSandboxImage(req, env, "alpine-i386");
  assert.equal(res.status, 206);
  assert.equal(res.headers.get("content-range"), "bytes 2-4/8");
  assert.equal(res.headers.get("content-length"), "3");
  const out = new Uint8Array(await res.arrayBuffer());
  assert.deepEqual([...out], [30, 40, 50]);
});

test("HEAD returns size headers and no body", async () => {
  const bytes = new Uint8Array(42);
  const env = { STORAGE: mockBucket({ [IMG]: bytes }) };
  const req = new Request("https://x.test/sandbox/img/alpine-i386.ext2", { method: "HEAD" });
  const res = await handleSandboxImage(req, env, "alpine-i386");
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-length"), "42");
  assert.equal(await res.text(), "");
});
