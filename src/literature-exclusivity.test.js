// (no @ts-check: node:test / node:assert have no type declarations in this
// repo — the same reason src/search-sources.test.js omits it.)
//
// WHO MAY SEARCH THE LITERATURE — the exclusivity guard.
//
// Owner directive, 2026-08-13: the agent roster became SPECIFIC, with no
// general member. `normal` and its `research` agent are gone, Deep Science
// (`scholar`) is the default and the terminal fallback, and with that came a
// division of the corpora — **Deep Science is the exclusive owner of all arXiv
// and PubMed capability**, with the palaeogenomics agent keeping the
// life-science leg it was built on and nothing else.
//
// That division is expressed in TWO files that have to agree, and nothing made
// them agree before this suite existed:
//
//   * sdk/AGENTS.json — each agent's `capability.context` declares which
//     literature blocks it holds. It is DATA, edited by hand, and a spec edit
//     that adds "literature-arxiv" to another agent is one word long.
//   * src/search-sources.js — each source's `requiresContext` names the block
//     its answering agent must hold. pipeline.js enforces it generically
//     (`sourceAllowed`), so the enforcement itself is never the thing that
//     drifts; the DECLARATIONS are.
//
// So this file asserts the pairing from both ends: exactly which agents may
// hold each literature block (§1), and what that means for the sources a real
// resolved capability can actually reach (§2) — including the two cases the
// directive singles out, palaeogenomics keeping Europe PMC / hosted PubMed
// (which tests/evalsets/palaeogenomics.json and tests/needles/*-pubmed.json
// depend on) and NOT getting arXiv, whose coverage of the field its own spec
// describes as absent.
//
// §3 pins the fail-soft hole on purpose: a request that resolved NO capability
// keeps every source. That is the MCP channel — src/mcp.js builds its state
// without a registry, POST /mcp has no concept of an agent, and the
// ground-truth batteries reach both corpora through it — and any deployment
// whose registry will not load (invariant 2: a helper phase degrades, it never
// errors the request).
//
// Deliberately NOT duplicated here: the registry entry shape and
// capabilityAllowsSource's own truth table (src/search-sources.test.js), the
// pipeline call sites that consult it (src/pipeline.test.js), and the trigger
// matrix over the intent gates (src/search-sources-trigger.test.js).

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { SEARCH_SOURCES, capabilityAllowsSource, sourcePromptNotes } from "./search-sources.js";
import { resolveCapability } from "./agent-spec.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const REGISTRY = JSON.parse(readFileSync(join(repoRoot, "sdk", "AGENTS.json"), "utf8"));

/** @param {string} id */
const agent = (id) => {
  const a = REGISTRY.agents.find((x) => x.id === id);
  assert.ok(a, `sdk/AGENTS.json has no agent "${id}"`);
  return a;
};

/** The resolved capability of a shipped agent — what the pipeline actually
 * reads off `state.capability` for a turn routed to it. */
const capOf = (id) => resolveCapability(agent(id));

// Who is allowed to hold each literature block. This table IS the directive,
// and it is the thing to edit — deliberately, with a reason in the commit — if
// ownership ever moves. Everything below reads it.
const OWNERS = {
  // The preprint archive and the peer-reviewed record are Deep Science's alone.
  "literature-arxiv": ["scholar"],
  "literature-peer-reviewed": ["scholar"],
  // The life-science record is SHARED, and with exactly one other agent: the
  // palaeogenomics agent's second leg is the published literature of the field
  // (its first is the committed corpus of ancient individuals, which needs no
  // source at all). Removing it here would leave that agent answering
  // ancient-DNA questions from the generic web leg alone.
  "literature-pubmed": ["scholar", "palaeogenomics"],
};

// ============================================================================
// §1 — THE DECLARATIONS (sdk/AGENTS.json)
// ============================================================================

describe("§1 only the owning agents declare a literature corpus", () => {
  test("each literature block is declared by exactly the agents allowed to hold it", () => {
    for (const [block, owners] of Object.entries(OWNERS)) {
      const declarers = REGISTRY.agents
        .filter((a) => (a.capability?.context || []).includes(block))
        .map((a) => a.id)
        .sort();
      assert.deepEqual(
        declarers,
        [...owners].sort(),
        `"${block}" is declared by the wrong set of agents. A literature corpus belongs to the ` +
          "agent built on it (owner directive, 2026-08-13); handing one to another agent is a " +
          "product decision, so make it here in OWNERS, in the same commit as the spec edit.",
      );
    }
  });

  test("every literature source's requirement has an owner, and every owner exists", () => {
    // The two ends have to name the same blocks: a source requiring a block no
    // agent holds never runs for anyone, and an agent holding a block no source
    // requires is a declaration with no effect. Both are silent failures.
    const required = SEARCH_SOURCES.filter((s) => s.requiresContext).map((s) => s.requiresContext).sort();
    assert.deepEqual(required, Object.keys(OWNERS).sort());
    for (const owners of Object.values(OWNERS)) {
      for (const id of owners) assert.ok(agent(id), `${id} is named an owner but is not in the registry`);
    }
  });

  test("Deep Science holds all three, and it is the terminal fallback", () => {
    // The two halves of the directive are one fact: the roster has no general
    // member, so the agent every unrouted request lands on had better be able
    // to reach the literature. `requires: []` is what makes it reachable
    // ungated — a fallback behind a capability gate is not a fallback.
    const cap = capOf("scholar");
    for (const block of Object.keys(OWNERS)) {
      assert.ok(cap.context.includes(block), `scholar must declare ${block}`);
    }
    assert.deepEqual(agent("scholar").capability.requires, []);
    assert.equal(agent("scholar").mode, "science");
  });
});

