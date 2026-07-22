// @ts-nocheck
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeTriage, isSmalltalk } from "./triage.js";

test("a usable model plan passes through", () => {
  const r = normalizeTriage({ mode: "research", queries: ["a", "b"] }, "some question");
  assert.equal(r.mode, "research");
  assert.deepEqual(r.queries, ["a", "b"]);
});

test("direct plan drops queries", () => {
  const r = normalizeTriage({ mode: "direct", queries: ["x"] }, "hi there friend");
  assert.equal(r.mode, "direct");
  assert.deepEqual(r.queries, []);
});

test("junk falls back model-free: substantial message => research", () => {
  const r = normalizeTriage(null, "what is the capital of Sweden and its population");
  assert.equal(r.mode, "research");
  assert.equal(r.queries.length, 1);
});

test("junk falls back model-free: trivial message => direct", () => {
  const r = normalizeTriage(undefined, "thanks");
  assert.equal(r.mode, "direct");
});

test("short follow-up is seeded from the prior question", () => {
  const r = normalizeTriage(null, "and in 2024?", "what was the population of Stockholm");
  assert.equal(r.mode, "research");
  assert.match(r.queries[0], /Stockholm/);
  assert.match(r.queries[0], /2024/);
});

test("research with empty queries gets a seeded one", () => {
  const r = normalizeTriage({ mode: "research", queries: [] }, "explain quantum tunneling in detail");
  assert.equal(r.queries.length, 1);
});

// PA-6: EN + SV smalltalk parity — every English form has a Swedish counterpart.
test("smalltalk gate — English", () => {
  for (const m of ["hi", "hey", "hello", "good morning", "thanks", "thank you", "bye", "see you", "cheers"]) {
    assert.equal(isSmalltalk(m), true, `EN: ${m}`);
  }
});

test("smalltalk gate — Swedish parity", () => {
  for (const m of ["hej", "hejsan", "tjena", "god morgon", "tack", "tack så mycket", "hej då", "vi ses", "tackar"]) {
    assert.equal(isSmalltalk(m), true, `SV: ${m}`);
  }
});

test("smalltalk gate does not swallow real questions", () => {
  assert.equal(isSmalltalk("hej, vad är huvudstaden i Norge?"), false);
  assert.equal(isSmalltalk("hello, what is the GDP of Sweden?"), false);
});

test("smalltalk routes direct even when over the word-count threshold", () => {
  const r = normalizeTriage(null, "tack så mycket");
  assert.equal(r.mode, "direct");
});
