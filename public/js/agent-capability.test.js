// Unit suite for the AgentSpec CAPABILITY layer (spec 0.2.0) and the default-
// agent routing table — the part of an agent that says what it DOES rather than
// how it looks.
//
// Three jobs, in the order they matter:
//
//  1. **Declaration vs. implementation.** Every bound a default agent declares
//     is pinned against the real constant in the code that enforces it. A spec
//     that describes behaviour it does not have is worse than no spec, so this
//     suite fails when the two drift apart.
//  2. **The invariants, as rules rather than as prose.** Invariant 1 (a
//     tool-bearing mode still works on models without native tool use),
//     invariant 3 (the planning phases never leave the fixed JSON model),
//     invariant 4 (a client-tier agent may not put the server in the data path)
//     and invariant 6 (a declared gate routes Swedish and English alike) each
//     get a passing AND a failing case.
//  3. **Routing characterization.** `resolveRequestAgent` is asserted to
//     reproduce the flag precedence src/chat.js implements by hand
//     (sdk > orchestrator > outrospection, all gated on developer_mode). These
//     tests describe today's behaviour deliberately: they are the safety net a
//     registry-driven dispatch has to keep green.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  AGENTS_PATH,
  ANSWER_PHASES,
  BASE_CAPABILITY,
  CAPABILITY_EVENTS,
  CAPABILITY_REQUIREMENTS,
  CHAT_MODE_IDS,
  CONTEXT_BLOCKS,
  GATE_IDS,
  MODE_THEMES,
  TOOL_CLASSES,
  TOOL_FALLBACKS,
  IDENTITY_SELF_ANSWER_NOTE,
  agentIdentityPrompt,
  defaultAgentForMode,
  findAgent,
  resolveCapability,
  resolveControls,
  resolveRequestAgent,
  serverOnlySelections,
  validateAgentRegistry,
  validateAgentSpec,
  validateCapability,
} from "./agent-spec-core.js";
import { showsDepthSlider, backdropKind } from "./mode-theme.js";
import { MAX_AGENTS, MAX_WAVES, MAX_NODE_QUERIES, MAX_ORCH_SEARCHES } from "./orchestrator-core.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
const realRegistry = () => JSON.parse(readFileSync(join(repoRoot, AGENTS_PATH), "utf8"));

/** A minimal spec that validates, so a test can change exactly one thing. */
const spec = (over = {}) => ({
  id: "demo",
  name: "Demo",
  platform: "server",
  controls: [{ type: "prompt-input" }],
  ...over,
});

// ---- Stage 0: the drift that started this ------------------------------------

test("every agent's mode names a real chat mode", () => {
  for (const a of realRegistry().agents) {
    if (a.mode == null) continue;
    assert.ok(CHAT_MODE_IDS.includes(a.mode), `${a.id}: mode "${a.mode}" is not in CHAT_MODE_IDS`);
  }
  // The specific drift this rule exists to catch: the registry said
  // "agent-builder" while the running app's id was "sdk", and nothing checked.
  assert.equal(findAgent(realRegistry(), "agent-builder").mode, "sdk");
  assert.ok(validateAgentSpec(spec({ mode: "agent-builder" })).some((p) => p.includes("is not a chat mode")));
  assert.deepEqual(validateAgentSpec(spec({ mode: "sdk" })), []);
});

test("every mode-select offers only real chat modes", () => {
  for (const a of realRegistry().agents) {
    for (const c of resolveControls(a)) {
      if (c.type !== "mode-select") continue;
      for (const m of c.modes || []) {
        assert.ok(CHAT_MODE_IDS.includes(m), `${a.id}: mode-select offers "${m}"`);
      }
    }
  }
  const bad = spec({ controls: [{ type: "prompt-input" }, { type: "mode-select", modes: ["normal", "agent-builder"] }] });
  assert.ok(validateAgentSpec(bad).some((p) => p.includes('mode-select offers "agent-builder"')));
});

// ---- Stage 1: one default agent per chat mode, agreeing with the mode theme --

