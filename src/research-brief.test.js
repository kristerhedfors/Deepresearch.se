// The research brief where it meets the Worker: the façade, the prompt-set
// binding, and — the reason this file exists rather than everything living in
// public/js/research-brief-core.test.js — the SWEDISH PARITY that crosses the
// src/ seam.
//
// Invariant 6 is a rule about deterministic routing, and on the tool path the
// routing has moved into the model. What is left deterministic is the pair of
// functions that read the user's message and hand the brief its hints:
// `leadSourceIds` (which source did the message NAME as the place to look) and
// `sourcePromptNotes` (that registry's own bilingual query vocabulary). Their
// regexes are parity-tested where they live, in src/search-sources.test.js.
// What is tested HERE is the seam: that a Swedish message and its English twin
// produce the SAME brief, so nothing about the language survives into what the
// model is told to do. The pure core's own suite cannot assert this — a browser
// core does not import the Worker's registry, and its test file stays as
// browser-side as the core.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { BRIEF_EXEMPLARS, REPORT_TIER_STRUCTURE, briefFingerprint, researchBrief } from "./research-brief.js";
import * as core from "../public/js/research-brief-core.js";
import { SEARCH_SOURCES, leadSourceIds, sourcePromptNotes } from "./search-sources.js";
import { PROMPT_BUILDERS, phasePrompt } from "./prompt-sets.js";
import { PROMPT_ROLES, PROMPT_SETS } from "./agent-spec.js";

const BASE = { tier: "standard", tools: ["web_search", "read_pages", "source_search"], maxRounds: 8, maxCalls: 6 };

/** The brief exactly as a request would build it: hints computed from the
 * user's own message by the same functions the deterministic gates used. */
const briefFor = (message, cap = null) =>
  researchBrief({ ...BASE, capability: cap, leadHints: leadSourceIds(message), sourceNotes: sourcePromptNotes(cap) });

describe("the façade IS the core", () => {
  test("no re-implementation, no wrapper", () => {
    // src/facade-contract.test.js discovers this pair and asserts the same
    // thing repo-wide; pinning it here too costs nothing and makes the failure
    // land in this module's own suite.
    assert.equal(researchBrief, core.researchBrief);
    assert.equal(briefFingerprint, core.briefFingerprint);
    assert.equal(BRIEF_EXEMPLARS, core.BRIEF_EXEMPLARS);
    assert.equal(REPORT_TIER_STRUCTURE, core.REPORT_TIER_STRUCTURE);
  });

  test("the report tiers are the ones synthesis writes, not a second set", () => {
    // The whole reason the tier table moved into the core: the deterministic
    // answer and the tool-driven answer must be the same report by
    // construction. If synthPrompt ever stops splicing this exact string the
    // two paths have forked, and a comment saying they match would not notice.
    assert.deepEqual(Object.keys(REPORT_TIER_STRUCTURE).sort(), ["brief", "extended", "full", "standard"]);
    for (const tier of Object.keys(REPORT_TIER_STRUCTURE)) {
      assert.ok(researchBrief({ ...BASE, tier }).includes(REPORT_TIER_STRUCTURE[tier]), tier);
    }
  });
});

