# DistillSDK — design

**DistillSDK is the internal codename for the DeepResearch Platform SDK** — the
SDK that builds a whole **platform** (an entire DeepResearch.se-like agent
platform: a client tier + at most one server tier).
Its companion, the DeepResearch Agents SDK, builds a single **agent** inside a
platform and is tailored specifically to Agent Studio and the integrated Linux
environment (the execution sandbox).

**Status: designed 2026-07-16; WIRED into the running application since
2026-07-18** — the manifest logic and SDK-mode tool surface live in the shared
core `public/js/sdk-core.js` (server façade `src/sdk-tools.js`; `sdk/pair-cli.mjs`
re-exports it), consumed by Agent Studio, the `/mcp` `sdk_*` tools, and the
sandbox's `/src` mount. This directory is a
complete, self-contained software development kit for building **platforms**
like DeepResearch.**Se/cure** + DeepResearch.**Se/rver**: one AI assistant
product shipped as two tiers of the same capability set, where the platform as a
whole has **zero or one server component** between the chat client running in
the browser and the optional upstream APIs it fetches data from.

The SDK has three parts:

1. **This design** — the platform abstraction and the contracts every
   generated platform must preserve.
2. **The skill library** (`sdk/skills/*/SKILL.md`) — one buildable capability
   module per skill, covering the entire capability foundation of
   deepresearch.se, each with a from-scratch build plan, the reference
   implementation map into this repo, and an acceptance checklist.
3. **The manifest + roadmap** (`sdk/MANIFEST.json`, `sdk/ROADMAP.md`) — the
   machine-readable module registry with dependencies, and the rationale for
   the order in which modules are implemented.

The reference implementation for every module **is this repository**. The SDK
is written so that (a) a fresh platform can be generated from scratch by
selecting modules from the baseplate, and (b) the existing deepresearch.se can
later be wired up to SDK components module-by-module, because each skill's
"reference implementation" section names the exact files that already realize
it.

---

## 1. The platform abstraction

A **platform** is one product, two tiers:

- **The client tier** (archetype: DeepResearch.**Se/cure**, `/cure`) — the
  assistant runs **wholly in the browser**. No accounts. The server — if one
  exists at all — serves static bytes and public read-only JSON, and is in
  **no data path**: model calls go browser-direct to the user's own
  CORS-capable providers (or their own local OpenAI-compatible server, in
  which case *no third party* receives the conversation), the
  research/orchestration pipeline runs client-side, and all state (chats,
  settings, API keys) rests sealed in browser-local storage under user-held
  secrets. The tier's privacy is **structural**: the server could not log
  content or keys even in principle.
- **The server tier** (archetype: DeepResearch.**Se/rver**, `/rver`) — the
  signed-in assistant. Exactly **one server component** (an edge worker) sits
  between the browser chat client and the upstream APIs, owning
  orchestration, identity, quotas, metering, cloud storage, observability,
  and the admin surface.

**The zero-or-one-server property.** Across the whole platform there is at most
one server component. There is no microservice mesh, no separate auth
service, no search proxy fleet: every server-side responsibility lives in the
one worker, and the client tier must remain fully functional with that worker
reduced to a static file host (or replaced by any static host). This is the
property the SDK exists to preserve — it is what makes the platform's privacy
claims *auditable*: the client tier's guarantees follow from the absence of a
server in the data path, not from a policy document.

**Naming convention.** The platform's two tiers are named by one wordplay: a
shared brand stem whose URL path completes a word per tier
(`DeepResearch.Se` + `/cure` → "Secure"; + `/rver` → "Server"). A generated
platform may pick any stem/wordplay, but the convention carries real rules the
reference product codified: the display form is CamelCase-with-bold-tail
(DeepResearch.**Se/cure**), functional URLs stay lowercase, the short form is
the slashed tail alone (**Se/cure**), and whenever the two tiers are named
together the client tier comes FIRST (secure-first). Internal code names
(DRC/DRS in the reference) never appear in user-facing copy. See the
`symbol-language` skill.

