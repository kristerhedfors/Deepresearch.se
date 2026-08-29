// THE CYBER EXCLUSIVITY GUARD — a mechanical check that the cybersecurity and
// OSINT domain still belongs to ONE agent.
//
// The owner directive of 2026-08-13 made the roster specific: there is no
// general member any more, and the `cyber` agent is the exclusive owner of
// everything cybersecurity and OSINT. Four capability blocks carry that
// ownership — `entity-method`, `person-method`, `host-intel`, `street-imagery`
// — and a fifth, `owasp`, is shared with exactly one other agent for a reason
// that is written down below.
//
// Exclusivity is a claim about EVERY OTHER AGENT, which is the kind of claim
// that rots in silence. Nothing fails when a future spec quietly adds
// `host-intel` to Deep Science: the enrichment simply starts running there, the
// grounded capabilities note starts advertising it, and the roster is general
// again by accident. So the claim is pinned here, over the SHIPPED registry
// (sdk/AGENTS.json) rather than over a fixture — widening ownership then has to
// be a deliberate edit to a named assertion, with the reason recorded in this
// file, instead of a line in a JSON file nobody re-reads.
//
// This is the same shape as src/extensions.test.js's "core purity" guard, and
// it exists for the same reason: a separation that is only described is a
// separation that is already half gone.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { AGENTS_PATH, CONTEXT_BLOCKS, GATE_IDS, resolveCapability } from "./agent-spec.js";
import { DEFAULT_PROMPT_SET } from "../public/js/agent-spec-core.js";
import { PROMPT_BUILDERS } from "./prompt-sets.js";
import { EXTENSIONS } from "./extensions.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const REGISTRY = JSON.parse(readFileSync(join(ROOT, AGENTS_PATH), "utf8"));

/** The shipped agents, each with its resolved capability. */
const AGENTS = REGISTRY.agents.map((/** @type {any} */ a) => ({ id: a.id, cap: resolveCapability(a) }));

/** Which agent ids declare a given context block, in registry order. */
const declarers = (/** @type {string} */ block) =>
  AGENTS.filter((a) => a.cap.context.includes(block)).map((a) => a.id);

/** Which agent ids declare a given gate id. */
const gateDeclarers = (/** @type {string} */ id) =>
  AGENTS.filter((a) => (a.cap.gates || []).some((/** @type {any} */ g) => g.id === id)).map((a) => a.id);

// The four blocks the Cyber agent owns ALONE, each with the capability it
// actually switches on — so a reader who finds this test failing can see what
// the other agent just gained.
const CYBER_ONLY = {
  "entity-method": "the subject-disambiguation rule and the depth-scaled dossier scaffold",
  "person-method": "the OSINT tradecraft half of person research (source ladder, verification, write-up)",
  "host-intel": "open ports, services, hosting organization and known CVEs for a named host",
  "street-imagery": "place resolution, street-level imagery and the interactive panorama",
};

// The one SHARED block, and the whole of the argument for sharing it: a
// security assessment of somebody else's system is Cyber's job, and a security
// assessment OF THIS PLATFORM is what Introspection is for. Both need the
// standard; nothing else does.
const OWASP_OWNERS = ["introspection", "cyber"];

describe("the registry this guard reads", () => {
  test("is the shipped one, and it really has a cyber agent", () => {
    // Guards every assertion below: a registry that failed to load, or an
    // agent id that was renamed, would make them all vacuously true.
    assert.ok(AGENTS.length >= 8, `only ${AGENTS.length} agents parsed from ${AGENTS_PATH}`);
    const cyber = AGENTS.find((a) => a.id === "cyber");
    assert.ok(cyber, "no `cyber` agent in the shipped registry");
    for (const block of [...Object.keys(CYBER_ONLY), "owasp"]) {
      assert.ok(cyber.cap.context.includes(block), `cyber does not declare ${block}`);
    }
  });

  test("every block this guard names is a real entry in the vocabulary", () => {
    for (const block of [...Object.keys(CYBER_ONLY), "owasp"]) {
      assert.ok(
        Object.prototype.hasOwnProperty.call(CONTEXT_BLOCKS, block),
        `${block} is not a CONTEXT_BLOCKS id — this guard would be checking a typo`,
      );
    }
  });
});

