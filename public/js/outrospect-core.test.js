import test from "node:test";
import assert from "node:assert/strict";
// The outrospection core: the lens registry, the deterministic lens router
// (EN + SV parity, invariant 6), item normalization, and — the part the whole
// feature turns on — the DELTA and the merge that decides what counts as new.
import {
  FRESH_WINDOW_MS,
  LENS_IDS,
  OUTROSPECT_CAPS,
  OUTROSPECT_LENSES,
  deltaItems,
  feedItemFromSearch,
  formatFeedText,
  itemSource,
  lensById,
  lensMatch,
  lensTally,
  mergeFeed,
  normalizeItemUrl,
  normalizeLens,
  refreshQueries,
  stalestLens,
  validateFeedItem,
} from "./outrospect-core.js";

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

test("every lens is complete and its ids are unique", () => {
  assert.ok(OUTROSPECT_LENSES.length >= 5, "the registry should cover the standing questions");
  const ids = new Set();
  for (const lens of OUTROSPECT_LENSES) {
    assert.match(lens.id, /^[a-z][a-z0-9-]*$/, `${lens.id} should be a slug`);
    assert.ok(!ids.has(lens.id), `${lens.id} is duplicated`);
    ids.add(lens.id);
    for (const field of ["title", "titleSv", "question", "questionSv"]) {
      assert.ok(lens[field] && lens[field].length > 3, `${lens.id}.${field} missing`);
    }
    assert.ok(lens.queries.length >= 2, `${lens.id} needs queries to search with`);
    for (const q of lens.queries) assert.equal(typeof q, "string");
    assert.ok(lens.terms.length, `${lens.id} needs EN routing terms`);
    assert.ok(lens.termsSv.length, `${lens.id} needs SV routing terms`);
  }
  assert.deepEqual(LENS_IDS, OUTROSPECT_LENSES.map((l) => l.id));
});

// Invariant 6: every deterministic routing gate takes Swedish with the same
// breadth as English. A lens with fewer Swedish forms than English ones is the
// exact drift this test exists to catch.
test("lens routing: Swedish term sets are as broad as the English ones (parity)", () => {
  for (const lens of OUTROSPECT_LENSES) {
    assert.ok(
      lens.termsSv.length >= lens.terms.length,
      `${lens.id}: ${lens.termsSv.length} SV terms vs ${lens.terms.length} EN — Swedish must not be thinner`,
    );
  }
});

test("lensMatch: routes English notes to the right standing question", () => {
  assert.equal(lensMatch("this library could be our only dependency"), "one-dependency");
  assert.equal(lensMatch("a new WebGPU model that runs on-device"), "browser-models");
  assert.equal(lensMatch("client-side vector search for RAG"), "edge-rag");
  assert.equal(lensMatch("their agent loop uses function calling"), "llm-architecture");
  assert.equal(lensMatch("end-to-end encrypted, local-first privacy"), "privacy-llm");
  assert.equal(lensMatch("the MCP specification adds a capability"), "agent-standards");
  assert.equal(lensMatch("another deep research assistant with citations"), "deep-research");
});

test("lensMatch: Swedish notes route the same way (parity)", () => {
  assert.equal(lensMatch("det här biblioteket kan bli vårt enda beroende"), "one-dependency");
  assert.equal(lensMatch("en ny modell som kör lokalt på enheten"), "browser-models");
  assert.equal(lensMatch("vektorsökning i webbläsaren för kunskapsbasen"), "edge-rag");
  assert.equal(lensMatch("deras arkitektur bygger på verktygsanrop"), "llm-architecture");
  assert.equal(lensMatch("kryptering och integritet, lokalt först"), "privacy-llm");
  assert.equal(lensMatch("specifikationen för protokollet uppdaterades"), "agent-standards");
  assert.equal(lensMatch("en annan forskningsassistent med källhänvisningar"), "deep-research");
});

test("lensMatch: definite and plural Swedish forms hit, not just the base word", () => {
  // The Swedish definite form is the common failure mode of an English-first
  // gate: "beroendet"/"beroendena" are what a Swedish note actually says.
  assert.equal(lensMatch("beroendet är för stort"), "one-dependency");
  assert.equal(lensMatch("beroendena växer"), "one-dependency");
  assert.equal(lensMatch("arkitekturen håller inte"), "llm-architecture");
  assert.equal(lensMatch("integriteten är hela poängen"), "privacy-llm");
  assert.equal(lensMatch("standarderna konvergerar"), "agent-standards");
});

