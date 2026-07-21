# DistillSDK — implementation order and rationale

This document is the human rationale over `sdk/MANIFEST.json`'s dependency
graph: the order in which a new pair's modules should be implemented, why
that order and not another, and what "done" means at each phase. The
`pair-generator` skill executes this order mechanically; this file explains
it. The same order, run in *adoption mode*, is the plan for wiring the
existing deepresearch.se to SDK components later.

Two principles drive every ordering decision:

1. **Every intermediate state is a working product.** Modules land one at a
   time, tests green and acceptance satisfied, so the pair is demoable and
   verifiable after every single module — never a scaffold awaiting a big
   bang. This is how the reference was actually built (a weekend chat site
   first; everything else accreted onto a working core).
2. **Fail-soft design makes early ordering cheap (PA-2).** Because helper
   capabilities degrade instead of erroring, the pipeline can land before
   web search exists, search before enrichments exist, the server tier
   before cloud storage exists. Ordering exploits this: build the spine,
   then light up limbs in value order.

---

## Phase 0 — Foundation (modules: `pair-architecture`, `baseplate-worker`, `baseplate-client`)

**Build first, always.** Nothing else can exist without it, and the two
decisions it locks in — the pair's contracts and its name/wordplay — are the
only ones that get more expensive to change with every later module.

- `pair-architecture` costs no code: it is the decision record. Choose the
  brand stem and the two-tier wordplay NOW — it flows into URL paths, publish
  slugs, symbol characters and copy everywhere downstream. Adopt the PA
  contracts explicitly; later skills cite them by number.
- `baseplate-worker` before `baseplate-client` by a nose: the worker serves
  the client, and its test/typecheck/deploy harness is the delivery pipeline
  every later module rides. Keep it degenerate — routing, assets, headers,
  logging, optional-D1 — and resist adding features here; the whole point of
  the module model is that features are separate, selectable things.
- **Exit criterion:** a deployed page served by the one worker, `npm test`
  and typecheck green, security headers verified live. A "hello pair".

## Phase 1 — The model plane (modules: `provider-registry`, `research-pipeline`, then `web-search`, `enrichments`)

**The product's spine.** A chat assistant that answers well is the value;
everything else is posture around it.

- `provider-registry` first — no model calls, no product. Both halves land
  together (server registry + client CORS registry) because PA-7 wants their
  shared shapes decided once. The hardened stream loop is part of this
  module deliberately: the reference's worst production bugs (hung fetches,
  silent truncation, missing `finish_reason`) live at this seam, so the
  guards are foundation, not polish.
- `research-pipeline` second, **before web search exists**. This is the
  ordering trick PA-2 buys: triage → (empty search) → synthesis → validation
  runs fine with zero sources — you ship a working direct-answer assistant
  and the full phase machinery, budget planner and split routing (PA-3) get
  real traffic before search costs a cent. The client-tier port lands in the
  same phase from the same prompts, keeping the twin honest from day one.
- `web-search` third: the search wave lights up inside an already-tested
  pipeline. The source registry and diversity caps come with it.
- `enrichments` last and strictly optional: each is a one-file drop-in by
  construction, so they can trickle in forever. Do not build any enrichment
  before its intent gate can be written bilingual (PA-6) — parity is part of
  the definition of done, not a follow-up.
- **Exit criterion:** both a server-tier and a client-tier conversation
  produce researched, cited answers end to end (client tier on the
  builder's own key), with the pipeline flow unit-tested against a mock
  provider on both tiers.

**Sequencing note on measurement:** if any pipeline-quality tuning beyond
the defaults is planned, pull `eval-harness` (phase 4) forward to land
immediately after `research-pipeline`. PA-10 makes a scored baseline a
precondition for tuning — the reference's canonical lesson is three
plausible pipeline upgrades that benchmarked net-negative and shipped OFF.

## Phase 2 — The two tiers become real (modules: `sealed-crypto`*, `secure-tier`, `identity-access`, `quota-metering`, `sse-recovery`)

**The pair property is the mission — establish it early, while the surface
area is small.** Retrofitting a client tier onto a server-assuming codebase
is exactly the trap the SDK exists to avoid.

- `sealed-crypto` is cataloged in layer 3 but is pulled forward here by the
  dependency closure: the secure tier's defining property (sealed local
  state, keys inside the blob) needs it on day one. Building it early also
  forces the frozen-derivation-constants discipline before there is any
  stored state to migrate.
- `secure-tier` before the server tier's identity stack. This is deliberate
  and slightly counterintuitive: the client tier is the *stricter* posture,
  and building it first means every later server-side capability must argue
  its way in (as class S or B), rather than the client tier having to argue
  server dependencies *out*. It also gives the pair its proof-of-mission
  artifact earliest.
