// Unit tests for the arXiv search source (src/arxiv.js).
//
// The live-API semantics these tests encode were established by probing the
// real endpoint (2026-07-26) — see the module header. What is pinned here is
// the pure logic: intent routing (both directions, both languages), noise
// stripping, the AND ladder, Atom parsing, item mapping, dedup and diversity
// keying.
import test from "node:test";
import assert from "node:assert/strict";

import {
  ARXIV_MAX_PER_REQUEST,
  arxivAttempts,
  arxivCacheKey,
  arxivDistinctiveness,
  arxivDiversityKey,
  arxivId,
  arxivIdOf,
  arxivIntent,
  arxivMapEntry,
  arxivParseFeed,
  arxivPickQuery,
  arxivRankedTerms,
  arxivSearch,
  arxivSearchQuery,
  arxivSelectTerms,
  arxivTermKey,
  arxivTerms,
} from "./arxiv.js";

const log = { info() {}, warn() {}, error() {}, debug() {} };

test("arxivIntent", async (t) => {
  await t.test("fires on explicit arXiv / preprint mentions", () => {
    for (const s of [
      "what does arxiv say about diffusion models",
      "summarize arxiv.org/abs/2606.09730",
      "arXiv:2606.09730 please",
      "any preprints on this",
      "is there an e-print for it",
    ]) {
      assert.equal(arxivIntent(s), true, s);
    }
  });

  await t.test("fires on scientific-literature vocabulary, whatever the topic", () => {
    for (const s of [
      "what do the papers say about intermittent fasting",
      "any peer-reviewed studies on this",
      "recent publications about coral bleaching",
      "show me the literature",
      "what does the research say",
    ]) {
      assert.equal(arxivIntent(s), true, s);
    }
  });

  await t.test("fires on research phrasing WITH a scientific topic", () => {
    // The reported failure this module exists to fix, verbatim (2026-07-26):
    // five web searches ran and arXiv was never asked, although every primary
    // source Exa returned was itself an arxiv.org page.
    assert.equal(
      arxivIntent(
        "Latest on llm swarm reasoning and how many agents with the same model Can work together and become smarter than just one",
      ),
      true,
    );
    for (const s of [
      "latest advances in reinforcement learning",
      "does quantization outperform distillation for llms",
      "state of the art in protein folding",
      "how many agents work together in multi-agent reasoning",
    ]) {
      assert.equal(arxivIntent(s), true, s);
    }
  });

  await t.test("does not fire on ordinary questions (no step, no event, no fetch)", () => {
    for (const s of [
      "what's the weather in Stockholm",
      "the latest iPhone camera compared to Pixel",
      "best pizza in Gothenburg",
      "how do I reset my password",
      "what model are you using",
      "latest news about the election",
      "",
      null,
      undefined,
    ]) {
      assert.equal(arxivIntent(s), false, String(s));
    }
  });

  // Invariant 6: Swedish forms carry the same breadth as English.
  await t.test("Swedish language parity", () => {
    const pairs = [
      ["what do the papers say about llm agents", "vad säger artiklarna om llm-agenter"],
      ["any peer-reviewed studies on this", "några referentgranskade studier om detta"],
      ["what does the research say", "vad säger forskningen"],
      ["recent publications about graphene", "senaste publikationerna om grafen"],
      ["latest advances in machine learning", "senaste framstegen inom maskininlärning"],
      ["do more agents become smarter", "blir fler agenter smartare"],
      ["state of the art for exoplanets", "forskningsläget för exoplaneter"],
      ["evidence for quantum advantage", "bevis för kvantmekanik"],
      ["compare llm reasoning benchmarks", "jämför resonemang hos språkmodeller"],
      ["is there a preprint", "finns det ett förtryck"],
    ];
    for (const [en, sv] of pairs) {
      assert.equal(arxivIntent(en), true, `EN: ${en}`);
      assert.equal(arxivIntent(sv), true, `SV: ${sv}`);
    }
    // …and the Swedish non-firing side stays quiet too.
    for (const s of ["vad är vädret i Stockholm", "bästa pizzan i Göteborg", "senaste nytt om valet"]) {
      assert.equal(arxivIntent(s), false, s);
    }
  });
});

