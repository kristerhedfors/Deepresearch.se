# Generalizing the default agents into the Agents SDK

**Status: Stages 0–3 SHIPPED plus the prompts axis, 2026-07-25. Stages 5–7
SHIPPED 2026-07-26 (§7). Stage 4 — publishing spend-capable agent links — is
still not built, and is the one that needs the quota-grant assessment.** This page began as an investigation of what this site's built-in
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

> This is the shape as **proposed**, kept for the record. Two fields changed on
> contact with the implementation — `gates` carries an id plus `langs` rather
> than its own term lists, and a `prompts` field was added later (§5). The
> shipped shape is [`docs/AGENT-PLATFORM.md`](./AGENT-PLATFORM.md) §3.1.

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

### Declared versus executed — the measurement, 2026-07-26

Stage 2 shipped the capability block "declared but not yet authoritative", and
Stage 3 made *part* of it authoritative. The line between the two halves is
easy to lose, because both halves have passing tests. The difference:

- an **executed** field is read at run start and changes what happens;
- a **declared** field is asserted equal to a hardcoded constant by a test, so
  changing it in a spec fails `npm test` rather than changing behaviour.

When this was written, exactly three values crossed from the registry into a
run — `src/chat.js` put `answerPhase`, `agentId` and `promptSet` on the
pipeline state, and the resolved capability object itself was never carried.
Stages 5–7 below closed that. The table records both columns, because the
distinction is the thing worth remembering: a passing test proves a field is
*accurate*, not that it is *read*.

| Field | Was | Now | Where it lands |
|---|---|---|---|
| `defaults` table + `mode` | executed | executed | `resolveRequestAgent` → `src/chat.js` |
| `capability.answerPhase` | executed | executed | `ANSWER_PHASE_RUNNERS` (`src/pipeline.js`) |
| `capability.prompts` | executed | executed | `phasePrompt` (`src/prompt-sets.js`) |
| `capability.requires` | executed | executed | the knob gate in `resolveRequestAgent`, plus `requirementsFor` for an untrusted spec |
| `quota` | executed | executed | `agentTokenGrantParams` → `src/agent-link.js` |
| `capability.bounds` | declared | **executed** | `capBound` in the tool loops and the orchestrator's per-node caps |
| `capability.tools` | declared | **executed** | `toolsForRun` over `src/tool-sets.js` |
| `capability.search` | declared | **executed** | `searchPolicyFor` → the Exa gate, the aux wave, `takeSearchBatch`, the orchestrator budget |
| `capability.context` | declared | **executed** | `capHasContext` at the enrichment registry (`src/enrichment.js`) and the search-source registry (`src/search-sources.js` `requiresContext` → `sourceAllowed`) |
| `capability.gates`, `emits`, `team` | declared | declared | the gates and caps live in their own modules |
| `theme`, `intro`, `loading`, `backdrop`, `controls` | declared | declared | rendered only by `/agents/preview.html`; the running app draws from `mode-theme.js` |

So the visual half is still not authoritative — `agent-preview.js` renders a
spec's composer, and the real chat pane does not. The registry describes both
halves accurately because tests force it to, not because either half is
generated from it.

#### What moved `capability.context` into the executed column (2026-08-13)

The owner directive that made the roster **specific, with no general member**
is what did it. Once `normal` and its `research` agent were gone and every mode
named a domain, the domains had to be enforced by something, and the only
honest place was the spec that claims them.

The seam is `capHasContext(state.capability, "<block>")`, read at two registries
that already existed:

- **Enrichments** (`src/enrichment.js`). The ancient-sample corpus and the
  Scholar metrics leg were already gated this way; 2026-08-13 added the OWASP
  reference — extracted from inside the introspection enrichment into its own
  module `src/owasp-context.js` — and the *method* half of person research.
  Before the extraction, OWASP hung off `state.introspection`, so **five modes
  reached it as a side effect of carrying the source snapshot while exactly one
  agent declared it**. That mismatch is the clearest single example of why a
  declaration nobody reads is not a boundary.
- **Search sources** (`src/search-sources.js`). A registry entry may now name a
  `requiresContext` block, and `sourceAllowed` in `src/pipeline.js` honours it
  generically — the orchestrator reads the field and never learns which source
  it belongs to, exactly like `intent` and `leadIntent`. That is what makes Deep
  Science the exclusive owner of `literature-arxiv`, `literature-pubmed` and
  `literature-peer-reviewed`, with Palaeogenomics holding `literature-pubmed`
  too because Europe PMC is its only literature leg.