describe("the cyber/OSINT domain belongs to exactly one agent", () => {
  for (const [block, what] of Object.entries(CYBER_ONLY)) {
    test(`${block} is declared by cyber and NO other agent`, () => {
      assert.deepEqual(
        declarers(block),
        ["cyber"],
        `${block} (${what}) is now declared by more than the Cyber agent. ` +
          "Since 2026-08-13 the roster is SPECIFIC and this domain has one owner: " +
          "if another agent genuinely needs it, say why here and change this assertion " +
          "deliberately — do not widen the spec and leave the guard behind.",
      );
    });
  }

  test("owasp is shared with introspection, and with nothing else", () => {
    // The deliberate overlap. Introspection is how this platform is asked to
    // assess ITSELF, and that is a security assessment like any other.
    assert.deepEqual(
      declarers("owasp").sort(),
      [...OWASP_OWNERS].sort(),
      "the OWASP reference reached a third agent. Before 2026-08-13 it reached FIVE, " +
        "because it lived inside the introspection enrichment and was gated on a MODE " +
        "rather than on a declaration — that is the failure this guard exists to keep fixed.",
    );
  });

  test("no other agent declares a cyber gate either", () => {
    // The gates are the other half of the declaration: a spec that selected
    // `host-intel`'s gate without its context block would be describing an
    // agent that routes on a lookup it cannot perform.
    for (const id of ["security-assessment", "entity-research", "person-research", "host-intel", "place-lookup"]) {
      assert.ok(Object.prototype.hasOwnProperty.call(GATE_IDS, id), `${id} is not a GATE_IDS entry`);
      const owners = gateDeclarers(id);
      assert.deepEqual(
        owners.filter((o) => o !== "cyber" && !(id === "security-assessment" && o === "introspection")),
        [],
        `${id} is declared outside the Cyber agent (${owners.join(", ")})`,
      );
      assert.ok(owners.includes("cyber"), `cyber does not declare the ${id} gate`);
    }
  });

  test("every cyber gate carries both languages (invariant 6)", () => {
    // A gate declared English-only would route a Swedish user's OSINT question
    // to the general research path with none of this agent's method attached.
    const cyber = AGENTS.find((a) => a.id === "cyber");
    for (const g of cyber.cap.gates) {
      assert.deepEqual(
        [...(g.langs || [])].sort(),
        ["en", "sv"],
        `the ${g.id} gate must declare both languages`,
      );
    }
  });
});

describe("the extension registry agrees with the specs", () => {
  test("each extension's contextBlock is one of the cyber-only blocks", () => {
    // src/extensions.js is the only src/ module that may name a service
    // (invariant 7), so the exclusivity claim about Shodan and Street View has
    // to be made HERE, in the vocabulary rather than in the vendor's name.
    for (const e of EXTENSIONS) {
      assert.ok(
        Object.prototype.hasOwnProperty.call(CYBER_ONLY, e.contextBlock),
        `extension "${e.id}" declares ${e.contextBlock}, which is not a Cyber-owned block`,
      );
      assert.deepEqual(declarers(e.contextBlock), ["cyber"], `${e.id} is reachable outside the Cyber agent`);
    }
  });

  test("both of today's extensions are accounted for", () => {
    // Stops the loop above passing because the registry emptied.
    assert.deepEqual(EXTENSIONS.map((e) => e.contextBlock).sort(), ["host-intel", "street-imagery"]);
  });
});

