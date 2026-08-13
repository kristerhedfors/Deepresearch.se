// Unit tests for the person-research enrichment runner (src/person-research.js).
//
// The core's own suite (public/js/person-research-core.test.js) owns the gate
// and the block's content. What is pinned here is the ENRICHMENT CONTRACT
// src/enrichment.js states: silent — no step, no state, no conversation change
// — when the message names nobody to research; a visible step and an appended
// block when it fires; and never a throw, whatever it is handed.
//
// Deliberately NOT `// @ts-check`: the fail-soft cases feed malformed ctx
// shapes (a missing state bag, a null conversation, a message with no content)
// that strict types would reject by design.

import assert from "node:assert/strict";
import test, { describe } from "node:test";

import {
  PERSON_METHOD_CONTEXT,
  PERSON_RESEARCH_ID,
  personGuardrailsBlock,
  personResearchBlock,
  runPersonResearchEnrichment,
} from "./person-research.js";

const FIRES = "Write a report about what you can find on this founder";
const QUIET = "write a report about Tesla battery technology";

// The Cyber agent's declaration — the only agent that gets the OSINT tradecraft
// half of the block (owner directive, 2026-08-13). Every OTHER agent, and every
// caller with no resolved agent at all, gets the privacy rail alone; that is
// the default `run()` below uses, because it is the common case.
const CYBER = { capability: { context: [PERSON_METHOD_CONTEXT] } };

