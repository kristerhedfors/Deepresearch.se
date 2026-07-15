// The canonical-origin redirect (src/canonical.js) — previously inline in the
// untested entrypoint. The properties exercised: http and/or www 301s to the
// https apex with path + query preserved (the Firefox Focus OAuth
// redirect_uri_mismatch protection), and an already-canonical URL passes
// through (null — the router falls through to normal dispatch).
import test from "node:test";
import assert from "node:assert/strict";
import { canonicalRedirect } from "./canonical.js";

test("plain http 301s to the https apex, path + query preserved", () => {
  const res = canonicalRedirect(new URL("http://deepresearch.se/cure?ws=tok#frag"));
  assert.equal(res?.status, 301);
  assert.equal(res?.headers.get("Location"), "https://deepresearch.se/cure?ws=tok#frag");
});

test("www strips to the apex", () => {
  const res = canonicalRedirect(new URL("https://www.deepresearch.se/rver"));
  assert.equal(res?.status, 301);
  assert.equal(res?.headers.get("Location"), "https://deepresearch.se/rver");
});

test("http + www canonicalizes both in one hop", () => {
  const res = canonicalRedirect(new URL("http://www.deepresearch.se/login?next=%2Frver"));
  assert.equal(res?.status, 301);
  assert.equal(res?.headers.get("Location"), "https://deepresearch.se/login?next=%2Frver");
});

test("the canonical https apex passes through (null)", () => {
  assert.equal(canonicalRedirect(new URL("https://deepresearch.se/")), null);
  assert.equal(canonicalRedirect(new URL("https://deepresearch.se/api/chat")), null);
});

test("only a www. PREFIX strips — a www elsewhere in the host is untouched", () => {
  assert.equal(canonicalRedirect(new URL("https://mywww.example.com/")), null);
});
