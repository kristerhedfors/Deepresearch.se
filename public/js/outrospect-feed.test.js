import test from "node:test";
import assert from "node:assert/strict";
// The feed-as-session-history surface: paging back through the feed, the
// incremental local index, and the excerpt block a question carries out.
// The DOM half (renderFeedEntry / mountFeedHistory) is verified live; this
// covers everything that decides WHAT gets shown, indexed and sent.
import {
  FEED_PAGE_SIZE,
  FEED_RETRIEVE_K,
  feedIndexText,
  feedItemIndexText,
  feedPage,
  outwardExcerptBlock,
  OUTROSPECT_LENSES,
} from "./outrospect-core.js";
import { unindexedItems } from "./outrospect-feed.js";

const item = (over = {}) => ({
  key: "https://a.example/x",
  lens: "edge-rag",
  title: "Headline",
  url: "https://a.example/x",
  teaser: "a teaser",
  source: "a.example",
  first_seen: 1_800_000_000_000,
  ...over,
});

const feed = (n) =>
  Array.from({ length: n }, (_, i) =>
    item({ key: `https://a.example/${i}`, url: `https://a.example/${i}`, title: `T${i}` }),
  );

// ---------------------------------------------------------------------------
// Paging — reading backwards through the feed
// ---------------------------------------------------------------------------

test("feedPage: a blank session opens on the newest page", () => {
  const items = feed(100);
  const { page, more, nextOffset } = feedPage(items, { size: 40 });
  assert.equal(page.length, 40);
  assert.equal(page[0].title, "T0", "the newest entry leads the first page");
  assert.equal(more, true);
  assert.equal(nextOffset, 40);
});

test("feedPage: successive offsets walk back without gaps or repeats", () => {
  const items = feed(100);
  const seen = [];
  let offset = 0;
  for (;;) {
    const r = feedPage(items, { offset, size: 30 });
    seen.push(...r.page.map((i) => i.title));
    offset = r.nextOffset;
    if (!r.more) break;
  }
  assert.equal(seen.length, 100);
  assert.equal(new Set(seen).size, 100, "no entry appears twice");
  assert.deepEqual(seen, items.map((i) => i.title), "and none is skipped");
});

test("feedPage: the last page reports no more, and an exhausted offset is empty", () => {
  const items = feed(10);
  const last = feedPage(items, { offset: 0, size: 10 });
  assert.equal(last.more, false);
  const past = feedPage(items, { offset: 10, size: 10 });
  assert.deepEqual(past.page, []);
  assert.equal(past.more, false);
});

test("feedPage survives junk and a shorter-than-a-page feed", () => {
  assert.deepEqual(feedPage(null).page, []);
  assert.deepEqual(feedPage(undefined).page, []);
  const short = feedPage(feed(3), { size: FEED_PAGE_SIZE });
  assert.equal(short.page.length, 3);
  assert.equal(short.more, false);
});

// ---------------------------------------------------------------------------
// Index text — a retrieved chunk must still be citable
// ---------------------------------------------------------------------------

test("feedItemIndexText is self-contained: title, lens, source and URL all present", () => {
  // The chunker can merge two short entries into one chunk, so an entry that
  // loses its URL on the way in is an article the answer cannot cite.
  const text = feedItemIndexText(item({ title: "A tiny model in the tab" }));
  assert.match(text, /A tiny model in the tab/);
  assert.match(text, /https:\/\/a\.example\/x/);
  assert.match(text, /a\.example/);
  assert.match(text, new RegExp(OUTROSPECT_LENSES.find((l) => l.id === "edge-rag").title));
  assert.match(text, /a teaser/);
});

test("feedItemIndexText does not throw on a half-formed item", () => {
  assert.equal(typeof feedItemIndexText({}), "string");
  assert.equal(typeof feedItemIndexText(null), "string");
});

test("feedIndexText covers every entry it is given", () => {
  const text = feedIndexText(feed(5));
  for (let i = 0; i < 5; i++) assert.match(text, new RegExp(`T${i}\\b`));
  assert.equal(feedIndexText(null), "");
});

// ---------------------------------------------------------------------------
// The incremental index — a revisit must not re-embed the whole feed
// ---------------------------------------------------------------------------

test("unindexedItems returns only what this browser has not indexed", () => {
  const items = feed(5);
  const known = items.slice(0, 3).map((i) => i.key);
  const fresh = unindexedItems(items, known);
  assert.equal(fresh.length, 2);
  assert.deepEqual(fresh.map((i) => i.title), ["T3", "T4"]);
});

test("unindexedItems: nothing known means everything is new; all known means none", () => {
  const items = feed(4);
  assert.equal(unindexedItems(items, []).length, 4);
  assert.equal(unindexedItems(items, items.map((i) => i.key)).length, 0);
});

test("unindexedItems drops keyless entries rather than indexing junk", () => {
  assert.equal(unindexedItems([{ title: "no key" }, null], []).length, 0);
  assert.deepEqual(unindexedItems(null, []), []);
});

// ---------------------------------------------------------------------------
// The outgoing block
// ---------------------------------------------------------------------------

test("outwardExcerptBlock labels the excerpts and asks for citation", () => {
  const block = outwardExcerptBlock([{ text: "## Some article\nurl: https://a.example/1" }]);
  assert.match(block, /OUTWARD FEED/);
  assert.match(block, /cite them/i);
  assert.match(block, /https:\/\/a\.example\/1/);
});

test("outwardExcerptBlock is empty when nothing was retrieved", () => {
  // "" matters: it is what makes the whole feature fail soft — no index, no
  // network, no match all leave the outgoing message byte-identical.
  assert.equal(outwardExcerptBlock([]), "");
  assert.equal(outwardExcerptBlock(null), "");
  assert.equal(outwardExcerptBlock([{ text: "   " }, {}]), "");
});

test("outwardExcerptBlock honours the retrieval cap", () => {
  const many = Array.from({ length: 40 }, (_, i) => ({ text: `entry ${i}` }));
  const block = outwardExcerptBlock(many, { limit: 3 });
  assert.match(block, /entry 0/);
  assert.match(block, /entry 2/);
  assert.ok(!block.includes("entry 3"), "cap not applied");
  assert.ok(FEED_RETRIEVE_K > 0 && FEED_RETRIEVE_K <= 20);
});
