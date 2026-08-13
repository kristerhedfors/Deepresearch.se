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
  MAX_PROMPT_PREVIEW,
} from "./orchestrator-core.js";

const goodPlan = {
  title: "Compare edge runtimes",
  agents: [
    { id: "workers", kind: "web_research", name: "Workers researcher", task: "Research Cloudflare Workers limits.", deps: [] },
    { id: "deno", kind: "web_research", name: "Deno researcher", task: "Research Deno Deploy limits.", deps: [] },
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
      { id: "First Agent!", kind: "web_research", name: "One", task: "Do a thing.", deps: [] },
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

test("normalizeWorkflow keeps planned queries on web_research nodes only", () => {
  const raw = {
    agents: [
      { id: "r", kind: "web_research", task: "t", queries: ["one", "  two  ", "", "three-too-many"] },
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
  assert.ok(p.includes("web_research"));
  assert.ok(!p.includes('"introspection":') && !p.includes("- \"introspection\""), "introspection hidden without source");
  assert.ok(p.includes("svenska"));
  assert.ok(p.includes("Jämför två ramverk"));
  const withSource = orchestratorPlanPrompt({ message: "x", hasSource: true });
  assert.ok(withSource.includes('- "introspection"'));
});

// Feedback #21 (2026-07-24): a "most deepresearch.se-like project" run
// compared candidates against the site without ANY agent ever establishing
// what the site does — the critic flagged it, nothing blocked it. The plan
// prompt now requires a first-wave grounding agent for reference-object
// comparisons, introspection-kind when the object is this site itself.
test("plan prompt requires grounding a comparison's reference object (feedback #21)", () => {
  const p = orchestratorPlanPrompt({ message: "compare X to this site", hasSource: true });
  assert.ok(p.includes("GROUND COMPARISONS"));
  assert.ok(p.includes("first-wave grounding agent"));
  assert.ok(p.includes('MUST be kind "introspection"'));
  assert.ok(p.includes('list it in "deps"'));
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

test("workflowEvent carries the persona and planned queries the inspector shows", () => {
  // The plan decides more per node than the box can draw; the node INSPECTOR
  // shows the rest, so it has to ride along (feedback #35).
  const plan = normalizeWorkflow({
    agents: [
      { id: "workers", kind: "web_research", name: "R", task: "Research.", queries: ["cloudflare workers limits", "workers cpu"] },
      { id: "critic", kind: "custom", name: "C", persona: "A skeptical engineer.", task: "Compare.", deps: ["workers"] },
    ],
  });
  const ev = workflowEvent(plan);
  assert.deepEqual(ev.agents[0].queries, ["cloudflare workers limits", "workers cpu"]);
  assert.equal(ev.agents[0].persona, undefined, "omitted when empty — an unchanged event for a plain team");
  assert.equal(ev.agents[1].persona, "A skeptical engineer.");
  assert.equal(ev.agents[1].queries, undefined, "only web_research nodes plan searches");
});

test("agentUpdateEvent normalizes status and bounds the note", () => {
  const ev = agentUpdateEvent("workers", "done", { duration_ms: 1200, chars: 900 });
  assert.deepEqual(ev, { type: "agent_update", id: "workers", status: "done", duration_ms: 1200, chars: 900 });
  assert.equal(agentUpdateEvent("x", "not-a-state").status, "running");
  assert.ok(agentUpdateEvent("x", "failed", { note: "n".repeat(500) }).note.length <= 200);
  for (const s of NODE_STATES) assert.equal(agentUpdateEvent("x", s).status, s);
});

test("agentUpdateEvent head-clamps the prompt but reports its true length", () => {
  const full = "You are a sub-agent.\n" + "g".repeat(MAX_PROMPT_PREVIEW * 3);
  const ev = agentUpdateEvent("workers", "running", { prompt: full });
  assert.equal(ev.prompt.length, MAX_PROMPT_PREVIEW);
  assert.ok(ev.prompt.startsWith("You are a sub-agent."), "the HEAD travels — the task, not the grounding");
  assert.equal(ev.prompt_chars, full.length);
  // Nothing extra on an ordinary update.
  assert.equal(agentUpdateEvent("workers", "done").prompt, undefined);
});

test("kind registry is closed and self-describing", () => {
  assert.deepEqual(AGENT_KIND_IDS.slice().sort(), ["custom", "introspection", "swarm", "web_research"]);
  for (const k of AGENT_KIND_IDS) {
    assert.ok(AGENT_KINDS[k].label && AGENT_KINDS[k].desc);
    assert.equal(typeof AGENT_KINDS[k].needsSource, "boolean");
    assert.equal(typeof AGENT_KINDS[k].needsSwarm, "boolean");
  }
});

// ---- the swarm kind (client-hosted: public/js/swarm-runtime.js) --------------

test("swarm nodes need a capable device — no capability downgrades to custom", () => {
  const raw = { agents: [{ id: "s", kind: "swarm", task: "Weigh the options.", swarmSize: 8, rounds: 3 }] };
  assert.equal(normalizeWorkflow(raw, { hasSwarm: true }).agents[0].kind, "swarm");
  // Knob off / no cached weights / an older client that never announced it:
  // the task still runs, as an ordinary specialist on the answer model.
  const plain = normalizeWorkflow(raw).agents[0];
  assert.equal(plain.kind, "custom");
  assert.equal(plain.swarmSize, undefined);
});

test("swarm nodes carry clamped member/round counts", () => {
  // One swarm node per plan (see the next test), so each case is its own plan.
  const one = (/** @type {any} */ a) => normalizeWorkflow({ agents: [a] }, { hasSwarm: true }).agents[0];
  assert.deepEqual(
    [
      one({ id: "big", kind: "swarm", task: "A.", swarmSize: 99, rounds: 9 }),
      one({ id: "small", kind: "swarm", task: "B.", swarmSize: 1, rounds: 0 }),
      one({ id: "bare", kind: "swarm", task: "C." }),
    ].map((a) => [a.swarmSize, a.rounds]),
    [[12, 3], [2, 1], [4, 2]],
  );
});

test("only ONE swarm node survives a plan — the extras run as ordinary specialists", () => {
  // Every swarm node spawns in-browser model instances; several of them is a
  // memory multiplier, not a bigger team (feedback #26, the Safari tab
  // crashes). The prompt already asked for one; this is the bound.
  const plan = normalizeWorkflow(
    {
      agents: [
        { id: "first", kind: "swarm", task: "Weigh it.", swarmSize: 6 },
        { id: "second", kind: "swarm", task: "Weigh it differently.", swarmSize: 6 },
        { id: "third", kind: "swarm", task: "And again." },
      ],
    },
    { hasSwarm: true },
  );
  assert.deepEqual(plan.agents.map((a) => a.kind), ["swarm", "custom", "custom"]);
  assert.equal(plan.agents[1].swarmSize, undefined, "a downgraded node carries no swarm shape");
  assert.ok(
    validateWorkflow({ agents: [{ id: "a", kind: "swarm", task: "x" }, { id: "b", kind: "swarm", task: "y" }] })
      .some((p) => /at most one swarm agent/.test(p)),
    "validation names it too",
  );
});

test("a swarm node can never depend on another agent (it runs before the request)", () => {
  const plan = normalizeWorkflow(
    {
      agents: [
        { id: "res", kind: "web_research", task: "Look it up.", queries: ["q"] },
        { id: "sw", kind: "swarm", task: "Judge it.", deps: ["res"] },
        { id: "critic", kind: "custom", task: "Combine.", deps: ["sw", "res"] },
      ],
    },
    { hasSwarm: true },
  );
  assert.deepEqual(plan.agents[1].deps, [], "the invented dependency is dropped");
  assert.deepEqual(plan.agents[2].deps, ["sw", "res"], "depending ON a swarm is fine");
  assert.deepEqual(workflowWaves(plan).waves, [["res", "sw"], ["critic"]]);
  // And validateWorkflow reports the same rule on a hand-written plan.
  assert.ok(
    validateWorkflow({ agents: [{ id: "a", kind: "custom", task: "t" }, { id: "sw", kind: "swarm", task: "t", deps: ["a"] }] })
      .some((p) => p.includes("cannot depend")),
  );
});

test("the plan prompt offers the swarm kind only when the device can host one", () => {
  const without = orchestratorPlanPrompt({ message: "Rank these three options." });
  assert.ok(!without.includes('"swarm"'));
  const with_ = orchestratorPlanPrompt({ message: "Rank these three options.", hasSwarm: true, swarmModel: "Bonsai 1.7B · 1-bit" });
  assert.ok(with_.includes('"swarm"'));
  assert.ok(with_.includes("Bonsai 1.7B · 1-bit"));
  assert.ok(with_.includes("swarmSize"));
  assert.ok(/CANNOT have "deps"/.test(with_));
});

test("workflowEvent carries the swarm's shape so the graph can draw its members", () => {
  const plan = normalizeWorkflow({ agents: [{ id: "s", kind: "swarm", task: "Judge.", swarmSize: 6 }] }, { hasSwarm: true });
  const ev = workflowEvent(plan);
  assert.equal(ev.agents[0].swarmSize, 6);
  assert.equal(ev.agents[0].rounds, 2);
  // Non-swarm nodes stay exactly as they were.
  assert.equal(workflowEvent(goodPlan).agents[0].swarmSize, undefined);
});

test("findWorkflowAgent looks up by id", () => {
  assert.equal(findWorkflowAgent(goodPlan, "critic").name, "Critic");
  assert.equal(findWorkflowAgent(goodPlan, "nope"), null);
});
