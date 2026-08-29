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
//     reproduce what src/chat.js does: the caller resolves the chat mode once
//     (chat-mode-core.js) and the table picks that mode's agent, with the legacy
//     per-mode flags and an addressed id as the other two ways in — every pass
//     gated on the capabilities the caller actually holds. These tests describe
//     today's behaviour deliberately: they are the safety net a registry-driven
//     dispatch has to keep green.
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
  IMPLIED_REQUIREMENTS,
  RESEARCH_STRATEGIES,
  MODE_THEMES,
  requirementsFor,
  resolveUntrustedAgent,
  TOOL_CLASSES,
  TOOL_FALLBACKS,
  capHasTool,
  capSearch,
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
import { DEFAULT_CHAT_MODE, MODE_REQUEST_FLAGS } from "./chat-mode-core.js";
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
  const bad = spec({ controls: [{ type: "prompt-input" }, { type: "mode-select", modes: ["science", "agent-builder"] }] });
  assert.ok(validateAgentSpec(bad).some((p) => p.includes('mode-select offers "agent-builder"')));
});

// ---- Stage 1: one default agent per chat mode, agreeing with the mode theme --

test("the defaults table covers every chat mode, in chat.js precedence order", () => {
  const reg = realRegistry();
  assert.deepEqual(reg.defaults.map((r) => r.mode), ["sdk", "orchestrator", "outrospection", "models", "introspection", "cyber", "lypning", "science"]);
  // EVERY row names a request flag now — there is no `flag: null` row any more.
  // Until 2026-08-13 the last row was `normal` → the general research agent,
  // reachable by no flag at all, which is what "terminal fallback" meant: the
  // pass that walks the flagless rows. Retiring the general agent retired that
  // pass with it (nothing is flagless), and Deep Science took the terminal seat
  // — reached through the MODE pass, because a request always arrives with the
  // mode its caller already resolved (src/chat.js hands `enrich.chatMode` in,
  // and resolveBodyChatMode clamps an unavailable one to DEFAULT_CHAT_MODE).
  // Introspection got `introspection_mode` in 2026-07-26's collapse — before
  // that it was the only mode with no way to ask for it by name, which is what
  // made it the derived leftover of the developer_mode knob.
  assert.deepEqual(
    reg.defaults.map((r) => r.flag),
    ["sdk_mode", "orchestrator_mode", "outrospection_mode", "models_mode", "introspection_mode", "cyber_mode", "lypning_mode", "science_mode"],
  );
  assert.equal(reg.defaults.some((r) => !r.flag), false, "no row is reachable without being asked for by name");
  assert.equal(reg.defaults.at(-1).mode, DEFAULT_CHAT_MODE, "the last row is the default mode's — the terminal one");
  // The flags and their order agree with the shared mode table, which is what
  // src/chat.js actually resolves a request's mode against.
  assert.deepEqual(
    reg.defaults.filter((r) => r.flag).map((r) => [r.mode, r.flag]),
    MODE_REQUEST_FLAGS.map((r) => [r.mode, r.flag]),
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
  // THE RESEARCH AGENTS DRIVE THEIR OWN TOOLS (2026-08-29, the owner directive
  // that made the model-driven path the main one). Each one's classes are its
  // declared CONTEXT expressed as tools — a class whose block the agent does
  // not declare would be refused at admission anyway, so declaring it would
  // only spend the model's rounds discovering that. Hence cyber holds the two
  // integration classes and scholar does not, and scholar holds `literature`
  // and cyber does not.
  const RESEARCH_TOOLBOXES = {
    scholar: ["web-research", "source-search", "literature", "python"],
    cyber: ["web-research", "source-search", "host-intel-tools", "street-imagery-tools", "python"],
    palaeogenomics: ["web-research", "source-search", "literature", "ancient-samples-query", "python"],
    models: ["web-research", "source-search", "python"],
    secure: ["web-research", "python"],
  };
  for (const [id, tools] of Object.entries(RESEARCH_TOOLBOXES)) {
    assert.deepEqual(cap(id).tools, tools, `${id}'s toolbox`);
    // EVERY tool-declaring research agent falls back to the standard four-node
    // graph, which is plain JSON-mode and streamed calls. That is what makes
    // the amended invariant 1 safe to state: a loop only some models can run
    // could not be the main path of a platform that routes to a whole catalog.
    assert.equal(cap(id).toolFallback, "pipeline", `${id}'s fallback`);
  }
  // The modes with no tool loop still say so. `lypning` is the interesting one:
  // it answers from a single committed dataset and searches nothing, so a
  // toolbox would only offer it tools every call would be refused.
  for (const id of ["lypning", "orchestrator", "outrospection", "under-construction"]) {
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
    introspection: "source-research",
    sdk: "build",
    orchestrator: "workflow",
    outrospection: "feed",
    // The Models agent adds NO executor: it is the research phase with the Hub
    // forced on and the priced, verification-annotated model catalog in
    // context, which is why a sixth mode needed no row in ANSWER_PHASE_RUNNERS.
    models: "research",
    // Deep Science is the same shape and the point is worth stating twice: a
    // mode is a SELECTION over shipped behaviour, not new behaviour. It is the
    // research phase restricted to peer-reviewed sources, so a seventh mode
    // needed no row in ANSWER_PHASE_RUNNERS either (invariant 1 holds for the
    // routing as for the run).
    science: "research",
    // And Cyber, which replaced the general research agent on 2026-08-13, is the
    // same shape a third time: the research phase pointed at the security/OSINT
    // context blocks and gates. A domain is a SELECTION, so retiring the
    // catch-all and adding a domain agent moved no code into the executor table.
    cyber: "research",
    // And lypning, the fourth: it is the research phase with the web leg turned
    // OFF and one context block — the dashboard's own dataset — in its place.
    // A stats agent for an external project needed no executor either, which is
    // the strongest version of the same point: even a mode whose subject is not
    // research at all is a SELECTION over shipped behaviour.
    lypning: "research",
  });
  // The retired mode cannot be asked for by name here: the defaults table is
  // keyed on live chat modes, and `normal` resolves only through
  // normalizeChatMode (RETIRED_CHAT_MODES), one layer up.
  assert.equal(defaultAgentForMode(reg, "normal"), null);
});

