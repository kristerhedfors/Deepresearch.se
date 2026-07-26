// (no @ts-check: node:test / node:assert have no type declarations in this
// repo — tsconfig's types is workers-only and @types/node would be a new
// dependency.)
// Covers the pipeline's pure exports: normalizeTriage (the triage-failure
// fallback incl. decomposition/quiz fields — src/triage.js), collectConflicts
// (src/pipeline.js), and isTransientConnectStatus (src/answer-stream.js).
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { isTransientConnectStatus, contextOverflowMessage } from "./answer-stream.js";
import { collectConflicts } from "./pipeline-inputs.js";
import { searchPolicyFor } from "./pipeline.js";
import { normalizeTriage } from "./triage.js";

describe("normalizeTriage", () => {
  test("clarify with a real question is preserved and trimmed", () => {
    const result = normalizeTriage({ action: "clarify", question: "  which region?  " }, "some question");
    assert.deepEqual(result, { action: "clarify", question: "which region?" });
  });

  test("clarify with a blank question falls through to the fallback logic", () => {
    const result = normalizeTriage({ action: "clarify", question: "   " }, "a long enough question here");
    assert.equal(result.action, "research");
  });

  test("research action filters out non-string and blank queries", () => {
    const result = normalizeTriage({ action: "research", queries: ["real query", "", null, 42, "  "] }, "x");
    assert.deepEqual(result, { action: "research", queries: ["real query"] });
  });

  test("research action with no usable queries falls back", () => {
    const result = normalizeTriage({ action: "research", queries: [] }, "a long enough fallback question");
    assert.equal(result.action, "research");
    assert.deepEqual(result.queries, ["a long enough fallback question"]);
  });

  test("direct action passes through", () => {
    assert.deepEqual(normalizeTriage({ action: "direct" }, "hi"), { action: "direct" });
  });

  test("the optional quiz flag rides along on direct and research, strict-boolean only", () => {
    assert.deepEqual(normalizeTriage({ action: "direct", quiz: true }, "wuiz me"), { action: "direct", quiz: true });
    const research = normalizeTriage({ action: "research", queries: ["glider handbook"], quiz: true }, "x");
    assert.equal(research.quiz, true);
    // Anything but literal true is dropped — never a truthy-string surprise.
    assert.deepEqual(normalizeTriage({ action: "direct", quiz: "yes" }, "hi"), { action: "direct" });
    assert.equal(normalizeTriage({ action: "research", queries: ["q"], quiz: 1 }, "x").quiz, undefined);
    // And clarify never carries it.
    assert.deepEqual(
      normalizeTriage({ action: "clarify", question: "which?", quiz: true }, "x"),
      { action: "clarify", question: "which?" },
    );
  });

  test("unparseable triage falls back to research when the user message is long enough (>=12 chars)", () => {
    const result = normalizeTriage(null, "this is a decently long question");
    assert.equal(result.action, "research");
    assert.deepEqual(result.queries, ["this is a decently long question"]);
  });

  test("unparseable triage falls back to direct when the user message is short (<12 chars)", () => {
    const result = normalizeTriage(undefined, "hi there");
    assert.equal(result.action, "direct");
  });

  test("fallback research query is truncated to 300 chars", () => {
    const long = "x".repeat(400);
    const result = normalizeTriage({}, long);
    assert.equal(result.queries[0].length, 300);
  });

  test("on triage failure, a short follow-up seeds the search from the prior question, not the referential phrase", () => {
    // "undersök saken" ("investigate the matter") is meaningless as a literal
    // search; with a prior turn present the fallback searches that topic.
    const result = normalizeTriage(null, "undersök saken", "Vad hände med Northvolt konkursen?");
    assert.equal(result.action, "research");
    assert.deepEqual(result.queries, ["Vad hände med Northvolt konkursen?"]);
  });

  test("with no prior turn there is nothing to resolve against, so a short standalone message is researched as-is (pre-existing behavior, unchanged)", () => {
    // A bare "undersök saken" as the FIRST message has no context to seed
    // from and is indistinguishable from a legit short query like
    // "Northvolt konkurs 2026"; the follow-up seeding only applies when a
    // prior user turn exists. This documents that the prior-less path keeps
    // the original >=12-char research fallback.
    const result = normalizeTriage(null, "undersök saken");
    assert.equal(result.action, "research");
    assert.deepEqual(result.queries, ["undersök saken"]);
  });

  test("on triage failure, a substantial standalone message is still researched as-is even with prior context", () => {
    const msg = "What is the current market share of electric vehicles in Norway in 2026?";
    const result = normalizeTriage(null, msg, "earlier unrelated question about batteries");
    assert.equal(result.action, "research");
    assert.deepEqual(result.queries, [msg]);
  });
});

