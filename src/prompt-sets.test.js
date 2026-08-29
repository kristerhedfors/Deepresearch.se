// Unit suite for the prompt-set binding (src/prompt-sets.js) — the last
// capability axis, and the one most able to drift silently: a spec can name a
// prompt set, so the name has to keep meaning the prompt the phase actually
// uses.
//
// Three jobs:
//  1. The binding COVERS the vocabulary exactly — every (set, role) pair the
//     pure core declares is bound, and nothing extra is.
//  2. Each bound builder IS the shipped prompt for that role, identity-checked
//     against src/prompts.js (and the two pure cores). A renamed or re-pointed
//     prompt fails here rather than in production.
//  3. Resolution is total: every phase × role a runner can ask for returns a
//     function, for any state — including states that name nothing, name
//     nonsense, or name a set that does not fill the role.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { BOUND_ROLES, PROMPT_BUILDERS, phasePrompt, promptBuilder, promptSetFor } from "./prompt-sets.js";
import {
  AGENTS_PATH,
  ANSWER_PHASES,
  DEFAULT_PROMPT_SET,
  PROMPT_ROLES,
  PROMPT_SETS,
  findAgent,
  missingPromptRoles,
  resolveCapability,
  resolvePromptSet,
  validateCapability,
} from "./agent-spec.js";
import {
  directPrompt,
  orchAgentPrompt,
  orchSynthPrompt,
  queryPlanPrompt,
  reflectPrompt,
  sdkBuildPrompt,
  sdkBuildToolPrompt,
  searchOffPrompt,
  sourceAgentPrompt,
  sourceAnswerPrompt,
  sourceToolAgentPrompt,
  synthPrompt,
} from "./prompts.js";
import { orchestratorPlanPrompt } from "../public/js/orchestrator-core.js";
import { outrospectionAnswerPrompt } from "../public/js/outrospect-core.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const realRegistry = () => JSON.parse(readFileSync(join(repoRoot, AGENTS_PATH), "utf8"));

const spec = (over = {}) => ({
  id: "demo", name: "Demo", platform: "server", controls: [{ type: "prompt-input" }], ...over,
});

test("the binding covers the declared vocabulary exactly", () => {
  assert.deepEqual(Object.keys(PROMPT_BUILDERS).sort(), Object.keys(PROMPT_SETS).sort());
  for (const [set, def] of Object.entries(PROMPT_SETS)) {
    assert.deepEqual(BOUND_ROLES[set].sort(), [...def.roles].sort(), `set "${set}" binds exactly its declared roles`);
    for (const role of def.roles) {
      assert.ok(PROMPT_ROLES.includes(role), `"${role}" is a known prompt role`);
      assert.equal(typeof promptBuilder(set, role), "function");
    }
  }
});

test("each bound builder is the shipped prompt for that role", () => {
  // Identity checks, not behaviour checks: this is the anti-drift assertion.
  assert.equal(PROMPT_BUILDERS.research.plan, queryPlanPrompt);
  assert.equal(PROMPT_BUILDERS.research.reflect, reflectPrompt);
  assert.equal(PROMPT_BUILDERS.research.answer, synthPrompt);
  assert.equal(PROMPT_BUILDERS.research["answer-direct"], directPrompt);
  assert.equal(PROMPT_BUILDERS.research["answer-search-off"], searchOffPrompt);
  assert.equal(PROMPT_BUILDERS["source-research"].plan, sourceAgentPrompt);
  assert.equal(PROMPT_BUILDERS["source-research"].answer, sourceAnswerPrompt);
  assert.equal(PROMPT_BUILDERS["source-research"]["answer-tools"], sourceToolAgentPrompt);
  assert.equal(PROMPT_BUILDERS.build.answer, sdkBuildPrompt);
  assert.equal(PROMPT_BUILDERS.build["answer-tools"], sdkBuildToolPrompt);
  assert.equal(PROMPT_BUILDERS.workflow.plan, orchestratorPlanPrompt);
  assert.equal(PROMPT_BUILDERS.workflow.worker, orchAgentPrompt);
  assert.equal(PROMPT_BUILDERS.workflow.answer, orchSynthPrompt);
  assert.equal(PROMPT_BUILDERS.feed.answer, outrospectionAnswerPrompt);
});

