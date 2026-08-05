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
    // tail. It was then fixed by SKIPPING the oversized block — this test used
    // to assert [1] was absent. With the per-source fair share it is no longer
    // dropped at all: its excerpt is clipped to its share and the source stays
    // citable, which is strictly more than the model had before.
    const huge = { n: 1, title: "H", url: "https://h.se", highlights: ["x".repeat(4000)] };
    const small = (n) => ({ n, title: `S${n}`, url: `https://s${n}.se`, highlights: ["y"] });
    const digest = sourceDigest([huge, small(2), small(3)], 1200);
    assert.match(digest, /\[1\] H/, "the long source is clipped, not dropped");
    assert.match(digest, /\[…\]/, "and the clip is explicit");
    assert.ok(!digest.includes("x".repeat(4000)), "its excerpt really was shortened");
    assert.match(digest, /\[2\] S2/);
    assert.match(digest, /\[3\] S3/);
    assert.ok(digest.length <= 1200);
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

  test("~32 bulky sources against an 18 000-char cap now all fit, clipped", () => {
    // budget.js gives the common tier maxSources 24, and pipeline.js's aux
    // capacity reserve raises it by up to 8 per contributing source WITHOUT
    // raising digestCap. This test used to assert the loss (`shown < 32`) and
    // only that it was REPORTED; the per-source fair share removes the loss —
    // 32 × ~680 chars fits an 18 000-char window once no block may take more
    // than its share, so every source is shown with a shortened excerpt.
    const sources = Array.from({ length: 32 }, (_, i) => bulky(i + 1));
    const digest = sourceDigest(sources, 18_000);
    assert.equal(digestShownCount(sources, 18_000), 32, "no source is starved out");
    assert.match(digest, /\[32\] T/, "including the last one");
    assert.match(digest, /\[…\]/, "excerpts were shortened to make room");
    assert.doesNotMatch(digest, /omitted here for length/, "nothing was dropped");
    assert.ok(digest.length <= 18_000);
  });

  test("dropping is still the last resort when even the floor share cannot fit", () => {
    // 40 sources against 3 000 chars is under ~75 chars each: past the point
    // where a shortened excerpt says anything, so the digest goes back to
    // carrying fewer sources — and says how many it left out.
    const sources = Array.from({ length: 40 }, (_, i) => bulky(i + 1));
    const digest = sourceDigest(sources, 3000);
    const shown = digestShownCount(sources, 3000);
    assert.ok(shown > 0 && shown < 40, `expected a partial list, got ${shown}`);
    assert.match(digest, new RegExp(`${40 - shown} further collected sources omitted`));
    assert.ok(digest.length <= 3000);
  });
});

