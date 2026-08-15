# The Agent Platform — the DeepResearch Agents SDK

**Build complete agents through the Agents SDK — define them, preview them,
prove them, and share them.** This is the reference for the **DeepResearch
Agents SDK**, the project's SDK for building a single **agent** inside a
platform, tailored specifically to the two surfaces where agents live:

- **Agent Studio** — the chat mode that turns a described flavour into a
  published agent at `/app/<slug>/`. The Agents SDK supplies its definition
  layer (the AgentSpec), its direct build tools (`write_file` staging +
  `publish_app` — the ONLY pathway that ships files; see §2), and its
  publishing surface (`src/build-pub.js`).
- **The integrated Linux environment** — the in-browser execution sandbox
  (`public/js/sandbox.js`, `public/js/bash-core.js`): where an agent or a
  build can actually *run and test* code, with attached files under
  `/workspace/` and, in developer/SDK mode, the platform's own source mounted
  at `/src`. The sandbox is for execution only — files created there are
  never published; shipping always goes through the build tools.

(Its companion, the **DeepResearch Platform SDK** — codename
DistillSDK, [`docs/DISTILLSDK.md`](./DISTILLSDK.md) — builds a whole *platform*,
an entire DeepResearch.se-like two-tier product; this one builds one *agent*
that runs on a platform. Agent Studio consults the Platform SDK's module
catalog as its *method* when a request distills a whole platform rather than a
single agent.) This is the top of a
three-level documentation tree. Read this page for the whole picture; follow the
links down to the subsystem docs and then to the source; and use the **"ask the
source"** links (§9) to put any question straight to the introspection agent,
which answers from the project's own code.

> **Status (2026-08-13, spec 0.2.0):** the definition layer, the **ten**
> shipped agents, the composer renderer, the visual proof, the CLI, the live
> preview surface, and the metered share-link **mint** are **wired and tested**.
> The mint reuses the existing Se/rver-token subsystem verbatim (no new crypto,
> no new meter — §8). From 0.2.0: the **capability block** (§3.1) and the
> **routing table** (§4) — the site's seven default chat modes are registry
> entries, `/api/chat` dispatches on the phase a spec declares, and every phase
> speaks in the prompt set its agent names. Since 2026-08-13 the roster is
> SPECIFIC and has no general member: the `normal` mode and its `research`
> agent are retired, Deep Science is the default and terminal fallback, Cyber
> is new, and `capability.context` is executed rather than merely declared
> (§3.2). The project is experimental research into how far a useful assistant
> can be pushed toward *provable* privacy, not a finished product.

---

## 1. What an agent is

An **agent** is a *flavour* of this site's platform — its Se/cure + Se/rver
tiers. It is defined by what you can see and change about it, on two levels.

**How it looks and feels** — five things:

1. its **chat-input-pane controls** — which affordances hang off the composer:
   a model picker, a research-depth slider, web-search / incognito toggles,
   attachments, a mode picker;
2. its **intro animation** and its **loading animation**;
3. its **colour theme**;
4. its **example questions** (a seed set, plus on-demand generation);
5. the **default quota** a minted share-link **token** carries (its credits).

**What it does** — its **capability block** (§3.1): which answer phase takes the
turn, which prompt set it speaks in, which tool set the model may drive, which
retrieval blocks are injected, the search and model-routing policy, the
deterministic gates, the bounds, the events it emits, the knob it requires, and
— for a workflow — which agents its team may draw from.

Both levels are **data**. Deriving a new agent is: copy one spec, change those
fields, validate. No code change — including for what it does, as long as it
selects an answer phase the platform already implements.

## 2. The ten agents we ship

Each is one entry in [`sdk/AGENTS.json`](../sdk/AGENTS.json) — reference specs
that exist to be copied. **Seven are the DEFAULT agents**, one per Se/rver chat
mode; two are the client-tier archetype and the template; and one — Palaeogenomics
— is a DERIVED agent bound to no mode at all, reachable only by id.

The roster is **specific, and has no general member** (owner directive,
2026-08-13). Until that date the first row was *Research*, mode `normal`,
labeled "Deep Research": the catch-all every unrouted request fell back to, and
the one agent defined by what it did *not* specialise in. It is retired. Every
agent below names a domain, and a request naming none lands on Deep Science
rather than on a catch-all — so the terminal fallback now carries a policy
(literature-first: the peer-reviewed record leads and is numbered first, and
the web leg runs behind it labelled as web reporting) where it used to carry
open-web research. Old clients, stored settings, share links and the eval harnesses still
sending `normal` resolve through `RETIRED_CHAT_MODES`
([`public/js/chat-mode-core.js`](../public/js/chat-mode-core.js)).

The first seven rows are the dropdown, in dropdown order.

