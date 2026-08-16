// (no @ts-check: node:test / node:assert have no type declarations in this
// repo — tsconfig's types is workers-only and @types/node would be a new
// dependency.)
// SLASH COMMANDS are PLATFORM BASELINE — the every-mode routing suite.
//
// Owner directive, 2026-07-26 (feedback #26): "Orchestrator does not pick up
// 'feedback' but let's make this change to EVERY agent instead … and for
// starters we will only have /feedback and /help and those shall be available
// in every agent."
//
// A suite that listed today's modes would pass forever while the sixth mode
// shipped without them — which is the exact shape of the bug being fixed. So
// every check here DISCOVERS the modes instead:
//
//   · the executor phases come from src/pipeline.js's ANSWER_PHASE_RUNNERS
//     table (parsed out, since it is module-private), and each one is driven
//     through the real runPipeline;
//   · the fail-soft per-mode BOOLEANS come from answerPhaseFor's own body;
//   · the request-side guards come from src/chat.js's `…On` declarations;
//   · the chat modes come from chat-mode.js CHAT_MODES.
//
// Add a seventh agent, a fourth executor phase or a sixth mode without wiring
// the commands and the corresponding test fails naming it.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runPipeline } from "./pipeline.js";
import { slashEffect } from "./slash.js";
import { SLASH_COMMAND_NAMES } from "../public/js/slash-core.js";

const pipelineSrc = readFileSync(new URL("./pipeline.js", import.meta.url), "utf8");
const chatSrc = readFileSync(new URL("./chat.js", import.meta.url), "utf8");
// The mode list moved to chat-mode-core.js in 2026-07-26's collapse — a PURE
// core (no localStorage, no document), which is why this can now be read from
// the core rather than from the browser module chat-mode.js. That still matters
// for the browser module itself: src/ must not import it, since doing so drags
// it, and bar-tint.js/dev-mode.js behind it, into the Workers tsconfig program,
// where `document` and `window` do not exist and `npm run typecheck` fails on
// files this branch never touched.
const chatModeSrc = readFileSync(new URL("../public/js/chat-mode-core.js", import.meta.url), "utf8");

/** The chat modes, read from chat-mode-core.js's own CHAT_MODES list. */
function chatModes() {
  const list = /export const CHAT_MODES = \[([\s\S]*?)\]/.exec(chatModeSrc);
  assert.ok(list, "CHAT_MODES not found — this suite must be re-pointed");
  return [...list[1].matchAll(/"([a-z][\w-]*)"/g)].map((m) => m[1]);
}
const CHAT_MODES = chatModes();

/** The executor answer phases, read from the dispatch table itself. */
function answerPhases() {
  const table = /const ANSWER_PHASE_RUNNERS = \{([\s\S]*?)\n\};/.exec(pipelineSrc);
  assert.ok(table, "ANSWER_PHASE_RUNNERS table not found — this suite must be re-pointed");
  return [...table[1].matchAll(/^\s{2}([a-z][\w-]*):/gm)].map((m) => m[1]);
}

/** The per-mode state booleans answerPhaseFor falls back to. */
function fallbackModeFlags() {
  const fn = /function answerPhaseFor\(state\) \{([\s\S]*?)\n\}/.exec(pipelineSrc);
  assert.ok(fn, "answerPhaseFor not found — this suite must be re-pointed");
  return [...fn[1].matchAll(/state\.(\w+)\)\s*return/g)].map((m) => m[1]);
}

const log = { info() {}, warn() {}, error() {}, debug() {} };

/** A pipeline state shaped like the one chat.js builds, for one mode. */
function stateFor({ phase = null, flag = "" } = {}) {
  return {
    startedAt: Date.now(), model: "m", jsonModel: "jm", webSearch: false, searchSource: "",
    ext: {}, introspection: false, introspectionCount: 0, vision: false, visionModels: [],
    visionTotals: { prompt_tokens: 0, completion_tokens: 0 }, imageLocations: [], shellTranscript: [],
    totals: { prompt_tokens: 0, completion_tokens: 0 }, jsonTotals: { prompt_tokens: 0, completion_tokens: 0 },
    searchCount: 0, sources: [], budgetS: 60, plan: {},
    answerPhase: phase,
    ...(flag ? { [flag]: true } : {}),
    feedbackCapture: true,
  };
}

