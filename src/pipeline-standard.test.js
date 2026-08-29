// (no @ts-check: node:test / node:assert have no type declarations in this
// repo — tsconfig's types is workers-only and @types/node would be a new
// dependency.)
//
// Unit suite for the STANDARD four-node pipeline (src/pipeline-standard.js).
//
// Four jobs, and they are the four ways this module could quietly be wrong:
//
//  1. The query plan HARDENS. It writes the strings that reach a search
//     engine, so junk must not pass through it and a dead planner must still
//     seed a searchable angle — in Swedish exactly as in English, since the
//     seeder is the one piece of this node that reads the user's words.
//  2. It FAILS SOFT to the end (invariant 2). A JSON model that returns null
//     on every single call still has to produce an answer.
//  3. The ONE loop edge is really one: it stops on "sufficient", it stops on
//     the deadline, it stops on the search cap, and it never exceeds
//     STANDARD_MAX_REFLECT_ROUNDS.
//  4. Retrieval and the writer are pipeline.js's, not this module's. Pinned
//     behaviourally (every source enters through runSearches) AND against the
//     source text, because the failure mode is a well-meaning re-implementation
//     of a wave loop that silently drops the per-domain cap, the cross-wave
//     dedup or the search_start/search_done cards.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  QUERY_PLAN_SCHEMA,
  REFLECT_SCHEMA,
  STANDARD_MAX_REFLECT_ROUNDS,
  STANDARD_PIPELINE_ID,
  generateQueries,
  normalizeQueryPlan,
  reflect,
  reflectRoundsFor,
  runStandardResearch,
} from "./pipeline-standard.js";
import { hardenJson } from "./triage.js";

// ---- harness --------------------------------------------------------------

const plan = (over = {}) => ({
  budgetMs: 60_000,
  budgetS: 60,
  queries: 4,
  gapIterations: 2,
  followups: 3,
  validate: true,
  maxSearches: 20,
  maxSources: 24,
  digestCap: 18_000,
  estimates: { triage: 6000, search: 1300, gap: 4500, synth: 16_000, validate: 13_000, digest: 4000, fetch: 2500, claim: 3500 },
  searchDepth: "standard",
  reportTier: "standard",
  synthMaxTokens: 4000,
  validateMaxTokens: 3000,
  ...over,
});

/**
 * A ctx with the shape runPipeline builds, and a `calls` ledger. Nothing here
 * touches a provider, a search index or a socket: the nodes under test are the
 * two JSON calls and the loop edge, and everything else arrives as a dep.
 */
function harness({ planOver = {}, lastUser = "what is the state of solid-state batteries", priorUser = "", jsonResults = [], sources = [] } = {}) {
  const calls = [];
  const state = {
    startedAt: Date.now(),
    plan: plan(planOver),
    sources: [...sources],
    ranQueries: new Set(),
    searchCount: 0,
    iterations: 0,
    namedUrlCount: 0,
    webSearch: true,
  };
  const conversation = [
    ...(priorUser ? [{ role: "user", content: priorUser }, { role: "assistant", content: "…" }] : []),
    { role: "user", content: lastUser },
  ];
  const ctx = {
    env: {},
    log: { info: (...a) => calls.push(["log.info", ...a]), warn: (...a) => calls.push(["log.warn", ...a]) },
    emit: () => {},
    model: "test/answer",
    jsonModel: "test/json",
    state,
    profile: {},
    jsonProfile: {},
    conversation,
    reinforceJsonOnly: false,
    lastUser,
    convText: lastUser,
    cleanLastUser: lastUser,
    gateLastUser: lastUser,
    cleanConvText: lastUser,
    planLastUser: lastUser,
    planConvText: lastUser,
    imageParts: [],
    emitDelta: () => {},
    step: (id, label) => calls.push(["step", id, label]),
    stepDone: (id, label, details, extra) => calls.push(["stepDone", id, label, details, extra]),
  };

  let jsonCall = 0;
  const deps = {
    jsonPhase: async (_ctx, phase) => {
      calls.push(["jsonPhase", phase.label, phase.statKey]);
      const r = jsonResults[jsonCall++];
      return r === undefined ? null : r;
    },
    runNamedUrlReads: async (_ctx, urls) => {
      calls.push(["runNamedUrlReads", urls]);
    },
    runSearches: async (_ctx, queries, round) => {
      calls.push(["runSearches", queries, round]);
      // Stand in for the real engine's bookkeeping so the loop's own caps are
      // exercised: the wave engine is what advances searchCount and ranQueries.
      for (const q of queries) state.ranQueries.add(q);
      state.searchCount += queries.length;
      state.sources.push({ n: state.sources.length + 1, title: `S${round}`, url: `https://e.example/${round}` });
    },
    runDirectReply: async () => {
      calls.push(["runDirectReply"]);
    },
    runSynthesis: async (_ctx, extra) => {
      calls.push(["runSynthesis", extra]);
      return "DRAFT";
    },
    runValidation: async (_ctx, draft) => {
      calls.push(["runValidation", draft]);
    },
  };
  const named = (name) => calls.filter((c) => c[0] === name);
  return { ctx, state, deps, calls, named };
}

