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
  OUTROSPECT_QUOTE_CAPS,
  QUOTE_STOPWORDS_EN,
  QUOTE_STOPWORDS_SV,
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
  outrospectionAnswerPrompt,
  outrospectionBlock,
  outrospectionLensCatalog,
  outrospectionQuoteBlock,
  quoteTerms,
  refreshQueries,
  scorePassage,
  selectQuotes,
  splitPassages,
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

// ---------------------------------------------------------------------------
// OUTROSPECTION MODE — the answer block and prompt (the fifth chat mode)
// ---------------------------------------------------------------------------

const item = (over = {}) => ({
  key: over.url || "https://a.example/x",
  lens: "edge-rag",
  title: "A thing someone shipped",
  url: "https://a.example/x",
  teaser: "One paragraph about it.",
  source: "a.example",
  first_seen: 1_800_000_000_000,
  ...over,
});

test("outrospectionBlock numbers items newest-first and names the lens", () => {
  const block = outrospectionBlock([
    item({ title: "Newest", url: "https://a.example/1" }),
    item({ title: "Older", url: "https://a.example/2" }),
  ]);
  assert.match(block, /\[1\] Newest/);
  assert.match(block, /\[2\] Older/);
  // The lens TITLE, not the raw id — the answer model reads prose.
  assert.match(block, new RegExp(lensById("edge-rag").title));
  assert.match(block, /https:\/\/a\.example\/1/);
  assert.match(block, /2 items/);
});

// The empty-feed prompt orders the model to "name the lenses that exist". It
// could not: the block returned "" with no items, so nothing in context listed
// them, and the answer said "plus fyra till — jag har inte den fullständiga
// listan" (feedback #25, 2026-07-26). A prompt may not order what the context
// cannot supply, so the catalog is now unconditional.
test("outrospectionBlock ALWAYS carries the lens catalog, even with no items", () => {
  for (const empty of [[], null, undefined]) {
    const block = outrospectionBlock(empty);
    assert.ok(block, "an empty feed must still give the model the lenses to name");
    for (const lens of OUTROSPECT_LENSES) {
      assert.ok(block.includes(lens.title), `${lens.id} missing from the empty-feed block`);
      assert.ok(block.includes(lens.question), `${lens.id}'s standing question missing`);
    }
  }
});

test("outrospectionBlock: with items, the catalog AND the feed section are present", () => {
  const block = outrospectionBlock([item({ fresh: true })]);
  assert.match(block, /THE LENSES/);
  assert.match(block, /OUTWARD FEED/);
  assert.match(block, /· NEW/);
});

test("outrospectionLensCatalog: every lens, EN and SV (parity)", () => {
  const en = outrospectionLensCatalog(false);
  const sv = outrospectionLensCatalog(true);
  for (const lens of OUTROSPECT_LENSES) {
    assert.ok(en.includes(lens.title) && en.includes(lens.question), `${lens.id} missing from EN catalog`);
    assert.ok(sv.includes(lens.titleSv) && sv.includes(lens.questionSv), `${lens.id} missing from SV catalog`);
  }
  // The count is stated so the model never has to infer how many there are.
  assert.ok(en.includes(String(OUTROSPECT_LENSES.length)));
  assert.ok(sv.includes(String(OUTROSPECT_LENSES.length)));
});

test("outrospectionBlock honors the item and character caps", () => {
  const many = Array.from({ length: 60 }, (_, i) => item({ title: `T${i}`, url: `https://a.example/${i}` }));
  const capped = outrospectionBlock(many);
  assert.ok(!capped.includes("[25]"), "item cap not applied");
  // A tight char budget truncates further rather than overflowing.
  const tiny = outrospectionBlock(many, { chars: 500 });
  assert.ok(tiny.length < capped.length);
  assert.match(tiny, /\[1\]/);
});

