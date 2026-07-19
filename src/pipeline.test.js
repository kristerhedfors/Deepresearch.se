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

  test("runSearches gates the Exa call on state.webSearch", () => {
    // The Exa leg (webSearch(env,…) + its billing counter) lives behind the
    // knob; without the gate the knob would still hit Exa when off.
    assert.match(src, /if \(state\.webSearch\) \{[\s\S]*webSearch\(env, log, query, state\.plan\.searchDepth\)/);
    assert.match(src, /if \(state\.webSearch\) \{[\s\S]*state\.searchCount \+= batch\.length/);
  });

  test("runAuxSearches runs regardless of the knob (outside the Exa gate)", () => {
    // The aux wave (HF Hub & co) must NOT be inside `if (state.webSearch)`, so
    // it still fires with web search off — depth over available sources.
    const runSearches = src.slice(src.indexOf("async function runSearches"), src.indexOf("async function runAuxSearches"));
    assert.match(runSearches, /await runAuxSearches\(ctx, batch, round\);/);
    // The aux call sits after the closing brace of the webSearch block, not within it.
    const auxIdx = runSearches.indexOf("await runAuxSearches");
    const gateIdx = runSearches.indexOf("if (state.webSearch)");
    assert.ok(gateIdx >= 0 && auxIdx > gateIdx, "aux call comes after the Exa gate");
  });

  test("web-off short-circuits to the model answer ONLY when no other source applies", () => {
    // Developer-mode source research and any applicable aux source (SEARCH_SOURCES
    // intent) keep the research path alive with the knob off; runWithoutSearch is
    // the fallback for when none applies.
    assert.match(
      src,
      /if \(!state\.webSearch\) \{[\s\S]*if \(!ctx\.hasSource && !SEARCH_SOURCES\.some\(\(s\) => s\.intent\(ctx\.lastUser\)\)\) \{[\s\S]*return runWithoutSearch\(ctx\);/,
    );
  });

  test("runWithoutSearch scales the model answer by the slider's report tier", () => {
    assert.match(src, /searchOffPrompt\(\{[^}]*reportTier: ctx\.state\.plan\.reportTier/);
  });
});
