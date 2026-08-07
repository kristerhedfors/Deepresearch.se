// Unit tests for src/exa.js's REQUEST path — the primary web-search leg, and
// the highest-traffic external surface in the whole pipeline.
//
// The sibling file src/exa.test.js covers the pure `searchCacheKey` derivation
// and nothing else; everything below it — key gating, the Exa wire format, the
// pluggable-backend selection, the Exa fallback, and every fail-soft degrade —
// was untested. This file pins that behaviour:
//
//   * KEY GATING — no EXA_API_KEY means the documented failure string and ZERO
//     outbound requests; a present key travels only in the x-api-key header.
//   * BACKEND SELECTION (the branch that matters most) — the admin's
//     `search.backend`, the per-request user `source`, `allow_user_choice`,
//     and the `fallback_exa` switch decide whether Exa is contacted at all.
//     A hostile `search_source` normalizes to "" (normalizeSearchSource), and
//     the terms-restricted `bing_rss` SERP provider is unreachable from every
//     default path.
//   * FAIL-SOFT (CLAUDE.md invariant 2) — 401/429/500, a thrown or timed-out
//     fetch, a non-JSON body, and an empty result set all degrade to a
//     `failure()` bundle the pipeline carries on with. Nothing throws.
//   * PRIVACY (CLAUDE.md invariant 4) — the outbound Exa request carries the
//     QUERY and the depth tier, and nothing else: no conversation, no
//     filename, no account/session id, and no other provider's secret.
//   * LANGUAGE INDEPENDENCE (CLAUDE.md invariant 6) — webSearch has no
//     deterministic language gate at all; a Swedish query must travel and
//     route exactly like an English one. Pinned so a future English-only
//     phrase gate here is caught.
//
// The Workers Cache API path (caches.default) is NOT mocked, per this
// project's convention and the note in src/exa.test.js: `caches` is undefined
// in Node, so src/edge-cache.js's `globalThis.caches?.default` guard makes
// every cacheGet a miss and every cachePut a no-op — the live cache behaviour
// (a genuine hit, `cached: true`) is verified in production, not here.
//
// No `// @ts-check`: several tests deliberately feed malformed shapes (a
// non-JSON body, results rows missing fields, a hostile search_source, partial
// Env objects) that the annotated signatures reject by design.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { webSearch, fetchContents, contentsCacheKey } from "./exa.js";
import { fakeFetch, withFakeFetch } from "./test-helpers/fetch.js";
import { fakeLog } from "./test-helpers/env.js";
import { fakeD1 } from "./test-helpers/d1.js";
import { saveConfig } from "./config.js";
import { normalizeSearchSource, resolveSearchBackend } from "./websearch-backends.js";
import { SERP_PROVIDERS, DEFAULT_SERP_PROVIDERS, normalizeSerpProviders } from "./websearch-cf.js";

const EXA_SEARCH = /api\.exa\.ai\/search/;
const EXA_CONTENTS = /api\.exa\.ai\/contents/;
const DDG = /duckduckgo\.com/;
const MARGINALIA = /marginalia/;

/** A well-formed Exa /search body. */
function exaResults(...rows) {
  return { results: rows };
}

/** The request body Exa actually received, parsed. */
function sentBody(stub, matcher = EXA_SEARCH) {
  const reqs = stub.matching(matcher);
  assert.equal(reqs.length, 1, "expected exactly one request to the matched host");
  return JSON.parse(reqs[0].body);
}

/** One classed DuckDuckGo no-JS result block (the shape parseDdg reads). */
function ddgResult(title, target, snippet) {
  const href = "//duckduckgo.com/l/?uddg=" + encodeURIComponent(target) + "&amp;rut=abc";
  return `<div class="result results_links">
    <h2 class="result__title"><a class="result__a" href="${href}">${title}</a></h2>
    <a class="result__snippet" href="${href}">${snippet}</a>
  </div>`;
}

const DDG_SERP = `<html><body>
  ${ddgResult("Northvolt battery plant", "https://example.com/northvolt", "The battery factory in Skelleftea")}
  ${ddgResult("Northvolt battery news", "https://example.org/news", "battery production update")}
</body></html>`;

/**
 * An env whose site config is a KNOWN `search` block.
 *
 * src/config.js caches the resolved config in a module-level 30 s cache, so a
 * test that just hands getConfig a row can be served an earlier test's value.
 * Going through the real `saveConfig` writes the cache deterministically, and
 * every field of the `search` block is spelled out on every call so no
 * previous patch can leak in.
 */
