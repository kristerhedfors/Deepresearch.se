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
import { AGENTS_PATH, capBound, findAgent, resolveCapability } from "./agent-spec.js";
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

// ---- executed, not merely declared -------------------------------------------
//
// The pins above say the registry describes the code. These say the code READS
// the registry — the difference between stage 2 and stage 5. Without them a
// declared bound is documentation, and a spec that varied one would change
// nothing.

test("a declared bound NARROWS the run and can never widen it", () => {
  // The whole safety argument for resolving an untrusted spec: `limit` is the
  // platform's own ceiling, so it is both the default and the maximum.
  assert.equal(capBound({ bounds: { maxRounds: 2 } }, "maxRounds", 6), 2, "narrows");
  assert.equal(capBound({ bounds: { maxRounds: 9999 } }, "maxRounds", 6), 6, "cannot widen");
  assert.equal(capBound({ bounds: {} }, "maxRounds", 6), 6, "undeclared = the constant");
  assert.equal(capBound(null, "maxRounds", 6), 6, "no capability at all = the constant");
});

test("a malformed bound resolves to the constant rather than breaking the run", () => {
  // Invariant 2 at the capability seam: a spec is data, and data can be wrong.
  for (const bad of [{ maxRounds: -1 }, { maxRounds: NaN }, { maxRounds: Infinity }, { maxRounds: "6" }, { maxRounds: null }]) {
    assert.equal(capBound({ bounds: bad }, "maxRounds", 6), 6, `${JSON.stringify(bad)} falls back`);
  }
});

test("every shipped agent's declared bounds resolve to the constants they pin", () => {
  // The no-op proof for this stage: because each spec declares exactly its
  // phase's constant, routing every shipped agent through capBound reproduces
  // today's behaviour byte for byte. If someone lowers a spec's bound without
  // meaning to, this is what says the run actually got shorter.
  assert.equal(capBound(cap("introspection"), "maxRounds", MAX_SOURCE_TOOL_ROUNDS), MAX_SOURCE_TOOL_ROUNDS);
  const build = cap("agent-builder");
  assert.equal(capBound(build, "maxRounds", MAX_SDK_TOOL_ROUNDS), MAX_SDK_TOOL_ROUNDS);
  assert.equal(capBound(build, "maxTokens", SDK_BUILD_ROUND_MAX_TOKENS), SDK_BUILD_ROUND_MAX_TOKENS);
  assert.equal(capBound(build, "timeoutMs", SDK_BUILD_ROUND_TIMEOUT_MS), SDK_BUILD_ROUND_TIMEOUT_MS);
  const orch = cap("orchestrator");
  assert.equal(capBound(orch, "maxTokens", ORCH_NODE_MAX_TOKENS), ORCH_NODE_MAX_TOKENS);
  assert.equal(capBound(orch, "timeoutMs", ORCH_NODE_TIMEOUT_MS), ORCH_NODE_TIMEOUT_MS);
});

test("the bound call sites read the capability rather than the constant", () => {
  // A source pin, in the habit of pipeline.test.js: the four Worker-side bounds
  // must each reach their limit THROUGH capBound. Passing the bare constant
  // again would silently un-execute the declaration while every other test here
  // stayed green.
  const src = readFileSync(join(repoRoot, "src/pipeline.js"), "utf8")
    + readFileSync(join(repoRoot, "src/orchestrator.js"), "utf8");
  for (const konst of [
    "MAX_SOURCE_TOOL_ROUNDS",
    "MAX_SDK_TOOL_ROUNDS",
    "SDK_BUILD_ROUND_MAX_TOKENS",
    "SDK_BUILD_ROUND_TIMEOUT_MS",
    "ORCH_NODE_MAX_TOKENS",
    "ORCH_NODE_TIMEOUT_MS",
  ]) {
    // Every mention outside the `export const` declaration and the prose is a
    // use, and every use must be as capBound's third argument.
    const uses = src.split("\n").filter(
      (l) => l.includes(konst) && !l.includes("export const") && !l.trim().startsWith("//"),
    );
    assert.ok(uses.length > 0, `${konst} is used somewhere`);
    for (const line of uses) {
      assert.match(line, /capBound\(/, `${konst} reaches the run through capBound: ${line.trim()}`);
    }
  }
});
