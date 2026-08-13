---
name: orchestrator-mode
description: Load when working on ORCHESTRATOR MODE — the violet entry in the chat-mode dropdown (Deep Science / Cyber / Introspection / Agent Studio / Orchestrator / Outrospection / Models) that runs a request as a planned team of SUB-AGENTS working in the background, with the workflow shown live — or when touching src/orchestrator.js (runOrchestration), public/js/orchestrator-core.js (the plan schema/waves/prompts pure core), public/js/workflow-viz.js (the sub-agent graph view), public/js/graph-backdrop.js / mode-backdrop.js (the rotating wireframe workflow-graph BACKGROUND and the backdrop-axis dispatch), the orchestrator_mode chat field, the workflow/agent_update SSE events, or the orch-mode violet theme. Also load when extending the sub-agent KIND vocabulary, adding a new agent-BACKDROP kind (mode-theme.js backdrop axis / AgentSpec backdrop field), or debugging a workflow that planned badly, hung, or lost nodes.
---

# Orchestrator mode — sub-agents in the background (2026-07-24)

The fourth chat mode to ship: the user's request is decomposed by a JSON PLAN
phase into a small team of sub-agents — each a **web research** node (planned
Exa queries + a sourced brief), an Introspection node (retrieved own-source
excerpts), a `swarm` node, or a fully custom specialist (persona +
instructions) — executed
by the Worker in parallel waves, then merged into one streamed answer. The
workflow itself is a first-class UI element: a live graph of the team.

## Invariants (do not "fix" these)

- **Invariant 1 holds — NO function calling.** The plan phase is ONE
  JSON-mode call on the fixed `jsonModel` (invariant 3, like triage); the
  workflow it returns is DATA (`normalizeWorkflow` salvages sloppy JSON,
  `fallbackPlan` degrades to a single-agent team). The executor is plain
  code: `workflowWaves` → `Promise.all` per wave. No model ever decides
  control flow mid-run, so the mode works on any catalog model.
- **Invariant 2 — every node fails soft.** A failed/timed-out node
  (`ORCH_NODE_TIMEOUT_MS`) becomes an honest gap note in the merge input
  (`mergeAgentResults`); the answer still streams. Only the final merge can
  fail the chat, like any synthesis.
- **Split routing/billing (invariant 3):** plan on `jsonModel`
  (`jsonTotals`); every node and the merge on the user's chosen model via
  buffered `streamCompletion` (retry/failover included) into `totals`.
- **Capability gate:** `orchestrator_mode: true` is honored only with the
  modes available to the caller (`chat.js`, same gate as sdk mode; sdk wins if
  both arrive). Picking the mode in either dropdown flips the knob.

## The pieces

- `public/js/orchestrator-core.js` — the shared PURE core (Node-tested):
  `AGENT_KINDS` (closed vocabulary — `web_research` (renamed from
  `deep_research` on 2026-08-13, when the general agent whose name it had
  borrowed was retired; the role was always the specific one — search the open
  web, write a sourced brief), `introspection`
  (`needsSource`, downgraded to custom without a snapshot), `swarm`
  (`needsSwarm`, downgraded the same way without a swarm-capable browser),
  `custom`),
  `validateWorkflow`/`normalizeWorkflow` (never-throw; slugs ids, breaks
  cycles, caps at `MAX_AGENTS`=6 / `MAX_WAVES`=3), `workflowWaves`,
  `orchestratorPlanPrompt` (EN+SV: "svara på svenska…"), `agentTaskPrompt`,
  `mergeAgentResults`, and the `workflow`/`agentUpdateEvent` SSE shapes.
- `src/orchestrator.js` — the executor: plan → waves → merge. `web_research`
  nodes run their PLANNED queries (`agent.queries`, decided by the plan
  phase — no per-node model call) through the same Exa path/events/source
  registry as the pipeline under `MAX_ORCH_SEARCHES`; introspection nodes
  call `retrieveSourceBlockFor` (src/introspect.js); node briefs never
  stream — only the merge does (`orchSynthPrompt`, citations only from the
  shared source digest). Emits `agent_<id>` step events too, so clients
  without the workflow view still narrate the run.
