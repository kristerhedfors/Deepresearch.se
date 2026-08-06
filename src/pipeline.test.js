// (no @ts-check: node:test / node:assert have no type declarations in this
// repo — tsconfig's types is workers-only and @types/node would be a new
// dependency.)
// Covers the pipeline's pure exports: normalizeTriage (the triage-failure
// fallback incl. decomposition/quiz fields — src/triage.js), collectConflicts
// (src/pipeline.js), and isTransientConnectStatus (src/answer-stream.js).
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { isTransientConnectStatus, contextOverflowMessage } from "./answer-stream.js";
import { collectConflicts } from "./pipeline-inputs.js";
import { searchPolicyFor, subquestionsAreIndependent } from "./pipeline.js";
import { looksLikeClarifyTurn, normalizeTriage } from "./triage.js";
import { lastAssistantText } from "./conversation.js";

describe("looksLikeClarifyTurn", () => {
  // What the pipeline actually emitted on the reported conversation
  // (feedback #47): runClarify streams the question alone, nothing else.
  test("recognises the clarifying questions this pipeline emits", () => {
    for (const turn of [
      "What is the street address you'd like me to research?",
      "What kind of news are you looking for in Andalucia? (e.g., latest events, sports, politics, weather)",
      'Could you clarify what you mean by "Happy mews"? For example:\n\n1. A place or business\n2. Positive news\n3. Something else',
    ]) {
      assert.equal(looksLikeClarifyTurn(turn), true, turn.slice(0, 40));
    }
  });

  // Swedish parity by construction, not by phrase list (CLAUDE.md invariant 6):
  // the gate keys on punctuation and markdown structure, never on English
  // wording, so it must behave identically on the Swedish forms.
  test("holds for Swedish exactly as for English", () => {
    assert.equal(looksLikeClarifyTurn("Vilken gatuadress vill du att jag undersöker?"), true);
    assert.equal(looksLikeClarifyTurn("Vilken typ av nyheter är du ute efter i Andalusien?"), true);
    assert.equal(
      looksLikeClarifyTurn("## Nyheter i Andalusien\n\nDe senaste rapporterna visar [1] att läget är lugnt. Vill du veta mer?"),
      false,
    );
  });

  test("an answer is not a clarification, however it ends", () => {
    // A synthesized answer: headings and numbered citations, and it may well
    // end by offering to dig further — that offer is not a question to the
    // pipeline, and treating it as one would suppress a legitimate clarify.
    assert.equal(
      looksLikeClarifyTurn("## The launch\n\nThe rocket lifted off at dawn [1]. Want me to research the next one?"),
      false,
    );
    assert.equal(looksLikeClarifyTurn("The bezel measures 38.9mm [4]. Shall I look for more?"), false);
    assert.equal(looksLikeClarifyTurn("A".repeat(800) + "?"), false); // too long to be a question alone
    assert.equal(looksLikeClarifyTurn("Here is the answer."), false); // asks nothing
    assert.equal(looksLikeClarifyTurn(""), false);
    assert.equal(looksLikeClarifyTurn(undefined), false);
  });

  test("the unanswered-send marker is not read as a clarification", () => {
    // The marker a failed send leaves behind (feedback #45's fix): it states
    // something, it does not ask.
    assert.equal(
      looksLikeClarifyTurn("[The question above went unanswered — it was stopped before any answer arrived.]"),
      false,
    );
  });

  test("lastAssistantText reads the turn being replied to", () => {
    const conversation = [
      { role: "user", content: "news in andalucia" },
      { role: "assistant", content: "What kind of news?" },
      { role: "user", content: "Search web!" },
    ];
    assert.equal(lastAssistantText(conversation), "What kind of news?");
    assert.equal(looksLikeClarifyTurn(lastAssistantText(conversation)), true);
    assert.equal(lastAssistantText([{ role: "user", content: "first message" }]), "");
  });
});

