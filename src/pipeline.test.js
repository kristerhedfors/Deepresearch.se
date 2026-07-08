import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { collectConflicts, isTransientConnectStatus, normalizeTriage } from "./pipeline.js";

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