test("the defaults table covers every chat mode, in chat.js precedence order", () => {
  const reg = realRegistry();
  assert.deepEqual(reg.defaults.map((r) => r.mode), ["sdk", "orchestrator", "outrospection", "introspection", "normal"]);
  assert.deepEqual(
    reg.defaults.map((r) => r.flag),
    ["sdk_mode", "orchestrator_mode", "outrospection_mode", null, null],
  );
  for (const m of CHAT_MODE_IDS) {
    assert.ok(defaultAgentForMode(reg, m), `chat mode "${m}" has no default agent`);
  }
});

test("a default agent agrees with its mode theme on backdrop and depth slider", () => {
  const reg = realRegistry();
  for (const mode of CHAT_MODE_IDS) {
    const a = defaultAgentForMode(reg, mode);
    assert.equal(a.backdrop.kind, backdropKind(mode), `${a.id}: backdrop disagrees with MODE_THEMES.${mode}`);
    const hasDepth = resolveControls(a).some((c) => c.type === "depth-slider");
    assert.equal(hasDepth, showsDepthSlider(mode), `${a.id}: depth-slider presence disagrees with MODE_THEMES.${mode}`);
    assert.equal(a.mode, mode);
    assert.equal(a.platform, "server", `${a.id}: a Se/rver chat mode's default agent is server-platform`);
    assert.equal(MODE_THEMES[mode].id, mode);
  }
});

test("tier archetypes are not chat modes and are exempt from mode parity", () => {
  const reg = realRegistry();
  const inDefaults = new Set(reg.defaults.map((r) => r.agent));
  for (const id of ["secure", "under-construction"]) {
    assert.equal(inDefaults.has(id), false, `${id} is a tier archetype/template, not a chat mode`);
    assert.equal(findAgent(reg, id).platform, "client");
  }
});

// ---- Stage 2: the capability block, pinned to what the code actually does ----

test("every shipped agent declares a valid capability, and the registry validates whole", () => {
  const reg = realRegistry();
  assert.deepEqual(validateAgentRegistry(reg), []);
  for (const a of reg.agents) assert.deepEqual(validateCapability(a), [], `${a.id} capability`);
});

test("an absent capability block resolves to the plain deep-research turn", () => {
  const cap = resolveCapability(spec());
  assert.deepEqual(cap, BASE_CAPABILITY);
  assert.equal(cap.answerPhase, "research");
  // Sub-objects merge rather than replace, so a spec can name one bound alone.
  const partial = resolveCapability(spec({ capability: { bounds: { maxRounds: 3 }, search: { web: false } } }));
  assert.deepEqual(partial.bounds, { maxRounds: 3 });
  assert.equal(partial.search.web, false);
  assert.equal(partial.search.auxSources, true, "unnamed search fields keep their base value");
});

test("the workflow team's declared shape matches the executor's own caps", () => {
  // The bounds that live in a PURE core are pinned here; the ones that live in
  // the Worker (src/pipeline.js, src/orchestrator.js) are pinned in
  // src/agent-bounds.test.js — this suite stays inside the client module graph
  // so the public typecheck never pulls the Worker in.
  const orch = resolveCapability(findAgent(realRegistry(), "orchestrator"));
  assert.equal(orch.team.maxAgents, MAX_AGENTS);
  assert.equal(orch.team.maxWaves, MAX_WAVES);
  assert.equal(orch.team.maxQueriesPerAgent, MAX_NODE_QUERIES);
  assert.equal(orch.search.maxQueries, MAX_ORCH_SEARCHES);
});

