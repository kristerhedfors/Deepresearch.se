// (no @ts-check: node:test / node:assert have no type declarations in this
// repo — tsconfig's types is workers-only and @types/node would be a new
// dependency.)
// Covers search-sources.js: the SEARCH_SOURCES entry contract, the
// concatenated planner prompt notes, and platform diversity keying.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { SEARCH_SOURCES, capabilityAllowsSource, leadSourceIds, platformDiversityKey, sourcePromptNotes } from "./search-sources.js";
import { CONTEXT_BLOCKS } from "./agent-spec.js";

// The registry is the parallel-work seam: every source integrates as data
// here, and the pipeline/prompts/sources modules only iterate. These tests
// pin the entry CONTRACT so a mis-shaped entry from any session fails fast
// in CI instead of silently never firing (or crashing a wave) in production.
describe("SEARCH_SOURCES registry contract", () => {
  test("every entry declares the required interface", () => {
    assert.ok(SEARCH_SOURCES.length >= 1);
    const ids = new Set();
    for (const s of SEARCH_SOURCES) {
      assert.match(s.id, /^[a-z][a-z0-9_-]*$/, `bad id: ${s.id}`);
      assert.ok(!ids.has(s.id), `duplicate id: ${s.id}`);
      ids.add(s.id);
      assert.equal(typeof s.intent, "function", `${s.id}: intent`);
      assert.equal(typeof s.search, "function", `${s.id}: search`);
      assert.equal(typeof s.service, "string", `${s.id}: service display name`);
      assert.ok(s.service.trim().length >= 2, `${s.id}: service must be a real display name`);
      if (s.dedupKey) assert.equal(typeof s.dedupKey, "function", `${s.id}: dedupKey`);
      if (s.maxPerRequest != null) assert.ok(Number.isInteger(s.maxPerRequest) && s.maxPerRequest >= 1, `${s.id}: maxPerRequest`);
      if (s.promptNote) {
        assert.equal(typeof s.promptNote, "string", `${s.id}: promptNote`);
        assert.match(s.promptNote, /^ /, `${s.id}: promptNote must start with a space (it is concatenated after other prompt rules)`);
      }
      // diversityHost and diversityKeyOf come as a pair.
      assert.equal(!!s.diversityHost, typeof s.diversityKeyOf === "function", `${s.id}: diversityHost/diversityKeyOf pair`);
      if (s.requiresContext) {
        // A requirement naming a block the AgentSpec vocabulary does not have
        // can never be satisfied, so the source would silently never run for
        // anyone — the failure mode this field exists to make impossible.
        assert.equal(typeof s.requiresContext, "string", `${s.id}: requiresContext`);
        assert.ok(
          Object.prototype.hasOwnProperty.call(CONTEXT_BLOCKS, s.requiresContext),
          `${s.id}: requiresContext "${s.requiresContext}" is not a CONTEXT_BLOCKS id — no agent can ever declare it`,
        );
      }
      if (s.leadIntent) assert.equal(typeof s.leadIntent, "function", `${s.id}: leadIntent`);
      if (s.leadMaxPerRequest != null) {
        assert.ok(Number.isInteger(s.leadMaxPerRequest) && s.leadMaxPerRequest >= 1, `${s.id}: leadMaxPerRequest`);
        assert.ok(s.leadIntent, `${s.id}: leadMaxPerRequest without a leadIntent can never apply`);
      }
    }
  });

  test("intent predicates are safe on junk input", () => {
    for (const s of SEARCH_SOURCES) {
      assert.equal(typeof s.intent(""), "boolean");
      assert.equal(typeof s.intent(null), "boolean");
      if (s.leadIntent) {
        assert.equal(typeof s.leadIntent(""), "boolean");
        assert.equal(typeof s.leadIntent(null), "boolean");
      }
    }
  });

  test("leadIntent is strictly narrower than intent", () => {
    // Leading DISPLACES web search, so the tier that triggers it must be
    // "the message names this source", never "the message asks something this
    // source could serve" (feedback #44). A source whose leadIntent fired
    // where its intent did not would silently take a turn it was not asked
    // for — this pins the containment on every entry's own vocabulary.
    for (const s of SEARCH_SOURCES) {
      if (!s.leadIntent) continue;
      for (const probe of [
        `search ${s.id} for something`,
        `what does ${s.service} say about diffusion models`,
        "what does the latest research say about llm swarm reasoning",
        "senaste forskningen om språkmodeller",
        "hello",
        "",
      ]) {
        if (s.leadIntent(probe)) assert.ok(s.intent(probe), `${s.id}: leads but does not engage on "${probe}"`);
      }
    }
  });
});

