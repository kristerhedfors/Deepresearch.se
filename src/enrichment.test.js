// Unit tests for the pre-pipeline enrichment RUNNER (src/enrichment.js).
//
// Each individual runner has (or is getting) its own suite. What is pinned
// HERE is the thing no other file pins: the registry itself — which
// enrichments exist, in what order they run, which piece of request state
// gates each one, and the fail-soft contract runEnrichments wraps around all
// of them (CLAUDE.md invariant 2 — helper phases degrade, they never break the
// request). Before this file, deleting an entry from CORE_ENRICHMENTS, or
// swapping two of them, or changing a gate from `state.vision` to something
// else, left the whole suite green.
//
// `ENRICHMENTS` is NOT exported and this file deliberately does not add a seam
// for it, so membership and order are observed through the two doors the
// module already has:
//
//   1. a HOSTILE CONVERSATION — a Proxy array that throws on every property
//      access. Every enabled runner touches the conversation, so every one of
//      them throws, runEnrichments catches each in turn, and the resulting
//      `<id>.enrichment_failed` warnings ARE the ordered id list. The same
//      probe doubles as the strongest possible fail-soft test, because it
//      exercises the six REAL core runners plus both real extensions.
//   2. a TRACER STATE — a Proxy whose `get` records reads. `enabled(state)` is
//      called for every entry in order, so the recorded property names are the
//      per-entry gates, in registry order.
//
// For the contract cases that need a cooperative runner (a nullish return, an
// async rejection, chaining) the test injects PROBE ENTRIES: `EXTENSIONS`
// (src/extensions.js) is a mutable exported array and `ENRICHMENTS` is built
// from it at module-evaluation time, so pushing probes and then importing
// `./enrichment.js?probe=N` yields a fresh registry instance whose first
// entries are ours. The real array is restored immediately afterwards.
//
// Deliberately NOT `// @ts-check`: the probes feed malformed shapes on purpose
// (a Proxy where a Conversation belongs, runners that resolve to null, a
// thrown non-Error) — exactly the inputs the fail-soft contract exists for.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { describe } from "node:test";

import { lastUserText, withoutMethodBlocks } from "./conversation.js";
import { runEnrichments } from "./enrichment.js";
import { entityResearchBlock } from "./entity-research.js";
import { EXTENSIONS, emptyExtensionState, extensionEnrichments } from "./extensions.js";
import { personResearchBlock } from "./person-research.js";
import { fakeLog } from "./test-helpers/env.js";
import { withFakeFetch } from "./test-helpers/fetch.js";

// The registry as it must be: both registered extensions FIRST (src/enrichment.js
// "the extensions run BEFORE the core ones so an appended source snapshot is the
// last thing added"), then the core enrichments in their documented order.
const EXPECTED_ORDER = [
  "shodan",
  "maps",
  "image_read",
  "introspect",
  "models",
  "aadr",
  "scholar",
  "person_research",
  // Last, and after person_research on purpose: on an OSINT question about a
  // named individual both fire, and the method plus its guardrails must be read
  // before the rule about resolving which subject it is (feedback #64).
  "entity_research",
];

const EXTENSION_IDS = ["shodan", "maps"];
const CORE_IDS = EXPECTED_ORDER.filter((id) => !EXTENSION_IDS.includes(id));

/** Every gate on, so the whole registry runs. */
function everythingOn() {
  return {
    vision: true,
    introspection: true,
    modelsMode: true,
    capability: { context: ["ancient-samples", "scholar-metrics"] },
    ext: { shodan: { on: true }, maps: { on: true } },
  };
}

/**
 * A conversation that throws on every property access — see the header. Symbol
 * lookups and `then` pass through, because the runner awaits its own return
 * value (an unwrapped `then` probe would throw inside runEnrichments itself
 * rather than inside a runner).
 */
function hostileConversation() {
  return new Proxy([], {
    get(target, prop) {
      if (typeof prop === "symbol" || prop === "then") return Reflect.get(target, prop);
      throw new Error("hostile conversation");
    },
  });
}

const NOOP_CTX = {
  emit() {},
  step() {},
  stepDone() {},
};