Three consequences worth carrying forward:

- **A corpus belonging to an agent is a fact about the agent.** The previous
  spelling was `state.auxOnly`, a per-request narrowing an enrichment writes;
  handing a corpus to a different agent is now a one-line spec diff rather than
  an edit somewhere in the request path.
- **`routingNeedsRegistry` had to become unconditional.** Skipping the registry
  resolves a null capability, and a null capability is the unrestricted platform
  default — the exact opposite of what the gates are for. The cost is paid by a
  small dedicated registry artifact (`public/introspect/agents.json`) instead of
  the multi-megabyte snapshot.
- **Null and empty mean different things.** A null capability (`POST /mcp`, or a
  registry that will not load) keeps every source, because "no agent was
  resolved" is not "an agent declared nothing" — invariant 2. An agent that
  declares an empty `context` gets none of the gated blocks.

### The three limits Agent Studio actually hits

Framing the remaining work as "Stage 4" understated it. Three separate limits
sat between the registry and a flexible builder, and only the third was what
Stage 4 described. **Limits 1 and 2 are closed** (stages 6 and 7); limit 3
stands, and is the one that needs an owner decision rather than more code.

1. **An agent cannot be addressed.** `resolveRequestAgent` walks the `defaults`
   table and nothing else — a request has no way to name an agent id. So a
   registry entry is reachable only if it also gets a `defaults` row and its own
   request flag, which means a sixth *mode* is data but a sixth *agent* is not.
   The acceptance test in `agent-capability.test.js` proves the mode case, which
   is why the distinction is easy to miss.
2. **A spec cannot be authored at runtime.** `sdk/AGENTS.json` ships inside the
   committed source snapshot and is loaded through the ASSETS binding. There is
   no path by which a spec written during a session becomes resolvable, so
   Agent Studio's `write_file` / `publish_app` produce static bundles under
   `/app/<slug>/` and nothing else. That ceiling is §2's "a static single-page
   app that reimplements a slice of Se/cure".
3. **An agent cannot have its own words.** `capability.prompts` selects one of
   five shipped sets. Persona, domain framing, house style and refusal rules are
   not expressible at any length — the axis a builder reaches for first is the
   one the schema is silent on. This is the inverse of the §2 finding: the
   prompts axis closed the *drift* problem (a spec now names its voice) without
   opening the *authoring* problem.

### Stage 5 — execute what is already declared — SHIPPED (2026-07-26)

The resolved capability is carried on the pipeline state, and the pipeline
reads it. Three narrowing accessors in the pure core do the reading:
`capBound`, `capSearch`, `capHasTool`.

Every one of them takes the platform's own limit as **both the default and the
ceiling**. An absent, malformed or over-large declaration all resolve to
today's value, and no declaration can reach further than the code already
reaches. That asymmetry is not tidiness — it is the entire safety argument for
stage 7, because it means the worst a hostile spec can do is make its own agent
do less work.

- **bounds** — the source tool loop, the build loop and the orchestrator's
  per-node token and wall-clock caps read the agent's declaration, clamped to
  their own constants.
- **tools** — [`src/tool-sets.js`](../src/tool-sets.js), the sibling of
  `prompt-sets.js`, binds each closed class to the array its phase used to
  import. It walks the binding in *registry* order, so two specs naming the same
  classes in different orders get byte-identical tool lists and no spec can
  reorder what a model sees. A class whose deployment need is unmet (the source
  snapshot) is dropped rather than erroring.
- **search** — `searchPolicyFor()` ANDs the agent's declared ceiling with the
  user's knob, narrowing in both directions, and the orchestrator's
  `MAX_ORCH_SEARCHES` now comes from the spec's `maxQueries` — the one search
  field that was genuinely declared-but-unread.

**The regression this nearly shipped, and the rule that came out of it.** A
capability governs the phase it **names**, and no other. Introspection declares
`search.web: false` because its own phase does not search; the research flow is
reached from introspection only when the per-message `externalSourceIntent`
gate hands the turn back *in order to* search. Applying introspection's
declaration there would have silently killed web search for every
developer-mode request. It has its own test.

No-op by construction, and asserted as such: every shipped agent declares
exactly what its phase already did, so routing them all through the accessors
reproduces the previous behaviour. New tests pin that the call sites read the
capability rather than the constant — passing the bare constant again would
un-execute the declaration while every other test stayed green.

