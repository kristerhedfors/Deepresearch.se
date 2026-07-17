# The Agent-Pair SDK

**The complete documentation of `sdk/` — the Agent-Pair SDK — as a standalone
section of the project's documentation.** The SDK is the *constructive*
counterpart to the repo's operational skills: a design, a 33-module skill
library, a machine-readable manifest, an implementation-order rationale, and a
dependency-free CLI for building **agent pairs** — one AI-assistant product
shipped as two tiers of the same capability set, the way this site ships
DeepResearch.**Se/cure** + DeepResearch.**Se/rver**.

> **Status (2026-07-16): design + skill library only.** Nothing under `sdk/`
> is imported by `src/` or `public/`. The SDK is distilled *from* this
> repository — every module points back at the files that already realize it —
> and wiring the running application to SDK modules is a later, separate task
> (§10, adoption mode). The reference itself is experimental; the SDK does not
> make a generated pair production-ready.

This document is self-contained: it covers the abstraction, the capability
classes, the contracts, the full module catalog, the CLI, the implementation
order, and every way the SDK is used. For machine-readable detail the files
under `sdk/` remain authoritative — `sdk/MANIFEST.json` for the module
registry (ids, deps, reference files, acceptance), `sdk/DESIGN.md` for the
full design prose, `sdk/ROADMAP.md` for the phase rationale, and
`sdk/skills/<id>/SKILL.md` for each module's build plan. This document mirrors
them; an edit to any of them updates this document in the same commit (the
repo's mirror discipline).

---

## 1. What the SDK is

An **agent pair** is one product, two tiers:

- a **client tier** (archetype: DeepResearch.**Se/cure**, `/cure`) that runs
  wholly in the browser, with the server — if any — in **no data path**: the
  user's own upstream APIs or local model server, sealed local state,
  structural privacy;
- a **server tier** (archetype: DeepResearch.**Se/rver**, `/rver`) where
  exactly **one server component** (an edge worker) sits between the browser
  chat client and the optional upstream APIs, owning identity, orchestration,
  metering, storage and operations.

The SDK has three parts:

1. **The design** (`sdk/DESIGN.md`, condensed here in §2–§5) — the agent-pair
   abstraction and the contracts every generated pair must preserve.
2. **The skill library** (`sdk/skills/<id>/SKILL.md`) — one buildable
   capability module per skill, covering the entire capability foundation of
   deepresearch.se, each with a from-scratch build plan, the reference
   implementation map into this repo, and an acceptance checklist.
3. **The manifest + roadmap** (`sdk/MANIFEST.json`, `sdk/ROADMAP.md`) — the
   machine-readable module registry with dependencies, and the rationale for
   the order in which modules are implemented.

| File | What it is |
|---|---|
| `sdk/DESIGN.md` | The pair abstraction: zero-or-one server, capability classes C/S/B/X/D, contracts PA-1…PA-10, the module model, the design decisions |
| `sdk/MANIFEST.json` | The module registry: 33 modules with layer, class, dependencies, skill path, reference files, acceptance criteria |
| `sdk/ROADMAP.md` | The implementation order: six phases, why each module lands where it does, exit criteria per phase |
| `sdk/skills/<id>/SKILL.md` | One buildable capability module per skill |
| `sdk/README.md` | The catalog-and-usage front page of the `sdk/` directory |
| `sdk/pair-cli.mjs` | The dependency-free CLI over the manifest (`list` / `show` / `plan` / `validate`), unit-tested in `npm test` |
| `sdk/drpl.mjs` | The DRPL/1 pipeline-language reference tooling (`validate` / `show` / `fingerprint` / `diff` over `*.drpl.json` documents) — the formal language declaring a pipeline's structure incl. privacy placement, so pairs and nodes can be compared structurally (spec: `docs/PIPELINE-LANGUAGE.md`; part of the DRSW workspace-interchange standard, `docs/WORKSPACE-PROTOCOL.md`); unit-tested in `npm test` (`sdk/drpl.test.mjs`) |

**Why skills, not a framework.** The reference codebase's entire bug history
is integration behavior — hung fetches, silent stream truncation, CPU
ceilings, model quirks — which frameworks hide rather than prevent. The SDK
therefore ships *knowledge* (skills with contracts, build plans, and
acceptance tests) plus a thin generator, not a runtime library. Generated
pairs own their `fetch` calls and their stream loops, exactly like the
reference does. A skill is also the unit an agent session can actually
execute — which is how both the reference and any generated pair are, in
practice, built.

---

## 2. The agent-pair abstraction

**The zero-or-one-server property.** Across the whole pair there is at most
one server component. There is no microservice mesh, no separate auth service,
no search proxy fleet: every server-side responsibility lives in the one
worker, and the client tier must remain fully functional with that worker
reduced to a static file host (or replaced by any static host). This is the
property the SDK exists to preserve — it is what makes the pair's privacy
claims *auditable*: the client tier's guarantees follow from the absence of a
server in the data path, not from a policy document.

```
                 CLIENT TIER (class C)                SERVER TIER (class S)
  ┌──────────────┐   browser-direct    ┌──────────┐        ┌──────────────┐
  │   Browser    │ ─────────────────►  │ Upstream │  ◄──── │  The ONE     │
  │  chat client │   (user's keys /    │   APIs   │        │  edge worker │
  │              │    local server)    └──────────┘        └──────▲───────┘
  │  sealed local│                                                │
  │  state       │ ── static bytes only ──────────────────────────┤
  │              │                                                │
  │              │ ── grant tokens (class B, metered) ────────────┘
  └──────────────┘        the only sanctioned crossover
```

The upstream APIs themselves are **optional**: a client-tier session against a
local model server has *no* upstream third party at all, and a pair can be
generated with no web search, no maps, no enrichment — the baseplate plus a
provider registry is already a working product.

**Why the worker is the only server.** One deployable, one routing table, one
security-header function, one identity gate: auditable by reading a single
module graph. Serverless-edge (Cloudflare Workers in the reference) makes "one
server component" cheap to hold — no fleet to grow into. The design survives
platform swaps (Deno Deploy, Bun on a VPS) because the skills state the
*contract* (routing, D1-equivalent optionality, R2-equivalent blob store), not
the vendor API.

**Why the client tier is not a demo.** The client tier is the mission's proof
— how far a useful assistant can be pushed toward *provable* privacy. Class C
modules are first-class citizens with the same pipeline invariants (PA-1,
PA-2, PA-3 all hold client-side in the reference's `drc-research.js`), not a
feature-reduced teaser. Every capability skill states its client-tier story:
implementable / bridged / honestly server-only.

**Naming convention.** The pair's two tiers are named by one wordplay: a
shared brand stem whose URL path completes a word per tier (`DeepResearch.Se`
+ `/cure` → "Secure"; + `/rver` → "Server"). A generated pair may pick any
stem/wordplay, but the convention carries real rules the reference codified:
the display form is CamelCase-with-bold-tail (DeepResearch.**Se/cure**),
functional URLs stay lowercase, the short form is the slashed tail alone
(**Se/cure**), and whenever the two tiers are named together the client tier
comes FIRST. Internal code names never appear in user-facing copy. See the
`symbol-language` module (§6, layer 5).

---

## 3. Capability classes

Every SDK module is classified by where it can run. This classification is the
heart of the design — it is what "preserving the properties" means:

| Class | Meaning | Examples |
|---|---|---|
| **C — client-pure** | Implementable with no server in the data path. Must work on a static host. | sealed client crypto, the secure tier, offline workspace links |
| **S — server-backed** | Requires the one server component. Only ever exists in the server tier. | identity/accounts, quotas, cloud ciphertext storage, the MCP surface |
| **B — bridged** | A server capability *lent* to a client-tier session through metered grant tokens — the ONLY sanctioned way the client tier touches the server. | the grant-token bridge (granted web search, proxied LLM completions, the consolidated server token) |
| **X — shared substrate** | Pure logic used by BOTH tiers: one implementation as a pure core under the client's module tree, re-exported by a server façade. | the research pipeline, provider registry, bash-core, introspect-core |
| **D — development system** | Not product code: the loops, evals, boards and workflows that keep the pair maintainable by agent sessions. | eval harness, feedback/test loops, the generator, the architecture itself |

Class rules the generator (and `pair-cli.mjs validate`) enforces:

- A **C** module's module graph may not import an **S** module. The reference
  pins this style of constraint with unit tests — e.g. `src/vault.js` must
  never enter the `/cure` graph; the server token's graph may never include a
  data-bearing module.
- A **B** module is always: **opt-in** (a user-visible toggle), **disclosed**
  (the client UI says which APIs are connected), **quota-metered** (an atomic
  server-side meter row per grant), **time-limited** (expiring tokens),
  **fail-safe** (no meter backend → no spend, never unmetered), and
  **minimal-payload** (only the query/coordinate/host crosses — never the
  conversation, unless the capability *is* an LLM call, in which case the
  disclosure must say so explicitly).
- An **X** module must be import-safe in Node (unit-testable without a DOM or
  Worker runtime) and dependency-free.

---

## 4. The contracts (PA-1 … PA-10)

The SDK's load-bearing contracts, distilled from the reference's proven
invariants. Every module skill states which of these it touches; the generator
refuses combinations that break them. Numbered **PA** (Pair Architecture) so
skills can cite them precisely.

- **PA-1 — Deterministic orchestration; no function calling.** The
  orchestrator (worker or browser) picks every phase and every query; models
  only fill in JSON or prose, so the product works identically across any
  model catalog. Narrow, explicitly-scoped exceptions must be opt-in,
  capability-gated, and leave the deterministic path intact as the fallback
  for every model.
- **PA-2 — Helper phases fail soft.** Search, gap check, validation, and every
  enrichment degrade to a lesser result rather than erroring the chat; every
  outbound call is time-bounded. A product that sometimes returns nothing is
  worse than one that always returns something.
- **PA-3 — Split model routing.** JSON planning phases run on a fixed,
  reliable, cheap model; only synthesis (and direct replies) runs on the
  user's chosen model — regardless of provider. Token accounting and budgeting
  split the same way.
- **PA-4 — The privacy split.** Content rests as ciphertext everywhere it can,
  with narrowly-declared readable exceptions. Keys never rest beside the
  ciphertext they open. Outbound requests carry the minimum — a query, a
  coordinate, a host — never the conversation, filename, or identity. The
  client tier holds the stronger, structural form of this promise; bridged
  capabilities are its bounded, disclosed exceptions.
- **PA-5 — Minimal dependencies; no build step; evidence-driven exceptions.**
  No client transpilation ever; the worker deploys as plain source. Runtime
  dependencies require the bar "encodes knowledge this project doesn't want to
  own"; per-model special-casing must trace to a reproduced finding.
- **PA-6 — Language parity in deterministic gates.** Every regex/phrase gate
  that routes behavior takes all supported languages with the same breadth
  (the reference: Swedish + English, typos included), enforced by parity unit
  tests in the same change — never one language now, others "later".
- **PA-7 — The shared-core rule (class X).** Logic needed by both tiers is
  written ONCE as a pure, Node-testable core under the client tree; the server
  imports it through a façade re-export whose "surface IS the core" contract
  is pinned by a unit test. Hand-mirrored copies are forbidden.
- **PA-8 — The bridge discipline (class B).** All client-tier ↔ server
  crossings ride grant tokens: HMAC/JWT families under ONE root secret with
  structural namespace separation (cross-family forgery provably impossible),
  atomic per-grant metering (reserve/refund), global budget ceilings, instant
  revocation, and the guarantee that a token authorizes **upstream API access
  only — never the server tier's own data** (pinned structurally: closed
  permission vocabulary + module-graph tests + the token can never pass the
  identity gate).
- **PA-9 — Fail-safe metering.** If the meter backend is unavailable, the
  bridged capability is unavailable — there is no unmetered spend path, ever.
  (Contrast PA-2: *helper* phases fail soft; *money and quota* fail safe.)
- **PA-10 — Verify live; measure before believing.** Anything touching an
  external provider, real storage, or a real device is verified against the
  live deployment; answer-quality changes land only behind a scored benchmark;
  findings ledgers are append-only. The class-D modules exist to make this
  cheap.

**Why the bridge is a token system and not "just an API".** The pair's story
collapses if the client tier quietly calls authenticated server endpoints.
Grant tokens make every crossing *visible* (disclosed in UI), *bounded*
(quota, TTL, budget ceiling), *revocable* (delete the meter row), and
*accountable* (minted by a signed-in user or admin). The consolidated form is
one standard JWT carrying a permission set ("one ticket, one JWT") with
per-permission meter rows; the name convention ("server token") is itself a
disclosure device: nobody forgets it goes to a server somewhere.

---

## 5. The module model: baseplate + selectable features

A generated pair is assembled from **modules**. Each module is one skill in
`sdk/skills/`, one entry in `sdk/MANIFEST.json`, and maps to a bounded set of
files in the generated tree. Modules declare:

- `id`, `name`, `layer` (0–6), `class` (C/S/B/X/D)
- `deps` — module ids that must exist first (the generator's topological
  order; `sdk/ROADMAP.md` is the human rationale over the same graph)
- `skill` — the SKILL.md path
- `reference` — the files in THIS repo that realize the module today
- `provides` — the capability summary
- `acceptance` — what must be true (tests green, live probe passing) before
  the module counts as landed

**The baseplate** is the mandatory floor: `pair-architecture` (the rules),
`baseplate-worker` (the one server, even if it only serves static files at
first), and `baseplate-client` (the browser chat shell). Everything else is
selectable. Three worked selections:

| Selection | Modules | What you get |
|---|---|---|
| **Minimal client-only assistant** | baseplate + `provider-registry` (client half) + `secure-tier` + `sealed-crypto` | A `/cure`-style bring-your-own-key chat with sealed local state, deployable on any static host — zero servers |
| **Minimal pair** | the above + `identity-access` + `quota-metering` + `sse-recovery` + `research-pipeline` | Both tiers: signed-in server-orchestrated research + the client twin |
| **Full deepresearch.se** | everything in the manifest | The reference product, rebuilt |

**Feature selection is additive and ordered.** The generator takes a
selection, closes it over `deps`, sorts by layer, and emits/builds one module
at a time, each landing with its unit tests green and its acceptance checklist
satisfied before the next starts. A big-bang scaffold would generate 100+
files no one has verified — exactly the failure mode PA-10 exists to prevent.

### Platform types — what a generated app IS

A build produced through the SDK declares one of two **platform types**, and
the type is its logical boundary:

- **A client-tier build** ("Se/cure-type") is class-C only: static, no-build,
  sealed local state, browser-direct upstream APIs (the user's keys, their
  local model server, or grant tokens borrowed through the bridge). Because it
  is just static files it is **instantly runnable**: the `pair-studio` module
  preview-deploys it into an in-app pane, and the saved artifact runs from any
  static host. This is the default type, deliberately — the pair's own mission
  posture applied to what the pair builds.
- **A server-tier build** adds the one server component. The pair's own server
  **never executes or hosts generated server code** (a hard rule — anything
  else breaks the zero-or-one-server property and the trust boundary at once),
  so a server-tier build exports as a deployable bundle for the user's own
  infrastructure, while its client half can still be previewed in-app against
  generated mocks.

---

## 6. The module catalog (33 modules)

The complete registry, grouped by layer. `Deps` is the manifest's dependency
edge set — the generator's topological order.

**Layer 0 — Foundation (the mandatory baseplate)**

| Module | Class | Deps | Provides |
|---|---|---|---|
| `pair-architecture` | D | — | The contracts, capability classes, naming/wordplay convention, module-graph rules — the SDK's constitution; costs no code |
| `baseplate-worker` | S | pair-architecture | The one server: entrypoint routing, static assets + public allowlist, security headers/CSP, canonical-origin redirect, optional-D1 + lazy schema, config, logging, http helpers, `node:test` harness, zero-build typecheck |
| `baseplate-client` | C | pair-architecture | The no-build browser chat shell: glass chrome, composer, turns, sanitized markdown, SSE line parser, history sidebar, settings client, attachments, the pure-core (Node-testable) module convention |

**Layer 1 — Model & search plane**

| Module | Class | Deps | Provides |
|---|---|---|---|
| `provider-registry` | X | baseplate-worker, baseplate-client | Multi-provider LLM registry on both tiers + the hardened stream loop (the reference's worst production bugs live at this seam, so the guards are foundation, not polish) |
| `research-pipeline` | X | provider-registry | The deterministic no-function-calling research pipeline (triage → search → gap → synthesis → validation), both tiers, with the budget planner and split routing |
| `web-search` | X | baseplate-worker, baseplate-client | Default + pluggable search backends, the source registry, per-origin diversity caps |
| `enrichments` | S | research-pipeline | The opt-in context-enrichment registry (the geocode/host-intel/maps pattern) — one-file drop-ins, each bilingual from day one (PA-6) |

**Layer 2 — The two tiers**

| Module | Class | Deps | Provides |
|---|---|---|---|
| `secure-tier` | C | baseplate-client, provider-registry, sealed-crypto | The wholly-in-browser tier: sealed state, own keys, twin UX, static-host deployable |
| `identity-access` | S | baseplate-worker | OIDC sign-in, sessions, terms/approval gates, break-glass, the admin gate |
| `quota-metering` | S | identity-access | Windowed quotas, split billing, concurrency caps, alerts, the message center |
| `sse-recovery` | S | research-pipeline, baseplate-client | The SSE contract + answer recovery/relaunch/stall machinery (only provable live — PA-10) |

**Layer 3 — Privacy & storage plane**

| Module | Class | Deps | Provides |
|---|---|---|---|
| `sealed-crypto` | C | baseplate-client | User-held secrets, HKDF derivations, AES-GCM archives — the pure crypto core (frozen derivation constants from day one) |
| `ciphertext-storage` | S | identity-access, sealed-crypto | Cloud ciphertext, the blind-blob vault tier, drain-wipe — every stored byte argues PA-4 |
| `client-rag` | X | provider-registry, sealed-crypto | Chunking/embedding/retrieval over docs, projects and chats, per-tier storage postures |
| `grant-bridge` | B | identity-access, quota-metering, secure-tier, web-search | The metered grant-token bridge — the only sanctioned tier crossing (PA-8/PA-9); a new pair builds the consolidated one-JWT form directly |
| `offline-workspaces` | C | sealed-crypto, grant-bridge, secure-tier | A whole configured session sealed into one URL-fragment link |

**Layer 4 — Operations & feedback plane**

| Module | Class | Deps | Provides |
|---|---|---|---|
| `observability` | S | baseplate-worker, identity-access | Structured logs, request-id correlation, the opt-out interaction log, live-verify |
| `decision-boards` | S | identity-access, observability | Human-decides-agent-executes boards + the `?format=text` loop input format |
| `feedback-loops` | D | decision-boards, observability | Feedback threads, try-it test points, the git test-request channel |
| `eval-harness` | D | research-pipeline | Trace harness + two scored benchmarks + append-only ledgers (pull forward if tuning — baseline before believing) |
| `agent-dev-workflow` | D | pair-architecture | Skills-as-memory, fleet git discipline, regression routing, secret scanning (configure hooks/ledgers in phase 0–1; the full loop needs shipped features) |

**Layer 5 — Extension surfaces** (all leaves; product priority decides order)

| Module | Class | Deps | Provides |
|---|---|---|---|
| `execution-sandbox` | X | baseplate-client, research-pipeline | In-browser Linux VM + the fenced-block shell agent (the deepest well — treat as its own project with a standing maintenance owner) |
| `introspection-help` | X | research-pipeline, secure-tier | Self-source answering + the docs-first interactive help |
| `mcp-surface` | S | research-pipeline, identity-access, quota-metering | The pair exposed as an MCP tool — the strategic outbound edge |
| `publish-replays` | S | secure-tier, baseplate-worker | Frozen research sessions as public replay pages |
| `symbol-language` | X | baseplate-client | Per-tier symbols, disclosure grammar, wordmark discipline, the UX-conventions registry |
| `games-shelf` | S | identity-access | The registry seam for whole product surfaces (worked example: a game) |
| `exec-engine` | X | execution-sandbox | The execution engine under the sandbox: CheerpX (decided), our own small fast self-hosted image with full prefetch, the thin `ExecEngine` seam + fallback ladder as future-proofing |
| `vm-toolchain` | X | exec-engine, execution-sandbox, introspection-help | The SDK inside the prepackaged Linux VM: the `/src/sdk` mount, the in-app `sdk/<name>` skills catalog, desktop parity |
| `workspace-fs` | S | execution-sandbox, exec-engine, mcp-surface | Fast-track file plane: read/write/edit/grep/glob via MCP hit a host-side store directly; only shell routes through the VM (sync-in → exec → harvest). Server-tier only |

**Layer 6 — Generation, studio & deploy**

| Module | Class | Deps | Provides |
|---|---|---|---|
| `pair-generator` | D | pair-architecture | Selection → dependency closure → module-at-a-time generation; adoption mode for wiring an existing product. Meta — used from day one, listed last |
| `pair-studio` | X | vm-toolchain, secure-tier, pair-generator | The in-app builder: prompt → SDK-guided generation in the VM → preview deploy in the same UI → save as a runnable test application |
| `deploy-pipeline` | S | workspace-fs, pair-studio, grant-bridge | Deploy the workspace and try it LIVE: a same-origin preview URL for client-tier builds, a push to the user's own edge account for server-tier builds (never the pair's origin). Server-tier only |

### The skill shape

Each `sdk/skills/<id>/SKILL.md` follows one shape: **capability class & tier
story** → the **PA contracts** it carries → a from-scratch **build plan** →
the **reference implementation map** into this repo → an **acceptance
checklist** → **pitfalls** (the institutional memory: real incidents,
evidence-driven decisions). The frontmatter `description` is the load trigger,
exactly like the operational skills'.

---

## 7. The CLI (`sdk/pair-cli.mjs`)

A dependency-free Node CLI over the manifest — the mechanical half of module
selection. Unit-tested by `sdk/pair-cli.test.mjs` as part of the repo's
`npm test`.

```bash
node sdk/pair-cli.mjs list            # the catalog, grouped by layer
node sdk/pair-cli.mjs show <id>       # one module: class, deps, provides, skill, reference, acceptance
node sdk/pair-cli.mjs plan <id ...>   # dependency closure of a selection → build order
node sdk/pair-cli.mjs validate       # manifest integrity + class rules (run before committing a manifest change)
```

`plan` is the generator's first step made inspectable: give it a selection
(e.g. `plan secure-tier research-pipeline`) and it prints the closed,
layer-sorted module order to build. `validate` enforces the registry's
integrity (every module's skill file exists, deps resolve, class rules hold)
and is also test-pinned, so a broken manifest fails `npm test`.

The same CLI runs **inside the pair's own sandbox VM**: the SDK is mounted at
`/src/sdk` (the `vm-toolchain` module), so with a nodejs-equipped image,
`node /src/sdk/pair-cli.mjs …` works from within the browser's own Linux.

The SDK's second CLI is `sdk/drpl.mjs` — the **DRPL/1** pipeline-language
reference tooling (spec: `docs/PIPELINE-LANGUAGE.md`; unit-tested by
`sdk/drpl.test.mjs`), which makes a pair's pipeline structure a comparable
artifact:

```bash
node sdk/drpl.mjs validate <f.drpl.json>       # structural validation
node sdk/drpl.mjs show <f>                     # the phase table (dataflow, placement, calls)
node sdk/drpl.mjs fingerprint <f> [--level shape|placement|full] [--spine]
node sdk/drpl.mjs diff <a> <b> [--level …] [--spine]
```

The two committed examples (`docs/examples/*.drpl.json`) encode the
reference pair's deployed pipelines; their test-pinned property — identical
at spine-shape, different at placement — is the pair abstraction (§2)
stated as two hashes.

---

## 8. Implementation order (the roadmap, condensed)

`sdk/ROADMAP.md` is the human rationale over the manifest's dependency graph.
Two principles drive every ordering decision: **every intermediate state is a
working product** (modules land one at a time, tests green, acceptance
satisfied), and **fail-soft design makes early ordering cheap** (PA-2 — the
pipeline can land before web search exists, search before enrichments, the
server tier before cloud storage).

| Phase | Modules | The point | Exit criterion |
|---|---|---|---|
| **0 — Foundation** | pair-architecture, baseplate-worker, baseplate-client | Lock the contracts and the name/wordplay — the only decisions that get more expensive with every later module | A deployed "hello pair" page served by the one worker, tests + typecheck green, headers verified live |
| **1 — Model plane** | provider-registry, research-pipeline, web-search, enrichments | The product's spine; the pipeline lands BEFORE search exists (PA-2's ordering trick) | Both tiers produce researched, cited answers end to end, pipeline unit-tested against a mock provider |
| **2 — The two tiers** | sealed-crypto (pulled forward), secure-tier, identity-access, quota-metering, sse-recovery | The client tier FIRST — the stricter posture makes every later server capability argue its way in; never open sign-ups before quotas | The pair exists as a pair; class-C module-graph pins green |
| **3 — Privacy & storage** | ciphertext-storage, client-rag, grant-bridge, offline-workspaces | Every module here is defined by which tier it must NOT touch; the bridge builds last against stable subsystems | Cross-subsystem grant invariant suite green; a workspace link round-trips mint → seal → open → hydrate → spend → pause → revoke |
| **4 — Operations & loops** | observability, eval-harness, decision-boards, feedback-loops, agent-dev-workflow | Timed by people, not code: land when real users generate signal and agent sessions work in parallel | A keyword-only bug report can be traced, fixed with the verbatim message as a regression test, and verified live |
| **5 — Extensions** | execution-sandbox, introspection-help, mcp-surface, publish-replays, symbol-language, games-shelf, exec-engine, vm-toolchain, workspace-fs | All leaves; order by product priority, not dependency | Each lands independently with its own acceptance |
| **6 — Generation, studio & deploy** | pair-generator, pair-studio, deploy-pipeline | The generator is used from day one (meta); the studio is the capstone — the generator's walk moved into the product | Prompt → generated client-tier app previewed in-session → exported bundle runs from a plain static host; a built workspace deploys to a live URL |

Sequencing note (PA-10): if any pipeline-quality tuning beyond the defaults is
planned, pull `eval-harness` forward to land immediately after
`research-pipeline` — the reference's canonical lesson is three plausible
pipeline upgrades that benchmarked net-negative and shipped OFF.

---

## 9. Using the SDK

**From a desktop** (any editor, any agent harness): clone the repo and work
the skills directly — `node sdk/pair-cli.mjs list` for the catalog, `plan
<modules>` for a build order, `validate` before committing a manifest change.
The vendor-neutral `AGENTS.md` at the repo root points any coding agent at
both skill catalogs (operational + SDK).

**From the application itself:** the SDK rides the committed source snapshot,
so both tiers can browse and quote every SDK skill in-app through
introspection mode (cataloged as `sdk/<name>` next to the operational
playbooks — see `public/js/introspect-core.js`), and the sandbox VM mounts the
whole SDK at `/src/sdk`. The `pair-studio` module is the full in-app loop:
prompt an app, have it designed in the VM, try it in a preview pane in the
same UI, save it as a runnable test application.

**To learn the architecture:** read this document, then `sdk/DESIGN.md`, then
the `pair-architecture` skill.

**To generate a new pair from scratch:** load the `pair-generator` skill. In
short: pick a selection (the baseplate is mandatory; §5's worked selections
are the calibration points), close it over the manifest's dependencies
(`pair-cli.mjs plan`), then walk the roadmap's phase order executing one
module skill at a time, landing each with its tests green and acceptance
checklist satisfied before starting the next.

---

## 10. Relationship to the existing application (adoption mode)

Nothing in `sdk/` is imported by `src/` or `public/` today. The later wiring
task proceeds per module, in the manifest's dependency order:

1. Pick a module; read its skill's "reference implementation" map.
2. Extract/align the reference files to the module's stated contract (usually
   a no-op — the skills were written FROM the reference).