/** Runs the REAL registry, recording steps and log lines. */
async function runReal(conversation, state, opts = {}) {
  const log = fakeLog();
  const steps = [];
  const out = await runEnrichments(
    opts.env || {},
    log,
    NOOP_CTX.emit,
    (id, label) => steps.push(["start", id, label]),
    (id, label, details) => steps.push(["done", id, label, details]),
    conversation,
    state,
  );
  return { out, log, steps, warns: log.at("warn").map((l) => l.args) };
}

/** The ids of the enrichments that ran, in the order they ran. */
function idsThatRan(warns) {
  return warns.map(([event]) => String(event).replace(/\.enrichment_failed$/, ""));
}

let probeSeq = 0;

/**
 * Swap the extension registry for `entries`, load a FRESH enrichment.js whose
 * ENRICHMENTS therefore starts with them, restore the real registry, then hand
 * that instance's runEnrichments to `fn`.
 */
async function withProbes(entries, fn) {
  const saved = EXTENSIONS.slice();
  let mod;
  try {
    EXTENSIONS.length = 0;
    EXTENSIONS.push(...entries);
    mod = await import(`./enrichment.js?probe=${++probeSeq}`);
  } finally {
    EXTENSIONS.length = 0;
    EXTENSIONS.push(...saved);
  }
  return fn(mod.runEnrichments);
}

/** A probe extension descriptor (the shape extensionEnrichments() consumes). */
function probe(id, run) {
  return { id, enabled: () => true, run };
}

// ---------------------------------------------------------------------------

describe("the enrichment registry — membership and order", () => {
  test("is exactly the two extensions followed by the core enrichments, in order", async () => {
    // Nothing else in the suite pins this: delete an entry from
    // CORE_ENRICHMENTS and every other test still passes.
    const { warns, out } = await runReal(hostileConversation(), everythingOn());
    assert.deepEqual(idsThatRan(warns), EXPECTED_ORDER);
    // …and the failure of all nine left the conversation exactly as it came in.
    assert.equal(typeof out, "object");
  });

  test("the registry's extensions come first, before any core enrichment", async () => {
    const { warns } = await runReal(hostileConversation(), everythingOn());
    const ids = idsThatRan(warns);
    const lastExtension = Math.max(...EXTENSION_IDS.map((id) => ids.indexOf(id)));
    const firstCore = Math.min(...CORE_IDS.map((id) => ids.indexOf(id)));
    assert.ok(lastExtension < firstCore, `extensions must precede core: ${ids.join(", ")}`);
  });

  test("image_read runs FIRST among the core enrichments", async () => {
    // Load-bearing, per src/image-read.js and the CORE_ENRICHMENTS comment: an
    // attached picture is opaque to everything that reads the conversation
    // afterwards (textOf flattens it to "[N image(s) attached]"), so the
    // transcription must exist before any other enrichment or phase looks. Move
    // this entry down and introspection/aadr/scholar/person_research all start
    // gating on a message with no subject in it.
    const { warns } = await runReal(hostileConversation(), everythingOn());
    const ids = idsThatRan(warns);
    assert.equal(ids[EXTENSION_IDS.length], "image_read");
    for (const id of CORE_IDS.filter((c) => c !== "image_read")) {
      assert.ok(ids.indexOf("image_read") < ids.indexOf(id), `image_read must precede ${id}`);
    }
  });

  test("each entry is gated on the documented piece of request state", async () => {
    // `enabled(state)` runs for every entry in registry order, so the property
    // reads it makes ARE the gates, in order:
    //   shodan / maps  ← their own slice of state.ext (extensions.js sliceOf)
    //   image_read     ← state.vision
    //   introspect     ← state.introspection
    //   models         ← state.modelsMode
    //   aadr           ← capHasContext(state.capability, "ancient-samples")
    //   scholar        ← capHasContext(state.capability, "scholar-metrics")
    //   person_research← nothing at all (`enabled: () => true`)
    const reads = [];
    const ext = new Proxy(
      {},
      {
        get(_t, prop) {
          if (typeof prop === "symbol") return undefined;
          reads.push(`ext.${prop}`);
          return undefined;
        },
      },
    );
    const state = new Proxy(
      { ext },
      {
        get(target, prop) {
          if (typeof prop === "symbol") return undefined;
          reads.push(String(prop));
          return target[prop];
        },
      },
    );
    await runReal([{ role: "user", content: "what is the capital of France?" }], state);
    assert.deepEqual(reads, [
      "ext",
      "ext.shodan",
      "ext",
      "ext.maps",
      "vision",
      "introspection",
      "modelsMode",
      "capability",
      "capability",
    ]);
  });

  test("person_research is the one entry that is always enabled", async () => {
    // Every other gate is off in a bare state, so it is the only runner reached
    // — its own intent gate decides, not the registry.
    const { warns } = await runReal(hostileConversation(), {});
    assert.deepEqual(idsThatRan(warns), ["person_research", "entity_research"]);
  });

  test("the registry is language-independent", async () => {
    // enrichment.js holds no phrase gate of its own (invariant 6 lives in the
    // individual runners' intent functions). Pinned so a future change cannot
    // quietly introduce an English-only condition at the registry level.
    const sv = await runReal(hostileConversation(), everythingOn());
    const en = await runReal(hostileConversation(), everythingOn());
    assert.deepEqual(idsThatRan(sv.warns), idsThatRan(en.warns));
    const svTurn = await runReal(
      [{ role: "user", content: "Vilka portar är öppna på basalt.se?" }],
      everythingOn(),
    );
    const enTurn = await runReal(
      [{ role: "user", content: "Which ports are open on basalt.se?" }],
      everythingOn(),
    );
    // Same registry decisions either way: both turns reach every enabled
    // runner, and neither language errors the request.
    assert.equal(Array.isArray(svTurn.out), true);
    assert.equal(Array.isArray(enTurn.out), true);
  });
});