test("arxivTerms", async (t) => {
  await t.test("keeps topic words, strips literature/question/qualifier noise", () => {
    assert.deepEqual(arxivTerms("llm swarm reasoning research 2026"), ["llm", "swarm", "reasoning"]);
    assert.deepEqual(arxivTerms("what do the latest papers say about graphene"), ["graphene"]);
    // Generic research nouns ("systems", "model") and comparison verbs
    // ("outperform") are stripped too — they match nearly every abstract, so
    // they would spend a ladder slot without narrowing anything.
    assert.deepEqual(arxivTerms("evidence that multi-agent systems outperform one model"), ["multi-agent"]);
  });

  await t.test("strips bare years — the worst offender in the reported failure", () => {
    // AND-ing "2026" in pushed the live query from 37 to 511,207 junk hits.
    assert.ok(!arxivTerms("llm swarm reasoning research 2026").includes("2026"));
    assert.ok(!arxivTerms("advances in 2025 and 2026").includes("2025"));
  });

  await t.test("keeps intra-word hyphens (multi-agent is one term)", () => {
    assert.ok(arxivTerms("multi-agent reasoning").includes("multi-agent"));
  });

  await t.test("dedupes, drops single characters, and never throws on junk", () => {
    assert.deepEqual(arxivTerms("swarm swarm swarm"), ["swarm"]);
    assert.deepEqual(arxivTerms("a b c"), []);
    assert.deepEqual(arxivTerms(null), []);
    assert.deepEqual(arxivTerms({}), []);
  });

  await t.test("strips Swedish noise with the same breadth as English", () => {
    assert.deepEqual(arxivTerms("vad säger de senaste artiklarna om grafen"), ["grafen"]);
    assert.deepEqual(arxivTerms("senaste forskningen om maskininlärning"), ["maskininlärning"]);
    assert.deepEqual(arxivTerms("vilka studier finns om exoplaneter"), ["exoplaneter"]);
  });
});

test("arxivAttempts (the bounded AND ladder)", async (t) => {
  await t.test("most distinctive rung first, giving up slots, bounded to 2 attempts", () => {
    const rungs = arxivAttempts("llm swarm reasoning agents architecture");
    // 2, not 3: arXiv publishes a 1-request-per-3-seconds limit and sells no
    // way past it, so the per-turn request budget is spent deliberately.
    assert.equal(rungs.length, 2);
    // Terms are picked by distinctiveness but emitted in the query's own word
    // order, and successive rungs NEST (top-3 ⊂ top-4).
    assert.deepEqual(
      rungs.map((r) => r.terms),
      [
        ["swarm", "reasoning", "agents", "architecture"],
        ["reasoning", "agents", "architecture"],
      ],
    );
  });

  await t.test("one turn's worst case stays inside the published rate limit", () => {
    // arXiv asks for no more than one request every three seconds. The
    // registry caps this source at ARXIV_MAX_PER_REQUEST searches per turn and
    // each search at MAX_ATTEMPTS rungs, so the ceiling is their product —
    // pinned here so neither can be raised without facing the limit.
    const worstRungs = arxivAttempts("alpha beta gamma delta epsilon zeta").length;
    assert.equal(worstRungs, 2);
    assert.equal(ARXIV_MAX_PER_REQUEST, 2);
    assert.ok(worstRungs * ARXIV_MAX_PER_REQUEST <= 4, "per-turn arXiv request ceiling grew");
  });

  await t.test("caps the first rung at 4 terms (6 AND-ed terms measured 0 hits)", () => {
    for (const r of arxivAttempts("alpha beta gamma delta epsilon zeta eta theta")) {
      assert.ok(r.terms.length <= 4, `rung too wide: ${r.terms.join("+")}`);
    }
  });

  await t.test("a single topic term still gets one attempt", () => {
    assert.deepEqual(arxivAttempts("graphene").map((r) => r.terms), [["graphene"]]);
  });

  await t.test("an explicit arXiv id short-circuits the ladder", () => {
    assert.deepEqual(arxivAttempts("summarize arXiv:2606.09730v1"), [
      { terms: ["id:2606.09730"], key: "id:2606.09730" },
    ]);
  });

  await t.test("no terms → no attempts (no fetch at all)", () => {
    assert.deepEqual(arxivAttempts("what are the latest papers"), []);
    assert.deepEqual(arxivAttempts(""), []);
  });

  await t.test("rung keys are stable for cross-wave dedup", () => {
    // Three terms → the widest rung IS all three.
    assert.equal(arxivAttempts("llm swarm reasoning")[0].key, "llm swarm reasoning");
    assert.equal(arxivAttempts("LLM Swarm")[0].key, arxivAttempts("llm  swarm")[0].key);
  });
});