async function envWithSearchConfig(patch = {}, extra = {}) {
  const env = { DB: fakeD1(), ...extra };
  await saveConfig(env, {
    search: {
      backend: "exa",
      base_url: "",
      results: 6,
      fallback_exa: true,
      cf_pages: true,
      cf_serp: ["ddg", "marginalia"],
      allow_user_choice: true,
      ...patch,
    },
  });
  return env;
}

describe("webSearch — key gating", () => {
  test("an empty query fails before any config read or outbound request", async () => {
    const log = fakeLog();
    await withFakeFetch([[EXA_SEARCH, exaResults({ title: "t", url: "https://x/" })]], async (stub) => {
      const res = await webSearch({ EXA_API_KEY: "k" }, log, "");
      assert.equal(res.content, "No search query was provided.");
      assert.deepEqual(res.items, []);
      assert.deepEqual(res.sources, []);
      assert.equal(res.resultCount, 0);
      assert.equal(typeof res.durationMs, "number");
      assert.equal(stub.requests.length, 0);
      assert.ok(log.text().includes("exa.empty_query"));
    });
  });

  test("a missing EXA_API_KEY returns the documented failure and contacts nobody", async () => {
    const log = fakeLog();
    await withFakeFetch([[EXA_SEARCH, exaResults({ title: "t", url: "https://x/" })]], async (stub) => {
      const res = await webSearch({}, log, "northvolt");
      // The verbatim string src/exa.js returns — the pipeline carries it as
      // search "content" rather than erroring the chat.
      assert.equal(res.content, "Web search is unavailable: EXA_API_KEY is not configured.");
      assert.deepEqual(res.items, []);
      assert.deepEqual(res.sources, []);
      assert.equal(res.resultCount, 0);
      assert.equal(stub.requests.length, 0, "no outbound request without a key");
      assert.deepEqual(stub.hosts(), []);
      assert.ok(log.text().includes("exa.misconfigured"));
      assert.ok(log.text().includes("EXA_API_KEY"));
    });
  });

  test("the key travels in the x-api-key header on a POST to api.exa.ai", async () => {
    await withFakeFetch([[EXA_SEARCH, exaResults({ title: "T", url: "https://x/", highlights: ["h"] })]], async (stub) => {
      await webSearch({ EXA_API_KEY: "secret-key" }, fakeLog(), "northvolt");
      const req = stub.matching(EXA_SEARCH)[0];
      assert.equal(req.method, "POST");
      assert.equal(req.host, "api.exa.ai");
      assert.equal(req.headers["x-api-key"], "secret-key");
      assert.equal(req.headers["content-type"], "application/json");
      // The key is auth, not payload: it must not also be in the URL or body.
      assert.ok(!req.url.includes("secret-key"));
      assert.ok(!req.body.includes("secret-key"));
    });
  });
});

