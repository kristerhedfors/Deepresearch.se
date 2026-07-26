// (no @ts-check: node:test / node:assert have no type declarations in this
// repo — tsconfig's types is workers-only and @types/node would be a new
// dependency.)
// Unit tests for the Hugging Face INFERENCE provider (src/hf-inference.js) —
// the id namespace, the catalog normalization, the ranking, and the allowance.
//
// The fixture rows are trimmed copies of what GET https://router.huggingface.co
// /v1/models actually returned on 2026-07-26 (see the module header), so the
// shapes exercised here are the shapes production sees rather than shapes
// invented to make an assertion pass.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_ALLOWANCE,
  hfAllowance,
  hfBrowseItem,
  hfInferenceConfigured,
  hfInferenceModels,
  hfModelId,
  hfRankModels,
  hfWireModel,
  isHfModel,
  normalizeRouterModel,
  parseHfModelId,
  toHfPayload,
  turnCostEur,
  TYPICAL_TURN,
} from "./hf-inference.js";

const RAW_INKLING = {
  id: "thinkingmachines/Inkling",
  owned_by: "thinkingmachines",
  architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] },
  providers: [
    { provider: "together", status: "live", context_length: 524288, pricing: { input: 1, output: 4.05 }, is_free: false, supports_tools: true, supports_structured_output: true },
    { provider: "deepinfra", status: "live", context_length: 524288, pricing: { input: 0.9, output: 3.5 }, is_free: false, supports_tools: true, supports_structured_output: false },
  ],
};
const RAW_UNPRICED = {
  id: "zai-org/GLM-4.5",
  owned_by: "zai-org",
  architecture: { input_modalities: ["text"] },
  providers: [{ provider: "novita", status: "live", context_length: 128000 }],
};
const RAW_CHEAP = {
  id: "meta-llama/Llama-3.1-8B-Instruct",
  owned_by: "meta-llama",
  architecture: { input_modalities: ["text"] },
  providers: [{ provider: "nebius", status: "live", context_length: 131072, pricing: { input: 0.02, output: 0.06 }, supports_tools: false }],
};

describe("the id namespace", () => {
  test("hf: is the routing prefix, and a bare owner/model path is NOT one", () => {
    // The prefix is load-bearing, not cosmetic: Berget ids are bare
    // vendor/model paths, so an unprefixed HF id would route to Berget.
    assert.equal(isHfModel("hf:meta-llama/Llama-3.1-8B-Instruct"), true);
    assert.equal(isHfModel("meta-llama/Llama-3.1-8B-Instruct"), false);
    assert.equal(isHfModel("mistralai/Mistral-Small-3.2-24B-Instruct-2506"), false);
    assert.equal(isHfModel("claude-opus-5"), false);
    assert.equal(isHfModel(undefined), false);
  });

  test("hfModelId refuses anything that is not an owner/model path", () => {
    assert.equal(hfModelId("meta-llama/Llama-3.1-8B-Instruct"), "hf:meta-llama/Llama-3.1-8B-Instruct");
    assert.equal(hfModelId("meta-llama/Llama-3.1-8B-Instruct", "together"), "hf:meta-llama/Llama-3.1-8B-Instruct@together");
    assert.equal(hfModelId("no-slash"), null);
    assert.equal(hfModelId("a/b/c"), null);
    assert.equal(hfModelId("../../etc/passwd"), null);
    assert.equal(hfModelId("owner/model", "not a provider"), null);
  });

  test("parse and wire round-trip, pinned provider included", () => {
    assert.deepEqual(parseHfModelId("hf:owner/model"), { hfId: "owner/model", provider: null });
    assert.deepEqual(parseHfModelId("hf:owner/model@together"), { hfId: "owner/model", provider: "together" });
    assert.equal(parseHfModelId("owner/model"), null);
    // The router's own pinning syntax is `owner/model:provider`.
    assert.equal(hfWireModel("hf:owner/model"), "owner/model");
    assert.equal(hfWireModel("hf:owner/model@together"), "owner/model:together");
  });
});

describe("catalog normalization", () => {
  test("the cheapest LIVE priced serving becomes `best`", () => {
    const m = normalizeRouterModel(RAW_INKLING);
    assert.ok(m);
    assert.equal(m.best?.provider, "deepinfra"); // 3.5 out beats together's 4.05
    assert.equal(m.priced, true);
    assert.equal(m.vision, true); // image is an input modality
    assert.equal(m.contextLength, 524288);
    assert.equal(m.url, "https://huggingface.co/thinkingmachines/Inkling");
  });

  test("a model nobody prices normalizes with best = null", () => {
    const m = normalizeRouterModel(RAW_UNPRICED);
    assert.ok(m);
    assert.equal(m.best, null);
    assert.equal(m.priced, false);
    // …but it still carries its context length off the unpriced serving, so the
    // card can say something useful about a model it cannot enable.
    assert.equal(m.contextLength, 128000);
  });

  test("a row with no usable id is dropped, not thrown over", () => {
    assert.equal(normalizeRouterModel({ id: "nope" }), null);
    assert.equal(normalizeRouterModel({}), null);
    assert.equal(normalizeRouterModel(null), null);
  });
});

describe("ranking", () => {
  const catalog = [RAW_INKLING, RAW_UNPRICED, RAW_CHEAP].map(normalizeRouterModel).filter(Boolean);

  test("an empty query orders cheapest-first", () => {
    // The picker exists to make cost legible, so "no query" means "show me the
    // cheap end", and the unpriced model sorts last rather than first.
    const ids = hfRankModels(/** @type {any} */ (catalog), "").map((m) => m.hfId);
    assert.deepEqual(ids, ["meta-llama/Llama-3.1-8B-Instruct", "thinkingmachines/Inkling", "zai-org/GLM-4.5"]);
  });

  test("a query matches the repo name and drops non-matches", () => {
    const ids = hfRankModels(/** @type {any} */ (catalog), "llama").map((m) => m.hfId);
    assert.deepEqual(ids, ["meta-llama/Llama-3.1-8B-Instruct"]);
    assert.deepEqual(hfRankModels(/** @type {any} */ (catalog), "nothingmatches"), []);
  });
});

