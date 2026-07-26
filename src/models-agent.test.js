// (no @ts-check: node:test / node:assert have no type declarations in this
// repo — tsconfig's types is workers-only and @types/node would be a new
// dependency.)
// Unit tests for the Models agent (src/models-agent.js): the model-lifecycle
// gate and the ranking query it derives. The catalog block it folds in belongs
// to src/model-catalog.js and is tested there.
//
// The gate is a deterministic regex (invariant 1 — no model decides whether the
// catalog is folded in), and it routes Swedish and English with the same breadth
// (invariant 6). The "Swedish language parity" suite below follows the
// enforcement pattern src/googlemaps.test.js established.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { readFileSync } from "node:fs";

import { HUB_SEARCHES_PER_REQUEST, modelIntent, modelQuery } from "./models-agent.js";

describe("modelIntent", () => {
  test("fires on choosing / pricing / starting a model", () => {
    for (const q of [
      "which model should I use for swedish text?",
      "what does the cheapest vision model cost?",
      "compare the llama and qwen models on price",
      "can I run a bigger model here?",
      "recommend an LLM with a large context window",
      "enable a model that supports tools",
    ]) {
      assert.equal(modelIntent(q), true, q);
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
      assert.equal(modelIntent(q), false, q);
    }
    assert.equal(modelIntent(undefined), false);
    assert.equal(modelIntent(42), false);
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
      assert.equal(modelIntent(q), true, q);
    }
  });

  test("Swedish research questions about models stay silent, like their English twins", () => {
    for (const q of [
      "hur hanterar transformerarkitekturen långa kontexter?",
      "vad hände med bonsai-modellerna den här månaden?",
      "sammanfatta den tekniska rapporten",
    ]) {
      assert.equal(modelIntent(q), false, q);
    }
  });
});

describe("modelQuery", () => {
  test("strips the shopping vocabulary so the ranking sees the domain terms", () => {
    // "which cheap swedish model should I use" must rank on "swedish", not on
    // "cheap" and "use" — those are how the question was asked, not what it was
    // asked about.
    assert.equal(modelQuery("which cheap swedish model should I use"), "swedish");
    assert.equal(modelQuery("vilken billig svensk modell ska jag köra"), "svensk");
    // "vision" is kept: it is a capability the catalog can actually be ranked
    // on, unlike "cheapest"/"cost", which describe the asking rather than the
    // model.
    assert.equal(modelQuery("what does the cheapest qwen vision model cost"), "qwen vision");
  });

  test("a question with nothing but shopping words ranks on nothing (cheapest-first)", () => {
    assert.equal(modelQuery("which model is cheapest?"), "");
  });
});

describe("the lifecycle vocabulary", () => {
  test("evaluation asks fire too — the agent owns verification, not just shopping", () => {
    // The gate widened when the agent did: "has this been verified" is as much
    // a model question as "what does it cost", and the priced catalog block is
    // what answers it.
    for (const q of [
      "which models have been verified?",
      "evaluate this model against the checks",
      "test the model I just enabled",
      "how reliable is that model, has it been checked?",
      "disable the model I enabled yesterday",
    ]) {
      assert.equal(modelIntent(q), true, q);
    }
  });

  test("Swedish evaluation asks fire exactly like their English twins", () => {
    for (const q of [
      "vilka modeller är verifierade?",
      "utvärdera modellen mot kontrollerna",
      "testa modellen jag aktiverade",
      "hur tillförlitlig är den modellen, är den kontrollerad?",
      "stäng av modellen jag aktiverade igår",
    ]) {
      assert.equal(modelIntent(q), true, q);
    }
  });
});

// ---- the forced hub search (feedback #36) -----------------------------------
//
// "None of these questions resulted in hugging face being searched, which is
// weird since this is the Models agent." Two halves: the enrichment must FORCE
// the hub source on regardless of the message (that half already shipped), and
// it must lean on it harder than a mode that merely mentions the hub in
// passing. Read from the source: the enrichment's own body is a Worker call
// away from a unit test, and these are its two state declarations.

describe("the forced hub source", () => {
  const src = readFileSync(new URL("./models-agent.js", import.meta.url), "utf8");
  const enrichment = src.slice(src.indexOf("export async function runModelsAgentEnrichment"));

  test("forces the hub source on for the turn, before the intent gate", () => {
    assert.match(enrichment, /\(state\)\.forceAux = \["hf"\];/);
    // Above the modelIntent early return: EVERY turn in this mode searches the
    // hub, not just the ones asking to pick a model.
    assert.ok(
      enrichment.indexOf("forceAux") < enrichment.indexOf("if (!modelIntent(lastUser)) return conversation;"),
      "forceAux is set before the modelIntent early return",
    );
  });

  test("raises the hub's per-request search ceiling above the registry default", () => {
    assert.match(enrichment, /\(state\)\.auxMaxPerRequest = \{ hf: HUB_SEARCHES_PER_REQUEST \};/);
    assert.ok(HUB_SEARCHES_PER_REQUEST > 3, "above src/search-sources.js's maxPerRequest: 3");
    // Set beside forceAux, so the same "every turn" rule covers it.
    assert.ok(
      enrichment.indexOf("auxMaxPerRequest") < enrichment.indexOf("if (!modelIntent(lastUser)) return conversation;"),
      "the ceiling is raised before the modelIntent early return",
    );
  });
});