test("declared tool sets and fallbacks match the modes that have them", () => {
  const reg = realRegistry();
  const cap = (id) => resolveCapability(findAgent(reg, id));
  // Introspection drives the snapshot readers, falling back to the JSON read loop.
  assert.deepEqual(cap("introspection").tools, ["source-read"]);
  assert.equal(cap("introspection").toolFallback, "read-loop");
  // Agent Studio adds the SDK planning tools and the shipping tools, falling
  // back to the fenced FILE:-block convention.
  assert.deepEqual(cap("agent-builder").tools, ["source-read", "sdk-plan", "build-publish"]);
  assert.equal(cap("agent-builder").toolFallback, "file-blocks");
  // The modes with no tool loop say so.
  for (const id of ["research", "orchestrator", "outrospection", "secure", "under-construction"]) {
    assert.deepEqual(cap(id).tools, [], `${id} runs no tool loop`);
    assert.equal(cap(id).toolFallback, "none");
  }
});

test("declared answer phases are one per shipped answer path", () => {
  const reg = realRegistry();
  const byMode = Object.fromEntries(
    CHAT_MODE_IDS.map((m) => [m, resolveCapability(defaultAgentForMode(reg, m)).answerPhase]),
  );
  assert.deepEqual(byMode, {
    normal: "research",
    introspection: "source-research",
    sdk: "build",
    orchestrator: "workflow",
    outrospection: "feed",
  });
});

test("every mode that needs the capability knob declares it", () => {
  const reg = realRegistry();
  for (const mode of ["sdk", "orchestrator", "outrospection", "introspection"]) {
    const cap = resolveCapability(defaultAgentForMode(reg, mode));
    assert.deepEqual(cap.requires, ["developer_mode"], `${mode} is gated on the developer_mode knob`);
  }
  assert.deepEqual(resolveCapability(defaultAgentForMode(reg, "normal")).requires, []);
});

// ---- Stage 3: the identity block, derived FROM the capability ----------------
//
// Spec 0.3.0 binds a system prompt to each declaration (owner directive,
// feedback #28: an agent asked "what can outrospection do" went and read the
// source to answer a question about itself). The block's load-bearing half is
// generated from the capability, which is what makes it un-driftable — so the
// assertions here are the same kind as the rest of this suite: declaration
// against implementation, one per axis.

test("every agent's system prompt reports its OWN capability, and claims nothing else", () => {
  const reg = realRegistry();
  for (const a of reg.agents) {
    const cap = resolveCapability(a);
    const text = agentIdentityPrompt(a);

    // The answer phase, named.
    assert.ok(text.includes(ANSWER_PHASES[cap.answerPhase].label), `${a.id} names its answer phase`);

    // Tools: an agent with none may not describe a tool loop; an agent with
    // some must name them AND its non-tool fallback (invariant 1, as a fact
    // about this agent rather than as a rule about the platform).
    if (cap.tools.length) {
      for (const t of cap.tools) assert.ok(text.includes(TOOL_CLASSES[t].label), `${a.id} names its ${t} tools`);
      assert.ok(text.includes(cap.toolFallback), `${a.id} names its no-tool fallback`);
    } else {
      assert.ok(!/drive the .* tools/.test(text), `${a.id} has no tools and must not claim any`);
      assert.ok(text.includes("no tools this turn"), `${a.id} says it has no tools`);
    }

    // Search: the block agrees with the search plane either way.
    if (cap.search.web && cap.search.maxQueries !== 0) assert.ok(text.includes("search the web"), `${a.id} searches`);
    else assert.ok(text.includes("run a web search"), `${a.id} does not search and says so`);

    // Every retrieval block it declares is named as something it works from.
    for (const b of cap.context) {
      assert.ok(text.includes(CONTEXT_BLOCKS[b].label), `${a.id} names the ${b} block it works from`);
    }

    // Gates and team, when declared.
    for (const g of cap.gates) assert.ok(text.includes(GATE_IDS[g.id].label), `${a.id} names its ${g.id} gate`);
    if (cap.team) assert.ok(text.includes(String(cap.team.maxAgents)), `${a.id} names its team size`);

    // The tier is structural, so it is stated as such.
    assert.ok(text.includes(a.platform === "client" ? "Se/cure" : "Se/rver"), `${a.id} names its tier`);
  }
});