// ============================================================================
// §2 — WHAT THAT MEANS FOR A REAL TURN
// ============================================================================

/** The ids of the sources a resolved capability may consult, in registry
 * order — pipeline.js's `sourceAllowed` applied over the whole registry. */
const reachable = (cap) => SEARCH_SOURCES.filter((s) => capabilityAllowsSource(cap, s)).map((s) => s.id);

describe("§2 the sources each shipped agent can reach", () => {
  test("Deep Science reaches every literature leg — including its own corpora", () => {
    // The change this suite was written for: `state.auxOnly` used to be the
    // ONLY expression of "this agent uses the peer-reviewed leg", and it blocked
    // the two corpora the agent now owns. Ownership means reachable; the
    // per-turn default is still peer-reviewed-only, and that is
    // src/scholar-metrics.test.js's subject, not this file's.
    assert.deepEqual(reachable(capOf("scholar")), ["hf", "arxiv", "europepmc", "scholar"]);
  });

  test("palaeogenomics keeps Europe PMC / hosted PubMed, and gets no preprint archive", () => {
    // THE EXPLICIT PRESERVATION. The ancient-DNA agent has two legs and this is
    // one of them: tests/evalsets/palaeogenomics.json and
    // tests/needles/palaeogenomics-pubmed.json are graded against literature it
    // can only reach through this source. arXiv is excluded for the reason that
    // agent's own documentation gives — the field publishes in journals and on
    // bioRxiv, not on arXiv — so admitting it would buy nothing and would spend
    // the turn's search budget on the wrong corpus.
    const cap = capOf("palaeogenomics");
    assert.ok(reachable(cap).includes("europepmc"), "the life-science leg must still run");
    assert.ok(!reachable(cap).includes("arxiv"), "arXiv does not cover this field");
    assert.ok(!reachable(cap).includes("scholar"), "the peer-reviewed leg belongs to Deep Science");
    // …and its planner is taught Europe PMC's vocabulary and nothing else's:
    // that note is what makes a Swedish ancient-DNA question search in English,
    // which is the difference between hundreds of hits and zero.
    const notes = sourcePromptNotes(cap);
    assert.match(notes, /Europe PMC \(PubMed\/PMC\/bioRxiv\)/);
    assert.doesNotMatch(notes, /scientific preprint archive/);
  });

  test("no other agent reaches any literature corpus", () => {
    // Including `cyber`, the domain agent that replaced the general one. A
    // security question phrased as "what does the latest research say" used to
    // fire arXiv; it now reaches the web leg and the hub, and the literature
    // legs belong to the agents that own them.
    const owned = new Set(Object.values(OWNERS).flat());
    for (const a of REGISTRY.agents) {
      if (owned.has(a.id)) continue;
      const got = reachable(resolveCapability(a));
      assert.deepEqual(
        got,
        ["hf"],
        `${a.id} can reach a literature corpus it does not own (${got.join(", ")})`,
      );
    }
  });
});

// ============================================================================
// §3 — THE FAIL-SOFT HOLE, ON PURPOSE
// ============================================================================

describe("§3 a request with no resolved agent keeps every source", () => {
  test("null capability → the full registry, and the full planner vocabulary", () => {
    // Invariant 2, and the deliberate design decision behind it: the MCP
    // literature door is NOT governed by the agent roster, because MCP has no
    // concept of an agent to govern it with. A null capability means "no agent
    // was resolved" — the MCP channel, or a deployment whose registry will not
    // load — never "an agent declared nothing", and reading it the second way
    // would turn a registry outage into empty answers.
    assert.deepEqual(reachable(null), SEARCH_SOURCES.map((s) => s.id));
    assert.deepEqual(reachable(undefined), SEARCH_SOURCES.map((s) => s.id));
    assert.equal(sourcePromptNotes(null), sourcePromptNotes());
  });
});