describe("webSearch — success path", () => {
  test("maps Exa results to the content/items/sources shape downstream reads", async () => {
    const rows = exaResults(
      { title: "Northvolt files", url: "https://example.com/a", highlights: ["one", "two"] },
      { title: "Battery plant", url: "https://example.org/b", highlights: ["three"] },
    );
    await withFakeFetch([[EXA_SEARCH, rows]], async () => {
      const res = await webSearch({ EXA_API_KEY: "k" }, fakeLog(), "northvolt");
      assert.equal(res.resultCount, 2);
      assert.equal(res.cached, false);
      assert.equal(typeof res.durationMs, "number");
      // items = the pipeline's cross-search source registry shape
      assert.deepEqual(res.items, [
        { title: "Northvolt files", url: "https://example.com/a", highlights: ["one", "two"] },
        { title: "Battery plant", url: "https://example.org/b", highlights: ["three"] },
      ]);
      // sources = the UI's expandable activity panel shape
      assert.deepEqual(res.sources, [
        { title: "Northvolt files", url: "https://example.com/a" },
        { title: "Battery plant", url: "https://example.org/b" },
      ]);
      // content = the numbered LLM-facing digest, highlights joined with " … "
      assert.equal(
        res.content,
        "[1] Northvolt files\nhttps://example.com/a\none … two\n\n[2] Battery plant\nhttps://example.org/b\nthree",
      );
    });
  });

  test("a result with no title falls back to its URL, and missing highlights to []", async () => {
    const rows = exaResults({ url: "https://example.com/a" }, { title: "", url: "https://example.org/b", highlights: "not-an-array" });
    await withFakeFetch([[EXA_SEARCH, rows]], async () => {
      const res = await webSearch({ EXA_API_KEY: "k" }, fakeLog(), "q");
      assert.deepEqual(res.items, [
        { title: "https://example.com/a", url: "https://example.com/a", highlights: [] },
        { title: "https://example.org/b", url: "https://example.org/b", highlights: [] },
      ]);
      assert.deepEqual(res.sources.map((s) => s.title), ["https://example.com/a", "https://example.org/b"]);
      // NOTE the divergence: items[] and sources[] fall back to the URL, but
      // the LLM-facing digest falls back to the literal "(untitled)" instead.
      // Pinned as the behaviour that actually ships, not as an endorsement —
      // the model is told "(untitled)" for a source the UI labels with its URL.
      assert.ok(res.content.startsWith("[1] (untitled)\nhttps://example.com/a"));
    });
  });

  test("defaults to 5 results / type auto and always asks for highlights", async () => {
    await withFakeFetch([[EXA_SEARCH, exaResults({ title: "T", url: "https://x/" })]], async (stub) => {
      await webSearch({ EXA_API_KEY: "k" }, fakeLog(), "northvolt");
      assert.deepEqual(sentBody(stub), {
        query: "northvolt",
        type: "auto",
        numResults: 5,
        contents: { highlights: true },
      });
    });
  });

  test("threads the budget's depth tier (numResults + type) into the request body", async () => {
    await withFakeFetch([[EXA_SEARCH, exaResults({ title: "T", url: "https://x/" })]], async (stub) => {
      await webSearch({ EXA_API_KEY: "k" }, fakeLog(), "northvolt", { numResults: 12, type: "deep" });
      const body = sentBody(stub);
      assert.equal(body.numResults, 12);
      assert.equal(body.type, "deep");
    });
  });

  test("a Swedish query travels byte-identically and routes exactly like an English one", async () => {
    // webSearch has NO deterministic language gate — the query is passed
    // through verbatim. Pinned (CLAUDE.md invariant 6) so a future
    // English-only phrase gate on this hot path is caught immediately.
    for (const q of ["battery factory in northern Sweden", "batterifabrik i norra Sverige — Skellefteå"]) {
      await withFakeFetch([[EXA_SEARCH, exaResults({ title: "T", url: "https://x/" })]], async (stub) => {
        const res = await webSearch({ EXA_API_KEY: "k" }, fakeLog(), q, { numResults: 7, type: "auto" });
        const body = sentBody(stub);
        assert.equal(body.query, q, "the query must not be rewritten or transliterated");
        assert.equal(body.numResults, 7);
        assert.equal(res.resultCount, 1);
        assert.deepEqual(stub.hosts(), ["api.exa.ai"]);
      });
    }
  });
});