describe("normalizeTriage", () => {
  test("clarify with a real question is preserved and trimmed", () => {
    const result = normalizeTriage({ action: "clarify", question: "  which region?  " }, "some question");
    assert.deepEqual(result, { action: "clarify", question: "which region?" });
  });

  // Feedback #47: three clarifying turns in a row, web search explicitly on,
  // not one query run. One question is help; the second is a loop.
  test("a second clarification in a row becomes a search instead", () => {
    const clarify = { action: "clarify", question: "What kind of news are you looking for?" };
    // First time through, the question stands.
    assert.deepEqual(normalizeTriage(clarify, "news in andalucia", "", { priorWasClarify: false }), {
      action: "clarify",
      question: "What kind of news are you looking for?",
    });
    // Asked once already: search rather than ask again.
    const escaped = normalizeTriage(clarify, "news in andalucia", "", { priorWasClarify: true });
    assert.equal(escaped.action, "research");
    assert.deepEqual(escaped.queries, ["news in andalucia"]);
  });

  test("the escaped clarification seeds from the prior turn for a bare follow-up", () => {
    // "Search web!" carries no topic of its own — the established one does.
    const escaped = normalizeTriage(
      { action: "clarify", question: "What would you like me to search for?" },
      "Search web!",
      "news in andalucia",
      { priorWasClarify: true },
    );
    assert.deepEqual(escaped, { action: "research", queries: ["news in andalucia"] });
  });

  test("the escaped clarification never answers directly with nothing to say", () => {
    // Too short to search and no prior turn: the normal fallback would answer
    // directly, but the user has already been asked once, so search anyway.
    const escaped = normalizeTriage({ action: "clarify", question: "Which one?" }, "reddit", "", {
      priorWasClarify: true,
    });
    assert.deepEqual(escaped, { action: "research", queries: ["reddit"] });
  });

  test("a mounted demo surface answers instead of asking what was meant", () => {
    // Feedback #58: "Lets see a starship launch" mounted the Starship
    // animation and the reply was "Do you want to see a live launch or a past
    // one?" — asked over the launch already playing above it. Once a demo is
    // on screen the ambiguity is answered, so the turn replies directly and
    // the answer prompt (capabilitiesTail's spaceScene clause) names it.
    const clarify = { action: "clarify", question: "Live or past?" };
    assert.deepEqual(
      normalizeTriage(clarify, "Lets see a starship launch", "", { demoMounted: true }),
      { action: "direct" },
    );
    // Without one, the clarification still stands — this narrows nothing else.
    assert.deepEqual(normalizeTriage(clarify, "Lets see a starship launch", "", {}), {
      action: "clarify",
      question: "Live or past?",
    });
    // The two-in-a-row escape still wins: it searches rather than answering
    // from nothing, and a demo does not change that (feedback #47).
    assert.equal(
      normalizeTriage(clarify, "news in andalucia", "", { demoMounted: true, priorWasClarify: true })
        .action,
      "research",
    );
  });

  test("clarify with a blank question falls through to the fallback logic", () => {
    const result = normalizeTriage({ action: "clarify", question: "   " }, "a long enough question here");
    assert.equal(result.action, "research");
  });

  test("research action filters out non-string and blank queries", () => {
    const result = normalizeTriage({ action: "research", queries: ["real query", "", null, 42, "  "] }, "x");
    assert.deepEqual(result, { action: "research", queries: ["real query"] });
  });

  test("research action with no usable queries falls back", () => {
    const result = normalizeTriage({ action: "research", queries: [] }, "a long enough fallback question");
    assert.equal(result.action, "research");
    assert.deepEqual(result.queries, ["a long enough fallback question"]);
  });

  test("direct action passes through", () => {
    assert.deepEqual(normalizeTriage({ action: "direct" }, "hi"), { action: "direct" });
  });

  test("the optional quiz flag rides along on direct and research, strict-boolean only", () => {
    assert.deepEqual(normalizeTriage({ action: "direct", quiz: true }, "wuiz me"), { action: "direct", quiz: true });
    const research = normalizeTriage({ action: "research", queries: ["glider handbook"], quiz: true }, "x");
    assert.equal(research.quiz, true);
    // Anything but literal true is dropped — never a truthy-string surprise.
    assert.deepEqual(normalizeTriage({ action: "direct", quiz: "yes" }, "hi"), { action: "direct" });
    assert.equal(normalizeTriage({ action: "research", queries: ["q"], quiz: 1 }, "x").quiz, undefined);
    // And clarify never carries it.
    assert.deepEqual(
      normalizeTriage({ action: "clarify", question: "which?", quiz: true }, "x"),
      { action: "clarify", question: "which?" },
    );
  });

  test("unparseable triage falls back to research when the user message is long enough (>=12 chars)", () => {
    const result = normalizeTriage(null, "this is a decently long question");
    assert.equal(result.action, "research");
    assert.deepEqual(result.queries, ["this is a decently long question"]);
  });

  test("unparseable triage falls back to direct when the user message is short (<12 chars)", () => {
    const result = normalizeTriage(undefined, "hi there");
    assert.equal(result.action, "direct");
  });

  test("fallback research query is truncated to 300 chars", () => {
    const long = "x".repeat(400);
    const result = normalizeTriage({}, long);
    assert.equal(result.queries[0].length, 300);
  });

  test("on triage failure, a short follow-up seeds the search from the prior question, not the referential phrase", () => {
    // "undersök saken" ("investigate the matter") is meaningless as a literal
    // search; with a prior turn present the fallback searches that topic.
    const result = normalizeTriage(null, "undersök saken", "Vad hände med Northvolt konkursen?");
    assert.equal(result.action, "research");
    assert.deepEqual(result.queries, ["Vad hände med Northvolt konkursen?"]);
  });

  test("with no prior turn there is nothing to resolve against, so a short standalone message is researched as-is (pre-existing behavior, unchanged)", () => {
    // A bare "undersök saken" as the FIRST message has no context to seed
    // from and is indistinguishable from a legit short query like
    // "Northvolt konkurs 2026"; the follow-up seeding only applies when a
    // prior user turn exists. This documents that the prior-less path keeps
    // the original >=12-char research fallback.
    const result = normalizeTriage(null, "undersök saken");
    assert.equal(result.action, "research");
    assert.deepEqual(result.queries, ["undersök saken"]);
  });

  test("on triage failure, a substantial standalone message is still researched as-is even with prior context", () => {
    const msg = "What is the current market share of electric vehicles in Norway in 2026?";
    const result = normalizeTriage(null, msg, "earlier unrelated question about batteries");
    assert.equal(result.action, "research");
    assert.deepEqual(result.queries, [msg]);
  });
});

