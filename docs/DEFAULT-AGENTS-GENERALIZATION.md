# Generalizing the default agents into the Agents SDK

**Status: Stages 0–3 SHIPPED plus the prompts axis, 2026-07-25 (owner go-ahead
in-session). Stage 4 is not built.** This page began as an investigation of what this site's built-in
agents actually are, a measurement of how much of that the DeepResearch Agents
SDK could express, and a staged plan for closing the distance. §1–§3 record the
findings as they stood before the work; §5 marks what landed. The gap those
sections describe is the reason for the capability layer, not a description of
today's registry — for that, read [`docs/AGENT-PLATFORM.md`](./AGENT-PLATFORM.md)
§3.1 and §4.

The premise in the request is right, and worth stating as the thesis:

> The closer the SDK's agent definition sits to the agents we ship by default,
> the more capable anything built through Agent Studio can be.

The distance was large, and large in a specific, measurable way: the SDK could
describe how an agent *looks*, and the platform decided how an agent *works*.
Everything below follows from that split.

---

## 1. What "our default agents" are today

There is no single place where a default agent is defined. There are three
registries, and they do not know about each other.

### Registry A — `sdk/AGENTS.json` (the Agents SDK)

Four specs: `research`, `secure`, `under-construction`, `agent-builder`.
Resolved by the pure core [`public/js/agent-spec-core.js`](../public/js/agent-spec-core.js)
(façade [`src/agent-spec.js`](../src/agent-spec.js), re-exported by
`sdk/pair-cli.mjs`). A spec carries: `controls` (closed vocabulary of seven
types), `theme`, `intro`, `loading`, `backdrop`, `examples`, `quota`,
`platform`, `mode`, `derivesFrom`.

Consumers, in full: the preview page
([`public/js/agent-preview.js`](../public/js/agent-preview.js)), the visual proof
(`scripts/agent-proof.mjs` / `proveComposer`), the share-link mint
([`src/agent-link.js`](../src/agent-link.js)), and the CLI's `agents` / `agent`
commands. That is the whole surface. **No spec in this registry influences a
single request through `/api/chat`.**

### Registry B — `public/js/mode-theme.js` + `public/js/chat-mode.js`

Five modes: `normal` (Deep Research), `introspection`, `sdk` (Agent Studio),
`orchestrator`, `outrospection`. `MODE_THEMES` declares accent, status-bar tint,
check colour, spinner, character, side panel, backdrop, depth-slider
applicability, symbol, blurb. `CHAT_MODES` declares the dropdown and which
request flag each mode sets.

This registry overlaps Registry A on three axes (theme, backdrop, controls-ish)
and disagrees with it on the identity set. It is the one the running app reads.

### Registry C — the code (the real definition)

What a default agent actually *is* lives spread across the Worker. Taking
Orchestrator mode as the worked example, its definition is:

| Piece | Where |
|---|---|
| request flag + capability gate + precedence | `src/chat.js` (`orchestrator_mode`, gated on `developerOn`, ordered after `sdkOn`) |
| answer-phase dispatch | `src/pipeline.js` — `if (state.orchestratorMode) return runOrchestration(ctx)` |
| executor, bounds, wave concurrency | `src/orchestrator.js` (`ORCH_NODE_MAX_TOKENS`, `ORCH_NODE_TIMEOUT_MS`) |
| plan schema, sub-agent vocabulary, caps | `public/js/orchestrator-core.js` (`AGENT_KINDS`, `MAX_AGENTS`, `MAX_WAVES`, `MAX_ORCH_SEARCHES`) |
| prompts | `src/prompts.js` (`orchAgentPrompt`, `orchSynthPrompt`) + core (`orchestratorPlanPrompt`) |
| SSE events | `workflow`, `agent_update` |
| visuals | `mode-theme.js` (violet, `graph` backdrop), `mode-spinner.js` (`ORCH_SPINNER`), `public/css/app.css` |
| chat-log column | `src/chatlog.js` / `src/chat.js` |

A grep for one mode id (`outrospection`) hits **14 non-test files** across
`src/` and `public/`. Adding a sixth default agent today means writing code in
roughly that many places. That is the cost the SDK exists to remove, and does
not yet remove.

---

## 2. The measured gap

Every axis below is something that demonstrably distinguishes one shipped
default agent from another in the source. The right-hand column is whether
`validateAgentSpec` / `composerModel` can express it.

