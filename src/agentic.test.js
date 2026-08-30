// (no @ts-check: node:test / node:assert have no type declarations in this
// repo — tsconfig's types is workers-only and @types/node would be a new
// dependency.)
//
// Unit suite for the AGENTIC research engine (src/agentic.js) — the answer
// model driving its own bounded research turn.
//
// This is the module where invariant 2 stops being structural. In the
// deterministic flow every phase is a separate call with its own fail-soft
// clause, so "a helper degrades, the request survives" is a property of the
// shape. Here one loop does the gathering, and every rung of that ladder has to
// be written down and held. So the suite is the ladder, rung by rung:
//
//   the loop's TEXT never streams, and always reaches the writer
//   a model that cannot drive tools never enters the loop at all
//   the call budget refuses the (N+1)th call — in a sentence
//   a tool that THROWS becomes a sentence, and is counted
//   a loop that throws before any delta falls through, having streamed nothing
//
// …plus the routing (engineFor), and invariant 6: the deterministic source
// gates that used to route a Swedish message do not run on this path, so their
// verdict is folded into the brief instead — and it has to arrive there for a
// Swedish question exactly as for an English one.
//
// Everything is driven through the `deps` seam: no provider, no search index,
// no socket. What is NOT faked is the part that decides what a run may reach —
// admitToolCall, the toolbox resolution and the brief are the real ones,
// because a suite that faked those would be testing its own fakes.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  AGENTIC_BY_DEFAULT,
  AGENTIC_PIPELINE_ID,
  MAX_RESEARCH_TOOL_CALLS,
  MAX_TOOL_ERRORS,
  RESEARCH_ENGINES,
  buildLoopInput,
  engineFor,
  loopStepId,
  normalizeResearchEngine,
  remainingSeconds,
  researchNotesSection,
  researchToolsForRun,
  runAgenticResearch,
  toolCallHeadline,
} from "./agentic.js";
import { MAX_SPENDING_CALLS } from "./tool-admission.js";

// ---- harness --------------------------------------------------------------

const plan = (over = {}) => ({
  budgetMs: 120_000,
  budgetS: 120,
  queries: 4,
  gapIterations: 2,
  followups: 3,
  validate: true,
  maxSearches: 20,
  maxSources: 24,
  digestCap: 18_000,
  estimates: { triage: 6000, search: 1300, gap: 4500, synth: 16_000, validate: 13_000, tool: 6000 },
  searchDepth: "standard",
  reportTier: "standard",
  synthMaxTokens: 4000,
  validateMaxTokens: 3000,
  ...over,
});

/** A model on a provider this env has a secret for, so a tool dialect resolves. */
const TOOL_MODEL = "mistralai/Mistral-Small-3.2-24B-Instruct-2506";
const CONFIGURED = { BERGET_API_TOKEN: "test-token" };

/**
 * A ctx with the shape runPipeline builds, a `calls` ledger, and a scripted
 * loop.
 *
 * `script` is the tool calls the fake provider issues, in order; `deps.toolRun`
 * walks it through the module's own execTool exactly as src/tool-run.js would,
 * INCLUDING that wire's catch — so a test that wants to prove the module counts
 * a throwing tool cannot pass by accident on the wire's behalf.
 */
