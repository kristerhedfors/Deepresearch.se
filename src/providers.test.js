import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { isAnthropicModel, isOpenAiModel, listChatModels, providerName } from "./providers.js";

// The dispatch itself (chatCompletion/completeJson routing to the right
// client) is exercised live — the registry lookup is a thin one-liner over
// the per-provider clients, which carry their own tests. What's
// unit-testable here is the routing predicate, the naming used in error
// messages, and the catalog merge/degrade behavior.

describe("providers routing", () => {
  test("providerName follows the model-id namespace", () => {
    assert.equal(providerName("claude-opus-4-8"), "Anthropic");
    assert.equal(providerName("claude-haiku-4-5"), "Anthropic");
    assert.equal(providerName("gpt-5.6-sol"), "OpenAI");
    assert.equal(providerName("gpt-5.4-mini"), "OpenAI");
    assert.equal(providerName("mistralai/Mistral-Small-3.2-24B-Instruct-2506"), "Berget");
    assert.equal(providerName("openai/gpt-oss-120b"), "Berget"); // vendor-path lookalike stays on Berget
    assert.equal(providerName(undefined), "Berget"); // no model = provider default = Berget
  });

  test("routing predicates are re-exported for callers that import only the seam", () => {
    assert.equal(isAnthropicModel("claude-sonnet-5"), true);
    assert.equal(isAnthropicModel("openai/gpt-oss-120b"), false);
    assert.equal(isOpenAiModel("gpt-5.6-luna"), true);
    assert.equal(isOpenAiModel("openai/gpt-oss-120b"), false);
  });
});

describe("listChatModels degrade path", () => {
  // An unreachable BERGET_URL makes the Berget catalog fetch throw fast;
  // the merged catalog must then degrade to the reachable key-gated
  // providers' entries rather than reporting no catalog at all.
  const deadBerget = "http://127.0.0.1:9"; // discard port — connection refused

  test("Berget down + secondary providers configured → their entries still serve", async () => {
    const models = await listChatModels({
      BERGET_URL: deadBerget,
      ANTHROPIC_API_KEY: "k",
      OPENAI_API_KEY: "k",
    });
    const providers = new Set(models.map((m) => m.provider));
    assert.deepEqual(providers, new Set(["anthropic", "openai"]));
    assert.ok(models.some((m) => m.id.startsWith("claude-")));
    assert.ok(models.some((m) => m.id.startsWith("gpt-")));
  });

  test("Berget down + no secondary keys → the failure propagates", async () => {
    await assert.rejects(listChatModels({ BERGET_URL: deadBerget }));
  });
});