| Capability axis | Evidence in the code | In AgentSpec? |
|---|---|---|
| Which function takes the answer phase | `runSdkBuild` / `runOrchestration` / `runOutrospection` / `runSourceResearch` / triage→search→synth | **no** |
| System prompt / persona | `sdkBuildPrompt`, `sourceToolAgentPrompt`, `orchAgentPrompt`, `synthPrompt`, … (20 exported prompt builders) | **no** |
| Tool set | `INTROSPECTION_TOOLS`, `SDK_TOOLS`, `BUILD_TOOLS`, bash-lite; `sdkBuildTools(snapshot)` composes them | **no** |
| No-tool fallback convention | source read loop vs `FILE:`-block parsing (`parseFileBlocks`) | **no** |
| Injected context blocks | `sourceSnapshot`, `helpBlock`, `owaspBlock`, `secureDigest`, `shellBlock`, outward feed | **no** |
| Search policy | `state.webSearch`, `SEARCH_SOURCES`, `MAX_NODE_QUERIES`, `MAX_ORCH_SEARCHES` | **no** |
| Model routing | split `jsonModel` (plan/triage/gap/validate) vs `model` (answer) — invariant 3 | **no** |
| Deterministic intent gates | `externalSourceIntent`, `quizIntent`, `feedbackIntent`, `lensMatch` — all EN+SV | **no** |
| Capability gating + precedence | `developerOn`; `sdk` beats `orchestrator` beats `outrospection` | **no** |
| SSE event vocabulary | `workflow`, `agent_update`, `build`, `quiz` on top of `step`/`stepDone` | **no** |
| Bounds | `MAX_SOURCE_TOOL_ROUNDS` 6, `MAX_SDK_TOOL_ROUNDS` 12, `SDK_BUILD_ROUND_TIMEOUT_MS` 240 s, … | **no** |
| Deliverable / side effect | published `/app/<slug>/`, minted token, chat-log row | partial (`quota` only) |
| Sub-agent composition | `AGENT_KINDS` = `deep_research` / `introspection` / `custom` | **no** |
| Composer controls, theme, animations, backdrop, examples, share quota | `agent-spec-core.js` | **yes** |

One row out of fourteen. The SDK owns the composer; the platform owns the agent.

### The consequence for Agent Studio

Agent Studio's deliverable is a set of static files published to `/app/<slug>/`
under an opaque-origin CSP sandbox ([`src/build-pub.js`](../src/build-pub.js)):
no cookies, no origin-bound storage, no credentialed same-origin fetch. The
build prompt tells the model so explicitly — plain static HTML/CSS/JS, no CDNs,
in-memory state, and the user pastes their own provider key at runtime.

So the ceiling on "an agent built through Agent Studio" is currently **a static
single-page app that reimplements a slice of Se/cure from scratch**. It cannot
reach the pipeline, the tool loop, the source snapshot, the sub-agent executor,
or the retrieval layers — the parts that make the default agents worth anything.
Raising that ceiling is the whole point of this work — and it is the part Stage
4 addresses, which is not built.

---

## 3. Drift found along the way

These were defects, not design questions. All five are fixed (Stage 0/1); they
are kept here because each one names a rule that now exists to prevent it.

1. **Mode ids disagree.** `sdk/AGENTS.json` uses `"mode": "agent-builder"` and
   `mode-select` offers `["normal","introspection","agent-builder"]`. The real
   mode ids (`chat-mode.js` `CHAT_MODES`, `mode-theme.js` `CHAT_MODE_IDS`) are
   `normal`, `introspection`, `sdk`, `orchestrator`, `outrospection`. Nothing
   validates the `mode` field against them, so the drift is silent.
2. **Two of five default agents are missing entirely.** `introspection`,
   `orchestrator` and `outrospection` have no AgentSpec — three of the five, in
   fact. `docs/ARCHITECTURE.md` §15 already names this for the last two.
3. **A stale header comment.** `mode-theme.js` opens with "three chat MODES …
   (Deep Research / Introspection / SDK)" while `CHAT_MODE_IDS` below it lists
   five.
4. **Two incompatible senses of "agent".** `orchestrator-core.js`'s
   `AGENT_KINDS` is a closed three-value vocabulary that cannot name an entry in
   `sdk/AGENTS.json`, and vice versa. An orchestrated team cannot include an
   agent the SDK defines.
5. **The skill and the doc both say "four agents we ship"**
   (`sdk/skills/agent-platform/SKILL.md`, `docs/AGENT-PLATFORM.md` §2) while the
   dropdown ships five modes. The count is right for the registry and wrong for
   the product.

---

## 4. The proposal — a capability layer on the AgentSpec