/** Run one message through the pipeline and report what came back. */
async function run(message, state) {
  /** @type {any[]} */
  const events = [];
  await runPipeline(/** @type {any} */ ({}), log, (e) => events.push(e), [{ role: "user", content: message }], "m", /** @type {any} */ (state));
  return {
    feedback: /** @type {any} */ (state).feedback || null,
    text: events.filter((e) => e.choices).map((e) => e.choices[0].delta.content).join(""),
    steps: events.filter((e) => e.status).map((e) => e.status.label),
  };
}

describe("/feedback reaches the feedback case from EVERY executor phase", () => {
  test("the phase table is discovered, not listed", () => {
    const phases = answerPhases();
    assert.ok(phases.length >= 3, `expected the shipped executor phases, got ${JSON.stringify(phases)}`);
  });

  for (const phase of answerPhases()) {
    test(`answerPhase "${phase}" hands a /feedback turn to the developers, not to its executor`, async () => {
      const state = stateFor({ phase });
      const out = await run("/feedback the map view was cut off on my phone", state);
      assert.ok(out.feedback, `answerPhase "${phase}" swallowed the report — it never reached the feedback case`);
      assert.equal(out.feedback.comment, "the map view was cut off on my phone");
      assert.match(out.text, /developers|utvecklarna/i);
    });

    test(`answerPhase "${phase}" still honors the bare "feedback" keyword (unchanged behaviour)`, async () => {
      const state = stateFor({ phase });
      const out = await run("feedback the map view was cut off", state);
      assert.ok(out.feedback, `the keyword gate regressed for answerPhase "${phase}"`);
      assert.equal(out.feedback.comment, "feedback the map view was cut off");
    });
  }

  // The registry-unavailable path: chat.js falls back to the per-mode booleans,
  // so those have to route a command the same way.
  for (const flag of fallbackModeFlags()) {
    test(`the fail-soft "${flag}" fallback also yields a /feedback turn`, async () => {
      const state = stateFor({ flag });
      const out = await run("/feedback still broken", state);
      assert.ok(out.feedback, `state.${flag} swallowed the report on the registry-unavailable path`);
      assert.equal(out.feedback.comment, "still broken");
    });
  }

  test("Swedish reaches the same place with the same words (invariant 6)", async () => {
    for (const phase of answerPhases()) {
      const state = stateFor({ phase });
      const out = await run("/feedback kartan var avklippt på min telefon", state);
      assert.equal(out.feedback?.comment, "kartan var avklippt på min telefon");
      assert.match(out.text, /utvecklarna/i, `the Swedish note got an English reply in phase "${phase}"`);
    }
  });

  test("an ordinary research question is untouched in every phase — the gate is not greedy", async () => {
    for (const phase of answerPhases()) {
      const state = stateFor({ phase });
      // The executors need an env/model this bare state cannot provide, so the
      // assertion is simply that the feedback case did NOT claim the turn.
      await run("what does /help do in other chat products?", state).catch(() => {});
      assert.equal(/** @type {any} */ (state).feedback, undefined, `phase "${phase}" mistook a question for feedback`);
    }
  });
});