- `identity-access` then `quota-metering`, in that order — metering needs
  identities to meter. Do not open sign-ups before quotas exist: the
  reference's model is approval-gated accounts with windowed quotas from the
  start, because an LLM product's marginal cost is real money (PA-9 thinking
  applies to your own wallet too).
- `sse-recovery` completes the server tier's chat transport once real users
  with real phones exist — its machinery (answer cache, relaunch marker,
  stall watchdogs) is only provable live (PA-10), so it lands when there is
  a live product to prove it on.
- **Exit criterion:** the pair exists as a pair — a visitor uses the client
  tier with their own key; a signed-in user uses the server tier under
  quota; the tier-crossing affordances (dimmed buttons, explainers) point
  each way; class-C module-graph pins are green.

## Phase 3 — The privacy & storage plane (modules: `ciphertext-storage`, `client-rag`, `grant-bridge`, `offline-workspaces`)

**Persistence and the bridge — after both tiers stand, because every module
here is defined by which tier it must NOT touch.**

- `ciphertext-storage` first: the server tier's knob-gated cloud storage,
  the vault tier, and the drain-wipe. Landing it after `secure-tier` keeps
  the asymmetry honest — the client tier already works with zero server
  storage, so every byte the server stores needs the PA-4 argument written
  down (ciphertext, or a declared readable exception).
- `client-rag` next: it spans both tiers and both storage postures, so it
  wants sealed-crypto, storage and the provider registry all settled.
- `grant-bridge` after everything it bridges. The bridge is the pair's most
  security-sensitive module; building it late means the things it lends
  (search, completions) and the identities that mint it are already stable,
  and the full invariant checklist (forgery matrix, meters, budgets,
  account binding, module-graph pin) can run against real subsystems. Build
  the consolidated one-JWT form directly in a new pair — the reference's
  three-family history is evolution baggage a fresh pair skips (its skill
  documents the legacy families so adoption mode can still reason about
  them).
- `offline-workspaces` last: it composes sealed-crypto's link crypto with
  grant-bridge's embeddable tokens; both must be frozen first.
- **Exit criterion:** the cross-subsystem grant invariant suite green over
  a combined meter-backend fake; a workspace link round-trips
  mint → seal → open → hydrate → spend → pause → revoke.

## Phase 4 — Operations & the feedback loops (modules: `observability`, `eval-harness`, `decision-boards`, `feedback-loops`, `agent-dev-workflow`)

**The loops that keep the pair alive once humans and agent fleets touch
it.** Minimal logging already exists (baseplate); this phase is the full
apparatus, and its timing is driven by people, not code: land it when real
users generate real signal and multiple agent sessions work in parallel.

- `observability` first — the interaction log (with its opt-out contract),
  request-id correlation and the admin read APIs are what every other loop
  consumes. Note the declared PA-4 exception must be written into the
  privacy copy the moment the log exists, not later.
- `eval-harness` here at the latest (earlier per the phase-1 note).
- `decision-boards` before `feedback-loops`: the boards are the mechanism;
  the feedback/test loops are its heaviest consumers.
- `agent-dev-workflow` is cheap and mostly configuration (hooks, ledgers,
  skill structure) — but it multiplies in value with fleet size, so set it
  up the moment more than one session works the repo. In practice the
  reference adopted it mid-life and paid a reconciliation cost (the merge
  barrier exists because of it); a new pair should adopt it in phase 0–1
  and skip that tax. It sits in this phase only because its full loop
  (regression routing, maintenance owners, PR watching) presumes shipped
  features to maintain.
- **Exit criterion:** a bug report that is only a keyword can be traced,
  fixed at the right layer with the verbatim message as a regression test,
  and verified live — the loop the reference runs daily.

## Phase 5 — Extension surfaces (modules: `execution-sandbox`, `introspection-help`, `mcp-surface`, `publish-replays`, `symbol-language`, `games-shelf`)

**All leaves; order by product priority, not dependency.** Each is
independently selectable and none blocks another. Guidance rather than
order:

- `symbol-language` earns its place as soon as the pair has public users —
  it is the identity system, and its wordmark/disclosure grammar touches
  copy everywhere, so earlier is cheaper. (A pair that skips it should
  still adopt its UX-conventions registry; that part is nearly free.)
- `introspection-help` pairs naturally with a public "how are you built"
  story and doubles as the help system — high leverage for an
  open-source-as-proof product (the mission posture the reference takes).