describe("normalizeTriage — decomposition fields (complexity, subquestions)", () => {
  test("carries a valid complexity and trimmed sub-questions through the research path", () => {
    const result = normalizeTriage(
      {
        action: "research",
        queries: ["q1"],
        complexity: "multihop",
        subquestions: ["  Who owns X? ", "What did the owner announce?"],
      },
      "x",
    );
    assert.equal(result.complexity, "multihop");
    assert.deepEqual(result.subquestions, ["Who owns X?", "What did the owner announce?"]);
  });

  test("omits both fields when absent — the pre-decomposition shape exactly", () => {
    const result = normalizeTriage({ action: "research", queries: ["real query"] }, "x");
    assert.deepEqual(result, { action: "research", queries: ["real query"] });
  });

  test("carries a valid decomposition value", () => {
    for (const shape of ["independent", "sequential"]) {
      const result = normalizeTriage(
        { action: "research", queries: ["q"], decomposition: shape },
        "x",
      );
      assert.equal(result.decomposition, shape, shape);
    }
  });

  test("drops an unknown decomposition value instead of carrying junk", () => {
    const result = normalizeTriage(
      { action: "research", queries: ["q"], decomposition: "parallel-ish" },
      "x",
    );
    assert.equal("decomposition" in result, false);
  });

  test("a Swedish research turn carries the shape fields the same way", () => {
    // Invariant 6 in spirit: the classifier is a model field rather than a
    // regex gate, but a Swedish request must reach the fan-out gate with the
    // same shape as an English one — no language-dependent drop-out.
    const result = normalizeTriage(
      {
        action: "research",
        queries: ["jämför elbilar"],
        complexity: "comparison",
        subquestions: ["Vad kostar en Volvo EX30?", "Vad kostar en Tesla Model 3?"],
        decomposition: "independent",
      },
      "jämför elbilar",
    );
    assert.equal(result.decomposition, "independent");
    assert.equal(subquestionsAreIndependent(result), true);
  });
});

describe("subquestionsAreIndependent — the fan-out shape gate", () => {
  test("the classifier decides when it spoke", () => {
    assert.equal(subquestionsAreIndependent({ decomposition: "independent" }), true);
    assert.equal(subquestionsAreIndependent({ decomposition: "sequential" }), false);
  });

  test("a sequential verdict overrides a fan-out-friendly complexity", () => {
    // The whole point of asking directly: a survey whose angles build on each
    // other used to fan out purely because "survey" was the proxy.
    assert.equal(
      subquestionsAreIndependent({ complexity: "survey", decomposition: "sequential" }),
      false,
    );
  });

  test("multihop is refused even when the classifier claims independence", () => {
    // Hop 2 cannot be searched until hop 1 surfaces the bridging fact, so a
    // concurrent audit of it audits an unanswerable question.
    assert.equal(
      subquestionsAreIndependent({ complexity: "multihop", decomposition: "independent" }),
      false,
    );
  });

  test("falls back to the complexity proxy when the field is absent", () => {
    assert.equal(subquestionsAreIndependent({ complexity: "comparison" }), true);
    assert.equal(subquestionsAreIndependent({ complexity: "survey" }), true);
    assert.equal(subquestionsAreIndependent({ complexity: "multihop" }), false);
    assert.equal(subquestionsAreIndependent({ complexity: "simple" }), false);
    assert.equal(subquestionsAreIndependent({}), false);
  });

  test("drops an unknown complexity value instead of carrying junk", () => {
    const result = normalizeTriage(
      { action: "research", queries: ["q"], complexity: "extreme" },
      "x",
    );
    assert.equal("complexity" in result, false);
  });

  test("filters non-string/blank sub-questions and caps at 5", () => {
    const result = normalizeTriage(
      {
        action: "research",
        queries: ["q"],
        subquestions: ["a", "", null, 42, "b", "c", "d", "e", "f"],
      },
      "x",
    );
    assert.deepEqual(result.subquestions, ["a", "b", "c", "d", "e"]);
  });

  test("an empty subquestions array is omitted, not attached", () => {
    const result = normalizeTriage(
      { action: "research", queries: ["q"], subquestions: [] },
      "x",
    );
    assert.equal("subquestions" in result, false);
  });
});

describe("collectConflicts", () => {
  test("accumulates trimmed conflicts across gap rounds, deduped", () => {
    const state = {};
    collectConflicts(state, { conflicts: [" A says 5, B says 7 ", "dates differ"] });
    collectConflicts(state, { conflicts: ["dates differ", "C disputes the attribution"] });
    assert.deepEqual(state.conflicts, [
      "A says 5, B says 7",
      "dates differ",
      "C disputes the attribution",
    ]);
  });

  test("missing/malformed conflicts fields are simply no conflicts", () => {
    const state = {};
    collectConflicts(state, null);
    collectConflicts(state, {});
    collectConflicts(state, { conflicts: "not an array" });
    collectConflicts(state, { conflicts: [null, "", 42] });
    assert.deepEqual(state.conflicts, []);
  });

  test("caps the accumulated list at 6", () => {
    const state = {};
    collectConflicts(state, { conflicts: ["1", "2", "3", "4"] });
    collectConflicts(state, { conflicts: ["5", "6", "7", "8"] });
    assert.equal(state.conflicts.length, 6);
  });
});

describe("isTransientConnectStatus", () => {
  test("provider-side statuses are retryable", () => {
    for (const status of [500, 502, 503, 504, 429, 408]) {
      assert.equal(isTransientConnectStatus(status), true, `status ${status}`);
    }
  });

  test("deterministic client errors are not retried", () => {
    for (const status of [400, 401, 403, 404, 413, 422]) {
      assert.equal(isTransientConnectStatus(status), false, `status ${status}`);
    }
  });
});

