// (no @ts-check: node:test / node:assert have no type declarations in this
// repo — tsconfig's types is workers-only and @types/node would be a new
// dependency.)
// Covers sources.js: the source registry's dedup/numbering, the per-origin
// diversity cap + overflow backfill, the platform (HF owner) keying, and
// the capped sourceDigest block.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  hostnameOf,
  diversityKeyOf,
  addSources,
  backfillOverflowSources,
  digestShownCount,
  sourceDigest,
  sourceProgress,
  withSources,
} from "./sources.js";

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

// The digest is the ONLY view synthesis, the gap check and validation get of
// the registry. It used to stop at the first block that would not fit and
// return, so the sources past that point were invisible with no marker in the
// prompt and no counter anywhere — while `chat_logs` recorded the full
// registry, so an investigation into "why did it miss [26]?" got a row proving
// [26] was collected.
describe("sourceDigest — truncation is never silent", () => {
  const bulky = (n) => ({ n, title: "T".repeat(60), url: `https://ex.se/${n}`, highlights: ["H".repeat(600)] });

  test("a truncated digest says how many sources were omitted", () => {
    const sources = Array.from({ length: 10 }, (_, i) => bulky(i + 1));
    const digest = sourceDigest(sources, 3000);
    assert.match(digest, /\[1\]/);
    assert.doesNotMatch(digest, /\[10\] T/, "the tail really was cut");
    assert.match(digest, /further collected sources omitted/, "and the model is told so");
    assert.match(digest, /Cite only the numbers listed above/);
  });

  test("an untruncated digest carries no marker", () => {
    assert.doesNotMatch(sourceDigest([bulky(1), bulky(2)], 20_000), /omitted here for length/);
  });

  test("one oversized source no longer hides every shorter source after it", () => {
    // The old `break` meant a single long-highlight source truncated the whole
    // tail. Entries are numbered explicitly, so skipping one and keeping the
    // rest costs the reader nothing and keeps the answer its grounding.
    const huge = { n: 1, title: "H", url: "https://h.se", highlights: ["x".repeat(4000)] };
    const small = (n) => ({ n, title: `S${n}`, url: `https://s${n}.se`, highlights: ["y"] });
    const digest = sourceDigest([huge, small(2), small(3)], 1200);
    assert.doesNotMatch(digest, /\[1\] H/);
    assert.match(digest, /\[2\] S2/);
    assert.match(digest, /\[3\] S3/);
  });

  test("the marker never pushes the digest past the cap it was given", () => {
    const sources = Array.from({ length: 40 }, (_, i) => bulky(i + 1));
    for (const cap of [1000, 3000, 14_000, 18_000, 24_000]) {
      assert.ok(sourceDigest(sources, cap).length <= cap, `cap ${cap} respected with the marker`);
    }
  });

  test("digestShownCount reports what the model read, not what was collected", () => {
    const sources = Array.from({ length: 10 }, (_, i) => bulky(i + 1));
    assert.equal(digestShownCount(sources, 40_000), 10);
    assert.ok(digestShownCount(sources, 3000) < 10);
    assert.equal(digestShownCount([], 1000), 0);
  });

  test("the measured production shape: ~32 sources against an 18 000-char cap loses several", () => {
    // budget.js gives the common tier maxSources 24, and pipeline.js's aux
    // capacity reserve raises it by up to 8 per contributing source WITHOUT
    // raising digestCap. This pins the loss as REPORTED rather than silent.
    const sources = Array.from({ length: 32 }, (_, i) => bulky(i + 1));
    const shown = digestShownCount(sources, 18_000);
    assert.ok(shown < 32, "the mismatch is real");
    assert.match(sourceDigest(sources, 18_000), new RegExp(`${32 - shown} further collected source`));
  });
});

// The gap loop breaks when a follow-up wave found nothing new. It used to read
// `state.sources.length`, which the domain cap holds flat whenever a wave's
// finds were all capped — so a question whose answer lives across many pages
// of one authoritative origin stopped researching while it was still finding
// new pages.
describe("sourceProgress — the gap loop's saturation signal", () => {
  test("a wave whose finds are ALL domain-capped still counts as progress", () => {
    const state = freshState(24);
    addSources(state, [{ url: "https://gov.se/1" }, { url: "https://gov.se/2" }, { url: "https://gov.se/3" }]);
    const admittedBefore = state.sources.length;
    const before = sourceProgress(state);
    addSources(state, [{ url: "https://gov.se/4" }, { url: "https://gov.se/5" }]);
    assert.equal(state.sources.length, admittedBefore, "the old signal reads this as saturated");
    assert.equal(sourceProgress(state) - before, 2, "two genuinely new pages — progress, not exhaustion");
  });

  test("a wave that re-finds only known URLs is still saturation", () => {
    const state = freshState(24);
    addSources(state, [{ url: "https://gov.se/1" }, { url: "https://gov.se/2" }, { url: "https://gov.se/3" }]);
    addSources(state, [{ url: "https://gov.se/4" }]);
    const before = sourceProgress(state);
    // One already admitted, one already in overflow — nothing new either way.
    addSources(state, [{ url: "https://gov.se/1" }, { url: "https://gov.se/4" }]);
    assert.equal(sourceProgress(state) - before, 0, "overflow must dedup or saturation never fires");
  });

  test("unchanged when no overflow occurred", () => {
    const state = freshState(24);
    addSources(state, [{ url: "https://a.se/1" }, { url: "https://b.se/1" }]);
    assert.equal(sourceProgress(state), state.sources.length);
  });

  test("a registry already at maxSources still reads as saturated", () => {
    const state = freshState(2);
    addSources(state, [{ url: "https://a.se/1" }, { url: "https://b.se/1" }]);
    const before = sourceProgress(state);
    addSources(state, [{ url: "https://c.se/1" }]);
    assert.equal(sourceProgress(state) - before, 0, "a full registry can admit nothing more");
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

  // The detection used to be /(^|\n)\s*sources\s*:/i, which only matched a bare
  // `Sources:` at the start of a line. Every report tier in prompts.js asks for
  // markdown structure, so a model that reached for `### Sources:` got the list
  // appended a SECOND time — two source lists in one MCP answer, the model's
  // built from a possibly-truncated digest and the registry's full one, with
  // nothing saying which was authoritative.
  test("recognises the source list through the heading decorations models write", () => {
    for (const heading of [
      "### Sources:",
      "## Sources",
      "**Sources:**",
      "- Sources:",
      "#### **Sources**",
      "SOURCES:",
    ]) {
      const already = `answer body\n\n${heading}\n- [1] A — https://a.com`;
      assert.equal(withSources(already, sources), already, `did not recognise ${heading}`);
    }
  });

  // Same rule as every other routing gate in the repo (CLAUDE.md invariant 6):
  // a Swedish answer ends with `Källor:`, and matching only the English form
  // appended an English list underneath it.
  test("recognises the Swedish source heading too", () => {
    for (const heading of ["Källor:", "### Källor:", "**Källor**", "Kallor:"]) {
      const already = `svar\n\n${heading}\n- [1] A — https://a.com`;
      assert.equal(withSources(already, sources), already, `did not recognise ${heading}`);
    }
  });

  test("prose that merely mentions sources mid-sentence still gets the list", () => {
    const body = "We consulted many sources: books, papers and interviews.";
    assert.match(withSources(body, sources), /\n\nSources:\n/);
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
