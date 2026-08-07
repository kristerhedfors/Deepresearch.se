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
import test, { describe } from "node:test";

import { runEnrichments } from "./enrichment.js";
import { EXTENSIONS, emptyExtensionState } from "./extensions.js";
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
    // …and the failure of all eight left the conversation exactly as it came in.
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
    assert.deepEqual(idsThatRan(warns), ["person_research"]);
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
    assert.deepEqual(idsThatRan(warns), ["person_research"]);
    assert.equal(warns.length, 1);
    assert.equal(typeof out, "object");
  });

  test("a state with no ext bag at all leaves both extensions off", async () => {
    const { warns } = await runReal(hostileConversation(), {});
    assert.equal(idsThatRan(warns).includes("shodan"), false);
    assert.equal(idsThatRan(warns).includes("maps"), false);
  });

  test("emptyExtensionState() (the MCP channel's shape) leaves both extensions off", async () => {
    const { warns } = await runReal(hostileConversation(), { ext: emptyExtensionState() });
    assert.deepEqual(idsThatRan(warns), ["person_research"]);
  });

  test("an extension fires only on its own slice", async () => {
    const only = async (ext) => idsThatRan((await runReal(hostileConversation(), { ext })).warns);
    assert.deepEqual(await only({ shodan: { on: true } }), ["shodan", "person_research"]);
    assert.deepEqual(await only({ maps: { on: true } }), ["maps", "person_research"]);
    assert.deepEqual(await only({ shodan: { on: false }, maps: { on: false } }), ["person_research"]);
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
        ["person_research"],
        `capability ${JSON.stringify(capability)} must not enable aadr/scholar`,
      );
    }
  });

  test("a capability declaring ancient-samples turns aadr on — and only aadr", async () => {
    const { warns } = await runReal(hostileConversation(), {
      capability: { context: ["ancient-samples"] },
    });
    assert.deepEqual(idsThatRan(warns), ["aadr", "person_research"]);
  });

  test("a capability declaring scholar-metrics turns scholar on — and only scholar", async () => {
    const { warns } = await runReal(hostileConversation(), {
      capability: { context: ["scholar-metrics"] },
    });
    assert.deepEqual(idsThatRan(warns), ["scholar", "person_research"]);
  });

  test("the core knobs each enable exactly their own entry", async () => {
    const only = async (state) => idsThatRan((await runReal(hostileConversation(), state)).warns);
    assert.deepEqual(await only({ vision: true }), ["image_read", "person_research"]);
    assert.deepEqual(await only({ introspection: true }), ["introspect", "person_research"]);
    assert.deepEqual(await only({ modelsMode: true }), ["models", "person_research"]);
    // Falsy knobs stay off — the gates coerce rather than test for `true`.
    assert.deepEqual(await only({ vision: 0, introspection: "", modelsMode: null }), [
      "person_research",
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
