---
name: orchestrator-mode
description: Load when working on ORCHESTRATOR MODE — the violet entry in the chat-mode dropdown (Deep Research / Introspection / Agent Studio / Orchestrator) that runs a request as a planned team of SUB-AGENTS working in the background, with the workflow shown live — or when touching src/orchestrator.js (runOrchestration), public/js/orchestrator-core.js (the plan schema/waves/prompts pure core), public/js/workflow-viz.js (the sub-agent graph view), the orchestrator_mode chat field, the workflow/agent_update SSE events, or the orch-mode violet theme. Also load when extending the sub-agent KIND vocabulary or debugging a workflow that planned badly, hung, or lost nodes.
---

# Orchestrator mode — sub-agents in the background (2026-07-24)

The fourth chat mode: the user's request is decomposed by a JSON PLAN phase
into a small team of sub-agents — each a Deep Research node (planned Exa
queries + a sourced brief), an Introspection node (retrieved own-source
excerpts), or a fully custom specialist (persona + instructions) — executed
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
  `developer_mode` knob on (`chat.js`, same gate as `sdk_mode`; sdk wins if
  both arrive). Picking the mode in either dropdown flips the knob.

## The pieces

- `public/js/orchestrator-core.js` — the shared PURE core (Node-tested):
  `AGENT_KINDS` (closed vocabulary — `deep_research`, `introspection`
  (`needsSource`, downgraded to custom without a snapshot), `custom`),
  `validateWorkflow`/`normalizeWorkflow` (never-throw; slugs ids, breaks
  cycles, caps at `MAX_AGENTS`=6 / `MAX_WAVES`=3), `workflowWaves`,
  `orchestratorPlanPrompt` (EN+SV: "svara på svenska…"), `agentTaskPrompt`,
  `mergeAgentResults`, and the `workflow`/`agentUpdateEvent` SSE shapes.
- `src/orchestrator.js` — the executor: plan → waves → merge. deep_research
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
- Meta: chat_logs rows carry `orchestrator: 1` +
  `orchestration: {agents, waves, failed, searches}` — grep these when
  debugging (the chat-logs skill).

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
  boolean developerMode into a mode field first.

## Verification

- Unit: `orchestrator-core.test.js` (plan salvage, waves, cycle-break,
  prompts, event shapes), `workflow-viz.test.js` (layout, SVG, XSS),
  mode/deeplink suites.
- STILL OWED (live-verify discipline): a real Orchestrator round trip on the
  deployed site — pick Orchestrator (violet pane + `orchestrator` tag), ask a
  decomposable question, confirm the plan step lists the team, the workflow
  graph renders and nodes flip running→done, searches show per node, the
  merged answer cites [n], the reopened conversation replays the graph, and
  a chat_logs row carries `orchestrator: 1`. Also a Swedish request (plan
  names/tasks in Swedish) and a web-search-off run (nodes degrade to custom).