describe("webSearch — backend selection and fallback", () => {
  test("the site-wide cloudflare backend routes to runBackendSearch instead of Exa", async () => {
    const env = await envWithSearchConfig({ backend: "cloudflare", cf_pages: false }, { EXA_API_KEY: "k" });
    const log = fakeLog();
    await withFakeFetch(
      [
        [DDG, DDG_SERP],
        [EXA_SEARCH, exaResults({ title: "exa", url: "https://exa.example/" })],
      ],
      async (stub) => {
        const res = await webSearch(env, log, "northvolt battery");
        assert.equal(res.resultCount, 2);
        assert.deepEqual(res.items.map((i) => i.url), ["https://example.com/northvolt", "https://example.org/news"]);
        assert.equal(res.cached, false);
        assert.ok(stub.hosts().includes("html.duckduckgo.com"));
        assert.ok(!stub.hosts().includes("api.exa.ai"), "Exa must not be contacted when the backend answered");
        assert.ok(log.text().includes("search.backend_hit"));
      },
    );
  });

  test("a per-request user source picks the cloudflare backend with no admin config at all", async () => {
    // No DB → the built-in defaults (backend "exa", allow_user_choice true).
    const log = fakeLog();
    await withFakeFetch(
      [
        [DDG, DDG_SERP],
        [EXA_SEARCH, exaResults({ title: "exa", url: "https://exa.example/" })],
      ],
      async (stub) => {
        const res = await webSearch({ EXA_API_KEY: "k" }, log, "northvolt battery", {}, { source: "cloudflare" });
        assert.equal(res.resultCount, 2);
        assert.ok(!stub.hosts().includes("api.exa.ai"));
        // Result-page enrichment is on by default: it fetches the result URLs
        // themselves, never a search engine the operator did not choose.
        assert.ok(!stub.hosts().includes("www.bing.com"));
      },
    );
  });

  test("an empty backend falls back to Exa and returns Exa's results when fallback_exa is on", async () => {
    const log = fakeLog();
    await withFakeFetch(
      [
        // No route for the SERP hosts → 404 → the cascade finds nothing.
        [EXA_SEARCH, exaResults({ title: "From Exa", url: "https://exa.example/a", highlights: ["hl"] })],
      ],
      async (stub) => {
        const res = await webSearch({ EXA_API_KEY: "k" }, log, "northvolt battery", {}, { source: "cloudflare" });
        assert.equal(res.resultCount, 1);
        assert.deepEqual(res.items, [{ title: "From Exa", url: "https://exa.example/a", highlights: ["hl"] }]);
        assert.ok(stub.hosts().includes("html.duckduckgo.com"), "the chosen backend was tried first");
        assert.ok(stub.hosts().includes("api.exa.ai"), "…then Exa served the fallback");
        assert.ok(log.text().includes("search.backend_fallback_exa"));
      },
    );
  });

  test("fallback_exa: false degrades instead of contacting Exa", async () => {
    const env = await envWithSearchConfig({ backend: "cloudflare", fallback_exa: false }, { EXA_API_KEY: "k" });
    const log = fakeLog();
    await withFakeFetch([[EXA_SEARCH, exaResults({ title: "From Exa", url: "https://exa.example/a" })]], async (stub) => {
      const res = await webSearch(env, log, "northvolt battery");
      assert.equal(res.content, "No results found for: northvolt battery");
      assert.deepEqual(res.items, []);
      assert.deepEqual(res.sources, []);
      assert.equal(res.resultCount, 0);
      assert.ok(!stub.hosts().includes("api.exa.ai"), "an opted-out site must never reach Exa");
      assert.deepEqual(stub.matching(EXA_SEARCH), []);
      assert.ok(log.text().includes("search.backend_no_results"));
    });
  });

  test("the fallback is skipped — not attempted keyless — when no EXA_API_KEY exists", async () => {
    const log = fakeLog();
    await withFakeFetch([[EXA_SEARCH, exaResults({ title: "From Exa", url: "https://exa.example/a" })]], async (stub) => {
      const res = await webSearch({}, log, "northvolt battery", {}, { source: "cloudflare" });
      assert.equal(res.content, "No results found for: northvolt battery");
      assert.equal(res.resultCount, 0);
      assert.ok(!stub.hosts().includes("api.exa.ai"), "no keyless request may be sent to Exa");
    });
  });

  test("allow_user_choice: false pins the site backend and ignores the request's source", async () => {
    const env = await envWithSearchConfig({ backend: "exa", allow_user_choice: false }, { EXA_API_KEY: "k" });
    await withFakeFetch(
      [
        [DDG, DDG_SERP],
        [EXA_SEARCH, exaResults({ title: "From Exa", url: "https://exa.example/a" })],
      ],
      async (stub) => {
        const res = await webSearch(env, fakeLog(), "northvolt battery", {}, { source: "cloudflare" });
        assert.equal(res.resultCount, 1);
        assert.equal(res.items[0].url, "https://exa.example/a");
        assert.deepEqual(stub.hosts(), ["api.exa.ai"], "the pinned site backend wins over the user's pick");
      },
    );
  });

  test("an unknown or hostile search_source normalizes to '' and leaves the site default in charge", async () => {
    // The normalizer is the gate: only the two user-selectable ids survive.
    assert.equal(normalizeSearchSource("cloudflare"), "cloudflare");
    assert.equal(normalizeSearchSource("  ExA  "), "exa");
    for (const hostile of [
      "bing_rss",
      "searxng",
      "exa_compatible",
      "https://evil.example/search",
      "../../etc/passwd",
      "CLOUDFLARE; DROP TABLE",
      { backend: "bing_rss" },
      ["cloudflare"],
      null,
      undefined,
      7,
    ]) {
      assert.equal(normalizeSearchSource(hostile), "", `${JSON.stringify(hostile)} must not select a backend`);
    }
    // …and end to end: a junk source cannot move the search off the default.
    await withFakeFetch(
      [
        [DDG, DDG_SERP],
        [EXA_SEARCH, exaResults({ title: "From Exa", url: "https://exa.example/a" })],
      ],
      async (stub) => {
        const res = await webSearch({ EXA_API_KEY: "k" }, fakeLog(), "northvolt battery", {}, { source: "bing_rss" });
        assert.equal(res.items[0].url, "https://exa.example/a");
        assert.deepEqual(stub.hosts(), ["api.exa.ai"]);
      },
    );
  });

  test("the terms-restricted bing_rss provider is unreachable from every default path", async () => {
    // 1. It ships, and it is marked restricted with a reason an operator can act on.
    const bing = SERP_PROVIDERS.find((p) => p.id === "bing_rss");
    assert.ok(bing?.restricted, "bing_rss must stay marked restricted");
    // 2. It is not in the default provider list, and no default resolution yields it.
    assert.ok(!DEFAULT_SERP_PROVIDERS.includes("bing_rss"));
    assert.ok(!normalizeSerpProviders(undefined).includes("bing_rss"));
    assert.ok(!normalizeSerpProviders([]).includes("bing_rss"));
    assert.ok(!normalizeSerpProviders(["nope", 7]).includes("bing_rss"));
    for (const cfg of [{}, { backend: "cloudflare" }, { backend: "cloudflare", cf_serp: [] }, { backend: "cloudflare", cf_serp: ["junk"] }]) {
      assert.ok(!resolveSearchBackend({}, cfg).serp.includes("bing_rss"));
      assert.ok(!resolveSearchBackend({}, cfg, "cloudflare").serp.includes("bing_rss"));
      assert.ok(!resolveSearchBackend({}, cfg, "bing_rss").serp.includes("bing_rss"));
    }
    // 3. End to end, on the default config: bing.com is never contacted, even
    //    when the chosen providers return nothing at all.
    await withFakeFetch([[EXA_SEARCH, exaResults({ title: "From Exa", url: "https://exa.example/a" })]], async (stub) => {
      await webSearch({ EXA_API_KEY: "k" }, fakeLog(), "northvolt battery", {}, { source: "cloudflare" });
      assert.ok(!stub.hosts().some((h) => /bing\.com$/.test(h)), `contacted ${stub.hosts().join(", ")}`);
    });
    // Only an explicit, knowing operator configuration can select it — the
    // normalizer does keep an id the admin typed on purpose.
    assert.deepEqual(normalizeSerpProviders(["bing_rss"]), ["bing_rss"]);
  });
});