test('"what can you do" is answerable without a source read or a sandbox command', () => {
  // The reported case, end to end (feedback #28): the block an outrospection
  // turn carries has to contain the answer AND the instruction to use it.
  const text = agentIdentityPrompt(findAgent(realRegistry(), "outrospection"));
  assert.ok(text.includes("outward feed"), "it says what it answers from");
  assert.ok(text.includes("Lens"), "it says how an ask is routed");
  assert.ok(text.includes("run a web search"), "it says what it cannot do");
  assert.ok(text.includes(IDENTITY_SELF_ANSWER_NOTE));
  assert.ok(/without reading source, running commands or searching/.test(text));
  // …while a genuinely implementation-level question is still allowed to go
  // looking — the other half of the directive.
  assert.ok(/Investigate only when the question asks for implementation-level detail/.test(text));
});

test("a capability change moves the identity with it — there is no second place to update", () => {
  const base = spec({ capability: { answerPhase: "research", search: { web: true } } });
  assert.ok(agentIdentityPrompt(base).includes("search the web"));
  const noSearch = spec({ capability: { answerPhase: "research", search: { web: false } } });
  assert.ok(!agentIdentityPrompt(noSearch).includes("search the web"));
  assert.ok(agentIdentityPrompt(noSearch).includes("run a web search on this turn"));
  // An authored persona cannot restore a capability the spec removed: the
  // authored half only ADDS lines, the derived half is what states the facts.
  const lying = spec({
    capability: { answerPhase: "research", search: { web: false } },
    identity: { does: ["describe what the web says"] },
  });
  assert.ok(agentIdentityPrompt(lying).includes("run a web search on this turn"));
});

// ---- The invariants, each with a passing and a failing case -----------------

test("invariant 1 — a tool-bearing mode must name a non-tool fallback", () => {
  assert.deepEqual(validateCapability(spec({ capability: { tools: ["source-read"], toolFallback: "read-loop" } })), []);
  const bad = validateCapability(spec({ capability: { tools: ["source-read"], toolFallback: "none" } }));
  assert.ok(bad.some((p) => p.includes("must work on models without native tool use")));
  // The vocabulary is closed: a spec cannot assemble a novel toolbox.
  assert.ok(validateCapability(spec({ capability: { tools: ["rm_rf"], toolFallback: "read-loop" } }))
    .some((p) => p.includes('unknown tool class "rm_rf"')));
});

test("invariant 3 — the planning phases never leave the fixed JSON model", () => {
  assert.deepEqual(validateCapability(spec({ capability: { routing: { planModel: "json-default" } } })), []);
  const bad = validateCapability(spec({ capability: { routing: { planModel: "user" } } }));
  assert.ok(bad.some((p) => p.includes("invariant 3")));
  // The answer model may be either bucket.
  assert.deepEqual(validateCapability(spec({ capability: { routing: { answerModel: "json-default" } } })), []);
  assert.ok(validateCapability(spec({ capability: { routing: { answerModel: "whatever" } } })).length);
});

test("invariant 4 — a client-tier agent may not put the server in the data path", () => {
  // Each server-only axis, rejected on a client platform and accepted on a server one.
  const cases = [
    { capability: { answerPhase: "build", tools: ["build-publish"], toolFallback: "file-blocks" } },
    { capability: { answerPhase: "feed", context: ["outward-feed"] } },
    { capability: { answerPhase: "workflow", team: { kinds: ["demo"] } } },
    { capability: { requires: ["developer_mode"] } },
    { capability: { emits: ["step", "build"] } },
  ];
  for (const over of cases) {
    const asClient = validateCapability(spec({ platform: "client", ...over }));
    assert.ok(asClient.some((p) => p.includes("invariant 4")), `client platform must reject ${JSON.stringify(over.capability)}`);
    const asServer = validateCapability(spec({ platform: "server", ...over }));
    assert.ok(!asServer.some((p) => p.includes("invariant 4")), `server platform must allow ${JSON.stringify(over.capability)}`);
  }
  // The client-tier things Se/cure genuinely does are NOT server-only: it reads
  // the source snapshot browser-direct and runs the sandbox in the page.
  const secureish = spec({
    platform: "client",
    capability: { tools: ["source-read", "shell"], toolFallback: "read-loop", context: ["source-snapshot", "shell-transcript"], answerPhase: "source-research" },
  });
  assert.deepEqual(validateCapability(secureish), []);
  assert.deepEqual(serverOnlySelections(secureish), []);
  // And the shipped client agents keep the promise.
  for (const a of realRegistry().agents) {
    if (a.platform !== "client") continue;
    assert.deepEqual(serverOnlySelections(a), [], `${a.id} must keep the client-tier promise`);
  }
});