test("lensMatch: no match returns null rather than guessing a lens", () => {
  assert.equal(lensMatch("the weather in Umeå is cold"), null);
  assert.equal(lensMatch(""), null);
  assert.equal(lensMatch(null), null);
  assert.equal(lensMatch(undefined), null);
});

test("lensMatch: word boundaries — a term inside a longer word does not fire", () => {
  // "rag" must not match "fragrance"; "standard" must not match "standardize"
  // as a hit for a note that is plainly about something else.
  assert.notEqual(lensMatch("the fragrance industry"), "edge-rag");
});

test("normalizeLens clamps to the registry", () => {
  assert.equal(normalizeLens("edge-rag"), "edge-rag");
  assert.equal(normalizeLens("nonsense"), LENS_IDS[0]);
  assert.equal(normalizeLens(null, "privacy-llm"), "privacy-llm");
  assert.equal(lensById("edge-rag").id, "edge-rag");
  assert.equal(lensById("nope"), null);
});

// ---------------------------------------------------------------------------
// Item identity — the thing that decides whether an article is "new"
// ---------------------------------------------------------------------------

test("normalizeItemUrl: the same article in different clothes is ONE key", () => {
  const canonical = normalizeItemUrl("https://example.com/post");
  assert.equal(normalizeItemUrl("http://www.example.com/post/"), canonical);
  assert.equal(normalizeItemUrl("https://example.com/post#section"), canonical);
  assert.equal(normalizeItemUrl("https://EXAMPLE.com/post?utm_source=news"), canonical);
  assert.equal(normalizeItemUrl("https://example.com/post?fbclid=abc"), canonical);
});

test("normalizeItemUrl: meaningful query parameters are KEPT", () => {
  // Stripping every parameter would collapse genuinely different pages.
  assert.notEqual(normalizeItemUrl("https://example.com/p?id=1"), normalizeItemUrl("https://example.com/p?id=2"));
});

test("normalizeItemUrl: rejects anything that is not an http(s) page", () => {
  assert.equal(normalizeItemUrl("javascript:alert(1)"), "");
  assert.equal(normalizeItemUrl("data:text/html,hi"), "");
  assert.equal(normalizeItemUrl("not a url"), "");
  assert.equal(normalizeItemUrl(""), "");
  assert.equal(normalizeItemUrl(null), "");
});

test("itemSource strips www and yields a display host", () => {
  assert.equal(itemSource("https://www.simonwillison.net/2026/x"), "simonwillison.net");
  assert.equal(itemSource("garbage"), "");
});

test("validateFeedItem: needs a usable url AND a title", () => {
  assert.equal(validateFeedItem({ url: "https://a.example/x" }).ok, false);
  assert.equal(validateFeedItem({ title: "Headline" }).ok, false);
  assert.equal(validateFeedItem(null).ok, false);
  const v = validateFeedItem({ lens: "edge-rag", title: "Headline", url: "https://a.example/x" });
  assert.equal(v.ok, true);
  assert.equal(v.value.lens, "edge-rag");
  assert.equal(v.value.source, "a.example");
  assert.ok(v.value.first_seen > 0);
});

test("validateFeedItem clamps oversized fields instead of rejecting", () => {
  const v = validateFeedItem({
    title: "T".repeat(OUTROSPECT_CAPS.title + 500),
    teaser: "x".repeat(OUTROSPECT_CAPS.teaser + 500),
    url: "https://a.example/x",
  });
  assert.equal(v.ok, true);
  assert.equal(v.value.title.length, OUTROSPECT_CAPS.title);
  assert.equal(v.value.teaser.length, OUTROSPECT_CAPS.teaser);
});

test("validateFeedItem: an unknown lens falls back rather than storing garbage", () => {
  const v = validateFeedItem({ lens: "made-up", title: "T", url: "https://a.example/x" });
  assert.equal(v.ok, true);
  assert.ok(LENS_IDS.includes(v.value.lens));
});