### 1.1 Capability classes

Every SDK module is classified by where it can run. This classification is
the heart of the design — it is what "preserving the properties" means:

| Class | Meaning | Examples |
|---|---|---|
| **C — client-pure** | Implementable with no server in the data path. Must work on a static host. | sealed client crypto, browser-direct provider registry, the client-side pipeline, client RAG, offline workspace links |
| **S — server-backed** | Requires the one server component. Only ever exists in the server tier. | identity/accounts, quotas, cloud ciphertext storage, interaction logs, admin boards, the MCP surface |
| **B — bridged** | A server capability *lent* to a client-tier session through metered grant tokens — the ONLY sanctioned way the client tier touches the server. | granted web search, proxied LLM completions, the consolidated server token |
| **X — shared substrate** | Pure logic used by BOTH tiers: one implementation as a pure core under the client's module tree, re-exported by a server façade. | pipeline input builders, bash-core, introspect-core, websearch-backends-core |
| **D — development system** | Not product code: the loops, evals, boards and workflows that keep the platform maintainable by agent sessions. | eval harness, decision boards, feedback/test loops, git/merge discipline |

Class rules the generator enforces:

- A **C** module's module graph may not import an **S** module. (The
  reference pins this style of constraint with unit tests — e.g. `vault.js`
  must never enter the `/cure` graph; the server token's graph may never
  include a data-bearing module.)
- A **B** module is always: **opt-in** (a user-visible toggle), **disclosed**
  (the client UI says which APIs are connected), **quota-metered** (an atomic
  server-side meter row per grant), **time-limited** (expiring tokens),
  **fail-safe** (no meter backend → no spend, never unmetered), and
  **minimal-payload** (only the query/coordinate/host crosses — never the
  conversation, unless the capability *is* an LLM call, in which case the
  disclosure must say so explicitly).
- An **X** module must be import-safe in Node (unit-testable without a DOM or
  Worker runtime) and dependency-free.

### 1.2 Where the platform sits between the browser and upstream APIs

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

The upstream APIs themselves are **optional**: a client-tier session against
a local model server has *no* upstream third party at all, and a platform can be
generated with no web search, no maps, no enrichment — the baseplate plus a
provider registry is already a working product.

---

## 2. The contracts (platform invariants)

These are the SDK's load-bearing contracts, distilled from the reference
implementation's proven invariants. Every module skill states which of these
it touches; the generator refuses combinations that break them. Numbered
**PA-1 … PA-10** (Pair Architecture) so skills can cite them precisely.