// ---- 1. the query plan hardens -------------------------------------------

describe("normalizeQueryPlan", () => {
  test("keeps only usable strings, dedups case-insensitively, and caps to the plan", () => {
    const p = normalizeQueryPlan(
      { queries: ["  Acme revenue  ", "acme revenue", "", 42, null, "Acme lawsuits", "Acme staff"], rationale: "  cover the company  " },
      "acme",
      { maxQueries: 2 },
    );
    assert.deepEqual(p.queries, ["Acme revenue", "Acme lawsuits"]);
    assert.equal(p.rationale, "cover the company");
    assert.equal(p.direct, false);
    assert.equal(p.seeded, false);
  });

  test("junk of every shape degrades rather than throwing", () => {
    for (const raw of [null, undefined, 0, "", "research", [], [1, 2], { queries: "nope" }, { queries: [{}] }, { direct: "yes" }]) {
      const p = normalizeQueryPlan(raw, "how do perovskite tandem cells degrade", { maxQueries: 4 });
      assert.equal(typeof p.direct, "boolean");
      assert.ok(Array.isArray(p.queries));
      // A real question always leaves the node with something to search.
      assert.deepEqual(p.queries, ["how do perovskite tandem cells degrade"]);
      assert.equal(p.seeded, true);
    }
  });

  test("an explicit direct outranks angles the planner wrote anyway", () => {
    const p = normalizeQueryPlan({ direct: true, queries: ["thanks"] }, "thanks!", { maxQueries: 4 });
    assert.equal(p.direct, true);
    assert.deepEqual(p.queries, []);
  });

  test("the schema hardens the wire shape before normalization sees it", () => {
    const hardened = hardenJson(QUERY_PLAN_SCHEMA, { queries: ["a"], rationale: 7, direct: "true", extra: "dropped" });
    assert.equal(hardened.rationale, "7");
    assert.equal(hardened.direct, true);
    assert.equal(hardened.extra, undefined);
    assert.equal(hardenJson(REFLECT_SCHEMA, { sufficient: "false", follow_up_queries: ["q"] }).sufficient, false);
  });

  // Invariant 6. The seeder is the only part of this node that reads the
  // user's own words, and the bug it exists to prevent — a bare
  // back-reference reaching the search engine verbatim — was REPORTED in
  // Swedish ("undersök saken"). English-first behaviour here would mean a
  // Swedish follow-up searching for the phrase instead of the subject.
  test("Swedish language parity — a follow-up seeds from the prior question in both languages", () => {
    const subject = "hur långt har svenska kärnkraftsutbyggnaden kommit";
    for (const followup of ["undersök saken", "det då?", "berätta mer", "gräv djupare", "look into it", "tell me more", "dig deeper", "what about that"]) {
      const p = normalizeQueryPlan(null, followup, { priorUser: subject, maxQueries: 4 });
      assert.deepEqual(p.queries, [subject], `"${followup}" seeds from the subject, not from itself`);
      assert.ok(!p.queries.includes(followup), `"${followup}" never becomes the query`);
    }
  });

  test("Swedish language parity — a self-contained message is searched as written", () => {
    for (const q of ["vad kostar en värmepump i sverige 2026", "what does a heat pump cost in sweden 2026"]) {
      assert.deepEqual(normalizeQueryPlan({}, q, { maxQueries: 4 }).queries, [q]);
    }
  });
});

