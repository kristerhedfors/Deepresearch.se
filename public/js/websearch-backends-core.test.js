// Unit tests for the SHARED web-search backend core (websearch-backends-core.js)
// — the browser-facing surface both tiers use. The server façade
// (src/websearch-backends.js) re-exports these; src/websearch-backends.test.js
// covers the env-aware resolution. Here we pin the core's own contract: the
// pure parsers and the (log, resolved, query, depth) dispatch — no `env`, since
// the browser has none. fetch/URL/AbortSignal are Node globals, so it runs
// unmodified in `node --test`.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  SELF_HOSTED_BACKENDS,
  itemsDigest,
  resultFromItems,
  parseSearxngResults,
  parseExaCompatibleResults,
  runBackendSearch,
} from "./websearch-backends-core.js";

test("SELF_HOSTED_BACKENDS is the self-hosted shape list (no built-in exa)", () => {
  assert.deepEqual(SELF_HOSTED_BACKENDS, ["searxng", "exa_compatible"]);
});

test("itemsDigest / resultFromItems produce the numbered Exa-style shape", () => {
  const r = resultFromItems([
    { title: "A", url: "https://a.com", highlights: ["one"] },
    { title: "", url: "", highlights: [] }, // dropped (no url)
  ]);
  assert.equal(r.resultCount, 1);
  assert.match(r.content, /^\[1\] A\nhttps:\/\/a\.com\none/);
  assert.equal(resultFromItems([]), null);
});

test("parseSearxngResults maps content→highlight, dedupes, caps", () => {
  const out = parseSearxngResults(
    {
      results: [
        { title: "T1", url: "https://one.com", content: "snip" },
        { title: "dup", url: "https://one.com", content: "x" },
        { url: "https://two.com" },
        { title: "T3", url: "https://three.com", content: "s3" },
      ],
    },
    2,
  );
  assert.equal(out.length, 2);
  assert.deepEqual(out[0].highlights, ["snip"]);
  assert.equal(out[1].title, "https://two.com");
});

test("parseExaCompatibleResults prefers highlights, falls back to text/snippet", () => {
  const out = parseExaCompatibleResults(
    {
      results: [
        { title: "A", url: "https://a.com", highlights: ["h"] },
        { title: "B", url: "https://b.com", text: "body" },
      ],
    },
    10,
  );
  assert.deepEqual(out[0].highlights, ["h"]);
  assert.deepEqual(out[1].highlights, ["body"]);
});

test("runBackendSearch: (log, resolved, query, depth) — no env — over a mocked fetch", async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = async (u) => {
    assert.match(String(u), /format=json/);
    return new Response(JSON.stringify({ results: [{ title: "Hit", url: "https://hit.com", content: "b" }] }), { status: 200 });
  };
  try {
    const r = await runBackendSearch(console, { backend: "searxng", baseUrl: "https://searx.ex", key: "", results: 5 }, "q", {});
    assert.equal(r.resultCount, 1);
    assert.equal(r.sources[0].url, "https://hit.com");
  } finally {
    globalThis.fetch = orig;
  }
});

test("runBackendSearch fail-soft: non-2xx and thrown fetch → null; unknown backend → null", async () => {
  const orig = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response("no", { status: 500 });
    assert.equal(await runBackendSearch(console, { backend: "exa_compatible", baseUrl: "https://x", key: "" }, "q", {}), null);
    globalThis.fetch = async () => {
      throw new Error("down");
    };
    assert.equal(await runBackendSearch(console, { backend: "searxng", baseUrl: "https://x", key: "" }, "q", {}), null);
    // "grant"/"exa" aren't self-hosted shapes — the core declines them.
    assert.equal(await runBackendSearch(console, { backend: "grant", baseUrl: "https://x", key: "" }, "q", {}), null);
  } finally {
    globalThis.fetch = orig;
  }
});

test("runBackendSearch: no baseUrl → null (no fetch attempted)", async () => {
  const orig = globalThis.fetch;
  let called = false;
  globalThis.fetch = async () => {
    called = true;
    return new Response("{}", { status: 200 });
  };
  try {
    assert.equal(await runBackendSearch(console, { backend: "searxng", baseUrl: "", key: "" }, "q", {}), null);
    assert.equal(called, false);
  } finally {
    globalThis.fetch = orig;
  }
});