function harness({
  lastUser = "what is the state of solid-state batteries",
  script = [],
  loopText = "I searched and here is what I found.",
  loopThrows = null,
  capability = null,
  model = TOOL_MODEL,
  env = CONFIGURED,
  webSearch = true,
  toolResults = {},
  toolThrows = new Set(),
  planOver = {},
  // An execution environment bound to the request, as the client tier's browser
  // VM and the local runner both supply one. Default ON so the `python` class
  // survives the toolbox's `needs: "exec"` gate — a run with nothing bound gets
  // a smaller toolbox, which is its own test below rather than the baseline.
  exec = async () => ({ exitCode: 0, stdout: "", stderr: "" }),
} = {}) {
  const calls = [];
  const state = {
    startedAt: Date.now(),
    plan: plan(planOver),
    sources: [],
    ranQueries: new Set(),
    searchCount: 0,
    iterations: 0,
    namedUrlCount: 0,
    totals: { prompt_tokens: 0, completion_tokens: 0 },
    webSearch,
    capability,
    ext: {},
    exec,
    execLabel: "a test runner",
  };
  const ctx = {
    env,
    log: {
      info: (...a) => calls.push(["log.info", ...a]),
      warn: (...a) => calls.push(["log.warn", ...a]),
    },
    emit: (e) => calls.push(["emit", e]),
    emitDelta: (t) => calls.push(["emitDelta", t]),
    model,
    jsonModel: "test/json",
    state,
    profile: {},
    jsonProfile: {},
    conversation: [{ role: "user", content: lastUser }],
    reinforceJsonOnly: false,
    shellBlock: "",
    hasSource: false,
    lastUser,
    convText: lastUser,
    cleanLastUser: lastUser,
    gateLastUser: lastUser,
    imageParts: [],
    step: (id, label) => calls.push(["step", id, label]),
    stepDone: (id, label, details, extra) => calls.push(["stepDone", id, label, details, extra]),
  };

  const deps = {
    toolRun: async (_env, opts) => {
      calls.push(["toolRun", opts.model, opts.tools.map((t) => t.name), opts.system, opts.userContent]);
      if (loopThrows) throw new Error(loopThrows);
      let round = 1;
      for (const call of script) {
        let result;
        try {
          result = await opts.execTool(call.name, call.args);
        } catch (err) {
          // src/tool-run.js's own contract: the wire never lets an execTool
          // throw escape. Reproduced here so the module is measured against the
          // wire it really runs on.
          result = `Tool error: ${err?.message || String(err)}`;
        }
        calls.push(["toolResult", call.name, result]);
        if (opts.onToolUse) opts.onToolUse({ round, name: call.name, input: call.args, result });
        round += 1;
      }
      return {
        text: loopText,
        usage: { prompt_tokens: 100, completion_tokens: 50 },
        rounds: Math.max(1, script.length),
        toolCalls: script.length,
        stopReason: "stop",
      };
    },
    runResearchTool: async (_env, _log, name, args) => {
      calls.push(["runResearchTool", name, args]);
      if (toolThrows.has(name)) throw new Error(`${name} exploded`);
      return (
        toolResults[name] || { text: `${name} says something.`, isError: false, found: true, sourcesAdded: 0 }
      );
    },
    runStandardResearch: async () => {
      calls.push(["runStandardResearch"]);
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

// ---- 0. the vocabulary and the routing ------------------------------------

describe("engineFor", () => {
  test("the request outranks the spec, and the spec outranks the platform", () => {
    const { ctx } = harness({ capability: { routing: { strategy: "agentic" } } });
    assert.equal(engineFor(ctx), "agentic");
    ctx.state.researchEngine = "standard";
    assert.equal(engineFor(ctx), "standard", "the caller's choice wins over the agent's");
  });

  test("an unknown engine name is IGNORED, never an error", () => {
    // It arrives from an untrusted request body and it is an optimisation, not
    // a permission — a typo has to yield the platform's choice, not a 400.
    for (const junk of ["vibes", "", "  ", null, undefined, 7, {}, ["agentic"]]) {
      assert.equal(normalizeResearchEngine(junk), null, String(junk));
    }
    assert.deepEqual(RESEARCH_ENGINES, ["agentic", "standard"]);
    assert.equal(normalizeResearchEngine("  AGENTIC "), "agentic", "trimmed and case-folded");
    const { ctx } = harness();
    ctx.state.researchEngine = "vibes";
    assert.equal(engineFor(ctx), AGENTIC_BY_DEFAULT ? "agentic" : "standard");
  });

  test("a model that cannot drive tools lands on the standard graph", () => {
    // The fallback that keeps every model in the catalog working: the platform
    // defaults to the loop, and the answer for a model with no tool dialect is
    // the deterministic graph — not a refusal, and not a loop it would fail
    // silently in (invariant 1's toolFallback, in the routing layer).
    assert.equal(AGENTIC_BY_DEFAULT, true, "the model-driven path is the platform's default");
    assert.equal(engineFor(harness().ctx), "agentic");
    assert.equal(engineFor(harness({ env: {} }).ctx), "standard", "no provider secret → no dialect");
    const withImage = harness().ctx;
    withImage.imageParts = [{ type: "image_url", image_url: { url: "data:," } }];
    assert.equal(engineFor(withImage), "standard", "a conversation carrying images never loops");
    // …and a ctx built without image parts at all must not throw on the way to
    // an answer. A router that throws costs the whole turn.
    const bare = harness().ctx;
    delete bare.imageParts;
    assert.equal(engineFor(bare), "agentic");
  });

  test("an EMPTY toolbox lands on the standard graph too", () => {
    // An agent that declares no research classes gets no tools, and a loop with
    // no tools is a plain completion with extra steps.
    const declared = { tools: [], context: [], search: { web: true, auxSources: true, maxQueries: null } };
    const { ctx } = harness({ capability: declared });
    assert.deepEqual(researchToolsForRun(ctx), []);
    assert.equal(engineFor(ctx), "standard");
    // A NULL capability is the other direction and is deliberate: no agent was
    // resolved (the MCP channel, an unreadable registry), so the box opens —
    // every individual call is still admitted against the account's knobs.
    assert.ok(researchToolsForRun(harness().ctx).length > 0);
  });
});

// ---- 1. the loop's text never streams, and always reaches the writer -------

describe("gather, then write", () => {
  test("the loop's text is never emitted and always reaches the report writer", async () => {
    const { ctx, deps, calls, named } = harness({
      script: [{ name: "web_search", args: { queries: ["solid state battery 2026"] } }],
      loopText: "Working conclusion: the anode is the bottleneck.",
    });
    await runAgenticResearch(ctx, deps);

    // Nothing the loop said reached the client. This is the whole reason the
    // fall-through below is safe rather than a second answer on top of half of
    // one, so it is asserted against every emitting seam, not just emitDelta.
    assert.deepEqual(named("emitDelta"), []);
    const emitted = JSON.stringify(calls.filter((c) => c[0] === "emit" || c[0] === "emitDelta"));
    assert.ok(!emitted.includes("Working conclusion"), "the loop's text never went out on the wire");

    // …and it did not vanish either: it is the notes block the writer reads.
    const [synth] = named("runSynthesis");
    assert.ok(synth, "the platform's writer wrote the answer");
    assert.match(synth[1], /Working conclusion: the anode is the bottleneck\./);
    assert.match(synth[1], /Research notes:/);
    assert.deepEqual(named("runValidation")[0], ["runValidation", "DRAFT"]);
    assert.equal(ctx.state.pipelineId, AGENTIC_PIPELINE_ID);
  });

  test("a result that ADDED SOURCES stays out of the notes — the writer cites it by number", async () => {
    const { ctx, deps, named } = harness({
      script: [
        { name: "web_search", args: { queries: ["a"] } },
        { name: "literature_corpora", args: {} },
      ],
      toolResults: {
        web_search: { text: "four papers", isError: false, found: true, sourcesAdded: 4 },
        literature_corpora: { text: "31 individuals", isError: false, found: true, sourcesAdded: 0 },
      },
      loopText: "",
    });
    await runAgenticResearch(ctx, deps);
    const notes = named("runSynthesis")[0][1];
    assert.ok(!notes.includes("four papers"), "already in the numbered registry — not repeated unnumbered");
    assert.match(notes, /31 individuals/, "a corpus row has no other way into the answer");
  });

  test("researchNotesSection is empty when there is nothing to say", () => {
    assert.equal(researchNotesSection([], ""), "");
    assert.equal(researchNotesSection(null, "   "), "");
    assert.equal(researchNotesSection([{ headline: "h", text: "t", sourcesAdded: 2 }], ""), "");
  });

  test("the answer is still written when the model called no tool at all", async () => {
    const { ctx, deps, named } = harness({ script: [] });
    await runAgenticResearch(ctx, deps);
    assert.equal(named("runSynthesis").length, 1);
    assert.equal(named("runStandardResearch").length, 0, "an empty loop is not a failed loop");
  });
});

// ---- 2. the bounds --------------------------------------------------------

describe("the bounds refuse in words", () => {
  test("the tool budget refuses the (N+1)th call", async () => {
    // MAX_SPENDING_CALLS bites first for a metered tool, so the run-level
    // allowance is exercised with one that spends nothing: it runs in the
    // sandbox the request already has and reaches no third party.
    const script = Array.from({ length: MAX_RESEARCH_TOOL_CALLS + 3 }, (_, i) => ({
      name: "run_python",
      args: { source: `print(${i})` },
    }));
    const { ctx, deps, named } = harness({ script });
    await runAgenticResearch(ctx, deps);
    assert.equal(named("runResearchTool").length, MAX_RESEARCH_TOOL_CALLS, "the cap is a hard stop");
    const refusals = named("toolResult").filter(([, , text]) => /allowance is used up/.test(String(text)));
    assert.equal(refusals.length, 3, "and every call past it was answered in a sentence");
    for (const [, , text] of refusals) {
      assert.ok(String(text).length > 40, "a refusal a model can act on, not a code");
    }
    assert.equal(named("runSynthesis").length, 1, "the report is still written");
  });

  test("the SPENDING allowance refuses the (N+1)th search before the call cap does", async () => {
    const script = Array.from({ length: MAX_SPENDING_CALLS + 2 }, (_, i) => ({
      name: "web_search",
      args: { queries: [`distinct angle ${i}`] },
    }));
    const { ctx, deps, named } = harness({ script });
    await runAgenticResearch(ctx, deps);
    assert.equal(named("runResearchTool").length, MAX_SPENDING_CALLS);
    assert.ok(MAX_SPENDING_CALLS < MAX_RESEARCH_TOOL_CALLS, "the metered bound is the tighter one");
    assert.equal(named("runSynthesis").length, 1);
  });

  test("a tool this run was not handed is refused, and never runs", async () => {
    // The AND-gate at the call layer: the toolbox was fixed before the model
    // ran, and a model naming a tool it saw in an earlier conversation gets a
    // sentence rather than the tool.
    const { ctx, deps, named } = harness({
      capability: {
        tools: ["ancient-samples-query"],
        context: ["ancient-samples"],
        search: { web: true, auxSources: true, maxQueries: null },
      },
      script: [{ name: "web_search", args: { queries: ["anything"] } }],
    });
    await runAgenticResearch(ctx, deps);
    assert.equal(named("runResearchTool").length, 0);
    assert.match(String(named("toolResult")[0][2]), /not part of this run's toolbox/);
  });
});

// ---- 3. a broken tool is a sentence, and it is counted --------------------

describe("the fail-soft ladder", () => {
  test("a throwing tool becomes a string, and the answer is still written", async () => {
    const { ctx, deps, named } = harness({
      script: [
        { name: "run_python", args: { source: "print(1)" } },
        { name: "run_python", args: { source: "print(2)" } },
      ],
      toolThrows: new Set(["run_python"]),
    });
    await runAgenticResearch(ctx, deps);
    for (const [, , text] of named("toolResult")) {
      assert.equal(typeof text, "string");
      assert.match(text, /failed and returned nothing/);
      assert.ok(!/Tool error:/.test(text), "caught HERE, so it is counted — not swallowed by the wire");
    }
    assert.equal(named("runSynthesis").length, 1);
  });

  test("MAX_TOOL_ERRORS stops the spending, and the report is still written", async () => {
    const script = Array.from({ length: MAX_TOOL_ERRORS + 2 }, (_, i) => ({
      name: "run_python",
      args: { source: `print(${i})` },
    }));
    const { ctx, deps, named } = harness({ script, toolThrows: new Set(["run_python"]) });
    await runAgenticResearch(ctx, deps);
    assert.equal(named("runResearchTool").length, MAX_TOOL_ERRORS, "it stops asking a tool that keeps failing");
    assert.match(String(named("toolResult").at(-1)[2]), /Tool use has stopped for this answer/);
    assert.equal(named("runSynthesis").length, 1);
  });

  test("a loop that throws before any delta falls through to standard, with nothing streamed", async () => {
    const { ctx, deps, named, calls } = harness({ loopThrows: "provider timed out" });
    await runAgenticResearch(ctx, deps);
    assert.deepEqual(named("emitDelta"), [], "nothing streamed — which is what makes the fall-through safe");
    assert.equal(named("runSynthesis").length, 0, "this engine wrote nothing");
    assert.equal(named("runStandardResearch").length, 1, "the deterministic graph answers instead");
    assert.ok(
      calls.some(([kind, id]) => kind === "stepDone" && id === "loop"),
      "and the trail says the loop ended rather than leaving it spinning",
    );
  });

  test("a model with no tool support never enters the loop and lands on standard", async () => {
    const { ctx, deps, named } = harness({ env: {}, script: [{ name: "web_search", args: { queries: ["x"] } }] });
    await runAgenticResearch(ctx, deps);
    assert.equal(named("toolRun").length, 0, "decided before any model call");
    assert.equal(named("runStandardResearch").length, 1);
    assert.equal(named("runSynthesis").length, 0);
  });

  test("an agent with an empty toolbox lands on standard before any model call", async () => {
    const declared = { tools: [], context: [], search: { web: true, auxSources: true, maxQueries: null } };
    const { ctx, deps, named } = harness({ capability: declared });
    await runAgenticResearch(ctx, deps);
    assert.equal(named("toolRun").length, 0);
    assert.equal(named("runStandardResearch").length, 1);
  });
});

// ---- 4. invariant 6 — Swedish reaches the brief the same way --------------

describe("invariant 6", () => {
  test("a Swedish question folds the same lead-source hint into the brief as its English twin", async () => {
    // The deterministic gates that used to route a Swedish message to the right
    // corpus do not run on this path — the model routes now. So the SAME gate
    // functions are run here and their verdict is folded into the brief as a
    // hint. If that fold is English-only, a Swedish question loses the corpus
    // its English twin gets, and nothing else in the system would notice.
    const ask = async (text) => {
      const { ctx, deps, named } = harness({ lastUser: text });
      await runAgenticResearch(ctx, deps);
      return named("toolRun")[0][3];
    };
    const en = await ask("what do recent arxiv papers say about llm agent planning");
    const sv = await ask("vad säger senaste arxiv-artiklarna om llm-agenters planering");
    assert.match(en, /names arxiv as the place to look/i);
    assert.equal(sv, en, "the brief a Swedish question gets is the brief an English one gets");
  });

  test("the hint is read off the CLEAN gate message, not the enrichment-appended one", async () => {
    // The same bug class three other gates in this repo have already been
    // caught by: an enrichment appends a block of prose to `lastUser`, and a
    // gate reading that instead of the user's own words fires on the block.
    const { ctx, deps, named } = harness();
    ctx.gateLastUser = "what do recent arxiv papers say about llm agent planning";
    ctx.lastUser = `${ctx.cleanLastUser}\n\n[a context block that mentions nothing]`;
    await runAgenticResearch(ctx, deps);
    assert.match(named("toolRun")[0][3], /names arxiv as the place to look/i);
  });

  test("the loop is asked in the user's own words, with the enriched view beside them", () => {
    const { ctx } = harness({ lastUser: "vad säger forskningen om kärnkraft i Sverige" });
    ctx.shellBlock = "SHELL TRANSCRIPT";
    const input = buildLoopInput(ctx);
    assert.match(input, /kärnkraft i Sverige/);
    assert.match(input, /SHELL TRANSCRIPT/);
    assert.match(input, /Research this with your tools/);
  });
});

// ---- 5. the trail the map draws -------------------------------------------

describe("the steps a run emits", () => {
  test("one step pair per tool call, numbered rather than named", async () => {
    const { ctx, deps, calls } = harness({
      script: [
        { name: "web_search", args: { queries: ["first angle"] } },
        { name: "run_python", args: { source: "print(1)" } },
      ],
    });
    await runAgenticResearch(ctx, deps);
    const steps = calls.filter(([k]) => k === "step" || k === "stepDone");
    const ids = steps.map(([, id]) => id);
    assert.deepEqual(ids, ["loop", loopStepId(1), loopStepId(1), loopStepId(2), loopStepId(2), "loop"]);
    // The forward-compatible `extra` seam: a client that does not know these
    // keys ignores them, and one that does never parses an English label.
    const done = steps.find(([k, id]) => k === "stepDone" && id === loopStepId(1));
    assert.equal(done[4].tool, "web_search");
    assert.equal(typeof done[4].round, "number");
  });

  test("a headline is built from the arguments, so a new tool needs no edit here", () => {
    assert.equal(toolCallHeadline("web_search", { queries: ["a", "b"] }), "web_search  a, b");
    assert.equal(toolCallHeadline("source_search", { source: "arxiv", query: "diffusion" }), "source_search  arxiv · diffusion");
    // Numbers and booleans are settings, not subjects; a call with none of the
    // shapes worth showing still gets a legible line rather than "undefined".
    assert.equal(toolCallHeadline("run_python", { limit: 5, deep: true }), "run_python");
    assert.equal(toolCallHeadline("", null), "tool");
  });
});

// ---- 6. the deadline the brief reports ------------------------------------

test("remainingSeconds never goes negative and answers 0 when there is no target", () => {
  assert.equal(remainingSeconds(null), 0);
  assert.equal(remainingSeconds({ plan: {}, startedAt: Date.now() }), 0);
  assert.equal(remainingSeconds({ plan: { budgetMs: 60_000 }, startedAt: Date.now() - 600_000 }), 0);
  const left = remainingSeconds({ plan: { budgetMs: 60_000 }, startedAt: Date.now() });
  assert.ok(left > 55 && left <= 60, `about a minute left, got ${left}`);
});

test("with no execution environment bound, the compute tool is not offered", () => {
  // `needs: "exec"` on the binding rather than a knob on the agent: the class
  // is dropped and the REST of the toolbox survives. The failure this avoids is
  // handing a model a compute tool on a deployment with nothing to run in and
  // letting it spend rounds discovering that the hard way.
  const bound = harness().ctx;
  // `null`, not `undefined`: a destructuring default fires on undefined, so
  // passing that would silently keep the environment and pass the test for the
  // wrong reason.
  const unbound = harness({ exec: null }).ctx;
  const names = (c) => researchToolsForRun(c).map((t) => t.name);
  assert.ok(names(bound).includes("run_python"), "a bound environment serves it");
  assert.ok(!names(unbound).includes("run_python"), "an unbound one does not");
  // …and nothing else changed. A dropped class must not shrink the toolbox
  // around it, or an unbound sandbox would quietly cost the run its research.
  assert.deepEqual(
    names(unbound),
    names(bound).filter((n) => n !== "run_python"),
  );
});

test("the Se/rver container serves the python class exactly as far as the knob allows", () => {
  // have.exec is asked of execEnvironmentFor itself — the same function that
  // would run the program — so the toolbox and the runner cannot disagree.
  // Pinned in BOTH directions: a container deploy with the account's
  // execution-sandbox knob ON offers run_python; the knob OFF or the binding
  // absent drops the class, so the model is never handed a compute tool that
  // every call would only refuse (the honest-sentence side of that same gate is
  // pinned in src/research-tools-run.test.js).
  const names = (/** @type {any} */ c) => researchToolsForRun(c).map((/** @type {any} */ t) => t.name);
  const knobOn = { id: "u", user: { id: "u", settings_json: '{"bash_lite_mcp":true}' } };
  const knobOff = { id: "u", user: { id: "u" } };
  const serverCtx = (identity, env = { ...CONFIGURED, EXEC_SANDBOX: {} }) => {
    // `exec: null` — no caller-bound runner, which is every Worker-side
    // research turn: the container is the only environment the loop can reach.
    const { ctx } = harness({ exec: null, env });
    ctx.state.identity = identity;
    return ctx;
  };
  assert.ok(names(serverCtx(knobOn)).includes("run_python"), "binding + knob → the class is offered");
  assert.ok(!names(serverCtx(knobOff)).includes("run_python"), "knob off → the class is dropped");
  assert.ok(!names(serverCtx(knobOn, CONFIGURED)).includes("run_python"), "binding absent → dropped too");
});

describe("the loop is asked from the PLANNING view (feedback #65, fifth instance)", () => {
  const SCAFFOLD =
    "Structure the dossier as a TIBER-EU threat-intelligence report: Targeting, " +
    "Scenarios, Threat Actor Profiles, and a Controls Assessment annex.";

  test("method prose is not in the text the model writes queries from", () => {
    const h = harness({ lastUser: "Tiber style threat intel on Acme AB" });
    const state = /** @type {any} */ (h.ctx.state);
    state.methodBlocks = [SCAFFOLD];
    const c = /** @type {any} */ (h.ctx);
    c.planLastUser = "Tiber style threat intel on Acme AB";
    c.planConvText = "user: Tiber style threat intel on Acme AB";
    c.lastUser = `Tiber style threat intel on Acme AB\n\n${SCAFFOLD}`;
    c.convText = `user: Tiber style threat intel on Acme AB\n\n${SCAFFOLD}`;

    const input = buildLoopInput(h.ctx);
    const question = input.slice(0, input.indexOf("How the ANSWER should be structured"));
    // The half that decides the searches must be free of it. Planned against
    // the scaffold, the first query goes after the report FORMAT and carries
    // the scaffold's own words with it — which is exactly what #65 reported.
    assert.ok(!/TIBER-EU|Controls Assessment/.test(question), "the scaffold leaked into the question");
    assert.match(question, /Acme AB/, "the subject survived");
  });

  test("…and comes back, labelled as a house method rather than as a topic", () => {
    // Stripping it entirely would be the other bug: the scaffold is a real
    // instruction about the write-up, and the deterministic path got it for
    // free because synthesis read the enriched view after triage had planned
    // from the stripped one. One model does both jobs here, so the separation
    // has to be said out loud.
    const h = harness({ lastUser: "Tiber style threat intel on Acme AB" });
    /** @type {any} */ (h.ctx.state).methodBlocks = [SCAFFOLD];
    const input = buildLoopInput(h.ctx);
    assert.match(input, /How the ANSWER should be structured/);
    assert.match(input, /do not search for its words/);
    assert.ok(input.includes(SCAFFOLD), "the method itself must still reach the model");
  });

  test("a ctx with no planning view falls back rather than asking an empty question", () => {
    // The MCP channel builds a leaner state. Falling back to the enriched view
    // restores the previous behaviour; emptying the question would not.
    const h = harness({ lastUser: "how does split routing work?" });
    const c = /** @type {any} */ (h.ctx);
    delete c.planLastUser;
    delete c.planConvText;
    assert.match(buildLoopInput(h.ctx), /how does split routing work\?/);
  });
});

describe("the production crash of 2026-08-30: a null identity meets a real container binding", () => {
  // "Probability we live in a black hole, based on james webbs latest
  // observations" — asked three times, failed three times (chat_logs #1757,
  // #1759, #1760), each with `Cannot read properties of null (reading 'user')`,
  // followed by the user's own "Feedback this failed". The chain:
  // researchToolsForRun asks execEnvironmentFor whether anything can run a
  // program; on a deploy carrying the EXEC_SANDBOX binding that reaches
  // bashLiteEnabled → featureAvailability, which read `identity.user`
  // unguarded — and neither chat.js nor mcp.js had ever wired the identity
  // onto the state, so it was null on every real request. Local Workers and
  // CI have no container binding, so execContainerAvailable short-circuited
  // before the read and every suite stayed green while production burned.
  const bindingEnv = () => /** @type {any} */ ({
    BERGET_API_TOKEN: "t",
    EXEC_SANDBOX: { get: () => ({ fetch: async () => new Response("{}") }) },
  });

  test("toolbox resolution survives, and drops the python class", () => {
    const h = harness({ env: bindingEnv() });
    /** @type {any} */ (h.ctx.state).identity = null;
    // The harness binds a fake DREE runner by default (its other tests need
    // one); production's crash had NOTHING bound — clear it so the container
    // question is actually asked, which is where the read was.
    /** @type {any} */ (h.ctx.state).exec = undefined;
    // The crash was HERE — before the loop, before any fail-soft rung.
    const tools = researchToolsForRun(h.ctx);
    assert.ok(Array.isArray(tools), "toolbox resolution must not throw on a null identity");
    assert.ok(
      !tools.some((t) => t.name === "run_python"),
      "no identity means no account knob, means no container — the class is dropped, not crashed on",
    );
  });

  test("a signed-in identity with the knob on keeps the class", () => {
    const h = harness({ env: bindingEnv() });
    /** @type {any} */ (h.ctx.state).identity = {
      user: { id: "u1", settings_json: JSON.stringify({ bash_lite_mcp: true }) },
    };
    /** @type {any} */ (h.ctx.state).exec = undefined;
    const tools = researchToolsForRun(h.ctx);
    assert.ok(
      tools.some((t) => t.name === "run_python"),
      "the fix must not be a guard that silently answers no for everyone — the wired identity is the other half",
    );
  });
});
