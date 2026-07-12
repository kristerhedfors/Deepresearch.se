// Unit tests for model-routing.js — the shared split-model-routing decision
// (JSON planning phases run on the fixed reliable model). chat.js and mcp.js
// both delegate here; chat.test.js additionally covers chat.js's 2-arg wrapper.
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { resolveJsonModel } from "./model-routing.js";

const DEF = "mistralai/Mistral-Small";

describe("resolveJsonModel", () => {
  test("routes any other answer model to the default JSON model", () => {
    const catalog = [{ id: "some/model", up: true }, { id: DEF, up: true }];
    assert.equal(resolveJsonModel(catalog, "some/model", DEF), DEF);
  });

  test("no-ops when the answer model already IS the default JSON model", () => {
    assert.equal(resolveJsonModel(null, DEF, DEF), DEF);
  });

  test("stays optimistic (default) when the catalog is unavailable", () => {
    assert.equal(resolveJsonModel(null, "some/model", DEF), DEF);
    assert.equal(resolveJsonModel(undefined, "some/model", DEF), DEF);
  });

  test("falls back to the user's model when the default is explicitly down", () => {
    const catalog = [{ id: "some/model", up: true }, { id: DEF, up: false }];
    assert.equal(resolveJsonModel(catalog, "some/model", DEF), "some/model");
  });

  test("falls back to the user's model when the deployment doesn't offer the default", () => {
    const catalog = [{ id: "some/model", up: true }];
    assert.equal(resolveJsonModel(catalog, "some/model", DEF), "some/model");
  });
});