describe("gating", () => {
  test("a disabled enrichment's run is never called", async () => {
    // The hostile conversation makes "was run called?" observable: any runner
    // that were reached would throw and log. Only person_research does.
    const { warns, out } = await runReal(hostileConversation(), { vision: false, introspection: false });
    assert.deepEqual(idsThatRan(warns), ["person_research", "entity_research"]);
    assert.equal(warns.length, 2);
    assert.equal(typeof out, "object");
  });

  test("a state with no ext bag at all leaves both extensions off", async () => {
    const { warns } = await runReal(hostileConversation(), {});
    assert.equal(idsThatRan(warns).includes("shodan"), false);
    assert.equal(idsThatRan(warns).includes("maps"), false);
  });

  test("emptyExtensionState() (the MCP channel's shape) leaves both extensions off", async () => {
    const { warns } = await runReal(hostileConversation(), { ext: emptyExtensionState() });
    assert.deepEqual(idsThatRan(warns), ["person_research", "entity_research"]);
  });

  test("an extension fires only on its own slice", async () => {
    const only = async (ext) => idsThatRan((await runReal(hostileConversation(), { ext })).warns);
    assert.deepEqual(await only({ shodan: { on: true } }), ["shodan", "person_research", "entity_research"]);
    assert.deepEqual(await only({ maps: { on: true } }), ["maps", "person_research", "entity_research"]);
    assert.deepEqual(await only({ shodan: { on: false }, maps: { on: false } }), ["person_research", "entity_research"]);
  });

  test("an ordinary Deep Research turn leaves aadr and scholar OFF", async () => {
    // The sharpest gap this file closes: both suites call their runners
    // directly, so nothing pinned that a request which never consulted the
    // agent registry (capability null/absent — every ordinary turn) does not
    // reach them. Removing the agent from sdk/AGENTS.json must turn the
    // capability off entirely.
    for (const capability of [undefined, null, {}, { context: [] }, { context: ["source-snapshot"] }]) {
      const { warns } = await runReal(hostileConversation(), { capability });
      assert.deepEqual(
        idsThatRan(warns),
        ["person_research", "entity_research"],
        `capability ${JSON.stringify(capability)} must not enable aadr/scholar`,
      );
    }
  });

  test("a capability declaring ancient-samples turns aadr on — and only aadr", async () => {
    const { warns } = await runReal(hostileConversation(), {
      capability: { context: ["ancient-samples"] },
    });
    assert.deepEqual(idsThatRan(warns), ["aadr", "person_research", "entity_research"]);
  });

  test("a capability declaring scholar-metrics turns scholar on — and only scholar", async () => {
    const { warns } = await runReal(hostileConversation(), {
      capability: { context: ["scholar-metrics"] },
    });
    assert.deepEqual(idsThatRan(warns), ["scholar", "person_research", "entity_research"]);
  });

  test("the core knobs each enable exactly their own entry", async () => {
    const only = async (state) => idsThatRan((await runReal(hostileConversation(), state)).warns);
    assert.deepEqual(await only({ vision: true }), ["image_read", "person_research", "entity_research"]);
    assert.deepEqual(await only({ introspection: true }), ["introspect", "person_research", "entity_research"]);
    assert.deepEqual(await only({ modelsMode: true }), ["models", "person_research", "entity_research"]);
    // Falsy knobs stay off — the gates coerce rather than test for `true`.
    assert.deepEqual(await only({ vision: 0, introspection: "", modelsMode: null }), [
      "person_research",
      "entity_research",
    ]);
  });

  test("an ordinary turn with every knob off touches nothing and reaches no network", async () => {
    await withFakeFetch([], async (stub) => {
      const conversation = [{ role: "user", content: "what is the capital of France?" }];
      const { out, steps, log } = await runReal(conversation, {});
      // The three contract assertions for a silent path.
      assert.equal(out, conversation);
      assert.deepEqual(steps, []);
      assert.deepEqual(stub.requests, []);
      assert.deepEqual(log.at("warn"), []);
    });
  });
});