test("invariant 6 — a declared gate routes Swedish and English alike", () => {
  assert.deepEqual(validateCapability(spec({ capability: { gates: [{ id: "lens", langs: ["en", "sv"] }] } })), []);
  for (const langs of [["en"], ["sv"], []]) {
    const bad = validateCapability(spec({ capability: { gates: [{ id: "lens", langs }] } }));
    assert.ok(bad.some((p) => p.includes("invariant 6")), `langs ${JSON.stringify(langs)} must be rejected`);
  }
  assert.ok(validateCapability(spec({ capability: { gates: [{ id: "vibes", langs: ["en", "sv"] }] } }))
    .some((p) => p.includes('unknown gate "vibes"')));
  // The two shipped gate-bearing modes declare parity.
  const reg = realRegistry();
  for (const [id, gate] of [["introspection", "external-source"], ["outrospection", "lens"]]) {
    const g = resolveCapability(findAgent(reg, id)).gates.find((x) => x.id === gate);
    assert.ok(g, `${id} declares the ${gate} gate`);
    assert.deepEqual([...g.langs].sort(), ["en", "sv"]);
  }
});

test("the closed vocabularies stay closed", () => {
  assert.deepEqual(Object.keys(ANSWER_PHASES), ["research", "source-research", "build", "workflow", "feed", "direct"]);
  assert.deepEqual(Object.keys(TOOL_CLASSES), ["source-read", "sdk-plan", "build-publish", "shell"]);
  assert.deepEqual(TOOL_FALLBACKS, ["read-loop", "file-blocks", "none"]);
  assert.deepEqual(Object.keys(GATE_IDS), ["external-source", "lens", "quiz", "feedback"]);
  assert.ok(Object.keys(CONTEXT_BLOCKS).includes("source-snapshot"));
  assert.ok(Object.keys(CAPABILITY_EVENTS).includes("agent_update"));
  assert.ok(Object.keys(CAPABILITY_REQUIREMENTS).includes("developer_mode"));
  for (const bad of ["answerPhase", "emits", "context", "requires"]) {
    const over = bad === "answerPhase" ? { answerPhase: "vibes" } : { [bad]: ["vibes"] };
    assert.ok(validateCapability(spec({ capability: over })).length, `${bad} must reject an unknown member`);
  }
  // Bounds are numbers, and only the three known ones.
  assert.ok(validateCapability(spec({ capability: { bounds: { maxRounds: -1 } } })).some((p) => p.includes("non-negative")));
  assert.ok(validateCapability(spec({ capability: { bounds: { forever: 1 } } })).some((p) => p.includes('unknown bound "forever"')));
  // A team only means something for a workflow.
  assert.ok(validateCapability(spec({ capability: { team: { kinds: ["research"] } } }))
    .some((p) => p.includes('answerPhase "workflow"')));
});

test("a workflow team may only name agents that exist", () => {
  const reg = realRegistry();
  const orch = findAgent(reg, "orchestrator");
  for (const k of resolveCapability(orch).team.kinds) {
    assert.ok(findAgent(reg, k), `team kind "${k}" is a registry agent`);
  }
  const broken = { ...reg, agents: reg.agents.map((a) => (a.id === "orchestrator"
    ? { ...a, capability: { ...a.capability, team: { ...a.capability.team, kinds: ["ghost"] } } }
    : a)) };
  assert.ok(validateAgentRegistry(broken).some((p) => p.includes('unknown agent "ghost"')));
});