describe("leadSourceIds", () => {
  test("names the sources a message asks for BY NAME, in registry order", () => {
    // feedback #44: "if asked for arXiv explicitly, start there and do only
    // arxiv unless called for otherwise."
    assert.deepEqual(leadSourceIds("find arXiv research mentioning linux"), ["arxiv"]);
    assert.deepEqual(leadSourceIds("sök på arxiv efter artiklar om linux"), ["arxiv"]);
  });

  test("an ordinary question leads nothing — the common case is unchanged", () => {
    for (const s of [
      "what does the latest research say about llm swarm reasoning",
      "who won the election",
      "",
      null,
    ]) {
      assert.deepEqual(leadSourceIds(s), []);
    }
  });

  test("naming a second place to look stands the lead down", () => {
    assert.deepEqual(leadSourceIds("check arxiv and the web for this"), []);
  });
});

describe("sourcePromptNotes", () => {
  test("concatenates every declared note (hf's referent note included)", () => {
    const notes = sourcePromptNotes();
    assert.match(notes, /"HF"\/"hf" in a user message means Hugging Face/);
  });

  test("a null capability composes every note — the MCP channel, unchanged", () => {
    // Null means "no agent was resolved", which is not "an agent declared
    // nothing": src/mcp.js builds its state without a registry, and a
    // deployment whose registry will not load resolves nothing either. Both
    // keep the pre-2026-08-13 prompt byte for byte.
    assert.equal(sourcePromptNotes(null), sourcePromptNotes());
    assert.equal(sourcePromptNotes(undefined), sourcePromptNotes());
  });

  test("a capability's notes cover exactly the sources it may consult", () => {
    // The planner is taught the vocabulary of a corpus only when the answering
    // agent can actually reach it (owner directive, 2026-08-13). Teaching
    // "arXiv means arxiv.org, never clarify it" to an agent forbidden to search
    // arXiv spends triage's attention shaping queries for a leg that will never
    // run, and invites a plan that promises sources the answer cannot cite.
    const restricted = sourcePromptNotes({ context: [] });
    const full = sourcePromptNotes(null);
    for (const s of SEARCH_SOURCES) {
      if (!s.promptNote) continue;
      assert.ok(full.includes(s.promptNote), `${s.id}: its note is missing from the unrestricted prompt`);
      assert.equal(
        restricted.includes(s.promptNote),
        !s.requiresContext,
        `${s.id}: an agent declaring no context blocks must get the notes of exactly the unrestricted sources`,
      );
    }
    // …and declaring the block puts that source's note back.
    for (const s of SEARCH_SOURCES) {
      if (!s.requiresContext || !s.promptNote) continue;
      assert.ok(
        sourcePromptNotes({ context: [s.requiresContext] }).includes(s.promptNote),
        `${s.id}: declaring "${s.requiresContext}" must restore its planner note`,
      );
    }
  });
});

describe("capabilityAllowsSource", () => {
  test("a source declaring no requirement runs for everyone, as before", () => {
    for (const s of SEARCH_SOURCES) {
      if (s.requiresContext) continue;
      assert.equal(capabilityAllowsSource({ context: [] }, s), true, `${s.id}`);
      assert.equal(capabilityAllowsSource({ context: ["something-else"] }, s), true, `${s.id}`);
    }
  });

  test("a declared requirement is enforced against the agent's context blocks", () => {
    for (const s of SEARCH_SOURCES) {
      if (!s.requiresContext) continue;
      assert.equal(capabilityAllowsSource({ context: [] }, s), false, `${s.id}: ungated`);
      assert.equal(capabilityAllowsSource({ context: ["unrelated"] }, s), false, `${s.id}: wrong block admitted it`);
      assert.equal(capabilityAllowsSource({ context: [s.requiresContext] }, s), true, `${s.id}: declared and refused`);
    }
  });

  test("a NULL capability keeps every source — invariant 2, and the MCP door", () => {
    // The fail-soft rule, and the one deliberate hole in the roster's reach: a
    // POST /mcp call that names no agent resolves none, so its literature door
    // is ungoverned (src/mcp.js resolves `deep_research`'s optional `agent`
    // argument through the registry; without one the capability is null), and
    // the ground-truth batteries reach both corpora that way. A deployment
    // whose registry will not load takes the same path, because an outage that
    // looks like an empty answer is the worst possible reading of "the agent
    // declared nothing".
    for (const s of SEARCH_SOURCES) {
      assert.equal(capabilityAllowsSource(null, s), true, `${s.id}: null capability`);
      assert.equal(capabilityAllowsSource(undefined, s), true, `${s.id}: missing capability`);
    }
  });
});

describe("platformDiversityKey", () => {
  test("returns the declared key for a claimed platform host", () => {
    assert.equal(
      platformDiversityKey("huggingface.co", "https://huggingface.co/KBLab/kb-whisper-large"),
      "huggingface.co/KBLab",
    );
  });

  test("returns null for unclaimed hosts (→ hostname keying)", () => {
    assert.equal(platformDiversityKey("bbc.com", "https://bbc.com/news"), null);
  });
});