// The measured production shape behind feedback #61 / chat_logs #1656: a
// 600-second run collected 35 sources, [1]-[13] biomedical records of ~1 300
// chars each (title + url + provenance + authors ≤180 + abstract ≤900) and
// [14]-[35] the ~400-char web pages that actually answered the question — an
// alumni page, the trade press, an interview. Filled in arrival order the
// thirteen ate the whole window and synthesis never saw the tail, so the
// answer asserted no independent coverage existed among the numbered sources.
describe("sourceDigest — a run of verbose early sources cannot starve the tail", () => {
  const verbose = (n) => ({
    n,
    title: `Long biomedical paper title about a molecular mechanism, cohort and outcome ${n} ${"t".repeat(30)}`,
    url: `https://europepmc.org/article/MED/${30000000 + n}`,
    highlights: [
      "Europe PMC · 2021 · Journal of Something · cited 41× · peer-reviewed: indexed in MEDLINE",
      "A".repeat(178),
      "a".repeat(898),
    ],
  });
  const web = (n) => ({
    n,
    title: `Relevant web page ${n}`,
    url: `https://relevant${n}.example/story`,
    highlights: ["w".repeat(180), "x".repeat(160)],
  });
  const productionShape = [
    ...Array.from({ length: 13 }, (_, i) => verbose(i + 1)),
    ...Array.from({ length: 20 }, (_, i) => web(i + 14)),
  ];

  for (const cap of [18_000, 24_000]) {
    test(`every one of the 33 sources is visible at a ${cap}-char cap`, () => {
      const digest = sourceDigest(productionShape, cap);
      for (const s of productionShape) {
        assert.match(digest, new RegExp(`\\[${s.n}\\] `), `[${s.n}] must be in the digest`);
      }
      assert.equal(digestShownCount(productionShape, cap), 33);
      assert.doesNotMatch(digest, /omitted here for length/);
      assert.ok(digest.length <= cap, `stayed inside ${cap}`);
    });
  }

  test("the tail keeps its FULL excerpt — only the verbose blocks pay", () => {
    const digest = sourceDigest(productionShape, 18_000);
    // A short block is under its share, so water-filling leaves it untouched.
    assert.ok(digest.includes(`https://relevant33.example/story\n${"w".repeat(180)}`));
    // The long ones are clipped instead of dropped, and say so.
    assert.match(digest, /\[…\]/);
    assert.ok(!digest.includes("a".repeat(898)), "the 900-char abstracts were shortened");
  });

  test("the citation numbers stay stable and in order", () => {
    const shown = [...sourceDigest(productionShape, 18_000).matchAll(/(^|\n\n)\[(\d+)\] /g)].map((m) =>
      Number(m[2]),
    );
    assert.deepEqual(shown, productionShape.map((s) => s.n));
  });

  test("a still-tighter cap degrades by clipping first, dropping only after", () => {
    // The floor tier. Everything still fits once no block may take more than
    // its share — the previous implementation showed 11 of 33 here.
    assert.equal(digestShownCount(productionShape, 14_000), 33);
  });
});

describe("sourceDigest — fail-soft", () => {
  test("malformed entries are skipped rather than thrown on", () => {
    const sources = [
      { n: 1, title: "A", url: "https://a.se", highlights: ["ok"] },
      null,
      // highlights is not an array — a shape no producer should emit, but the
      // digest must not be the thing that fails the request.
      { n: 2, title: "B", url: "https://b.se", highlights: "oops" },
      { n: 3, title: "C", url: "https://c.se" },
    ];
    const digest = sourceDigest(sources, 10_000);
    assert.match(digest, /\[1\] A/);
    assert.match(digest, /\[2\] B/);
    assert.match(digest, /\[3\] C/);
    assert.equal(digestShownCount(sources, 10_000), 3);
  });

  test("a non-list or an absent cap degrades instead of erroring", () => {
    assert.equal(sourceDigest(null, 10_000), "");
    assert.equal(sourceDigest(undefined, 10_000), "");
    assert.equal(digestShownCount(null, 10_000), 0);
    const sources = [{ n: 1, title: "A", url: "https://a.se", highlights: ["hi"] }];
    assert.match(sourceDigest(sources, undefined), /\[1\] A/);
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

  // A heading is not a list. Long generations on this catalogue are recorded
  // stopping early and cleanly — sometimes right after writing the heading,
  // sometimes mid-URL inside it. Suppressing on the heading alone would hand
  // an MCP caller an answer with NO usable sources, which is worse than the
  // double-printing the check exists to prevent.
  test("a truncated source list still gets the registry appended", () => {
    for (const truncated of [
      "answer body [1].\n\n### Sources:",
      "answer body [1].\n\n### Sources:\n",
      "answer body [1].\n\nSources:\n- [1] A — https",
    ]) {
      assert.match(withSources(truncated, sources), /\n\nSources:\n\[1\] A — https:\/\/a\.com/, truncated);
    }
  });

  test("one surviving entry is enough to count as a real list", () => {
    const partial = "answer body [1].\n\n### Sources:\n- [1] A — https://a.com\n- [2] B — http";
    assert.equal(withSources(partial, sources), partial);
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