test("term selection spends the AND slots on topic words, not position", async (t) => {
  await t.test("the bench-question case that exposed position-based selection", () => {
    // Terms in word order start [large, still, support, idea, moderate,
    // alcohol, consumption, protective, cardiovascular, ...] — taking the
    // first four put `large still support idea` in the query and left the
    // actual subject out entirely.
    const q =
      "Do recent large studies still support the idea that moderate alcohol consumption has a protective cardiovascular effect, or has that view changed?";
    const terms = arxivAttempts(q)[0].terms;
    assert.deepEqual(terms, ["moderate", "consumption", "protective", "cardiovascular"]);
    for (const junk of ["large", "still", "support", "idea", "view", "changed", "effect"]) {
      assert.ok(!terms.includes(junk), `discourse word survived: ${junk}`);
    }
  });

  await t.test("acronyms beat longer ordinary words despite being short", () => {
    // Scored on the ORIGINAL casing — "llm" lowercased is just a short word.
    assert.ok(arxivDistinctiveness("LLM") > arxivDistinctiveness("consumption"));
    assert.ok(arxivDistinctiveness("RAG") > arxivDistinctiveness("retrieval"));
    // …but a lowercase short word does not get the bonus.
    assert.ok(arxivDistinctiveness("llm") < arxivDistinctiveness("reasoning"));
  });

  await t.test("compound/versioned technical tokens are boosted", () => {
    assert.ok(arxivDistinctiveness("multi-agent") > arxivDistinctiveness("multiagent"));
    assert.ok(arxivDistinctiveness("GPT-4") > arxivDistinctiveness("gpt"));
  });

  await t.test("arxivSelectTerms nests and preserves word order", () => {
    const ranked = arxivRankedTerms("swarm reasoning agents architecture");
    assert.deepEqual(arxivSelectTerms(ranked, 4), ["swarm", "reasoning", "agents", "architecture"]);
    assert.deepEqual(arxivSelectTerms(ranked, 3), ["reasoning", "agents", "architecture"]);
    assert.deepEqual(arxivSelectTerms(ranked, 2), ["reasoning", "architecture"]);
    // Nesting: every narrower set is a subset of the wider one.
    const wide = new Set(arxivSelectTerms(ranked, 3));
    for (const t2 of arxivSelectTerms(ranked, 2)) assert.ok(wide.has(t2), t2);
  });

  await t.test("fewer terms than the limit returns them all, order intact", () => {
    assert.deepEqual(arxivSelectTerms(arxivRankedTerms("llm swarm"), 4), ["llm", "swarm"]);
    assert.deepEqual(arxivSelectTerms([], 4), []);
    assert.deepEqual(arxivSelectTerms(null, 4), []);
  });

  await t.test("hyphenated literature words are stripped as one token", () => {
    // "peer" and "reviewed" are noise separately, but "peer-reviewed" is ONE
    // token and slipped through until it was added explicitly.
    assert.ok(!arxivTerms("is there peer-reviewed evidence for this").includes("peer-reviewed"));
  });
});

test("arxivSearchQuery uses the one form that works", () => {
  // all:"multi word phrase" measured 0 hits; unquoted spaces are OR, not AND.
  assert.equal(arxivSearchQuery(["llm", "swarm"]), 'abs:"llm" AND abs:"swarm"');
  assert.equal(arxivSearchQuery(["collective intelligence"]), 'abs:"collective intelligence"');
});