### The design constraint that makes this safe

The capability block is a **selector over code that already ships**, never a
place to define new behaviour. A spec picks from closed vocabularies whose
members each name an existing implementation. That keeps the load-bearing
invariants intact:

- **Invariant 1 (no function calling in the pipeline).** The dispatch stays
  code; the spec is data read *before* the run starts. A spec can select the
  already-authorized tool exception, it cannot introduce a new one.
- **Invariant 2 (helpers fail soft).** Selecting a capability the deployment
  can't serve degrades exactly as today — `normalizeWorkflow` already downgrades
  `introspection` nodes to `custom` when no snapshot is available; that is the
  pattern to generalize.
- **Invariant 3 (split routing).** `routing` is declared, and validation forbids
  moving a JSON planning phase off `DEFAULT_MODEL`.
- **Invariant 4 (the privacy split).** A `platform: "client"` spec is rejected
  at validation if it selects any server-side context or capability. Today that
  boundary is prose in a skill; this makes it a test.
- **Invariant 6 (EN+SV parity).** A declared gate must carry both `en` and `sv`
  term sets, or validation fails. Parity becomes structurally impossible to
  forget rather than a review habit.

### The shape

```jsonc
"capability": {
  "answerPhase": "research",        // research | source-research | build | workflow | feed | direct
  "tools": ["source-read"],         // closed CLASSES: source-read | sdk-plan | build-publish | shell
  "toolFallback": "read-loop",      // read-loop | file-blocks | none
  "context": ["source-snapshot"],   // source-snapshot | docs-corpus | secure-digest
                                    // | shell-transcript | outward-feed | owasp
  "search": { "web": true, "auxSources": true, "maxQueries": 6 },
  "routing": { "planModel": "json-default", "answerModel": "user" },
  "gates": [{ "id": "external-source", "en": ["…"], "sv": ["…"] }],
  "bounds": { "maxRounds": 6, "maxTokens": 2048, "timeoutMs": 150000 },
  "emits": ["step", "workflow", "agent_update"],
  "requires": ["developer_mode"],
  "team": { "kinds": ["research", "introspection"], "maxAgents": 6, "maxWaves": 3 }
}
```

Every vocabulary above is closed, for the same reason the control types are
closed: one dispatcher must be able to draw any agent, and one validator must be
able to reject anything it cannot serve.

`team.kinds` is the compounding piece. It holds **agent ids from the registry**,
not a separate three-value enum — which is how a user-built agent becomes
eligible as a team member.

### Which SDK carries it

The **Agents SDK** owns the capability block: it describes one agent, and both
its home surfaces (Agent Studio, the integrated Linux environment) are the ones
that consume it. The **Platform SDK**'s layer-6 `agent-platform` module gains a
build step for it, and `orchestrator` earns the Platform-SDK module
`docs/ARCHITECTURE.md` §15 already says it owes — the executor is platform
machinery, the team composition is agent data.

---

## 5. Staging — what shipped

Four stages. Each leaves the tree green and shippable; each has an acceptance
test, in the project's habit of making the claim machine-checkable. **Stages
0–3 landed on 2026-07-25**; the per-stage notes below record what each turned
into.

### Stage 0 — fix the drift (no design decisions) — SHIPPED

Correct the `mode` values, add the missing mode ids to `mode-select`, refresh
the stale comment and the "four agents" counts.

*Accept:* a unit test asserts every AgentSpec `mode` is in `CHAT_MODE_IDS`, and
every `mode-select` entry likewise. **Done** — `validateAgentSpec` now rejects
both, importing `CHAT_MODE_IDS` from `mode-theme.js` rather than restating it,
so the two registries cannot drift again.

### Stage 1 — five real specs, zero behaviour change — SHIPPED

Add `introspection`, `orchestrator` and `outrospection` to `sdk/AGENTS.json`
with the theme, backdrop, spinner and depth-slider values they already have in
`mode-theme.js`. Derive or cross-check `MODE_THEMES` against the registry so the
two can never diverge again.

*Accept:* a parity test pins `MODE_THEMES[id]` against the spec for all five;
`scripts/agent-proof.mjs` renders seven composers instead of four. **Done** —
the parity test covers backdrop and depth-slider presence, the two axes that are
genuinely the same fact in both registries. Colour is deliberately not pinned:
the mode accents and the spec themes serve different surfaces (the running app
versus the preview gallery), and forcing them equal would have changed shipped
visuals for no gain.

### Stage 2 — the capability block, declared but not yet authoritative — SHIPPED