test("every mode that needs the capability knob declares it", () => {
  const reg = realRegistry();
  // `science` came OUT of this list and `cyber` went in (2026-08-13). Deep
  // Science is the terminal fallback now, and the terminal row is the ONE that
  // may not declare a requirement: a requirement on it would be unsatisfiable
  // for an identity that holds no knob, the row would be skipped, and the walk
  // would end at nothing — a null capability, which is the UNRESTRICTED platform
  // default. The fallback has to be servable to everyone for the restriction to
  // mean anything.
  for (const mode of ["sdk", "orchestrator", "outrospection", "models", "introspection", "cyber"]) {
    const cap = resolveCapability(defaultAgentForMode(reg, mode));
    assert.deepEqual(cap.requires, ["developer_mode"], `${mode} is gated on the developer_mode knob`);
  }
  assert.deepEqual(resolveCapability(defaultAgentForMode(reg, DEFAULT_CHAT_MODE)).requires, []);
  assert.equal(DEFAULT_CHAT_MODE, "science");
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
  // The seven added on 2026-08-29 are the RESEARCH toolbox — the classes an
  // agent declares to reach the tools it drives itself on the agentic path.
  // They are classes rather than tool names for the reason src/tool-sets.js's
  // header gives: a spec selects a SET, never an individual tool, which is what
  // keeps the owner-authorized invariant-1 exception bounded to shapes that
  // were actually authorized. `python` is one class rather than a tool because
  // the interpreter behind it is a fall-through ladder, not one binary.
  assert.deepEqual(Object.keys(TOOL_CLASSES), [
    "source-read", "sdk-plan", "build-publish", "shell",
    "web-research", "source-search", "literature", "ancient-samples-query",
    "host-intel-tools", "street-imagery-tools", "python",
  ]);
  // `pipeline` joined on 2026-08-29: the research toolbox's fallback, and the
  // one that lets the main path be a tool loop at all.
  assert.deepEqual(TOOL_FALLBACKS, ["read-loop", "file-blocks", "pipeline", "none"]);
  // The five gates added on 2026-08-13 are the Cyber agent's: the general
  // research agent used to reach these behaviours by keyword alone, from any
  // turn. They are a domain's now, so they are declared — `host-intel` and
  // `place-lookup` deliberately naming no module, because their gates sit
  // downstream of the extension registry (invariant 7).
  assert.deepEqual(Object.keys(GATE_IDS), [
    "external-source", "lens", "quiz", "model-lifecycle", "ancient-sample", "scholar-venue",
    "security-assessment", "entity-research", "person-research", "lypning-series", "host-intel",
    "place-lookup", "feedback",
  ]);
  assert.ok(Object.keys(CONTEXT_BLOCKS).includes("source-snapshot"));
  assert.ok(Object.keys(CONTEXT_BLOCKS).includes("ancient-samples"));
  assert.ok(Object.keys(CONTEXT_BLOCKS).includes("scholar-metrics"));
  assert.ok(Object.keys(CONTEXT_BLOCKS).includes("lypning-stats"));
  // The blocks the two new domain rosters select — Cyber's four and the
  // literature legs Deep Science and Palaeogenomics declare.
  for (const b of ["owasp", "entity-method", "person-method", "host-intel", "street-imagery",
    "literature-arxiv", "literature-pubmed", "literature-peer-reviewed"]) {
    assert.ok(Object.keys(CONTEXT_BLOCKS).includes(b), `${b} is a declarable context block`);
  }
  assert.ok(Object.keys(CAPABILITY_EVENTS).includes("agent_update"));
  assert.ok(Object.keys(CAPABILITY_REQUIREMENTS).includes("developer_mode"));
  assert.deepEqual(RESEARCH_STRATEGIES, ["auto", "agentic", "standard"]);
  assert.ok(validateCapability(spec({ capability: { routing: { strategy: "vibes" } } })).length);
  assert.deepEqual(validateCapability(spec({ capability: { routing: { strategy: "agentic" } } })), []);
  // Every implied requirement names a class that exists and a knob that exists.
  // The drift this prevents: a class added to TOOL_CLASSES and bound in
  // src/tool-sets.js while its knob row keeps the OLD class's name, so an agent
  // declaring it needs nothing and reaches everything.
  for (const [cls, needs] of Object.entries(IMPLIED_REQUIREMENTS.tools)) {
    assert.ok(Object.keys(TOOL_CLASSES).includes(cls), `${cls} is a real tool class`);
    for (const r of needs) assert.ok(Object.keys(CAPABILITY_REQUIREMENTS).includes(r), `${cls} needs a real knob`);
  }
  // `python` implies NO knob, and `shell` still implies the sandbox. They look
  // like twins — both run something in the environment the request is bound to
  // — and pairing them here was the first instinct. It is wrong, and the reason
  // is the difference between the two gating mechanisms rather than anything
  // about Python: `requires` decides whether an AGENT is reachable, and the
  // terminal row of the defaults table may not carry one (an identity that
  // cannot satisfy it makes the routing walk skip the row and end at nothing).
  // So a knob here did not gate computing — it made the DEFAULT agent unable to
  // declare the class at all. Whether there is anywhere to run is a property of
  // the deployment, which is `needs: "exec"` on the binding: the class is
  // dropped and the rest of the toolbox survives.
  assert.deepEqual(IMPLIED_REQUIREMENTS.tools.python, undefined);
  assert.deepEqual(IMPLIED_REQUIREMENTS.tools.shell, ["sandbox"]);
  // The other half of that — that the binding carries `needs: "exec"` instead —
  // is pinned in src/tool-sets.test.js, which is where the bindings live.
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

test("routing: the resolved MODE picks the agent, exactly as src/chat.js does", () => {
  const reg = realRegistry();
  // src/chat.js resolves the mode ONCE (chat-mode-core.js resolveBodyChatMode)
  // and hands it in; this is the fourth argument.
  const atMode = (mode, granted) => {
    const hit = resolveRequestAgent(reg, {}, granted, mode);
    return hit && { mode: hit.mode, agent: hit.agent.id, phase: hit.capability.answerPhase };
  };

  assert.deepEqual(atMode("sdk", DEV), { mode: "sdk", agent: "agent-builder", phase: "build" });
  assert.deepEqual(atMode("orchestrator", DEV), { mode: "orchestrator", agent: "orchestrator", phase: "workflow" });
  assert.deepEqual(atMode("outrospection", DEV), { mode: "outrospection", agent: "outrospection", phase: "feed" });
  assert.deepEqual(atMode("introspection", DEV), { mode: "introspection", agent: "introspection", phase: "source-research" });
  assert.deepEqual(atMode("cyber", DEV), { mode: "cyber", agent: "cyber", phase: "research" });
  // Deep Science, the terminal row since the general agent was retired
  // (2026-08-13). This line used to read `atMode("normal", …) → research`.
  assert.deepEqual(atMode("science", DEV), { mode: "science", agent: "scholar", phase: "research" });
  // …and it is the one row that resolves with NO capability at all, which is
  // what makes it usable as the fallback (see the requires test above).
  assert.deepEqual(atMode(DEFAULT_CHAT_MODE, {}), { mode: "science", agent: "scholar", phase: "research" });

  // Without the capability every gated mode is unreachable, whatever mode the
  // caller resolved — the "a client can't acquire a capability it doesn't hold"
  // rule, enforced here as the last line of defence even though
  // resolveBodyChatMode has already clamped an unavailable identity to the
  // default mode. What an ungranted mode yields CHANGED on 2026-08-13: it used
  // to silently become the plain Deep Research turn, because the flagless
  // `normal` row caught everything the walk had refused. There is no flagless
  // row now, so the walk simply ends — null, "no agent", and src/chat.js answers
  // the turn from its own cascade rather than from a capability the caller never
  // qualified for. Refusing is the safer of the two: a downgrade that quietly
  // hands back the UNRESTRICTED default is exactly what routingNeedsRegistry
  // stopped doing on the same day.
  for (const mode of ["introspection", "sdk", "orchestrator", "outrospection", "models", "cyber"]) {
    assert.equal(atMode(mode, {}), null, `${mode} without the capability must not resolve`);
  }
  // The retired mode id is not a row: callers normalize it (normalizeChatMode,
  // RETIRED_CHAT_MODES: normal → science) BEFORE routing, and an un-normalized
  // one resolves to nothing rather than to a nearest match.
  assert.equal(atMode("normal", DEV), null);
});

test("routing: the legacy mode flags still resolve, for callers that send them", () => {
  const reg = realRegistry();
  const at = (body, granted) => {
    const hit = resolveRequestAgent(reg, body, granted);
    return hit && { mode: hit.mode, agent: hit.agent.id, phase: hit.capability.answerPhase };
  };

  // Each flag alone, with the capability granted. src/chat.js folds these into
  // the resolved mode before routing, so this pass is what serves a hand-rolled
  // request — and a registry-declared flag the shipped table doesn't know.
  assert.deepEqual(at({ sdk_mode: true }, DEV), { mode: "sdk", agent: "agent-builder", phase: "build" });
  assert.deepEqual(at({ orchestrator_mode: true }, DEV), { mode: "orchestrator", agent: "orchestrator", phase: "workflow" });
  assert.deepEqual(at({ outrospection_mode: true }, DEV), { mode: "outrospection", agent: "outrospection", phase: "feed" });
  assert.deepEqual(at({ introspection_mode: true }, DEV), { mode: "introspection", agent: "introspection", phase: "source-research" });
  assert.deepEqual(at({ cyber_mode: true }, DEV), { mode: "cyber", agent: "cyber", phase: "research" });
  assert.deepEqual(at({ science_mode: true }, DEV), { mode: "science", agent: "scholar", phase: "research" });

  // Precedence when several arrive: sdk > orchestrator > outrospection.
  assert.equal(at({ sdk_mode: true, orchestrator_mode: true, outrospection_mode: true }, DEV).mode, "sdk");
  assert.equal(at({ orchestrator_mode: true, outrospection_mode: true }, DEV).mode, "orchestrator");

  // NO flag and no mode selects NOTHING. This line has moved twice. It used to
  // be INTROSPECTION (introspection had no flag and was whatever was left once
  // the developer_mode knob was on); 2026-07-26 made it the plain Deep Research
  // turn, served by the flagless `normal` row; 2026-08-13 retired that row with
  // the general agent, so a body that asks for no mode and carries no flag has
  // named nothing to route to. In a real request this branch is unreachable —
  // src/chat.js resolves the mode first and always passes it (the fourth
  // argument, exercised in the test above).
  assert.equal(at({}, DEV), null);
  assert.deepEqual(
    resolveRequestAgent(reg, {}, DEV, DEFAULT_CHAT_MODE).agent.id, "scholar",
    "…and with the mode a real caller supplies, the terminal row answers",
  );

  // Strict booleans only — no truthy-string surprises (the normalizeTriage
  // habit): a truthy non-boolean does not select Agent Studio, so the turn is
  // whatever the resolved mode says it is.
  assert.equal(at({ sdk_mode: "yes" }, DEV), null);
  assert.equal(at({ sdk_mode: 1 }, DEV), null);
  assert.equal(resolveRequestAgent(reg, { sdk_mode: "yes" }, DEV, DEFAULT_CHAT_MODE).agent.id, "scholar");

  // An explicit mode outranks a flag, so a stale flag cannot hijack the turn.
  assert.equal(resolveRequestAgent(reg, { sdk_mode: true }, DEV, "introspection").mode, "introspection");
});

test("routing degrades to null on an unusable registry, never throws", () => {
  for (const reg of [null, undefined, {}, { agents: [] }, { defaults: [] }, { defaults: "x" }]) {
    assert.equal(resolveRequestAgent(reg, { sdk_mode: true }, DEV), null);
    assert.equal(resolveRequestAgent(reg, {}, DEV, "sdk"), null);
  }
  // A defaults row naming an agent that does not exist is skipped, not fatal.
  // Where the request lands after the skip changed on 2026-08-13: it used to
  // fall to the flagless `normal` row, and that row is gone, so a walk that
  // finds nothing else ends at null — while a caller that supplied its resolved
  // mode still gets that mode's agent, and one broken row takes no other row
  // down with it.
  const reg = realRegistry();
  const broken = { ...reg, defaults: [{ mode: "sdk", agent: "ghost", flag: "sdk_mode" }, ...reg.defaults.slice(1)] };
  assert.equal(resolveRequestAgent(broken, { sdk_mode: true }, DEV), null);
  assert.equal(resolveRequestAgent(broken, {}, DEV, "sdk"), null);
  assert.equal(resolveRequestAgent(broken, { sdk_mode: true }, DEV, DEFAULT_CHAT_MODE).agent.id, "scholar");
  assert.equal(resolveRequestAgent(broken, {}, DEV, "introspection").agent.id, "introspection");
});

test("routing: an eighth agent is data — adding one to the registry routes it", () => {
  // The acceptance test for the whole generalization: a new mode-bearing agent
  // that exists ONLY as registry data resolves through the same code path. (It
  // was "a sixth agent" when the mode table had five rows; the count is not the
  // point, and the roster has moved twice since.)
  const reg = realRegistry();
  const extra = {
    id: "scout",
    name: "Scout",
    platform: "server",
    // A shipped chat mode, because `mode` is validated against CHAT_MODE_IDS —
    // and the row goes at the END, so the shipped Deep Science row still wins
    // the mode pass and only the flag reaches this one.
    mode: DEFAULT_CHAT_MODE,
    controls: [{ type: "prompt-input" }],
    capability: { answerPhase: "direct", requires: ["sandbox"], search: { web: false } },
  };
  const extended = {
    ...reg,
    agents: [...reg.agents, extra],
    defaults: [...reg.defaults, { mode: DEFAULT_CHAT_MODE, agent: "scout", flag: "scout_mode" }],
  };
  assert.deepEqual(validateAgentSpec(extra), []);
  // A registry-declared flag the shipped mode table knows nothing about — which
  // is why resolveRequestAgent keeps a flag pass of its own after the mode pass.
  const hit = resolveRequestAgent(extended, { scout_mode: true }, { ...DEV, sandbox: true });
  assert.equal(hit.agent.id, "scout");
  assert.equal(hit.capability.answerPhase, "direct");
  // Its own requirement gates it, exactly like developer_mode gates the others:
  // without the sandbox knob the flagged row is skipped, and the request
  // resolves to whatever the caller's own mode says — Deep Science, the terminal
  // row, for a caller that asked for nothing else. (Before 2026-08-13 the answer
  // here was the general `research` agent, reached through the flagless row that
  // retiring it removed.)
  assert.equal(resolveRequestAgent(extended, { scout_mode: true }, DEV, DEFAULT_CHAT_MODE).agent.id, "scholar");
  assert.equal(resolveRequestAgent(extended, { scout_mode: true }, DEV), null);
});

// ---- the narrowing accessors (stage 5: declared → executed) -------------------
//
// capBound has its own suite next to the Worker constants it clamps against
// (src/agent-bounds.test.js). These two live here because they are wholly
// expressible in the client module graph.

test("capSearch narrows in both directions and never widens", () => {
  const off = { search: { web: false, auxSources: false } };
  const on = { search: { web: true, auxSources: true } };
  // A knob that is off wins over any declaration…
  assert.deepEqual(capSearch(on, { web: false }).web, false);
  // …and a declaration that is off wins over any knob.
  assert.deepEqual(capSearch(off, { web: true }).web, false);
  // Both on is the only way through.
  assert.deepEqual(capSearch(on, { web: true }).web, true);
  // Absent request fields mean "not asked about", not "denied".
  assert.deepEqual(capSearch(on, {}).auxSources, true);
  assert.deepEqual(capSearch(off, {}).auxSources, false);
  // No capability at all is the request alone — a run that never consulted
  // the registry behaves exactly as it did before this existed.
  assert.deepEqual(capSearch(null, { web: true }), { web: true, auxSources: true, maxQueries: null });
});

test("capSearch takes the LOWER query ceiling, and null means unbounded", () => {
  assert.equal(capSearch({ search: { maxQueries: 3 } }, { maxQueries: 9 }).maxQueries, 3);
  assert.equal(capSearch({ search: { maxQueries: 9 } }, { maxQueries: 3 }).maxQueries, 3);
  assert.equal(capSearch({ search: { maxQueries: null } }, { maxQueries: 4 }).maxQueries, 4);
  assert.equal(capSearch({ search: { maxQueries: 4 } }, {}).maxQueries, 4);
  assert.equal(capSearch({ search: {} }, {}).maxQueries, null);
  assert.equal(capSearch({ search: { maxQueries: 0 } }, {}).maxQueries, 0, "zero is a real ceiling");
  // Garbage is not a ceiling — it is an absent one (invariant 2 at the seam).
  for (const bad of [-1, NaN, Infinity, "3", null]) {
    assert.equal(capSearch({ search: { maxQueries: bad } }, {}).maxQueries, null, `${String(bad)} ignored`);
  }
});

test("the orchestrator's declared query ceiling is the executor's own budget", () => {
  // The one search field that was genuinely declared-but-unread before stage 5:
  // MAX_ORCH_SEARCHES now comes from the spec, clamped to itself.
  const orch = resolveCapability(findAgent(realRegistry(), "orchestrator"));
  assert.equal(orch.search.maxQueries, MAX_ORCH_SEARCHES);
  assert.equal(capSearch(orch, { web: true }).maxQueries, MAX_ORCH_SEARCHES);
});

test("capHasTool reads the declared classes and nothing else", () => {
  const build = resolveCapability(findAgent(realRegistry(), "agent-builder"));
  assert.ok(capHasTool(build, "source-read"));
  assert.ok(capHasTool(build, "build-publish"));
  assert.ok(!capHasTool(build, "shell"));
  // An agent with no tools, and no capability at all, both select nothing.
  assert.ok(!capHasTool(resolveCapability(findAgent(realRegistry(), "cyber")), "source-read"));
  assert.ok(!capHasTool(null, "source-read"));
});

// ---- Stage 6: an agent is ADDRESSABLE, not only a mode's default -------------
//
// The defaults table made a sixth MODE data. These make a sixth AGENT data: a
// registry entry reachable with no defaults row, no request flag, no
// CHAT_MODE_IDS entry, no mode-theme descriptor and no CSS. That is the seam a
// builder needs, and the one Agent Studio publishes into.

test("addressing: `agent` selects a registry entry the defaults table cannot reach", () => {
  const reg = realRegistry();
  // `secure` and `under-construction` are tier archetypes — no defaults row, no
  // flag, unreachable before this. Addressed, they answer.
  const hit = resolveRequestAgent(reg, { agent: "under-construction" }, DEV);
  assert.equal(hit.agent.id, "under-construction");
  assert.equal(hit.capability.answerPhase, "direct");
  assert.equal(hit.addressed, true);
  // An agent bound to no chat mode renders in the DEFAULT composer. Both tier
  // archetypes stopped declaring a mode on 2026-08-13 — they used to say
  // "normal", and that mode no longer exists — so this reports
  // DEFAULT_CHAT_MODE, which is a real domain agent's mode now rather than the
  // old catch-all's.
  assert.equal(hit.mode, DEFAULT_CHAT_MODE);
  assert.equal(findAgent(reg, "under-construction").mode, undefined, "the archetype declares no mode at all");
  // The archetype for the client tier, likewise.
  assert.equal(resolveRequestAgent(reg, { agent: "secure" }, DEV).agent.id, "secure");
});

test("addressing beats every mode flag, because it is more specific", () => {
  const reg = realRegistry();
  const hit = resolveRequestAgent(reg, { agent: "outrospection", sdk_mode: true }, DEV);
  assert.equal(hit.agent.id, "outrospection");
  assert.equal(hit.capability.answerPhase, "feed");
});

test("addressing is subject to the SAME requirement gate as every other route", () => {
  const reg = realRegistry();
  // Agent Studio requires developer_mode. Addressing it without the knob must
  // not be a way around the knob — it falls through to what the caller could
  // have had anyway, which is the mode it already resolved.
  const denied = resolveRequestAgent(reg, { agent: "agent-builder" }, {}, DEFAULT_CHAT_MODE);
  assert.equal(denied.agent.id, "scholar", "an ungranted address falls through, never escalates");
  assert.equal(denied.addressed, false);
  // With no mode to fall through TO, the refusal is total rather than a
  // downgrade: before 2026-08-13 the flagless `normal` row caught this and
  // handed back the general research agent, and there is no such row now.
  assert.equal(resolveRequestAgent(reg, { agent: "agent-builder" }, {}), null);
  // With the knob, the same body reaches it.
  assert.equal(resolveRequestAgent(reg, { agent: "agent-builder" }, DEV).agent.id, "agent-builder");
});

test("an unknown, malformed or empty address falls through to the table", () => {
  const reg = realRegistry();
  // Every one of these must behave exactly like a body that named no agent at
  // all — so probing for ids reveals nothing and breaks nothing. With the mode a
  // real caller supplies, that is the default agent's turn; the id in the body
  // changes nothing about which one answers.
  for (const agent of ["ghost", "", "   ", null, 7, {}, [], true]) {
    const hit = resolveRequestAgent(reg, { agent }, DEV, DEFAULT_CHAT_MODE);
    assert.equal(hit.agent.id, "scholar", `agent=${JSON.stringify(agent)} falls through`);
    assert.equal(hit.addressed, false);
    // The same body with no mode at all resolves to nothing rather than to a
    // consolation agent — the flagless `normal` row that used to catch it went
    // with the general agent on 2026-08-13.
    assert.equal(resolveRequestAgent(reg, { agent }, DEV), null);
  }
  // A bad address falls through to the MODE the caller resolved, not past it.
  const inMode = resolveRequestAgent(reg, { agent: "ghost" }, DEV, "introspection");
  assert.equal(inMode.agent.id, "introspection");
  assert.equal(inMode.addressed, false);
  // …and for an identity holding no capability — whose mode resolveBodyChatMode
  // has already clamped to the default — to the terminal row, which needs none.
  assert.equal(resolveRequestAgent(reg, { agent: "ghost" }, {}, DEFAULT_CHAT_MODE).agent.id, "scholar");
});

test("a defaults-table hit is never marked addressed", () => {
  const reg = realRegistry();
  assert.equal(resolveRequestAgent(reg, { sdk_mode: true }, DEV).addressed, false);
  // The two bodies that name nothing are asked WITH the resolved mode a real
  // caller carries: since 2026-08-13 there is no flagless row to catch a body
  // that asks for nothing at all, so the no-mode form resolves to null and has
  // no `addressed` flag to check.
  assert.equal(resolveRequestAgent(reg, {}, DEV, DEFAULT_CHAT_MODE).addressed, false);
  assert.equal(resolveRequestAgent(reg, {}, {}, DEFAULT_CHAT_MODE).addressed, false);
});

test("addressing an agent that exists only as registry data routes it whole", () => {
  // The stage-6 acceptance test: a new agent added ONLY to AGENTS.json, with no
  // defaults row at all, answers on its own phase, prompt set and bounds.
  const reg = realRegistry();
  const scout = {
    id: "scout",
    name: "Scout",
    platform: "server",
    mode: DEFAULT_CHAT_MODE,
    controls: [{ type: "prompt-input" }],
    capability: {
      answerPhase: "research",
      bounds: { maxRounds: 2 },
      search: { web: false, auxSources: false, maxQueries: 1 },
    },
  };
  assert.deepEqual(validateAgentSpec(scout), []);
  const extended = { ...reg, agents: [...reg.agents, scout] };
  const hit = resolveRequestAgent(extended, { agent: "scout" }, DEV);
  assert.equal(hit.agent.id, "scout");
  assert.equal(hit.capability.answerPhase, "research");
  assert.equal(hit.capability.bounds.maxRounds, 2);
  assert.equal(capSearch(hit.capability, { web: true }).web, false, "its declaration narrows the knob");
  assert.equal(capSearch(hit.capability, { maxQueries: 20 }).maxQueries, 1, "…and its query ceiling");
});

test("addressing: prompt set and answer phase stay independent choices", () => {
  // The freedom capability.prompts bought, exercised through addressing: a
  // build-phase agent speaking in the source-research voice. It is bounded —
  // a set that cannot fill its phase's roles is still rejected, which is why
  // the research phase can only take the research set.
  const reg = realRegistry();
  const quiet = {
    id: "quiet-builder",
    name: "Quiet Builder",
    platform: "server",
    mode: "sdk",
    controls: [{ type: "prompt-input" }],
    capability: {
      answerPhase: "build",
      prompts: "source-research",
      tools: ["build-publish"],
      toolFallback: "file-blocks",
      requires: ["developer_mode"],
    },
  };
  assert.deepEqual(validateAgentSpec(quiet), []);
  const hit = resolveRequestAgent({ ...reg, agents: [...reg.agents, quiet] }, { agent: "quiet-builder" }, DEV);
  assert.equal(hit.capability.answerPhase, "build");
  assert.equal(hit.capability.prompts, "source-research");
  // …and the pairing that is NOT expressible stays rejected.
  const bad = { ...quiet, id: "bad", capability: { ...quiet.capability, answerPhase: "research" } };
  assert.ok(validateAgentSpec(bad).some((p) => p.includes("does not fill the research phase")));
});

// ---- Stage 7: resolving a spec the repo did not commit -----------------------
//
// Every spec in AGENTS.json ships inside the source snapshot, so `npm test` is
// what stands between a bad declaration and production. A spec a USER authored
// has no such gate. These are the rules that replace it, and each one is
// written as "the hostile spec that would work without this".

test("the implied-requirement table agrees with the real registry", () => {
  // The table is derived from what the shipped agents declare, so it must not
  // drift from them: every shipped agent's declared `requires` has to cover
  // what its own selections imply. A newly-privileged selection that nobody
  // added to the table fails here rather than at a request.
  for (const a of realRegistry().agents) {
    const declared = new Set(resolveCapability(a).requires);
    for (const r of requirementsFor(a)) {
      assert.ok(declared.has(r), `${a.id} selects something implying "${r}" but does not declare it`);
    }
  }
  // …and the derivation adds nothing where nothing is due.
  assert.deepEqual(requirementsFor(findAgent(realRegistry(), "scholar")), []);
  assert.deepEqual(requirementsFor(findAgent(realRegistry(), "agent-builder")), ["developer_mode"]);
});

test("Deep Science declares a web leg the reader's knob still governs", () => {
  // feedback #69 (2026-08-14): the agent used to declare `search.web: false`,
  // which capSearch could only narrow — so the knob was inert and the open
  // record was unreachable, including for the one question (what a retracted
  // paper claimed) that ONLY the open record answers. The declaration is now
  // true, which restores the knob as the decider rather than making the web
  // leg unconditional.
  const cap = resolveCapability(findAgent(realRegistry(), "scholar"));
  assert.equal(cap.search.web, true, "the declaration no longer vetoes the knob");
  assert.equal(capSearch(cap, { web: true }).web, true, "knob on → the leg runs");
  assert.equal(capSearch(cap, { web: false }).web, false, "knob off → it does not");
  // The auxiliary half is untouched: the literature legs are what it leads with.
  assert.equal(cap.search.auxSources, true);
  // And it stays the terminal fallback, reachable by any caller.
  assert.deepEqual(cap.requires, []);
});

test("a self-declared `requires: []` cannot buy a privileged selection", () => {
  // THE escalation this stage exists to close. The routing gate checks what a
  // spec claims to need; a spec is data, and hostile data claims to need
  // nothing. Requirements are derived from the SELECTION, so lying is inert.
  const liar = {
    id: "liar",
    name: "Liar",
    platform: "server",
    controls: [{ type: "prompt-input" }],
    capability: {
      answerPhase: "build",
      tools: ["build-publish"],
      toolFallback: "file-blocks",
      requires: [], // "I need nothing"
    },
  };
  assert.deepEqual(validateAgentSpec(liar), [], "it is structurally valid — that is the point");
  assert.deepEqual(requirementsFor(liar), ["developer_mode"], "…but its selection says otherwise");
  const denied = resolveUntrustedAgent(liar, {});
  assert.equal(denied.agent, null);
  assert.match(denied.problems[0], /requires "developer_mode"/);
  // With the knob genuinely granted, the same spec resolves.
  assert.equal(resolveUntrustedAgent(liar, { developer_mode: true }).agent.id, "liar");
});

test("an untrusted spec that fails ANY rule is refused whole, not in part", () => {
  const ok = {
    id: "probe",
    name: "Probe",
    platform: "server",
    controls: [{ type: "prompt-input" }],
    capability: { answerPhase: "research" },
  };
  assert.equal(resolveUntrustedAgent(ok, {}).agent.id, "probe");
  // One broken field at a time — each must yield a null agent AND a reason.
  const broken = [
    ["a phase outside the vocabulary", { capability: { answerPhase: "exfiltrate" } }],
    ["a tool class outside the vocabulary", { capability: { answerPhase: "research", tools: ["rm-rf"], toolFallback: "read-loop" } }],
    ["a context block outside the vocabulary", { capability: { answerPhase: "research", context: ["/etc/passwd"] } }],
    ["an event outside the vocabulary", { capability: { answerPhase: "research", emits: ["exfil"] } }],
    ["a requirement outside the vocabulary", { capability: { answerPhase: "research", requires: ["root"] } }],
    ["a gate outside the vocabulary", { capability: { answerPhase: "research", gates: [{ id: "backdoor", langs: ["en", "sv"] }] } }],
    ["a bound outside the vocabulary", { capability: { answerPhase: "research", bounds: { maxSpend: 5 } } }],
    ["a non-slug id", { id: "../../etc/passwd" }],
    ["a platform outside the vocabulary", { platform: "root" }],
    ["a mode that is not a chat mode", { mode: "godmode" }],
    ["a control outside the vocabulary", { controls: [{ type: "shell-input" }] }],
  ];
  for (const [why, over] of broken) {
    const hit = resolveUntrustedAgent({ ...ok, ...over }, { developer_mode: true, sandbox: true });
    assert.equal(hit.agent, null, `refused: ${why}`);
    assert.equal(hit.capability, null, `no partial capability: ${why}`);
    assert.ok(hit.problems.length, `says why: ${why}`);
  }
});

test("an untrusted spec cannot move a planning phase off the fixed JSON model (inv. 3)", () => {
  const spec = {
    id: "hijack", name: "Hijack", platform: "server", controls: [{ type: "prompt-input" }],
    capability: { answerPhase: "research", routing: { planModel: "user", answerModel: "user" } },
  };
  const hit = resolveUntrustedAgent(spec, { developer_mode: true });
  assert.equal(hit.agent, null);
  assert.ok(hit.problems.some((p) => p.includes("invariant 3")));
});

test("an untrusted client-tier spec cannot put the server in the data path (inv. 4)", () => {
  // The privacy split as a request-path refusal rather than a build-time one.
  const spec = {
    id: "leak", name: "Leak", platform: "client", controls: [{ type: "prompt-input" }],
    capability: { answerPhase: "feed", context: ["outward-feed"] },
  };
  const hit = resolveUntrustedAgent(spec, { developer_mode: true });
  assert.equal(hit.agent, null);
  assert.ok(hit.problems.some((p) => p.includes("invariant 4")));
});

test("an untrusted tool-bearing spec must still work without native tool use (inv. 1)", () => {
  const spec = {
    id: "toolsonly", name: "Tools Only", platform: "server", controls: [{ type: "prompt-input" }],
    capability: { answerPhase: "source-research", tools: ["source-read"], toolFallback: "none" },
  };
  const hit = resolveUntrustedAgent(spec, { developer_mode: true });
  assert.equal(hit.agent, null);
  assert.ok(hit.problems.some((p) => p.includes("every mode must work on models without native tool use")));
});

test("an untrusted spec's gate must route Swedish and English alike (inv. 6)", () => {
  const spec = {
    id: "enonly", name: "EN Only", platform: "server", controls: [{ type: "prompt-input" }],
    capability: { answerPhase: "research", gates: [{ id: "quiz", langs: ["en"] }] },
  };
  const hit = resolveUntrustedAgent(spec, { developer_mode: true });
  assert.equal(hit.agent, null);
  assert.ok(hit.problems.some((p) => p.includes("invariant 6")));
});

test("junk in place of a spec is refused without throwing", () => {
  for (const junk of [null, undefined, "", "agent", 7, true, [], [{ id: "x" }], () => {}]) {
    const hit = resolveUntrustedAgent(junk, { developer_mode: true });
    assert.equal(hit.agent, null, `refused: ${JSON.stringify(junk) ?? String(junk)}`);
    assert.ok(hit.problems.length);
  }
});

test("a resolved untrusted spec is still bounded by the narrowing accessors", () => {
  // Belt and braces: even a spec that validates cannot ask for MORE than the
  // platform does. Validation says the declaration is well-formed; capBound and
  // capSearch say it cannot exceed the code's own limits.
  const greedy = {
    id: "greedy", name: "Greedy", platform: "server", controls: [{ type: "prompt-input" }],
    capability: { answerPhase: "research", bounds: { maxRounds: 100000 }, search: { maxQueries: 100000 } },
  };
  const hit = resolveUntrustedAgent(greedy, { developer_mode: true });
  assert.equal(hit.agent.id, "greedy", "it validates — a large number is not malformed");
  assert.equal(capSearch(hit.capability, { maxQueries: 6 }).maxQueries, 6, "the request's ceiling still wins");
});
