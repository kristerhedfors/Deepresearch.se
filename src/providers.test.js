import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { isAnthropicModel, providerName } from "./providers.js";

// The dispatch itself (chatCompletion/completeJson routing to the right
// client) is exercised live — both branches are thin one-liners over the
// per-provider clients, which carry their own tests. What's unit-testable
// here is the routing predicate and the naming used in error messages.

describe("providers routing", () => {
  test("providerName follows the model-id namespace", () => {
    assert.equal(providerName("claude-opus-4-8"), "Anthropic");
    assert.equal(providerName("claude-haiku-4-5"), "Anthropic");
    assert.equal(providerName("mistralai/Mistral-Small-3.2-24B-Instruct-2506"), "Berget");
    assert.equal(providerName(undefined), "Berget"); // no model = provider default = Berget
  });

  test("isAnthropicModel is re-exported for callers that import only the seam", () => {
    assert.equal(isAnthropicModel("claude-sonnet-5"), true);
    assert.equal(isAnthropicModel("openai/gpt-oss-120b"), false);
  });
});
