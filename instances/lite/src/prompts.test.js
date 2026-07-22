// @ts-nocheck
import { test } from "node:test";
import assert from "node:assert/strict";
import { triagePrompt, synthesisPrompt, ANTI_INJECTION_NOTE, LANGUAGE_NOTE, SOURCE_RULE } from "./prompts.js";

// Prompts are code — assert each standing rule is present where it must be.

test("triage carries the anti-injection note (triage classifies raw user text)", () => {
  const sys = triagePrompt("q").find((m) => m.role === "system").content;
  assert.ok(sys.includes(ANTI_INJECTION_NOTE));
  assert.match(sys, /json/i);
});

test("triage expands a follow-up using the prior message", () => {
  const withPrior = triagePrompt("and 2024?", "population of Stockholm");
  assert.ok(withPrior.some((m) => m.content.includes("population of Stockholm")));
});

test("synthesis carries anti-injection AND language note (it reads raw web content)", () => {
  const sys = synthesisPrompt("q", "[1] title\nhttp://x\nsnippet").find((m) => m.role === "system").content;
  assert.ok(sys.includes(ANTI_INJECTION_NOTE), "anti-injection required on synthesis");
  assert.ok(sys.includes(LANGUAGE_NOTE), "EN/SV language note required");
});

test("the source-citation rule appears only when a digest is present", () => {
  const withDigest = synthesisPrompt("q", "[1] t\nhttp://x").find((m) => m.role === "system").content;
  const noDigest = synthesisPrompt("q", "").find((m) => m.role === "system").content;
  assert.ok(withDigest.includes(SOURCE_RULE));
  assert.ok(!noDigest.includes(SOURCE_RULE));
});

test("synthesis puts the digest in the user turn and trims history", () => {
  const history = Array.from({ length: 20 }, (_, i) => ({ role: "user", content: `h${i}` }));
  const msgs = synthesisPrompt("the question", "[1] src", history);
  const userTurn = msgs[msgs.length - 1];
  assert.match(userTurn.content, /the question/);
  assert.match(userTurn.content, /\[1\] src/);
  assert.ok(msgs.length <= 8, "history is trimmed to the last few turns + system + question");
});
