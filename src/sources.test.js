// (no @ts-check: node:test / node:assert have no type declarations in this
// repo — tsconfig's types is workers-only and @types/node would be a new
// dependency.)
// Covers sources.js: the source registry's dedup/numbering, the per-origin
// diversity cap + overflow backfill, the platform (HF owner) keying, and
// the capped sourceDigest block.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { hostnameOf, diversityKeyOf, addSources, backfillOverflowSources, sourceDigest, withSources } from "./sources.js";

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

describe("withSources", () => {
  const sources = [
    { n: 1, title: "A", url: "https://a.com", highlights: [] },
    { n: 2, title: "B", url: "https://b.com", highlights: [] },
  ];

  test("appends a one-line-per-source 'Sources:' block", () => {
    const out = withSources("answer body", sources);
    assert.match(out, /^answer body\n\nSources:\n/);
    assert.ok(out.includes("[1] A — https://a.com"));
    assert.ok(out.includes("[2] B — https://b.com"));
  });

  test("no sources returns the text unchanged", () => {
    assert.equal(withSources("answer body", []), "answer body");
    assert.equal(withSources("answer body", undefined), "answer body");
  });

  test("does not double-print when the text already carries a Sources: list", () => {
    const already = "answer body\n\nSources:\n[1] A — https://a.com";
    assert.equal(withSources(already, sources), already);
  });
});

describe("diversityKeyOf — hf.co owner-namespace keying", () => {
  test("non-HF URLs key by hostname as before", () => {
    assert.equal(diversityKeyOf("https://www.bbc.com/news/article"), "bbc.com");
  });

  test("HF models/datasets/spaces key by owner; papers share one bucket", () => {
    assert.equal(diversityKeyOf("https://huggingface.co/KBLab/kb-whisper-large"), "huggingface.co/KBLab");
    assert.equal(diversityKeyOf("https://huggingface.co/datasets/vtllms/sealqa"), "huggingface.co/vtllms");
    assert.equal(diversityKeyOf("https://huggingface.co/spaces/foo/bar"), "huggingface.co/foo");
    assert.equal(diversityKeyOf("https://huggingface.co/papers/2505.17538"), "huggingface.co/papers");
    assert.equal(diversityKeyOf("https://huggingface.co/google"), "huggingface.co/google");
    assert.equal(diversityKeyOf("https://huggingface.co/"), "huggingface.co");
  });

  test("the domain cap therefore applies per HF owner, not per hub", () => {
    const state = freshState(10);
    addSources(state, [
      { url: "https://huggingface.co/orgA/m1", title: "a1" },
      { url: "https://huggingface.co/orgA/m2", title: "a2" },
      { url: "https://huggingface.co/orgA/m3", title: "a3" },
      { url: "https://huggingface.co/orgA/m4", title: "a4" }, // 4th from orgA -> overflow
      { url: "https://huggingface.co/datasets/orgB/d1", title: "b1" }, // different owner: admitted
      { url: "https://huggingface.co/orgC/m1", title: "c1" },
    ]);
    const urls = state.sources.map((s) => s.url);
    assert.ok(!urls.includes("https://huggingface.co/orgA/m4"));
    assert.ok(urls.includes("https://huggingface.co/datasets/orgB/d1"));
    assert.ok(urls.includes("https://huggingface.co/orgC/m1"));
    assert.equal(state.sourceOverflow.length, 1);
  });
});
