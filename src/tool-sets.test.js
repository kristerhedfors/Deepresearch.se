// Declaration-vs-implementation pins for the TOOL-CLASS binding
// (src/tool-sets.js), the sibling of prompt-sets.test.js.
//
// The point of pinning at all: a capability block that names a tool class the
// binding does not serve would hand a model an empty toolbox and fall through
// to the deterministic path for reasons no log would explain. These assert the
// vocabulary and the binding stay the same size and shape, and that the two
// tool-driving phases reach their definitions THROUGH the binding rather than
// importing arrays the spec has no say over.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { BOUND_CLASSES, TOOL_BINDINGS, toolsForRun } from "./tool-sets.js";
import { TOOL_CLASSES } from "./agent-spec.js";
import { AGENTS_PATH, findAgent, resolveCapability } from "./agent-spec.js";
import { INTROSPECTION_TOOLS } from "./introspect-tools.js";
import { BUILD_TOOLS, SDK_TOOLS } from "../public/js/sdk-core.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const registry = () => JSON.parse(readFileSync(join(repoRoot, AGENTS_PATH), "utf8"));
const cap = (id) => resolveCapability(findAgent(registry(), id));

test("every tool class in the vocabulary is bound, and nothing else is", () => {
  // The failure this prevents: adding a class to TOOL_CLASSES, shipping a spec
  // that selects it, and handing the model nothing.
  assert.deepEqual(BOUND_CLASSES.sort(), Object.keys(TOOL_CLASSES).sort());
});

test("each class binds to the exact array the phases used to import", () => {
  assert.equal(TOOL_BINDINGS["source-read"].tools, INTROSPECTION_TOOLS);
  assert.equal(TOOL_BINDINGS["sdk-plan"].tools, SDK_TOOLS);
  assert.equal(TOOL_BINDINGS["build-publish"].tools, BUILD_TOOLS);
  // The sandbox loop runs in the browser, so an empty Worker-side binding is
  // correct rather than missing — asserted so nobody "fixes" it later.
  assert.deepEqual(TOOL_BINDINGS["shell"].tools, []);
});

test("the shipped agents' declarations reproduce today's tool lists exactly", () => {
  // The no-op proof for this stage. Introspection's native path used to import
  // INTROSPECTION_TOOLS; Agent Studio's used sdkBuildTools(snapshot).
  assert.deepEqual(toolsForRun(cap("introspection"), [], { snapshot: true }), INTROSPECTION_TOOLS);
  assert.deepEqual(
    toolsForRun(cap("agent-builder"), [], { snapshot: true }),
    [...INTROSPECTION_TOOLS, ...SDK_TOOLS, ...BUILD_TOOLS],
  );
  // …and without a snapshot, the readers drop out — the old
  // `snapshot ? INTROSPECTION_TOOLS : []` conditional, now a declared `needs`.
  assert.deepEqual(
    toolsForRun(cap("agent-builder"), [], { snapshot: false }),
    [...SDK_TOOLS, ...BUILD_TOOLS],
  );
});

test("no capability resolved means the phase's own fallback classes", () => {
  // An unreadable registry and the MCP channel both arrive here. They must get
  // exactly what the phase got before capabilities existed.
  assert.deepEqual(toolsForRun(null, ["source-read"], { snapshot: true }), INTROSPECTION_TOOLS);
  assert.deepEqual(
    toolsForRun(undefined, ["source-read", "sdk-plan", "build-publish"], { snapshot: true }),
    [...INTROSPECTION_TOOLS, ...SDK_TOOLS, ...BUILD_TOOLS],
  );
});

test("a capability declaring NO tools is honoured as none, not as the fallback", () => {
  // The difference between "the registry could not be read" (use the fallback)
  // and "this agent deliberately has no tools" (give it none). Collapsing the
  // two would make an agent's declaration unable to say the quiet thing.
  assert.deepEqual(toolsForRun({ tools: [] }, ["source-read"], { snapshot: true }), []);
});

test("the resolved list follows REGISTRY order, so a spec cannot reorder it", () => {
  const forward = toolsForRun({ tools: ["source-read", "sdk-plan", "build-publish"] }, [], { snapshot: true });
  const reversed = toolsForRun({ tools: ["build-publish", "sdk-plan", "source-read"] }, [], { snapshot: true });
  assert.deepEqual(forward, reversed);
});

test("an unknown or malformed class selects nothing rather than throwing", () => {
  // A spec is data, and stage 7 makes it untrusted data (invariant 2).
  assert.deepEqual(toolsForRun({ tools: ["not-a-class"] }, [], { snapshot: true }), []);
  assert.deepEqual(toolsForRun({ tools: "source-read" }, [], { snapshot: true }), []);
  assert.deepEqual(toolsForRun({ tools: null }, [], { snapshot: true }), []);
});

test("the tool-driving phases read the binding rather than importing the arrays", () => {
  // The source pin, in the habit of pipeline.test.js: pipeline.js must not
  // reach a tool array directly, or a spec's declaration would be decoration.
  const src = readFileSync(join(repoRoot, "src/pipeline.js"), "utf8");
  const code = src.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
  for (const arr of ["INTROSPECTION_TOOLS", "SDK_TOOLS", "BUILD_TOOLS"]) {
    assert.ok(!code.includes(arr), `pipeline.js no longer names ${arr} — it declares tool CLASSES`);
  }
  assert.match(code, /toolsForRun\(ctx\.state\.capability, \["source-read"\]/);
  assert.match(code, /toolsForRun\(ctx\.state\.capability, SDK_BUILD_TOOL_CLASSES/);
});
