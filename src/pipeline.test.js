// (no @ts-check: node:test / node:assert have no type declarations in this
// repo — tsconfig's types is workers-only and @types/node would be a new
// dependency.)
// Covers the pipeline's pure exports and the source-read pins that keep the
// phase flow honest: the answer-phase dispatch table and its engine router,
// which view each planning phase reads, and isTransientConnectStatus
// (src/answer-stream.js).
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { isTransientConnectStatus, contextOverflowMessage } from "./answer-stream.js";
import { labelWebItems, searchPolicyFor } from "./pipeline.js";

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

  // The triage phase carried a model-side `quiz` backup for typos the regexes
  // miss ("Bygg en wuiz…"). It went with the phase, so quizIntent is now the
  // ONLY gate — which is why the argument it reads is the whole of the pin.
  test("no second quiz gate reads the enriched message instead", () => {
    assert.doesNotMatch(src, /quizIntent\(ctx\.lastUser\)/);
    assert.doesNotMatch(src, /decision\.quiz === true/);
  });
});

// The follow-up loop moved to src/pipeline-standard.js's reflect node when the
// gap cascade was deleted, and its bounds moved with it (round ceiling, search
// cap, deadline — pinned in that module's own suite). What stayed HERE is the
// registry accounting the loop spends against, so this is the pin that the
// deleted loop's saturation signal did not take with it: `sourceProgress`
// counts the domain-capped finds too, and reading `sources.length` alone made
// a wave whose every result hit DOMAIN_CAP — a question whose answer lives
// across many pages of one authoritative origin — look identical to a wave
// that found nothing.
describe("the source registry's progress signal counts overflow", () => {
  const src = readFileSync(new URL("./sources.js", import.meta.url), "utf8");

  test("sourceProgress adds the overflow to the admitted registry", () => {
    assert.match(src, /export function sourceProgress\(state\) \{\s*return state\.sources\.length \+ \(state\.sourceOverflow\?\.length \|\| 0\);/);
  });

  // Deduped like the registry itself, or a later wave re-finding the same
  // capped URLs would read as new ground.
  test("a re-found capped URL does not count twice", () => {
    assert.match(src, /if \(!state\.overflowUrls\.has\(item\.url\)\)/);
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
    // The leg is DISPATCHED behind the gate (`web ? startWebLeg(…) : null`)
    // and awaited on whichever side of the aux wave this request ordered it —
    // so the gate is the ternary, and both awaits are null-guarded by it.
    assert.match(runSearches, /const webWave = web \? startWebLeg\(ctx, batch, round\) : null;/);
    assert.match(runSearches, /if \(webWave && !webLast\) await webWave\(\);/);
    assert.match(runSearches, /if \(webWave && webLast\) await webWave\(\);/);
    const webLeg = src.slice(src.indexOf("function startWebLeg"), src.indexOf("const MAX_AUX_SEARCHES_DEFAULT"));
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
    const webStartIdx = runSearches.indexOf("const webWave = web ? startWebLeg(ctx, batch, round) : null;");
    const firstAwait = runSearches.indexOf("if (webWave && !webLast) await webWave();");
    const finishIdx = runSearches.indexOf("const auxItems = await auxWave();");
    assert.ok(startIdx >= 0 && webStartIdx > startIdx, "aux wave is dispatched before the Exa leg is dispatched");
    assert.ok(firstAwait > webStartIdx, "…and BOTH are dispatched before either is awaited");
    assert.ok(finishIdx > firstAwait, "by default aux results are absorbed after the Exa leg, so numbering stays deterministic");
    // The dispatch itself is outside any `web` gate — `webWave` is null when
    // the knob is off, and only the AWAITS are guarded on it.
    assert.ok(startIdx < webStartIdx, "aux dispatch is not inside the Exa gate");
  });

  test("a request may stamp its web results with a standing caveat", () => {
    // The second half of feedback #69. The digest is what the answer model
    // reads, so a caveat only reliably attaches to a source by travelling ON
    // it — the same reasoning that puts "Preprint, not peer-reviewed" at the
    // head of every arXiv item instead of in a prompt sentence about arXiv.
    const note = "Web result — NOT peer-reviewed.";
    const items = [{ url: "https://e.com/a", title: "A", highlights: ["first", "second"] }];
    const out = labelWebItems(/** @type {any} */ ({ webSourceNote: note }), items);
    assert.deepEqual(out[0].highlights, [note, "first", "second"], "the caveat leads");
    assert.deepEqual(items[0].highlights, ["first", "second"], "the source item is not mutated");
    // A source with no highlights at all still carries it.
    assert.deepEqual(
      labelWebItems(/** @type {any} */ ({ webSourceNote: note }), [{ url: "u", title: "t" }])[0].highlights,
      [note],
    );
    // Most requests declare nothing, and those items pass through untouched.
    for (const state of [{}, { webSourceNote: "" }, { webSourceNote: "   " }, { webSourceNote: 7 }]) {
      assert.deepEqual(labelWebItems(/** @type {any} */ (state), items), items);
    }
    // Fail-soft on the shape core was handed (invariant 2).
    assert.deepEqual(labelWebItems(/** @type {any} */ ({ webSourceNote: note }), /** @type {any} */ (null)), []);
  });

  test("a request may order the web leg LAST, without either leg waiting on the other", () => {
    // feedback #69: "deep science needs web search as well but should start
    // with research sources and then validate with help from web search".
    // Ordering is a property of ABSORPTION (which fixes a source's number),
    // never of dispatch — buying the ordering with the serial latency of
    // feedback #44 would be trading one report for the other.
    const runSearches = src.slice(src.indexOf("async function runSearches"), src.indexOf("async function runWebLeg"));
    assert.match(runSearches, /const webLast = state\.webAfterAux === true;/);
    const webStartIdx = runSearches.indexOf("const webWave = web ? startWebLeg(ctx, batch, round) : null;");
    const auxAwaitIdx = runSearches.indexOf("const auxItems = await auxWave();");
    const lateAwaitIdx = runSearches.indexOf("if (webWave && webLast) await webWave();");
    assert.ok(lateAwaitIdx > auxAwaitIdx, "the late absorption happens after the aux wave lands");
    assert.ok(webStartIdx < auxAwaitIdx, "…but the web leg was still dispatched before the aux wave was awaited");
    // Generic: core reads a boolean off the state and never learns which agent
    // set it, the same seam as forceAux / auxOnly.
    assert.ok(!/scholar|science/i.test(runSearches), "runSearches names no agent or source");
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
    // …and a source the ANSWERING AGENT may not consult at all (the registry's
    // `requiresContext`, owner directive 2026-08-13) cannot lead it: after the
    // roster split an agent with no arXiv capability still MATCHED "search
    // arxiv for …", stood the web leg down on it, and answered with no sources.
    assert.match(leading, /const allowed = ids\.filter\(\(id\) => \{[\s\S]*sourceAllowed\(state, source\);/);
    // …and a source the request narrowed away (state.auxOnly — the Deep
    // Science agent restricting itself to the peer-reviewed leg) cannot lead
    // it either: a lead planAuxSource will then refuse to plan would stand the
    // web leg down and spend the wave on nothing.
    assert.match(leading, /\bstate\.auxOnly;\n\s*return Array\.isArray\(only\) && only\.length \? allowed\.filter\(/);
    assert.doesNotMatch(leading, /arxiv|\bhf\b|hugging|scholar/i);
  });

  test("web-off short-circuits to the model answer ONLY when no other source applies", () => {
    // Developer-mode source research and any applicable aux source keep the
    // research path alive with the knob off; runWithoutSearch is the fallback
    // for when none applies. "Applicable" is the source's own intent OR the
    // state's forceAux list — a mode built AROUND a source (the Hugging Face
    // agent) must not fall through to a sourceless answer just because the
    // message didn't happen to name the hub. The aux half is still subject to
    // the agent's own auxSources declaration, which outranks a forced source —
    // and, since the roster split (owner directive 2026-08-13), to the agent's
    // right to consult that source AT ALL (`sourceAllowed`, the registry's
    // `requiresContext`). Without that first test a source the answering agent
    // may not use still drags the turn through triage, a search wave and the
    // gap rounds before planAuxSource refuses to plan it — the whole pipeline
    // paid to reach the answer this branch would have written immediately.
    assert.match(
      src,
      /if \(!policy\.web\) \{[\s\S]*if \(!ctx\.hasSource && !\(policy\.auxSources && SEARCH_SOURCES\.some\(\(s\) => sourceAllowed\(state, s\) && \(forcedAux\.includes\(s\.id\) \|\| s\.intent\(ctx\.gateLastUser\)\)\)\)\) \{[\s\S]*return runWithoutSearch\(ctx\);/,
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
    assert.match(fn, /\bstate\.forceAux\b/);
    assert.match(fn, /for \(const source of SEARCH_SOURCES\)[\s\S]*forced\.includes\(source\.id\)[\s\S]*runAuxSearch\(ctx, source, batch, 1\)/);
    assert.doesNotMatch(fn, /\bhf\b|hugging/i);
    // The agent's own auxSources declaration still outranks the force.
    assert.match(fn, /!forced\.length \|\| !searchPolicyFor\(state\)\.auxSources/);

    const sourceResearch = src.slice(src.indexOf("async function runSourceResearch(ctx)"), src.indexOf("export async function runSynthesis"));
    // Run BEFORE the snapshot check, so even the no-snapshot exit has them.
    const auxIdx = sourceResearch.indexOf("await runForcedAuxSearches(ctx)");
    assert.ok(auxIdx >= 0 && auxIdx < sourceResearch.indexOf("if (!snapshot"), "forced aux runs before the snapshot check");
    // …and reaches BOTH answer paths — the native-tool one and the read loop.
    assert.match(sourceResearch, /runSourceResearchTools\(ctx, snapshot, auxBlock\)/);
    assert.match(sourceResearch, /\(auxBlock \? `\$\{auxBlock\}\\n\\n` : ""\)/);
    // The answer prompt is told external sources exist — otherwise its flat
    // "there are no external sources to cite" discards what we just fetched.
    // The `externalSources` field is what this test is about; the options object
    // has since grown `capability` (2026-08-13), which is pinned separately in
    // src/cyber-exclusivity.test.js, so match the one field rather than the
    // whole literal.
    assert.match(sourceResearch, /"source-research", "answer"\)\(\{[^}]*externalSources: !!auxBlock/);
    const tools = src.slice(src.indexOf("async function runSourceResearchTools"), src.indexOf("export const MAX_SDK_TOOL_ROUNDS"));
    assert.match(tools, /"source-research", "answer-tools"\)\(\{[^}]*externalSources: !!auxBlock/);
  });

  test("a mode may raise a source's per-request search ceiling, generically", () => {
    // feedback #36: "the Models pipeline should be even more inclined to search
    // hf". The override is read off the state by id — core names no source —
    // and only ever RAISES the registry's own default.
    const plan = src.slice(src.indexOf("function planAuxSource(ctx, source"), src.indexOf("async function runOneAuxSearch"));
    assert.match(plan, /\bstate\.auxMaxPerRequest\?\.\[source\.id\]/);
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
    // `research` became a dispatch target with the engine split (2026-08-29):
    // it routes to whichever engine engineFor picked, after the per-message
    // gates. `source-research` deliberately did NOT — which of the two a
    // knob-on turn runs is a per-message decision the hasSource +
    // externalSourceIntent gate owns, and that gate lives inside the research
    // phase rather than in the registry.
    for (const [phase, fn] of [
      ["research", "runResearchPhase"],
      ["build", "runSdkBuild"],
      ["workflow", "runOrchestration"],
      ["feed", "runOutrospection"],
      ["direct", "runWithoutSearch"],
    ]) {
      assert.match(table, new RegExp(`\\b${phase}: ${fn},`), `${phase} → ${fn}`);
    }
    assert.ok(!table.includes("source-research:"), "source-research is not a dispatch target");
    // …and the fall-through calls the SAME function, so an unreadable registry
    // and the MCP channel (which resolve no phase at all) take the identical
    // path a dispatched `research` turn takes.
    assert.match(src, /return runResearchPhase\(ctx\);/);
  });

  test("the research phase routes to an engine, and never falls out of the router", () => {
    // The properties the router has to keep. Read off the source because
    // running it needs a provider: the engine is chosen by src/agentic.js (not
    // re-decided here), the standard graph has its own branch, and every other
    // name — including one a future spec resolves that this build does not
    // know — reaches the loop, which degrades into the standard graph itself.
    // A request must always be answered by something (invariant 2), and after
    // the bespoke phases were deleted there is no fall-through left to catch
    // an unrouted turn, so the router's LAST statement has to be a call.
    const phase = src.slice(src.indexOf("async function runResearchPhase"), src.indexOf("async function runQuizResearch"));
    assert.match(phase, /const engine = engineFor\(ctx\);/);
    assert.match(phase, /if \(engine === "standard"\) return runStandardResearch\(ctx\);/);
    assert.match(phase, /return runAgenticResearch\(ctx\);\n\}/);
    // The quiz is the one research turn neither engine can finish, so it gets
    // its own short flow: runQuizGeneration replaces the report outright.
    assert.match(phase, /if \(quizReq\) return runQuizResearch\(ctx, quizReq\);/);
  });

  test("the quiz flow reuses the standard graph's nodes rather than a planner of its own", () => {
    // The deleted triage phase used to plan the quiz turn's angles. Nothing
    // replaced it with a second planner: node 1 does that job, and the flow
    // stops before the reflect loop because a quiz is written from what is
    // already in front of it.
    const quiz = src.slice(src.indexOf("async function runQuizResearch"), src.indexOf("// ---- phases ---"));
    assert.match(quiz, /await generateQueries\(ctx\)/);
    assert.match(quiz, /await runNamedUrlReads\(ctx, extractNamedUrls\(ctx\.cleanLastUser\)\)/);
    assert.match(quiz, /await runSearches\(ctx, queryPlan\.queries, 1\)/);
    assert.ok(!/reflect\(/.test(quiz), "no reflect round on a quiz turn");
    // Fail-soft: a quiz that cannot be built still produces an answer.
    assert.match(quiz, /await runSynthesis\(ctx\)/);
    assert.match(quiz, /await runValidation\(ctx, draft\)/);
  });

  // The deletion's own guard. These six were the bespoke five-phase cascade
  // and the dead deep tier hanging off it; nothing routes to them any more,
  // and re-introducing one would put a second orchestration beside the two
  // engines without anything failing.
  test("the deleted phases stay deleted", () => {
    for (const gone of [
      "async function runTriage",
      "async function runGapChecks",
      "async function maybeDigest",
      "async function maybeFullContentDigest",
      "async function runSubquestionFanout",
      "async function runClaimValidation",
    ]) {
      assert.ok(!src.includes(gone), `${gone} must not come back`);
    }
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
  const widen = src.slice(src.indexOf("function widenPlanCapacity"));

  test("both caps move together, by the same widening", () => {
    // The pairing lives in ONE function now, so this pins it there…
    assert.match(widen.slice(0, 400), /plan\.maxSources \+= n;/);
    assert.match(widen.slice(0, 400), /plan\.digestCap = Math\.min\(plan\.digestCap \+ n \* DIGEST_CHARS_PER_SOURCE, DIGEST_CAP_CEILING\)/);
    // …and this is the half the two hand-written copies could never assert:
    // no OTHER site may widen the registry, because a site that widened it
    // alone would be a reserve that admits sources the digest cannot carry.
    const widenings = [...src.matchAll(/\.maxSources \+=/g)];
    assert.equal(widenings.length, 1, "maxSources must only be widened by widenPlanCapacity");
    // Both callers reach it: the aux-source reserve and the named-URL reads.
    const reserve = src.slice(src.indexOf("if (result.items.length && !st.reserved)"));
    assert.match(reserve.slice(0, 1600), /widenPlanCapacity\(state\.plan, Math\.min\(result\.items\.length, 8\)\)/);
    assert.match(src, /widenPlanCapacity\(state\.plan, items\.length\)/);
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
    // lead wave is the only thing that ran). The web leg's recording sits in
    // startWebLeg, its DISPATCH half — a query is issued when it is sent, not
    // when the request gets round to absorbing the answer.
    const web = src.slice(src.indexOf("function startWebLeg"));
    assert.match(web.slice(0, 1600), /issuedQueries \|\|= new Set\(\)\)\.add\(query\)/);
    const absorb = src.slice(src.indexOf("function absorbAuxResult"));
    assert.match(absorb.slice(0, 1200), /issuedQueries \|\|= new Set\(\)\)\.add\(plan\.key \|\| plan\.query\)/);
  });

  // The reserve #392 added was unbounded in the direction that kills a turn:
  // four aux sources could push a 24,000-char digest to 65,600, and a
  // synthesis context overflow is not failover-eligible — the user gets no
  // answer at all rather than a shorter one.
  test("the digest reserve has a ceiling", () => {
    assert.match(src, /const DIGEST_CAP_CEILING = 36_000;/);
    // The clamp sits in the one function every widening goes through, so a
    // new caller cannot reintroduce an unbounded one.
    const widen = src.slice(src.indexOf("function widenPlanCapacity"));
    assert.match(widen.slice(0, 400), /Math\.min\(/);
    assert.match(widen.slice(0, 400), /DIGEST_CAP_CEILING\)/);
    assert.equal([...src.matchAll(/\.digestCap = /g)].length, 1, "one clamp, one writer");
  });
});

// Live feedback #65. The FOURTH instance of one bug class — a phase reading the
// enrichment-contaminated message instead of the view it actually needs — after
// the quiz gate (chat_logs #360), externalSourceIntent, and the #61 source
// ladder. It is the first instance OUTSIDE a deterministic gate, which is
// exactly why every call-site guard above this one stayed green through it: a
// reader who follows docs/MAINTENANCE-OWNERS.md back to those guards finds them
// clean and stops, because they pin gate ARGUMENTS and this defect is in a
// phase's own destructure.
//
// The mechanism: enrichments append context blocks to the user's message before
// any model call, and two of them (person_research, entity_research) append
// METHOD PROSE — how to research the subject, how to shape the report. The
// three JSON phases that WRITE web-search query strings were reading
// ctx.lastUser / ctx.convText, so a bare "Tiber style threat intel" arrived at
// the planner with 945 words of TIBER-EU / MITRE ATT&CK scaffold attached; it
// planned queries against the report FORMAT instead of the company, with the
// block's own prose visible in the first query.
//
// Neither existing view fixes it. The CLEAN pair drops the DATA enrichments a
// planner legitimately writes queries from (the transcription of the user's own
// photo above all — that is the user's question). So the fix is a third view,
// planLastUser/planConvText = withoutMethodBlocks(convo, state.methodBlocks),
// and the three phases destructure it under the old names.
//
// As with the quiz and aux-source pins: withoutMethodBlocks is pure and covered
// by conversation.test.js. The bug was WHICH VIEW THE PHASE READ, so the
// destructure is what gets pinned — and pinned per phase, sliced to each
// function body, because a whole-file /planLastUser/ match would pass with two
// of the three regressed.
describe("the query-writing phases plan from the method-block-free view", () => {
  const src = readFileSync(new URL("./pipeline.js", import.meta.url), "utf8");

  // The `const { … } = ctx;` line that opens a phase, sliced to that phase's
  // own body so one phase's destructure can never satisfy another's assertion.
  const destructureOf = (from, to) => {
    const start = src.indexOf(from);
    const end = src.indexOf(to);
    assert.ok(start !== -1, `slice start not found: ${from}`);
    assert.ok(end > start, `slice end not found after start: ${to}`);
    const line = src.slice(start, end).match(/^\s*const \{[^}]*\} = ctx;/m);
    assert.ok(line, `no ctx destructure in ${from}`);
    return line[0];
  };

  // Reads the plan view under the old names, and — after the two aliases are
  // struck out — has no bare lastUser/convText left to have read instead.
  const assertPlansFromCleanView = (line) => {
    assert.match(line, /planLastUser: lastUser/);
    assert.match(line, /planConvText: convText/);
    const withoutAliases = line.replace(/plan(?:LastUser|ConvText): (?:lastUser|convText),?\s*/g, "");
    assert.doesNotMatch(withoutAliases, /\blastUser\b/, "the raw enriched lastUser must not come back");
    assert.doesNotMatch(withoutAliases, /\bconvText\b/, "the raw enriched convText must not come back");
  };

  // The two query-writing phases moved to src/pipeline-standard.js when the
  // triage/gap cascade was deleted, so the pin follows them there. It stays
  // per-phase and sliced to each function body for the same reason: a
  // whole-file /planLastUser/ match would pass with one of the two regressed.
  const std = readFileSync(new URL("./pipeline-standard.js", import.meta.url), "utf8");
  const stdDestructureOf = (from, to) => {
    const start = std.indexOf(from);
    const end = std.indexOf(to);
    assert.ok(start !== -1, `slice start not found: ${from}`);
    assert.ok(end > start, `slice end not found after start: ${to}`);
    const line = std.slice(start, end).match(/^\s*const \{[^}]*\} = ctx;/m);
    assert.ok(line, `no ctx destructure in ${from}`);
    return line[0];
  };

  test("generateQueries plans from planLastUser/planConvText", () => {
    assertPlansFromCleanView(
      stdDestructureOf("export async function generateQueries", "export async function reflect"),
    );
  });

  test("reflect plans from planLastUser/planConvText", () => {
    assertPlansFromCleanView(
      stdDestructureOf("export async function reflect", "export async function runStandardResearch"),
    );
  });

  // The deterministic half of feedback #65 travelled with the node. Without it
  // the prompt rule is alone on the fixed JSON planner, which is exactly the
  // configuration the reported bug happened in.
  test("generateQueries still drops format-chasing angles deterministically", () => {
    assert.match(std, /import \{ focusQueriesOnSubject \} from "\.\/query-focus\.js"/);
    assert.match(std, /focusQueriesOnSubject\(plan\.queries, \{ cleanText: ctx\.cleanConvText, methodApplied \}\)/);
    // Read off the CLEAN conversation: what the user asked about is a fact
    // about their words, never about prose an enrichment appended to them.
    assert.doesNotMatch(std, /focusQueriesOnSubject\([^)]*ctx\.convText/);
  });

  // Without this the three pins above are satisfiable by a plan view that is
  // just the enriched pair under another name.
  test("the plan view is the conversation minus its method blocks", () => {
    assert.match(src, /import \{[\s\S]*?withoutMethodBlocks[\s\S]*?\} from "\.\/conversation\.js"/);
    assert.match(src, /withoutMethodBlocks\(convo, \/\*\* @type \{any\} \*\/ \(state\)\.methodBlocks\)/);
    assert.match(src, /planLastUser: textOf\(lastUserMessage\(planConvo\)\?\.content\)/);
    assert.match(src, /planConvText: formatConversation\(planConvo\)/);
  });

  test("PipelineCtx declares the third view", () => {
    const upto = src.slice(0, src.indexOf("}} PipelineCtx"));
    const typedef = upto.slice(upto.lastIndexOf("@typedef {{"));
    assert.match(typedef, /^\s*\*\s+planLastUser: string,$/m);
    assert.match(typedef, /^\s*\*\s+planConvText: string,$/m);
    // The other two views stay — synthesis still reads the enriched pair (the
    // method block IS what the answer is meant to follow) and the gates still
    // read the clean one.
    assert.match(typedef, /^\s*\*\s+lastUser: string,$/m);
    assert.match(typedef, /^\s*\*\s+cleanLastUser: string,$/m);
  });
});