test("arxivId", () => {
  assert.equal(arxivId("arXiv:2606.09730"), "2606.09730");
  assert.equal(arxivId("look at 2606.09730v2 please"), "2606.09730");
  assert.equal(arxivId("https://arxiv.org/abs/2510.10047"), "2510.10047");
  assert.equal(arxivId("no id here"), null);
  assert.equal(arxivId("version 1.2.3"), null);
});

// A trimmed but structurally faithful capture of a real response.
const FEED = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:arxiv="http://arxiv.org/schemas/atom">
  <opensearch:totalResults>37</opensearch:totalResults>
  <entry>
    <id>http://arxiv.org/abs/2605.10698v1</id>
    <title>The Bystander Effect in Multi-Agent Reasoning:
      Quantifying Cognitive Loafing</title>
    <updated>2026-05-11T00:00:00Z</updated>
    <published>2026-05-11T00:00:00Z</published>
    <summary>Multi-agent systems (MAS) assume that collaborating inherently
      improves reasoning. We challenge this &amp; show otherwise.</summary>
    <category term="cs.MA" scheme="http://arxiv.org/schemas/atom"/>
    <category term="cs.AI" scheme="http://arxiv.org/schemas/atom"/>
    <arxiv:primary_category term="cs.MA"/>
    <author><name>Dahlia Shehata</name></author>
    <author><name>Ming Li</name></author>
  </entry>
  <entry>
    <id>http://arxiv.org/abs/2510.10047v1</id>
    <title>SwarmSys: Decentralized Swarm-Inspired Agents</title>
    <updated>2025-10-11T00:00:00Z</updated>
    <published>2025-10-11T00:00:00Z</published>
    <summary>LLM agents have shown remarkable reasoning abilities.</summary>
    <category term="cs.AI" scheme="http://arxiv.org/schemas/atom"/>
    <author><name>Ruohao Li</name></author>
    <author><name>Hongjun Liu</name></author>
    <author><name>Leyi Zhao</name></author>
    <author><name>Wei Chen</name></author>
  </entry>
