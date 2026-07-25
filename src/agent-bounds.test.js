// Declaration-vs-implementation pins for the AgentSpec bounds that live in the
// WORKER — src/pipeline.js and src/orchestrator.js.
//
// Its sibling `public/js/agent-capability.test.js` owns everything expressible
// inside the client module graph (validation rules, routing, the team caps that
// live in orchestrator-core). The split is not cosmetic: `tsconfig.public.json`
// typechecks `public/**` with no Workers globals, so a public/js suite that
// imported a Worker module would drag the whole server graph into that pass and
// break the typecheck. Bounds declared by a spec but enforced in `src/` are
// therefore pinned here.
//
// The point of pinning at all: a capability block that claims a limit the code
// does not enforce is worse than no claim. If someone raises MAX_SDK_TOOL_ROUNDS
// without touching the spec, this suite fails rather than the registry quietly
// lying about the agent.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { AGENTS_PATH, findAgent, resolveCapability } from "./agent-spec.js";
import { ORCH_NODE_MAX_TOKENS, ORCH_NODE_TIMEOUT_MS } from "./orchestrator.js";
import {
  MAX_SDK_TOOL_ROUNDS,
  MAX_SOURCE_TOOL_ROUNDS,
  SDK_BUILD_ROUND_MAX_TOKENS,
  SDK_BUILD_ROUND_TIMEOUT_MS,
} from "./pipeline.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const cap = (id) => resolveCapability(findAgent(JSON.parse(readFileSync(join(repoRoot, AGENTS_PATH), "utf8")), id));

test("introspection's declared round cap is the tool loop's own", () => {
  assert.equal(cap("introspection").bounds.maxRounds, MAX_SOURCE_TOOL_ROUNDS);
});

test("Agent Studio's declared rounds, token budget and wall-clock are the build path's own", () => {
  const build = cap("agent-builder");
  assert.equal(build.bounds.maxRounds, MAX_SDK_TOOL_ROUNDS);
  assert.equal(build.bounds.maxTokens, SDK_BUILD_ROUND_MAX_TOKENS);
  assert.equal(build.bounds.timeoutMs, SDK_BUILD_ROUND_TIMEOUT_MS);
});

test("the orchestrator's declared per-node bounds are the executor's own", () => {
  const orch = cap("orchestrator");
  assert.equal(orch.bounds.maxTokens, ORCH_NODE_MAX_TOKENS);
  assert.equal(orch.bounds.timeoutMs, ORCH_NODE_TIMEOUT_MS);
});

test("an agent that declares no bounds claims none", () => {
  // The three modes with no Worker-side limits of their own must not invent
  // numbers — an empty `bounds` is the honest declaration.
  for (const id of ["research", "outrospection", "secure", "under-construction"]) {
    assert.deepEqual(cap(id).bounds, {}, `${id} declares no bounds`);
  }
});