// ---- the two nodes in isolation -------------------------------------------

describe("the nodes", () => {
  test("generateQueries builds its prompt through the prompt-set binding and caps to the plan", async () => {
    const h = harness({ planOver: { queries: 2 }, jsonResults: [{ queries: ["a", "b", "c"], rationale: "why", direct: false }] });
    const p = await generateQueries(h.ctx, h.deps);
    assert.deepEqual(p.queries, ["a", "b"]);
    assert.equal(h.named("jsonPhase")[0][2], "queries", "records under the budget.js PRIORS_MS key");
    const done = h.named("stepDone")[0];
    assert.equal(done[4].route, "research");
    assert.ok(done[3].includes("why"), "the rationale is shown to the user");
  });

  test("reflect reads a verdict, a stated gap and bounded follow-ups", async () => {
    const h = harness({ jsonResults: [{ sufficient: false, knowledge_gap: "no source gives 2026 volumes", follow_up_queries: ["a", "b", "c", "d", "e"] }] });
    const r = await reflect(h.ctx, 1, h.deps);
    assert.equal(r.sufficient, false);
    assert.equal(r.gap, "no source gives 2026 volumes");
    assert.equal(r.queries.length, h.ctx.state.plan.followups);
    assert.equal(h.named("jsonPhase")[0][2], "reflect");
  });

  test("reflect with no follow-up queries is sufficiency, whatever the boolean says", async () => {
    const h = harness({ jsonResults: [{ sufficient: false, knowledge_gap: "", follow_up_queries: [] }] });
    assert.equal((await reflect(h.ctx, 1, h.deps)).sufficient, true);
  });
});

// ---- 2. fail-soft to the end ---------------------------------------------

describe("fail-soft", () => {
  test("a jsonModel that returns null on every call still produces an answer", async () => {
    // The strongest statement of invariant 2 available for this module: both
    // JSON nodes are dead, and the run must still search something and write.
    const h = harness({ jsonResults: [] }); // every jsonPhase resolves null
    await runStandardResearch(h.ctx, h.deps);
    const waves = h.named("runSearches");
    assert.ok(waves.length >= 1, "the model-free seed still produced a wave");
    assert.deepEqual(waves[0][1], ["what is the state of solid-state batteries"]);
    assert.equal(h.named("runSynthesis").length, 1);
    assert.equal(h.named("runValidation")[0][1], "DRAFT", "the draft reached validation");
    assert.equal(h.named("runDirectReply").length, 0);
  });

  test("a reflect node that THROWS costs the round, never the report", async () => {
    // The loop edge is optional work. jsonPhase's own contract is that it
    // returns null rather than throwing, so this is the unexpected case — a
    // prompt builder or a dep blowing up — and it must still not cost the user
    // an answer that was already retrievable.
    const h = harness({ planOver: { reflectRounds: 2 } });
    h.deps.jsonPhase = async (_ctx, phase) => {
      h.calls.push(["jsonPhase", phase.label, phase.statKey]);
      if (phase.label.startsWith("reflect")) throw new Error("provider down");
      return { queries: ["q1"], direct: false };
    };
    await assert.doesNotReject(() => runStandardResearch(h.ctx, h.deps));
    assert.equal(h.named("runSearches").length, 1, "the failed round ran no wave");
    assert.equal(h.named("runSynthesis").length, 1);
    assert.equal(h.named("runValidation")[0][1], "DRAFT");
    assert.ok(h.calls.some((c) => c[0] === "log.warn" && c[1] === "chat.reflect_failed"));
  });
});

// ---- 3. the one loop edge -------------------------------------------------

