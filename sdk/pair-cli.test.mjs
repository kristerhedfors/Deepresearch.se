// Unit suite for DistillSDK's CLI (sdk/pair-cli.mjs) — pure helpers over
// a small fixture manifest plus an integrity run against the REAL manifest, so
// `npm test` catches a manifest edit that breaks deps/classes or forgets a
// skill file (the same mirror-discipline the repo's other catalogs get).
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadManifest,
  validateManifest,
  closeSelection,
  orderModules,
  renderPlan,
  renderList,
  renderShow,
} from "./pair-cli.mjs";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const fixture = () => ({
  baseplate: ["arch", "worker", "client"],
  layers: { 0: "Foundation", 1: "Plane", 2: "Tiers" },
  modules: [
    { id: "arch", name: "Architecture", layer: 0, class: "D", deps: [], skill: "sdk/skills/arch/SKILL.md", provides: "", reference: [], acceptance: "a" },
    { id: "worker", name: "Worker", layer: 0, class: "S", deps: ["arch"], skill: "sdk/skills/worker/SKILL.md", provides: "", reference: [], acceptance: "b" },
    { id: "client", name: "Client", layer: 0, class: "C", deps: ["arch"], skill: "sdk/skills/client/SKILL.md", provides: "", reference: [], acceptance: "c" },
    { id: "crypto", name: "Crypto", layer: 1, class: "C", deps: ["client"], skill: "sdk/skills/crypto/SKILL.md", provides: "", reference: [], acceptance: "d" },
    { id: "secure", name: "Secure tier", layer: 2, class: "C", deps: ["client", "crypto"], skill: "sdk/skills/secure/SKILL.md", provides: "", reference: [], acceptance: "e" },
    { id: "identity", name: "Identity", layer: 2, class: "S", deps: ["worker"], skill: "sdk/skills/identity/SKILL.md", provides: "", reference: [], acceptance: "f" },
    { id: "bridge", name: "Bridge", layer: 2, class: "B", deps: ["identity", "secure"], skill: "sdk/skills/bridge/SKILL.md", provides: "", reference: [], acceptance: "g" },
  ],
});

test("closeSelection: baseplate always included, deps pulled transitively", () => {
  const got = closeSelection(fixture(), ["secure"]);
  assert.deepEqual([...got].sort(), ["arch", "client", "crypto", "secure", "worker"]);
});

test("orderModules: dependencies precede dependents; layers ascend; stable", () => {
  const m = fixture();
  const order = orderModules(m, closeSelection(m, ["bridge"])).map((x) => x.id);
  assert.ok(order.indexOf("arch") < order.indexOf("worker"));
  assert.ok(order.indexOf("client") < order.indexOf("crypto"));
  assert.ok(order.indexOf("crypto") < order.indexOf("secure"));
  assert.ok(order.indexOf("identity") < order.indexOf("bridge"));
  assert.ok(order.indexOf("secure") < order.indexOf("bridge"));
});

test("orderModules: a dependency cycle is named, not looped", () => {
  const m = fixture();
  m.modules.find((x) => x.id === "arch").deps = ["bridge"];
  assert.throws(() => orderModules(m, m.modules.map((x) => x.id)), /cycle/);
});

test("validateManifest: clean fixture passes; C-depends-on-S is flagged", () => {
  assert.deepEqual(validateManifest(fixture()), []);
  const m = fixture();
  m.modules.find((x) => x.id === "secure").deps.push("identity");
  const problems = validateManifest(m);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /secure \(C\) depends on identity \(S\)/);
});

test("validateManifest: duplicate ids, bad class/layer, unresolved deps, missing skill files", () => {
  const m = fixture();
  m.modules.push({ id: "worker", name: "dup", layer: 9, class: "Z", deps: ["nope"], skill: "", provides: "", reference: [], acceptance: "" });
  const problems = validateManifest(m, () => false);
  assert.ok(problems.some((p) => /duplicate id: worker/.test(p)));
  assert.ok(problems.some((p) => /illegal class Z/.test(p)));
  assert.ok(problems.some((p) => /illegal layer 9/.test(p)));
  assert.ok(problems.some((p) => /unresolved dep nope/.test(p)));
  assert.ok(problems.some((p) => /skill file missing/.test(p)));
});

test("renderers: list groups by layer, show prints an entry, plan numbers the walk", () => {
  const m = fixture();
  assert.match(renderList(m), /Layer 0 — Foundation/);
  assert.match(renderList(m), /worker {2}\(S\) \[baseplate\] — Worker/);
  assert.match(renderShow(m, "bridge"), /deps: identity, secure/);
  assert.equal(renderShow(m, "nope"), "unknown module: nope");
  const plan = renderPlan(m, ["secure"]);
  assert.match(plan, /1\. arch/);
  assert.match(plan, /done when: e/);
  assert.doesNotMatch(plan, /bridge/);
});

test("the REAL manifest is valid: deps resolve, class rules hold, every skill file exists", () => {
  const m = loadManifest(REPO_ROOT);
  const problems = validateManifest(m, (p) => existsSync(join(REPO_ROOT, p)));
  assert.deepEqual(problems, []);
  // And the full-catalog plan orders without a cycle.
  const order = orderModules(m, closeSelection(m, m.modules.map((x) => x.id)));
  assert.equal(order.length, m.modules.length);
});