- `mcp-surface` is the strategic outbound edge: the pair as infrastructure
  other agents compose with. Cheap (one file, no dependency) once the
  pipeline and identity exist.
- `execution-sandbox` is the deepest well — treat it as its own project
  with a standing maintenance owner (the reference's regression history
  says so).
- `exec-engine` sits under the sandbox: the engine is **CheerpX** (decided —
  proprietary, i386, not source-built, accepted), and the substance is
  building **our own SMALL, FAST image from scratch** (a reproducible
  Alpine-i386 recipe, tools pinned and added as we go), self-hosted from our
  origin, with **full prefetch** so it loads quickly and commands never stall
  fetching hundreds of MB. The thin `ExecEngine` seam + the c2w/v86/qemu
  fallback ladder are recorded as optional future-proofing, not a migration.
  Decision matrix: `docs/JS-VM-RESEARCH.md`.
- `vm-toolchain` follows `exec-engine` + `introspection-help` when the pair
  should become its own development environment: the small fast Alpine image
  loaded in its entirety by prefetch, the SDK mounted in-VM, and the in-app
  `sdk/<name>` skills catalog. Verified-gate before any image becomes fleet
  default.
- `workspace-fs` layers on `exec-engine` + `mcp-surface` once the sandbox is a
  place real coding happens: it makes the answer model's file work
  (read/edit/grep/glob) fast by routing it host-side through MCP tools, and
  keeps only shell in the VM via the sync-in→exec→harvest coherence protocol.
  Server-tier only — it presumes an MCP-client model and a server host, both
  of which Se/cure lacks. It is the file-plane the studio and the deploy
  pipeline build on. Design: `docs/WORKSPACE-FS-DESIGN.md`.
- `publish-replays` and `games-shelf` are small and land whenever wanted.

## Phase 6 — Generation, studio & deploy (modules: `pair-generator`, `pair-studio`, `deploy-pipeline`)

`pair-generator` is not a build phase: the generator skill is *used* from
day one (it is how phases 0–5 are executed) and is listed last only because
it is meta. Its adoption mode — wiring an existing product to SDK modules
one at a time, holding each module's acceptance checklist constant across
the swap — is the later task for deepresearch.se itself, and follows this
same phase order.

`pair-studio` IS a build phase — the capstone: the generator's walk moved
into the product itself. It lands last by dependency reality (it composes
the sandbox, the VM toolchain, the secure tier and the generator), and its
ordering rationale is the same twin argument as phase 2: the **client-tier
platform type first** — a generated client-tier app is class-C static
files, so "try it out" is an in-UI preview pane with zero hosting risk,
while server-tier builds are exports by rule (the pair's server never hosts
generated server code). Exit criterion: prompt → generated client-tier app
previewed in the same session → exported bundle runs from a plain static
host.

`deploy-pipeline` promotes the studio's in-tab preview to a real live
deploy: a same-origin preview URL for a static build, or a push to the
**user's own** edge account for a server-tier build (never the pair's
origin). It lands after `workspace-fs` (the source tree it builds from) and
`pair-studio` (the preview it promotes), and is server-tier only — a live
deploy needs a real host. Exit criterion: a built workspace deploys to a
live URL the user opens and tries in the same session.

---

## The order at a glance