describe("the loop edge", () => {
  test("reflect returning sufficient:true exits after one wave", async () => {
    const h = harness({
      planOver: { reflectRounds: 2 },
      jsonResults: [
        { queries: ["q1", "q2"], direct: false },
        { sufficient: true, knowledge_gap: "nothing after 2025 Q4", follow_up_queries: [] },
      ],
    });
    await runStandardResearch(h.ctx, h.deps);
    assert.equal(h.named("runSearches").length, 1, "no follow-up wave ran");
    // …and the gap it stated on the way out still reaches the writer. This is
    // the artefact the saturation boolean never produced.
    assert.match(h.named("runSynthesis")[0][1], /nothing after 2025 Q4/);
  });

  test("an insufficient verdict runs exactly one follow-up wave at the default budget", async () => {
    const h = harness({
      jsonResults: [
        { queries: ["q1"], direct: false },
        { sufficient: false, knowledge_gap: "no independent coverage", follow_up_queries: ["f1", "f2"] },
        { sufficient: false, knowledge_gap: "still none", follow_up_queries: ["f3"] },
      ],
    });
    await runStandardResearch(h.ctx, h.deps);
    const waves = h.named("runSearches");
    assert.equal(waves.length, 2, "one initial wave plus one reflect round");
    assert.deepEqual(waves[1][1], ["f1", "f2"]);
    assert.equal(waves[1][2], 2, "the round number the wave engine numbers sources by");
    assert.equal(h.ctx.state.iterations, 1);
  });

  test("the round ceiling is STANDARD_MAX_REFLECT_ROUNDS however deep the budget", async () => {
    const h = harness({
      planOver: { reflectRounds: 9, gapIterations: 8, budgetMs: 600_000, budgetS: 600 },
      jsonResults: [
        { queries: ["q1"], direct: false },
        ...Array.from({ length: 9 }, (_, i) => ({ sufficient: false, knowledge_gap: `gap ${i}`, follow_up_queries: [`f${i}`] })),
      ],
    });
    await runStandardResearch(h.ctx, h.deps);
    assert.equal(h.named("runSearches").length, 1 + STANDARD_MAX_REFLECT_ROUNDS);
  });

  test("the deadline exits mid-loop without erroring", async () => {
    // The budget is already blown when the loop is reached: the round must be
    // cut and the mandatory phases must still run (a cut is a smaller run, not
    // a failed one).
    const h = harness({
      planOver: { reflectRounds: 2, budgetMs: 1000, budgetS: 1 },
      jsonResults: [{ queries: ["q1"], direct: false }, { sufficient: false, knowledge_gap: "g", follow_up_queries: ["f1"] }],
    });
    h.ctx.state.startedAt = Date.now() - 60_000;
    await assert.doesNotReject(() => runStandardResearch(h.ctx, h.deps));
    assert.equal(h.named("runSearches").length, 1, "the reflect round was cut");
    assert.equal(h.named("jsonPhase").length, 1, "reflect never ran, so no JSON call was paid for");
    assert.ok(h.calls.some((c) => c[0] === "log.info" && c[1] === "chat.budget_cut"), "the cut is logged");
    assert.equal(h.named("runSynthesis").length, 1, "the answer is still written");
    assert.equal(h.named("runValidation").length, 1);
  });

  test("the search cap ends the loop before another wave", async () => {
    const h = harness({
      planOver: { reflectRounds: 2, maxSearches: 1 },
      jsonResults: [{ queries: ["q1"], direct: false }, { sufficient: false, knowledge_gap: "g", follow_up_queries: ["f1"] }],
    });
    await runStandardResearch(h.ctx, h.deps);
    assert.equal(h.named("runSearches").length, 1);
    assert.equal(h.named("runSynthesis").length, 1);
  });

  test("reflectRoundsFor: one by default, none at the floor, never more than the ceiling", () => {
    assert.equal(reflectRoundsFor(plan()), 1);
    assert.equal(reflectRoundsFor(plan({ gapIterations: 8 })), 1, "the striving gap ceiling is not a reflect count");
    assert.equal(reflectRoundsFor(plan({ gapIterations: 0 })), 0, "the floor budget reflects not at all");
    assert.equal(reflectRoundsFor(plan({ reflectRounds: 2 })), STANDARD_MAX_REFLECT_ROUNDS);
    assert.equal(reflectRoundsFor(plan({ reflectRounds: 99 })), STANDARD_MAX_REFLECT_ROUNDS);
    assert.equal(reflectRoundsFor(plan({ reflectRounds: -3 })), 0);
    assert.equal(reflectRoundsFor(/** @type {any} */ ({})), 0);
  });
});

// ---- the direct branch ----------------------------------------------------