- Client: `workflow-viz.js` (pure layout + SVG string, DOM mount into the
  turn body; embeds-registry kind `"workflow"` with live-updated `statuses`;
  replayed by turns.js, `embedRef` in message-content.js, compacted in
  activity-core.js), stream.js `handleEvent` branches, the `orch-mode`
  violet theme (mode-theme.js descriptor, chat-mode.js class, app.css
  palette/pane/tag/waves, ORCH_SPINNER balloon recolour in mode-spinner.js,
  `--check-violet`), both dropdowns, deeplink aliases
  (`orchestrator|orchestrate|orch|workflow`).
- **The node INSPECTOR — tap a node to see inside it** (2026-07-26, feedback
  #35). The graph is the only place a sub-agent is visible, and a box cannot
  hold a whole sub-run, so every node is a button: tapping one opens a panel
  under the graph with that node's task, persona, searches, upstream/downstream
  links (themselves buttons — walking the team is the point), and the PROMPT it
  is working on. Tap it again to close; tap another to switch. It is LIVE — the
  open panel repaints on every update while the answer is still streaming, and
  `nodeActivity` turns the stored facts into the sentence it leads with
  ("Searching the web — 1 query still running", "Writing its brief from the
  prompt below"). Three things feed it, all additive and forward-compatible:
  `persona`/`queries` on the `workflow` event, a second `running`
  `agent_update` carrying `prompt` + `prompt_chars` (emitted in
  `runAgentNode` once the node's grounding is assembled), and `agent` on the
  per-node `search_start`/`search_done` events. Pure and Node-tested:
  `inspectorModel`, `inspectorHtml`, `nodeActivity`, `mergeSearch` and
  `nodeRenderState`; the DOM side is delegation on the box (click + Enter/Space,
  the nodes are `role="button" tabindex="0"`). Everything it stores is BOUNDED
  for the same reason the swarm strip is — `statuses` is persisted with the
  turn.
- **The `swarm` kind — the one node that runs OUTSIDE the server**
  (2026-07-25, `docs/SWARM-REASONING.md`): N tiny Bonsai models reasoning at
  once in the user's browser (`public/js/swarm-core.js` = the algorithm:
  diverge → ring critique → deterministic converge with a measured agreement
  score; `swarm-runtime.js` = the worker pool over `ondevice-engine.js`
  `spawnSwarmMember`). Because a streamed request has no channel back to the
  page, an orchestrator send from a swarm-capable device is TWO calls: the
  client asks `POST /api/orchestrator/plan` (`src/orchestrator-api.js` — the
  same JSON phase on the same fixed model), runs the swarm nodes locally
  (`stream.js maybeRunSwarmPrepass`, the sandbox pre-pass's shape), then sends
  `/api/chat` with `workflow` + `swarm_results`. The executor skips its plan
  phase, seeds those nodes done, and runs the rest. Swarm nodes are FIRST-WAVE
  by construction (they predate the request) — `normalizeWorkflow` drops any
  dep the plan invents; other nodes may depend on them. Nothing is trusted: the
  plan re-normalizes and `resolveSwarmResults` clamps the briefs. A swarm node
  that arrives without a brief runs server-side as a `custom` specialist.
- Meta: chat_logs rows carry `orchestrator: 1` +
  `orchestration: {agents, waves, failed, searches}` — grep these when
  debugging (the chat-logs skill).
- **When a run dies, look in THREE places (2026-07-26, feedback #26).** A
  fail-soft node used to leave only a `ctx.log.warn` in Workers Logs and a
  bare `failed: N`, so "orchestrator crashed" was unanswerable after the fact.
  Now: (1) `orchestration.failures` in the chat_logs row —
  `{id, kind, wave, class, ms, note}` per node, capped at
  `MAX_LOGGED_FAILURES`; (2) `scripts/errors --q _subsystem/orchestrator` —
  the durable, deduped fix-queue row (`recordSubsystemFailure`), which is the
  ONLY trace that survives if the run dies before chat.js writes its row;
  (3) the `agent_update` note, now prefixed with the failure class
  (`timeout: …`), so the graph says what happened. The classes are
  `classifyFailure`'s closed set in src/server-errors.js.
  **A run that leaves NOTHING anywhere did not die on the server** — check
  `orch.plan` in Workers Logs with no matching `chat.complete`: that pattern
  means the two-call swarm flow planned, and the BROWSER died before
  `/api/chat` was ever sent (the on-device model pool is the memory-hungriest
  thing this product does).
- **The graph backdrop** (`public/js/graph-backdrop.js`): Orchestrator's
  AGENT BACKGROUND — a hovering, slowly rotating wireframe directed graph
  behind the chat (root baton star + one wireframe symbol per sub-agent:
  balloon blue = web_research, TIN slate = introspection, violet diamond =
  custom), fed the live team by stream.js and showing per-node status
  (pulse/✓/✕). Built solely on `space-core.js`'s rotY/projectPoint — add no
  dependencies. It is the "graph" value of the generalized `backdrop` axis
  (mode-theme.js + the AgentSpec `backdrop` field, `BACKDROP_KINDS` =
  none/terminal/graph); `mode-backdrop.js` is the dispatch, the sandbox
  terminal layer (`agent-backdrop.js`) is the "terminal" implementation.
  Reduced motion → one static frame; hidden tab → the loop skips drawing.
  **Since 2026-07-26 `mode-backdrop.js` does NOT mount it directly.** This mode
  has BOTH backgrounds available, and the header terminal icon `#termbtn` owns
  the choice between every combination — a five-state cycle (both → terminal
  forward → terminal only → graph only → neither), so a user can keep the graph
  without the shell chatter or the other way round. The dispatch registers the
  graph's `{show, hide}` pair with `agent-backdrop.js` `setGraphLayer` and the
  view state decides; a non-graph mode registers `null`, which tears the canvas
  down. The hook exists because `graph-backdrop.js` is not in the public asset
  allowlist and `agent-backdrop.js` is — a direct import there would 401 the
  whole Se/cure module graph. Full cycle table: the **execution-sandbox** skill;
  the interaction rule is **UX-2** (and **UX-18** for why a tap never no-ops).

## Editing rules

- The kind vocabulary is CLOSED like the AgentSpec control types: adding a
  kind means core registry entry + executor branch + (if source-dependent)
  the `needsSource` downgrade + tests. The plan prompt lists kinds from the
  registry automatically.
- The boot-script/theme checklist applies to any theming change: editing the
  `<script data-devtheme>` in index.html requires recomputing
  `THEME_BOOT_HASH` (src/security-headers.js — command in its comment).
- Se/cure (DRC) is deliberately NOT wired: /cure has no mode dropdown
  (modes were never generalized there). Porting means generalizing DRC's
  boolean developerMode into a mode field first — Se/rver's own collapse to
  `chat_mode` (2026-07-26) is the worked example of that move.

## Verification

- Unit: `orchestrator-core.test.js` (plan salvage, waves, cycle-break,
  prompts, event shapes incl. the inspector's persona/queries/prompt fields,
  the swarm kind's downgrade/dep rules),
  `workflow-viz.test.js` (layout, SVG, XSS, the swarm member strip, and the
  inspector: model assembly, the activity sentence per stage, escaped HTML,
  the bounded `nodeRenderState`/`mergeSearch` folds, selection markup),
  `swarm-core.test.js` (the algorithm — scoring, the EN+SV agreement metric,
  the stop condition), `swarm-runtime.test.js` (the loop against a FAKE
  member — `spawn` is injected for exactly this), `orchestrator-api.test.js`,
  mode/deeplink suites.
- STILL OWED for the SWARM: a device with cached Bonsai weights — member dots
  animating, the agreement readout moving, `orchestration.swarm` in the
  chat log, a Swedish run, and a knob-off device getting no swarm kind at all.
- STILL OWED (live-verify discipline): a real Orchestrator round trip on the
  deployed site — pick Orchestrator (violet pane + `orchestrator` tag), ask a
  decomposable question, confirm the plan step lists the team, the workflow
  graph renders and nodes flip running→done, TAPPING a node opens its inspector
  mid-run and the prompt/searches fill in live (and a reopened conversation
  still opens its nodes), searches show per node, the
  merged answer cites [n], the reopened conversation replays the graph, and
  a chat_logs row carries `orchestrator: 1`. Also a Swedish request (plan
  names/tasks in Swedish) and a web-search-off run (nodes degrade to custom).
