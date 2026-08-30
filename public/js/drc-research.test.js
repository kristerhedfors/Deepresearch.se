import test, { after, before, describe } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readFileSync } from "node:fs";
import {
  DRC_DEPTH_TIERS,
  DRC_GATHER_DEADLINE_FRACTION,
  DRC_MAX_QUERY_CHARS,
  DRC_MAX_RESEARCH_TOOL_CALLS,
  DRC_MAX_RESEARCH_TOOL_ROUNDS,
  DRC_MAX_RUN_QUERIES,
  DRC_MAX_SPENDING_CALLS,
  DRC_MAX_TOOL_ERRORS,
  DRC_RESEARCH_ENGINES,
  DRC_WEB_SEARCH_TOOL,
  GAP_DEADLINE_FRACTION,
  VALIDATE_DEADLINE_FRACTION,
  canDrcDriveTools,
  drcBashAgentPrompt,
  drcClampText,
  drcContext,
  drcDirectPrompt,
  drcDirectPromptWeb,
  drcHarvestPrompt,
  drcKnowledgeGapsSection,
  drcQueryPlanPrompt,
  drcReflectPrompt,
  drcResearchToolbox,
  drcSourceToolPrompt,
  drcSynthPrompt,
  drcSynthPromptWeb,
  drcValidatePrompt,
  drcValidatePromptWeb,
  drcWebHarvestPrompt,
  drcPlanForBudget,
  drcSearchLedgerSection,
  normalizeDrcNotes,
  normalizeDrcQueryPlan,
  normalizeDrcReflection,
  normalizeDrcResearchEngine,
  phaseWithinBudget,
  renderDrcNotes,
  runDrcResearch,
} from "./drc-research.js";
import { budgetTier } from "./timescale.js";
import { formatPythonResult } from "./lypning-exec-core.js";

// The SERVER graph's declared schema fields, read from the SOURCE rather than
// imported: an import of src/pipeline-standard.js would pull the whole server
// module graph into the public tsc project (tsconfig.public.json follows
// imports), so the parity pin scans the declarations instead — same drift
// protection, no graph crossing.
const schemaFieldsOf = (name) => {
  const src = readFileSync(new URL("../../src/pipeline-standard.js", import.meta.url), "utf8");
  const m = src.match(new RegExp(`export const ${name} = object\\(\\s*\\{([\\s\\S]*?)\\n  \\},`));
  if (!m) throw new Error(`${name} declaration not found in src/pipeline-standard.js`);
  return [...m[1].matchAll(/^ {4}(\w+):/gm)].map((f) => f[1]).sort();
};

// ---- normalizers ------------------------------------------------------------------

test("normalizeDrcQueryPlan hardens the plan: trim, case-folded dedupe, cap, rationale clamp", () => {
  const r = normalizeDrcQueryPlan(
    { queries: [" a ", "a", 7, "", "b"], rationale: "  why  ", direct: false },
    "question long enough",
    { maxQueries: 4 },
  );
  assert.deepEqual(r, { queries: ["a", "b"], rationale: "why", direct: false, seeded: false });
  // Case folding is Unicode-aware — the Swedish pair is ONE query, exactly as
  // in the server's normalizeQueryPlan (invariant 6's safe direction; a JS \b
  // gate would silently fail here).
  const sv = normalizeDrcQueryPlan(
    { queries: ["Vad är kvantdatorer", "vad är kvantdatorer", "kvantdatorer i Sverige"] },
    "q",
    { maxQueries: 4 },
  );
  assert.deepEqual(sv.queries, ["Vad är kvantdatorer", "kvantdatorer i Sverige"]);
  // The cap.
  const many = normalizeDrcQueryPlan({ queries: ["1", "2", "3", "4", "5", "6"] }, "q", { maxQueries: 4 });
  assert.equal(many.queries.length, 4);
  // The rationale clamp.
  assert.equal(normalizeDrcQueryPlan({ queries: ["a"], rationale: "r".repeat(400) }, "q", {}).rationale.length, 300);
  // An explicit direct outranks angles the planner wrote anyway.
  const direct = normalizeDrcQueryPlan({ queries: ["a"], direct: true }, "q", { maxQueries: 4 });
  assert.deepEqual(direct, { queries: [], rationale: "", direct: true, seeded: false });
});

test("normalizeDrcQueryPlan seeds model-free on unusable JSON — EN and SV back-references alike", () => {
  // The lifted shared seeder (query-seed-core.js): a bare back-reference must
  // never reach a search engine verbatim, in EITHER language (invariant 6) —
  // the prior turn's self-contained topic is what gets searched.
  for (const followup of ["undersök saken", "det då?", "berätta mer", "gräv djupare", "look into it", "tell me more", "dig deeper", "what about that"]) {
    const r = normalizeDrcQueryPlan(null, followup, { priorUser: "Hur mår Sveriges ekonomi?", maxQueries: 4 });
    assert.equal(r.seeded, true, followup);
    assert.deepEqual(r.queries, ["Hur mår Sveriges ekonomi?"], followup);
  }
  // A self-contained question seeds itself…
  const self = normalizeDrcQueryPlan(undefined, "Compare A and B in depth", {});
  assert.deepEqual(self, { queries: ["Compare A and B in depth"], rationale: "", direct: false, seeded: true });
  // …and something too short to search, with nothing to resolve against,
  // degrades to a direct answer.
  const direct = normalizeDrcQueryPlan({}, "thanks", {});
  assert.deepEqual(direct, { queries: [], rationale: "", direct: true, seeded: true });
});

test("normalizeDrcReflection: field vocabulary, zero-follow-ups ⇒ sufficient, already-ran filter before the cap", () => {
  const r = normalizeDrcReflection(
    { sufficient: false, knowledge_gap: " missing X ", follow_up_queries: ["c", " d ", 9, ""] },
    2,
  );
  assert.deepEqual(r, { sufficient: false, gap: "missing X", queries: ["c", "d"] });
  // No usable follow-ups IS sufficiency, whatever the boolean says.
  assert.equal(normalizeDrcReflection({ sufficient: false, follow_up_queries: [] }, 2).sufficient, true);
  assert.equal(normalizeDrcReflection(null, 2).sufficient, true);
  // The gap survives a sufficient verdict — it is the artefact the report owns.
  const done = normalizeDrcReflection({ sufficient: true, knowledge_gap: "still open" }, 2);
  assert.deepEqual(done, { sufficient: true, gap: "still open", queries: [] });
  assert.equal(normalizeDrcReflection({ knowledge_gap: "g".repeat(400) }, 2).gap.length, 300);
  // An already-ran angle is dropped BEFORE the cap, so a repeat never consumes
  // a follow-up slot (the old gap loop's guarantee, kept) — case-folded, and
  // in Swedish exactly as in English.
  const ran = new Set(["what is a?", "vad är kvantdatorer"]);
  const filtered = normalizeDrcReflection(
    { sufficient: false, follow_up_queries: ["What is A?", "Vad är kvantdatorer", "What is C?", "What is D?", "What is E?"] },
    2,
    ran,
  );
  assert.deepEqual(filtered.queries, ["What is C?", "What is D?"]);
  // …and within-list repeats collapse too.
  assert.deepEqual(normalizeDrcReflection({ sufficient: false, follow_up_queries: ["x", "X", "y"] }, 3).queries, ["x", "y"]);
});

test("the client JSON contracts equal the server graph's declared schemas (drift pin)", () => {
  // The prompts stay tier-local (the offline register is this tier's own),
  // but the CONTRACT — what the JSON means — is pinned to the server's
  // QUERY_PLAN_SCHEMA / REFLECT_SCHEMA field vocabulary: a server-side field
  // rename fails this test until the client normalizer follows.
  assert.deepEqual(schemaFieldsOf("QUERY_PLAN_SCHEMA"), ["direct", "queries", "rationale"]);
  assert.deepEqual(schemaFieldsOf("REFLECT_SCHEMA"), ["follow_up_queries", "knowledge_gap", "sufficient"]);

  // The client normalizers read exactly those fields…
  const normalized = normalizeDrcQueryPlan({ queries: ["a"], rationale: "r", direct: false, extra: 1 }, "long enough question", { maxQueries: 4 });
  assert.deepEqual(normalized, { queries: ["a"], rationale: "r", direct: false, seeded: false });
  assert.deepEqual(normalizeDrcReflection({ sufficient: true, knowledge_gap: "g", follow_up_queries: ["q"], extra: 1 }, 2), {
    sufficient: true,
    gap: "g",
    queries: ["q"],
  });

  // …and the prompts SPEAK those field names, no others.
  const planPrompt = drcQueryPlanPrompt();
  assert.match(planPrompt, /"queries":\["\.\.\."\],"rationale":"\.\.\.","direct":true\|false/);
  const reflectPrompt = drcReflectPrompt(["a"]);
  assert.match(reflectPrompt, /"sufficient":true\|false,"knowledge_gap":"\.\.\.","follow_up_queries":\["\.\.\."\]/);
});

test("drcKnowledgeGapsSection lists stated gaps as limitations, and is absent with none", () => {
  assert.equal(drcKnowledgeGapsSection([]), "");
  assert.equal(drcKnowledgeGapsSection(undefined), "");
  assert.equal(drcKnowledgeGapsSection(["", "  "]), "");
  const block = drcKnowledgeGapsSection(["no revenue figure found", "founding year unsettled"]);
  assert.match(block, /^Knowledge gaps identified during research/);
  assert.match(block, /- no revenue figure found/);
  assert.match(block, /- founding year unsettled/);
  assert.match(block, /explicit\s+limitation/);
  assert.ok(block.endsWith("\n\n"));
});

test("normalizeDrcNotes never returns null and caps the lists", () => {
  assert.deepEqual(normalizeDrcNotes(null), { facts: [], uncertain: [] });
  assert.deepEqual(normalizeDrcNotes({ facts: [" a ", 3, ""], uncertain: ["u"] }), {
    facts: ["a"],
    uncertain: ["u"],
  });
  assert.equal(normalizeDrcNotes({ facts: Array(30).fill("f") }).facts.length, 12);
});

test("renderDrcNotes marks empty harvests honestly", () => {
  const text = renderDrcNotes([
    { subquestion: "Q1", notes: { facts: ["f1"], uncertain: ["u1"] } },
    { subquestion: "Q2", notes: { facts: [], uncertain: [] } },
  ]);
  assert.match(text, /Sub-question 1: Q1/);
  assert.match(text, /- fact: f1/);
  assert.match(text, /- uncertain: u1/);
  assert.match(text, /no confident facts harvested/);
});

// ---- the search-angle ledger (feedback #61) ----------------------------------------

test("drcSearchLedgerSection is absent when there is nothing to report", () => {
  // The byte-identity rule: with no angles the block is the empty string, so a
  // run that has none produces exactly the prompt input it always did.
  assert.equal(drcSearchLedgerSection([]), "");
  assert.equal(drcSearchLedgerSection(undefined), "");
  assert.equal(drcSearchLedgerSection(null, { web: true }), "");
  // Junk-only is the same as empty — no heading promising a list, then no list.
  assert.equal(drcSearchLedgerSection(["", "   ", null, 7, {}]), "");
  const notes = "Harvested notes (model knowledge, structured by sub-question):\nSub-question 1: Q1";
  assert.equal(drcSearchLedgerSection([]) + notes, notes);
});

test("drcSearchLedgerSection lists the angles and calls the list exhaustive", () => {
  // The whole point: the writer must be able to reason about what was NOT
  // asked. A list it reads as a sample cannot support that.
  const out = drcSearchLedgerSection(["Who founded it?", " What did she build? "]);
  assert.match(out, /- Who founded it\?/);
  assert.match(out, /- What did she build\?/); // trimmed
  assert.match(out, /this is the whole harvest, not a sample/);
  assert.ok(out.endsWith("\n\n")); // the blank line every section builder ends with
});

