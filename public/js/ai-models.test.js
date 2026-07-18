import { test } from "node:test";
import assert from "node:assert/strict";
import { aiModelIntent, aiModelMentions, AI_MODEL_NOT_A_PACKAGE_NOTE, AI_MODEL_RESEARCH_NOTE } from "./ai-models.js";

test("aiModelIntent recognizes versioned model names (the reported misfire)", () => {
  // The exact IMG_5207 case: "Latest on glm-5.2" must read as a model.
  assert.equal(aiModelIntent("Latest on glm-5.2"), true);
  assert.equal(aiModelIntent("glm 4.6 benchmarks"), true);
  assert.equal(aiModelIntent("what can GLM4 do"), true);
  assert.equal(aiModelIntent("kimi k2 vs kimi k3"), true);
  assert.equal(aiModelIntent("llama 4 release"), true);
  assert.equal(aiModelIntent("gemini 2.5 pro"), true);
  assert.equal(aiModelIntent("gpt-5 pricing"), true);
  assert.equal(aiModelIntent("claude 3.7 sonnet"), true);
  assert.equal(aiModelIntent("grok-4"), true);
});

test("aiModelIntent recognizes strong (bare) family names", () => {
  assert.equal(aiModelIntent("tell me about deepseek"), true);
  assert.equal(aiModelIntent("is qwen any good"), true);
  assert.equal(aiModelIntent("kimi latest news"), true);
  assert.equal(aiModelIntent("mixtral vs mistral"), true);
  assert.equal(aiModelIntent("o3 reasoning"), true);
});

test("aiModelIntent has Swedish parity (model names are language-neutral)", () => {
  // Same tokens, Swedish phrasing — must match identically (invariant 6).
  assert.equal(aiModelIntent("senaste om glm-5.2"), true);
  assert.equal(aiModelIntent("vad är nytt i deepseek"), true);
  assert.equal(aiModelIntent("hur bra är kimi k2 jämfört med k3"), true);
  assert.equal(aiModelIntent("berätta om llama 4"), true);
});

test("aiModelIntent does NOT match a bare GLM (the C++ math library) or unrelated words", () => {
  // Bare "glm" with no version is the OpenGL Mathematics library / the
  // statistical model — not an AI model. Must stay false so the sandbox may
  // legitimately look it up if asked.
  assert.equal(aiModelIntent("how do I install glm headers"), false);
  assert.equal(aiModelIntent("fit a glm in R"), false);
  assert.equal(aiModelIntent("the llama walked up the hill"), false);
  assert.equal(aiModelIntent("play me a sonnet"), false);
  assert.equal(aiModelIntent("grok the concept"), false);
  assert.equal(aiModelIntent(""), false);
  assert.equal(aiModelIntent("   "), false);
});

test("aiModelMentions extracts the distinct tokens in order", () => {
  assert.deepEqual(aiModelMentions("kimi k2 vs kimi k3"), ["kimi k2", "kimi k3"]);
  assert.deepEqual(aiModelMentions("Latest on glm-5.2"), ["glm-5.2"]);
  assert.deepEqual(aiModelMentions("deepseek and qwen"), ["deepseek", "qwen"]);
  assert.deepEqual(aiModelMentions("nothing here"), []);
});

test("prompt notes name the families the user called out", () => {
  for (const fam of ["GLM", "Kimi", "DeepSeek"]) {
    assert.ok(AI_MODEL_NOT_A_PACKAGE_NOTE.includes(fam), `package note names ${fam}`);
  }
  assert.ok(/SHELL_DONE/.test(AI_MODEL_NOT_A_PACKAGE_NOTE));
  assert.ok(/RESEARCH/i.test(AI_MODEL_RESEARCH_NOTE));
});