3. Add the module's acceptance tests if any are missing.
4. Record the binding in the manifest (`reference` is already the pointer).

Because the skills were distilled from the live code and its documented
incident history, "wiring up" is mostly *adoption of the SDK's names and
acceptance gates*, not a rewrite — and recreating the entire site from scratch
is the same walk in generation mode instead of adoption mode. That is also the
swap discipline: replace one module's files with the SDK-generated equivalent,
hold the acceptance checklist constant, and the swap is provably
behavior-preserving.

---

## 11. Relationship to the rest of the documentation

- **`.claude/skills/` (operational)** — run and maintain THIS deployment. The
  SDK skills are *constructive* — build the capability in a fresh repo (or
  bind it here). They deliberately share vocabulary and cite the same incident
  history; where an operational skill already documents a procedure, the SDK
  skill points at it rather than duplicating it.
- **`docs/ARCHITECTURE.md`** — describes the deployed system as it runs today;
  the SDK describes the same system as a buildable module registry. The two
  views are reconciled through each module's `reference` file list.
- **Design docs the SDK cites as module deep-dives:** `docs/JS-VM-RESEARCH.md`
  (the exec-engine decision matrix), `docs/WORKSPACE-FS-DESIGN.md` (the
  workspace-fs file plane), `docs/WORKSPACE-SECURITY.md` (offline-workspaces),
  `docs/SERVER-TOKENS.md` (the grant-bridge's consolidated JWT),
  `docs/SYMBOL-LANGUAGE.md` (symbol-language), `docs/DECISION-BOARD-LOOPS.md`
  (decision-boards / feedback-loops).
- **This document** rides the documentation corpus (`scripts/bundle-docs.mjs`
  → `public/introspect/docs-corpus.json`), so the in-app HELP layer can answer
  SDK questions from the documentation itself; the SDK skill *bodies* ride the
  source snapshot's skills catalog. Editing `sdk/` or this file therefore
  means regenerating the committed introspection artifacts (`npm run bundle`,
  `bundle:rag`, `bundle:docs`, `bundle:docs-rag`) like any other tracked-text
  change — `npm test` names the drift if forgotten.

**What the SDK does NOT promise.** It does not make a pair production-ready
(the reference itself is explicitly experimental); it does not abstract away
providers' wire quirks (skills document them instead); and it does not let a
selection violate the contracts — there is no flag to "just this once" put the
server in the client tier's data path.

---

## 12. Maintaining the SDK and this document

- **Manifest edits:** run `node sdk/pair-cli.mjs validate` (also test-pinned —
  a broken manifest fails `npm test`). A new module needs its manifest entry,
  its `sdk/skills/<id>/SKILL.md`, a `sdk/ROADMAP.md` phase placement, and its
  rows here (§6) and in `sdk/README.md`, in the same commit.
- **This document mirrors `sdk/`** the way `FEATURES.md` §3 mirrors
  `src/features.js`: hand-maintained, updated in the same commit as the thing
  it describes. The catalog in §6 must match `sdk/MANIFEST.json` (module ids,
  classes, deps); the contracts in §4 must match `sdk/DESIGN.md` §2.
- **Artifact regeneration:** any edit to this file or to `sdk/` is a
  tracked-text change — regenerate the introspection artifacts and run
  `npm test` before pushing.