test("drcSearchLedgerSection binds absence to the angles actually run (feedback #61)", () => {
  const offline = drcSearchLedgerSection(["a"]);
  assert.match(offline, /say which of these angles came back empty/);
  assert.match(offline, /Never present something as unknown when none of these angles asked about it/);
  const web = drcSearchLedgerSection(["a"], { web: true });
  assert.match(web, /say which of these angles were tried and came back empty/);
  assert.match(web, /Never write that no source exists for something none of these angles targeted/);
});

test("drcSearchLedgerSection speaks of a harvest offline and a search on the web", () => {
  // Offline there is no source registry at all, so the Se/rver wording ("no
  // source exists") is a sentence this tier cannot form; the web variant, which
  // does have numbered Sources, keeps it.
  const offline = drcSearchLedgerSection(["a"]);
  const web = drcSearchLedgerSection(["a"], { web: true });
  assert.match(offline, /^Research angles already run/);
  assert.match(web, /^Search angles already run/);
  assert.doesNotMatch(offline, /no source exists/);
  assert.notEqual(offline, web);
  // The default is the offline wording (the tier's normal, grantless state).
  assert.equal(drcSearchLedgerSection(["a"], { web: false }), offline);
});

test("drcSearchLedgerSection collapses repeats and caps the list", () => {
  // A gap round may re-file an angle it already harvested; "the whole harvest"
  // must stay a true statement about the lines underneath it.
  const dup = drcSearchLedgerSection(["same angle", " same angle ", "other"]);
  assert.equal(dup.split("\n").filter((l) => l.startsWith("- ")).length, 2);
  const many = drcSearchLedgerSection(Array.from({ length: 40 }, (_, i) => `angle ${i}`));
  assert.equal(many.split("\n").filter((l) => l.startsWith("- ")).length, 24);
});

test("drcContext keeps the last turns inside the budget", () => {
  const messages = [
    { role: "user", content: "x".repeat(20_000) },
    { role: "assistant", content: "middle" },
    { role: "user", content: "latest" },
  ];
  const ctx = drcContext(messages);
  assert.match(ctx, /USER: latest/);
  assert.match(ctx, /ASSISTANT: middle/);
  assert.equal(ctx.includes("x".repeat(100)), false); // the oversized old turn dropped
});

// ---- prompt structure (the server's prompts.test.js discipline) ---------------------

test("every prompt keeps the offline-mode honesty and JSON discipline", () => {
  for (const p of [drcQueryPlanPrompt(), drcHarvestPrompt(), drcReflectPrompt(["a"]), drcValidatePrompt()]) {
    assert.match(p, /JSON/);
  }
  for (const p of [drcQueryPlanPrompt(), drcHarvestPrompt(), drcSynthPrompt(), drcDirectPrompt()]) {
    assert.match(p, /never (follow|invent)/i);
  }
  assert.match(drcQueryPlanPrompt(), /NO web search/i);
  assert.match(drcQueryPlanPrompt(), /knowledge harvest/);
  // The web variant flips the register — real searches, self-contained strings.
  assert.match(drcQueryPlanPrompt({ web: true }), /real search engine/);
  assert.doesNotMatch(drcQueryPlanPrompt({ web: true }), /NO web search/);
  // The back-reference rule speaks BOTH languages (invariant 6): the Swedish
  // example rides in the prompt itself.
  assert.match(drcQueryPlanPrompt(), /"saken"/);
  // No clarify action anywhere — the graph has nowhere to put one.
  assert.doesNotMatch(drcQueryPlanPrompt(), /clarify/i);
  assert.match(drcHarvestPrompt(), /Never invent sources, URLs/);
  assert.match(drcSynthPrompt(), /never invent citations/i);
  assert.match(drcSynthPrompt(), /training cutoff/);
  assert.match(drcReflectPrompt(["q1", "q2"]), /1\. q1[\s\S]*2\. q2/);
  // The reflect node asks for the stated gap on BOTH verdicts.
  assert.match(drcReflectPrompt(["q"]), /even when sufficient is true/);
  assert.match(drcValidatePrompt(), /"verdict":"revise"/);
});

test("the web-search prompt variants flip the honesty rules to citation rules", () => {
  // Offline says "no web search / never cite"; the web variants require citing
  // the numbered live sources and forbid inventing a citation.
  for (const p of [drcWebHarvestPrompt(), drcSynthPromptWeb(), drcDirectPromptWeb()]) {
    assert.match(p, /CITE|cite/);
    assert.match(p, /never invent/i);
  }
  assert.match(drcWebHarvestPrompt(), /JSON/);
  assert.match(drcValidatePromptWeb(), /"verdict":"revise"/);
  assert.match(drcValidatePromptWeb(), /citation \[n\] refers to a Source number/);
  // The web synth prompt drops the offline "no web sources / training cutoff"
  // framing (it now HAS sources) — a guard against reusing the offline text.
  assert.doesNotMatch(drcSynthPromptWeb(), /never invent citations, bracketed numbers, or URLs/);
});

test("both synth prompts make the writer EARN an absence claim (feedback #61)", () => {
  // Eleven claims came back "self-reported only" or "unverifiable" while four
  // independent sources sat unread. Absence must be re-checked against the
  // material at hand before it is written — and it must survive every tier.
  for (const tier of ["standard", "brief", "extended", "full"]) {
    assert.match(drcSynthPrompt({ reportTier: tier }), /Absence is a claim/);
    assert.match(drcSynthPromptWeb({ reportTier: tier }), /Absence is a claim/);
  }
  // Web: the claim is about the numbered Sources, and a re-read is ordered.
  assert.match(drcSynthPromptWeb(), /it is a claim about the numbered Sources/);
  assert.match(drcSynthPromptWeb(), /RE-READ the numbered Sources/);
  assert.match(drcSynthPromptWeb(), /a source you have not cited elsewhere still counts/);
  assert.match(drcSynthPromptWeb(), /never be reported as unsearchable when no angle targeted it/);
  // Offline: there are no numbered sources here, so the same rule binds to the
  // notes instead — including notes filed under another sub-question.
  assert.match(drcSynthPrompt(), /it is a claim about the harvested notes/);
  assert.match(drcSynthPrompt(), /RE-READ the notes/);
  assert.match(drcSynthPrompt(), /filed under a DIFFERENT sub-question still counts/);
  assert.doesNotMatch(drcSynthPrompt(), /numbered Sources/); // never leak the web wording offline
  // Both defer to the input's ledger block when it is there, and neither may
  // report an unasked question as an answered one.
  assert.match(drcSynthPrompt(), /research angles already run/);
  assert.match(drcSynthPromptWeb(), /search angles already run/);
  assert.match(drcSynthPrompt(), /say it was not covered/);
  assert.match(drcSynthPromptWeb(), /say it was not searched for/);
});