| # | Module | Phase | Why here |
|---|---|---|---|
| 1 | pair-architecture | 0 | Locks contracts + name; costs no code |
| 2 | baseplate-worker | 0 | The one server; the delivery harness |
| 3 | baseplate-client | 0 | The chat shell both tiers share |
| 4 | provider-registry | 1 | No model calls, no product; guards are foundation |
| 5 | research-pipeline | 1 | Runs before search exists (PA-2); spine of the value |
| 6 | web-search | 1 | Lights up inside a tested pipeline |
| 7 | enrichments | 1 | Optional drip-ins, one file each |
| 8 | sealed-crypto | 2* | Pulled forward: the secure tier's foundation |
| 9 | secure-tier | 2 | The stricter tier first — mission proof, keeps the pair honest |
| 10 | identity-access | 2 | Accounts before quotas |
| 11 | quota-metering | 2 | Never open sign-ups before quotas |
| 12 | sse-recovery | 2 | Provable only live; lands when live users exist |
| 13 | ciphertext-storage | 3 | Every stored byte argues PA-4 after the tiers stand |
| 14 | client-rag | 3 | Spans both tiers' storage postures |
| 15 | grant-bridge | 3 | Bridges only what already exists; consolidated JWT form directly |
| 16 | offline-workspaces | 3 | Composes 8 + 15; both must freeze first |
| 17 | observability | 4 | What every loop consumes (log opt-out contract with it) |
| 18 | eval-harness | 4† | † earlier if tuning: baseline before believing |
| 19 | decision-boards | 4 | The human-decision mechanism |
| 20 | feedback-loops | 4 | The boards' heaviest consumers |
| 21 | agent-dev-workflow | 4‡ | ‡ configure hooks/ledgers in phase 0–1; full loop needs shipped features |
| 22–30 | extensions (incl. exec-engine, vm-toolchain, workspace-fs) | 5 | Leaves; product priority decides. exec-engine is the source-built substrate; workspace-fs is the fast-track file plane (server-tier) |
| 31 | pair-generator | 6 | Meta — used throughout, listed last |
| 32 | pair-studio | 6 | The capstone: the generator moved into the product; client-tier builds try out in-UI |
| 33 | deploy-pipeline | 6 | Deploy the workspace live (same-origin preview / user's own account); server-tier |

---

## Beyond the phases — future direction: fine-tuned, model-sized SDKs

*(A long-horizon goal, recorded 2026-07-21. It sits after phase 6 because it
presupposes the whole thing shipped AND measured — do not start it before
`eval-harness` (18) and the feedback loops (20) are real and the pair is
demonstrably passing scored tasks.)*

The current SDK is one fixed artifact — 33 modules, one baseplate, contracts
that hold for any model. The direction below turns "the SDK" into a *family of
distilled SDKs*, each tuned to a specific model, and uses the reference itself
as a training-data factory. Two capabilities have to be in place first, which is
why this is a *future* goal, not a phase:

1. **A testing system that scores success on specific tasks** — the
   `eval-harness` grown from "does the pipeline answer" (phase 4) into a
   per-task success-rate meter: given a development task and a chosen SDK +
   source implementation, did the agent actually deliver it? Without this
   number there is nothing to tune toward.
2. **The SDK fully wired to the source it distills** — SDK mode already
   distills the deployed Se/cure source into a flavour; the tuning loop needs
   that binding to be *plural*: the SDK can be pointed at more than one
   implementation as its knowledge base.

### 1. Tune the SDK *and* the source it has access to

Once both hold, two things become tunable together: the **SDK** (which modules,
skills, contracts, and how they are phrased) and the **source code of the
implementation(s)** the SDK carries as knowledge. Tuning either changes the
success-rate number; the eval harness is what closes the loop.

### 2. Many implementations = subsets of the full feature set

Today the full feature set lives in one main repo. The idea: define several
**constellations** — three, four, five distinct *subsets* of these features
assembled in particular ways. Guest integrations (which providers, sources,
enrichments, extension surfaces are present) differ per subset, so each
constellation is a genuinely different complete implementation, not a subset
that merely omits code paths. The module model (§5 of `DESIGN.md`: baseplate +
selectable features, dependency-closed) is exactly what makes these subsets
*buildable and valid* rather than arbitrary — every reasonable permutation of
features that closes under its dependencies is a candidate complete
implementation.

### 3. Keep the (query → response) dataset per implementation

For each such implementation, keep the **actual development query→response
dataset** it produced — the real interactions of agents building against that
particular constellation. Across all reasonable permutations, this is a large,
domain-specific corpus of "given this SDK over this source, here is how a
development task was carried out," paired with the eval harness's verdict on
whether it succeeded.

### 4. The SDK fine-tuning mechanism

With permutations + datasets + per-task scores in hand, we can **fit an SDK to a
model**: for a particular (often small, mobile) model, produce an SDK whose
*dimensions are kept small enough* to fit the model's size and attention span,
and whose *promised use cases are bounded* to what that model can actually hold.
Because we have success-rate data on specific tasks across a selection of
implementations, "small enough and still delivers" stops being a guess — it is
measured. The fine-tuning mechanism searches for the SDK shape that maximises
task success under the model's context/size budget.

### 5. The payoff — a "lovable model"

These fine-tuned, model-sized SDKs then become the **basis for producing a
bounded amount of training data within a particular domain**. Fine-tune one of
these small mobile models on that domain-specific corpus, and it should be able
to deliver a *lovable* experience — implementing things from this SDK as it has
been trained to do, reliably, at a size that runs on-device. This is SDK mode's
green "lovable experience" (see the **sdk-mode** skill) carried to its
conclusion: not just a prompt-time SDK a large model reads, but a distilled SDK
*baked into* a small model that already knows how to build with it.

**Why it stays a note, not a phase:** every step here is downstream of shipped,
measured features and of a plural SDK↔source binding. Recording it keeps the
generation phases (6) and the eval harness (4) pointed at a destination — a
*trainable* SDK family — without pulling any of the work forward before its
preconditions exist.