| Agent | Mode | Tier | What it is |
|---|---|---|---|
| **Deep Science** | `science` | Se/rver | The peer-reviewed record first, the open record to check it against. Merges OpenAlex, Europe PMC's reviewed slice, Semantic Scholar, the hosted PubMed index and (where licensed) Google Scholar's own ranking, then keeps only records carrying positive evidence of peer review. That leg **leads** and is absorbed first, so it takes the first numbered sources; the web leg runs behind it (knob-gated) stamped "NOT peer-reviewed" and may not stand in for the literature on a scientific claim — added 2026-08-14 on feedback #69, before which `search.web: false` made it structurally webless. **The default agent and the terminal fallback**, which is why its spec is the one mode default declaring `requires: []`. Spec id `scholar` ([`SCHOLAR.md`](SCHOLAR.md)). |
| **Cyber** | `cyber` | Se/rver | Cybersecurity and OSINT. The one agent that may reach the platform's outward-facing intelligence: host intelligence for a named host, IP or organization; street-level imagery and place resolution read as reconnaissance; the OWASP Top 10 for web and for LLM applications as real reference text; and the two OSINT methods — subject disambiguation, and the depth-scaled dossier scaffold whose deepest tier is shaped like a TIBER-EU targeted threat-intelligence report. |
| **Introspection** | `introspection` | Se/rver | The site read from the inside — answers from its own deployed source and docs, natively with tools or through the deterministic read loop. Keeps the OWASP block too: a security assessment *of this platform* is its turn. |
| **Agent Studio** | `sdk` | Se/rver | The mode that *builds* agents (spec id `agent-builder`): describe a flavour, it distils this site into it and publishes it live. |
| **Orchestrator** | `orchestrator` | Se/rver | A planned team of sub-agents run in parallel waves, merged into one answer. One kind runs *outside* the server: a `swarm` node reasons with many tiny Bonsai models at once in the user's own browser ([`SWARM-REASONING.md`](SWARM-REASONING.md)). |
| **Outrospection** | `outrospection` | Se/rver | Introspection's mirror image — answers from the standing outward feed of what everyone else shipped. |
| **Models** | `models` | Se/rver | The agent whose subject is the models themselves, and the lifecycle it owns: discovered → evaluated → enabled. It holds the live catalog of every model this deployment can reach across every provider, with each one's price and its verification checklist — and enabling one puts it in every mode's dropdown. |
| **Secure** | — | Se/cure | The never-cloud tier — runs wholly in your browser, server in no data path, sealed local state. |
| **Under Construction** | — | Se/cure | A placeholder — the minimal viable agent (composer + send + an honest notice). The template you copy to start a new one. |
| **Palaeogenomics** | — | Se/rver | Ancient DNA: the published literature (Europe PMC) and a structured query over 20,927 published ancient individuals, kept as two separate legs. Bound to **no chat mode** — addressed by id, `defaults` untouched — and the worked example of a DOMAIN agent that costs the platform one registry entry and one vocabulary member. Its sample block is enabled by the spec's declared `context`, not by a knob; the same declaration is what keeps it the one agent besides Deep Science holding `literature-pubmed` ([`PALAEOGENOMICS.md`](PALAEOGENOMICS.md)). |

`derivesFrom` used to point at `research` on every server-tier spec. With the
general agent gone they point at `baseplate` — the Platform SDK module — which
is the honest ancestor now that there is nothing general left to inherit from.

The **Agent Studio** is where the platform folds back on itself — it is the
[`pair-studio`](../sdk/skills/pair-studio/SKILL.md) module made real: prompt →
generate in the VM → preview → publish at `/app/<slug>/`.

A published agent does not have to reinvent how it reaches a model. Every build
that talks to one loads the **app kit** (`public/app-kit/dr-provider-kit.js`),
which the publish step adds to the bundle on its own. It has two modes, and a
build picks one:

- **Hosted** (the default). The app runs on this site's own model access, pinned
  to a model chosen when it was published, so whoever opens the link can use it
  immediately — no key, no dropdown, nothing to configure. What makes that
  possible is a grant, not a shared secret: at publish time the app gets its own
  Se/rver token with the `api` permission alone (`src/app-token.js`), written
  into the generated `js/dr-app-config.js` and metered like every other token.
  The conversation therefore crosses this site's server on its way to the model
  provider — the opposite of the posture below — so the app states it:
  `llm.note()` is that sentence, and builds are told to show it.
- **Bring your own key.** Pasting a key detects the provider, loads the models
  that key can actually reach, and fills the same flag-prefixed dropdown this
  site uses — over the same providers, with the country each conversation is
  processed in stated on every option. The key stays in the page and goes only
  to that provider, which is what lets a generated agent inherit Se/cure's
  posture rather than approximate it. This is the right mode for a never-cloud
  flavour, and it is what the user gets when they ask for it.

The kit's registry is pinned by test against the platform's own
(`public/js/drc-providers.js`), so an agent published today and one published a
year ago disagree about nothing.

