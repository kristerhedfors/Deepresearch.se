import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { hostnameOf, addSources, backfillOverflowSources, sourceDigest } from "./sources.js";

function freshState(maxSources = 10) {
  return {
    sources: [],
    byUrl: new Map(),
    plan: { maxSources },
  };
}

describe("hostnameOf", () => {
  test("extracts the hostname and strips a leading www.", () => {
    assert.equal(hostnameOf("https://www.example.com/page?x=1"), "example.com");
  });
  test("leaves a non-www hostname alone", () => {
    assert.equal(hostnameOf("https://news.example.com/a"), "news.example.com");
  });
  test("falls back to the raw string for an unparseable URL, not a throw", () => {
    assert.equal(hostnameOf("not a url"), "not a url");
  });
});

describe("addSources", () => {
  test("adds sources in arrival order, numbered sequentially from 1", () => {
    const state = freshState();
    addSources(state, [{ url: "https://a.com/1", title: "A" }, { url: "https://b.com/1", title: "B" }]);
    assert.equal(state.sources.length, 2);
    assert.equal(state.sources[0].n, 1);
    assert.equal(state.sources[1].n, 2);
  });

  test("dedupes by URL across calls", () => {
    const state = freshState();
    addSources(state, [{ url: "https://a.com/1", title: "A" }]);
    addSources(state, [{ url: "https://a.com/1", title: "A again" }]);
    assert.equal(state.sources.length, 1);
  });

  test("skips items with no url", () => {
    const state = freshState();
    addSources(state, [{ title: "no url" }, null, { url: "https://a.com/1" }]);
    assert.equal(state.sources.length, 1);
  });

  test("caps at 3 sources per domain, routing the rest to overflow", () => {
    const state = freshState();
    const items = Array.from({ length: 5 }, (_, i) => ({ url: `https://same.com/page${i}`, title: `p${i}` }));
    addSources(state, items);
    assert.equal(state.sources.length, 3, "only 3 admitted from the same domain");
    assert.equal(state.sourceOverflow.length, 2, "the other 2 held in overflow");
  });

  test("different domains are counted independently of the shared domain cap", () => {
    const state = freshState();
    const items = [
      ...Array.from({ length: 3 }, (_, i) => ({ url: `https://same.com/${i}` })),
      { url: "https://other.com/1" },
    ];
    addSources(state, items);
    assert.equal(state.sources.length, 4);
    assert.equal(state.sourceOverflow.length, 0);
  });

  test("stops admitting once state.plan.maxSources is reached, even mid-batch", () => {
    const state = freshState(2);
    const items = [
      { url: "https://a.com/1" },
      { url: "https://b.com/1" },
      { url: "https://c.com/1" },
    ];
    addSources(state, items);
    assert.equal(state.sources.length, 2);
  });

  test("truncates highlights to the first 3", () => {
    const state = freshState();
    addSources(state, [{ url: "https://a.com/1", highlights: ["h1", "h2", "h3", "h4", "h5"] }]);
    assert.deepEqual(state.sources[0].highlights, ["h1", "h2", "h3"]);
  });

  test("falls back to the URL as title when no title is given", () => {
    const state = freshState();
    addSources(state, [{ url: "https://a.com/1" }]);
    assert.equal(state.sources[0].title, "https://a.com/1");
  });
});

describe("backfillOverflowSources", () => {
  test("fills up to maxSources from overflow when the registry is short", () => {
    const state = freshState(4);
    const items = Array.from({ length: 6 }, (_, i) => ({ url: `https://same.com/${i}` }));
    addSources(state, items); // 3 admitted, 3 overflow, registry short of maxSources=4
    assert.equal(state.sources.length, 3);
    backfillOverflowSources(state);
    assert.equal(state.sources.length, 4, "backfilled exactly one more from overflow");
  });

  test("does nothing when the registry already meets maxSources", () => {
    const state = freshState(3);
    const items = Array.from({ length: 5 }, (_, i) => ({ url: `https://same.com/${i}` }));
    addSources(state, items); // 3 admitted (== maxSources), 2 overflow
    backfillOverflowSources(state);
    assert.equal(state.sources.length, 3);
  });

  test("does nothing when overflow is empty even if short of maxSources", () => {
    const state = freshState(10);
    addSources(state, [{ url: "https://a.com/1" }]);
    backfillOverflowSources(state);
    assert.equal(state.sources.length, 1);
  });

  test("numbers backfilled sources continuing the existing sequence", () => {
    const state = freshState(4);
    const items = Array.from({ length: 5 }, (_, i) => ({ url: `https://same.com/${i}` }));
    addSources(state, items);
    backfillOverflowSources(state);
    assert.deepEqual(state.sources.map((s) => s.n), [1, 2, 3, 4]);
  });
});

describe("sourceDigest", () => {
  test("joins source blocks with a blank line between them", () => {
    const sources = [
      { n: 1, title: "A", url: "https://a.com", highlights: ["hi"] },
      { n: 2, title: "B", url: "https://b.com", highlights: [] },
    ];
    const digest = sourceDigest(sources, 10_000);
    assert.match(digest, /\[1\] A/);
    assert.match(digest, /\[2\] B/);
    assert.ok(digest.includes("\n\n"));
  });

  test("stops adding sources once the character cap would be exceeded", () => {
    const sources = [
      { n: 1, title: "A".repeat(50), url: "https://a.com", highlights: [] },
      { n: 2, title: "B".repeat(50), url: "https://b.com", highlights: [] },
    ];
    // Each block alone is ~68 chars; a cap that fits one but not two.
    const digest = sourceDigest(sources, 80);
    assert.match(digest, /\[1\]/);
    assert.doesNotMatch(digest, /\[2\]/);
  });

  test("empty source list returns an empty string", () => {
    assert.equal(sourceDigest([], 1000), "");
  });
});
