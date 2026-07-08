import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { getModelProfile } from "./model-profiles.js";

describe("getModelProfile", () => {
  test("unknown model returns DEFAULT, completely unaffected", () => {
    const profile = getModelProfile("some/brand-new-model-nobody-has-profiled");
    assert.equal(profile.priorsMs, null);
    assert.equal(profile.jsonReinforcement, false);
    assert.equal(profile.maxTokensOverride, null);
    assert.equal(profile.skipValidation, false);
    assert.equal(profile.maxCompletionAttempts, 2);
  });

  test("GLM-4.7-FP8 gets elevated priors but default retry/validation behavior", () => {
    const profile = getModelProfile("zai-org/GLM-4.7-FP8");
    assert.ok(profile.priorsMs);
    assert.equal(profile.priorsMs.synth, 40_000);
    assert.equal(profile.skipValidation, false);
    assert.equal(profile.maxCompletionAttempts, 2);
  });

  test("Kimi-K2.6 gets a widened completion-attempt count on top of its priors", () => {
    const profile = getModelProfile("moonshotai/Kimi-K2.6");
    assert.equal(profile.maxCompletionAttempts, 3);
    assert.ok(profile.priorsMs);
  });

  test("gpt-oss-120b skips validation and reinforces JSON-only output", () => {
    const profile = getModelProfile("openai/gpt-oss-120b");
    assert.equal(profile.skipValidation, true);
    assert.equal(profile.jsonReinforcement, true);
    assert.equal(profile.priorsMs, null, "this override never set priors");
  });

  test("nested override fields (priorsMs) are cloned, not shared with OVERRIDES", () => {
    const a = getModelProfile("zai-org/GLM-4.7-FP8");
    const b = getModelProfile("zai-org/GLM-4.7-FP8");
    assert.notEqual(a.priorsMs, b.priorsMs, "each call must return its own copy");
    a.priorsMs.synth = 1;
    assert.equal(b.priorsMs.synth, 40_000, "mutating one call's result must not affect another's");
  });

  test("a profile without a nested-field override gets the DEFAULT's null, not undefined", () => {
    const profile = getModelProfile("openai/gpt-oss-120b");
    assert.equal(profile.maxTokensOverride, null);
  });
});

test("Mistral Medium carries the probed 2-image-per-request cap; others have no limit", () => {
  // 2026-07-08 live probe: 1 ✓, 2 ✓, 3 ✗, 4 ✗ (count, not size — 4 tiny
  // images 400ed identically); Kimi and gemma accepted 4 images fine.
  assert.equal(getModelProfile("mistralai/Mistral-Medium-3.5-128B").maxImages, 2);
  assert.equal(getModelProfile("moonshotai/Kimi-K2.6").maxImages, null);
  assert.equal(getModelProfile("unknown/model").maxImages, null);
});