describe("normalizeTriage — decomposition fields (complexity, subquestions)", () => {
  test("carries a valid complexity and trimmed sub-questions through the research path", () => {
    const result = normalizeTriage(
      {
        action: "research",
        queries: ["q1"],
        complexity: "multihop",
        subquestions: ["  Who owns X? ", "What did the owner announce?"],
      },
      "x",
    );
    assert.equal(result.complexity, "multihop");
    assert.deepEqual(result.subquestions, ["Who owns X?", "What did the owner announce?"]);
  });

  test("omits both fields when absent — the pre-decomposition shape exactly", () => {
    const result = normalizeTriage({ action: "research", queries: ["real query"] }, "x");
    assert.deepEqual(result, { action: "research", queries: ["real query"] });
  });

  test("drops an unknown complexity value instead of carrying junk", () => {
    const result = normalizeTriage(
      { action: "research", queries: ["q"], complexity: "extreme" },
      "x",
    );
    assert.equal("complexity" in result, false);
  });

  test("filters non-string/blank sub-questions and caps at 5", () => {
    const result = normalizeTriage(
      {
        action: "research",
        queries: ["q"],
        subquestions: ["a", "", null, 42, "b", "c", "d", "e", "f"],
      },
      "x",
    );
    assert.deepEqual(result.subquestions, ["a", "b", "c", "d", "e"]);
  });

  test("an empty subquestions array is omitted, not attached", () => {
    const result = normalizeTriage(
      { action: "research", queries: ["q"], subquestions: [] },
      "x",
    );
    assert.equal("subquestions" in result, false);
  });
});

describe("collectConflicts", () => {
  test("accumulates trimmed conflicts across gap rounds, deduped", () => {
    const state = {};
    collectConflicts(state, { conflicts: [" A says 5, B says 7 ", "dates differ"] });
    collectConflicts(state, { conflicts: ["dates differ", "C disputes the attribution"] });
    assert.deepEqual(state.conflicts, [
      "A says 5, B says 7",
      "dates differ",
      "C disputes the attribution",
    ]);
  });

  test("missing/malformed conflicts fields are simply no conflicts", () => {
    const state = {};
    collectConflicts(state, null);
    collectConflicts(state, {});
    collectConflicts(state, { conflicts: "not an array" });
    collectConflicts(state, { conflicts: [null, "", 42] });
    assert.deepEqual(state.conflicts, []);
  });

  test("caps the accumulated list at 6", () => {
    const state = {};
    collectConflicts(state, { conflicts: ["1", "2", "3", "4"] });
    collectConflicts(state, { conflicts: ["5", "6", "7", "8"] });
    assert.equal(state.conflicts.length, 6);
  });
});

describe("isTransientConnectStatus", () => {
  test("provider-side statuses are retryable", () => {
    for (const status of [500, 502, 503, 504, 429, 408]) {
      assert.equal(isTransientConnectStatus(status), true, `status ${status}`);
    }
  });

  test("deterministic client errors are not retried", () => {
    for (const status of [400, 401, 403, 404, 413, 422]) {
      assert.equal(isTransientConnectStatus(status), false, `status ${status}`);
    }
  });
});

// Regression pin for chat_logs #524 (2026-07-18): an introspection turn on the
// 32k Mistral Small overran the context window and the raw Berget 400 JSON was
// dumped at the user with no answer. contextOverflowMessage() rewrites that
// deterministic "input too large" 400 into a clean, actionable sentence; every
// other 400 (and every non-400) passes through untouched so the normal error
// path still surfaces.
describe("contextOverflowMessage", () => {
  test("rewrites the OpenAI-shape context_length_exceeded 400", () => {
    const berget400 =
      '{"error":{"message":"This model\'s maximum context length is 32768 tokens. ' +
      'However, your input is estimated at 32134 tokens. Please reduce the length of ' +
      'the input.","type":"invalid_request_error","code":"context_length_exceeded"}}';
    const msg = contextOverflowMessage(400, berget400);
    assert.ok(msg, "an overflow 400 yields a message");
    assert.match(msg, /too long for the selected model/i);
    assert.doesNotMatch(msg, /context_length_exceeded|invalid_request_error/, "no raw provider JSON leaks");
  });

  test("matches the several phrasings OpenAI-compatible providers use", () => {
    for (const detail of [
      "context_length_exceeded",
      "context length exceeded",
      "This model's maximum context length is 8192 tokens",
      "the model's context window is too small",
      "Please reduce the length of the messages",
      "Please reduce the length of the prompt",
    ]) {
      assert.ok(contextOverflowMessage(400, detail), `should match: ${detail}`);
    }
  });

  test("leaves other 400s and non-400 statuses alone", () => {
    assert.equal(contextOverflowMessage(400, '{"error":{"message":"bad request"}}'), null);
    assert.equal(contextOverflowMessage(400, ""), null);
    assert.equal(contextOverflowMessage(401, "context_length_exceeded"), null);
    assert.equal(contextOverflowMessage(500, "maximum context length"), null);
  });
});