test("outrospectionAnswerPrompt: grounded when there are items, honest when not", () => {
  const withItems = outrospectionAnswerPrompt({ lens: lensById("edge-rag"), hasItems: true });
  assert.match(withItems, /ONLY from the feed items/);
  assert.match(withItems, /\[1\], \[2\]/);
  assert.match(withItems, new RegExp(lensById("edge-rag").question.slice(0, 30)));

  const empty = outrospectionAnswerPrompt({ hasItems: false });
  assert.match(empty, /holds nothing on this yet/);
  // The load-bearing rule: never fabricate a feed item (the scan's rule, now
  // enforced where a model could be tempted to invent one).
  assert.match(empty, /NEVER invent articles/);
  assert.match(empty, /\/outrospect\//);
});

test("outrospectionAnswerPrompt has Swedish parity (invariant 6)", () => {
  // The DEFAULT prompt is bilingual, so a Swedish question gets a Swedish
  // answer without a second language detector (the orchestrator convention).
  assert.match(outrospectionAnswerPrompt({ hasItems: true }), /svara på svenska/i);
  // And the explicit Swedish leg is a full instruction, not a translated tail.
  const sv = outrospectionAnswerPrompt({ lens: lensById("edge-rag"), hasItems: true, swedish: true });
  assert.match(sv, /Svara på svenska\./);
  assert.match(sv, /ENBART utifrån flödesposterna/);
  assert.match(sv, new RegExp(lensById("edge-rag").questionSv.slice(0, 20)));
  const svEmpty = outrospectionAnswerPrompt({ hasItems: false, swedish: true });
  assert.match(svEmpty, /hitta ALDRIG på artiklar/);
});

// ---------------------------------------------------------------------------
// QUOTATION — the indexed article text and the passage scorer (feedback #28)
//
// The feed could list what other people shipped but never quote it. These
// cover the pure half of the fix: which words of a question count, how a
// document is cut into quotable passages, how a passage is scored, and the
// three rules that must hold no matter what — a quote is verbatim, a quote
// carries its own URL, and "nothing relevant" is a valid answer rather than a
// reason to invent one.
// ---------------------------------------------------------------------------

// Invariant 6 again, one level down: the passage scorer is a deterministic
// routing gate, and an English-only stop list would let Swedish function words
// ("och", "vilken", "hur") dominate the score of a Swedish question.
test("quote stop words: the Swedish set is as broad as the English one (parity)", () => {
  assert.ok(
    QUOTE_STOPWORDS_SV.length >= QUOTE_STOPWORDS_EN.length,
    `${QUOTE_STOPWORDS_SV.length} SV stop words vs ${QUOTE_STOPWORDS_EN.length} EN — Swedish must not be thinner`,
  );
  for (const list of [QUOTE_STOPWORDS_EN, QUOTE_STOPWORDS_SV]) {
    assert.equal(new Set(list).size, list.length, "stop words should not repeat");
    for (const w of list) assert.equal(w, w.toLowerCase());
  }
});

test("quoteTerms keeps the content words and drops the scaffolding, EN and SV alike", () => {
  const en = quoteTerms("How are the other deep research systems handling citations?");
  assert.deepEqual(en, ["deep", "research", "systems", "handling", "citations"]);
  // The Swedish question must reduce to its content words just as cleanly —
  // if it did not, every Swedish question would score on "vilka"/"hur".
  const sv = quoteTerms("Hur hanterar de andra deep research-systemen källhänvisningar?");
  assert.deepEqual(sv, ["hanterar", "deep", "research", "systemen", "källhänvisningar"]);
});

test("quoteTerms keeps short acronyms, dedupes, and caps", () => {
  assert.deepEqual(quoteTerms("AI and RAG and AI again"), ["ai", "rag", "again"]);
  assert.deepEqual(quoteTerms(""), []);
  assert.deepEqual(quoteTerms(null), []);
  const many = quoteTerms(Array.from({ length: 80 }, (_, i) => `term${i}`).join(" "));
  assert.equal(many.length, OUTROSPECT_QUOTE_CAPS.terms);
});

test("splitPassages cuts on paragraphs first and never exceeds the cap", () => {
  const text = "First paragraph about retrieval.\n\nSecond paragraph about vector search.";
  assert.deepEqual(splitPassages(text, { min: 0 }), [
    "First paragraph about retrieval.",
    "Second paragraph about vector search.",
  ]);
  const long = `${"Sentence about retrieval. ".repeat(60)}`;
  for (const p of splitPassages(long, { max: 200 })) assert.ok(p.length <= 200, `${p.length} > 200`);
});

test("splitPassages returns verbatim text — collapsed whitespace, no other edits", () => {
  const [p] = splitPassages("The   model  runs\n  in the browser, they said.", { min: 0 });
  assert.equal(p, "The model runs in the browser, they said.");
});

test("splitPassages: an unbroken wall of characters is hard-sliced, not dropped", () => {
  const wall = "x".repeat(1000);
  const parts = splitPassages(wall, { max: 300 });
  assert.ok(parts.length >= 3);
  for (const p of parts) assert.ok(p.length <= 300);
});

test("splitPassages: a page of only short lines still yields its best line", () => {
  const parts = splitPassages("Home\n\nAbout\n\nContact us today", { min: 200 });
  assert.deepEqual(parts, ["Contact us today"]);
  assert.deepEqual(splitPassages("", {}), []);
  assert.deepEqual(splitPassages(null, {}), []);
});

test("scorePassage: distinct coverage beats repetition", () => {
  const terms = ["retrieval", "browser", "embedding"];
  const broad = scorePassage("Retrieval in the browser with an embedding index.", terms);
  const narrow = scorePassage("retrieval retrieval retrieval retrieval retrieval", terms);
  assert.ok(broad > narrow, `${broad} should beat ${narrow}`);
  assert.equal(scorePassage("Nothing to do with any of it.", terms), 0);
  assert.equal(scorePassage("anything", []), 0);
});

test("scorePassage matches whole words, so 'rag' does not fire on 'fragment'", () => {
  assert.equal(scorePassage("a fragmented storage layer", ["rag"]), 0);
  assert.ok(scorePassage("a RAG pipeline", ["rag"]) > 0);
});

// A realistic stored body: paragraphs long enough to be worth quoting (the
// minimum passage length exists to keep navigation chrome — "Home", "About",
// "Subscribe" — out of an answer's quotation marks).
const INTRO =
  "An introductory paragraph that sets the scene at some length without ever saying anything much about the actual mechanism involved.";
const CORE =
  "The embedding index runs entirely in the browser, so retrieval never leaves the tab and no vector database is involved anywhere in the path.";
const OUTRO =
  "A closing note about the licence and where to file issues, which is not the reason anybody opened the page in the first place.";

const doc = (over = {}) => ({
  url: "https://a.example/x",
  title: "A thing someone shipped",
  source: "a.example",
  lens: "edge-rag",
  text: `${INTRO}\n\n${CORE}\n\n${OUTRO}`,
  ...over,
});

test("selectQuotes picks the passage that answers the question and carries its URL", () => {
  const quotes = selectQuotes("does the embedding index run in the browser?", [doc()]);
  assert.equal(quotes.length, 1);
  assert.equal(quotes[0].text, CORE);
  assert.equal(quotes[0].url, "https://a.example/x", "a quote without its source link is useless");
  assert.equal(quotes[0].n, 1);
  assert.ok(quotes[0].score > 0);
});

test("selectQuotes routes a Swedish question to the same passage (invariant 6)", () => {
  const sv = selectQuotes("kör embedding-indexet i browser?", [doc()]);
  assert.equal(sv.length, 1);
  assert.match(sv[0].text, /embedding index runs entirely in the browser/);
});

test("selectQuotes returns NOTHING when the stored text is irrelevant — it never invents", () => {
  assert.deepEqual(selectQuotes("what happened at the zoo yesterday", [doc()]), []);
  assert.deepEqual(selectQuotes("anything", []), []);
  assert.deepEqual(selectQuotes("anything", null), []);
});

test("selectQuotes: a question of pure scaffolding falls back to each article's opening", () => {
  // "what is new out there?" reduces to no scorable terms at all. Leading with
  // the opening passage is still REAL, attributable text — the alternative
  // (nothing) would make the commonest question in this mode the one that
  // never quotes.
  const quotes = selectQuotes("what is out there?", [doc(), doc({ url: "https://b.example/y" })]);
  assert.equal(quotes.length, 2);
  assert.equal(quotes[0].text, INTRO);
  assert.deepEqual(quotes.map((q) => q.url), ["https://a.example/x", "https://b.example/y"]);
});

test("selectQuotes honours the per-source, count and character caps", () => {
  const fat = doc({
    text: Array.from(
      { length: 12 },
      (_, i) => `Paragraph ${i}: the browser embedding index is described here in enough detail to be worth quoting back at somebody.`,
    ).join("\n\n"),
  });
  const one = selectQuotes("browser embedding index", [fat]);
  assert.equal(one.length, OUTROSPECT_QUOTE_CAPS.perSource, "one article may not fill the whole block");

  const many = Array.from({ length: 10 }, (_, i) => doc({ url: `https://a.example/${i}` }));
  assert.ok(selectQuotes("browser embedding index", many).length <= OUTROSPECT_QUOTE_CAPS.quotes);
  const tight = selectQuotes("browser embedding index", many, { chars: 60, perSource: 1 });
  assert.equal(tight.length, 1, "the char budget stops the block, but never below one quote");
});

test("selectQuotes drops a document with no usable URL rather than quoting it unattributably", () => {
  assert.deepEqual(selectQuotes("browser embedding index", [doc({ url: "javascript:alert(1)" })]), []);
  assert.deepEqual(selectQuotes("browser embedding index", [doc({ url: "" })]), []);
});

test("selectQuotes is deterministic — same question, same documents, same quotes", () => {
  const docs = [doc(), doc({ url: "https://b.example/y", title: "Another" })];
  assert.deepEqual(selectQuotes("browser embedding index", docs), selectQuotes("browser embedding index", docs));
});

test("outrospectionQuoteBlock renders every passage with its url, EN and SV", () => {
  const quotes = selectQuotes("browser embedding index", [doc()]);
  const en = outrospectionQuoteBlock(quotes);
  assert.match(en, /QUOTABLE PASSAGES/);
  assert.match(en, /\[Q1\]/);
  assert.match(en, /url: https:\/\/a\.example\/x/);
  assert.match(en, /a\.example/);
  const sv = outrospectionQuoteBlock(quotes, { swedish: true });
  assert.match(sv, /CITERBARA STYCKEN/);
  assert.match(sv, /url: https:\/\/a\.example\/x/);
  // Nothing to quote renders as nothing, not as an empty heading.
  assert.equal(outrospectionQuoteBlock([]), "");
  assert.equal(outrospectionQuoteBlock(null), "");
});

test("outrospectionBlock carries the quotes alongside the headlines", () => {
  const quotes = selectQuotes("browser embedding index", [doc()]);
  const block = outrospectionBlock([item()], { quotes });
  assert.match(block, /THE LENSES/);
  assert.match(block, /OUTWARD FEED/);
  assert.match(block, /QUOTABLE PASSAGES/);
  // Without quotes the block is exactly what it always was.
  assert.ok(!outrospectionBlock([item()]).includes("QUOTABLE PASSAGES"));
});

test("outrospectionAnswerPrompt: quoting is permitted only when passages are in context", () => {
  const withQuotes = outrospectionAnswerPrompt({ hasItems: true, hasQuotes: true });
  assert.match(withQuotes, /QUOTABLE PASSAGES/);
  assert.match(withQuotes, /WORD FOR WORD/);
  assert.match(withQuotes, /source link/);
  assert.match(withQuotes, /NEVER invent a quotation/);

  // The load-bearing half: with no stored text, quoting is forbidden outright.
  // This is where a model would otherwise write a plausible sentence and
  // attribute it to a real URL, which is the same fabrication the item rule
  // forbids one level up.
  const noQuotes = outrospectionAnswerPrompt({ hasItems: true, hasQuotes: false });
  assert.match(noQuotes, /do NOT quote verbatim/);
  assert.match(noQuotes, /Never invent a quotation/);
});

test("outrospectionAnswerPrompt: the quoting rule has Swedish parity (invariant 6)", () => {
  const sv = outrospectionAnswerPrompt({ hasItems: true, hasQuotes: true, swedish: true });
  assert.match(sv, /CITERBARA STYCKEN/);
  assert.match(sv, /ORDAGRANT/);
  assert.match(sv, /hitta ALDRIG på ett citat/);
  const svNone = outrospectionAnswerPrompt({ hasItems: true, hasQuotes: false, swedish: true });
  assert.match(svNone, /citera INGENTING ordagrant/);
});