test("feedItemFromSearch turns a search result into an item, highlights as teaser", () => {
  const item = feedItemFromSearch("browser-models", {
    title: "A tiny model runs in the tab",
    url: "https://a.example/tiny",
    highlights: ["It fits in 400 MB.", "WebGPU only."],
  }, { query: "webgpu" });
  assert.equal(item.lens, "browser-models");
  assert.equal(item.teaser, "It fits in 400 MB. … WebGPU only.");
  assert.equal(item.query, "webgpu");
  assert.equal(feedItemFromSearch("browser-models", { title: "no url" }), null);
});

// ---------------------------------------------------------------------------
// The delta — the product of a scan
// ---------------------------------------------------------------------------

test("deltaItems returns only what was never seen", () => {
  const known = ["https://a.example/one"];
  const fresh = deltaItems(known, [
    { lens: "edge-rag", title: "One", url: "https://a.example/one" },
    { lens: "edge-rag", title: "Two", url: "https://a.example/two" },
  ]);
  assert.equal(fresh.length, 1);
  assert.equal(fresh[0].title, "Two");
});

test("deltaItems: a known item in different clothes is still known", () => {
  // The whole reason normalizeItemUrl exists — a tracking parameter must not
  // make an article re-flash as new every single scan.
  const fresh = deltaItems(["https://example.com/post"], [
    { lens: "edge-rag", title: "Post", url: "http://www.example.com/post/?utm_source=x" },
  ]);
  assert.equal(fresh.length, 0);
});

test("deltaItems accepts stored ROWS as `known`, not just keys", () => {
  const fresh = deltaItems([{ url: "https://a.example/one" }], [
    { lens: "edge-rag", title: "One again", url: "https://a.example/one" },
  ]);
  assert.equal(fresh.length, 0);
});

test("deltaItems dedupes WITHIN the incoming batch too", () => {
  // Two lenses' queries routinely surface the same article in one scan.
  const fresh = deltaItems([], [
    { lens: "edge-rag", title: "Same", url: "https://a.example/x" },
    { lens: "llm-architecture", title: "Same", url: "https://a.example/x?utm_source=y" },
  ]);
  assert.equal(fresh.length, 1);
});

test("deltaItems drops unusable results rather than storing them", () => {
  assert.equal(deltaItems([], [{ title: "no url" }, null, "nonsense"]).length, 0);
});

// ---------------------------------------------------------------------------
// The merge
// ---------------------------------------------------------------------------

test("mergeFeed dedupes across streams and keeps the EARLIEST first_seen", () => {
  const now = 1_800_000_000_000;
  const merged = mergeFeed(
    [
      [{ lens: "edge-rag", title: "Old news", url: "https://a.example/x", first_seen: now - 100_000 }],
      [{ lens: "edge-rag", title: "Old news", url: "https://a.example/x", first_seen: now }],
    ],
    { now },
  );
  assert.equal(merged.length, 1);
  // Re-finding an article must NOT bump it back to the top of the page.
  assert.equal(merged[0].first_seen, now - 100_000);
});

test("mergeFeed flags fresh strictly by the window", () => {
  const now = 1_800_000_000_000;
  const merged = mergeFeed(
    [
      [
        { lens: "edge-rag", title: "New", url: "https://a.example/new", first_seen: now - 1000 },
        { lens: "edge-rag", title: "Old", url: "https://a.example/old", first_seen: now - FRESH_WINDOW_MS - 1 },
      ],
    ],
    { now },
  );
  assert.equal(merged.find((i) => i.title === "New").fresh, true);
  assert.equal(merged.find((i) => i.title === "Old").fresh, false);
});

test("mergeFeed sorts newest first, filters by lens, and caps", () => {
  const now = 1_800_000_000_000;
  const items = Array.from({ length: 5 }, (_, i) => ({
    lens: i % 2 ? "edge-rag" : "privacy-llm",
    title: `T${i}`,
    url: `https://a.example/${i}`,
    first_seen: now - i * 1000,
  }));
  const merged = mergeFeed([items], { now });
  assert.deepEqual(merged.map((i) => i.title), ["T0", "T1", "T2", "T3", "T4"]);
  assert.equal(mergeFeed([items], { now, lens: "edge-rag" }).length, 2);
  assert.equal(mergeFeed([items], { now, limit: 2 }).length, 2);
});