describe("fail-soft (CLAUDE.md invariant 2)", () => {
  test("a throwing runner is caught, named in a warn, and the next one still runs", async () => {
    const seen = [];
    const conversation = [{ role: "user", content: "hello" }];
    await withProbes(
      [
        probe("boom", async () => {
          throw new Error("upstream exploded");
        }),
        probe("after", async (c) => {
          seen.push(c.conversation);
          return c.conversation;
        }),
      ],
      async (run) => {
        const log = fakeLog();
        const out = await run({}, log, NOOP_CTX.emit, NOOP_CTX.step, NOOP_CTX.stepDone, conversation, {});
        // The event name is the observability contract chatlogs/wrangler-tail
        // readers grep for; the production miss behind this file was a runner
        // with NO event of any kind.
        assert.deepEqual(
          log.at("warn").map((l) => l.args),
          [["boom.enrichment_failed", { error: "upstream exploded" }]],
        );
        // The next enrichment got the conversation the failed one was given.
        assert.equal(seen.length, 1);
        assert.equal(seen[0], conversation);
        assert.equal(out, conversation);
      },
    );
  });

  test("an asynchronous rejection behaves exactly like a synchronous throw", async () => {
    const conversation = [{ role: "user", content: "hello" }];
    await withProbes(
      [
        probe("sync", () => {
          throw new Error("sync failure");
        }),
        probe("async", () => Promise.reject(new Error("async failure"))),
        probe("last", async (c) => c.conversation),
      ],
      async (run) => {
        const log = fakeLog();
        const out = await run({}, log, NOOP_CTX.emit, NOOP_CTX.step, NOOP_CTX.stepDone, conversation, {});
        assert.deepEqual(
          log.at("warn").map((l) => l.args),
          [
            ["sync.enrichment_failed", { error: "sync failure" }],
            ["async.enrichment_failed", { error: "async failure" }],
          ],
        );
        assert.equal(out, conversation);
      },
    );
  });

  test("a non-Error throw is stringified rather than crashing the logger", async () => {
    const conversation = [{ role: "user", content: "hello" }];
    await withProbes(
      [
        probe("stringy", async () => {
          throw "just a string";
        }),
        probe("nullish", async () => {
          throw undefined;
        }),
      ],
      async (run) => {
        const log = fakeLog();
        const out = await run({}, log, NOOP_CTX.emit, NOOP_CTX.step, NOOP_CTX.stepDone, conversation, {});
        assert.deepEqual(
          log.at("warn").map((l) => l.args),
          [
            ["stringy.enrichment_failed", { error: "just a string" }],
            ["nullish.enrichment_failed", { error: "undefined" }],
          ],
        );
        assert.equal(out, conversation);
      },
    );
  });

  test("runners chain: each sees the conversation the previous one returned", async () => {
    const conversation = [{ role: "user", content: "hello" }];
    const first = [{ role: "user", content: "hello\n\n[BLOCK A]" }];
    const second = [{ role: "user", content: "hello\n\n[BLOCK A]\n\n[BLOCK B]" }];
    const seen = [];
    await withProbes(
      [
        probe("a", async (c) => {
          seen.push(c.conversation);
          return first;
        }),
        probe("b", async (c) => {
          seen.push(c.conversation);
          return second;
        }),
      ],
      async (run) => {
        const out = await run({}, fakeLog(), NOOP_CTX.emit, NOOP_CTX.step, NOOP_CTX.stepDone, conversation, {});
        assert.equal(seen[0], conversation);
        assert.equal(seen[1], first);
        assert.equal(out, second);
        // The caller's array is never mutated in place by the runner.
        assert.deepEqual(conversation, [{ role: "user", content: "hello" }]);
      },
    );
  });

  test("a failed runner does not hand its half-work to the next one", async () => {
    // The catch keeps `convo` at the value the failed runner was GIVEN, not at
    // anything it managed to build before throwing.
    const conversation = [{ role: "user", content: "hello" }];
    const seen = [];
    await withProbes(
      [
        probe("partial", async () => {
          throw new Error("threw after building a block");
        }),
        probe("next", async (c) => {
          seen.push(c.conversation);
          return c.conversation;
        }),
      ],
      async (run) => {
        const out = await run({}, fakeLog(), NOOP_CTX.emit, NOOP_CTX.step, NOOP_CTX.stepDone, conversation, {});
        assert.equal(seen[0], conversation);
        assert.equal(out, conversation);
      },
    );
  });

  test("the ctx handed to a runner carries exactly the documented seven fields", async () => {
    const env = { SHODAN_API_KEY: "k" };
    const state = { marker: 1 };
    const conversation = [{ role: "user", content: "hello" }];
    const log = fakeLog();
    let ctx;
    await withProbes(
      [
        probe("inspect", async (c) => {
          ctx = c;
          return c.conversation;
        }),
      ],
      async (run) => {
        await run(env, log, NOOP_CTX.emit, NOOP_CTX.step, NOOP_CTX.stepDone, conversation, state);
      },
    );
    assert.deepEqual(Object.keys(ctx).sort(), [
      "conversation",
      "emit",
      "env",
      "log",
      "state",
      "step",
      "stepDone",
    ]);
    assert.equal(ctx.env, env);
    assert.equal(ctx.log, log);
    assert.equal(ctx.state, state);
    assert.equal(ctx.conversation, conversation);
  });

  test("the whole call never rejects, whatever a runner does", async () => {
    const conversation = [{ role: "user", content: "hello" }];
    const misbehaviours = [
      ["throws", () => { throw new Error("x"); }],
      ["rejects", () => Promise.reject(new Error("x"))],
      ["returns null", async () => null],
      ["returns undefined", async () => undefined],
      ["returns a string", async () => "not a conversation"],
      ["returns a number", async () => 42],
      ["throws a non-Error", () => { throw { weird: true }; }],
      ["never returns a promise", () => conversation],
    ];
    for (const [name, run] of misbehaviours) {
      await withProbes([probe("bad", run)], async (runEnrich) => {
        await assert.doesNotReject(
          () => runEnrich({}, fakeLog(), NOOP_CTX.emit, NOOP_CTX.step, NOOP_CTX.stepDone, conversation, {}),
          `a runner that ${name} must not reject the request`,
        );
      });
    }
  });

  test("the real registry never rejects even when every runner is hostile", async () => {
    // Eight real runners, all handed a conversation that throws on touch.
    const convo = hostileConversation();
    await assert.doesNotReject(async () => {
      const { out, warns } = await runReal(convo, everythingOn());
      assert.equal(out, convo, "the conversation comes back as it went in");
      assert.equal(warns.length, EXPECTED_ORDER.length);
    });
  });

  // FINDING (reported, not fixed here): a runner that resolves to a NULLISH
  // value is not contained the way a throwing one is. `convo = await e.run(...)`
  // assigns it unconditionally, so the null flows into the NEXT runner and out
  // of runEnrichments — the user's message is lost rather than degraded. Today
  // no shipped runner does this, and person_research's own defensiveness
  // (`conversation || []`) converts it to an empty array before it escapes the
  // real registry, which is why the damage is invisible. The tests below pin
  // the CURRENT behaviour so a fix (skip the assignment when the result is not
  // an array) turns them red and lands with intent.
  // Was a KNOWN GAP until 2026-08-07: `convo = await e.run(...)` assigned
  // unconditionally, so a runner that slipped and resolved to null/undefined
  // handed that nullish value to the NEXT runner and out of runEnrichments.
  // These two tests are now the regression pin for the containment.
  test("a nullish return is contained — the next runner still gets the conversation", async () => {
    const conversation = [{ role: "user", content: "hello" }];
    const seen = [];
    const log = fakeLog();
    await withProbes(
      [
        probe("nullish", async () => null),
        probe("next", async (c) => {
          seen.push(c.conversation);
          return c.conversation;
        }),
      ],
      async (run) => {
        const out = await run({}, log, NOOP_CTX.emit, NOOP_CTX.step, NOOP_CTX.stepDone, conversation, {});
        assert.equal(seen[0], conversation, "the next runner is handed the conversation, not null");
        assert.equal(out, conversation, "and the conversation survives to the caller");
      },
    );
    assert.match(log.text(), /nullish\.enrichment_dropped/, "the drop is logged rather than being silent");
  });

  test("through the REAL registry a nullish return leaves the conversation intact", async () => {
    const conversation = [{ role: "user", content: "hello" }];
    await withProbes([probe("nullish", async () => undefined)], async (run) => {
      const out = await run({}, fakeLog(), NOOP_CTX.emit, NOOP_CTX.step, NOOP_CTX.stepDone, conversation, {});
      // Before the fix person_research (always enabled, runs last) coerced the
      // undefined to [] and the request proceeded with the user's question
      // deleted. Now the nullish return never leaves the failing runner.
      assert.deepEqual(out, conversation);
    });
  });
});