// ---- Routing characterization (the safety net for a registry-driven dispatch) -

const DEV = { developer_mode: true };

test("routing: the mode flags resolve exactly as src/chat.js gates them", () => {
  const reg = realRegistry();
  const at = (body, granted) => {
    const hit = resolveRequestAgent(reg, body, granted);
    return hit && { mode: hit.mode, agent: hit.agent.id, phase: hit.capability.answerPhase };
  };

  // Each flag alone, with the knob granted.
  assert.deepEqual(at({ sdk_mode: true }, DEV), { mode: "sdk", agent: "agent-builder", phase: "build" });
  assert.deepEqual(at({ orchestrator_mode: true }, DEV), { mode: "orchestrator", agent: "orchestrator", phase: "workflow" });
  assert.deepEqual(at({ outrospection_mode: true }, DEV), { mode: "outrospection", agent: "outrospection", phase: "feed" });

  // Precedence when several arrive: sdk > orchestrator > outrospection.
  assert.equal(at({ sdk_mode: true, orchestrator_mode: true, outrospection_mode: true }, DEV).mode, "sdk");
  assert.equal(at({ orchestrator_mode: true, outrospection_mode: true }, DEV).mode, "orchestrator");

  // No flag, knob granted → introspection (the derived default).
  assert.deepEqual(at({}, DEV), { mode: "introspection", agent: "introspection", phase: "source-research" });

  // No knob → every gated mode is unreachable, whatever the body claims. This
  // is the "a client can't acquire a capability it doesn't hold" rule.
  for (const body of [{}, { sdk_mode: true }, { orchestrator_mode: true }, { outrospection_mode: true }]) {
    assert.deepEqual(at(body, {}), { mode: "normal", agent: "research", phase: "research" },
      `${JSON.stringify(body)} without the knob must fall to Deep Research`);
  }

  // Strict booleans only — no truthy-string surprises (the normalizeTriage habit).
  assert.equal(at({ sdk_mode: "yes" }, DEV).mode, "introspection");
  assert.equal(at({ sdk_mode: 1 }, DEV).mode, "introspection");
});

test("routing degrades to null on an unusable registry, never throws", () => {
  for (const reg of [null, undefined, {}, { agents: [] }, { defaults: [] }, { defaults: "x" }]) {
    assert.equal(resolveRequestAgent(reg, { sdk_mode: true }, DEV), null);
  }
  // A defaults row naming an agent that does not exist is skipped, not fatal.
  const reg = realRegistry();
  const broken = { ...reg, defaults: [{ mode: "sdk", agent: "ghost", flag: "sdk_mode" }, ...reg.defaults.slice(1)] };
  assert.equal(resolveRequestAgent(broken, { sdk_mode: true }, DEV).mode, "introspection");
});

test("routing: a sixth agent is data — adding one to the registry routes it", () => {
  // The acceptance test for the whole generalization: a new mode-bearing agent
  // that exists ONLY as registry data resolves through the same code path.
  const reg = realRegistry();
  const sixth = {
    id: "scout",
    name: "Scout",
    platform: "server",
    mode: "normal",
    controls: [{ type: "prompt-input" }],
    capability: { answerPhase: "direct", requires: ["sandbox"], search: { web: false } },
  };
  const extended = {
    ...reg,
    agents: [...reg.agents, sixth],
    defaults: [{ mode: "normal", agent: "scout", flag: "scout_mode" }, ...reg.defaults],
  };
  assert.deepEqual(validateAgentSpec(sixth), []);
  const hit = resolveRequestAgent(extended, { scout_mode: true }, { ...DEV, sandbox: true });
  assert.equal(hit.agent.id, "scout");
  assert.equal(hit.capability.answerPhase, "direct");
  // Its own requirement gates it, exactly like developer_mode gates the others:
  // without the sandbox knob the flagged row is skipped and the request falls
  // through to the derived default.
  assert.equal(resolveRequestAgent(extended, { scout_mode: true }, DEV).agent.id, "introspection");
});