describe("the direct branch", () => {
  test("a direct plan with nothing linked answers from the model", async () => {
    const h = harness({ lastUser: "thanks!", jsonResults: [{ direct: true, queries: [], rationale: "small talk" }] });
    await runStandardResearch(h.ctx, h.deps);
    assert.equal(h.named("runDirectReply").length, 1);
    assert.equal(h.named("runSearches").length, 0);
    assert.equal(h.named("runSynthesis").length, 0);
    // The named-URL read still ran first: what it reads is what decides this
    // branch, so it cannot sit below it (feedback #67's ordering).
    assert.equal(h.named("runNamedUrlReads").length, 1);
  });

  test("a page we actually READ overrides the direct decision", async () => {
    const h = harness({
      lastUser: "what does https://example.com/paper say?",
      jsonResults: [{ direct: true, queries: [] }],
    });
    h.deps.runNamedUrlReads = async (_ctx, urls) => {
      h.calls.push(["runNamedUrlReads", urls]);
      h.ctx.state.namedUrlCount = urls.length; // the page came back
    };
    await runStandardResearch(h.ctx, h.deps);
    assert.deepEqual(h.named("runNamedUrlReads")[0][1], ["https://example.com/paper"]);
    assert.equal(h.named("runDirectReply").length, 0);
    assert.equal(h.named("runSynthesis").length, 1, "the page is answered from, not apologised for");
  });
});

// ---- 4. retrieval and the writer stay pipeline.js's ------------------------

describe("retrieval is not re-implemented here", () => {
  test("every wave goes through the existing search engine", async () => {
    const h = harness({
      jsonResults: [
        { queries: ["q1", "q2"], direct: false },
        { sufficient: false, knowledge_gap: "g", follow_up_queries: ["f1"] },
      ],
    });
    await runStandardResearch(h.ctx, h.deps);
    // Every source in the registry arrived through runSearches, and each wave
    // carried its round number — which is what the source-numbering order, the
    // per-source caps and the search cards all key on.
    assert.deepEqual(h.named("runSearches").map((c) => c[2]), [1, 2]);
    assert.equal(h.ctx.state.sources.length, 2);
    assert.equal(h.ctx.state.pipelineId, STANDARD_PIPELINE_ID);
  });

  test("the module imports the engine rather than owning one", () => {
    const src = readFileSync(new URL("./pipeline-standard.js", import.meta.url), "utf8");
    // The reuse itself.
    assert.match(src, /import \{[\s\S]*?runSearches[\s\S]*?\} from "\.\/pipeline\.js"/);
    assert.match(src, /import \{[\s\S]*?runNamedUrlReads[\s\S]*?\} from "\.\/pipeline\.js"/);
    assert.match(src, /import \{[\s\S]*?runSynthesis[\s\S]*?\} from "\.\/pipeline\.js"/);
    assert.match(src, /import \{[\s\S]*?runValidation[\s\S]*?\} from "\.\/pipeline\.js"/);
    // And the absence that makes it real: none of the wave engine's own
    // machinery is reachable from here, so there is nothing to re-implement a
    // per-domain cap, a cross-wave dedup or a search card WITH.
    for (const forbidden of ["./exa.js", "./search-sources.js", "./named-urls-fetch.js"]) {
      assert.equal(src.includes(`from "${forbidden}"`), false, `imports ${forbidden}`);
    }
    // Code only — the module's own header names the cards it does NOT emit,
    // and a grep that reads prose as behaviour is a grep that will one day
    // fail on a comment while the real regression walks past.
    const code = src.split("\n").map((l) => (l.trim().startsWith("//") ? "" : l)).join("\n");
    assert.equal(/\baddSources\b/.test(code), false, "does not admit sources itself");
    assert.equal(/\btakeSearchBatch\b/.test(code), false, "does not batch queries itself");
    assert.equal(/search_start|search_done/.test(code), false, "does not emit search cards itself");
    assert.equal(/ctx\.emit\(/.test(code), false, "emits no SSE event of its own — the reused phases own the trail");
    // Invariant 1: no tool loop anywhere in this topology.
    assert.equal(/tool_use|toolRun|tools:/.test(code), false, "no function calling");
  });
});