// Regression pin for chat_logs #524 (2026-07-18): an introspection turn on the
// 32k Mistral Small overran the context window and the raw Berget 400 JSON was
// dumped at the user with no answer. contextOverflowMessage() rewrites that
// deterministic "input too large" 400 into a clean, actionable sentence; every
// other 400 (and every non-400) passes through untouched so the normal error
// path still surfaces.
describe("contextOverflowMessage", () => {
  test("rewrites the OpenAI-shape context_length_exceeded 400", () => {
    const berget400 =
      '{"error":{"message":"This model\'s maximum context length is 32768 tokens. ' +
      'However, your input is estimated at 32134 tokens. Please reduce the length of ' +
      'the input.","type":"invalid_request_error","code":"context_length_exceeded"}}';
    const msg = contextOverflowMessage(400, berget400);
    assert.ok(msg, "an overflow 400 yields a message");
    assert.match(msg, /too long for the selected model/i);
    assert.doesNotMatch(msg, /context_length_exceeded|invalid_request_error/, "no raw provider JSON leaks");
  });

  test("matches the several phrasings OpenAI-compatible providers use", () => {
    for (const detail of [
      "context_length_exceeded",
      "context length exceeded",
      "This model's maximum context length is 8192 tokens",
      "the model's context window is too small",
      "Please reduce the length of the messages",
      "Please reduce the length of the prompt",
    ]) {
      assert.ok(contextOverflowMessage(400, detail), `should match: ${detail}`);
    }
  });

  test("leaves other 400s and non-400 statuses alone", () => {
    assert.equal(contextOverflowMessage(400, '{"error":{"message":"bad request"}}'), null);
    assert.equal(contextOverflowMessage(400, ""), null);
    assert.equal(contextOverflowMessage(401, "context_length_exceeded"), null);
    assert.equal(contextOverflowMessage(500, "maximum context length"), null);
  });
});

// Regression pin for chat_logs #360 (2026-07-15): the deterministic quiz gate
// must read the CLEAN pre-enrichment message, never the enrichment-appended
// lastUser — the introspection block folded into lastUser carries the
// CLAUDE.md orientation, whose prose contains literal "quiz me…" examples, so
// with developer mode on EVERY request quiz-triggered and the whole answer
// became a 5-question quiz. quizIntent itself is pure and correct (quiz.test
// covers it); the bug was the CALL SITE's argument, so that is what gets
// pinned — same style as the façade-contract source pins elsewhere.
describe("quiz gate reads the clean (pre-enrichment) user message", () => {
  const src = readFileSync(new URL("./pipeline.js", import.meta.url), "utf8");

  test("the primary deterministic gate uses cleanLastUser", () => {
    assert.match(src, /quizIntent\(ctx\.cleanLastUser\)/);
    assert.doesNotMatch(src, /quizIntent\(ctx\.lastUser\)/);
  });

  test("the triage-backup question count uses cleanLastUser", () => {
    assert.match(src, /quizQuestionCount\(ctx\.cleanLastUser\)/);
    assert.doesNotMatch(src, /quizQuestionCount\(ctx\.lastUser\)/);
  });
});