An agent's interface is whatever its job needs. A chat window is one option —
the most common, not the required one; a single button, a form, or a grid of
prompts is a complete agent if that is what the work looks like. The build
prompts say so, because before capture #CAP-22 every build converged on the same
message thread behind the same key field.

### 2.1 Agents are not chat modes, and not tiers

Four different lists get confused for one another, so here they are side by
side. The agent list is not the chat-mode dropdown and not the tier split, even
though seven of its entries are now bound to a mode (§4).

| The list | Where it lives | What it is | Its entries |
|---|---|---|---|
| **Tiers** | the product | The two halves of the platform, split by where the data goes | Se/cure (client, server in no data path), Se/rver (signed-in, cloud) |
| **Chat modes** | `public/js/chat-mode-core.js` `CHAT_MODES` (re-exported by `chat-mode.js`, façade `src/chat-modes.js`), mirrored in `public/js/mode-theme.js` | What the pipeline *does* with a turn — picked in the dropdown | `science` (Deep Science), `cyber` (Cyber), `introspection`, `sdk` (Agent Studio), `orchestrator`, `outrospection`, `models` (Models) |
| **Agents** | `sdk/AGENTS.json` | Reference AgentSpecs — templates to copy | Deep Science, Cyber, Introspection, Agent Studio, Orchestrator, Outrospection, Models, Secure, Under Construction, Palaeogenomics |
| **Routes** | `public/js/stream.js` `sendMessage` | Where a send is *computed* — not chosen directly, inferred from the model pick and the knobs | server pipeline (`/api/chat`), on-device (`ondevice::` Bonsai), private introspection (own key, browser-direct) |

The fourth row is the one with no user-facing name, and the omission caused a
real bug. A route is not something the user picks; it is inferred. Choosing a
Bonsai model from the model dropdown looks like choosing a model, but it moves
the whole exchange into the browser, and choosing an own-key model for
introspection does the same. Neither calls `/api/chat` at all, so every gate
that lives in the server pipeline is absent — see §2.2.

The relationships, in one line each:

- **An agent picks a tier**, via `platform` (`"client"` = Se/cure,
  `"server"` = Se/rver). *Secure* is the reference agent for the client tier —
  the tier is the platform half, the agent is one flavour running on it. Se/cure
  is **not** an agent under Se/rver: its defining property is structural (the
  server is in no data path), and a client-platform spec cannot opt into a
  server data path (PA-4). The Se/rver tier no longer has a corresponding
  general reference agent; *Deep Science* is its default, and it is a domain
  agent like every other.
- **An agent picks a mode**, via the `mode` field and the `mode-select`
  control; all seven ids are selectable, and leaving `mode` unset is legal too —
  that is what makes `palaeogenomics` reachable by id alone. Since spec 0.2.0 it also picks an
  **answer phase**, via `capability.answerPhase` (§3.1) — so a spec can reach
  any execution semantics the platform already implements, and the `defaults`
  table (§4) is what binds a mode to the agent that IS it. What a spec still
  cannot do is *invent* execution semantics: a genuinely new executor is a row
  in `src/pipeline.js` `ANSWER_PHASE_RUNNERS`, written by hand. The dispatch is
  code; only the selection is data.
- **"Agent Studio" appears in both lists** because the mode that builds agents
  is itself shipped as a reference agent. Its spec **id** is `agent-builder` and
  its **mode** is the canonical `sdk`. The two are not interchangeable:
  `validateAgentSpec` rejects `"mode": "agent-builder"`, and the name survives
  only as that spec id and as a deep-link alias
  (`public/js/deeplink-core.js`).
- **A route is orthogonal to all three.** It is not a tier (an on-device send
  on Se/rver keeps the account, the encrypted history and the quota — only the
  computation moves), not a mode (every mode can be sent over any route the
  pick allows), and not an agent (no AgentSpec field selects one).

### 2.2 A route may not swallow a message addressed to the developers

A browser-direct route skips the server pipeline entirely, which means it also
skips the pipeline's deterministic gates. That is correct for research — the
whole point of an on-device pick is that the question stays on the phone — but
it is wrong for the one message type that is not research.