test("mergeFeed keeps the richer teaser when the same item arrives twice", () => {
  const merged = mergeFeed([
    [{ lens: "edge-rag", title: "X", url: "https://a.example/x", teaser: "short" }],
    [{ lens: "edge-rag", title: "X", url: "https://a.example/x", teaser: "a considerably longer teaser" }],
  ]);
  assert.equal(merged[0].teaser, "a considerably longer teaser");
});

test("mergeFeed survives junk streams without throwing", () => {
  assert.deepEqual(mergeFeed(null), []);
  assert.deepEqual(mergeFeed([null, undefined, "nope", [{ nothing: true }]]), []);
});

test("lensTally counts totals and fresh per lens", () => {
  const now = 1_800_000_000_000;
  const merged = mergeFeed(
    [
      [
        { lens: "edge-rag", title: "A", url: "https://a.example/a", first_seen: now },
        { lens: "edge-rag", title: "B", url: "https://a.example/b", first_seen: now - FRESH_WINDOW_MS - 1 },
      ],
    ],
    { now },
  );
  const tally = lensTally(merged);
  assert.deepEqual(tally["edge-rag"], { total: 2, fresh: 1 });
  assert.deepEqual(tally["privacy-llm"], { total: 0, fresh: 0 });
});

// ---------------------------------------------------------------------------
// Refresh scheduling
// ---------------------------------------------------------------------------

test("refreshQueries caps the fan-out and walks the list across runs", () => {
  const lens = OUTROSPECT_LENSES[0];
  const first = refreshQueries(lens.id, { max: 2, offset: 0 });
  assert.equal(first.length, 2);
  assert.deepEqual(first, lens.queries.slice(0, 2));
  // A later run starts where the last one left off, so a query at the end of
  // the list is not one that never gets issued.
  const second = refreshQueries(lens.id, { max: 2, offset: 2 });
  assert.notDeepEqual(second, first);
  assert.equal(refreshQueries("nonexistent-lens", { max: 2 }).length, 2, "clamps to a real lens");
});

test("refreshQueries never asks for more queries than a lens has", () => {
  for (const lens of OUTROSPECT_LENSES) {
    assert.ok(refreshQueries(lens.id, { max: 99 }).length <= lens.queries.length);
  }
});

test("stalestLens picks the lens whose newest item is oldest", () => {
  const now = 1_800_000_000_000;
  const items = LENS_IDS.map((lens, i) => ({
    lens,
    title: lens,
    url: `https://a.example/${lens}`,
    first_seen: now - i * 1000, // the LAST lens is the stalest
  }));
  assert.equal(stalestLens(items), LENS_IDS[LENS_IDS.length - 1]);
});

test("stalestLens prefers a lens with nothing at all", () => {
  const now = 1_800_000_000_000;
  const items = LENS_IDS.slice(1).map((lens) => ({
    lens,
    title: lens,
    url: `https://a.example/${lens}`,
    first_seen: now,
  }));
  assert.equal(stalestLens(items), LENS_IDS[0]);
});

test("stalestLens skips lenses on cooldown, and never returns nothing", () => {
  const skip = LENS_IDS.slice(0, LENS_IDS.length - 1);
  assert.equal(stalestLens([], { skip }), LENS_IDS[LENS_IDS.length - 1]);
  // Everything on cooldown still yields a lens rather than undefined — the
  // caller decides whether to actually search.
  assert.ok(LENS_IDS.includes(stalestLens([], { skip: LENS_IDS })));
});

// ---------------------------------------------------------------------------
// Text rendering (the ?format=text / scan-script view)
// ---------------------------------------------------------------------------

test("formatFeedText renders the tally, marks NEW, and says so when empty", () => {
  const now = 1_800_000_000_000;
  const merged = mergeFeed(
    [[{ lens: "edge-rag", title: "Fresh thing", url: "https://a.example/x", first_seen: now }]],
    { now },
  );
  const text = formatFeedText(merged, { now });
  assert.match(text, /OUTROSPECTION FEED/);
  assert.match(text, /edge-rag/);
  assert.match(text, /NEW .*Fresh thing/);
  assert.match(text, /https:\/\/a\.example\/x/);
  assert.match(formatFeedText([], { now }), /no items yet/);
});