### Stage 6 — address an agent by id — SHIPPED (2026-07-26)

`/api/chat` takes an `agent` field naming a registry entry directly.
`resolveRequestAgent` gained an addressing pass ahead of the flagged and
derived rows, applying the same `capability.requires` gate.

An unknown id, a misspelt id and an id the caller may not have all behave
identically: the request falls through to the table it would have got anyway.
So addressing can narrow what answers a request and can never reach a
capability the knobs withhold, and probing for ids reveals nothing.

`direct` became a dispatch target alongside `build`/`workflow`/`feed`. It was
always in the vocabulary and always the research flow's fallback; without a
runner, a spec declaring it would have been quietly answered by the research
pipeline. It has no mode-boolean fallback on purpose — there is no mode to fall
back to.

**The limit kept.** An agent's phase is authoritative only where an executor
exists. One declaring `research` or `source-research` still resolves to null,
because which of those a knob-on turn runs is the per-*message* `hasSource` +
`externalSourceIntent` decision and a per-*request* declaration must not
pre-empt it. The agent still governs that turn through its prompt set and its
capability. This is Stage 3's per-message/per-request split, unchanged.

The answer-phase dispatch table also got its first test. A grep for the mode
flags across every suite previously hit only `prompts.test.js`, so the table
could have lost a row without anything failing.

### Stage 7 — an untrusted spec is safe to resolve — SHIPPED (2026-07-26)

`resolveUntrustedAgent(spec, granted)` is the boundary for a spec the repo did
not commit. It fails closed in every direction: not an object, any validation
problem, or any ungranted requirement yields a null agent and the reasons. No
partial success, because a half-applied capability block is a state no reader
downstream expects.

**The escalation it closes.** `capability.requires` is *self-declared*. A spec
selecting the build tools while declaring `requires: []` would sail through the
ordinary routing gate, which checks what a spec claims to need rather than what
it reaches for. So requirements are **derived from the selection**
(`requirementsFor` over the `IMPLIED_REQUIREMENTS` table) and the derived set is
what gets checked. Lying is inert. The table is pinned against the real
registry — every shipped agent's declared `requires` must cover what its own
selections imply — so it cannot drift into being a parallel opinion of the
registry.

What makes this safe rather than merely careful is that it adds no new rules.
The closed vocabularies already reject non-members, `validateAgentSpec` already
runs invariants 1, 3, 4 and 6, and stage 5's accessors already make every field
a ceiling. The boundary's whole job is to run them on the request path and
refuse.

It is wired: `/api/chat` accepts an `agent_spec` object, the most specific route
(it beats `agent` and every mode flag, and needs no registry load). A refused
spec is logged and the turn is answered by the agent it would otherwise have
got — a chat turn is not the place to fail a build.

The rejected-spec suite covers each closed vocabulary and each invariant rule at
the boundary, plus junk in place of a spec, plus the self-declared-requires
escalation.

### What is still not built

**Stage 4 — publishing spend-capable agent links.** Deliberately untouched. Its
mechanism is in place (`agentLinkPlan` → `mintServerTokenGrant`) and stage 7
makes a published spec resolvable, so the remaining work is wiring plus the
**quota-grant-assessment** checklist. It stays separate because it is the only
step that spends money on a link a stranger can click: fail-safe, not fail-soft
(§6), and it should land as its own change.

**Per-user spec STORAGE.** Stage 7 shipped the boundary and the inline route,
not a place to keep a spec. `agent_write` / `agent_publish` writing to per-user
storage that the resolver reads after the committed registry is a wiring job
now rather than a security design job — which was the point of doing the
boundary first.

**Per-agent prompt TEXT.** Still the open question, and still needs an owner
decision, because it is where the selector rule (§6) bends: authored words are
not a member of a closed vocabulary. The bounded form worth arguing is an
appendix — a length-capped persona block appended to the shipped set's output,
never replacing it, so the deterministic prompt and the invariants survive.
Recorded as the question, not as a plan.

**The visual half.** `theme`, `controls`, `intro`, `loading` and `backdrop` are
still rendered only by `/agents/preview.html`; the running chat pane draws from
`mode-theme.js`. Making the spec authoritative there, with `mode-theme.js` as
the fallback, is the natural pair to stage 6 and was not part of this work.

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