A message opening with the word "feedback" (EN + SV) is a report *to the
developers*, not a question for a model. In the Se/rver tier the on-device and
private-introspection routes were checked before anything else, so a report
sent while a Bonsai model was picked was answered by that local model and no
feedback entry was ever created: the developers received nothing and the user
had no way to tell. The reported case came back as filler from a 1.7B model
(feedback #23).

The rule, and where it lives:

- `feedbackForcesServerRoute` (`public/js/feedback-core.js`) sits with the
  intent gate, not inside any branch. `sendMessage` consults it **above** every
  route decision, so a browser-direct route added later inherits the rule
  instead of quietly reopening the hole.
- The forced server send also drops an `ondevice::` model id, which is not in
  the server catalog and would otherwise fail validation as an unknown model
  (`src/validation.js` `resolveModel`). Nothing is lost: the feedback case
  answers with a canned acknowledgment and never calls a model at all.
- This is not a privacy regression. Typing "feedback" is an explicit, disclosed
  act of addressing the developers — the same reason a feedback entry is
  recorded even in incognito.
- Se/cure was never affected: its `send` (`public/cure/drc.js`) puts the gate
  first, before provider routing, and still requires an explicit confirmation
  before anything leaves the browser. The two tiers had simply diverged on
  ordering.


### 2.3 Slash commands are platform baseline, not an agent capability

The same argument, one level up. `/feedback` and `/help` (`public/js/slash-core.js`)
are available in **every** agent, on both tiers, in every chat mode — the
2026-07-26 owner directive that created them says so in as many words. The
question this raised for the Agents SDK was whether to model them as a new
member of the closed control vocabulary.

They are not. A control is something a spec *chooses*, and a chooseable command
is a command some agent ships without — the exact outcome the directive rules
out. So the commands are composer **baseline** instead:

- every `prompt-input` control carries the typeahead (`public/js/slash-menu.js`,
  UX-15), mounted once per composer rather than once per agent;
- `src/chat.js` resolves the command from the message text **before** the
  routing table below runs, and clears every executor phase for it;
- `src/pipeline.js` evaluates the feedback gate **above** the
  `ANSWER_PHASE_RUNNERS` dispatch.

An agent therefore cannot opt in, opt out, or redefine them — there is nothing
in the spec to set. `GATE_IDS` still lists the `feedback` gate for
completeness, and no shipped spec declares it, for the same reason.

The regression guard is `src/slash.test.js`, which discovers the executor
phases from the dispatch table and the mode booleans from `chat.js` rather than
listing them: a new agent, a new answer phase or a new mode that ships without
the commands fails a test that names it.


## 3. The AgentSpec

One agent, as JSON. The full field reference and the closed control vocabulary
live in the [`agent-platform` skill](../sdk/skills/agent-platform/SKILL.md);
the short version:

```jsonc
{
  "id": "scholar", "name": "Deep Science", "tagline": "…",
  "platform": "server",              // "client" | "server" — the tier
  "mode": "science",                 // a CANONICAL chat mode id, validated against
                                     // chat-mode.js: science | cyber | introspection |
                                     // sdk | orchestrator | outrospection | models.
                                     // "agent-builder" is NOT accepted here — it survives
                                     // only as the Agent Studio spec's `id` and as a
                                     // deep-link alias. `normal` is retired (2026-08-13)
  "theme": { "--agent-accent": "#3b82f6", … },
  "intro":   { "kind": "fade" },
  "loading": { "kind": "pipeline-phases", "messages": ["Triaging…", …] },
  "backdrop": { "kind": "terminal" },  // the agent BACKGROUND behind the chat:
                                       // none | terminal | graph (closed set)
  "controls": [                       // the chat-input pane — ORDER is render order
    { "type": "prompt-input", "placeholder": "Ask…" },
    { "type": "model-select" },
    { "type": "depth-slider", "min": 0, "max": 3, "default": 1, "ticks": ["Quick","Standard","Deep","Exhaustive"] },
    { "type": "toggle", "id": "web_search", "label": "Web search", "default": true },
    { "type": "attachments" },
    { "type": "mode-select", "modes": ["science","cyber","introspection","sdk","orchestrator","outrospection","models"] }
  ],
  "examples": ["…"], "generateExamples": true,
  "quota": { "window": "day", "requests": 50, "credits": null },
  "capability": { … }                // §3.1
}
```

**The control vocabulary is closed** (`prompt-input`, `send-button`,
`model-select`, `depth-slider`, `toggle`, `mode-select`, `attachments`). Each
type declares its default fields and which **request field it drives** — a
`depth-slider` drives `depth`, a `toggle` drives the flag named by its `id`.
Closing the vocabulary is what lets one renderer draw any agent's composer, and
lets the visual proof (§6) check every declared control actually appears.

**The backdrop is an axis, closed the same way** (`BACKDROP_KINDS`:
`none` / `terminal` / `graph`): each agent declares which BACKGROUND it works
in front of — `terminal` is the drifting sandbox shell output
(`public/js/agent-backdrop.js`), `graph` the hovering, slowly rotating
wireframe workflow graph (`public/js/graph-backdrop.js`, the Orchestrator
mode's background). The Se/rver chat modes declare the same axis in
`public/js/mode-theme.js` (`backdrop`), so modes and agents describe their
background with one vocabulary.

The one implementation is the pure core
[`public/js/agent-spec-core.js`](../public/js/agent-spec-core.js) (server
façade [`src/agent-spec.js`](../src/agent-spec.js); the CLI re-exports it) —
`validateAgentSpec`, `resolveControls`, `resolveTheme`, `resolveQuota`,
`resolveExamples`, and the `composerMarkup` renderer. It is I/O-free and
Node-tested ([`agent-spec-core.test.js`](../public/js/agent-spec-core.test.js)).

### 3.1 The capability block — what the agent DOES

The composer says how an agent looks. The **capability block** says what it
does, and it is what makes a default agent expressible as a spec at all:

```jsonc
"capability": {
  "answerPhase": "workflow",         // research | source-research | build
                                     // | workflow | feed | direct
  "prompts": "workflow",             // the PROMPT SET it speaks in — research |
                                     // source-research | build | workflow | feed
                                     // (null = the answer phase's own set)
  "tools": [],                       // source-read | sdk-plan | build-publish | shell
  "toolFallback": "none",            // read-loop | file-blocks | none
  "context": ["source-snapshot"],    // which retrieval blocks are injected — and,
                                     // since 2026-08-13, which corpora and which
                                     // third-party intelligence the agent may reach
  "search": { "web": true, "auxSources": false, "maxQueries": 6 },
  "routing": { "planModel": "json-default", "answerModel": "user" },
  "gates": [{ "id": "lens", "langs": ["en","sv"] }],
  "bounds": { "maxTokens": 2048, "timeoutMs": 150000 },
  "emits": ["step","search","workflow","agent_update"],
  "requires": ["developer_mode"],  // the non-default modes are available here
  "team": { "kinds": ["scholar","cyber","introspection"], "maxAgents": 6, "maxWaves": 3 }
}
```

**It is a SELECTOR, never a definition.** Every value is a member of a closed
vocabulary that names code the platform already ships. That single constraint is
what keeps the load-bearing invariants true of the *routing* as well as of the
run — a spec can select the owner-authorized tool exception, it cannot invent a
new one, and it can never express control flow.

Four invariants stop being prose and become validation rules:

| Rule | Enforced as |
|---|---|
| **Inv. 1** — every mode works across the whole catalog | an agent declaring `tools` must name a `toolFallback` other than `none` |
| **Inv. 3** — split model routing | `routing.planModel` is a one-member vocabulary (`json-default`) |
| **Inv. 4** — the privacy split | a `platform: "client"` spec may not select any `serverOnly` member; the platform type IS the boundary |
| **Inv. 6** — language parity | a declared gate must carry `langs` including both `en` and `sv` |

Each rule has a passing *and* a failing case in
[`agent-capability.test.js`](../public/js/agent-capability.test.js), and every
declared bound is pinned against the constant that enforces it — so a spec
describing behaviour the code does not have fails `npm test`.

**Prompt set and answer phase are independent choices.** A set is a named group
of system prompts covering some of six closed ROLES (`plan`, `worker`, `answer`,
`answer-tools`, `answer-direct`, `answer-search-off`);
[`src/prompt-sets.js`](../src/prompt-sets.js) binds each (set, role) pair to the
shipped builder, and each phase declares the roles it needs. So an agent can run
the research phase in the source-research voice — a combination that was not
expressible at any price before — while a set that cannot fill its phase's roles
is rejected at validation. The binding is pinned by identity against
`src/prompts.js`, so a re-pointed prompt fails `npm test` rather than a request.

### 3.2 Reading a capability at run time

A declared field only matters if something reads it. Four accessors in the
pure core do, and all four NARROW:

| Accessor | Reads | Rule |
|---|---|---|
| `capBound(cap, key, limit)` | `bounds` | `limit` is both the default and the ceiling |
| `capSearch(cap, requested)` | `search` | the agent's ceiling ANDed with the request, both directions |
| `capHasTool(cap, class)` | `tools` | resolved through `src/tool-sets.js` in registry order |
| `capHasContext(cap, block)` | `context` | a block runs only for an agent that declared it; a null capability declares none |

An absent, malformed or over-large declaration resolves to the platform's own
value. The worst a hostile capability block can do is make its own agent do
less.

**`context` became executed on 2026-08-13**, and that is the architectural
change behind the specific roster. It used to be declared-and-pinned: the specs
listed their retrieval blocks and a test checked the vocabulary, but nothing on
the request path read the list, so a block ran because a mode flag, a knob or a
keyword gate said so. Now `capHasContext` is the gate at two seams:

- **the enrichment registry** ([`src/enrichment.js`](../src/enrichment.js)) —
  the ancient-sample corpus, the Scholar metrics leg, the OWASP reference and
  the person-research *method* each run only for an agent that declared the
  matching block;
- **the search-source registry** ([`src/search-sources.js`](../src/search-sources.js))
  — a source entry may name a `requiresContext` block, and `sourceAllowed` in
  the pipeline honours it generically, so arXiv, Europe PMC and the
  peer-reviewed leg belong to the agents that declared them and to no others.

Fail-soft cuts the other way here than elsewhere, deliberately: a **null**
capability means *no agent was resolved*, not *an agent declared nothing*, so
every source still runs. That is the `POST /mcp` channel (which has no concept
of an agent) and any deployment whose registry will not load — invariant 2.
Declaring nothing, by contrast, is a real declaration and blocks the gated
blocks.

Still declared-and-pinned rather than read: `gates`, `emits` and `team`.

One rule is easy to get wrong and has its own test: **a capability governs the
phase it names, and no other.** Introspection declares `search.web: false`
because its own phase does not search; a turn the `externalSourceIntent` gate
hands back to research was routed there *in order to* search, so introspection's
declaration must not follow it.

## 4. The routing table — how a request finds its agent

The registry's top-level `defaults` is an **ordered** table: one row per chat
mode, naming the agent that IS that mode and the `/api/chat` request flag that
selects it. **Array order is precedence.**

```jsonc
"defaults": [
  { "mode": "sdk",           "agent": "agent-builder", "flag": "sdk_mode" },
  { "mode": "orchestrator",  "agent": "orchestrator",  "flag": "orchestrator_mode" },
  { "mode": "outrospection", "agent": "outrospection", "flag": "outrospection_mode" },
  { "mode": "models",        "agent": "models",        "flag": "models_mode" },
  { "mode": "introspection", "agent": "introspection", "flag": "introspection_mode" },
  { "mode": "cyber",         "agent": "cyber",         "flag": "cyber_mode" },
  { "mode": "science",       "agent": "scholar",       "flag": "science_mode" }
]
```

A request normally names its mode outright — `chat_mode: "<mode>"` — and
`resolveRequestAgent(registry, body, granted, mode)` serves that row if the
agent's `capability.requires` are all granted. The per-mode booleans are the
legacy spelling and still resolve, in array order; `science` is the terminal
fallback. "A client cannot acquire a capability it does not hold" is therefore
one rule applied uniformly, rather than a condition repeated per mode.

**Introspection got its flag on 2026-07-26.** Before that its row had
`flag: null` and it was the *derived* mode — whatever a request resolved to when
the `developer_mode` capability was granted and no other flag matched. That made
one boolean carry three unrelated jobs (availability, the persisted user choice,
and introspection's activation), so the same choice had to be stored three times
and reconciled on every page load. Now every mode is nameable and
`developer_mode` is an availability grant only.

**The terminal row changed on 2026-08-13.** It was `normal` / `research`,
flag `null` — the general agent. It is now `science` / `scholar`, and two
consequences are load-bearing:

- **The fallback must be reachable by any caller**, so `scholar` alone among the
  mode defaults declares `requires: []`. A requirement on the terminal row would
  fall through to *nothing*, and nothing resolves to a null capability, which is
  the unrestricted platform default — the opposite of what a fallback should be.
- **An unrouted request now gets a policy.** Deep Science leads with the
  peer-reviewed record and treats the web as corroboration behind it, so a
  caller wanting the open web as its PRIMARY evidence has to name an agent
  built that way. A broken `sdk` row falls to Deep Science, not to open-web
  research.

`src/chat.js` resolves the request; `src/pipeline.js` dispatches on the
resulting `capability.answerPhase` through a table of executors. Three practical
notes:

- **The dispatch stays code, the selection stays data.** Only the four executor
  phases (`build` / `workflow` / `feed` / `direct`) come from the registry.
  Whether a *source-carrying* request answers from the source or runs a web
  search is still decided per *message* by the pipeline's `hasSource` +
  `externalSourceIntent` gate, so an agent declaring `research` or
  `source-research` does not pre-empt it.
- **A mode need not bring an executor.** The Models agent's answer phase is the
  ordinary `research` one; what makes it its own mode is a capability block (a
  forced search source, a context block, a gate, an event) plus an enrichment —
  no row in `ANSWER_PHASE_RUNNERS`. It is the worked example of step 3 in §5: an
  agent whose phase already exists needs no executor code. `src/chat.js`
  therefore resolves it from the mode directly and lets it lose to any mode that
  DOES replace the flow.
- **Fail-soft (PA-2).** The registry is loaded once per ASSETS binding
  ([`src/agent-registry.js`](../src/agent-registry.js)). An unreadable registry
  falls back to the hand-written mode cascade, which the table reproduces
  exactly — pinned by test.
- **It is on every path now.** `routingNeedsRegistry` returns `true`
  unconditionally. The old shortcut skipped the load for a `normal` turn with no
  address, on the sound reasoning that the general agent declared nothing that
  could narrow it. That premise died with the general agent: every mode is a
  domain, a domain is enforced by `capHasContext`, and a request that skipped
  the registry would resolve a **null** capability — the unrestricted platform
  default. Deep Science would quietly stop being literature-only, which is the
  exact failure the exclusivity work exists to prevent.
- **What pays for it** is a second bundler output. `scripts/bundle-source.mjs`
  now writes `public/introspect/agents.json` — a byte copy of the registry,
  served at `AGENTS_REGISTRY_PATH` ([`public/js/introspect-core.js`](../public/js/introspect-core.js))
  — which `src/agent-registry.js` reads first, falling back to the source
  snapshot when a deploy's bundle predates it. So the per-isolate cost is one
  small asset read, not a multi-megabyte parse.

### 4.1 Three ways to reach an agent

The `defaults` table is the least specific of three routes. They are tried
most-specific first, and every one of them applies the same requirement gate.

| Route | Request field | Needs the registry? | What it is for |
|---|---|---|---|
| **Inline spec** | `agent_spec` (object) | no | a spec the caller wrote — Agent Studio handing back what it just built |
| **Address** | `agent` (id string) | yes | a registry entry with no `defaults` row, no flag, no chat mode |
| **Mode** | `chat_mode` (or a legacy `sdk_mode`, …) | yes | the seven default agents (the table above) |

Two rules make the extra reach safe:

**Falling through is the only failure.** An unknown id, a misspelt id, an id
whose requirements the caller lacks, and a refused inline spec all resolve to
the agent the request would have got with none of them. Nothing errors, nothing
escalates, and probing for ids reveals nothing.

**Requirements are derived, not declared.** `capability.requires` is written by
whoever wrote the spec, so for a spec the repo did not commit it cannot be the
gate — a spec selecting the build tools while declaring `requires: []` would
otherwise sail through. `requirementsFor()` derives the needed knobs from what
the capability actually *selects* (the `IMPLIED_REQUIREMENTS` table, pinned
against the shipped registry), and `resolveUntrustedAgent()` checks the derived
set after running every validation rule. It fails closed: no partial capability,
ever.

Together with the narrowing accessors (§3.2) this is the whole argument for
letting a stranger's spec run: it cannot select outside the closed vocabularies,
cannot break invariants 1/3/4/6, cannot reach a knob it was not granted, and
cannot ask for more of anything than the platform already does.

## 5. Deriving your own agent

1. Copy an entry in `sdk/AGENTS.json` and give it a new `id`.
2. Change the defining things — controls, animations, theme, examples, quota
   (§1) and the capability block (§3.1) — and set `derivesFrom` to the agent you
   copied (provenance).
3. Reach it. Addressing it by id (`{"agent": "<id>"}`) needs nothing further —
   no `defaults` row, no request flag, no chat mode, no theme descriptor, no
   CSS. Add a `defaults` row only if it should also BE a chat mode (§4). An
   agent whose `answerPhase` is one the platform already implements needs **no
   code at all**.
4. Validate: `node sdk/pair-cli.mjs validate` (checks agents too) and
   `npm test`. Inspect it: `node sdk/pair-cli.mjs agent <id>`.
5. Prove it renders: `node scripts/agent-proof.mjs` (§6).

That is the whole loop — a new agent is data, not code.

**Without touching the repo at all**, send the spec inline as `agent_spec` on
the request (§4.1). It goes through `resolveUntrustedAgent`, which runs every
rule in this document and refuses the whole spec if any fails. This is the seam
the **Agent Studio** mode builds toward: describe an agent in natural language,
and get back something the real platform runs rather than a static page that
reimplements a fraction of it.

Two things a derived agent still cannot do, both deliberate: it cannot author
its own prompt TEXT (it selects one of the shipped sets — §3.1), and it cannot
be published as a spend-capable share link yet (the minted-token half of
`docs/DEFAULT-AGENTS-GENERALIZATION.md` Stage 4, which needs the
**quota-grant-assessment** checklist).

## 6. Visual proof-driven testing

You declare which controls appear in the chat-input pane; the proof **renders
every agent's composer from its spec and asserts every declared control is
there**. Two forms:

- **The machine gate** — [`scripts/agent-proof.mjs`](../scripts/agent-proof.mjs)
  renders every composer, prints a pass/fail row per agent, and exits
  non-zero if any declared control is missing. `proveComposer()` is the same
  check, pinned in the test suite so `npm test` fails on a regression.
- **The eyeball artifact** — the same script writes a self-contained HTML
  gallery of every composer (theme, controls, intro/loading markers, example
  strips) you open in a browser.

Because the proof and the live composer both build from the *same*
`composerMarkup`, what the proof asserts is exactly what a user sees.

## 7. Preview + example questions

The preview surface ([`public/agents/preview.html`](../public/agents/preview.html)
+ [`public/js/agent-preview.js`](../public/js/agent-preview.js)) loads the
registry from the committed source snapshot (the same artifact introspection
and the Agent Studio plan from), renders each agent's composer, and lets you:

- **ask an example question** — each seed example is a chip that opens the real
  agent composer with the question prefilled (a §9-style deep-link);
- **generate more examples** — `exampleGenPrompt()` builds the prompt that asks
  the answer model for fresh questions in the agent's style;
- **see the share-link quota** the agent would mint (§8).

## 8. Sharing an agent as a link (quota + credits)

Creating an agent **as a link** mints a **token** carrying the agent's default
**quota/credits** — bounded, disclosed, revocable, fail-safe. This is wired
**by the book**: it reuses the platform's existing **Se/rver-token** subsystem
verbatim — no new crypto, no new meter.

- `agentTokenGrantParams(agent)` (pure) maps the spec to the subsystem's
  arguments: the upstream `services` in the **closed** permission vocabulary
  (`api` = LLM, `web` = search — [`src/server-token.js`](../src/server-token.js)
  `SERVER_TOKEN_SERVICES`), the per-service `quotas` (the spec's credits, else
  its request count), and the `ttlHours` from the quota window.
- `POST /api/admin/agent-link` ([`src/agent-link.js`](../src/agent-link.js),
  admin-gated like the existing shareable mint) loads the agent from the source
  snapshot and calls `mintServerTokenGrant()` — which signs one standard HS256
  **JWT** ([`mintServerToken`](../src/server-token.js)) and creates one D1
  `server_tokens` meter row per permission. Optional `ttlHours` / `quotas` in
  the body override the spec defaults ("go by default, or choose the credits").
- The response includes the JWT and a shareable `link` (`/cure?st=<token>`) —
  the same mechanism the admin server-token mint uses.

Because it *is* a Se/rver token, it carries **THE SERVER-TOKEN GUARANTEE**
unchanged — **PA-8** (bridge discipline) and **PA-9** (fail-safe metering) in
[`sdk/DESIGN.md`](../sdk/DESIGN.md), full model in
[`docs/SERVER-TOKENS.md`](./SERVER-TOKENS.md):

- the token authorises **upstream API access only** — never the Se/rver tier's
  own data, and never a login;
- every use decrements an **atomic meter row**; no meter backend → no spend;
- the link is **revocable** (delete the meter row) and **time-limited**.

So a shared agent link runs on exactly the credits you defined for it, and not
a request more. This is the one place the platform touches money and quota, and
it fails **safe**, not soft (contrast the pipeline's helper phases, which fail
soft — PA-2).

## 9. Ask the source (introspection deep-links)

Every claim on this page is answerable from the code. These links open the site
in **introspection mode** with the question prefilled — the introspection agent
answers from the project's own source
([mechanism](../public/js/deeplink-core.js): `/?mode=introspection&ask=…`):

- [How is an agent defined in the SDK?](/?mode=introspection&ask=How%20is%20an%20agent%20defined%20by%20its%20chat-input-pane%20controls%2C%20theme%20and%20animations%20in%20agent-spec-core.js%20and%20sdk%2FAGENTS.json%3F)
- [What is the closed control vocabulary and what does each control drive?](/?mode=introspection&ask=What%20is%20the%20closed%20control%20vocabulary%20in%20CONTROL_REGISTRY%20and%20which%20request%20field%20does%20each%20control%20drive%3F)
- [How does the visual proof assert a composer renders every declared control?](/?mode=introspection&ask=How%20does%20proveComposer%20and%20scripts%2Fagent-proof.mjs%20assert%20every%20declared%20control%20renders%3F)
- [How does a shared agent link mint a metered quota token?](/?mode=introspection&ask=How%20does%20a%20shared%20agent%20link%20mint%20a%20metered%20token%20with%20the%20spec%20quota%2C%20per%20the%20server-token%20bridge%20and%20PA-8%2FPA-9%3F)
- [How do the composer deep-links prefill the introspection agent?](/?mode=introspection&ask=How%20does%20parseComposerDeepLink%20in%20deeplink-core.js%20prefill%20the%20composer%20and%20select%20the%20mode%3F)
- [How do I derive a new agent from an existing one?](/?mode=introspection&ask=How%20do%20I%20derive%20a%20new%20agent%20by%20copying%20a%20spec%20in%20sdk%2FAGENTS.json%2C%20and%20how%20is%20it%20validated%3F)

## 10. Where this sits in the documentation

- **Up:** [`docs/DISTILLSDK.md`](./DISTILLSDK.md) — the whole SDK; the agent
  platform is its layer-6 `agent-platform` module.
- **Across:** [`docs/SERVER-TOKENS.md`](./SERVER-TOKENS.md) (the share-link
  token), [`docs/PRIVACY-MODEL.md`](./PRIVACY-MODEL.md) (what a client-tier
  agent must uphold), [`docs/SYMBOL-LANGUAGE.md`](./SYMBOL-LANGUAGE.md) (the
  branding a theme carries).
- **Down:** the [`agent-platform` skill](../sdk/skills/agent-platform/SKILL.md)
  (build plan + acceptance), the pure core
  [`agent-spec-core.js`](../public/js/agent-spec-core.js), and the specs
  themselves in [`sdk/AGENTS.json`](../sdk/AGENTS.json).
- **Code map:** [`docs/CODE-LAYOUT.md`](./CODE-LAYOUT.md) lists every module the
  platform adds.
