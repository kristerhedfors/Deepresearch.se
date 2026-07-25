// Unit tests for the pluggable web-search backends (src/websearch-backends.js):
// the pure parsers/result builders, backend resolution + clamping, and the
// fail-soft fetch dispatch over a mocked fetch. No live SearXNG/Exa needed.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  SEARCH_BACKENDS,
  USER_SEARCH_SOURCES,
  normalizeSearchSource,
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
  assert.deepEqual(SEARCH_BACKENDS, ["exa", "cloudflare", "searxng", "exa_compatible"]);
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

// ---- the Cloudflare-originating backend + the per-request user choice --------

test("the Worker-native backend is in the config allowlist and the user-pickable set", () => {
  assert.ok(SEARCH_BACKENDS.includes("cloudflare"));
  assert.deepEqual(USER_SEARCH_SOURCES, ["exa", "cloudflare"]);
});

test("normalizeSearchSource keeps only user-pickable ids", () => {
  assert.equal(normalizeSearchSource("exa"), "exa");
  assert.equal(normalizeSearchSource(" Cloudflare "), "cloudflare");
  // A self-hosted backend names an operator's service — never a user's choice.
  assert.equal(normalizeSearchSource("searxng"), "");
  assert.equal(normalizeSearchSource("exa_compatible"), "");
  for (const bad of ["", "nope", null, undefined, 7, {}]) assert.equal(normalizeSearchSource(bad), "");
});

test("a user's pick outranks the site backend; an admin can pin it away", () => {
  // No pick → the configured backend stands.
  assert.equal(resolveSearchBackend({}, { backend: "searxng", base_url: "https://s.example" }, "").backend, "searxng");
  // A pick wins over the site-wide selection…
  assert.equal(resolveSearchBackend({}, { backend: "exa" }, "cloudflare").backend, "cloudflare");
  assert.equal(resolveSearchBackend({}, { backend: "searxng" }, "exa").backend, "exa");
  // …unless the admin pinned the site-wide backend.
  assert.equal(
    resolveSearchBackend({}, { backend: "searxng", allow_user_choice: false }, "cloudflare").backend,
    "searxng",
  );
  // An unvalidated source can never select a backend.
  assert.equal(resolveSearchBackend({}, { backend: "exa" }, "searxng").backend, "exa");
});

test("cf_pages defaults on and rides the resolution", () => {
  assert.equal(resolveSearchBackend({}, {}).pages, true);
  assert.equal(resolveSearchBackend({}, { cf_pages: false }).pages, false);
});

test("runBackendSearch dispatches the cloudflare backend and shapes it like every other", async () => {
  const orig = globalThis.fetch;
  const href = "//duckduckgo.com/l/?uddg=" + encodeURIComponent("https://example.com/a");
  globalThis.fetch = async (u) => {
    if (String(u).includes("duckduckgo.com/html")) {
      return new Response(
        `<div class="result"><a class="result__a" href="${href}">Title A</a>` +
          `<a class="result__snippet">A snippet</a></div>`,
        { status: 200, headers: { "content-type": "text/html" } },
      );
    }
    return new Response("<body>page</body>", { status: 200, headers: { "content-type": "text/html" } });
  };
  try {
    const resolved = resolveSearchBackend({}, { backend: "cloudflare", cf_pages: false });
    const r = await runBackendSearch({}, noopLog, resolved, "a query", { numResults: 3 });
    assert.equal(r.resultCount, 1);
    assert.deepEqual(r.sources, [{ title: "Title A", url: "https://example.com/a" }]);
    assert.match(r.content, /\[1\] Title A\nhttps:\/\/example\.com\/a\nA snippet/);
  } finally {
    globalThis.fetch = orig;
  }
});

test("the cloudflare backend is fail-soft: a blocked SERP returns null, not a throw", async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = async () => new Response("blocked", { status: 403 });
  try {
    const resolved = resolveSearchBackend({}, { backend: "cloudflare" });
    assert.equal(await runBackendSearch({}, noopLog, resolved, "q", {}), null);
  } finally {
    globalThis.fetch = orig;
  }
});