describe("the capability actually REACHES the prompt layer", () => {
  // A declaration that nothing reads is the failure mode this whole change
  // exists to remove, and the prompt layer nearly shipped with it. Every
  // capability-aware prompt builder — the grounded capabilities note, the OWASP
  // assessment note, the search-source vocabulary spliced into triage and gap —
  // takes an optional `capability`, and for a while NOTHING passed it: the
  // builders were tested directly, the tests were green, and on the real
  // request path every filter was inert. A non-Cyber agent would have gone on
  // advertising host intelligence it could no longer run.
  //
  // So this pins the WIRING rather than the behaviour, by reading the source —
  // the same technique src/agent-bounds.test.js uses to pin that every bound
  // constant reaches capBound. It is deliberately crude: it cannot be satisfied
  // by a mock, and it fails the moment someone adds a phase that forgets the
  // field.
  const pipelineSrc = readFileSync(new URL("./pipeline.js", import.meta.url), "utf8");

  test("every capability-AWARE phase prompt is passed the capability", () => {
    // Which builders care is DERIVED, not listed: a prompt builder is
    // capability-aware exactly when its parameter list destructures
    // `capability`. So this cannot go stale by someone making a fifth builder
    // capability-aware and forgetting to add it here — the test finds it, and
    // then fails until pipeline.js passes the field.
    //
    // The pairing is (phase → its default prompt set → the bound builder),
    // which is the shipped mapping; an agent may name a different set, but the
    // call site is the same one either way.
    const calls = [...pipelineSrc.matchAll(/phasePrompt\(ctx\.state,\s*"([\w-]+)",\s*"([\w-]+)"\)\(\{([^}]*)\}\)/g)];
    assert.ok(calls.length >= 5, `expected the shipped phase prompts, found ${calls.length}`);
    let checked = 0;
    for (const [whole, phase, role, opts] of calls) {
      const set = DEFAULT_PROMPT_SET[phase] || phase;
      const builder = PROMPT_BUILDERS[set]?.[role];
      assert.ok(builder, `no builder bound for (${set}, ${role})`);
      // The PARAMETER LIST only. Testing the whole function text matches the
      // word inside a prompt's own English — the build prompt talks about what
      // an agent's capability block is — which read as "capability-aware" and
      // failed a builder that takes no such option.
      const params = String(builder).split("=>")[0];
      if (!/\bcapability\b/.test(params)) continue; // not capability-aware
      checked++;
      assert.match(
        opts,
        /capability:\s*ctx\.state\.capability/,
        `a capability-aware phase prompt is built without the run's capability:\n  ${whole.slice(0, 160)}`,
      );
    }
    // Guards the loop against passing because nothing matched.
    assert.ok(checked >= 4, `expected at least four capability-aware phase prompts, checked ${checked}`);
  });

  test("the planning phases pass it too", () => {
    // The standard graph's two JSON nodes take it through JsonPromptOpts, so
    // they are spelled differently and would slip past the matcher above.
    // They are the ones that decide whether the planner is taught a search
    // source's query vocabulary, which is the difference between planning
    // queries for a leg that will run and planning them for one that cannot.
    //
    // They live in src/pipeline-standard.js since the triage and gap phases
    // this used to read out of pipeline.js were deleted; the wiring is what is
    // pinned, so the pin follows the wiring.
    const standardSrc = readFileSync(new URL("./pipeline-standard.js", import.meta.url), "utf8");
    for (const role of ['"plan"', '"reflect"']) {
      assert.ok(
        standardSrc.includes(`phasePrompt(state, "research", ${role})`),
        `the ${role} node is not built through phasePrompt any more`,
      );
    }
    // Once per node, and off the run's own state.
    const passes = [...standardSrc.matchAll(/capability: \/\*\* @type \{any\} \*\/ \(state\)\.capability \|\| null/g)];
    assert.equal(passes.length, 2, "both planning nodes pass the run's capability");
    // The answer phases still pass it from pipeline.js.
    assert.match(pipelineSrc, /capability:\s*(state|ctx\.state)\.capability/);
  });
});