describe("the model allowance", () => {
  test("defaults apply with no config, and admin values extend them", () => {
    assert.deepEqual(hfAllowance(undefined), DEFAULT_ALLOWANCE);
    assert.deepEqual(hfAllowance({ hf: { max_output_usd: 12, max_accepted: 20 } }), {
      maxOutputUsd: 12,
      maxAccepted: 20,
    });
    // Junk falls back rather than uncapping by accident.
    assert.deepEqual(hfAllowance({ hf: { max_output_usd: "lots", max_accepted: 1.5 } }), DEFAULT_ALLOWANCE);
  });

  test("an unpriced model is never enableable — an unknown rate cannot be budgeted", () => {
    const m = normalizeRouterModel(RAW_UNPRICED);
    const row = hfBrowseItem(/** @type {any} */ (m), { allowance: DEFAULT_ALLOWANCE });
    assert.equal(row.allowed, false);
    assert.match(String(row.reason), /can't be budgeted/);
    assert.equal(row.turn_eur, null);
    assert.equal(row.pricing, null);
  });

  test("a model above the output ceiling is blocked, with the ceiling named", () => {
    const m = normalizeRouterModel(RAW_INKLING);
    const row = hfBrowseItem(/** @type {any} */ (m), { allowance: { maxOutputUsd: 1, maxAccepted: 6 } });
    assert.equal(row.allowed, false);
    assert.match(String(row.reason), /\$1\.00 per 1M output tokens/);
  });

  test("a full allowance blocks a NEW model but never an already-enabled one", () => {
    const m = normalizeRouterModel(RAW_CHEAP);
    const allowance = { maxOutputUsd: 3, maxAccepted: 2 };
    const blocked = hfBrowseItem(/** @type {any} */ (m), { allowance, acceptedCount: 2 });
    assert.equal(blocked.allowed, false);
    assert.match(String(blocked.reason), /Remove one/);
    // Already enabled: the card must stay actionable so it can be REMOVED.
    const already = hfBrowseItem(/** @type {any} */ (m), {
      allowance,
      acceptedCount: 2,
      acceptedIds: new Set(["meta-llama/Llama-3.1-8B-Instruct"]),
    });
    assert.equal(already.allowed, true);
    assert.equal(already.accepted, true);
  });

  test("pinning a serving prices the row against THAT provider", () => {
    const m = /** @type {any} */ (normalizeRouterModel(RAW_INKLING));
    const pinned = hfBrowseItem(m, {
      allowance: DEFAULT_ALLOWANCE,
      serving: m.servings.find((/** @type {any} */ s) => s.provider === "together"),
    });
    assert.equal(pinned.provider, "together");
    assert.equal(pinned.usd_out, 4.05);
    assert.equal(pinned.id, "hf:thinkingmachines/Inkling@together");
  });
});

describe("cost", () => {
  test("the per-turn estimate is the documented turn at the row's rates", () => {
    const m = /** @type {any} */ (normalizeRouterModel(RAW_CHEAP));
    const row = hfBrowseItem(m, { allowance: DEFAULT_ALLOWANCE });
    assert.equal(row.turn_eur, turnCostEur(row.price_in, row.price_out));
    // …and that turn is the one the UI is told about, so the label can't drift
    // away from the number.
    assert.equal(TYPICAL_TURN.prompt, 12000);
    const byHand = row.price_in * TYPICAL_TURN.prompt + row.price_out * TYPICAL_TURN.completion;
    assert.ok(Math.abs((row.turn_eur || 0) - byHand) < 1e-12);
  });

  test("catalog entries carry EUR per-token prices, so billing works unchanged", () => {
    const env = /** @type {any} */ ({ HUGGINGFACE_API_TOKEN: "hf_x" });
    const entries = hfInferenceModels(env, [
      /** @type {any} */ ({ id: "hf:a/b", hfId: "a/b", name: "b", price_in: 1e-6, price_out: 4e-6, vision: false }),
    ]);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].provider, "huggingface");
    assert.equal(entries[0].price_out, 4e-6);
    assert.equal(entries[0].up, true);
    assert.match(String(entries[0].pricing), /per 1M tokens/);
  });

  test("without the token the provider is invisible — nothing routes to it", () => {
    assert.equal(hfInferenceConfigured(/** @type {any} */ ({})), false);
    assert.deepEqual(
      hfInferenceModels(/** @type {any} */ ({}), [/** @type {any} */ ({ id: "hf:a/b", price_in: 1, price_out: 1 })]),
      [],
    );
  });
});

describe("the wire payload", () => {
  test("the hf: prefix is stripped and a pin becomes the router's suffix", () => {
    const p = /** @type {any} */ (toHfPayload([{ role: "user", content: "hi" }], { model: "hf:a/b@together", stream: true }));
    assert.equal(p.model, "a/b:together");
    assert.equal(p.stream, true);
    // Streaming usage only arrives when asked for — the same wire fact
    // src/openai.js documents.
    assert.deepEqual(p.stream_options, { include_usage: true });
    assert.equal(p.max_tokens, 4096);
  });

  test("a JSON call asks for json_object but never depends on it", () => {
    const p = /** @type {any} */ (toHfPayload([], { model: "hf:a/b", json: true }));
    assert.deepEqual(p.response_format, { type: "json_object" });
    assert.equal(p.stream, false);
  });
});
