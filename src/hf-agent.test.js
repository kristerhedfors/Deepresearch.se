// (no @ts-check: node:test / node:assert have no type declarations in this
// repo — tsconfig's types is workers-only and @types/node would be a new
// dependency.)
// Unit tests for the Hugging Face agent (src/hf-agent.js): the model-shopping
// gate, the ranking query it derives, and the priced catalog block.
//
// The gate is a deterministic regex (invariant 1 — no model decides whether the
// catalog is folded in), and it routes Swedish and English with the same breadth
// (invariant 6). The "Swedish language parity" suite below follows the
// enforcement pattern src/googlemaps.test.js established.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { hfCatalogBlock, hfModelIntent, hfModelQuery } from "./hf-agent.js";

describe("hfModelIntent", () => {
  test("fires on choosing / pricing / starting a model", () => {
    for (const q of [
      "which model should I use for swedish text?",
      "what does the cheapest vision model cost?",
      "compare the llama and qwen models on price",
      "can I run a bigger model here?",
      "recommend an LLM with a large context window",
      "enable a model that supports tools",
    ]) {
      assert.equal(hfModelIntent(q), true, q);
    }
  });

  test("stays silent on the rest of the mode's traffic", () => {
    // Half the questions in this mode mention models without asking to pick
    // one. A priced catalog block on every turn would crowd out the research.
    for (const q of [
      "how does the transformer architecture handle long contexts?",
      "what happened with the Bonsai 1-bit models this month?",
      "summarise the Qwen3 technical report",
      "who maintains the datasets behind FineWeb?",
      "what is a checkpoint, in training terms?",
      "",
    ]) {
      assert.equal(hfModelIntent(q), false, q);
    }
    assert.equal(hfModelIntent(undefined), false);
    assert.equal(hfModelIntent(42), false);
  });
});

describe("Swedish language parity", () => {
  // Every Swedish phrasing here has an English twin above; both must gate the
  // same way, and this is the suite that fails if a future widening adds one
  // language only.
  test("Swedish model-shopping asks fire exactly like their English twins", () => {
    for (const q of [
      "vilken modell ska jag köra för svensk text?",
      "vad kostar den billigaste modellen?",
      "jämför modellerna på pris",
      "kan jag starta en större språkmodell här?",
      "rekommendera en modell med stort kontextfönster",
      "aktivera en modell som stödjer verktyg",
      "vilka modeller är tillgängliga och vad är prislappen?",
    ]) {
      assert.equal(hfModelIntent(q), true, q);
    }
  });

  test("Swedish research questions about models stay silent, like their English twins", () => {
    for (const q of [
      "hur hanterar transformerarkitekturen långa kontexter?",
      "vad hände med bonsai-modellerna den här månaden?",
      "sammanfatta den tekniska rapporten",
    ]) {
      assert.equal(hfModelIntent(q), false, q);
    }
  });
});

describe("hfModelQuery", () => {
  test("strips the shopping vocabulary so the ranking sees the domain terms", () => {
    // "which cheap swedish model should I use" must rank on "swedish", not on
    // "cheap" and "use" — those are how the question was asked, not what it was
    // asked about.
    assert.equal(hfModelQuery("which cheap swedish model should I use"), "swedish");
    assert.equal(hfModelQuery("vilken billig svensk modell ska jag köra"), "svensk");
    // "vision" is kept: it is a capability the catalog can actually be ranked
    // on, unlike "cheapest"/"cost", which describe the asking rather than the
    // model.
    assert.equal(hfModelQuery("what does the cheapest qwen vision model cost"), "qwen vision");
  });

  test("a question with nothing but shopping words ranks on nothing (cheapest-first)", () => {
    assert.equal(hfModelQuery("which model is cheapest?"), "");
  });
});

describe("hfCatalogBlock", () => {
  const allowance = { maxOutputUsd: 3, maxAccepted: 6 };
  /** @type {any} */
  const row = {
    hfId: "meta-llama/Llama-3.1-8B-Instruct",
    provider: "nebius",
    context: 131072,
    usd_in: 0.02,
    usd_out: 0.06,
    turn_eur: 0.00028,
    vision: false,
    tools: false,
    accepted: false,
    allowed: true,
    reason: null,
  };

  test("quotes the real rates and names the allowance", () => {
    const block = hfCatalogBlock([row], [], allowance);
    assert.match(block, /meta-llama\/Llama-3\.1-8B-Instruct/);
    assert.match(block, /\$0\.02 in \/ \$0\.06 out per 1M tokens/);
    assert.match(block, /131k context/);
    assert.match(block, /up to \$3 per 1M output tokens, 6 models enabled at once/);
    assert.match(block, /Already enabled for this account: none yet/);
  });

  test("marks what is already enabled and what cannot be", () => {
    const blocked = { ...row, hfId: "big/Model", allowed: false, reason: "Above your model allowance." };
    const block = hfCatalogBlock(
      [{ ...row, accepted: true }, blocked],
      /** @type {any} */ ([{ hfId: "meta-llama/Llama-3.1-8B-Instruct" }]),
      allowance,
    );
    assert.match(block, /ALREADY ENABLED/);
    assert.match(block, /NOT ENABLEABLE: Above your model allowance\./);
    assert.match(block, /Already enabled for this account: meta-llama\/Llama-3\.1-8B-Instruct/);
  });

  test("tells the model that enabling is the USER's action, and what it means", () => {
    // The one thing the answer must not do is claim to have enabled something,
    // and the one thing it must say is that enabling reaches every mode.
    const block = hfCatalogBlock([row], [], allowance);
    assert.match(block, /Enabling a model is the user's action, not yours/);
    assert.match(block, /selectable in every chat mode/);
  });

  test("no rows means no block at all — never an empty heading", () => {
    assert.equal(hfCatalogBlock([], [], allowance), "");
  });
});