// Regression pin for chat_logs #360 (2026-07-15): the deterministic quiz gate
// must read the CLEAN pre-enrichment message, never the enrichment-appended
// lastUser — the introspection block folded into lastUser carries the
// CLAUDE.md orientation, whose prose contains literal "quiz me…" examples, so
// with developer mode on EVERY request quiz-triggered and the whole answer
// became a 5-question quiz. quizIntent itself is pure and correct (quiz.test
// covers it); the bug was the CALL SITE's argument, so that is what gets
// pinned — same style as the façade-contract source pins elsewhere.
describe("quiz gate reads the clean (pre-enrichment) user message", () => {
  const src = readFileSync(new URL("./pipeline.js", import.meta.url), "utf8");

  test("the primary deterministic gate uses cleanLastUser", () => {
    assert.match(src, /quizIntent\(ctx\.cleanLastUser\)/);
    assert.doesNotMatch(src, /quizIntent\(ctx\.lastUser\)/);
  });

  test("the triage-backup question count uses cleanLastUser", () => {
    assert.match(src, /quizQuestionCount\(ctx\.cleanLastUser\)/);
    assert.doesNotMatch(src, /quizQuestionCount\(ctx\.lastUser\)/);
  });
});

// Regression pin (feedback: "gave up too early" / "strive toward the depth
// target, shortcut if there isn't more to explore"): the deep-tier gap loop
// now runs a HIGH round ceiling (budget.js), so it needs a diminishing-returns
// stop — a follow-up wave that adds NO new sources ends the loop instead of
// spinning further rounds against the same registry. This is the meaningful-
// action guarantee that keeps the raised ceiling honest.
describe("gap loop stops when a follow-up wave surfaces no new sources", () => {
  const src = readFileSync(new URL("./pipeline.js", import.meta.url), "utf8");

  test("runGapChecks captures the source count before the wave and breaks on no gain", () => {
    assert.match(src, /const sourcesBefore = state\.sources\.length/);
    assert.match(src, /if \(state\.sources\.length === sourcesBefore\)[\s\S]*?break/);
    // The break lives AFTER the searches run (it measures their yield), not before.
    assert.match(src, /await runSearches\(ctx, followups[\s\S]*?state\.sources\.length === sourcesBefore/);
  });
});

describe("the web-search knob gates Exa only — depth still runs over other sources", () => {
  const src = readFileSync(new URL("./pipeline.js", import.meta.url), "utf8");

  // The gate is now reached through searchPolicyFor(state) — the knob ANDed
  // with the answering agent's declared ceiling (AgentSpec 0.2.0
  // capability.search). These pin the POLICY the way prompt-sets.test.js pins
  // a prompt role rather than a literal call: that the knob still decides is
  // asserted against the helper, and behaviour against the helper's own suite.
  test("the knob reaches the Exa gate through the search policy", () => {
    // searchPolicyFor must read state.webSearch — if it stopped, every pin
    // below would still match while the knob quietly did nothing.
    assert.match(src, /export function searchPolicyFor\(state\)[\s\S]*capSearch\([\s\S]*\{ web: state\.webSearch \}\)/);
  });

  test("runSearches gates the Exa call on the resolved policy", () => {
    // The web leg (webSearch(env,…) + its billing counter) lives behind the
    // gate; without it the knob would still search when off. The call carries
    // the user's picked SOURCE — which engine runs it — but the gate is what
    // decides whether it runs at all.
    assert.match(
      src,
      /if \(policy\.web\) \{[\s\S]*webSearch\(env, log, query, state\.plan\.searchDepth, \{ source: state\.searchSource \|\| "" \}\)/,
    );
    assert.match(src, /if \(policy\.web\) \{[\s\S]*state\.searchCount \+= batch\.length/);
  });

  test("runAuxSearches runs regardless of the knob (outside the Exa gate)", () => {
    // The aux wave (HF Hub & co) must NOT be inside the Exa gate, so it still
    // fires with web search off — depth over available sources. It has its own
    // declaration (`search.auxSources`), which is a different question.
    const runSearches = src.slice(src.indexOf("async function runSearches"), src.indexOf("async function runAuxSearches"));
    assert.match(runSearches, /await runAuxSearches\(ctx, batch, round\);/);
    // The aux call sits after the closing brace of the Exa block, not within it.
    const auxIdx = runSearches.indexOf("await runAuxSearches");
    const gateIdx = runSearches.indexOf("if (policy.web)");
    assert.ok(gateIdx >= 0 && auxIdx > gateIdx, "aux call comes after the Exa gate");
  });

  test("web-off short-circuits to the model answer ONLY when no other source applies", () => {
    // Developer-mode source research and any applicable aux source keep the
    // research path alive with the knob off; runWithoutSearch is the fallback
    // for when none applies. "Applicable" is the source's own intent OR the
    // state's forceAux list — a mode built AROUND a source (the Hugging Face
    // agent) must not fall through to a sourceless answer just because the
    // message didn't happen to name the hub. The aux half is still subject to
    // the agent's own auxSources declaration, which outranks a forced source.
    assert.match(
      src,
      /if \(!policy\.web\) \{[\s\S]*if \(!ctx\.hasSource && !\(policy\.auxSources && SEARCH_SOURCES\.some\(\(s\) => forcedAux\.includes\(s\.id\) \|\| s\.intent\(ctx\.lastUser\)\)\)\) \{[\s\S]*return runWithoutSearch\(ctx\);/,
    );
  });

  test("a forced source runs even when the message does not engage it", () => {
    // The forceAux seam itself: runAuxSearch skips a source whose intent is
    // false UNLESS the state listed its id. Generic — the pipeline reads ids
    // off the state and never names one.
    const runAux = src.slice(src.indexOf("async function runAuxSearch(ctx, source"));
    assert.match(runAux, /forceAux[\s\S]*\.includes\(source\.id\)/);
    assert.match(runAux, /if \(!batch\.length \|\| \(!forced && !source\.intent\(ctx\.lastUser\)\)\) return;/);
  });

  test("a forced source survives the developer-mode source-research path (feedback #36)", () => {
    // The regression this cost us: `state.forceAux` was honoured only inside
    // the search wave, and developer mode never reaches a wave — it answers
    // from the site's own files. So the Models agent, whose whole identity is
    // the model hub, answered model questions with 0 searches / 0 sources
    // whenever dev mode was also on (chat_logs #670, #671). Both source-
    // research answer paths must now carry the forced sources' findings.
    const fn = src.slice(src.indexOf("async function runForcedAuxSearches"), src.indexOf("async function runSourceResearch(ctx)"));
    // Generic: ids come off the state, no source is named here.
    assert.match(fn, /state\)\.forceAux/);
    assert.match(fn, /for \(const source of SEARCH_SOURCES\)[\s\S]*forced\.includes\(source\.id\)[\s\S]*runAuxSearch\(ctx, source, batch, 1\)/);
    assert.doesNotMatch(fn, /\bhf\b|hugging/i);
    // The agent's own auxSources declaration still outranks the force.
    assert.match(fn, /!forced\.length \|\| !searchPolicyFor\(state\)\.auxSources/);

    const sourceResearch = src.slice(src.indexOf("async function runSourceResearch(ctx)"), src.indexOf("async function runSubquestionFanout"));
    // Run BEFORE the snapshot check, so even the no-snapshot exit has them.
    const auxIdx = sourceResearch.indexOf("await runForcedAuxSearches(ctx)");
    assert.ok(auxIdx >= 0 && auxIdx < sourceResearch.indexOf("if (!snapshot"), "forced aux runs before the snapshot check");
    // …and reaches BOTH answer paths — the native-tool one and the read loop.
    assert.match(sourceResearch, /runSourceResearchTools\(ctx, snapshot, auxBlock\)/);
    assert.match(sourceResearch, /\(auxBlock \? `\$\{auxBlock\}\\n\\n` : ""\)/);
    // The answer prompt is told external sources exist — otherwise its flat
    // "there are no external sources to cite" discards what we just fetched.
    assert.match(sourceResearch, /"source-research", "answer"\)\(\{ externalSources: !!auxBlock \}\)/);
    const tools = src.slice(src.indexOf("async function runSourceResearchTools"), src.indexOf("export const MAX_SDK_TOOL_ROUNDS"));
    assert.match(tools, /"source-research", "answer-tools"\)\(\{ externalSources: !!auxBlock \}\)/);
  });

  test("a mode may raise a source's per-request search ceiling, generically", () => {
    // feedback #36: "the Models pipeline should be even more inclined to search
    // hf". The override is read off the state by id — core names no source —
    // and only ever RAISES the registry's own default.
    const runAux = src.slice(src.indexOf("async function runAuxSearch(ctx, source"));
    assert.match(runAux, /state\)\.auxMaxPerRequest\?\.\[source\.id\]/);
    assert.match(runAux, /typeof override === "number" && override > 0 \? override : \(source\.maxPerRequest \?\? MAX_AUX_SEARCHES_DEFAULT\)/);
    assert.match(runAux, /if \(st\.count >= cap\) return;/);
  });

  test("an introspection agent's `search.web: false` does not disarm the knob", () => {
    // The regression this stage could most easily have shipped. Introspection
    // declares web:false because its OWN phase does not search; the pipeline
    // reaches the research flow below only when the per-message
    // externalSourceIntent gate hands the turn back precisely in order to
    // search. A capability governs the phase it names and no other.
    const introspecting = { webSearch: true, capability: { answerPhase: "source-research", search: { web: false } } };
    assert.equal(searchPolicyFor(/** @type {any} */ (introspecting)).web, true);
    // …while an agent that DOES declare the research phase narrows it.
    const declared = { webSearch: true, capability: { answerPhase: "research", search: { web: false } } };
    assert.equal(searchPolicyFor(/** @type {any} */ (declared)).web, false);
    // …and no declaration at all is the knob alone, both ways.
    assert.equal(searchPolicyFor(/** @type {any} */ ({ webSearch: true, capability: null })).web, true);
    assert.equal(searchPolicyFor(/** @type {any} */ ({ webSearch: false, capability: null })).web, false);
  });

  test("a declared search ceiling can never widen the knob", () => {
    // Narrowing in both directions: the knob off wins over any declaration.
    const state = { webSearch: false, capability: { answerPhase: "research", search: { web: true } } };
    assert.equal(searchPolicyFor(/** @type {any} */ (state)).web, false);
  });

  test("runWithoutSearch scales the model answer by the slider's report tier", () => {
    // The prompt is reached through the prompt-set binding (src/prompt-sets.js)
    // rather than imported directly, so this pins the ROLE the phase asks for
    // plus the report tier it threads in. Which builder that role resolves to is
    // pinned by identity in prompt-sets.test.js.
    assert.match(
      src,
      /phasePrompt\(ctx\.state, "direct", "answer-search-off"\)\(\{[^}]*reportTier: ctx\.state\.plan\.reportTier/,
    );
  });
});

// ---- the answer-phase dispatch (stage 3, extended by stage 6) ----------------
//
// The registry-resolved `capability.answerPhase` picks the executor. This was
// never pinned: a grep for the mode flags across every *.test.js hit only
// prompts.test.js, so the table could lose a row without a failing test.

describe("the answer-phase dispatch table", () => {
  const src = readFileSync(new URL("./pipeline.js", import.meta.url), "utf8");
  const table = src.slice(src.indexOf("const ANSWER_PHASE_RUNNERS"), src.indexOf("function answerPhaseFor"));

  test("every executor phase in the vocabulary has a runner", () => {
    // ANSWER_PHASES also declares `research` and `source-research`, which are
    // deliberately NOT dispatch targets: which of those two a knob-on turn runs
    // is a per-message decision the hasSource + externalSourceIntent gate owns.
    for (const [phase, fn] of [
      ["build", "runSdkBuild"],
      ["workflow", "runOrchestration"],
      ["feed", "runOutrospection"],
      ["direct", "runWithoutSearch"],
    ]) {
      assert.match(table, new RegExp(`\\b${phase}: ${fn},`), `${phase} → ${fn}`);
    }
    assert.ok(!/\bresearch:/.test(table), "research is not a dispatch target");
    assert.ok(!/\bsource-research:/.test(table), "source-research is not a dispatch target");
  });

  test("the mode booleans survive as the fail-soft fallback", () => {
    // An unreadable registry, and the MCP channel which builds state without
    // any of this, both depend on these three (invariant 2).
    assert.match(src, /if \(state\.sdkMode\) return "build";/);
    assert.match(src, /if \(state\.orchestratorMode\) return "workflow";/);
    assert.match(src, /if \(state\.outrospectionMode\) return "feed";/);
    // `direct` deliberately has NO boolean fallback: it is reachable only by
    // addressing an agent that declares it, so there is no mode to fall back to.
    assert.ok(!/return "direct";/.test(src.slice(src.indexOf("function answerPhaseFor"), src.indexOf("function answerPhaseFor") + 900)));
  });
});
