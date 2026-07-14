// Unit tests for the pluggable web-search backends (src/websearch-backends.js):
// the pure parsers/result builders, backend resolution + clamping, and the
// fail-soft fetch dispatch over a mocked fetch. No live SearXNG/Exa needed.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  SEARCH_BACKENDS,
  resolveSearchBackend,
  itemsDigest,
  resultFromItems,
  parseSearxngResults,
  parseExaCompatibleResults,
  runBackendSearch,
} from "./websearch-backends.js";

const noopLog = { debug() {}, info() {}, warn() {}, error() {} };

test("resolveSearchBackend defaults to Exa and clamps results", () => {
  const d = resolveSearchBackend({}, {});
  assert.equal(d.backend, "exa");
  assert.equal(d.results, 6);
  assert.equal(d.fallbackExa, true);
  assert.equal(d.baseUrl, "");
  assert.equal(d.key, "");

  // Unknown backend id falls back to Exa.
  assert.equal(resolveSearchBackend({}, { backend: "nope" }).backend, "exa");
  // Results clamp to 1..20.
  assert.equal(resolveSearchBackend({}, { results: 999 }).results, 20);
  assert.equal(resolveSearchBackend({}, { results: 0 }).results, 6);
});

test("resolveSearchBackend takes key/url from env, env url wins, trailing slash trimmed", () => {
  const env = { SEARCH_BACKEND_URL: "https://env.example.com/", SEARCH_BACKEND_KEY: "sekret" };
  const r = resolveSearchBackend(env, { backend: "searxng", base_url: "https://config.example.com" });
  assert.equal(r.backend, "searxng");
  assert.equal(r.baseUrl, "https://env.example.com"); // env override wins, slash trimmed
  assert.equal(r.key, "sekret");

  // Without an env override, the config base URL is used.
  const r2 = resolveSearchBackend({}, { backend: "searxng", base_url: "https://config.example.com/" });
  assert.equal(r2.baseUrl, "https://config.example.com");
});

test("resolveSearchBackend honors fallback_exa=false", () => {
  assert.equal(resolveSearchBackend({}, { fallback_exa: false }).fallbackExa, false);
});

test("SEARCH_BACKENDS is the stable allowlist", () => {
  assert.deepEqual(SEARCH_BACKENDS, ["exa", "searxng", "exa_compatible"]);
});

test("itemsDigest matches the numbered Exa-style shape", () => {
  const digest = itemsDigest([
    { title: "A", url: "https://a.com", highlights: ["one", "two"] },
    { title: "", url: "https://b.com", highlights: [] },
  ]);
  assert.match(digest, /^\[1\] A\nhttps:\/\/a\.com\none … two/);
  assert.match(digest, /\[2\] \(untitled\)\nhttps:\/\/b\.com/);
});

test("resultFromItems drops url-less items and returns null when empty", () => {
  assert.equal(resultFromItems([]), null);
  assert.equal(resultFromItems([{ title: "x", url: "", highlights: [] }]), null);
  const r = resultFromItems([{ title: "x", url: "https://x.com", highlights: ["hi"] }]);
  assert.equal(r.resultCount, 1);
  assert.equal(r.sources[0].url, "https://x.com");
  assert.equal(r.sources[0].title, "x");
});

test("parseSearxngResults maps content→highlight, dedupes, caps", () => {
  const data = {
    results: [
      { title: "T1", url: "https://one.com", content: "snippet one" },
      { title: "T1 dup", url: "https://one.com", content: "dup" }, // dropped (same url)
      { url: "https://two.com", content: "" }, // no title → url as title, no highlight
      { title: "T3", url: "https://three.com", content: "snippet three" },
    ],
  };
  const out = parseSearxngResults(data, 2);
  assert.equal(out.length, 2); // capped
  assert.equal(out[0].url, "https://one.com");
  assert.deepEqual(out[0].highlights, ["snippet one"]);
  assert.equal(out[1].url, "https://two.com");
  assert.equal(out[1].title, "https://two.com");
  assert.deepEqual(out[1].highlights, []);
});