describe("webSearch — fail-soft (invariant 2)", () => {
  for (const status of [401, 429, 500]) {
    test(`an Exa ${status} degrades to a failure string instead of throwing`, async () => {
      const log = fakeLog();
      await withFakeFetch([[EXA_SEARCH, new Response("upstream said no", { status })]], async () => {
        const res = await webSearch({ EXA_API_KEY: "k" }, log, "northvolt");
        assert.equal(res.content, `Search error (${status}): upstream said no`);
        assert.deepEqual(res.items, []);
        assert.deepEqual(res.sources, []);
        assert.equal(res.resultCount, 0);
        assert.equal(typeof res.durationMs, "number");
        assert.ok(log.text().includes("exa.error"));
      });
    });
  }

  test("an error body is clamped to 300 chars so a huge upstream error can't flood the digest", async () => {
    const big = "x".repeat(5000);
    await withFakeFetch([[EXA_SEARCH, new Response(big, { status: 502 })]], async () => {
      const res = await webSearch({ EXA_API_KEY: "k" }, fakeLog(), "q");
      assert.equal(res.content, `Search error (502): ${"x".repeat(300)}`);
    });
  });

  test("a thrown fetch degrades, with the reason carried as content", async () => {
    const log = fakeLog();
    await withFakeFetch(
      [[EXA_SEARCH, () => { throw new Error("ECONNRESET"); }]],
      async () => {
        const res = await webSearch({ EXA_API_KEY: "k" }, log, "northvolt");
        assert.equal(res.content, "Search request failed: ECONNRESET");
        assert.equal(res.resultCount, 0);
        assert.deepEqual(res.items, []);
        assert.ok(log.text().includes("exa.request_failed"));
      },
    );
  });

  test("a timeout (the AbortSignal.timeout rejection) degrades exactly like any other fetch failure", async () => {
    await withFakeFetch(
      [[EXA_SEARCH, () => {
        const err = new Error("The operation was aborted due to timeout");
        err.name = "TimeoutError";
        throw err;
      }]],
      async () => {
        const res = await webSearch({ EXA_API_KEY: "k" }, fakeLog(), "northvolt");
        assert.ok(res.content.startsWith("Search request failed:"));
        assert.equal(res.resultCount, 0);
      },
    );
  });

  test("a malformed / non-JSON 200 body reads as no results, never a throw", async () => {
    for (const body of ["<html>not json</html>", "", "{oops", "[]", "false", '{"results":"nope"}']) {
      await withFakeFetch([[EXA_SEARCH, new Response(body, { status: 200 })]], async () => {
        const res = await webSearch({ EXA_API_KEY: "k" }, fakeLog(), "northvolt");
        assert.equal(res.content, "No results found for: northvolt");
        assert.deepEqual(res.items, []);
        assert.equal(res.resultCount, 0);
      });
    }
  });

  // ---- KNOWN DEFECT, reported not fixed (test-only change) -------------------
  //
  // `resp.json().catch(() => ({}))` only guards a PARSE failure. A 200 whose
  // body is the JSON literal `null` parses fine, so `data` is null and
  // `Array.isArray(data.results)` (src/exa.js:207) throws
  //   TypeError: Cannot read properties of null (reading 'results')
  // …out of webSearch, whose whole contract is that it never throws (module
  // header: "errors come back as strings too, so the pipeline can carry on
  // instead of the request 500ing"; CLAUDE.md invariant 2). src/pipeline.js's
  // runWebLeg awaits `Promise.all(batch.map(webSearch…))` with NO try/catch,
  // so one such response rejects the entire search wave and errors the chat.
  // Fixed 2026-08-07 with `data?.results`.
  //
  // Fixed 2026-08-07 (`data?.results`); this test is the regression pin.
  test(
    "a JSON `null` 200 body degrades like any other malformed body",
    async () => {
      await withFakeFetch([[EXA_SEARCH, new Response("null", { status: 200 })]], async () => {
        const res = await webSearch({ EXA_API_KEY: "k" }, fakeLog(), "northvolt");
        assert.equal(res.content, "No results found for: northvolt");
        assert.deepEqual(res.items, []);
        assert.equal(res.resultCount, 0);
      });
    },
  );

  test("a 200 with an empty results array yields an empty item list and no throw", async () => {
    const log = fakeLog();
    await withFakeFetch([[EXA_SEARCH, exaResults()]], async () => {
      const res = await webSearch({ EXA_API_KEY: "k" }, log, "northvolt");
      assert.equal(res.content, "No results found for: northvolt");
      assert.deepEqual(res.items, []);
      assert.deepEqual(res.sources, []);
      assert.equal(res.resultCount, 0);
      assert.equal(typeof res.durationMs, "number");
      assert.ok(log.text().includes("exa.search"));
    });
  });

  test("a config-read failure degrades to the Exa default rather than erroring the search", async (t) => {
    // src/config.js caches for 30 s in a module-level variable; freeze Date
    // 60 s ahead so this genuinely takes the uncached path and the SELECT
    // (which the fake makes throw) actually runs.
    t.mock.timers.enable({ apis: ["Date"], now: Date.now() + 60_000 });
    t.after(() => t.mock.timers.reset());
    const db = fakeD1().failOn(/SELECT value FROM config/, "D1_ERROR: config unavailable");
    await withFakeFetch([[EXA_SEARCH, exaResults({ title: "From Exa", url: "https://exa.example/a" })]], async (stub) => {
      const res = await webSearch({ DB: db, EXA_API_KEY: "k" }, fakeLog(), "northvolt");
      assert.equal(res.resultCount, 1);
      assert.deepEqual(stub.hosts(), ["api.exa.ai"]);
    });
    assert.ok(db.ran(/SELECT value FROM config/), "the failing read was actually attempted");
  });
});