- **PA-1 — Deterministic orchestration; no function calling.** The
  orchestrator (worker or browser) picks every phase and every query; models
  only fill in JSON or prose. Every pipeline phase is a direct JSON-mode or
  streamed call, so the product works identically across any catalog,
  including models with unreliable tool-calling. Narrow, explicitly-scoped
  exceptions (the reference's developer-mode source-investigation tool loop)
  must be opt-in, capability-gated, and leave the deterministic path intact
  as the fallback for every model.
- **PA-2 — Helper phases fail soft.** Search, gap check, validation, and
  every enrichment degrade to a lesser result rather than erroring the chat.
  Every outbound call is time-bounded so a hung backend can't defeat this. A
  product that sometimes returns nothing is worse than one that always
  returns something.
- **PA-3 — Split model routing.** JSON planning phases run on a fixed,
  reliable, cheap model; only synthesis (and direct replies) runs on the
  user's chosen model — regardless of which provider serves it. Token
  accounting and budgeting split the same way.
- **PA-4 — The privacy split.** Content rests as ciphertext everywhere it
  can (browser and cloud alike), with narrowly-declared readable exceptions
  (RAG-indexed material, and any explicitly-disclosed interaction log with a
  per-conversation opt-out). Encryption keys never rest beside the
  ciphertext they open. Outbound requests to third parties carry the minimum
  — a query, a coordinate, a host — never the conversation, filename, or
  identity. The client tier holds the stronger, structural form of this
  promise; bridged capabilities are its bounded, disclosed exceptions.
- **PA-5 — Minimal dependencies; no build step; evidence-driven
  exceptions.** No client transpilation ever; the worker is deployed as
  plain source. Runtime dependencies require the bar "encodes knowledge this
  project doesn't want to own"; per-model special-casing must trace to a
  reproduced finding.
- **PA-6 — Language parity in deterministic gates.** Every regex/phrase gate
  that routes behavior takes all supported languages with the same breadth
  (the reference: Swedish + English, typos included), enforced by parity
  unit tests in the same change — never one language now, others "later".
- **PA-7 — The shared-core rule (class X).** Logic needed by both tiers is
  written ONCE as a pure, Node-testable core under the client tree; the
  server imports it through a façade re-export whose "surface IS the core"
  contract is pinned by a unit test. Hand-mirrored copies are forbidden —
  the reference converged on this after real drift.
- **PA-8 — The bridge discipline (class B).** All client-tier ↔ server
  crossings ride grant tokens: HMAC/JWT families under ONE root secret with
  structural namespace separation (cross-family forgery must be provably
  impossible), per-grant metering rows updated atomically
  (reserve/refund), global budget ceilings, instant revocation, and the
  guarantee that a token authorizes **upstream API access only — never the
  server tier's own data** (pinned structurally: closed permission
  vocabulary + module-graph tests + the token can never pass the identity
  gate).
- **PA-9 — Fail-safe metering.** If the meter backend is unavailable, the
  bridged capability is unavailable — there is no unmetered spend path, ever.
  (Contrast PA-2: *helper* phases fail soft; *money and quota* fail safe.)
- **PA-10 — Verify live; measure before believing.** Anything touching an
  external provider, real storage, or a real device is verified against the
  live deployment; answer-quality changes land only behind a scored
  benchmark; findings ledgers are append-only. The development system
  (class D modules) exists to make this cheap.

---

## 3. The module model: baseplate + selectable features

A generated platform is assembled from **modules**. Each module is one skill in
`sdk/skills/`, one entry in `sdk/MANIFEST.json`, and maps to a bounded set of
files in the generated tree. Modules declare:

- `id`, `name`, `layer` (0–5, see ROADMAP.md), `class` (C/S/B/X/D)
- `deps` — module ids that must exist first (the generator's topological
  order; ROADMAP.md is the human rationale over the same graph)
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
| **Minimal platform** | the above + `identity-access` + `quota-metering` + `sse-recovery` + `research-pipeline` | Both tiers: signed-in server-orchestrated research + the client twin |
| **Full deepresearch.se** | everything in MANIFEST.json | The reference product, rebuilt |

**Feature selection is additive and ordered.** The generator (see the
`pair-generator` skill) takes a selection, closes it over `deps`, sorts by
layer, and emits/builds one module at a time, each landing with its unit
tests green and its acceptance checklist satisfied before the next starts.
That is also the wiring path for the existing site: replace one module's
files with the SDK-generated equivalent, hold the acceptance checklist
constant, and the swap is provably behavior-preserving. The mechanical half
is tooled: `sdk/pair-cli.mjs` (`list` / `show` / `plan` / `validate`)
computes closures, build orders, and manifest integrity — on a desktop
checkout or inside the platform's own sandbox VM (`node /src/sdk/pair-cli.mjs`).

### 3.1 Platform types — what a generated app IS

A build produced through the SDK declares one of two **platform types**,
and the type is its logical boundary:

- **A client-tier build** ("Se/cure-type" in the reference) is class-C only:
  static, no-build, sealed local state, browser-direct upstream APIs (the
  user's keys, their local model server, or grant tokens borrowed through
  the bridge). Because it is just static files, it is **instantly
  runnable**: the `pair-studio` module preview-deploys it into an in-app
  pane, and the saved artifact runs from any static host. This is the
  default type, and deliberately so — it is the platform's own mission posture
  applied to what the platform builds.
