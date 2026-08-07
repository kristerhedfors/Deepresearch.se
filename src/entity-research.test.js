// Unit tests for the entity-research enrichment runner (src/entity-research.js).
//
// The core's own suite (public/js/entity-research-core.test.js) owns the gate
// and the block's content. What is pinned here is the ENRICHMENT CONTRACT
// src/enrichment.js states: silent — no step, no state, no conversation change
// — when the message is not a dossier request; a visible step and an appended
// block when it fires; the report tier read from the plan the user's
// research-time slider produced; and never a throw, whatever it is handed.
//
// Deliberately NOT `// @ts-check`: the fail-soft cases feed malformed ctx
// shapes (a missing state bag, a null conversation, a plan that is not an
// object) that strict types would reject by design.

import assert from "node:assert/strict";
import test, { describe } from "node:test";

import {
  ENTITY_RESEARCH_ID,
  entityResearchBlock,
  runEntityResearchEnrichment,
} from "./entity-research.js";

const FIRES = "Osint on revsec"; // the verbatim message from feedback #64
const QUIET = "write a report about Tesla battery technology";

/** Runs the enrichment over a one-message conversation, recording the steps. */
async function run(text, opts = {}) {
  const steps = [];
  const logs = [];
  const state = opts.state === undefined ? {} : opts.state;
  const conversation =
    opts.conversation !== undefined ? opts.conversation : [{ role: "user", content: text }];
  const out = await runEntityResearchEnrichment({
    env: {},
    log: { info: (e, m) => logs.push([e, m]), warn() {}, error() {}, debug() {} },
    emit() {},
    step: (id, label) => steps.push(["start", id, label]),
    stepDone: (id, label, details) => steps.push(["done", id, label, details]),
    conversation,
    state,
    ...opts.ctx,
  });
  return { out, steps, logs, state, conversation };
}

/** The text of the last message, however its content is shaped. */
const lastText = (convo) => {
  const c = convo[convo.length - 1].content;
  return typeof c === "string"
    ? c
    : c
        .filter((p) => p.type === "text")
        .map((p) => p.text)
        .join("\n");
};

// ---- the silent path --------------------------------------------------------

describe("silent when the message is not a dossier request", () => {
  test("the conversation comes back UNCHANGED — the same array reference", async () => {
    const { out, conversation } = await run(QUIET);
    assert.equal(out, conversation);
    assert.equal(lastText(out), QUIET);
  });

  test("no step is emitted, so the user sees nothing happen", async () => {
    const { steps } = await run(QUIET);
    assert.deepEqual(steps, []);
  });

  test("no state is written", async () => {
    const { state } = await run(QUIET);
    assert.deepEqual(state, {});
  });

  test("nothing is logged", async () => {
    const { logs } = await run(QUIET);
    assert.deepEqual(logs, []);
  });
});

// ---- the firing path --------------------------------------------------------

describe("fires on an OSINT-class request", () => {
  test("the block is appended to the last user message", async () => {
    const { out, conversation } = await run(FIRES);
    assert.notEqual(out, conversation); // a new array, not a mutation
    const text = lastText(out);
    assert.ok(text.startsWith(FIRES), "the user's own words must come first");
    assert.ok(text.includes("SUBJECT RESOLUTION"), "the rule must be appended");
  });

  test("the step is emitted under the registry's id", async () => {
    const { steps } = await run(FIRES);
    assert.equal(steps.length, 2);
    assert.equal(steps[0][1], ENTITY_RESEARCH_ID);
    assert.equal(steps[1][1], ENTITY_RESEARCH_ID);
    assert.equal(steps[1][0], "done");
  });

  // The step's details are what a user reads to see what the turn is doing, so
  // the tier is named there — the whole second half of the feedback is that the
  // report should be a different size at a different setting, and an invisible
  // size is one nobody can tell went wrong.
  test("the finished step names the report depth", async () => {
    const { steps } = await run(FIRES, { state: { plan: { reportTier: "full" } } });
    assert.deepEqual(steps[1][3], [
      "Resolve the subject before profiling it; ask which entity when the name carries more than one",
      "Report depth: full",
    ]);
  });

  test("counters are recorded, and they carry no subject", async () => {
    const { state, logs } = await run(FIRES, { state: { plan: { reportTier: "extended" } } });
    assert.equal(state.entityResearch.applied, true);
    assert.equal(state.entityResearch.tier, "extended");
    assert.ok(state.entityResearch.words > 0);
    assert.equal(logs[0][0], "entity_research.applied");
    assert.deepEqual(Object.keys(logs[0][1]).sort(), ["tier", "words"]);
    // The message never reaches the log — not the name, not the question.
    assert.equal(JSON.stringify(logs).toLowerCase().includes("revsec"), false);
  });
});