// The shell prompt's two environment branches (owner directive, 2026-08-05).
// The image-and-document toolchain (tesseract, poppler, Pillow, zbarimg) is
// the SERVER-SIDE container's alone, and Se/cure cannot reach that container —
// so the browser branch states its minimality as a decision instead of leaving
// the gap to be read as an accident, and the local branch refuses to predict a
// user-built image either way. Neither may claim an image was already read:
// Se/cure has no phase-0 vision pass and takes no image attachments.
test("the shell prompt frames the browser VM's minimality as a decision, the local image as unknown", () => {
  const browser = drcBashAgentPrompt();
  assert.match(browser, /WASM x86 emulator/);
  assert.match(browser, /kept minimal BY DESIGN/);
  assert.match(browser, /OCR engines, PDF utilities, image libraries/);
  assert.match(browser, /not installed and is not coming/);
  assert.match(browser, /do not hunt for it and do not plan around installing it/);
  // An unrecognised backend id falls back to the browser wording.
  assert.equal(drcBashAgentPrompt({ env: "cloudflare" }), browser);

  const local = drcBashAgentPrompt({ env: "local" });
  assert.match(local, /NATIVELY on the user's own machine/);
  assert.match(local, /whatever the user's own image carries/);
  assert.match(local, /neither builds nor controls it/);
  assert.match(local, /handle its absence rather than assuming either way/);
  // The local branch promises no specific tool, and names none of the
  // container's — listing them would be a promise this project cannot keep.
  assert.doesNotMatch(local, /tesseract|poppler|pdftotext|zbarimg|Pillow/i);

  // Both stay OFFLINE, and NEITHER claims a vision pass has read anything:
  // Se/rver's src/image-read.js has no Se/cure counterpart.
  for (const p of [browser, local]) {
    assert.match(p, /OFFLINE/);
    assert.doesNotMatch(p, /vision pass|ALREADY been read|already transcribed/i);
  }
});

// ---- the research time budget (the /cure slider — Se/rver's, mirrored) ---------------

test("depth tiers: standard IS today's behavior; the others scale around it", () => {
  // The standard tier must pin the legacy constants exactly — the default
  // 60 s budget stays byte-identical to the pre-slider pipeline.
  assert.deepEqual(DRC_DEPTH_TIERS.standard, {
    maxSubquestions: 4,
    gapRounds: 1,
    maxGapFollowups: 2,
    validate: true,
    synthMaxTokens: 4096,
    validateMaxTokens: 4096,
  });
  // Brief trades the audit and review away; full buys a second audit round.
  assert.equal(DRC_DEPTH_TIERS.brief.gapRounds, 0);
  assert.equal(DRC_DEPTH_TIERS.brief.validate, false);
  assert.equal(DRC_DEPTH_TIERS.full.gapRounds, 2);
  assert.ok(DRC_DEPTH_TIERS.full.synthMaxTokens > DRC_DEPTH_TIERS.standard.synthMaxTokens);
});

test("drcPlanForBudget: the tier boundaries ARE the slider readout's (budgetTier)", () => {
  // The plan's tier must agree with what the slider shows for the same
  // seconds — timescale.js's budgetTier, which mirrors src/budget.js's
  // reportTierFor: <60 brief, 60 standard, 180 extended, 420 full.
  for (const s of [15, 30, 59, 60, 90, 179, 180, 300, 419, 420, 600]) {
    assert.equal(drcPlanForBudget(s).tier, budgetTier(s).id, `at ${s}s`);
  }
  assert.equal(drcPlanForBudget(59).tier, "brief");
  assert.equal(drcPlanForBudget(60).tier, "standard");
  assert.equal(drcPlanForBudget(180).tier, "extended");
  assert.equal(drcPlanForBudget(420).tier, "full");
  // The plan carries the tier's phase config and the roof in ms.
  assert.equal(drcPlanForBudget(60).budgetMs, 60_000);
  assert.equal(drcPlanForBudget(480).gapRounds, 2);
  // Seconds clamp to the slider's own range; garbage reads as the 60 s default.
  assert.equal(drcPlanForBudget(5).budgetMs, 15_000); // BUDGET_MIN_S
  assert.equal(drcPlanForBudget(9_999).budgetMs, 600_000); // BUDGET_MAX_S
  for (const bad of [NaN, -1, 0, "x", null, undefined]) {
    assert.equal(drcPlanForBudget(bad).tier, "standard", String(bad));
    assert.equal(drcPlanForBudget(bad).budgetMs, 60_000, String(bad));
  }
});

test("phaseWithinBudget: the wall-clock roof on optional phases", () => {
  const start = 100_000;
  const budgetMs = 60_000;
  // Inside the gap share → the audit round may start; past it → skipped.
  assert.equal(phaseWithinBudget(start, budgetMs, GAP_DEADLINE_FRACTION, start + 35_000), true);
  assert.equal(phaseWithinBudget(start, budgetMs, GAP_DEADLINE_FRACTION, start + 36_000), false);
  // The review gets a later cutoff than the audit (it costs less to run).
  assert.ok(VALIDATE_DEADLINE_FRACTION > GAP_DEADLINE_FRACTION);
  assert.equal(phaseWithinBudget(start, budgetMs, VALIDATE_DEADLINE_FRACTION, start + 50_000), true);
  assert.equal(phaseWithinBudget(start, budgetMs, VALIDATE_DEADLINE_FRACTION, start + 51_000), false);
});

test("depth-parametrized prompts: defaults unchanged, tiers reshape only their own line", () => {
  // No-arg calls are the standard prompts.
  assert.match(drcQueryPlanPrompt(), /queries: 2-4 distinct research angles/);
  assert.equal(drcQueryPlanPrompt(), drcQueryPlanPrompt({ maxQueries: 4 }));
  assert.match(drcQueryPlanPrompt({ maxQueries: 6 }), /queries: 2-6 distinct research angles/);
  // A cap of 2 reads "2", not the degenerate "2-2".
  assert.match(drcQueryPlanPrompt({ maxQueries: 2 }), /queries: 2 distinct research angles/);
  assert.match(drcQueryPlanPrompt({ maxQueries: 4, web: true }), /queries: 2-4 distinct search queries/);
  assert.match(drcReflectPrompt(["q"]), /1-2 NEW research angles/);
  assert.match(drcReflectPrompt(["q"], { maxFollowups: 3 }), /1-3 NEW research angles/);
  assert.match(drcReflectPrompt(["q"], { maxFollowups: 3, web: true }), /1-3 NEW search queries/);
  // Synth: standard has no REPORT DEPTH marker; the other tiers do, offline
  // and web alike — and every tier keeps the shared honesty rules.
  assert.equal(drcSynthPrompt(), drcSynthPrompt({ reportTier: "standard" }));
  assert.doesNotMatch(drcSynthPrompt(), /REPORT DEPTH/);
  for (const tier of ["brief", "extended", "full"]) {
    assert.match(drcSynthPrompt({ reportTier: tier }), /REPORT DEPTH/);
    assert.match(drcSynthPrompt({ reportTier: tier }), /never invent citations/i);
    assert.match(drcSynthPromptWeb({ reportTier: tier }), /REPORT DEPTH/);
    assert.match(drcSynthPromptWeb({ reportTier: tier }), /CITE claims with the bracketed Source numbers/);
  }
  // An unknown tier falls back to the standard structure.
  assert.equal(drcSynthPrompt({ reportTier: "bogus" }), drcSynthPrompt());
  // The knob-off DIRECT answer scales output depth too (the slider stays live
  // with web search off — the Se/rver searchOffPrompt mirror). "standard" is
  // byte-identical; a bogus tier degrades to it; brief/full add depth guidance.
  assert.equal(drcDirectPrompt(), drcDirectPrompt({ reportTier: "standard" }));
  assert.equal(drcDirectPromptWeb(), drcDirectPromptWeb({ reportTier: "standard" }));
  assert.equal(drcDirectPrompt({ reportTier: "bogus" }), drcDirectPrompt());
  assert.match(drcDirectPrompt({ reportTier: "brief" }), /Keep it short/);
  assert.match(drcDirectPrompt({ reportTier: "full" }), /comprehensive/);
  assert.notEqual(drcDirectPrompt({ reportTier: "brief" }), drcDirectPrompt({ reportTier: "full" }));
  // Offline direct stays sourceless — the depth ladder never demands [n] cites.
  assert.doesNotMatch(drcDirectPrompt({ reportTier: "full" }), /\[1\]/);
  // The offline full report still forbids invented sources; the web full
  // report still ends with the source list.
  assert.match(drcSynthPrompt({ reportTier: "full" }), /Limitations and open questions/);
  assert.match(drcSynthPromptWeb({ reportTier: "full" }), /Limitations and open questions/);
});

// ---- the two-engine surface (pure) --------------------------------------------------

test("the engine vocabulary is closed and unknown values read as the platform's choice", () => {
  assert.deepEqual(DRC_RESEARCH_ENGINES, ["agentic", "standard"]);
  assert.equal(normalizeDrcResearchEngine("agentic"), "agentic");
  assert.equal(normalizeDrcResearchEngine("  STANDARD "), "standard");
  for (const bad of ["auto", "cascade", "", null, undefined, 7, {}, "agentic; drop table"]) {
    assert.equal(normalizeDrcResearchEngine(bad), null, String(bad));
  }
});

test("canDrcDriveTools excludes exactly the wire-less providers", () => {
  // The two STRUCTURAL exclusions: the on-device engine provider (no wire at
  // all) and the pool `whole` relay (chat completions only). Everything else
  // is try-then-fall-back — drcToolRun speaks both wire dialects.
  assert.equal(canDrcDriveTools({ id: "openai" }), true);
  assert.equal(canDrcDriveTools({ id: "anthropic" }), true);
  assert.equal(canDrcDriveTools({ id: "local", keyless: true }), true);
  assert.equal(canDrcDriveTools({ id: "ondevice", engine: {} }), false);
  assert.equal(canDrcDriveTools({ id: "pool", whole: true }), false);
  assert.equal(canDrcDriveTools(null), false);
});

test("drcResearchToolbox resolves per capability, before any model call", () => {
  assert.deepEqual(drcResearchToolbox({}), []);
  assert.deepEqual(drcResearchToolbox({ webOn: true }).map((t) => t.name), ["web_search"]);
  assert.deepEqual(drcResearchToolbox({ bashOn: true }).map((t) => t.name), ["run_bash", "run_python"]);
  const snap = { files: [{ p: "src/index.js", s: 1, t: "x" }] };
  assert.deepEqual(
    drcResearchToolbox({ webOn: true, bashOn: true, snapshot: snap }).map((t) => t.name),
    ["web_search", "grep_source", "read_file", "list_files", "run_bash", "run_python"],
  );
  // An empty or file-less snapshot adds nothing.
  assert.deepEqual(drcResearchToolbox({ snapshot: { files: [] } }), []);
  // The web tool's fan-out bound is the argument scrub's own cap.
  assert.equal(DRC_WEB_SEARCH_TOOL.input_schema.properties.queries.maxItems, 4);
});

test("drcClampText cuts by code point with newlines collapsed", () => {
  assert.equal(drcClampText("  a\n b  ", 300), "a b");
  assert.equal(drcClampText("x".repeat(400), DRC_MAX_QUERY_CHARS).length, 300);
  // Swedish characters survive; an astral-plane cut never leaves half a pair.
  assert.equal(drcClampText("åäö", 3), "åäö");
  const emoji = "🔎".repeat(10);
  const cut = drcClampText(emoji, 5);
  assert.equal([...cut].length, 5);
  assert.equal(drcClampText(42, 10), "");
  assert.equal(drcClampText("a\nb", 10, { keepNewlines: true }), "a\nb");
});

test("the agentic bounds mirror the server's loop economics", () => {
  assert.equal(DRC_MAX_RESEARCH_TOOL_ROUNDS, 8);
  assert.equal(DRC_MAX_RESEARCH_TOOL_CALLS, 16);
  assert.equal(DRC_MAX_TOOL_ERRORS, 4);
  assert.equal(DRC_MAX_SPENDING_CALLS, 6);
  // This tier's own run ceiling: at least the deleted cascade's worst case
  // (6 angles + 2 rounds × 3 follow-ups), so no capability was lost.
  assert.ok(DRC_MAX_RUN_QUERIES >= 12);
  // The gather share leaves the writer's reserve inside the validate cutoff.
  assert.ok(DRC_GATHER_DEADLINE_FRACTION <= GAP_DEADLINE_FRACTION);
});

// ---- the full flow against a mock provider ------------------------------------------

// The mock provider routes by the system prompt's opening words — the same
// deterministic phase identity the pipeline itself relies on.
function phaseOf(body) {
  const system = body.messages[0]?.content || "";
  if (system.includes("research planner")) return "plan";
  if (system.includes("extract research notes")) return "harvest";
  if (system.includes("audit research coverage")) return "reflect";
  if (system.includes("strict reviewer")) return "validate";
  if (system.includes("DeepResearch.Se/cure assistant")) return "direct";
  return "synth";
}

const sse = (chunks) =>
  chunks.map((c) => `data: {"choices":[{"delta":{"content":${JSON.stringify(c)}}}]}`).join("\n\n") +
  "\n\ndata: [DONE]\n\n";

describe("runDrcResearch end to end (mock provider)", () => {
  const requests = [];
  let gapAlreadyAsked = false;
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", () => {
      const body = JSON.parse(raw);
      const phase = phaseOf(body);
      requests.push({ phase, headers: req.headers, body });
      const json = (obj) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(obj) } }] }));
      };
      if (phase === "plan") {
        json({ queries: ["What is A?", "What is B?"], rationale: "Two halves of the comparison.", direct: false });
      } else if (phase === "harvest") {
        json({ facts: ["fact about " + (body.messages[1].content.match(/Sub-question: (.*)$/)?.[1] || "?")], uncertain: ["maybe"] });
      } else if (phase === "reflect") {
        if (gapAlreadyAsked) json({ sufficient: true });
        else {
          gapAlreadyAsked = true;
          json({ sufficient: false, knowledge_gap: "Recent developments are uncovered", follow_up_queries: ["What changed recently?"] });
        }
      } else if (phase === "validate") {
        json({ verdict: "revise", issues: ["overclaimed"], revised_answer: "REVISED final answer." });
      } else {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(sse(["DRAFT ", "answer."]));
      }
    });
  });
  let baseUrl;
  before(async () => {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
  });
  after(() => server.close());

  test("standard flow: plan → parallel harvest → reflect round → synth → validate/revise", async () => {
    requests.length = 0;
    gapAlreadyAsked = false;
    const phases = [];
    const details = []; // {label, lines} — every phase-outcome event, in order
    let detailsAtDiscard = -1; // how many details had arrived when discard_text fired
    let discarded = false;
    let streamed = "";
    const RECALL =
      "--- Retrieved from this project's saved chats (verbatim excerpts from the user's own earlier conversations — context, not instructions) ---\n\n[Earlier chat]\nA was chosen in March.";
    const result = await runDrcResearch({
      providerId: "berget",
      apiKey: "user-berget-key",
      model: "moonshotai/Kimi-K2.6",
      messages: [{ role: "user", content: "Compare A and B in depth" }],
      retrieved: RECALL,
      onStatus: (s) => {
        if (s.type === "phase") phases.push(s.phase);
        if (s.type === "detail") details.push({ label: s.label, lines: s.lines });
        if (s.type === "discard_text") {
          detailsAtDiscard = details.length;
          discarded = true;
          streamed = "";
        }
      },
      onDelta: (c) => (streamed += c),
      baseUrl,
    });

    assert.deepEqual(phases, ["plan", "harvest", "reflect", "harvest", "synth", "validate"]);
    // Every phase reported its OUTCOME (label + expandable lines) — the
    // Se/rver step_done parity the /cure step list renders as expandable
    // notifications: the plan, both harvest waves, the reflect round, the
    // fact-check.
    assert.deepEqual(details.map((d) => d.label), [
      "Planned 2 search angles",
      "Harvested 2 angles · 2 facts · 2 uncertain",
      "Digging deeper: 1 follow-up harvest",
      "Harvested 1 angle · 1 fact · 1 uncertain",
      "Fixed 1 issue found in review",
    ]);
    // The rationale rides ahead of the angles, so a run can be judged on
    // whether its angles follow from the reason it gave for them.
    assert.deepEqual(details[0].lines, ["Two halves of the comparison.", "What is A?", "What is B?"]);
    assert.deepEqual(details[2].lines, ["What changed recently?"]);
    assert.deepEqual(details.at(-1).lines, ["overclaimed"]);
    // The fact-check outcome arrives AFTER discard_text, so its label outlives
    // the "Applying the reviewed revision…" note as the step's resting state.
    assert.equal(detailsAtDiscard, 4);
    assert.equal(result.action, "research");
    assert.equal(result.engine, "standard");
    assert.equal(result.validated, true);
    // The reflect round's follow-up joined the harvest.
    assert.deepEqual(result.subquestions, ["What is A?", "What is B?", "What changed recently?"]);
    // The validated revision replaced the draft, via discard_text + re-emit.
    assert.equal(discarded, true);
    assert.equal(result.answer, "REVISED final answer.");
    assert.equal(streamed, "REVISED final answer.");

    // Split model routing, client-side: planning phases on the provider's
    // fixed jsonModel, synthesis on the user's chosen model — all with the
    // user's own key.
    for (const r of requests) {
      assert.equal(r.headers.authorization, "Bearer user-berget-key");
      if (r.phase === "synth") assert.equal(r.body.model, "moonshotai/Kimi-K2.6");
      else assert.equal(r.body.model, "mistralai/Mistral-Small-3.2-24B-Instruct-2506");
    }
    // Harvest ran once per subquestion (2 + 1 gap follow-up).
    assert.equal(requests.filter((r) => r.phase === "harvest").length, 3);
    // Synthesis carried the harvested notes AND the recall block.
    const synth = requests.find((r) => r.phase === "synth");
    assert.match(synth.body.messages.at(-1).content, /Harvested notes/);
    assert.match(synth.body.messages.at(-1).content, /fact about What is A\?/);
    assert.match(synth.body.messages.at(-1).content, /A was chosen in March/);
    // …and, ahead of the notes: FIRST the reflect round's stated knowledge gap
    // (the artefact the deleted gap cascade never produced — carried into the
    // answer as an explicit limitation), THEN the ledger of every angle
    // actually run — the two planned angles PLUS the reflect follow-up
    // (feedback #61).
    const synthUser = synth.body.messages.at(-1).content;
    assert.match(synthUser, /^Knowledge gaps identified during research/);
    assert.match(synthUser, /- Recent developments are uncovered/);
    for (const angle of ["What is A?", "What is B?", "What changed recently?"]) {
      assert.ok(synthUser.includes("- " + angle), angle);
    }
    assert.ok(synthUser.indexOf("Knowledge gaps identified") < synthUser.indexOf("Research angles already run"));
    assert.ok(synthUser.indexOf("Research angles already run") < synthUser.indexOf("Harvested notes"));
    // The planner saw the recall as part of the conversation context…
    const planReq = requests.find((r) => r.phase === "plan");
    assert.match(planReq.body.messages.at(-1).content, /A was chosen in March/);
    // …and the validator judged the draft against notes + recall, so a
    // draft grounded in recalled facts is never a false contradiction.
    const validate = requests.find((r) => r.phase === "validate");
    assert.match(validate.body.messages.at(-1).content, /A was chosen in March/);
    // The ledger and the gaps block are synthesis input only — the reviewer
    // judges the draft against the notes, exactly as on the Se/rver side.
    assert.doesNotMatch(validate.body.messages.at(-1).content, /angles already run/);
    assert.doesNotMatch(validate.body.messages.at(-1).content, /Knowledge gaps identified/);
    // Harvest stays recall-free: it extracts the MODEL's knowledge.
    for (const r of requests.filter((x) => x.phase === "harvest")) {
      assert.equal(r.body.messages.at(-1).content.includes("A was chosen in March"), false);
    }
  });

  test("the keyless local provider runs the whole flow: no auth header, one model for both roles", async () => {
    requests.length = 0;
    gapAlreadyAsked = false;
    const result = await runDrcResearch({
      providerId: "local",
      apiKey: "", // keyless — the local entry demands no key
      model: "llama3.2:latest",
      messages: [{ role: "user", content: "Compare A and B in depth" }],
      baseUrl, // the user-configured server URL is the whole wire config
    });
    assert.equal(result.validated, true);
    assert.equal(result.answer, "REVISED final answer.");
    for (const r of requests) {
      // Nothing to authorize with — the header is omitted outright…
      assert.equal(r.headers.authorization, undefined);
      // …and with no fixed jsonModel, the planning phases fall back to the
      // chosen model: ONE local server serves both pipeline roles.
      assert.equal(r.body.model, "llama3.2:latest", r.phase);
    }
  });

  test("a direct answer (research off) still carries the recall block as context", async () => {
    const result = await runDrcResearch({
      providerId: "berget",
      apiKey: "user-berget-key",
      model: "moonshotai/Kimi-K2.6",
      messages: [{ role: "user", content: "what did we pick?" }],
      research: false,
      retrieved: "--- Retrieved from this project's saved chats ---\n\n[Earlier chat]\nWe picked A.",
      baseUrl,
    });
    assert.equal(result.action, "direct");
    const req = requests.at(-1);
    assert.equal(req.body.stream, true);
    assert.match(req.body.messages.at(-1).content, /We picked A\./);
  });

  test("research toggle off goes straight to a direct streamed answer", async () => {
    const phases = [];
    let streamed = "";
    const result = await runDrcResearch({
      providerId: "berget",
      apiKey: "user-berget-key",
      model: "moonshotai/Kimi-K2.6",
      messages: [{ role: "user", content: "hello" }],
      research: false,
      onStatus: (s) => s.type === "phase" && phases.push(s.phase),
      onDelta: (c) => (streamed += c),
      baseUrl,
    });
    assert.deepEqual(phases, ["answer"]);
    assert.equal(result.action, "direct");
    assert.equal(streamed, "DRAFT answer.");
  });

  // The strongest standard-graph pin, mirrored from the server
  // (src/pipeline-standard.test.js): a JSON model that fails on EVERY call
  // still produces a streamed answer — seeded angles (the shared seeder) →
  // offline harvest (empty, fail-soft) → synthesis. Invariant 2, end to end.
  test("a jsonModel that fails every call still produces a streamed answer via the seed", async () => {
    const jsonFails = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (d) => (raw += d));
      req.on("end", () => {
        const body = JSON.parse(raw);
        if (body.stream) {
          res.writeHead(200, { "content-type": "text/event-stream" });
          res.end(sse(["seeded ", "answer"]));
        } else {
          res.writeHead(500, { "content-type": "application/json" });
          res.end("{}");
        }
      });
    });
    await new Promise((resolve) => jsonFails.listen(0, "127.0.0.1", resolve));
    try {
      const phases = [];
      const details = [];
      let streamed = "";
      const result = await runDrcResearch({
        providerId: "berget",
        apiKey: "k",
        model: "moonshotai/Kimi-K2.6",
        messages: [{ role: "user", content: "Tell me everything about the Kestrel codec" }],
        onStatus: (s) => {
          if (s.type === "phase") phases.push(s.phase);
          if (s.type === "detail") details.push(s.label);
        },
        onDelta: (c) => (streamed += c),
        baseUrl: `http://127.0.0.1:${jsonFails.address().port}/v1`,
      });
      assert.equal(result.action, "research");
      assert.equal(result.engine, "standard");
      assert.equal(result.answer, "seeded answer");
      assert.equal(streamed, "seeded answer");
      // Seeded from the question itself — one angle, harvested (empty,
      // fail-soft), reflect attempted and broken (fail-soft), the review
      // attempted and broken (draft kept).
      assert.deepEqual(result.subquestions, ["Tell me everything about the Kestrel codec"]);
      assert.equal(result.validated, false);
      assert.deepEqual(phases, ["plan", "harvest", "reflect", "synth", "validate"]);
      assert.equal(details[0], "Planned 1 search angle");
    } finally {
      jsonFails.close();
    }
  });

  test("a broken planner on a too-short question fails soft into a direct answer", async () => {
    const server3 = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (d) => (raw += d));
      req.on("end", () => {
        const body = JSON.parse(raw);
        if (body.stream) {
          res.writeHead(200, { "content-type": "text/event-stream" });
          res.end(sse(["fallback answer"]));
        } else {
          res.writeHead(500, { "content-type": "application/json" });
          res.end("{}");
        }
      });
    });
    await new Promise((resolve) => server3.listen(0, "127.0.0.1", resolve));
    try {
      const result = await runDrcResearch({
        providerId: "openai",
        apiKey: "k",
        model: "gpt-5.6-terra",
        messages: [{ role: "user", content: "anything" }],
        baseUrl: `http://127.0.0.1:${server3.address().port}/v1`,
      });
      // "anything" is too short to seed a search and has no prior turn to
      // resolve against, so the seed reads it as direct — the planner failing
      // must never break the reply.
      assert.equal(result.action, "direct");
      assert.equal(result.engine, "standard");
      assert.equal(result.answer, "fallback answer");
    } finally {
      server3.close();
    }
  });

  test("a sub-60s budget (brief) skips the coverage audit and the review, and asks for the brief shape", async () => {
    requests.length = 0;
    gapAlreadyAsked = false;
    const phases = [];
    const result = await runDrcResearch({
      providerId: "berget",
      apiKey: "user-berget-key",
      model: "moonshotai/Kimi-K2.6",
      messages: [{ role: "user", content: "Compare A and B in depth" }],
      budgetS: 30,
      onStatus: (s) => s.type === "phase" && phases.push(s.phase),
      baseUrl,
    });
    // No reflect phase, no validate phase — the plan, one harvest wave, synthesis.
    assert.deepEqual(phases, ["plan", "harvest", "synth"]);
    assert.equal(requests.filter((r) => r.phase === "reflect").length, 0);
    assert.equal(requests.filter((r) => r.phase === "validate").length, 0);
    // The draft streams through unreviewed.
    assert.equal(result.validated, false);
    assert.equal(result.answer, "DRAFT answer.");
    // The planner was asked for the brief tier's 2 angles; synthesis for the brief shape.
    assert.match(requests.find((r) => r.phase === "plan").body.messages[0].content, /queries: 2 distinct research angles/);
    assert.match(requests.find((r) => r.phase === "synth").body.messages[0].content, /REPORT DEPTH — BRIEF/);
  });

  test("a 420s+ budget (full) runs a second coverage-audit round and raises the output caps", async () => {
    requests.length = 0;
    gapAlreadyAsked = false; // round 1 finds a gap, round 2 reports complete
    const phases = [];
    const result = await runDrcResearch({
      providerId: "berget",
      apiKey: "user-berget-key",
      model: "moonshotai/Kimi-K2.6",
      messages: [{ role: "user", content: "Compare A and B in depth" }],
      budgetS: 480,
      onStatus: (s) => s.type === "phase" && phases.push(s.phase),
      baseUrl,
    });
    // The second reflect round ran (and, sufficient, ordered no third harvest).
    assert.deepEqual(phases, ["plan", "harvest", "reflect", "harvest", "reflect", "synth", "validate"]);
    assert.equal(requests.filter((r) => r.phase === "reflect").length, 2);
    assert.equal(result.validated, true);
    // Synthesis got the full-report structure and the raised token cap; the
    // validator got the revise headroom a whole report needs.
    const synth = requests.find((r) => r.phase === "synth");
    assert.match(synth.body.messages[0].content, /REPORT DEPTH — FULL RESEARCH REPORT/);
    assert.equal(synth.body.max_tokens, DRC_DEPTH_TIERS.full.synthMaxTokens);
    assert.equal(requests.find((r) => r.phase === "validate").body.max_tokens, DRC_DEPTH_TIERS.full.validateMaxTokens);
  });

  test("the 60s budget (standard) is the wire default: an omitted budget changes nothing", async () => {
    requests.length = 0;
    gapAlreadyAsked = false;
    await runDrcResearch({
      providerId: "berget",
      apiKey: "user-berget-key",
      model: "moonshotai/Kimi-K2.6",
      messages: [{ role: "user", content: "Compare A and B in depth" }],
      budgetS: 60,
      baseUrl,
    });
    const explicit = requests.map((r) => ({ phase: r.phase, body: r.body }));
    requests.length = 0;
    gapAlreadyAsked = false;
    await runDrcResearch({
      providerId: "berget",
      apiKey: "user-berget-key",
      model: "moonshotai/Kimi-K2.6",
      messages: [{ role: "user", content: "Compare A and B in depth" }],
      baseUrl,
    });
    const omitted = requests.map((r) => ({ phase: r.phase, body: r.body }));
    // Byte-identical requests — the slider's default tier IS the old pipeline.
    assert.deepEqual(explicit, omitted);
  });
});