</feed>`;

test("arxivParseFeed", async (t) => {
  await t.test("parses entries, collapsing wrapped text and decoding entities", () => {
    const entries = arxivParseFeed(FEED);
    assert.equal(entries.length, 2);
    assert.equal(entries[0].title, "The Bystander Effect in Multi-Agent Reasoning: Quantifying Cognitive Loafing");
    assert.ok(entries[0].summary.includes("challenge this & show otherwise"));
    assert.deepEqual(entries[0].authors, ["Dahlia Shehata", "Ming Li"]);
    assert.deepEqual(entries[0].categories, ["cs.MA", "cs.AI"]);
    assert.equal(entries[0].published, "2026-05-11T00:00:00Z");
  });

  await t.test("never throws on junk (fail-soft)", () => {
    assert.deepEqual(arxivParseFeed(""), []);
    assert.deepEqual(arxivParseFeed(null), []);
    assert.deepEqual(arxivParseFeed("<html>503 Service Unavailable</html>"), []);
    assert.deepEqual(arxivParseFeed("<feed><entry>truncated..."), []);
  });

  await t.test("&amp; is decoded last so &amp;lt; does not become <", () => {
    const [e] = arxivParseFeed("<feed><entry><id>http://arxiv.org/abs/1</id><summary>a &amp;lt; b</summary></entry></feed>");
    assert.equal(e.summary, "a &lt; b");
  });
});

test("arxivMapEntry", async (t) => {
  await t.test("maps to a registry item with a citable metadata highlight", () => {
    const item = arxivMapEntry(arxivParseFeed(FEED)[0]);
    assert.equal(item.url, "https://arxiv.org/abs/2605.10698v1");
    assert.equal(item.title, "The Bystander Effect in Multi-Agent Reasoning: Quantifying Cognitive Loafing");
    assert.equal(item.highlights[0], "Dahlia Shehata, Ming Li · cs.MA · 2026-05-11 · arXiv:2605.10698v1");
    assert.ok(item.highlights[1].includes("Multi-agent systems"));
  });

  await t.test("abbreviates author lists past three", () => {
    const item = arxivMapEntry(arxivParseFeed(FEED)[1]);
    assert.ok(item.highlights[0].startsWith("Ruohao Li, Hongjun Liu, Leyi Zhao et al."));
  });

  await t.test("junk in → null out, never a throw", () => {
    assert.equal(arxivMapEntry(null), null);
    assert.equal(arxivMapEntry({}), null);
    assert.equal(arxivMapEntry({ id: "http://arxiv.org/abs/1", title: "" }), null);
    assert.equal(arxivMapEntry({ id: "not-a-url", title: "T" }), null);
  });

  await t.test("truncates a long abstract", () => {
    const item = arxivMapEntry({ id: "http://arxiv.org/abs/1", title: "T", summary: "x".repeat(900), authors: [], categories: [], published: "", updated: "" });
    assert.ok(item.highlights[1].length < 500);
    assert.ok(item.highlights[1].endsWith("…"));
  });
});

test("arxivIdOf", () => {
  assert.equal(arxivIdOf("http://arxiv.org/abs/2605.10698v1"), "2605.10698v1");
  assert.equal(arxivIdOf("nonsense"), "");
});

test("arxivPickQuery prefers the most topic-bearing angle", () => {
  assert.equal(
    arxivPickQuery(["what are the latest papers", "llm swarm reasoning agents benchmark"]),
    "llm swarm reasoning agents benchmark",
  );
  // Ties keep the planner's own ordering (its first angle is the primary one).
  assert.equal(arxivPickQuery(["graphene sheets", "silicon wafers"]), "graphene sheets");
  assert.equal(arxivPickQuery([]), "");
});

test("arxivTermKey", () => {
  assert.equal(arxivTermKey("llm swarm reasoning research 2026"), "llm swarm reasoning");
  // Prose differences that reduce to the same terms dedupe to one search.
  assert.equal(
    arxivTermKey("what do the latest papers say about llm swarm reasoning"),
    arxivTermKey("recent research on llm swarm reasoning"),
  );
  assert.equal(arxivTermKey("arXiv:2606.09730"), "id:2606.09730");
});

test("arxivDiversityKey keys by PAPER, not by the whole archive", async (t) => {
  await t.test("each preprint is its own independent origin", () => {
    assert.equal(arxivDiversityKey("https://arxiv.org/abs/2605.10698v1"), "arxiv.org/2605.10698");
    assert.notEqual(
      arxivDiversityKey("https://arxiv.org/abs/2605.10698"),
      arxivDiversityKey("https://arxiv.org/abs/2510.10047"),
    );
  });

  await t.test("abs / pdf / html and version suffixes collapse to one key", () => {
    const k = "arxiv.org/2606.09730";
    assert.equal(arxivDiversityKey("https://arxiv.org/abs/2606.09730v1"), k);
    assert.equal(arxivDiversityKey("https://arxiv.org/pdf/2606.09730"), k);
    assert.equal(arxivDiversityKey("https://arxiv.org/html/2606.09730v1"), k);
    assert.equal(arxivDiversityKey("https://arxiv.org/pdf/2606.09730.pdf"), k);
  });

  await t.test("falls back to the host on anything unparseable", () => {
    assert.equal(arxivDiversityKey("https://arxiv.org/list/cs.AI/recent"), "arxiv.org");
    assert.equal(arxivDiversityKey("not a url"), "arxiv.org");
  });
});

test("arxivSearch result caching", async (t) => {
  const realFetch = globalThis.fetch;
  const realCaches = /** @type {any} */ (globalThis).caches;
  t.afterEach(() => {
    globalThis.fetch = realFetch;
    /** @type {any} */ (globalThis).caches = realCaches;
  });

  // A minimal stand-in for caches.default: enough of match/put for the
  // edge-cache.js helpers, which otherwise no-op in Node.
  function fakeCache() {
    /** @type {Map<string, string>} */
    const store = new Map();
    /** @type {any} */ (globalThis).caches = {
      default: {
        async match(req) {
          const body = store.get(req.url);
          return body === undefined ? undefined : new Response(body);
        },
        async put(req, res) {
          store.set(req.url, await res.text());
        },
      },
    };
    return store;
  }

  await t.test("cacheKey namespaces on the params, not the prose", () => {
    const k = arxivCacheKey(new URLSearchParams({ search_query: 'abs:"graphene"' }));
    assert.ok(k.startsWith("https://arxiv.cache.internal/query?"));
    assert.ok(k.includes("graphene"));
  });

  await t.test("a second identical search makes no outbound call", async () => {
    fakeCache();
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      return new Response(FEED, { status: 200 });
    };
    const a = await arxivSearch({}, log, "llm swarm reasoning");
    const b = await arxivSearch({}, log, "llm swarm reasoning");
    assert.equal(calls, 1, "the second search re-fetched");
    assert.deepEqual(a.items, b.items);
    assert.equal(b.items.length, 2);
  });

  await t.test("differently worded questions reducing to the same rung share the entry", async () => {
    fakeCache();
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      return new Response(FEED, { status: 200 });
    };
    await arxivSearch({}, log, "what do the latest papers say about llm swarm reasoning");
    await arxivSearch({}, log, "recent research on llm swarm reasoning");
    assert.equal(calls, 1);
  });

  await t.test("a remembered empty rung broadens without asking arXiv again", async () => {
    fakeCache();
    /** @type {string[]} */
    const seen = [];
    globalThis.fetch = async (url) => {
      const q = new URL(String(url)).searchParams.get("search_query") || "";
      seen.push(q);
      return new Response(q.split(" AND ").length > 3 ? "<feed></feed>" : FEED, { status: 200 });
    };
    await arxivSearch({}, log, "llm swarm reasoning agents");
    assert.equal(seen.length, 2); // wide rung empty, next rung hit
    await arxivSearch({}, log, "llm swarm reasoning agents");
    assert.equal(seen.length, 2, "a cached run re-fetched something");
  });

  await t.test("a throttled response is NOT cached", async () => {
    fakeCache();
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      return calls === 1 ? new Response("slow down", { status: 429 }) : new Response(FEED, { status: 200 });
    };
    const first = await arxivSearch({}, log, "llm swarm reasoning");
    assert.deepEqual(first.items, []);
    // The retry must reach arXiv — an hour-long cached "nothing" from a
    // transient rate limit would be the worst possible entry.
    const second = await arxivSearch({}, log, "llm swarm reasoning");
    assert.equal(second.items.length, 2);
  });

  await t.test("a timeout is NOT cached either", async () => {
    fakeCache();
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      if (calls === 1) throw new Error("The operation was aborted due to timeout");
      return new Response(FEED, { status: 200 });
    };
    assert.deepEqual((await arxivSearch({}, log, "graphene superconductivity")).items, []);
    assert.equal((await arxivSearch({}, log, "graphene superconductivity")).items.length, 2);
  });
});

test("arxivSearch is fail-soft in every branch", async (t) => {
  const realFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = realFetch;
  });

  await t.test("no usable terms → no fetch at all", async () => {
    let called = 0;
    globalThis.fetch = async () => {
      called++;
      throw new Error("should not be called");
    };
    const r = await arxivSearch({}, log, "what are the latest papers");
    assert.equal(called, 0);
    assert.deepEqual(r.items, []);
    assert.deepEqual(r.usedKeys, []);
  });

  await t.test("a thrown fetch degrades to zero items", async () => {
    globalThis.fetch = async () => {
      throw new Error("network down");
    };
    const r = await arxivSearch({}, log, "llm swarm reasoning");
    assert.deepEqual(r.items, []);
    assert.ok(typeof r.durationMs === "number");
  });

  await t.test("a non-ok response degrades to zero items", async () => {
    globalThis.fetch = async () => new Response("nope", { status: 400 });
    const r = await arxivSearch({}, log, "llm swarm reasoning");
    assert.deepEqual(r.items, []);
  });

  await t.test("a 429 ABORTS the ladder instead of retrying through it", async () => {
    // Observed live 2026-07-26: repeated probing earned 429 Too Many Requests.
    // Answering a rate limit by firing the next rung immediately is what earns
    // a longer block, so the ladder must stop dead.
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      return new Response("slow down", { status: 429, headers: { "retry-after": "30" } });
    };
    const r = await arxivSearch({}, log, "llm swarm reasoning agents");
    assert.equal(calls, 1, "ladder kept going after a 429");
    assert.deepEqual(r.items, []);
  });

  await t.test("a 503 aborts the ladder too (arXiv's overload signal)", async () => {
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      return new Response("overloaded", { status: 503 });
    };
    await arxivSearch({}, log, "llm swarm reasoning agents");
    assert.equal(calls, 1);
  });

  await t.test("a plain error status still walks the ladder (not a throttle)", async () => {
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      return new Response("bad request", { status: 400 });
    };
    await arxivSearch({}, log, "llm swarm reasoning agents");
    assert.equal(calls, 2, "a 400 is per-rung, not a global stop");
  });

  await t.test("a malformed body degrades to zero items", async () => {
    globalThis.fetch = async () => new Response("<html>bad gateway</html>", { status: 200 });
    const r = await arxivSearch({}, log, "llm swarm reasoning");
    assert.deepEqual(r.items, []);
  });

  await t.test("walks the ladder until a rung returns hits, then stops", async () => {
    /** @type {string[]} */
    const seen = [];
    globalThis.fetch = async (url) => {
      const q = new URL(String(url)).searchParams.get("search_query") || "";
      seen.push(q);
      // The widest rung finds nothing (the measured over-specification case);
      // the next one down hits.
      return new Response(q.split(" AND ").length > 3 ? "<feed></feed>" : FEED, { status: 200 });
    };
    const r = await arxivSearch({}, log, "llm swarm reasoning agents model");
    assert.equal(seen.length, 2, seen.join(" | "));
    assert.equal(seen[0], 'abs:"llm" AND abs:"swarm" AND abs:"reasoning" AND abs:"agents"');
    // Giving up a slot drops the least distinctive term ("llm", lowercase).
    assert.equal(seen[1], 'abs:"swarm" AND abs:"reasoning" AND abs:"agents"');
    assert.equal(r.items.length, 2);
    // Both rungs are reported as consumed, so a later wave skips them.
    assert.deepEqual(r.usedKeys, ["llm swarm reasoning agents", "swarm reasoning agents"]);
  });

  await t.test("skipKeys suppresses rungs an earlier wave already spent", async () => {
    /** @type {string[]} */
    const seen = [];
    globalThis.fetch = async (url) => {
      seen.push(new URL(String(url)).searchParams.get("search_query") || "");
      return new Response(FEED, { status: 200 });
    };
    const r = await arxivSearch({}, log, "llm swarm reasoning agents model", {
      skipKeys: new Set(["llm swarm reasoning agents"]),
    });
    assert.equal(seen.length, 1);
    assert.equal(seen[0], 'abs:"swarm" AND abs:"reasoning" AND abs:"agents"');
    assert.deepEqual(r.usedKeys, ["swarm reasoning agents"]);
  });

  await t.test("an explicit id uses id_list, not a term query", async () => {
    /** @type {URL | null} */
    let seen = null;
    globalThis.fetch = async (url) => {
      seen = new URL(String(url));
      return new Response(FEED, { status: 200 });
    };
    await arxivSearch({}, log, "summarize arXiv:2606.09730");
    assert.equal(seen.searchParams.get("id_list"), "2606.09730");
    assert.equal(seen.searchParams.get("search_query"), null);
  });

  await t.test("caps the items one search contributes", async () => {
    const many = `<feed>${Array.from(
      { length: 20 },
      (_, i) =>
        `<entry><id>http://arxiv.org/abs/2600.0000${i}</id><title>Paper ${i}</title><summary>s</summary><published>2026-01-01T00:00:00Z</published></entry>`,
    ).join("")}</feed>`;
    globalThis.fetch = async () => new Response(many, { status: 200 });
    const r = await arxivSearch({}, log, "llm swarm reasoning");
    assert.equal(r.items.length, 5);
  });
});