describe("fetchContents", () => {
  test("an empty or all-blank URL list returns empty without a request", async () => {
    for (const urls of [[], null, undefined, ["", "   ", null]]) {
      await withFakeFetch([[EXA_CONTENTS, { results: [] }]], async (stub) => {
        const res = await fetchContents({ EXA_API_KEY: "k" }, urls, fakeLog());
        assert.deepEqual(res.results, []);
        assert.equal(res.cached, false);
        assert.equal(typeof res.durationMs, "number");
        assert.equal(stub.requests.length, 0);
      });
    }
  });

  test("a missing EXA_API_KEY returns empty and contacts nobody", async () => {
    const log = fakeLog();
    await withFakeFetch([[EXA_CONTENTS, { results: [{ url: "https://x/", text: "t" }] }]], async (stub) => {
      const res = await fetchContents({}, ["https://x/"], log);
      assert.deepEqual(res.results, []);
      assert.equal(res.cached, false);
      assert.equal(stub.requests.length, 0);
      assert.ok(log.text().includes("exa.contents_misconfigured"));
    });
  });

  test("success maps url/title/text and drops rows with no url or no text", async () => {
    const body = {
      results: [
        { url: "https://example.com/a", title: "A", text: "full text A" },
        { url: "https://example.org/b", text: "full text B" }, // title falls back to url
        { url: "https://example.net/c", text: "" }, // no text → dropped
        { title: "no url", text: "orphan" }, // no url → dropped
        { url: "https://example.io/d", text: 42 }, // non-string text → dropped
      ],
    };
    await withFakeFetch([[EXA_CONTENTS, body]], async (stub) => {
      const res = await fetchContents({ EXA_API_KEY: "k" }, ["https://example.com/a"], fakeLog());
      assert.deepEqual(res.results, [
        { url: "https://example.com/a", title: "A", text: "full text A" },
        { url: "https://example.org/b", title: "https://example.org/b", text: "full text B" },
      ]);
      assert.equal(res.cached, false);
      const req = stub.matching(EXA_CONTENTS)[0];
      assert.equal(req.method, "POST");
      assert.equal(req.headers["x-api-key"], "k");
    });
  });

  test("clamps each source's text to CONTENTS_MAX_CHARS and asks Exa for the same cap", async () => {
    const body = { results: [{ url: "https://example.com/a", title: "A", text: "y".repeat(20_000) }] };
    await withFakeFetch([[EXA_CONTENTS, body]], async (stub) => {
      const res = await fetchContents({ EXA_API_KEY: "k" }, ["https://example.com/a"], fakeLog());
      assert.equal(res.results[0].text.length, 6000);
      assert.deepEqual(sentBody(stub, EXA_CONTENTS).text, { maxCharacters: 6000 });
    });
  });

  test("dedupes and trims the URL batch it sends — but does NOT cap how many go out", async () => {
    const urls = ["  https://a.example/  ", "https://a.example/", "", null, "https://b.example/"];
    await withFakeFetch([[EXA_CONTENTS, { results: [] }]], async (stub) => {
      await fetchContents({ EXA_API_KEY: "k" }, urls, fakeLog());
      assert.deepEqual(sentBody(stub, EXA_CONTENTS).urls, ["https://a.example/", "https://b.example/"]);
    });
    // The COUNT bound is the caller's, not this module's: src/pipeline.js
    // sends `state.sources.slice(0, 4)`. Pinned as documentation — if a cap is
    // ever added here, this assertion is the one to update.
    const many = Array.from({ length: 50 }, (_, i) => `https://example.com/${i}`);
    await withFakeFetch([[EXA_CONTENTS, { results: [] }]], async (stub) => {
      await fetchContents({ EXA_API_KEY: "k" }, many, fakeLog());
      assert.equal(sentBody(stub, EXA_CONTENTS).urls.length, 50);
    });
  });

  test("a non-OK response degrades to empty without throwing", async () => {
    for (const status of [401, 429, 500]) {
      const log = fakeLog();
      await withFakeFetch([[EXA_CONTENTS, new Response("nope", { status })]], async () => {
        const res = await fetchContents({ EXA_API_KEY: "k" }, ["https://x/"], log);
        assert.deepEqual(res.results, []);
        assert.equal(res.cached, false);
        assert.ok(log.text().includes("exa.contents_error"));
      });
    }
  });

  test("a thrown / timed-out fetch degrades to empty without throwing", async () => {
    const log = fakeLog();
    await withFakeFetch(
      [[EXA_CONTENTS, () => { throw new Error("socket hang up"); }]],
      async () => {
        const res = await fetchContents({ EXA_API_KEY: "k" }, ["https://x/"], log);
        assert.deepEqual(res.results, []);
        assert.ok(log.text().includes("exa.contents_request_failed"));
      },
    );
  });

  test("a malformed body degrades to empty without throwing", async () => {
    for (const body of ["<html/>", "", "{oops", '{"results":"nope"}', "[]", "false"]) {
      await withFakeFetch([[EXA_CONTENTS, new Response(body, { status: 200 })]], async () => {
        const res = await fetchContents({ EXA_API_KEY: "k" }, ["https://x/"], fakeLog());
        assert.deepEqual(res.results, []);
        assert.equal(res.cached, false);
      });
    }
  });

  // The same `data.results`-on-null defect as webSearch, one function down
  // (src/exa.js:308). Milder in practice only because src/pipeline.js:1887
  // happens to wrap this call in a try/catch — the function itself still
  // breaks its documented "fully fail-soft" contract. Fixed 2026-08-07.
  test(
    "a JSON `null` 200 body degrades to empty like any other malformed body",
    async () => {
      await withFakeFetch([[EXA_CONTENTS, new Response("null", { status: 200 })]], async () => {
        const res = await fetchContents({ EXA_API_KEY: "k" }, ["https://x/"], fakeLog());
        assert.deepEqual(res.results, []);
      });
    },
  );

  test("contentsCacheKey is order- and duplicate-insensitive", () => {
    assert.equal(
      contentsCacheKey(["https://b.example/", " https://a.example/ ", "https://a.example/"]),
      contentsCacheKey(["https://a.example/", "https://b.example/"]),
    );
    assert.notEqual(contentsCacheKey(["https://a.example/"]), contentsCacheKey(["https://c.example/"]));
    assert.equal(typeof contentsCacheKey(null), "string");
    assert.equal(new URL(contentsCacheKey(["https://a.example/"])).protocol, "https:");
  });
});