// ---- the tier ---------------------------------------------------------------

describe("the report tier comes from the plan the research-time slider built", () => {
  for (const tier of ["brief", "standard", "extended", "full"]) {
    test(`a ${tier} plan appends the ${tier} scaffold`, async () => {
      const { out } = await run(FIRES, { state: { plan: { reportTier: tier } } });
      assert.ok(lastText(out).includes(entityResearchBlock(tier)));
    });
  }

  // The plan exists before enrichments run, so an absent one means a caller
  // that never built one (a test, an MCP-shaped state) rather than a bug —
  // "standard" is the same fallback every other reportTier consumer uses.
  test("an absent, empty or malformed plan falls back to standard", async () => {
    for (const state of [{}, { plan: null }, { plan: {} }, { plan: "full" }, { plan: { reportTier: "bogus" } }]) {
      const { out } = await run(FIRES, { state });
      assert.ok(
        lastText(out).includes(entityResearchBlock("standard")),
        `plan ${JSON.stringify(state.plan)} must fall back to standard`,
      );
    }
  });
});

// ---- fail-soft --------------------------------------------------------------

describe("never breaks the request (invariant 2)", () => {
  test("a malformed or empty conversation comes back unchanged", async () => {
    // `undefined` cannot travel through the helper (it means "use the default"),
    // so it and a wholly absent ctx are checked against the runner directly.
    for (const conversation of [[], null, "not an array", {}]) {
      const { out } = await run(FIRES, { conversation });
      assert.equal(out, conversation);
    }
    assert.equal(await runEntityResearchEnrichment({ conversation: undefined }), undefined);
    assert.equal(await runEntityResearchEnrichment({}), undefined);
    assert.equal(await runEntityResearchEnrichment(null), undefined);
  });

  test("a message with no readable text is not a dossier request", async () => {
    const conversation = [{ role: "user", content: [{ type: "image_url", image_url: { url: "x" } }] }];
    const { out, steps } = await run(FIRES, { conversation });
    assert.equal(out, conversation);
    assert.deepEqual(steps, []);
  });

  test("a missing step helper does not stop the block being appended", async () => {
    const out = await runEntityResearchEnrichment({
      env: {},
      log: {},
      conversation: [{ role: "user", content: FIRES }],
      state: {},
    });
    assert.ok(lastText(out).includes("SUBJECT RESOLUTION"));
  });

  test("a state bag that cannot be written still yields the block", async () => {
    const frozen = Object.freeze({ plan: { reportTier: "full" } });
    const { out } = await run(FIRES, { state: frozen });
    assert.ok(lastText(out).includes(entityResearchBlock("full")));
  });

  // The same property person-research has: no fetch to stub, because there is
  // nothing outside this deployment to reach.
  test("the runner makes no outbound request (nothing to mock, by design)", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = () => {
      throw new Error("the entity-research enrichment must not reach the network");
    };
    try {
      await run(FIRES);
    } finally {
      globalThis.fetch = original;
    }
  });
});

// ---- the gate must not be led by the pipeline's own prose -------------------

// The bug class this repo has now seen three times (the quiz gate, chat_logs
// #360; externalSourceIntent; the aux-source routing of feedback #61): a
// deterministic gate reads a message an enrichment has already written into,
// and matches the pipeline's own writing. This runner is LAST in the registry,
// so on a person-shaped turn it reads the message with person research's ~875
// words already appended — and that block is about OSINT method, which is
// exactly the vocabulary this gate looks for.
test("person research's own block does not trigger this gate", async () => {
  const { personResearchBlock } = await import("./person-research.js");
  const block = personResearchBlock();
  // Directly: the block alone is not a dossier request.
  const { entityResearchIntent } = await import("./entity-research.js");
  assert.equal(entityResearchIntent(block), false);
  // And in the position it is actually read from — appended to a person
  // question that is NOT itself an OSINT-class request.
  const { steps } = await run(FIRES, {
    conversation: [{ role: "user", content: `Write a report about what you can find on this founder\n\n${block}` }],
  });
  assert.deepEqual(steps, [], "the gate matched the pipeline's own prose");
});

// ---- the multipart contract -------------------------------------------------

test("an attached image survives the append (a new text part, not a rewrite)", async () => {
  const conversation = [
    {
      role: "user",
      content: [
        { type: "text", text: FIRES },
        { type: "image_url", image_url: { url: "data:image/png;base64,AAA" } },
      ],
    },
  ];
  const { out } = await run(FIRES, { conversation });
  const parts = out[out.length - 1].content;
  assert.equal(parts.filter((p) => p.type === "image_url").length, 1);
  assert.ok(parts.some((p) => p.type === "text" && p.text.includes("SUBJECT RESOLUTION")));
});