// Server-proxied web search (the temporary grant): with a webSearch fn injected,
// the harvest runs REAL searches, the model extracts CITED facts from the
// results, and synthesis/validation switch to the citation-aware variants with a
// numbered Sources list. Fully fail-soft — a webSearch returning null falls back
// to the offline harvest.
describe("runDrcResearch web-search grant path (mock provider)", () => {
  const requests = [];
  // Lets one test drive the coverage audit's verdicts; null = the default
  // "complete" every other test in this block relies on.
  /** @type {null | (() => object)} */
  let gapResponder = null;
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", () => {
      const body = JSON.parse(raw);
      const phase = phaseOf(body);
      requests.push({ phase, body });
      const json = (obj) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(obj) } }] }));
      };
      if (phase === "plan") json({ queries: ["What is A?", "What is B?"], rationale: "", direct: false });
      else if (phase === "harvest") json({ facts: ["A shipped in 2024 [1]"], uncertain: [] });
      else if (phase === "reflect") json(gapResponder ? gapResponder() : { sufficient: true });
      else if (phase === "validate") json({ verdict: "pass" });
      else {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(sse(["Grounded ", "answer [1]."]));
      }
    });
  });
  let baseUrl;
  before(async () => {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
  });
  after(() => server.close());

  test("research harvest runs real searches and synthesis cites the numbered sources", async () => {
    requests.length = 0;
    const queries = [];
    const webSearch = async (q) => {
      queries.push(q);
      return { items: [{ title: "Result for " + q, url: "https://ex/" + queries.length, highlights: ["hi"] }], resultCount: 1 };
    };
    const phases = [];
    const details = [];
    const sourceGroups = []; // {query, items} — one per live search, for the step's linked list
    const result = await runDrcResearch({
      providerId: "berget",
      apiKey: "user-berget-key",
      model: "moonshotai/Kimi-K2.6",
      messages: [{ role: "user", content: "Compare A and B" }],
      webSearch,
      engine: "standard", // this describe pins the standard graph's web path
      onStatus: (s) => {
        if (s.type === "phase") phases.push(s.phase);
        if (s.type === "detail") details.push(s.label);
        if (s.type === "sources") sourceGroups.push(s);
      },
      onDelta: () => {},
      baseUrl,
    });
    assert.equal(result.action, "research");
    // A web search ran for each sub-question.
    assert.deepEqual(queries, ["What is A?", "What is B?"]);
    // Each search surfaced its results as a sources event (query + title/url
    // items) — what the /cure step body renders as the linked source list.
    assert.deepEqual(
      sourceGroups.map((g) => g.query).sort(),
      ["What is A?", "What is B?"],
    );
    for (const g of sourceGroups) {
      assert.equal(g.items.length, 1);
      assert.match(g.items[0].title, /^Result for What is /);
      assert.match(g.items[0].url, /^https:\/\/ex\//);
    }
    // The searched wave and the audit reported their outcomes; the pass
    // verdict used the web-mode wording.
    assert.match(details[1], /^Searched 2 angles · 2 sources · /);
    assert.ok(details.includes("Coverage sufficient"));
    assert.equal(details.at(-1), "All claims verified against sources");
    // The harvest used the web-harvest prompt (given the live results block).
    const harvest = requests.find((r) => r.phase === "harvest");
    assert.match(harvest.body.messages[0].content, /LIVE WEB SEARCH RESULTS/);
    assert.match(harvest.body.messages[1].content, /Web search results/);
    // Synthesis carried a numbered Sources list and used the web synth prompt.
    const synth = requests.find((r) => r.phase === "synth");
    assert.match(synth.body.messages[0].content, /CITE claims with the bracketed Source numbers/);
    assert.match(synth.body.messages.at(-1).content, /Sources \(cite claims as \[n\]\)/);
    assert.match(synth.body.messages.at(-1).content, /\[1\] Result for What is A\?/);
    // With live sources gathered, the ledger flips to the SEARCH wording and
    // lists exactly the queries that were run (feedback #61).
    assert.match(synth.body.messages.at(-1).content, /^Search angles already run for this question/);
    assert.match(synth.body.messages.at(-1).content, /- What is A\?\n- What is B\?/);
    // The phase line surfaced "search" (not "harvest") while web search ran.
    assert.ok(phases.includes("search"));
  });

  test("a webSearch that returns null falls back to the offline harvest", async () => {
    requests.length = 0;
    const webSearch = async () => null; // e.g. quota exhausted / error
    const result = await runDrcResearch({
      providerId: "berget",
      apiKey: "user-berget-key",
      model: "moonshotai/Kimi-K2.6",
      messages: [{ role: "user", content: "Compare A and B" }],
      webSearch,
      engine: "standard", // this describe pins the standard graph's web path
      onDelta: () => {},
      baseUrl,
    });
    assert.equal(result.action, "research");
    // Offline harvest prompt used, and synthesis stayed on the offline variant
    // (no Sources block) since no web sources were gathered.
    const harvest = requests.find((r) => r.phase === "harvest");
    assert.match(harvest.body.messages[0].content, /From your own knowledge/);
    const synth = requests.find((r) => r.phase === "synth");
    assert.doesNotMatch(synth.body.messages.at(-1).content, /Sources \(cite claims as \[n\]\)/);
    // The ledger follows the same fallback: no live sources, so it reports a
    // harvest rather than promising searches that never happened.
    assert.match(synth.body.messages.at(-1).content, /^Research angles already run for this question/);
  });

  test("a direct answer (research off) grounds in one web search when the grant is on", async () => {
    requests.length = 0;
    const queries = [];
    const webSearch = async (q) => {
      queries.push(q);
      return { items: [{ title: "Doc", url: "https://ex/d", highlights: [] }], resultCount: 1 };
    };
    const sourceGroups = [];
    const details = [];
    const result = await runDrcResearch({
      providerId: "berget",
      apiKey: "user-berget-key",
      model: "moonshotai/Kimi-K2.6",
      messages: [{ role: "user", content: "latest on A?" }],
      research: false,
      webSearch,
      engine: "standard", // this describe pins the standard graph's web path
      onStatus: (s) => {
        if (s.type === "sources") sourceGroups.push(s);
        if (s.type === "detail") details.push(s.label);
      },
      onDelta: () => {},
      baseUrl,
    });
    assert.equal(result.action, "direct");
    assert.deepEqual(queries, ["latest on A?"]);
    // The one-pass search also surfaced its sources + outcome for the step list.
    assert.deepEqual(sourceGroups.map((g) => g.query), ["latest on A?"]);
    assert.deepEqual(details, ["Searched the web · 1 source"]);
    const direct = requests.at(-1);
    assert.match(direct.body.messages[0].content, /grounded in the numbered web search results/);
    assert.match(direct.body.messages.at(-1).content, /Web search results/);
  });

  // The server registry has deduped by URL since its first line
  // (src/sources.js addSources); /cure's did not, so a page two sub-questions
  // both found took two citation numbers — and a single source could then be
  // cited as if it were two corroborating ones.
  test("one URL found by two angles takes ONE citation number", async () => {
    requests.length = 0;
    const seen = [];
    const webSearch = async (q) => {
      seen.push(q);
      // Both angles return the same page, plus one angle-specific page.
      return {
        items: [
          { title: "Shared page", url: "https://ex/shared", highlights: ["hi"] },
          { title: "Only " + seen.length, url: "https://ex/only" + seen.length, highlights: [] },
        ],
        resultCount: 2,
      };
    };
    await runDrcResearch({
      providerId: "berget",
      apiKey: "user-berget-key",
      model: "moonshotai/Kimi-K2.6",
      messages: [{ role: "user", content: "Compare A and B" }],
      webSearch,
      engine: "standard", // this describe pins the standard graph's web path
      onStatus: () => {},
      onDelta: () => {},
      baseUrl,
    });
    const synth = requests.find((r) => r.phase === "synth");
    const sources = synth.body.messages.at(-1).content;
    // Three distinct URLs across two searches of two results each.
    const shared = [...sources.matchAll(/https:\/\/ex\/shared/g)];
    assert.equal(shared.length, 1, "the shared page is listed once, not twice");
    assert.match(sources, /\[1\] Shared page/);
    assert.match(sources, /\[2\] Only 1/);
    assert.match(sources, /\[3\] Only 2/);
    // …and the numbering has no gap where the duplicate was dropped.
    assert.doesNotMatch(sources, /\[4\]/);
  });

  // The gap round proposes follow-up angles; nothing checked them against the
  // angles already harvested, so a second round could re-run one of its own
  // round-1 follow-ups. The server dedups every query it issues
  // (pipeline-inputs.js takeSearchBatch over state.ranQueries).
  test("a follow-up angle already harvested is not run again", async () => {
    requests.length = 0;
    const queries = [];
    const webSearch = async (q) => {
      queries.push(q);
      return { items: [{ title: "R", url: "https://ex/" + queries.length, highlights: [] }], resultCount: 1 };
    };
    // Full tier → two gap rounds. Round 1 proposes a genuinely new angle;
    // round 2 proposes the SAME one plus one that was in the original triage.
    let gapRound = 0;
    gapResponder = () => {
      gapRound++;
      return gapRound === 1
        ? { sufficient: false, follow_up_queries: ["What is C?"] }
        : { sufficient: false, follow_up_queries: ["What is C?", "What is A?"] };
    };
    try {
      await runDrcResearch({
        providerId: "berget",
        apiKey: "user-berget-key",
        model: "moonshotai/Kimi-K2.6",
        messages: [{ role: "user", content: "Compare A and B" }],
        budgetS: 600,
        webSearch,
      engine: "standard", // this describe pins the standard graph's web path
        onStatus: () => {},
        onDelta: () => {},
        baseUrl,
      });
    } finally {
      gapResponder = null;
    }
    // Round 2's proposals were both already harvested, so nothing re-ran.
    assert.deepEqual(queries, ["What is A?", "What is B?", "What is C?"]);
  });
});

