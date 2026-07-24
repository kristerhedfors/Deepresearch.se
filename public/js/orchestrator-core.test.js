// Node built-in test runner — no deps (run via `npm test`).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AGENT_KINDS,
  AGENT_KIND_IDS,
  MAX_AGENTS,
  MAX_WAVES,
  MAX_RESULT_CHARS,
  NODE_STATES,
  validateWorkflow,
  normalizeWorkflow,
  workflowWaves,
  findWorkflowAgent,
  orchestratorPlanPrompt,
  agentTaskPrompt,
  clampResult,
  mergeAgentResults,
  workflowEvent,
  agentUpdateEvent,
} from "./orchestrator-core.js";

const goodPlan = {
  title: "Compare edge runtimes",
  agents: [
    { id: "workers", kind: "deep_research", name: "Workers researcher", task: "Research Cloudflare Workers limits.", deps: [] },
    { id: "deno", kind: "deep_research", name: "Deno researcher", task: "Research Deno Deploy limits.", deps: [] },
    { id: "critic", kind: "custom", name: "Critic", persona: "A skeptical platform engineer.", task: "Compare the two briefs and flag gaps.", deps: ["workers", "deno"] },
  ],
};

test("validateWorkflow accepts a good plan", () => {
  assert.deepEqual(validateWorkflow(goodPlan), []);
});

test("validateWorkflow reports structural problems, never throws", () => {
  assert.ok(validateWorkflow(null).length);
  assert.ok(validateWorkflow({}).length);
  assert.ok(validateWorkflow({ agents: [{ id: "A bad id!", kind: "nope" }] }).length >= 2);
  const dupe = { agents: [{ id: "a", kind: "custom", task: "x" }, { id: "a", kind: "custom", task: "y" }] };
  assert.ok(validateWorkflow(dupe).some((p) => p.includes("duplicate")));
});

test("validateWorkflow flags cycles and over-cap plans", () => {
  const cyclic = {
    agents: [
      { id: "a", kind: "custom", task: "x", deps: ["b"] },
      { id: "b", kind: "custom", task: "y", deps: ["a"] },
    ],
  };
  assert.ok(validateWorkflow(cyclic).some((p) => p.includes("cycle")));
  const many = { agents: Array.from({ length: MAX_AGENTS + 1 }, (_, i) => ({ id: `a${i}`, kind: "custom", task: "t" })) };
  assert.ok(validateWorkflow(many).some((p) => p.includes("too many agents")));
});

test("workflowWaves resolves parallel waves deterministically", () => {
  const { waves, unresolved } = workflowWaves(goodPlan);
  assert.deepEqual(waves, [["workers", "deno"], ["critic"]]);
  assert.deepEqual(unresolved, []);
});

test("workflowWaves reports cyclic agents as unresolved", () => {
  const { waves, unresolved } = workflowWaves({
    agents: [
      { id: "ok", kind: "custom", task: "t", deps: [] },
      { id: "a", kind: "custom", task: "t", deps: ["b"] },
      { id: "b", kind: "custom", task: "t", deps: ["a"] },
    ],
  });
  assert.deepEqual(waves, [["ok"]]);
  assert.deepEqual(unresolved.sort(), ["a", "b"]);
});

test("normalizeWorkflow salvages a sloppy model plan", () => {
  const raw = {
    title: "T",
    agents: [
      { id: "First Agent!", kind: "deep_research", name: "One", task: "Do a thing.", deps: [] },
      { kind: "made-up-kind", name: "Two", task: "Other thing.", deps: ["First Agent!", "ghost"] },
      { name: "no task — dropped" },
    ],
  };
  const plan = normalizeWorkflow(raw);
  assert.ok(plan);
  assert.equal(plan.agents.length, 2);
  assert.equal(plan.agents[0].id, "first-agent");
  assert.equal(plan.agents[1].kind, "custom"); // unknown kind → custom
  assert.deepEqual(plan.agents[1].deps, ["first-agent"]); // ghost dep dropped
  assert.deepEqual(validateWorkflow(plan), []);
});

test("normalizeWorkflow keeps planned queries on deep_research nodes only", () => {
  const raw = {
    agents: [
      { id: "r", kind: "deep_research", task: "t", queries: ["one", "  two  ", "", "three-too-many"] },
      { id: "c", kind: "custom", task: "t", queries: ["ignored"] },
    ],
  };
  const plan = normalizeWorkflow(raw);
  assert.deepEqual(plan.agents[0].queries, ["one", "two"]);
  assert.deepEqual(plan.agents[1].queries, []);
});

test("agentTaskPrompt includes the original user request when given", () => {
  const p = agentTaskPrompt({ name: "A", kind: "custom", task: "t" }, [], { userRequest: "the big question" });
  assert.ok(p.includes("the big question"));
});

test("normalizeWorkflow downgrades introspection without a source snapshot", () => {
  const raw = { agents: [{ id: "src", kind: "introspection", task: "Read the code." }] };
  assert.equal(normalizeWorkflow(raw, { hasSource: false }).agents[0].kind, "custom");
  assert.equal(normalizeWorkflow(raw, { hasSource: true }).agents[0].kind, "introspection");
});

