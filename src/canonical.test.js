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

// Loopback exemption (2026-07-29). `wrangler dev` serves plain http on
// localhost, so the http→https rule used to fire on every local request and
// build a Location identical to the request URL — an infinite 301 loop that
// stopped a browser ever reaching a locally-run Worker. These pin the
// exemption and, importantly, that it did not widen to anything else.
test("a wrangler dev server on localhost is left alone", () => {
  assert.equal(canonicalRedirect(new URL("http://localhost:8787/")), null);
  assert.equal(canonicalRedirect(new URL("http://localhost:8787/api/chat?x=1")), null);
  assert.equal(canonicalRedirect(new URL("http://127.0.0.1:8787/rver")), null);
  assert.equal(canonicalRedirect(new URL("http://[::1]:8787/")), null);
});

test("the exemption covers the .localhost suffix but not a lookalike domain", () => {
  assert.equal(canonicalRedirect(new URL("http://app.localhost:8787/")), null);
  // …while a real host that merely CONTAINS the word still canonicalizes.
  assert.equal(
    canonicalRedirect(new URL("http://localhost.example.com/"))?.headers.get("Location"),
    "https://localhost.example.com/",
  );
  assert.equal(
    canonicalRedirect(new URL("http://notlocalhost/"))?.headers.get("Location"),
    "https://notlocalhost/",
  );
});

test("the exemption is loopback-only — production still canonicalizes", () => {
  assert.equal(
    canonicalRedirect(new URL("http://deepresearch.se/"))?.headers.get("Location"),
    "https://deepresearch.se/",
  );
  assert.equal(
    canonicalRedirect(new URL("https://www.deepresearch.se/"))?.headers.get("Location"),
    "https://deepresearch.se/",
  );
});

test("an https preview URL still passes through untouched", () => {
  assert.equal(canonicalRedirect(new URL("https://abc123-deepresearch-se.workers.dev/rver")), null);
});