describe("privacy — outbound requests carry the minimum (invariant 4)", () => {
  // Everything a third party must never see, whether or not the current call
  // signature could carry it. Asserted mechanically so a future change that
  // threads identity or conversation through this seam fails here.
  const FORBIDDEN = [
    "I am researching my colleague Anna and her salary", // conversation text
    "q3-board-minutes.pdf", // an attached filename
    "krister.hedfors@gmail.com", // account identity
    "user-4711", // account id
    "sess_abc123", // session id
    "berget-secret", // another provider's key
    "sk-ant-secret",
    "sk-openai-secret",
    "shodan-secret",
    "search-backend-secret",
  ];

  const LOADED_ENV = {
    EXA_API_KEY: "exa-secret",
    BERGET_API_KEY: "berget-secret",
    ANTHROPIC_API_KEY: "sk-ant-secret",
    OPENAI_API_KEY: "sk-openai-secret",
    SHODAN_API_KEY: "shodan-secret",
    SEARCH_BACKEND_KEY: "search-backend-secret",
    ADMIN_PASSWORD: "hunter2",
  };

  test("the Exa search request carries the query and the depth tier — nothing else", async () => {
    await withFakeFetch([[EXA_SEARCH, exaResults({ title: "T", url: "https://x/" })]], async (stub) => {
      await webSearch(LOADED_ENV, fakeLog(), "northvolt bankruptcy filing", { numResults: 8, type: "auto" });
      const req = stub.matching(EXA_SEARCH)[0];
      // The body is exactly the four documented fields.
      assert.deepEqual(Object.keys(JSON.parse(req.body)).sort(), ["contents", "numResults", "query", "type"]);
      // The only header beyond content-type is the Exa key itself.
      assert.deepEqual(
        Object.keys(req.headers).filter((h) => /key|auth|cookie|token/i.test(h)),
        ["x-api-key"],
      );
      assert.deepEqual(stub.hosts(), ["api.exa.ai"]);
      stub.assertNoneCarry(FORBIDDEN, assert.fail);
    });
  });

  test("the /contents request carries the URL list and the char cap — nothing else", async () => {
    await withFakeFetch([[EXA_CONTENTS, { results: [] }]], async (stub) => {
      await fetchContents(LOADED_ENV, ["https://example.com/a"], fakeLog());
      assert.deepEqual(Object.keys(JSON.parse(stub.matching(EXA_CONTENTS)[0].body)).sort(), ["text", "urls"]);
      assert.deepEqual(stub.hosts(), ["api.exa.ai"]);
      stub.assertNoneCarry(FORBIDDEN, assert.fail);
    });
  });

  test("no secret and no identity leaks to the alternative backend or its result pages", async () => {
    await withFakeFetch([[DDG, DDG_SERP], [MARGINALIA, "<html></html>"]], async (stub) => {
      await webSearch(LOADED_ENV, fakeLog(), "northvolt battery", {}, { source: "cloudflare" });
      assert.ok(stub.requests.length > 0, "the backend really ran");
      // SEARCH_BACKEND_KEY belongs to a self-hosted backend, never to a
      // public SERP host or a fetched result page.
      stub.assertNoneCarry([...FORBIDDEN, "exa-secret"], assert.fail);
    });
  });

  test("nothing sensitive reaches the log either", async () => {
    const log = fakeLog();
    await withFakeFetch([[EXA_SEARCH, exaResults({ title: "T", url: "https://x/" })]], async () => {
      await webSearch(LOADED_ENV, log, "northvolt bankruptcy filing");
    });
    log.assertNoneLogged(["exa-secret", "berget-secret", "sk-ant-secret", "sk-openai-secret", "hunter2"], assert.fail);
  });
});