/** Runs the enrichment over a one-message conversation, recording the steps. */
async function run(text, opts = {}) {
  const steps = [];
  const logs = [];
  const state = opts.state === undefined ? {} : opts.state;
  const conversation = opts.conversation !== undefined
    ? opts.conversation
    : [{ role: "user", content: text }];
  const out = await runPersonResearchEnrichment({
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
  return typeof c === "string" ? c : c.filter((p) => p.type === "text").map((p) => p.text).join("\n");
};

// ---- the silent path --------------------------------------------------------

describe("silent when the message names nobody to research", () => {
  test("the conversation comes back UNCHANGED — the same array reference", async () => {
    const { out, conversation } = await run(QUIET);
    assert.equal(out, conversation);
    assert.equal(lastText(out), QUIET);
  });

  test("no step is emitted", async () => {
    const { steps } = await run(QUIET);
    assert.deepEqual(steps, []);
  });

  test("no state is written and nothing is logged", async () => {
    const { state, logs } = await run(QUIET);
    assert.deepEqual(state, {});
    assert.deepEqual(logs, []);
  });

  test("an empty message is silent", async () => {
    const { out, steps, conversation } = await run("");
    assert.equal(out, conversation);
    assert.deepEqual(steps, []);
  });

  test("a Swedish topic question is silent too (invariant 6 both ways)", async () => {
    const { out, steps, conversation } = await run("skriv en rapport om elbilsmarknaden");
    assert.equal(out, conversation);
    assert.deepEqual(steps, []);
  });
});

// ---- the firing path --------------------------------------------------------

describe("fires on a person-research request", () => {
  test("the block is appended to the LAST user message", async () => {
    const { out } = await run(FIRES, { state: { ...CYBER } });
    assert.equal(out.length, 1);
    assert.ok(lastText(out).startsWith(FIRES));
    assert.ok(lastText(out).includes(personResearchBlock()));
  });

  test("the original conversation is not mutated", async () => {
    const { out, conversation } = await run(FIRES);
    assert.notEqual(out, conversation);
    assert.equal(conversation[0].content, FIRES);
  });

  test("earlier turns are carried through untouched", async () => {
    const convo = [
      { role: "user", content: "hej" },
      { role: "assistant", content: "hej!" },
      { role: "user", content: FIRES },
    ];
    const { out } = await run(null, { conversation: convo, state: { ...CYBER } });
    assert.equal(out.length, 3);
    assert.equal(out[0], convo[0]);
    assert.equal(out[1], convo[1]);
    assert.ok(lastText(out).includes("SOURCE LADDER"));
  });

  test("a start and a done step are emitted under the shared id", async () => {
    const { steps } = await run(FIRES, { state: { ...CYBER } });
    assert.equal(steps.length, 2);
    assert.equal(steps[0][0], "start");
    assert.equal(steps[0][1], PERSON_RESEARCH_ID);
    assert.match(steps[0][2], /person-research method/i);
    assert.equal(steps[1][0], "done");
    assert.equal(steps[1][1], PERSON_RESEARCH_ID);
  });

  test("state records that the method was applied — and nothing about the subject", async () => {
    const { state } = await run(FIRES, { state: { ...CYBER } });
    assert.equal(state.personResearch.applied, true);
    assert.equal(state.personResearch.method, true);
    assert.ok(state.personResearch.words > 100);
    assert.ok(!JSON.stringify(state).includes("founder"));
  });

  test("the log line carries counters only, never the question", async () => {
    const { logs } = await run(FIRES, { state: { ...CYBER } });
    assert.equal(logs.length, 1);
    assert.equal(logs[0][0], "person_research.applied");
    assert.deepEqual(Object.keys(logs[0][1]), ["method", "words"]);
  });

  test("a multipart message keeps its image and gains a NEW text part", async () => {
    // The reported turn was a LinkedIn SCREENSHOT plus one sentence: the
    // attachment has to survive the append, or the vision phase reads nothing.
    const convo = [{
      role: "user",
      content: [
        { type: "text", text: FIRES },
        { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
      ],
    }];
    const { out } = await run(null, { conversation: convo });
    const parts = out[0].content;
    assert.equal(parts.length, 3);
    assert.equal(parts[1].type, "image_url");
    assert.equal(parts[2].type, "text");
    assert.ok(parts[2].text.includes("USING THIS BLOCK:"));
  });

  test("the Swedish equivalent fires the same way", async () => {
    const { out, steps } = await run("Skriv en rapport om vad du kan hitta om den här grundaren", {
      state: { ...CYBER },
    });
    assert.equal(steps.length, 2);
    assert.ok(lastText(out).includes("PERSON RESEARCH METHOD"));
  });
});

// ---- the split: a privacy RAIL and a domain CAPABILITY (2026-08-13) ---------
//
// The owner directive of 2026-08-13 gives OSINT to the Cyber agent, and this
// runner is where the person half of that lands. What it must NOT do is take
// the privacy rail with it: the gate is personResearchIntent, which fires on
// every agent, so an agent without the declaration would be answering "who is
// this founder" with no limits on reporting the subject's health, ethnicity,
// personnummer or home address. Invariant 4 makes that unacceptable, so the
// capability narrows the tradecraft and never the rail.

describe("the capability picks WHICH HALF of the block applies", () => {
  /** The prohibitions that must survive on every agent, verbatim from the rail. */
  const RAIL = [
    /public professional information only/,
    /national identity number \(personnummer, SSN\)/,
    /ethnicity, health, religion, politics, sexuality/,
    /ASSEMBLING facts whose combination would disclose one/,
    /de-anonymisation of a pseudonymous account/,
    /face matching or reverse image search/,
    /no contact with the subject or their colleagues under any pretext/,
    /a founder is not automatically a public figure/,
  ];
  /** The tradecraft that must NOT appear without the declaration. */
  const METHOD = [/PLAN\./, /SOURCE LADDER/, /LADDER RULE/, /VERIFY\./, /WRITE IT UP\./];

  test("an agent declaring person-method gets the FULL protocol", async () => {
    const { out } = await run(FIRES, { state: { ...CYBER } });
    const text = lastText(out);
    assert.equal(text.includes(personResearchBlock()), true);
    for (const re of [...RAIL, ...METHOD]) assert.match(text, re);
  });

  test("every other agent gets the privacy rail — and only the rail", async () => {
    for (const capability of [undefined, null, {}, { context: [] }, { context: ["owasp", "host-intel"] }]) {
      const { out } = await run(FIRES, { state: { capability } });
      const text = lastText(out);
      assert.equal(text.includes(personGuardrailsBlock()), true, JSON.stringify(capability));
      for (const re of RAIL) assert.match(text, re, JSON.stringify(capability));
      for (const re of METHOD) assert.doesNotMatch(text, re, JSON.stringify(capability));
    }
  });

  test("the rail-only block is self-explaining, not a fragment", async () => {
    // It is appended to a conversation on its own, so it carries its own
    // heading and the house "USING THIS BLOCK" tail — without them a model
    // reading a bare paragraph of prohibitions quotes them at the user.
    const block = personGuardrailsBlock();
    assert.match(block, /^PERSON RESEARCH LIMITS/);
    assert.match(block, /USING THIS BLOCK:/);
    assert.ok(block.trim().endsWith("let the report show the difference."));
    // And it is a strict SUBSET of the full block's substance: the rail is
    // shared text, never a second copy that could drift.
    assert.ok(personResearchBlock().includes(block.split("\n").find((l) => l.startsWith("GUARDRAILS"))));
  });

  test("the activity step and the counters say which half applied", async () => {
    // The only place a user can see that the report they are about to read was
    // written without the source ladder.
    const full = await run(FIRES, { state: { ...CYBER } });
    assert.match(full.steps[0][2], /person-research method/i);
    assert.match(full.steps[1][2], /method applied/i);
    assert.equal(full.state.personResearch.method, true);

    const rail = await run(FIRES);
    assert.match(rail.steps[0][2], /person-research limits/i);
    assert.match(rail.steps[1][2], /limits applied/i);
    assert.equal(rail.state.personResearch.method, false);
    assert.ok(rail.state.personResearch.words < full.state.personResearch.words);
    // Still nothing about the subject in either.
    assert.ok(!JSON.stringify(rail.state).includes("founder"));
  });

  test("a junk capability degrades to the rail rather than throwing", async () => {
    // The narrowing direction (invariant 2): anything that is not an explicit
    // declaration is treated as absent.
    for (const capability of [42, "person-method", { context: "person-method" }, { context: [42] }]) {
      const { out, steps } = await run(FIRES, { state: { capability } });
      assert.equal(steps.length, 2);
      assert.ok(lastText(out).includes(personGuardrailsBlock()), JSON.stringify(capability));
    }
  });
});

// ---- fail-soft --------------------------------------------------------------

describe("never throws, whatever it is handed", () => {
  const CASES = {
    "a null conversation": { conversation: null },
    "an empty conversation": { conversation: [] },
    "a conversation of nulls": { conversation: [null, null] },
    "a message with no content": { conversation: [{ role: "user" }] },
    "content of the wrong type": { conversation: [{ role: "user", content: 42 }] },
    "an assistant-only conversation": { conversation: [{ role: "assistant", content: FIRES }] },
  };

  for (const [name, opts] of Object.entries(CASES)) {
    test(name, async () => {
      const { out } = await run(null, opts);
      assert.ok(out === opts.conversation || Array.isArray(out));
    });
  }

  test("no state bag: the block is still appended", async () => {
    // No state means no capability, so it is the privacy RAIL that lands —
    // which is the right way round: the half a caller gets when the platform
    // knows nothing about it is the half that limits the answer.
    const { out } = await run(FIRES, { state: null });
    assert.ok(lastText(out).includes("public professional information only"));
  });

  test("a frozen state bag: the block is still appended", async () => {
    // The counters are a WRITE to request state; module scope is strict, so a
    // frozen bag throws on the assignment. The block must survive it.
    const { out } = await run(FIRES, { state: Object.freeze({ ...CYBER }) });
    assert.ok(lastText(out).includes("LADDER RULE"));
  });

  test("no step or log helpers: the block is still appended", async () => {
    const out = await runPersonResearchEnrichment({
      conversation: [{ role: "user", content: FIRES }],
      state: {},
    });
    assert.ok(lastText(out).includes("GUARDRAILS"));
  });

  test("the runner makes no outbound request (nothing to mock, by design)", async () => {
    const real = globalThis.fetch;
    globalThis.fetch = () => {
      throw new Error("the person-research enrichment must never reach the network");
    };
    try {
      const { out } = await run(FIRES, { state: { ...CYBER } });
      assert.ok(lastText(out).includes("PERSON RESEARCH METHOD"));
    } finally {
      globalThis.fetch = real;
    }
  });
});