// ---------------------------------------------------------------------------

// Live feedback #65. Enrichments append two KINDS of block to the last user
// message, and the difference is invisible to everything except the QUERY
// PLANNER. Most append DATA it legitimately needs — a transcription of the
// user's own photo, matched corpus rows, a metrics table, the model catalog.
// Exactly two append METHOD: person_research's protocol (874 words) and
// entity_research's report scaffold (945 at the `full` tier), prose that names
// no subject and asserts no fact. A four-word "Tiber style threat intel" grew
// 945 words of TIBER-EU and MITRE ATT&CK, triage read the result as "the
// latest user message", and the first web query went looking for the report
// FORMAT instead of for the company.
//
// runEnrichments is where the two are told apart: a registry row marked
// `method: true` has whatever it appended recorded on `state.methodBlocks` — by
// DIFFING the last user message around its run, so nothing has to be kept in
// sync with the block's own text — and src/pipeline.js builds its planning view
// with withoutMethodBlocks(convo, state.methodBlocks).
//
// The method rows here are the REAL ones, because a method row cannot be faked:
// `withProbes` reaches the registry through extensions.js extensionEnrichments(),
// which builds every entry as `{ id, enabled, run }` and carries no `method` key
// at all (an extension resolves something the message names, so it appends data
// by construction — pinned below). The probe seam still drives the data half,
// where that is exactly what is wanted.
describe("method blocks are recorded for the query planner (feedback #65)", () => {
  // Verbatim from the feedback each method exists for.
  const PERSON_TURN = "Write a report about what you can find on this founder"; // #60
  const ENTITY_TURN = "Osint on revsec"; // #64
  // Both gates fire on this one: the request SHAPE is a dossier and the subject
  // is a named individual. The registry order (person_research, then
  // entity_research) is what decides the order of the two recorded blocks.
  const BOTH_TURN = "do an osint report on the founder Anna Svensson";
  // Neither method gate fires, and no other enrichment is enabled by `{}`.
  const QUIET_TURN = "what is the capital of France?";

  const turn = (/** @type {string} */ text) => [{ role: "user", content: text }];

  test("a method row records exactly the block it appended — not the whole message", async () => {
    // The recorded string has to be the BLOCK: withoutMethodBlocks removes it by
    // exact substring, so a recording that carried the user's own words with it
    // would delete the question the planner exists to plan against.
    const person = {};
    await runReal(turn(PERSON_TURN), person);
    assert.deepEqual(/** @type {any} */ (person).methodBlocks, [personResearchBlock()]);

    const entity = {};
    await runReal(turn(ENTITY_TURN), entity);
    // No `state.plan`, so entity-research falls back to the "standard" tier the
    // same way every other reportTier consumer does.
    assert.deepEqual(/** @type {any} */ (entity).methodBlocks, [entityResearchBlock("standard")]);

    for (const [state, asked] of [[person, PERSON_TURN], [entity, ENTITY_TURN]]) {
      for (const block of /** @type {any} */ (state).methodBlocks) {
        assert.equal(
          block.includes(/** @type {string} */ (asked)),
          false,
          "a recorded block must carry none of what the user typed",
        );
      }
    }
  });

  test("what is recorded is what withoutMethodBlocks needs to restore the planning view", async () => {
    // The round trip is the whole contract: enrich → record → strip must hand
    // the planner back the message the user actually typed.
    const state = {};
    const { out } = await runReal(turn(PERSON_TURN), state);
    assert.notEqual(lastUserText(out), PERSON_TURN, "the block really was appended");
    const planning = withoutMethodBlocks(out, /** @type {any} */ (state).methodBlocks);
    assert.equal(lastUserText(planning), PERSON_TURN);
  });

  test("a DATA enrichment records nothing — the planner must keep seeing data blocks", async () => {
    // The load-bearing half of the design. `method` is absent by default and
    // that default is the right one: a block resolving something the message
    // NAMES (the photo transcription, the corpus rows, the catalog) is exactly
    // what a planner should be writing queries from. Marking a data row would
    // hide the user's own attachment from triage.
    const state = {};
    const conversation = turn(QUIET_TURN);
    const DATA = "[HOST INTELLIGENCE] basalt.se — 443/tcp open";
    await withProbes(
      [probe("data", async (c) => [{ role: "user", content: `${lastUserText(c.conversation)}\n\n${DATA}` }])],
      async (run) => {
        const out = await run({}, fakeLog(), NOOP_CTX.emit, NOOP_CTX.step, NOOP_CTX.stepDone, conversation, state);
        assert.ok(lastUserText(out).includes(DATA), "the data row did append");
        assert.equal(/** @type {any} */ (state).methodBlocks, undefined);
      },
    );
  });

  test("a SILENT method row records nothing — no empty entry, no array", async () => {
    // Both method runners are silent far more often than they fire (every turn
    // that is not a person or dossier request), and a silent runner returns the
    // conversation by reference. Recording an empty string there would make
    // withoutMethodBlocks a no-op with a cost, and `state.methodBlocks` a bag
    // that is never absent.
    const state = {};
    const conversation = turn(QUIET_TURN);
    const { out, warns } = await runReal(conversation, state);
    assert.equal(out, conversation, "the conversation came back by reference");
    assert.equal(/** @type {any} */ (state).methodBlocks, undefined);
    assert.deepEqual(warns, []);
  });

  test("both method rows record when both fire, in registry order", async () => {
    // An OSINT question about a named individual: the person method and its
    // guardrails first, then the subject-resolution rule and the report size.
    // Both firing on one turn is correct, not a double-fire (feedback #64) —
    // and the planner has to be able to strip BOTH.
    const state = {};
    const { out } = await runReal(turn(BOTH_TURN), state);
    const blocks = /** @type {any} */ (state).methodBlocks;
    assert.equal(blocks.length, 2);
    assert.deepEqual(blocks, [personResearchBlock(), entityResearchBlock("standard")]);
    // Registry order, stated as the property that matters rather than as the
    // constants above: the person block precedes the entity one in the message
    // as well as in the record.
    const text = lastUserText(out);
    assert.ok(text.indexOf(blocks[0]) < text.indexOf(blocks[1]));
    assert.equal(lastUserText(withoutMethodBlocks(out, blocks)), BOTH_TURN);
  });

  test("a method row whose runner returns a non-array records nothing", async () => {
    // The dropped-return case (pinned above for data rows) reached through a
    // REAL method row: handed a conversation that is not an array, both method
    // runners defensively hand it straight back, so `next` is not a Conversation.
    // `Array.isArray(next)` gates the recording exactly as it gates the
    // assignment — nothing is diffed against a value that is not a conversation.
    const state = {};
    const { out, log } = await runReal(/** @type {any} */ ("not a conversation"), state);
    assert.equal(/** @type {any} */ (state).methodBlocks, undefined);
    assert.equal(out, "not a conversation", "and the caller's value is untouched");
    assert.match(log.text(), /person_research\.enrichment_dropped/);
    assert.match(log.text(), /entity_research\.enrichment_dropped/);
  });

  test("a frozen state does not break the run (invariant 2)", async () => {
    // The recording is a WRITE to request state, which is the one new way this
    // could take down a chat — module scope is strict, so the assignment throws
    // rather than failing silently. It is caught at the write, not at the
    // runner: the blocks still reach the conversation, the planner simply sees
    // them the way it did before feedback #65, and no runner is blamed in the
    // log for something it did not do.
    const state = Object.freeze({});
    const conversation = turn(BOTH_TURN);
    /** @type {any} */
    let result;
    await assert.doesNotReject(async () => {
      result = await runReal(conversation, state);
    });
    const text = lastUserText(result.out);
    assert.ok(text.startsWith(BOTH_TURN), "the user's question survives");
    assert.ok(text.includes(personResearchBlock()), "the person method still applied");
    assert.ok(text.includes(entityResearchBlock("standard")), "the entity method still applied");
    assert.equal(/** @type {any} */ (state).methodBlocks, undefined);
    assert.deepEqual(result.warns, [], "the frozen write is not reported as a runner failure");
  });

  // `ENRICHMENTS` is not exported (see this file's header), so WHICH rows carry
  // the flag is pinned the way pipeline.test.js pins a call site: over the
  // source itself. The extension half needs no source read — extensionEnrichments()
  // is exported and builds the entries.
  describe("the flag is on exactly the two method rows", () => {
    const SRC = readFileSync(new URL("./enrichment.js", import.meta.url), "utf8");
    // One chunk per CORE_ENRICHMENTS entry: from its `id:` line to the next
    // one's (the last runs to end of file).
    const entries = SRC.split(/\n {4}id: "/)
      .slice(1)
      .map((chunk) => /** @type {[string, string]} */ ([chunk.slice(0, chunk.indexOf('"')), chunk]));

    test("the source parse sees the core registry the rest of this file observes", () => {
      // Guards the two assertions below: a parse that matched nothing would
      // make them both vacuously true.
      assert.deepEqual(entries.map(([id]) => id), CORE_IDS);
    });

    test("person_research and entity_research are marked, and no other core row is", () => {
      const marked = entries.filter(([, chunk]) => /\n {4}method: true,/.test(chunk)).map(([id]) => id);
      assert.deepEqual(marked, ["person_research", "entity_research"]);
    });

    test("the extension seam carries no method flag at all", () => {
      // Also why a probe can never be a method row: extensionEnrichments()
      // rebuilds each descriptor as `{ id, enabled, run }`. An extension
      // resolves something the message NAMES, which is data by construction.
      for (const e of extensionEnrichments()) {
        assert.equal("method" in e, false, `${e.id} must not be a method row`);
      }
    });

    test("the recording is gated on the row being a method row AND returning a conversation", () => {
      assert.match(
        SRC,
        /if \(e\.method && Array\.isArray\(next\)\) noteMethodBlock\(state, before, lastUserText\(next\)\)/,
      );
      // The `before` snapshot is taken only for method rows — reading the last
      // user message on every enrichment would be work no other row needs.
      assert.match(SRC, /const before = e\.method \? lastUserText\(convo\) : ""/);
    });
  });
});
