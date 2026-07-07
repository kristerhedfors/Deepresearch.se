import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { searchCacheKey } from "./exa.js";

// The Cache API path in webSearch (caches.default) is exercised live, per
// this project's convention of verifying external-provider integration in
// production rather than mocking it. The cache KEY derivation is pure, and
// it's what decides whether a repeated search is recognized as identical —
// so it's covered here.
describe("searchCacheKey", () => {
  test("identical searches produce the same key", () => {
    const a = searchCacheKey("Northvolt bankruptcy", "auto", 5);
    const b = searchCacheKey("Northvolt bankruptcy", "auto", 5);
    assert.equal(a, b);
  });

  test("normalizes case and whitespace so trivial spelling differences hit the same entry", () => {
    const a = searchCacheKey("Northvolt bankruptcy", "auto", 5);
    const b = searchCacheKey("  northvolt   BANKRUPTCY ", "auto", 5);
    assert.equal(a, b);
  });

  test("a different query gets a different key", () => {
    assert.notEqual(
      searchCacheKey("Northvolt bankruptcy", "auto", 5),
      searchCacheKey("Northvolt revenue", "auto", 5),
    );
  });

  test("the depth tier is part of the key — a deeper re-run isn't served a shallower cached result", () => {
    assert.notEqual(
      searchCacheKey("q", "auto", 5),
      searchCacheKey("q", "deep", 10),
    );
    assert.notEqual(
      searchCacheKey("q", "auto", 5),
      searchCacheKey("q", "auto", 10),
    );
  });

  test("produces a valid absolute URL usable as a Cache API key", () => {
    const key = searchCacheKey("some query", "auto", 8);
    const url = new URL(key); // throws if not a valid absolute URL
    assert.equal(url.protocol, "https:");
    assert.equal(url.searchParams.get("q"), "some query");
    assert.equal(url.searchParams.get("t"), "auto");
    assert.equal(url.searchParams.get("n"), "8");
  });

  test("handles empty/nullish queries without throwing", () => {
    assert.equal(typeof searchCacheKey("", "auto", 5), "string");
    assert.equal(typeof searchCacheKey(undefined, "auto", 5), "string");
  });
});