// Regression pin (feedback: "gave up too early" / "strive toward the depth
// target, shortcut if there isn't more to explore"): the deep-tier gap loop
// now runs a HIGH round ceiling (budget.js), so it needs a diminishing-returns
// stop — a follow-up wave that adds NO new sources ends the loop instead of
// spinning further rounds against the same registry. This is the meaningful-
// action guarantee that keeps the raised ceiling honest.
describe("gap loop stops when a follow-up wave surfaces no new sources", () => {
  const src = readFileSync(new URL("./pipeline.js", import.meta.url), "utf8");

  test("runGapChecks captures progress before the wave and breaks on no gain", () => {
    assert.match(src, /const foundBefore = sourceProgress\(state\)/);
    assert.match(src, /const gained = sourceProgress\(state\) - foundBefore/);
    assert.match(src, /if \(gained === 0\)[\s\S]*?break/);
    // The break lives AFTER the searches run (it measures their yield), not before.
    assert.match(src, /await runSearches\(ctx, followups[\s\S]*?gained === 0/);
  });

  // The signal must count the domain-capped finds too. Reading
  // `state.sources.length` alone made a wave whose every result hit
  // DOMAIN_CAP — a question whose answer lives across many pages of one
  // authoritative origin — look identical to a wave that found nothing, and
  // the loop stopped researching while it was still finding new pages.
  // sourceProgress's own behaviour is pinned in src/sources.test.js.
  test("the signal counts overflow, not just admitted sources", () => {
    assert.doesNotMatch(
      src,
      /if \(state\.sources\.length === sourcesBefore\)/,
      "the old admitted-only signal must not come back",
    );
    assert.match(src, /import \{[\s\S]*?sourceProgress[\s\S]*?\} from "\.\/sources\.js"/);
  });

  // Backlog #4 (docs/DEEP-RESEARCH-TECHNIQUES.md): whether rounds past the
  // second contribute anything was unmeasurable — only the saturation break
  // was logged, and it carried no source counts.
  test("each round logs what it gained, so the loop's contribution is measurable", () => {
    assert.match(src, /log\.info\("chat\.gap_round", \{[\s\S]*?gained,[\s\S]*?admitted:[\s\S]*?capped:/);
  });
});

// Measured on the ground-truth battery (tests/DR-EVAL-FINDINGS.md,
// 2026-08-05): with an empty registry, answers came back carrying a numbered
// source list whose every URL was the literal string "URL", cited [1]…[10]
// throughout — and every one was graded CORRECT. The model knew the answer and
// dressed it in citation furniture. "Use ONLY the numbered sources" does not
// cover the case where there are none.
describe("an empty source registry forbids citation markers outright", () => {
  const src = readFileSync(new URL("./pipeline.js", import.meta.url), "utf8");

  test("runSynthesis says so explicitly instead of passing an empty list", () => {
    const synth = src.slice(src.indexOf("async function runSynthesis"), src.indexOf("// Phase 5"));
    assert.match(synth, /Numbered sources: NONE/);
    assert.match(synth, /do NOT write any \[n\] citation markers/);
    assert.match(synth, /not backed by retrieved sources/);
    // And the ordinary path is untouched: a non-empty digest still goes out
    // under the same header it always did.
    assert.match(synth, /`Numbered sources:\\n\$\{digest\}`/);
  });
});

describe("the web-search knob gates Exa only — depth still runs over other sources", () => {
  const src = readFileSync(new URL("./pipeline.js", import.meta.url), "utf8");

  // The gate is now reached through searchPolicyFor(state) — the knob ANDed
  // with the answering agent's declared ceiling (AgentSpec 0.2.0
  // capability.search). These pin the POLICY the way prompt-sets.test.js pins
  // a prompt role rather than a literal call: that the knob still decides is
  // asserted against the helper, and behaviour against the helper's own suite.
  test("the knob reaches the Exa gate through the search policy", () => {
    // searchPolicyFor must read state.webSearch — if it stopped, every pin
    // below would still match while the knob quietly did nothing.
    assert.match(src, /export function searchPolicyFor\(state\)[\s\S]*capSearch\([\s\S]*\{ web: state\.webSearch \}\)/);
  });

  test("runSearches gates the Exa call on the resolved policy", () => {
    // The web leg (webSearch(env,…) + its billing counter) lives behind the
    // gate; without it the knob would still search when off. The call carries
    // the user's picked SOURCE — which engine runs it — but the gate is what
    // decides whether it runs at all.
    const runSearches = src.slice(src.indexOf("async function runSearches"), src.indexOf("async function runWebLeg"));
    assert.match(runSearches, /const web = policy\.web && !lead\.length;/);
    assert.match(runSearches, /if \(web\) await runWebLeg\(ctx, batch, round\);/);
    const webLeg = src.slice(src.indexOf("async function runWebLeg"), src.indexOf("const MAX_AUX_SEARCHES_DEFAULT"));
    assert.match(webLeg, /webSearch\(env, log, query, state\.plan\.searchDepth, \{ source: state\.searchSource \|\| "" \}\)/);
    assert.match(webLeg, /state\.searchCount \+= batch\.length/);
  });

  test("the aux wave runs regardless of the knob, and CONCURRENTLY with Exa", () => {
    // Two properties in one shape. (a) The aux wave (HF Hub & co) must NOT be
    // inside the Exa gate, so it still fires with web search off — depth over
    // available sources. It has its own declaration (`search.auxSources`),
    // which is a different question. (b) It is DISPATCHED before the Exa leg
    // is awaited: running the two serially put every aux source's latency
    // straight onto the user's wall clock (feedback #44, "the arXiv searches
    // took close to a minute").
    const runSearches = src.slice(src.indexOf("async function runSearches"), src.indexOf("async function runWebLeg"));
    const startIdx = runSearches.indexOf("const auxWave = startAuxSearches(ctx, batch, round, lead);");
    const webIdx = runSearches.indexOf("if (web) await runWebLeg(ctx, batch, round);");
    const finishIdx = runSearches.indexOf("const auxItems = await auxWave();");
    assert.ok(startIdx >= 0 && webIdx > startIdx, "aux wave is dispatched before the Exa leg is awaited");
    assert.ok(finishIdx > webIdx, "aux results are absorbed after the Exa leg, so numbering stays deterministic");
    // The dispatch itself is outside any `web` gate.
    assert.ok(startIdx < runSearches.indexOf("if (web)"), "aux dispatch is not inside the Exa gate");
  });

  test("a source the user names by NAME leads the wave, and the lead fails soft", () => {
    // feedback #44: "if asked for arXiv explicitly, start there and do only
    // arxiv unless called for otherwise". A leading source displaces the web
    // leg; a lead that finds nothing releases so "only X" can never become
    // "no sources at all" (invariant 2).
    const runSearches = src.slice(src.indexOf("async function runSearches"), src.indexOf("async function runWebLeg"));
    assert.match(runSearches, /const lead = leadingSources\(ctx\);/);
    assert.match(runSearches, /const web = policy\.web && !lead\.length;/);
    assert.match(
      runSearches,
      /if \(lead\.length && !auxItems && policy\.web\) \{[\s\S]*auxLeadReleased = true;[\s\S]*await runWebLeg\(ctx, batch, round\);/,
    );
    // Generic: the rule for what counts as naming a source lives in that
    // source's module; the orchestrator reads ids only.
    const leading = src.slice(src.indexOf("function leadingSources(ctx)"), src.indexOf("function startAuxSearches"));
    // …from the CLEAN pre-enrichment message: feedback #61 (see the
    // "auxiliary source gates" block below) — an enrichment block that merely
    // NAMES a source must not silently lead the request.
    assert.match(leading, /const ids = leadSourceIds\(ctx\.gateLastUser\);/);
    // …and a source the request narrowed away (state.auxOnly — the Deep
    // Science agent restricting itself to the peer-reviewed leg) cannot lead
    // it either: a lead planAuxSource will then refuse to plan would stand the
    // web leg down and spend the wave on nothing.
    assert.match(leading, /state\)\.auxOnly;\n\s*return Array\.isArray\(only\) && only\.length \? ids\.filter\(/);
    assert.doesNotMatch(leading, /arxiv|\bhf\b|hugging|scholar/i);
  });

  test("web-off short-circuits to the model answer ONLY when no other source applies", () => {
    // Developer-mode source research and any applicable aux source keep the
    // research path alive with the knob off; runWithoutSearch is the fallback
    // for when none applies. "Applicable" is the source's own intent OR the
    // state's forceAux list — a mode built AROUND a source (the Hugging Face
    // agent) must not fall through to a sourceless answer just because the
    // message didn't happen to name the hub. The aux half is still subject to
    // the agent's own auxSources declaration, which outranks a forced source.
    assert.match(
      src,
      /if \(!policy\.web\) \{[\s\S]*if \(!ctx\.hasSource && !\(policy\.auxSources && SEARCH_SOURCES\.some\(\(s\) => forcedAux\.includes\(s\.id\) \|\| s\.intent\(ctx\.gateLastUser\)\)\)\) \{[\s\S]*return runWithoutSearch\(ctx\);/,
    );
  });

  test("a forced source runs even when the message does not engage it", () => {
    // The forceAux seam itself: runAuxSearch skips a source whose intent is
    // false UNLESS the state listed its id. Generic — the pipeline reads ids
    // off the state and never names one.
    const plan = src.slice(src.indexOf("function planAuxSource(ctx, source"), src.indexOf("async function runOneAuxSearch"));
    assert.match(plan, /forceAux[\s\S]*\.includes\(source\.id\)/);
    assert.match(plan, /if \(!batch\.length \|\| \(!forced && !leading && !source\.intent\(ctx\.gateLastUser\)\)\) return \[\];/);
  });

  test("a forced source survives the developer-mode source-research path (feedback #36)", () => {
    // The regression this cost us: `state.forceAux` was honoured only inside
    // the search wave, and developer mode never reaches a wave — it answers
    // from the site's own files. So the Models agent, whose whole identity is
    // the model hub, answered model questions with 0 searches / 0 sources
    // whenever dev mode was also on (chat_logs #670, #671). Both source-
    // research answer paths must now carry the forced sources' findings.
    const fn = src.slice(src.indexOf("async function runForcedAuxSearches"), src.indexOf("async function runSourceResearch(ctx)"));
    // Generic: ids come off the state, no source is named here.
    assert.match(fn, /state\)\.forceAux/);
    assert.match(fn, /for \(const source of SEARCH_SOURCES\)[\s\S]*forced\.includes\(source\.id\)[\s\S]*runAuxSearch\(ctx, source, batch, 1\)/);
    assert.doesNotMatch(fn, /\bhf\b|hugging/i);
    // The agent's own auxSources declaration still outranks the force.
    assert.match(fn, /!forced\.length \|\| !searchPolicyFor\(state\)\.auxSources/);

    const sourceResearch = src.slice(src.indexOf("async function runSourceResearch(ctx)"), src.indexOf("async function runSubquestionFanout"));
    // Run BEFORE the snapshot check, so even the no-snapshot exit has them.
    const auxIdx = sourceResearch.indexOf("await runForcedAuxSearches(ctx)");
    assert.ok(auxIdx >= 0 && auxIdx < sourceResearch.indexOf("if (!snapshot"), "forced aux runs before the snapshot check");
    // …and reaches BOTH answer paths — the native-tool one and the read loop.
    assert.match(sourceResearch, /runSourceResearchTools\(ctx, snapshot, auxBlock\)/);
    assert.match(sourceResearch, /\(auxBlock \? `\$\{auxBlock\}\\n\\n` : ""\)/);
    // The answer prompt is told external sources exist — otherwise its flat
    // "there are no external sources to cite" discards what we just fetched.
    assert.match(sourceResearch, /"source-research", "answer"\)\(\{ externalSources: !!auxBlock \}\)/);
    const tools = src.slice(src.indexOf("async function runSourceResearchTools"), src.indexOf("export const MAX_SDK_TOOL_ROUNDS"));
    assert.match(tools, /"source-research", "answer-tools"\)\(\{ externalSources: !!auxBlock \}\)/);
  });

  test("a mode may raise a source's per-request search ceiling, generically", () => {
    // feedback #36: "the Models pipeline should be even more inclined to search
    // hf". The override is read off the state by id — core names no source —
    // and only ever RAISES the registry's own default.
    const plan = src.slice(src.indexOf("function planAuxSource(ctx, source"), src.indexOf("async function runOneAuxSearch"));
    assert.match(plan, /state\)\.auxMaxPerRequest\?\.\[source\.id\]/);
    assert.match(plan, /typeof override === "number" && override > 0 \? override : \(declared \?\? MAX_AUX_SEARCHES_DEFAULT\)/);
    // …and the registry's own ceilings — the ordinary one, and the higher one
    // a source declares for when it LEADS (feedback #44) — are what `declared`
    // resolves to, never a number written into the orchestrator.
    assert.match(plan, /const declared = \(leading \? source\.leadMaxPerRequest \?\? source\.maxPerRequest : source\.maxPerRequest\);/);
    // The cap is spent, never exceeded: `want` is what remains of it.
    assert.match(plan, /const want = Math\.max\(0, leading \? cap - st\.count : Math\.min\(1, cap - st\.count\)\);/);
  });

  test("an introspection agent's `search.web: false` does not disarm the knob", () => {
    // The regression this stage could most easily have shipped. Introspection
    // declares web:false because its OWN phase does not search; the pipeline
    // reaches the research flow below only when the per-message
    // externalSourceIntent gate hands the turn back precisely in order to
    // search. A capability governs the phase it names and no other.
    const introspecting = { webSearch: true, capability: { answerPhase: "source-research", search: { web: false } } };
    assert.equal(searchPolicyFor(/** @type {any} */ (introspecting)).web, true);
    // …while an agent that DOES declare the research phase narrows it.
    const declared = { webSearch: true, capability: { answerPhase: "research", search: { web: false } } };
    assert.equal(searchPolicyFor(/** @type {any} */ (declared)).web, false);
    // …and no declaration at all is the knob alone, both ways.
    assert.equal(searchPolicyFor(/** @type {any} */ ({ webSearch: true, capability: null })).web, true);
    assert.equal(searchPolicyFor(/** @type {any} */ ({ webSearch: false, capability: null })).web, false);
  });

  test("a declared search ceiling can never widen the knob", () => {
    // Narrowing in both directions: the knob off wins over any declaration.
    const state = { webSearch: false, capability: { answerPhase: "research", search: { web: true } } };
    assert.equal(searchPolicyFor(/** @type {any} */ (state)).web, false);
  });

  test("runWithoutSearch scales the model answer by the slider's report tier", () => {
    // The prompt is reached through the prompt-set binding (src/prompt-sets.js)
    // rather than imported directly, so this pins the ROLE the phase asks for
    // plus the report tier it threads in. Which builder that role resolves to is
    // pinned by identity in prompt-sets.test.js.
    assert.match(
      src,
      /phasePrompt\(ctx\.state, "direct", "answer-search-off"\)\(\{[^}]*reportTier: ctx\.state\.plan\.reportTier/,
    );
  });
});

// ---- the answer-phase dispatch (stage 3, extended by stage 6) ----------------
//
// The registry-resolved `capability.answerPhase` picks the executor. This was
// never pinned: a grep for the mode flags across every *.test.js hit only
// prompts.test.js, so the table could lose a row without a failing test.

describe("the answer-phase dispatch table", () => {
  const src = readFileSync(new URL("./pipeline.js", import.meta.url), "utf8");
  const table = src.slice(src.indexOf("const ANSWER_PHASE_RUNNERS"), src.indexOf("function answerPhaseFor"));

  test("every executor phase in the vocabulary has a runner", () => {
    // ANSWER_PHASES also declares `research` and `source-research`, which are
    // deliberately NOT dispatch targets: which of those two a knob-on turn runs
    // is a per-message decision the hasSource + externalSourceIntent gate owns.
    for (const [phase, fn] of [
      ["build", "runSdkBuild"],
      ["workflow", "runOrchestration"],
      ["feed", "runOutrospection"],
      ["direct", "runWithoutSearch"],
    ]) {
      assert.match(table, new RegExp(`\\b${phase}: ${fn},`), `${phase} → ${fn}`);
    }
    assert.ok(!/\bresearch:/.test(table), "research is not a dispatch target");
    assert.ok(!/\bsource-research:/.test(table), "source-research is not a dispatch target");
  });

  test("the mode booleans survive as the fail-soft fallback", () => {
    // An unreadable registry, and the MCP channel which builds state without
    // any of this, both depend on these three (invariant 2).
    assert.match(src, /if \(state\.sdkMode\) return "build";/);
    assert.match(src, /if \(state\.orchestratorMode\) return "workflow";/);
    assert.match(src, /if \(state\.outrospectionMode\) return "feed";/);
    // `direct` deliberately has NO boolean fallback: it is reachable only by
    // addressing an agent that declares it, so there is no mode to fall back to.
    assert.ok(!/return "direct";/.test(src.slice(src.indexOf("function answerPhaseFor"), src.indexOf("function answerPhaseFor") + 900)));
  });
});

// The same bug class a THIRD time (after the quiz gate above and
// externalSourceIntent): a deterministic gate reading the ENRICHMENT-appended
// user message instead of the clean one. Reported as feedback #61 (chat_logs
// #1656, 2026-08-05) — "Research this founder" with a LinkedIn screenshot.
//
// The person-research enrichment appends a ~700-word METHOD block to the
// user's own message. Its source ladder names OpenAlex, so scholarLeadIntent
// matched; a LEADING aux source stands the Exa leg down for the whole request
// (`const web = policy.web && !lead.length`), so the web leg never ran and the
// first thirteen numbered sources were cancer-conference abstract books. One
// "health" in the block's privacy prohibition ("never an inference of
// ethnicity, health, religion…") satisfied europepmcIntent's life-science half
// the same way.
//
// The gates themselves are pure and covered by their own suites; as with the
// quiz gate, the bug was the CALL SITE's argument, so that is what gets pinned.
describe("auxiliary source gates read the clean (pre-enrichment) user message", () => {
  const src = readFileSync(new URL("./pipeline.js", import.meta.url), "utf8");

  test("a source's intent gate uses cleanLastUser", () => {
    assert.match(src, /source\.intent\(ctx\.gateLastUser\)/);
    assert.doesNotMatch(src, /source\.intent\(ctx\.lastUser\)/);
  });

  test("the lead gate uses cleanLastUser", () => {
    // Leading is the costlier half: it stands the web leg down for the whole
    // request and never releases while the lead keeps returning items.
    assert.match(src, /leadSourceIds\(ctx\.gateLastUser\)/);
    assert.doesNotMatch(src, /leadSourceIds\(ctx\.lastUser\)/);
  });
});

// A reserve that admits more sources without paying for their prose does not
// add them to what synthesis READS — the digest is a character budget filled in
// arrival order, so the extra sources push the highest-numbered ones out of the
// window instead. That is how feedback #61's answer came to report that no
// independent press coverage existed while four independent sources sat unread
// past the cut.
describe("the aux registry reserve widens the digest with it", () => {
  const src = readFileSync(new URL("./pipeline.js", import.meta.url), "utf8");
  const reserve = src.slice(src.indexOf("if (result.items.length && !st.reserved)"));

  test("both caps move together, by the same widening", () => {
    assert.match(reserve.slice(0, 1200), /state\.plan\.maxSources \+= widened;/);
    assert.match(reserve.slice(0, 1600), /state\.plan\.digestCap = Math\.min\(/);
    assert.match(reserve.slice(0, 1600), /DIGEST_CAP_CEILING,/);
  });

  test("the per-source reserve is sized off the measured verbose block", () => {
    // Europe PMC / Scholar blocks run ~1,200-1,330 chars; reserving the web
    // figure (~400) would under-buy for exactly the sources that trigger it.
    assert.match(src, /const DIGEST_CHARS_PER_SOURCE = 1300;/);
  });
});

// Nothing recorded how many of the collected sources synthesis could actually
// read, which is why feedback #61 needed a source-list diff to diagnose: the
// answer was written from 15 sources and the reader was shown 35 beneath it.
describe("digest coverage is observable", () => {
  const src = readFileSync(new URL("./pipeline.js", import.meta.url), "utf8");

  test("synthesis logs how many sources the digest carried", () => {
    assert.match(src, /chat\.digest_coverage/);
    assert.match(src, /digestShownCount\(state\.sources, plan\.digestCap\)/);
  });
});

// The follow-up to #392's own review. Three defects that fix introduced, all
// found by adversarially re-reading it rather than by a user report.
describe("what the source-routing gates read, and what the ledger may claim", () => {
  const src = readFileSync(new URL("./pipeline.js", import.meta.url), "utf8");

  // #392 moved the aux gates onto the CLEAN message so prose the pipeline
  // appended to itself could not route a request. It moved one thing too many:
  // the vision transcription of the user's OWN attachment also rides in the
  // enriched message, and that is the user's question, not our prose. A photo
  // of a paper's record page plus "what is this about" routed on a message
  // with no subject in it.
  test("the gates read the clean message PLUS the user's own attachment", () => {
    assert.match(src, /gateLastUser: \[/);
    assert.match(src, /\(state\)\.imageReadText \|\| ""/);
    for (const call of [/leadSourceIds\(ctx\.gateLastUser\)/, /source\.intent\(ctx\.gateLastUser\)/, /s\.intent\(ctx\.gateLastUser\)/]) {
      assert.match(src, call);
    }
    // The thing #392 was right about stays fixed: never the enriched message.
    assert.doesNotMatch(src, /leadSourceIds\(ctx\.lastUser\)/);
    assert.doesNotMatch(src, /source\.intent\(ctx\.lastUser\)/);
  });

  // ranQueries is written by takeSearchBatch BEFORE the wave picks its legs,
  // so it also holds angles nothing was ever asked — the web knob off, or an
  // aux source leading and standing the web leg down. Showing those to the
  // answer model invites it to attest to searches that never happened, which
  // is the very error class the ledger exists to prevent.
  test("the ledger is built from DISPATCHED queries, never the planned set", () => {
    assert.match(src, /searchLedgerSection\(\/\*\* @type \{any\} \*\/ \(state\)\.issuedQueries\)/);
    assert.doesNotMatch(src, /searchLedgerSection\(state\.ranQueries\)/);
    // Both dispatch points record: the web leg, and the aux leg (which on a
    // lead wave is the only thing that ran).
    const web = src.slice(src.indexOf("async function runWebLeg"));
    assert.match(web.slice(0, 1200), /issuedQueries \|\|= new Set\(\)\)\.add\(query\)/);
    const absorb = src.slice(src.indexOf("function absorbAuxResult"));
    assert.match(absorb.slice(0, 1200), /issuedQueries \|\|= new Set\(\)\)\.add\(plan\.key \|\| plan\.query\)/);
  });

  // The reserve #392 added was unbounded in the direction that kills a turn:
  // four aux sources could push a 24,000-char digest to 65,600, and a
  // synthesis context overflow is not failover-eligible — the user gets no
  // answer at all rather than a shorter one.
  test("the digest reserve has a ceiling", () => {
    assert.match(src, /const DIGEST_CAP_CEILING = 36_000;/);
    const reserve = src.slice(src.indexOf("if (result.items.length && !st.reserved)"));
    assert.match(reserve.slice(0, 1600), /Math\.min\(/);
    assert.match(reserve.slice(0, 1600), /DIGEST_CAP_CEILING,/);
  });
});