test("parseSearxngResults tolerates junk", () => {
  assert.deepEqual(parseSearxngResults(null, 5), []);
  assert.deepEqual(parseSearxngResults({}, 5), []);
  assert.deepEqual(parseSearxngResults({ results: "x" }, 5), []);
});

test("parseExaCompatibleResults prefers highlights, falls back to text/snippet", () => {
  const data = {
    results: [
      { title: "A", url: "https://a.com", highlights: ["h1", "h2"] },
      { title: "B", url: "https://b.com", text: "body text" },
      { title: "C", url: "https://c.com", snippet: "snip" },
      { title: "no url", url: "" }, // dropped
    ],
  };
  const out = parseExaCompatibleResults(data, 10);
  assert.equal(out.length, 3);
  assert.deepEqual(out[0].highlights, ["h1", "h2"]);
  assert.deepEqual(out[1].highlights, ["body text"]);
  assert.deepEqual(out[2].highlights, ["snip"]);
});

test("runBackendSearch returns null for the exa backend (native path used)", async () => {
  const r = await runBackendSearch({}, noopLog, resolveSearchBackend({}, { backend: "exa" }), "q", {});
  assert.equal(r, null);
});

test("runBackendSearch hits SearXNG over a mocked fetch", async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = async (u) => {
    assert.match(String(u), /\/search\?/);
    assert.match(String(u), /format=json/);
    return new Response(JSON.stringify({ results: [{ title: "Hit", url: "https://hit.com", content: "body" }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  try {
    const resolved = resolveSearchBackend({}, { backend: "searxng", base_url: "https://searx.example.com" });
    const r = await runBackendSearch({}, noopLog, resolved, "hello world", { numResults: 5 });
    assert.equal(r.resultCount, 1);
    assert.equal(r.sources[0].url, "https://hit.com");
  } finally {
    globalThis.fetch = orig;
  }
});

test("runBackendSearch fail-soft: non-2xx → null", async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = async () => new Response("nope", { status: 502 });
  try {
    const resolved = resolveSearchBackend({}, { backend: "exa_compatible", base_url: "https://svc.example.com" });
    const r = await runBackendSearch({}, noopLog, resolved, "q", {});
    assert.equal(r, null);
  } finally {
    globalThis.fetch = orig;
  }
});

test("runBackendSearch fail-soft: thrown fetch → null", async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("network down");
  };
  try {
    const resolved = resolveSearchBackend({}, { backend: "searxng", base_url: "https://searx.example.com" });
    const r = await runBackendSearch({}, noopLog, resolved, "q", {});
    assert.equal(r, null);
  } finally {
    globalThis.fetch = orig;
  }
});

test("runBackendSearch null when self-hosted backend has no base URL", async () => {
  const resolved = resolveSearchBackend({}, { backend: "searxng", base_url: "" });
  const r = await runBackendSearch({}, noopLog, resolved, "q", {});
  assert.equal(r, null);
});

test("exa_compatible sends x-api-key and Exa-shaped body", async () => {
  const orig = globalThis.fetch;
  let seen = null;
  globalThis.fetch = async (u, opts) => {
    seen = { url: String(u), opts };
    return new Response(JSON.stringify({ results: [{ title: "R", url: "https://r.com", highlights: ["x"] }] }), {
      status: 200,
    });
  };
  try {
    const resolved = resolveSearchBackend(
      { SEARCH_BACKEND_KEY: "k123" },
      { backend: "exa_compatible", base_url: "https://svc.example.com" },
    );
    await runBackendSearch({ SEARCH_BACKEND_KEY: "k123" }, noopLog, resolved, "q", { type: "auto", numResults: 4 });
    assert.match(seen.url, /\/search$/);
    assert.equal(seen.opts.method, "POST");
    assert.equal(seen.opts.headers["x-api-key"], "k123");
    const body = JSON.parse(seen.opts.body);
    assert.equal(body.numResults, 4);
    assert.equal(body.query, "q");
    assert.ok(body.contents.highlights);
  } finally {
    globalThis.fetch = orig;
  }
});