describe("the request side: a command outranks the picked mode (src/chat.js)", () => {
  // Discovered, so a sixth mode's executor boolean is covered the day it lands.
  const modeFlags = [...chatSrc.matchAll(/^\s*const (\w+On) = ([\s\S]*?);$/gm)];

  test("chat.js declares the executor-mode booleans this suite inspects", () => {
    assert.ok(modeFlags.length >= 3, `expected the executor-mode booleans, found ${modeFlags.length}`);
  });

  for (const [, name, body] of modeFlags) {
    test(`${name} is cleared for a slash command`, () => {
      // Either spelled out, or via the `modeIs` helper — which is the mode
      // comparison WITH the !slashCmd guard baked in, so a mode boolean cannot
      // be written without it (asserted just below).
      assert.match(
        body,
        /!slashCmd|modeIs\(/,
        `${name} is not guarded by !slashCmd — a slash command typed in that mode would be swallowed by its executor`,
      );
    });
  }

  test("the modeIs helper the mode booleans share carries the !slashCmd guard", () => {
    // The guard is factored out, so this is where it is pinned: if modeIs ever
    // stops clearing on a slash command, every mode boolean built on it would
    // silently start swallowing /feedback and /help again (feedback #26).
    assert.match(chatSrc, /const modeIs = \([\s\S]{0,80}?\) => !slashCmd && enrich\.chatMode === m;/);
  });

  test("the command is resolved from the message text, before the mode routing", () => {
    const slashAt = chatSrc.indexOf("const slashCmd =");
    const modeAt = chatSrc.indexOf("---- mode routing");
    assert.ok(slashAt > 0, "chat.js no longer resolves a slash command");
    assert.ok(slashAt < modeAt, "the slash command must be resolved BEFORE the mode routing");
  });

  test("/help turns the introspection enrichment on for the request", () => {
    assert.match(chatSrc, /introspection: enrich\.sourceOn \|\| helpCommand/);
    assert.match(chatSrc, /state\.helpCommand = helpCommand/);
  });

  test("the routed agent's PROMPT SET is cleared too — the turn is no longer that agent's", () => {
    // phasePrompt prefers the request's set over the phase's default whenever
    // it fills the role, so a carried "workflow" set would answer a /help with
    // the orchestrator's planner and merge prompts.
    assert.match(chatSrc, /const promptSet = routed && !slashCmd \? resolvePromptSet/);
  });
});

describe("the pipeline order that makes the commands baseline", () => {
  test("the feedback gate is evaluated BEFORE the executor dispatch", () => {
    const gateAt = pipelineSrc.indexOf("if (feedbackReq) return runFeedbackCapture(ctx)");
    const dispatchAt = pipelineSrc.indexOf("ANSWER_PHASE_RUNNERS[phase](ctx)");
    assert.ok(gateAt > 0 && dispatchAt > 0);
    assert.ok(
      gateAt < dispatchAt,
      "runFeedbackCapture must be reachable before any executor phase, or a mode can swallow a report",
    );
  });

  test("the gate asks feedbackRequested (keyword OR command), not feedbackIntent alone", () => {
    assert.match(pipelineSrc, /feedbackRequested\(textOf\(lastUserMessage\(conversation\)\?\.content\)\)/);
  });

  test("/help wins over externalSourceIntent, so a help ask is answered from the docs", () => {
    // Matched across newlines: the gate grew a second escape hatch on 2026-08-16
    // (`sourceFirst`, for /mcp's platform tools, which force web search off and
    // so have no wave to be handed back to) and had to be reformatted onto
    // several lines. What must hold is the ORDER — helpCommand short-circuits
    // before externalSourceIntent is consulted at all.
    assert.match(
      pipelineSrc,
      /state\)\.helpCommand === true \|\|[\s\S]{0,120}!externalSourceIntent/,
    );
  });
});

describe("every chat mode is covered by construction", () => {
  test("the modes are the dropdown's, and no mode opts in or out of the commands", () => {
    // The commands live in the composer and in the pre-dispatch gate, so there
    // is nothing per-mode to enumerate. This test pins that: no source file may
    // gate a command on a mode id.
    for (const mode of CHAT_MODES) {
      for (const name of SLASH_COMMAND_NAMES) {
        const perMode = new RegExp(`slash[\\w.]*\\s*===?\\s*["'\`]${name}["'\`][^\\n]*${mode}`);
        assert.doesNotMatch(chatSrc, perMode, `chat.js gates /${name} on the "${mode}" mode`);
        assert.doesNotMatch(pipelineSrc, perMode, `pipeline.js gates /${name} on the "${mode}" mode`);
      }
    }
  });

  test("slashEffect is what both tiers route on", () => {
    assert.equal(slashEffect("/feedback x"), "feedback");
    assert.equal(slashEffect("/help x"), "help");
    assert.equal(slashEffect("ordinary question"), null);
  });
});