describe("Swedish language parity", () => {
  // Each row is the same request twice. The pairs are the ones the registry's
  // own gates recognise (src/search-sources.test.js), extended with definite
  // forms and a common misspelling, because invariant 6 asks for the same
  // BREADTH in both languages and a gate that only takes the dictionary form
  // fails on how people actually write.
  const PAIRS = [
    ["find arXiv research mentioning linux", "sök på arxiv efter artiklar om linux"],
    ["search arxiv for papers on graph neural networks", "leta på arxiv efter artiklar om grafneurala nätverk"],
    ["what preprints exist on arxiv about diffusion models", "vilka preprints finns på arxiv om diffusionsmodeller"],
    ["look on pubmed for trials of metformin in ageing", "sök på pubmed efter studier om metformin och åldrande"],
    ["search google scholar for citations of this paper", "sök på google scholar efter citeringar av den här artikeln"],
    ["what does the latest research say about swarm reasoning", "vad säger den senaste forskningen om svärmresonemang"],
  ];

  test("the same request in either language names the same lead sources", () => {
    for (const [en, sv] of PAIRS) {
      assert.deepEqual(leadSourceIds(sv), leadSourceIds(en), `"${sv}" vs "${en}"`);
    }
  });

  test("and therefore produces a byte-identical brief", () => {
    // This is the assertion the invariant reduces to on this path. The model
    // chooses its own tools, so the ONLY way the user's language can change
    // which sources get consulted is through these hints — and it does not.
    for (const [en, sv] of PAIRS) {
      assert.equal(briefFor(sv), briefFor(en), `"${sv}" vs "${en}"`);
      assert.equal(briefFingerprint(briefFor(sv)), briefFingerprint(briefFor(en)));
    }
  });

  test("a named source really does reach the brief — the parity is not vacuous", () => {
    // Without this, two briefs could match because neither carries a hint at
    // all, and the test above would pass on a builder that ignored leadHints.
    const [en, sv] = PAIRS[0];
    assert.deepEqual(leadSourceIds(en), ["arxiv"]);
    for (const m of [en, sv]) assert.match(briefFor(m), /names arxiv as the place to look, so search there FIRST/);
    // An ordinary question in either language leads nothing, which is the
    // common case and the one where nothing about the turn changes.
    const [plainEn, plainSv] = PAIRS[PAIRS.length - 1];
    for (const m of [plainEn, plainSv]) assert.ok(!briefFor(m).includes("as the place to look"));
  });

  test("the registry's bilingual query vocabulary reaches the model that now routes", () => {
    // The deterministic gate that used to shape a Swedish message into an
    // English query is not running any more; the note that TAUGHT it that is
    // the thing which has to arrive instead. Verbatim, not paraphrased.
    const notes = sourcePromptNotes(null);
    const brief = briefFor("sök på arxiv efter artiklar om linux");
    assert.ok(brief.includes(notes.trim()), "every declared source note is spliced in");
    for (const s of SEARCH_SOURCES) {
      if (s.promptNote) assert.ok(brief.includes(s.promptNote.trim()), `${s.id}'s note is missing`);
    }
    assert.match(brief, /Swedish-worded queries find nothing there/);
  });

  test("the brief states both language decisions itself, in both directions", () => {
    const brief = briefFor("vad säger den senaste forskningen om svärmresonemang");
    assert.match(brief, /a Swedish question gets a Swedish answer/);
    assert.match(brief, /Write each QUERY in the language the material you are searching is written in/);
  });

  test("a capability that may not reach a source is not taught its vocabulary", () => {
    // The 2026-08-13 rule, carried across: teaching a self-selecting model the
    // query grammar of a corpus it will be refused at admission is worse than
    // teaching it nothing — it plans a leg that cannot run.
    const restricted = /** @type {any} */ ({ context: [], search: { web: true, auxSources: true, maxQueries: null } });
    const brief = briefFor("sök på arxiv efter artiklar om linux", restricted);
    for (const s of SEARCH_SOURCES) {
      if (!s.promptNote) continue;
      assert.equal(
        brief.includes(s.promptNote.trim()),
        !s.requiresContext,
        `${s.id}: a restricted agent gets the notes of exactly the unrestricted sources`,
      );
    }
  });

  test("Swedish text in the hints is not folded away by the fingerprint", () => {
    // The JS \b trap's cousin: a hash over the low byte alone would make å and
    // ä indistinguishable from their Latin neighbours, so a Swedish-only edit
    // to a source note would slip past the pin that exists to catch edits.
    const a = researchBrief({ ...BASE, sourceNotes: "skriv frågan på engelska" });
    const b = researchBrief({ ...BASE, sourceNotes: "skriv fragan pa engelska" });
    assert.notEqual(briefFingerprint(a), briefFingerprint(b));
  });
});

describe("the prompt-set binding", () => {
  test("the research set fills the two tool-path roles with the brief", () => {
    assert.equal(PROMPT_BUILDERS.research.brief, researchBrief);
    assert.equal(PROMPT_BUILDERS.research["answer-tools"], researchBrief);
  });

  test("`brief` is a declared role of the closed vocabulary", () => {
    // A binding for a role the pure core does not declare would fail
    // prompt-sets.test.js's coverage check; asserting it here says which change
    // is missing rather than that a count is off.
    assert.ok(PROMPT_ROLES.includes("brief"));
    assert.ok(PROMPT_SETS.research.roles.includes("brief"));
    assert.ok(PROMPT_SETS.research.roles.includes("answer-tools"));
  });

  test("resolution reaches it from a request state, however the state is spelled", () => {
    for (const state of [undefined, {}, { promptSet: "research" }, { promptSet: "nonsense" }]) {
      assert.equal(phasePrompt(state, "research", "brief"), researchBrief);
      assert.equal(phasePrompt(state, "research", "answer-tools"), researchBrief);
    }
  });
});