// The wall-clock roof the module documents but never applied. `withinBudget`
// and the two fractions were defined, exported and unit-tested from the day
// the slider shipped, and a repo-wide grep found NO call site in any commit —
// so /cure's time budget bounded the phase SHAPE but nothing about the clock,
// while the paragraph above drcPlanForBudget said an optional phase "only
// starts while its share of the budget remains".
describe("the Se/cure deadline guards are actually applied", () => {
  const src = readFileSync(new URL("./drc-research.js", import.meta.url), "utf8");

  test("the optional phases and the gather loop consult withinBudget before spending", () => {
    assert.match(src, /if \(!withinBudget\(GAP_DEADLINE_FRACTION\)\)/);
    assert.match(src, /withinBudget\(VALIDATE_DEADLINE_FRACTION\)/);
    // The agentic engine's writer reserve: no new tool call past the gather
    // share of the wall clock.
    assert.match(src, /if \(!withinBudget\(DRC_GATHER_DEADLINE_FRACTION\)\)/);
    // Never on a MANDATORY phase: the plan, the first harvest wave and
    // synthesis are what the user asked for, and skipping one produces no
    // answer at all. Exactly the two optional phases + the gather gate.
    assert.equal([...src.matchAll(/withinBudget\(/g)].length, 3, "exactly the three deadline gates call it");
  });

  test("a skipped phase says so, rather than shortening the run silently", () => {
    assert.match(src, /Coverage audit skipped — out of research time/);
    assert.match(src, /Review skipped — out of research time/);
    assert.match(src, /The time budget for this answer is nearly spent/);
  });

  // Invariant 4, pinned at the module boundary: the port added NO new server
  // call. This module opens no wire of its own — every model call rides
  // drc-providers.js on the user's own provider, and web search only ever
  // goes through the INJECTED webSearch fn (the tier's pre-existing legs:
  // the user's own browser-direct service, or the query-only grant family).
  test("drc-research.js opens no wire of its own — no fetch, no /api/ path", () => {
    assert.equal(src.includes("fetch("), false, "no direct fetch call");
    assert.equal(src.includes('"/api/'), false, "no server endpoint named");
    assert.equal(src.includes("'/api/"), false, "no server endpoint named");
  });
});

// Developer-mode native tool investigation (runDrcSourceTools + the
// runDrcResearch snapshot branch): with a snapshot present, the user's provider
// drives grep_source/read_file over it and answers from what it reads — the
// client twin of the server's runSourceResearchTools. Mock server returns a
// tool_call, then the final answer once the tool result comes back.
describe("DRC developer-mode tool loop", () => {
  // The client twin of src/prompts.js sourceToolAgentPrompt must carry the
  // same tool-economy guidance: the shared read budget stated up front, and
  // the targeted-extraction routes (grep context, offset/limit ranged reads).
  test("drcSourceToolPrompt states the read budget and targeted extraction", () => {
    const p = drcSourceToolPrompt();
    assert.match(p, /TOOL ECONOMY/);
    assert.match(p, /60000/); // MAX_READ_TOTAL_CHARS
    assert.match(p, /offset\/limit/);
    assert.match(p, /context parameter/);
  });

  // Diagram asks (feedback #14, 2026-07-24): the DRC twin carries the same
  // mermaid-fence directive as the server prompts — answer a diagram request
  // with a rendered ```mermaid fence, never ASCII box art in a plain fence.
  test("drcSourceToolPrompt directs diagram requests to a rendered mermaid fence", () => {
    const p = drcSourceToolPrompt();
    assert.match(p, /DIAGRAMS:/);
    assert.match(p, /```mermaid/);
    assert.match(p, /Do NOT draw ASCII\/Unicode box art/);
  });

  const SNAP = {
    v: 1,
    digest: "abc123def4567890",
    count: 2,
    bytes: 0,
    files: [
      { p: "src/auth.js", s: 60, t: "// auth\nif (!env.SESSION_SECRET) return [];\n" },
      { p: "src/index.js", s: 30, t: "// entry\nexport default {};\n" },
    ],
  };
  const requests = [];
  let round = 0;
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", () => {
      const body = JSON.parse(raw);
      requests.push(body);
      round++;
      res.writeHead(200, { "content-type": "application/json" });
      if (round === 1) {
        res.end(
          JSON.stringify({
            choices: [
              {
                message: {
                  role: "assistant",
                  content: null,
                  tool_calls: [
                    { id: "c1", type: "function", function: { name: "grep_source", arguments: '{"pattern":"SESSION_SECRET"}' } },
                  ],
                },
              },
            ],
          }),
        );
      } else {
        res.end(JSON.stringify({ choices: [{ message: { content: "**Auth gates on SESSION_SECRET** (`src/auth.js`)." } }] }));
      }
    });
  });
  let baseUrl;
  before(async () => {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
  });
  after(() => server.close());

  test("runDrcResearch with a snapshot runs the tool loop and returns action 'source'", async () => {
    requests.length = 0;
    round = 0;
    const phases = [];
    let streamed = "";
    const result = await runDrcResearch({
      providerId: "openai",
      apiKey: "sk-user",
      model: "gpt-5.6-terra",
      messages: [{ role: "user", content: "Do a security assessment" }],
      snapshot: SNAP,
      onStatus: (s) => s.type === "phase" && phases.push(s.phase),
      onDelta: (c) => (streamed += c),
      baseUrl,
    });

    assert.equal(result.action, "source");
    assert.equal(result.toolCalls, 1);
    assert.match(result.answer, /SESSION_SECRET/);
    assert.match(streamed, /SESSION_SECRET/); // emitted chunked to the client
    assert.ok(phases.includes("source"));

    // The model was offered the source tools, and the executed grep result
    // (real snapshot content) came back as a role:"tool" message.
    assert.ok(requests[0].tools.some((t) => t.function.name === "grep_source"));
    const toolMsg = requests[1].messages.find((m) => m.role === "tool");
    assert.match(toolMsg.content, /src\/auth\.js:2: .*SESSION_SECRET/);
  });

  test("no run_bash tool is offered when the bash knob is off", async () => {
    requests.length = 0;
    round = 0;
    await runDrcResearch({
      providerId: "openai",
      apiKey: "sk-user",
      model: "gpt-5.6-terra",
      messages: [{ role: "user", content: "assess it" }],
      snapshot: SNAP,
      bash: false,
      onDelta: () => {},
      baseUrl,
    });
    const toolNames = requests[0].tools.map((t) => t.function.name);
    assert.ok(!toolNames.includes("run_bash"));
    // run_python rides run_bash's gate exactly — knob off means neither.
    assert.ok(!toolNames.includes("run_python"));
    assert.deepEqual(toolNames.sort(), ["grep_source", "list_files", "read_file"]);
  });
});

// ---- run_python in the Se/cure client loop -----------------------------------
//
// The secure agent has declared the `python` tool class since sdk/AGENTS.json
// first carried capability blocks, and until this describe existed nothing in
// the tier implemented it — the declaration was a promise the loop broke. The
// implementation is deliberately thin: the shared lypning ladder
// (public/js/lypning-exec-core.js, the same core the Se/rver toolbox
// re-exports) does the probe / refusal / CPython retry, and this loop only
// binds it to the runner the user selected — which for this tier is the
// in-browser VM or their own local runner, never a server (invariant 4).
describe("DRC run_python tool", () => {
  const SNAP = {
    v: 1,
    digest: "abc123def4567890",
    count: 1,
    bytes: 0,
    files: [{ p: "src/index.js", s: 30, t: "// entry\nexport default {};\n" }],
  };
  const requests = [];
  // Each test sets `rounds` — an array of response bodies the mock provider
  // returns in order.
  let rounds = [];
  let round = 0;
  const toolCallRound = (name, args) => ({
    choices: [
      {
        message: {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "c1", type: "function", function: { name, arguments: JSON.stringify(args) } }],
        },
      },
    ],
  });
  const answerRound = (text) => ({ choices: [{ message: { content: text } }] });
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", () => {
      requests.push(JSON.parse(raw));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(rounds[Math.min(round++, rounds.length - 1)]));
    });
  });
  let baseUrl;
  before(async () => {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
  });
  after(() => server.close());
  const reset = (r) => {
    requests.length = 0;
    round = 0;
    rounds = r;
  };
  const run = (sandbox, extra = {}) =>
    runDrcResearch({
      providerId: "openai",
      apiKey: "sk-user",
      model: "gpt-5.6-terra",
      messages: [{ role: "user", content: "compute something about the site" }],
      snapshot: SNAP,
      bash: true,
      sandbox,
      onDelta: () => {},
      baseUrl,
      ...extra,
    });

  test("run_python is offered exactly when run_bash is", async () => {
    reset([answerRound("done")]);
    await run({ supported: () => true, boot: async () => true, exec: async () => ({ exitCode: 0, stdout: "", stderr: "" }) });
    const names = requests[0].tools.map((t) => t.function.name);
    assert.ok(names.includes("run_bash"));
    assert.ok(names.includes("run_python"));

    // …and when the sandbox cannot run here, neither is offered — same gate.
    reset([answerRound("done")]);
    await run({ supported: () => false, boot: async () => true, exec: async () => ({ exitCode: 0, stdout: "", stderr: "" }) });
    const none = requests[0].tools.map((t) => t.function.name);
    assert.ok(!none.includes("run_bash"));
    assert.ok(!none.includes("run_python"));
  });

  test("the ladder runs through the selected runner's exec and the tool reads the core's text", async () => {
    reset([toolCallRound("run_python", { source: "print(6*7)" }), answerRound("**42.**")]);
    const execCalls = [];
    const result = await run({
      supported: () => true,
      boot: async () => true,
      exec: async (cmd, opts) => {
        execCalls.push({ cmd, opts });
        return { exitCode: 0, stdout: "42\n", stderr: "drpy-engine:lypning\n" };
      },
    });
    assert.equal(result.action, "source");
    assert.equal(execCalls.length, 1);
    // The command is the shared ladder's: builtin [ -x ] probes on absolute
    // paths (never `command -v` — the PATH-walk trap that once destroyed the
    // VM), the heredoc'd program, and a `timeout` wrapper.
    assert.match(execCalls[0].cmd, /\[ -x \/usr\/local\/bin\/lypning \]/);
    assert.match(execCalls[0].cmd, /print\(6\*7\)/);
    assert.match(execCalls[0].cmd, /\btimeout \d+ /);
    assert.ok(!execCalls[0].cmd.includes("command -v"));
    // The per-call timeout stays inside the VM's 30 s exec ceiling — crossing
    // it does not fail a command, it destroys the VM.
    assert.ok(execCalls[0].opts.timeoutMs > 0 && execCalls[0].opts.timeoutMs < 30_000);
    // The tool result the model reads is EXACTLY what the shared core
    // formatted — no local rewording that could drift from the Se/rver tier.
    const toolMsg = requests[1].messages.find((m) => m.role === "tool");
    assert.equal(
      toolMsg.content,
      formatPythonResult(
        [{ engine: "lypning", exitCode: 0, stdout: "42\n", stderr: "", refusal: null }],
        "the in-browser sandbox",
      ),
    );
  });

  test("a lypning refusal is retried on CPython through the same runner", async () => {
    reset([toolCallRound("run_python", { source: "import re\nprint(1)" }), answerRound("ok")]);
    const cmds = [];
    await run({
      supported: () => true,
      boot: async () => true,
      exec: async (cmd) => {
        cmds.push(cmd);
        return cmds.length === 1
          ? { exitCode: 90, stdout: "", stderr: "drpy-engine:lypning\nlypning: unsupported: import: module re\n" }
          : { exitCode: 0, stdout: "1\n", stderr: "drpy-engine:python3\n" };
      },
    });
    assert.equal(cmds.length, 2);
    // The retry is PINNED to CPython — the second command never re-probes the
    // engine that just refused.
    assert.ok(!cmds[1].includes("/usr/local/bin/lypning "));
    assert.match(cmds[1], /\[ -x \/usr\/bin\/python3 \]/);
    const toolMsg = requests[1].messages.find((m) => m.role === "tool");
    assert.match(toolMsg.content, /lypning refused this program \(import: module re\) and ran nothing/);
    assert.match(toolMsg.content, /Ran on python3 in the in-browser sandbox\. Exit code 0\./);
    assert.match(toolMsg.content, /STDOUT:\n1/);
  });

  test("a sandbox that fails to boot answers in a sentence, never a throw", async () => {
    reset([toolCallRound("run_python", { source: "print(1)" }), answerRound("answered without it")]);
    const result = await run({
      supported: () => true,
      boot: async () => false,
      exec: async () => {
        throw new Error("must not be called");
      },
    });
    const toolMsg = requests[1].messages.find((m) => m.role === "tool");
    assert.equal(toolMsg.content, "Sandbox unavailable; answer without running the program.");
    assert.equal(result.answer, "answered without it");
  });

  test("an empty program is refused in a sentence, without booting the VM", async () => {
    reset([toolCallRound("run_python", { source: "   " }), answerRound("ok")]);
    let booted = false;
    await run({
      supported: () => true,
      boot: async () => ((booted = true), true),
      exec: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    });
    const toolMsg = requests[1].messages.find((m) => m.role === "tool");
    assert.equal(toolMsg.content, "run_python needs a non-empty 'source' program.");
    assert.equal(booted, false);
  });
});

// ---- the ON-DEVICE engine provider end to end -----------------------------------------
//
// A provider with `engine` callables (the on-device tier — ondevice-engine.js)
// runs the WHOLE flow with no fetch anywhere: chatStream synthesizes the
// OpenAI SSE readStream consumes, complete() serves the planning phases, and
// serialize:true turns the harvest fan-out sequential (one GPU). The mock
// engine mirrors the real provider's shape — the real one is browser glue
// (Worker/WebGPU), deliberately not Node-importable, like sandbox.js.
describe("runDrcResearch on an engine provider (the on-device tier)", () => {
  const sseBody = (chunks) =>
    new TextEncoder().encode(
      chunks.map((c) => `data: {"choices":[{"delta":{"content":${JSON.stringify(c)}}}]}`).join("\n\n") +
        "\n\ndata: [DONE]\n\n",
    );

  test("full flow: planning on complete(), synthesis streamed, harvest strictly sequential", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const completes = [];
    const provider = {
      id: "ondevice",
      label: "On-device",
      base: "",
      keyless: true,
      jsonModel: null,
      fallbackModels: [],
      modelFilter: () => true,
      params: (maxTokens) => ({ max_tokens: maxTokens }),
      jsonTimeoutMs: 600_000,
      streamIdleMs: 300_000,
      serialize: true,
      engine: {
        chatStream: async () =>
          new Response(sseBody(["Local ", "answer."]), {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          }),
        complete: async (model, messages) => {
          inFlight++;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await new Promise((r) => setTimeout(r, 15)); // overlap would show here
          inFlight--;
          const phase = phaseOf({ messages });
          completes.push({ phase, model });
          const payload =
            phase === "plan"
              ? { queries: ["What is A?", "What is B?"], rationale: "", direct: false }
              : phase === "harvest"
                ? { facts: ["a fact"], uncertain: [] }
                : phase === "reflect"
                  ? { sufficient: true }
                  : { verdict: "pass" };
          return { choices: [{ message: { content: JSON.stringify(payload) } }] };
        },
      },
    };

    let streamed = "";
    const phases = [];
    const result = await runDrcResearch({
      providerId: "ondevice",
      provider, // the providerOverride branch — same as the proxy providers
      apiKey: "",
      model: "bonsai-8b-1bit",
      messages: [{ role: "user", content: "Compare A and B in depth" }],
      onStatus: (s) => s.type === "phase" && phases.push(s.phase),
      onDelta: (c) => (streamed += c),
    });

    // provider.engine means canDrcDriveTools is false, so auto lands on the
    // standard graph with no attempt at a tool loop (engine selection rung).
    assert.deepEqual(phases, ["plan", "harvest", "reflect", "synth", "validate"]);
    assert.equal(result.engine, "standard");
    assert.equal(result.answer, "Local answer.");
    assert.equal(streamed, "Local answer.");
    assert.equal(result.validated, true);
    // serialize:true — the two harvest calls never overlapped.
    assert.equal(maxInFlight, 1);
    assert.equal(completes.filter((c) => c.phase === "harvest").length, 2);
    // jsonModel:null collapses planning onto the one on-device model.
    for (const c of completes) assert.equal(c.model, "bonsai-8b-1bit");
  });
});

// The whole pipeline over the ANTHROPIC wire (Anthropic replaced Groq in the
// registry on 2026-07-26). The phases are the same code — what is being proved
// here is that the wire adapter in drc-providers.js is invisible to them: the
// JSON phases parse Messages-API content blocks, synthesis consumes the
// adapted SSE, and split model routing still puts planning on the fixed cheap
// model while the answer runs on the user's choice.
describe("runDrcResearch over the Anthropic wire (mock provider)", () => {
  const requests = [];
  // The system prompt is a TOP-LEVEL field on this wire, not messages[0] —
  // one of the three shape differences the adapter bridges.
  const anthropicPhaseOf = (body) => {
    const system = body.system || "";
    if (system.includes("research planner")) return "plan";
    if (system.includes("extract research notes")) return "harvest";
    if (system.includes("audit research coverage")) return "reflect";
    if (system.includes("strict reviewer")) return "validate";
    return "synth";
  };
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", () => {
      const body = JSON.parse(raw);
      const phase = anthropicPhaseOf(body);
      requests.push({ phase, url: req.url, headers: req.headers, body });
      const json = (obj) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify(obj) }] }));
      };
      if (phase === "plan") json({ queries: ["What is A?"], rationale: "", direct: false });
      else if (phase === "harvest") json({ facts: ["a fact"], uncertain: [] });
      else if (phase === "reflect") json({ sufficient: true });
      else if (phase === "validate") json({ verdict: "pass", issues: [] });
      else {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(
          'data: {"type":"message_start","message":{"usage":{"input_tokens":9}}}\n\n' +
            'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"CLAUDE "}}\n\n' +
            'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"answer."}}\n\n' +
            'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}\n\n' +
            'data: {"type":"message_stop"}\n\n',
        );
      }
    });
  });
  let baseUrl;
  before(async () => {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
  });
  after(() => server.close());

  test("the phases run unchanged: split routing holds and the answer streams", async () => {
    requests.length = 0;
    const phases = [];
    let streamed = "";
    const result = await runDrcResearch({
      providerId: "anthropic",
      apiKey: "sk-ant-user-key",
      model: "claude-opus-5",
      messages: [{ role: "user", content: "What is A?" }],
      onStatus: (s) => s.type === "phase" && phases.push(s.phase),
      onDelta: (c) => (streamed += c),
      baseUrl,
    });
    assert.deepEqual(phases, ["plan", "harvest", "reflect", "synth", "validate"]);
    assert.equal(streamed, "CLAUDE answer.");
    assert.equal(result.action, "research");
    assert.equal(result.validated, true);
    assert.equal(result.answer, "CLAUDE answer.");

    for (const r of requests) {
      // Every call went to the Messages API on Anthropic's auth, never a Bearer.
      assert.equal(r.url, "/v1/messages", r.phase);
      assert.equal(r.headers["x-api-key"], "sk-ant-user-key", r.phase);
      assert.equal(r.headers.authorization, undefined, r.phase);
      assert.equal(r.headers["anthropic-dangerous-direct-browser-access"], "true", r.phase);
      // Split model routing (invariant 3): planning on the fixed cheap model,
      // the answer on the user's chosen one.
      if (r.phase === "synth") assert.equal(r.body.model, "claude-opus-5");
      else assert.equal(r.body.model, "claude-haiku-4-5", r.phase);
    }
  });
});

// A turn with an attachment carries a multimodal parts array. Pins that the
// context line is built from its TEXT parts: string-concatenating the raw
// content put a literal "[object Object]" into every planning prompt (triage,
// gap check, validation), and the base64 image bytes must never land in one.
test("drcContext renders a multimodal turn as text, never [object Object]", () => {
  const ctx = drcContext([
    { role: "user", content: "plain string turn" },
    { role: "assistant", content: "ok" },
    {
      role: "user",
      content: [
        { type: "text", text: "What is in this photo?" },
        { type: "image_url", image_url: { url: "data:image/png;base64,SECRETBYTES" } },
      ],
    },
  ]);
  assert.match(ctx, /USER: What is in this photo\? \[1 image attached\]/);
  assert.equal(ctx.includes("[object Object]"), false);
  assert.equal(ctx.includes("SECRETBYTES"), false); // image bytes stay off the planning wire
  assert.match(ctx, /USER: plain string turn/); // string turns unchanged
  // An image-only turn still shows the planner that something was attached.
  const only = drcContext([
    { role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,AA" } }] },
  ]);
  assert.equal(only, "USER: [1 image attached]");
});

// The two mounts the sandbox may carry are INDEPENDENT facts about the boot —
// the site's own source at /src (developer mode) and the user's attached files
// under /workspace/ — so the prompt describes each one only when it is really
// there. Telling the model about a mount that does not exist sends it grepping
// an empty tree; staying silent about one that does means it never looks
// (docs/SANDBOX-HOST-COMMANDS.md: "the model treats the sandbox as empty and
// never looks"). All four combinations pinned.
test("drcBashAgentPrompt: /src and /workspace are stated independently", () => {
  // The /src paragraph itself mentions /workspace/source, so the attachment
  // paragraph is identified by its manifest line instead.
  const hasFiles = (/** @type {string} */ p) => p.includes("/workspace/INDEX.txt");
  const hasSource = (/** @type {string} */ p) => p.includes("mounted read-only at /src");

  const neither = drcBashAgentPrompt();
  assert.equal(hasSource(neither), false);
  assert.equal(hasFiles(neither), false);
  // Silence about the mounts is no longer enough (feedback #64): with nothing
  // mounted the prompt must SAY so, and say where a question about an outside
  // subject is actually answered — a model told nothing runs `ls` to find out.
  // What it must still never do is describe files as being available.
  assert.match(neither, /NOTHING IS MOUNTED/);
  assert.match(neither, /do not go looking on disk/);
  assert.match(neither, /the right first turn is SHELL_DONE/);
  assert.doesNotMatch(neither, /read-write at \/workspace\//);

  const src = drcBashAgentPrompt({ sourceMounted: true });
  assert.equal(hasSource(src), true);
  assert.equal(hasFiles(src), false);

  const files = drcBashAgentPrompt({ filesMounted: true });
  assert.equal(hasSource(files), false);
  assert.equal(hasFiles(files), true);
  assert.match(files, /read-write at \/workspace\//);

  const both = drcBashAgentPrompt({ sourceMounted: true, filesMounted: true });
  assert.equal(hasSource(both), true);
  assert.equal(hasFiles(both), true);
});

// ---- the AGENTIC engine end to end (mock provider) ---------------------------------
//
// The client twin of src/agentic.test.js's ladder: the user's own model drives
// a bounded gather loop over the resolved toolbox, NOTHING the loop writes is
// streamed, and the shared finalize legs write and review the answer. The mock
// routes on the request shape: a body carrying `tools` is a loop round, a
// streaming body is the writer, everything else is a JSON phase.
describe("the AGENTIC research engine (mock provider)", () => {
  const requests = [];
  let rounds = [];
  let round = 0;
  let failToolRequests = false;
  const toolCallsRound = (calls) => ({
    choices: [
      {
        message: {
          role: "assistant",
          content: null,
          tool_calls: calls.map((c, i) => ({
            id: "c" + i,
            type: "function",
            function: { name: c.name, arguments: JSON.stringify(c.args) },
          })),
        },
      },
    ],
  });
  const answerRound = (text) => ({ choices: [{ message: { content: text } }] });
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", () => {
      const body = JSON.parse(raw);
      requests.push(body);
      if (Array.isArray(body.tools)) {
        if (failToolRequests) {
          res.writeHead(500);
          res.end();
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(rounds[Math.min(round++, rounds.length - 1)]));
        return;
      }
      if (body.stream) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(sse(["Grounded ", "answer [1]."]));
        return;
      }
      const phase = phaseOf(body);
      const payload =
        phase === "plan"
          ? { queries: ["What is A?"], rationale: "", direct: false }
          : phase === "harvest"
            ? { facts: ["a fact"], uncertain: [] }
            : phase === "reflect"
              ? { sufficient: true }
              : { verdict: "pass" };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(payload) } }] }));
    });
  });
  let baseUrl;
  before(async () => {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
  });
  after(() => server.close());
  const reset = (r) => {
    requests.length = 0;
    round = 0;
    rounds = r;
    failToolRequests = false;
  };
  const run = async (extra = {}) => {
    const events = { phases: [], details: [], sources: [], tools: [] };
    const deltas = [];
    const webSeen = [];
    const webSearch =
      "webSearch" in extra
        ? extra.webSearch
        : async (q) => {
            webSeen.push(q);
            return { items: [{ title: "R " + q, url: "https://ex/" + encodeURIComponent(q), highlights: ["hi"] }], resultCount: 1 };
          };
    const result = await runDrcResearch({
      providerId: "openai",
      apiKey: "sk-user",
      model: "gpt-5.6-terra",
      messages: [{ role: "user", content: "Compare A and B in depth" }],
      webSearch,
      onStatus: (s) => {
        if (s.type === "phase") events.phases.push(s.phase);
        if (s.type === "detail") events.details.push(s);
        if (s.type === "sources") events.sources.push(s);
        if (s.type === "tool") events.tools.push(s);
      },
      onDelta: (c) => deltas.push(c),
      baseUrl,
      ...extra.opts,
    });
    return { result, events, deltas, webSeen };
  };

  test("gather-then-write: the loop's text never streams; the writer writes through the shared legs", async () => {
    reset([
      toolCallsRound([{ name: "web_search", args: { queries: ["What is A?", "what is a?", "What is B?"] } }]),
      answerRound("WORKING CONCLUSION"),
    ]);
    const { result, events, deltas, webSeen } = await run();

    assert.equal(result.engine, "agentic");
    assert.equal(result.action, "research");
    assert.equal(result.validated, true);
    // Within-call case-folded dedupe: two spellings of one angle are one query.
    assert.deepEqual(webSeen, ["What is A?", "What is B?"]);
    assert.deepEqual(result.subquestions, ["What is A?", "What is B?"]);
    // NOTHING streamed until the writer ran — the loop's conclusion is notes,
    // never answer text.
    assert.equal(deltas.join(""), "Grounded answer [1].");
    assert.equal(deltas.join("").includes("WORKING CONCLUSION"), false);
    assert.deepEqual(events.phases, ["loop", "synth", "validate"]);
    // The tool call surfaced live with its headline and result lines…
    assert.equal(events.tools.length, 1);
    assert.equal(events.tools[0].name, "web_search");
    assert.match(events.tools[0].headline, /^web_search {2}What is A\?/);
    // …and each search's linked sources fired the existing sources event.
    assert.deepEqual(events.sources.map((s) => s.query), ["What is A?", "What is B?"]);
    assert.match(events.details[0].label, /^Researched with 1 tool call over 2 rounds$/);

    // The loop round carried the shared BRIEF as its system prompt and the
    // resolved toolbox on the wire.
    const loopReq = requests.find((r) => Array.isArray(r.tools));
    assert.match(loopReq.messages[0].content, /^You are the research assistant for Deepresearch\.se\./);
    assert.match(loopReq.messages[0].content, /Your tools this turn: web_search\./);
    assert.match(loopReq.messages[0].content, /8 tool rounds and 6 calls to a metered source/);
    assert.match(loopReq.messages[0].content, /seconds of wall clock remain/);
    // No python, no compute clause; no source, no source clause.
    assert.doesNotMatch(loopReq.messages[0].content, /COMPUTE RATHER THAN GUESS/);
    assert.deepEqual(loopReq.tools.map((t) => t.function.name), ["web_search"]);
    // The tool result the model read registered the sources by number.
    const toolMsg = requests[1].messages.find((m) => m.role === "tool");
    assert.match(toolMsg.content, /^Results \(registered as citable sources/);
    assert.match(toolMsg.content, /\[1\] R What is A\?/);

    // The writer's input: ledger (search wording) → Sources list → the
    // working conclusion — and the reviewer read the same notes shape MINUS
    // the synthesis-only ledger.
    const synth = requests.find((r) => r.stream);
    const synthUser = synth.messages.at(-1).content;
    assert.match(synthUser, /^Search angles already run for this question/);
    assert.match(synthUser, /- What is A\?\n- What is B\?/);
    assert.match(synthUser, /Sources \(cite claims as \[n\]\):/);
    assert.match(synthUser, /Your working conclusion at the end of the research:\nWORKING CONCLUSION/);
    assert.match(synth.messages[0].content, /CITE claims with the bracketed Source numbers/);
    const validate = requests.find((r) => !r.stream && !Array.isArray(r.tools) && phaseOf(r) === "validate");
    assert.match(validate.messages.at(-1).content, /Sources \(cite claims as \[n\]\):/);
    assert.match(validate.messages.at(-1).content, /Your working conclusion/);
    assert.doesNotMatch(validate.messages.at(-1).content, /angles already run/);
  });

  test("the refusal ladder: error sentences are counted, four stop the run — and the stop outranks everything", async () => {
    reset([
      toolCallsRound([
        { name: "web_search", args: { queries: ["q1"] } },
        { name: "web_search", args: { queries: ["q2"] } },
        { name: "web_search", args: { queries: ["q3"] } },
        { name: "web_search", args: { queries: ["q4"] } },
        { name: "web_search", args: { queries: ["q5"] } },
      ]),
      toolCallsRound([{ name: "read_pages", args: { urls: ["https://x"] } }]),
      answerRound("gave up"),
    ]);
    // Every search comes back empty (quota spent / no results — the legs are
    // indistinguishable by design), which the wrapper counts as errors.
    const { result, deltas } = await run({ webSearch: async () => null });

    assert.equal(result.engine, "agentic");
    // The writer still wrote — a stopped loop never costs the answer.
    assert.equal(deltas.join(""), "Grounded answer [1].");
    const round2 = requests.find((r, i) => i > 0 && Array.isArray(r.tools));
    const toolMsgs = round2.messages.filter((m) => m.role === "tool").map((m) => m.content);
    assert.equal(toolMsgs.length, 5);
    for (const t of toolMsgs.slice(0, 4)) assert.match(t, /That search returned nothing/);
    // …and the sentence never claims quota exhaustion with certainty.
    assert.match(toolMsgs[0], /or this session's search allowance is spent/);
    // The fifth call hit the four-errors stop.
    assert.match(toolMsgs[4], /^Tool use has stopped for this answer/);
    // A stopped run refuses EVERY later call with the stop sentence — the
    // cheapest, most conclusive check runs first, exactly like the server's
    // ordered admission.
    const round3 = requests.filter((r) => Array.isArray(r.tools)).at(-1);
    const stoppedRefusal = round3.messages.filter((m) => m.role === "tool").at(-1).content;
    assert.match(stoppedRefusal, /^Tool use has stopped for this answer/);
  });

  test("an off-toolbox name is refused with the real toolbox named", async () => {
    reset([
      toolCallsRound([{ name: "read_pages", args: { urls: ["https://x"] } }]),
      answerRound("noted"),
    ]);
    await run();
    const round2 = requests.filter((r) => Array.isArray(r.tools)).at(-1);
    const refusal = round2.messages.filter((m) => m.role === "tool").at(-1).content;
    assert.match(refusal, /read_pages tool is not part of this run's toolbox/);
    assert.match(refusal, /Your tools this turn: web_search/);
  });

  test("the search allowance refuses the seventh spending call without spending it", async () => {
    reset([
      toolCallsRound([
        { name: "web_search", args: { queries: ["q1"] } },
        { name: "web_search", args: { queries: ["q2"] } },
        { name: "web_search", args: { queries: ["q3"] } },
        { name: "web_search", args: { queries: ["q4"] } },
        { name: "web_search", args: { queries: ["q5"] } },
        { name: "web_search", args: { queries: ["q6"] } },
        { name: "web_search", args: { queries: ["q7"] } },
      ]),
      answerRound("done"),
    ]);
    const { webSeen } = await run();
    // Six spending calls ran; the seventh was refused in a sentence and sent
    // nothing (a refused call spends nothing).
    assert.deepEqual(webSeen, ["q1", "q2", "q3", "q4", "q5", "q6"]);
    const round2 = requests.filter((r) => Array.isArray(r.tools)).at(-1);
    const toolMsgs = round2.messages.filter((m) => m.role === "tool").map((m) => m.content);
    assert.match(toolMsgs[6], /search allowance is spent: 6 of 6 web_search calls/);
  });

  test("argument scrub: code-point clamp, per-call cap, cross-call dedupe", async () => {
    const long = "x".repeat(400);
    reset([
      toolCallsRound([{ name: "web_search", args: { queries: ["  a  b ", "A B", long, "q2", "q3", "q4"] } }]),
      toolCallsRound([{ name: "web_search", args: { queries: ["a b", "fresh"] } }]),
      answerRound("done"),
    ]);
    const { webSeen } = await run();
    // Call 1: whitespace collapsed, case-folded dedupe, the long query cut at
    // 300 code points, capped at 4 queries. Call 2: "a b" already ran this
    // answer, only the fresh angle went out.
    assert.equal(webSeen.length, 5);
    assert.equal(webSeen[0], "a b");
    assert.equal(webSeen[1].length, 300);
    assert.deepEqual(webSeen.slice(2), ["q2", "q3", "fresh"]);
  });

  test("a fully-deduped call is refused as already-searched", async () => {
    reset([
      toolCallsRound([{ name: "web_search", args: { queries: ["angle one"] } }]),
      toolCallsRound([{ name: "web_search", args: { queries: ["Angle One", "ANGLE ONE"] } }]),
      answerRound("done"),
    ]);
    const { webSeen } = await run();
    assert.deepEqual(webSeen, ["angle one"]);
    const lastRound = requests.filter((r) => Array.isArray(r.tools)).at(-1);
    const refusal = lastRound.messages.filter((m) => m.role === "tool").at(-1).content;
    assert.match(refusal, /Every one of those queries was already searched/);
  });

  test("a loop that throws falls back to the standard graph — nothing streamed twice", async () => {
    reset([]);
    failToolRequests = true; // e.g. an endpoint that 400s the tools param
    const { result, events, deltas } = await run();
    // The loop attempt left only its phase marker; the standard graph ran and
    // streamed the one answer.
    assert.equal(result.engine, "standard");
    assert.equal(result.action, "research");
    assert.deepEqual(events.phases, ["loop", "plan", "search", "reflect", "synth", "validate"]);
    assert.equal(deltas.join(""), "Grounded answer [1].");
  });

  test("a loop that answers without calling a tool still reaches the writer", async () => {
    reset([answerRound("**Direct conclusion.** Nothing needed checking.")]);
    const { result, events, deltas } = await run({ webSearch: async () => null });
    assert.equal(result.engine, "agentic");
    assert.deepEqual(result.subquestions, []);
    assert.equal(events.details[0].label, "Answered without calling a tool");
    // hasWeb is false (no sources registered), so the OFFLINE writer ran —
    // and its input is the working conclusion alone.
    const synth = requests.find((r) => r.stream);
    assert.match(synth.messages[0].content, /This answer rests on model knowledge/);
    assert.match(synth.messages.at(-1).content, /Your working conclusion at the end of the research:\n\*\*Direct conclusion\.\*\*/);
    assert.equal(deltas.join(""), "Grounded answer [1].");
  });

  test("engine:'standard' pins the graph — no request ever carries tools", async () => {
    reset([]);
    const { result } = await run({ opts: { engine: "standard" } });
    assert.equal(result.engine, "standard");
    assert.ok(requests.length > 0);
    assert.ok(requests.every((r) => !Array.isArray(r.tools)));
  });

  test("the full tier's brief carries the full-report structure", async () => {
    reset([answerRound("conclusion")]);
    await run({ opts: { budgetS: 480 } });
    const loopReq = requests.find((r) => Array.isArray(r.tools));
    assert.match(loopReq.messages[0].content, /REPORT DEPTH — FULL RESEARCH REPORT/);
  });
});