Add `capability` to the schema, `validateAgentSpec`, and all five specs, filled
in to describe what the code *already does*. The pipeline keeps its `if`
branches. A test asserts the declaration matches the constants it describes
(`bounds.maxRounds` equals `MAX_SOURCE_TOOL_ROUNDS`, and so on).

*Accept:* declaration-vs-implementation test green; `node sdk/pair-cli.mjs
validate` covers capability; the invariant-4 and invariant-6 validation rules
have failing-case tests. **Done, and the vocabulary held.** All fourteen axes
from §2 are expressible; four constants had to be exported from `src/pipeline.js`
so the declared bounds could be pinned against the code that enforces them.
Invariants 1, 3, 4 and 6 each got a passing and a failing case. Two adjustments
fell out of writing it:

- The sketch in §4 had gates carrying their own `en`/`sv` term lists, which
  would have hand-mirrored the real term sets. A gate now declares an id from a
  closed vocabulary plus `langs`, so parity is asserted without duplicating what
  the gate actually matches.
- `search.web` stayed a plain boolean. Introspection's web search is *gated*
  rather than off, but adding a third value to model that would have put a
  conditional in the data; the declared `external-source` gate carries the
  meaning instead.

### Stage 3 — the pipeline reads the registry — SHIPPED

Replace the mode branches in `src/pipeline.js` with `resolveAgent(state)` and a
dispatch table keyed on `capability.answerPhase`. `src/chat.js`'s flag/gate
handling becomes a loop over `capability.requires` and the registry's precedence
order. The five default agents become five rows of data; a sixth is data too.

*Accept:* the `outrospection` grep drops from 14 files to roughly 4, and a
synthetic sixth agent added only to `AGENTS.json` routes correctly with no code
change — that last one is the acceptance test that actually proves the
generalization.

**Write the safety net first.** There was no test anywhere asserting that
`sdk_mode` / `orchestrator_mode` / `outrospection_mode` route to the right
answer phase — a `grep` for those flags across every `*.test.js` hit only
`src/prompts.test.js`. So Stage 3 opened with characterization tests over the
`if` branches, written against the behaviour they already had.

**How it landed, and the two limits it kept.** `src/chat.js` resolves the
request through `resolveRequestAgent`; `src/pipeline.js` dispatches through
`ANSWER_PHASE_RUNNERS`, a table of the three executor phases. Two deliberate
limits, both narrower than the stage as originally written:

- **Only the executor phases route by registry.** Whether a knob-on request is
  introspection or plain research is still the pipeline's `hasSource` +
  `externalSourceIntent` gate, because that is a per-*message* decision and the
  routing table is per-*request*. Collapsing the two would have changed
  behaviour, not just its shape.
- **The registry stays off the hot path.** It ships inside the multi-megabyte
  source snapshot, so `routingNeedsRegistry` skips loading it for any request
  that can only resolve to `normal` — which is most of them. The plain Deep
  Research turn pays nothing.

The three mode booleans survive as the fail-soft fallback for a deployment whose
registry cannot be read, and for the MCP channel, which builds its state without
them. The `outrospection` grep is 15 files rather than the ~4 predicted: the
routing collapsed, but the mode's theme, spinner, feed page and admin surface
are genuinely its own and were never routing.

### Stage 4 — Agent Studio ships capability, not just files — NOT BUILT

Three unlocks, in value order:

1. **A published agent runs on a minted token.** `agentLinkPlan` already derives
   the `api` / `web` permissions and quota from a spec, and
   `mintServerTokenGrant` already signs and meters them. Wiring that token into
   the published `/app/<slug>/` page means a built agent works on first click
   instead of demanding the visitor's own key. This is the single biggest jump
   in perceived capability and it needs **no new crypto and no new meter** — it
   reuses the Se/rver-token subsystem verbatim, so the guarantee (upstream API
   only, never a login, never Se/rver's stored data, revocable, fail-safe)
   carries over unchanged.
2. **Publishing a spec becomes a first-class deliverable.** Add `agent_write` /
   `agent_publish` alongside `write_file` / `publish_app`. "Build me a Swedish
   legal-research agent with web search off and a source-read tool" then
   produces an AgentSpec that the real platform runs — not a static page that
   reimplements a fraction of it.
3. **Built agents become team members.** With `team.kinds` holding registry ids,
   an orchestrated workflow can include an agent a user built ten minutes ago.
   That is where the SDK stops being a description of the product and starts
   compounding it.

*Accept:* an agent published as a spec answers a live request end to end on its
minted token; the quota-grant invariant checklist (**quota-grant-assessment**
skill) passes against it, with the "a token is never a login" assertions pinned
as they are elsewhere.

---

## 6. Risks, and what not to do

- **Do not let the capability block become a scripting language.** The moment a
  spec can express control flow rather than select it, invariant 1 is gone and
  the pipeline stops being deterministic across the catalog. Closed
  vocabularies, validated, no exceptions.
- **Do not let a client-tier spec select server context.** This is the one
  validation rule worth writing before anything else in Stage 2; it is the
  privacy split expressed as a test rather than as prose in a skill.
- **Stage 3 is the risky one.** It rewrites the dispatch every request goes
  through. It should land as its own PR, behind the existing mode tests, with a
  live probe per mode afterwards (**live-verify**) — the project's real bugs
  come from live behaviour, not unit tests.
- **Stage 4.1 is metering-sensitive.** A published page that spends on a minted
  token is money. Fail-safe, not fail-soft: no meter backend means no spend
  (PA-9), and the assessment checklist runs before it ships.
- **Do not widen the deliverable beyond the token's permissions.** The
  server-token guarantee exists to protect **Se/cure**. A published agent gets
  `api` and `web`, and nothing that reads what Se/rver stores.

---

## 7. Where it stands

Stages 0–3 are in the tree. The thesis is now testable rather than argued: a
sixth agent added only to `sdk/AGENTS.json` routes through `/api/chat` with no
code change, and that is asserted in `agent-capability.test.js` rather than
claimed here.

### The prompts axis (the increment after Stage 3)

Stage 3 generalized the routing and left the *voices* behind: `src/prompts.js`
held a hand-written prompt per mode, and the capability block named tool sets
and context blocks while saying nothing about the prompt that went with them —
so a spec was still an incomplete description of its agent, on exactly the axis
most able to drift unnoticed.

`capability.prompts` closes it. A **prompt set** is a named group covering some
of six closed ROLES (`plan`, `worker`, `answer`, `answer-tools`,
`answer-direct`, `answer-search-off`); `src/prompt-sets.js` binds each (set,
role) pair to the shipped builder, each answer phase declares the roles it
needs, and every phase now reaches its prompt through `phasePrompt(state, phase,
role)` rather than importing one.

Two things this buys beyond tidiness:

- **Prompt set and answer phase became independent.** Running the research phase
  in the source-research voice was not expressible before at any price; it is a
  one-field edit now. The freedom is bounded by validation: a set that cannot
  fill its phase's roles is rejected.
- **The binding is identity-pinned.** `prompt-sets.test.js` asserts each (set,
  role) resolves to the exact builder in `src/prompts.js`, so a renamed or
  re-pointed prompt fails `npm test` instead of a request.

It landed as a no-op by construction: every shipped agent declares the set its
phase already used, which is itself asserted. One existing test had to change —
`pipeline.test.js` grepped the source for a literal `searchOffPrompt({…})` call;
it now pins the ROLE the phase asks for, with the builder identity pinned in the
new suite.

What is still hand-written per mode: the executors themselves, the themes, and
the surfaces (feed page, workflow view, admin columns). Those are genuinely
per-mode work, not routing wearing a disguise.

Stage 4 remains the one that changes what a *built* agent can be, and it is
deliberately not started: it publishes spend-capable links. Its mechanism is
already in place (`agentLinkPlan` → `mintServerTokenGrant`), so the work is
wiring plus the quota-grant assessment, not new crypto. It should land as its
own change with the **quota-grant-assessment** checklist run against it.

## 8. Where this sits

- **Up:** [`docs/AGENT-PLATFORM.md`](./AGENT-PLATFORM.md) (the Agents SDK),
  [`docs/DISTILLSDK.md`](./DISTILLSDK.md) (the Platform SDK).
- **Across:** [`docs/ARCHITECTURE.md`](./ARCHITECTURE.md) §15 (the bespoke
  surfaces that owe an SDK module),
  [`docs/SERVER-TOKENS.md`](./SERVER-TOKENS.md) (Stage 4.1's mechanism),
  [`docs/PRIVACY-MODEL.md`](./PRIVACY-MODEL.md) (what validation must enforce).
- **Down:** [`public/js/agent-spec-core.js`](../public/js/agent-spec-core.js),
  [`public/js/orchestrator-core.js`](../public/js/orchestrator-core.js),
  [`public/js/sdk-core.js`](../public/js/sdk-core.js),
  [`src/pipeline.js`](../src/pipeline.js).
