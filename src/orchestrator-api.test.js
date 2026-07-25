// Unit tests for the pre-chat plan endpoint's pure seam
// (src/orchestrator-api.js). The handler itself is exercised live (it needs
// D1, the quota tables and a real Berget call — the live-verify discipline);
// what is testable here is the untrusted client descriptor that decides
// whether a plan may use the `swarm` kind at all.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { normalizeSwarmCapability } from "./orchestrator-api.js";

describe("normalizeSwarmCapability", () => {
  test("no descriptor, or one without a model, means no swarm", () => {
    assert.equal(normalizeSwarmCapability(undefined), null);
    assert.equal(normalizeSwarmCapability(null), null);
    assert.equal(normalizeSwarmCapability("yes"), null);
    assert.equal(normalizeSwarmCapability({}), null);
    assert.equal(normalizeSwarmCapability({ available: true }), null, "a claim without a model is not a capability");
    assert.equal(normalizeSwarmCapability({ available: false, modelId: "bonsai-1_7b-1bit" }), null);
  });

  test("keeps the model id and label, bounded", () => {
    assert.deepEqual(normalizeSwarmCapability({ available: true, modelId: "bonsai-1_7b-1bit", modelLabel: "Bonsai 1.7B · 1-bit" }), {
      modelId: "bonsai-1_7b-1bit",
      modelLabel: "Bonsai 1.7B · 1-bit",
    });
    // The label is display text in a prompt — it falls back to the id and can
    // never grow the prompt without bound.
    assert.equal(normalizeSwarmCapability({ modelId: "m" }).modelLabel, "m");
    const long = normalizeSwarmCapability({ modelId: "m".repeat(500), modelLabel: "L".repeat(500) });
    assert.ok(long.modelId.length <= 60 && long.modelLabel.length <= 60);
  });

  test("carries nothing else — member counts are the DEVICE's call, not the client's claim", () => {
    const cap = normalizeSwarmCapability({ modelId: "m", members: 999, maxWorkers: 999, admin: true });
    assert.deepEqual(Object.keys(cap).sort(), ["modelId", "modelLabel"]);
  });
});