test("every phase's declared prompt roles are fillable by its default set", () => {
  for (const [phase, def] of Object.entries(ANSWER_PHASES)) {
    const set = DEFAULT_PROMPT_SET[phase];
    assert.ok(set, `phase "${phase}" has a default prompt set`);
    for (const role of def.promptRoles || []) {
      assert.equal(typeof phasePrompt({}, phase, role), "function", `${phase}/${role}`);
    }
  }
});

test("every shipped agent declares the set its phase already used", () => {
  // The whole point of this increment landing as a no-op: the declaration
  // describes today's behaviour, so no request changes.
  for (const a of realRegistry().agents) {
    const cap = resolveCapability(a);
    assert.equal(resolvePromptSet(a), DEFAULT_PROMPT_SET[cap.answerPhase], `${a.id} declares its phase's own set`);
    assert.deepEqual(missingPromptRoles(a), [], `${a.id} fills every role its phase asks for`);
  }
  assert.equal(resolvePromptSet(findAgent(realRegistry(), "introspection")), "source-research");
  assert.equal(resolvePromptSet(findAgent(realRegistry(), "orchestrator")), "workflow");
  // under-construction runs the `direct` phase, which borrows the research set.
  assert.equal(resolvePromptSet(findAgent(realRegistry(), "under-construction")), "research");
});

test("prompt set and answer phase are independent, but not arbitrary", () => {
  // The combination this axis exists to make expressible: the research phase
  // spoken in the source-research voice. It was not expressible at any price.
  const mixed = spec({ capability: { answerPhase: "source-research", prompts: "source-research" } });
  assert.deepEqual(validateCapability(mixed), []);

  // A set that cannot fill the phase's roles is rejected — `feed` has only an
  // `answer`, so it cannot serve a phase that needs a plan and a tools variant.
  const bad = spec({ capability: { answerPhase: "source-research", prompts: "feed" } });
  const problems = validateCapability(bad);
  assert.ok(problems.some((p) => p.includes("does not fill")), problems.join("; "));
  assert.deepEqual(missingPromptRoles(bad).sort(), ["answer-tools", "plan"]);

  // And an unknown set name is rejected outright.
  assert.ok(validateCapability(spec({ capability: { prompts: "shakespeare" } }))
    .some((p) => p.includes("prompts must be one of")));
});

test("resolution is total — no state can leave a phase without a prompt", () => {
  const states = [undefined, {}, { promptSet: null }, { promptSet: "nope" }, { promptSet: 42 }, { promptSet: "feed" }];
  for (const state of states) {
    for (const [phase, def] of Object.entries(ANSWER_PHASES)) {
      for (const role of def.promptRoles || []) {
        assert.equal(typeof phasePrompt(state, phase, role), "function", `${JSON.stringify(state)} ${phase}/${role}`);
      }
    }
  }
  // A state naming a set that does not fill the role falls back to the phase's
  // own set rather than throwing: `feed` has no plan, so a workflow plan under
  // promptSet "feed" still resolves to the workflow planner.
  assert.equal(phasePrompt({ promptSet: "feed" }, "workflow", "plan"), orchestratorPlanPrompt);
  // A declared set that DOES fill the role wins over the phase default.
  assert.equal(phasePrompt({ promptSet: "feed" }, "research", "answer"), outrospectionAnswerPrompt);
  assert.equal(phasePrompt({}, "research", "answer"), synthPrompt);
});

test("promptSetFor clamps to a bound set", () => {
  assert.equal(promptSetFor({ promptSet: "build" }, "research"), "build");
  assert.equal(promptSetFor({ promptSet: "nonsense" }, "workflow"), "workflow");
  assert.equal(promptSetFor({}, "feed"), "feed");
  assert.equal(promptSetFor({}, "direct"), "research");
  assert.equal(promptSetFor({}, "not-a-phase"), "research");
});

test("promptBuilder throws only on an unreachable programming error", () => {
  assert.throws(() => promptBuilder("feed", "plan"), /no prompt builder/);
  assert.throws(() => promptBuilder("nope", "answer"), /no prompt builder/);
});