- **A server-tier build** adds the one server component. The platform's own
  server **never executes or hosts generated server code** (a hard rule —
  anything else breaks the zero-or-one-server property and the trust
  boundary at once), so a server-tier build exports as a deployable bundle
  for the user's own infrastructure, while its client half can still be
  previewed in-app against generated mocks.

The full prompt → design-in-the-VM → try-out-in-the-same-UI loop over these
types is the `pair-studio` module; the VM-side development environment (the
SDK mounted inside the prepackaged Linux, the small self-hosted image, the
in-app skills catalog) is the `vm-toolchain` module.

---

## 4. Design decisions worth stating once

**Why skills, not a framework.** The reference codebase's entire bug history
is integration behavior — hung fetches, silent stream truncation, CPU
ceilings, model quirks — which frameworks hide rather than prevent
(`docs/ARCHITECTURE-ROADMAP.md` §7). The SDK therefore ships *knowledge*
(skills with contracts, build plans, and acceptance tests) plus a thin
generator, not a runtime library. Generated platforms own their `fetch` calls and
their stream loops, exactly like the reference does. A skill is also the unit
an agent session can actually execute — which is how both the reference and
any generated platform are, in practice, built.

**Why the worker is the only server.** One deployable, one routing table, one
security-header function, one identity gate: auditable by reading a single
module graph. Serverless-edge (Cloudflare Workers in the reference) makes
"one server component" cheap to hold — no fleet to grow into. The design
survives platform swaps (Deno Deploy, Bun on a VPS) because the skills state
the *contract* (routing, D1-equivalent optionality, R2-equivalent blob
store), not the vendor API.

**Why the client tier is not a demo.** Se/cure is the mission's proof — how
far a useful assistant can be pushed toward *provable* privacy. So class C
modules are first-class citizens with the same pipeline invariants (PA-1,
PA-2, PA-3 all hold client-side in `drc-research.js`), not a feature-reduced
teaser. The SDK keeps this: every capability skill states its client-tier
story (implementable / bridged / honestly server-only).

**Why the bridge is a token system and not "just an API".** The platform's story
collapses if the client tier quietly calls authenticated server endpoints.
Grant tokens make every crossing *visible* (disclosed in UI), *bounded*
(quota, TTL, budget ceiling), *revocable* (delete the meter row), and
*accountable* (minted by a signed-in user or admin) — and their crypto keeps
families mutually unforgeable under one root secret. The consolidated form is
one standard JWT carrying a permission set ("one ticket, one JWT") with
per-permission meter rows; the name convention ("server token") is itself a
disclosure device: nobody forgets it goes to a server somewhere.

**Why generation is module-at-a-time, not one big scaffold.** Each module
lands verified (unit tests + acceptance) before the next begins, mirroring
how the reference was actually built and keeping every intermediate state a
working product. A big-bang scaffold would generate 100+ files no one has
verified, exactly the failure mode PA-10 exists to prevent.

**What the SDK does NOT promise.** It does not make the platform
production-ready (the reference itself is explicitly experimental); it does
not abstract away providers' wire quirks (skills document them instead); and
it does not let a selection violate the contracts — there is no flag to "just
this once" put the server in the client tier's data path.

---

## 5. Relationship to the existing application

Nothing in `sdk/` is imported by `src/` or `public/` today. The later wiring
task proceeds per module, in the manifest's dependency order:

1. Pick a module; read its skill's "reference implementation" map.
2. Extract/align the reference files to the module's stated contract
   (usually a no-op — the skills were written FROM the reference).
3. Add the module's acceptance tests if any are missing.
4. Record the binding in the manifest (`reference` is already the pointer).

Because the skills were distilled from the live code and its documented
incident history, "wiring up" is mostly *adoption of the SDK's names and
acceptance gates*, not a rewrite — and recreating the entire site from
scratch is the same walk in generation mode instead of adoption mode.