test("normalizeWorkflow breaks cycles and caps agent count", () => {
  const raw = {
    agents: [
      { id: "a", kind: "custom", task: "t", deps: ["b"] },
      { id: "b", kind: "custom", task: "t", deps: ["a"] },
      ...Array.from({ length: MAX_AGENTS + 3 }, (_, i) => ({ id: `x${i}`, kind: "custom", task: "t" })),
    ],
  };
  const plan = normalizeWorkflow(raw);
  assert.equal(plan.agents.length, MAX_AGENTS);
  assert.deepEqual(validateWorkflow(plan), []); // cycle broken → valid
});

test("normalizeWorkflow flattens chains deeper than MAX_WAVES", () => {
  const raw = {
    agents: [
      { id: "a", kind: "custom", task: "t" },
      { id: "b", kind: "custom", task: "t", deps: ["a"] },
      { id: "c", kind: "custom", task: "t", deps: ["b"] },
      { id: "d", kind: "custom", task: "t", deps: ["c"] },
    ],
  };
  const plan = normalizeWorkflow(raw);
  const { waves, unresolved } = workflowWaves(plan);
  assert.deepEqual(unresolved, []);
  assert.ok(waves.length <= MAX_WAVES, `got ${waves.length} waves`);
});

test("normalizeWorkflow returns null when nothing is salvageable", () => {
  assert.equal(normalizeWorkflow(null), null);
  assert.equal(normalizeWorkflow({ agents: [{ name: "taskless" }] }), null);
});

test("plan prompt lists kinds, rules, and Swedish-parity instruction", () => {
  const p = orchestratorPlanPrompt({ message: "Jämför två ramverk", hasSource: false });
  assert.ok(p.includes("deep_research"));
  assert.ok(!p.includes('"introspection":') && !p.includes("- \"introspection\""), "introspection hidden without source");
  assert.ok(p.includes("svenska"));
  assert.ok(p.includes("Jämför två ramverk"));
  const withSource = orchestratorPlanPrompt({ message: "x", hasSource: true });
  assert.ok(withSource.includes('- "introspection"'));
});

test("agentTaskPrompt carries persona, task and clamped upstream results", () => {
  const p = agentTaskPrompt(
    { name: "Critic", kind: "custom", task: "Judge.", persona: "Skeptic." },
    [{ id: "a", name: "A", text: "x".repeat(MAX_RESULT_CHARS + 50) }],
  );
  assert.ok(p.includes('"Critic"'));
  assert.ok(p.includes("Persona: Skeptic."));
  assert.ok(p.includes("### A (a)"));
  assert.ok(p.includes("[…truncated]"));
});

test("clampResult bounds long node results", () => {
  assert.equal(clampResult("short"), "short");
  assert.ok(clampResult("y".repeat(MAX_RESULT_CHARS * 2)).length < MAX_RESULT_CHARS + 30);
});

test("mergeAgentResults keeps wave order and reports failures honestly", () => {
  const merged = mergeAgentResults(goodPlan, {
    workers: { status: "done", text: "Workers brief." },
    deno: { status: "failed", note: "timeout" },
    critic: { status: "done", text: "Critique." },
  });
  assert.ok(merged.indexOf("Workers brief.") < merged.indexOf("Critique."));
  assert.ok(merged.includes("Deno researcher — failed (timeout)"));
  assert.ok(merged.includes("account for this gap"));
});

test("workflowEvent carries the plan graph and resolved waves", () => {
  const ev = workflowEvent(goodPlan);
  assert.equal(ev.type, "workflow");
  assert.equal(ev.agents.length, 3);
  assert.deepEqual(ev.waves, [["workers", "deno"], ["critic"]]);
  assert.deepEqual(ev.agents[2].deps, ["workers", "deno"]);
});

test("agentUpdateEvent normalizes status and bounds the note", () => {
  const ev = agentUpdateEvent("workers", "done", { duration_ms: 1200, chars: 900 });
  assert.deepEqual(ev, { type: "agent_update", id: "workers", status: "done", duration_ms: 1200, chars: 900 });
  assert.equal(agentUpdateEvent("x", "not-a-state").status, "running");
  assert.ok(agentUpdateEvent("x", "failed", { note: "n".repeat(500) }).note.length <= 200);
  for (const s of NODE_STATES) assert.equal(agentUpdateEvent("x", s).status, s);
});

test("kind registry is closed and self-describing", () => {
  assert.deepEqual(AGENT_KIND_IDS.sort(), ["custom", "deep_research", "introspection"]);
  for (const k of AGENT_KIND_IDS) {
    assert.ok(AGENT_KINDS[k].label && AGENT_KINDS[k].desc);
    assert.equal(typeof AGENT_KINDS[k].needsSource, "boolean");
  }
});

test("findWorkflowAgent looks up by id", () => {
  assert.equal(findWorkflowAgent(goodPlan, "critic").name, "Critic");
  assert.equal(findWorkflowAgent(goodPlan, "nope"), null);
});
