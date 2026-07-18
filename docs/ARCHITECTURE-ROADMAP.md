# Architecture roadmap — toward a stellar deep research agent

A forward-looking assessment of major architectural moves for continued
development of this codebase. `docs/ARCHITECTURE.md` describes what the
system *is*; this document argues about what it should *become*, and —
just as importantly — what it should refuse to become. Each section gives
a verdict, the reasoning, and the honest costs.

Written against the codebase as of 2026-07: ~37K lines of dependency-free
plain JS excluding tests (68 Worker modules in `src/`, 49 client modules
in `public/js/`), no build step, deployed by `npx wrangler deploy` /
git-connected push.

> **Status update (2026-07-09).** Much of this document has since shipped
> — per-section **Status** notes below record what, verified in code:
> type checking (§2), the enrichment registry AND the `/mcp` server (§3),
> the skills restructure (§4), the scored benchmarks (§5.0), and a
> hand-rolled schema validator (§7). §§5.1/5.2/5.4 were built, benchmarked,
> found net-negative, and switched OFF behind a flag — the benchmark-first
> discipline this document argued for, working exactly as intended.
> §5.3, §5.5 (full form) and §6 remain open.

---

## 0. Executive summary

| Question | Verdict | Status (2026-07-09) |
|---|---|---|
| Switch to TypeScript? | **Half-yes**: type-*check* everything now (JSDoc + `tsc --noEmit`, zero build step); consider full `.ts` for `src/` only later, via wrangler's built-in bundling. Never transpile the client. | **Shipped (step 1)** — `tsconfig.json`, `npm run typecheck`, `src/types.d.ts`, opt-in `// @ts-check` files |
| Switch to MCP exclusively for integrations? | **No** as internal plumbing — it would re-introduce the model-driven tool selection this pipeline deliberately removed. **Yes** as a *product surface*: expose DeepResearch itself as an MCP server. Internally, formalize the enrichment pattern the integrations already share. | **Shipped, both halves** — `src/enrichment.js` + `src/search-sources.js` registries; `POST /mcp` (`src/mcp.js`) |
| Move logic into skills? | **Yes** — for the *development* system, not the Worker. CLAUDE.md has grown into a ~10K-word monolith; restructure into a slim invariants file plus on-demand `.claude/skills/`. | **Shipped** — 17 skills in `.claude/skills/`, slim CLAUDE.md |
| Biggest single lever for answer quality? | **Scored evaluation.** The model-eval harness collects data read by hand; it cannot hillclimb. Add an LLM-judged benchmark with tracked scores before adding pipeline sophistication. | **Shipped** — `tests/eval-bench.mjs` + `tests/hf-bench.mjs` + ledgers |
| Biggest pipeline upgrades? | Research-notes compression, full-content fetch for top sources, outline-first synthesis at large budgets, claim-level validation — all expressible in the existing deterministic no-function-calling style. | **Built, benchmarked, disabled** (notes/full-content/claim-level — see §5.1/5.2/5.4); outline-first not built |
| Biggest platform move? | **Cloudflare Workflows** (durable execution) when research runs grow past the current envelope — it would replace the hand-built answers-table + heartbeat + `waitUntil` recovery machinery with platform-level durability. Not urgent; the current machinery is battle-tested. | **Not adopted** — no trigger condition arrived |
| New libraries? | Very few, deliberately: a tiny schema validator (Valibot or hand-rolled) for the JSON phases, `@cloudflare/workers-types` + `wrangler types` for typing. Skip Hono, skip generic LLM SDKs, skip agent frameworks. | **Shipped** — hand-rolled validator (`src/schema.js`); `typescript` + `@cloudflare/workers-types` as dev-deps only |

---

## 1. What must not change — the load-bearing decisions

Every improvement below is constrained by these. They are not legacy;
they are the reasons the product works, and each traces to a reproduced
production finding rather than a preference.

1. **Deterministic orchestration, no function calling.** The Worker picks
   every phase and every query; models only ever fill in JSON or prose.
   This is what makes the pipeline work identically across Berget's whole
   catalog — including reasoning models whose tool-calling/JSON is
   demonstrably unreliable (the GLM triage-corruption incident is the
   canonical evidence). Any proposal that hands control flow back to the
   model (function calling, ReAct loops, MCP tool selection *by the
   model*) reintroduces the exact failure class the architecture was
   built to eliminate.
2. **Fail-soft helper phases.** Triage, gap check, validation, geocode,
   Shodan, Maps — every helper degrades to a working (if shallower)
   answer. A stellar research agent that sometimes returns nothing is
   worse than a good one that always returns something.
3. **Split model routing.** JSON phases on a fixed reliable model,
   synthesis on the user's choice. Also what keeps the per-phase EWMA
   warm and the budget planner honest.
4. **The privacy split.** Encrypted-at-rest conversations, plaintext only
   for what's RAG-indexed, keys never at rest beside ciphertext,
   metadata-only logs, minimal outbound requests to third parties. This
   is a differentiator, not overhead — several sections below (evals,
   observability) must be designed *around* it.
5. **Minimal dependencies, evidence-driven exceptions.** The codebase's
   actual bug history is integration behavior — hung fetches, silent
   stream truncation, CPU ceilings, model quirks — none of which any
   framework would have prevented, and several of which a framework's
   abstraction would have *hidden* (the missing-`finish_reason` detection
   lives in our own stream loop precisely because we own it).

---

## 2. TypeScript

**Verdict: adopt type *checking* now, without a build step. Defer full
TypeScript, and scope it to `src/` only if it ever happens. The client
stays plain JS forever.**

> **Status: step 1 shipped.** `tsconfig.json` (strict, `allowJs`,
> `noEmit`; adoption is per-file via `// @ts-check` rather than global
> `checkJs`), `npm run typecheck`, `typescript` +
> `@cloudflare/workers-types` as the repo's only dev-deps, and a
> hand-written `src/types.d.ts` for the seam types. Steps 2–3 remain as
> written: no `.ts` renames, no client transpilation.

### The real constraint

"No build step" is load-bearing in two different ways that are worth
separating, because they have different escape hatches:

- **The client** (`public/`) is served as static assets byte-for-byte.
  Modules are hand-vendored, import-safe in Node for unit tests, and
  debuggable in production as the exact source that was written. A client
  build step would break the pure-core-tested-in-Node pattern
  (`message-content.js`, `exif.js`, `docs.js`, …), complicate the
  Playwright suite's relationship to what's deployed, and add a toolchain
  to a repo developed largely through Claude Code sessions (per `/build/`,
  sometimes from a phone). **Nothing here should ever require
  compilation.**
- **The Worker** (`src/`) is *already* bundled — wrangler runs esbuild on
  every deploy. Wrangler compiles TypeScript out of the box with zero
  extra configuration; `main = "src/index.ts"` would deploy exactly the
  way `src/index.js` does today, including on the git-connected
  auto-deploy path. So for the server, "no build step" is actually "no
  *additional* build step" — TS is nearly free.

### What types would actually buy here

Be honest about the defect history: the production bugs in
`tests/MODEL-EVAL-FINDINGS.md` (hung fetches, exceededCpu, empty
completions, JSON-mode corruption) are all *runtime integration*
failures. TypeScript prevents none of them. What it does prevent is the
class of bug this codebase is now *growing into* as it scales:

- **Shape drift across module seams.** The `ctx` object built in
  `runPipeline()` and threaded through every phase; the `state` object
  shared between `chat.js` and `pipeline.js` (now carrying `totals`,
  `jsonTotals`, `visionTotals`, `shodanCount`, `mapsCount`,
  `cachedSearchCount`, …); the SSE event vocabulary that client
  `activity.js`/`turns.js` must stay in sync with; the settings JSON
  (`shodan_mcp` / `google_maps` / …) parsed in three
  places. These are exactly the seams where a 16K-line two-sided codebase
  starts leaking, and exactly what structural typing catches.
- **Refactoring confidence** for the pipeline changes in §5.

### The staged plan

1. **Now — JSDoc + `tsc --noEmit`, both sides.** Add `typescript` and
   `@cloudflare/workers-types` as dev-deps, a `jsconfig.json` with
   `checkJs`, and a `npm run typecheck` script alongside `npm test`. Type
   the seams first, not everything: `@typedef` blocks for `PipelineState`,
   `PipelineCtx`, `SseEvent` (a discriminated union of every `status`
   type — this doubles as the protocol's canonical machine-readable
   spec), `Settings`, `ModelProfile`, `BudgetPlan`. Run `wrangler types`
   to generate the `Env` bindings type so `env.DB`/`env.R2`/secrets stop
   being stringly-typed. Files opt in with `// @ts-check` so adoption is
   gradual and never blocks a deploy.
2. **Later, only if warranted — `.ts` for `src/`.** If the JSDoc
   annotations become the bottleneck (they are wordier than TS syntax),
   rename `src/` modules to `.ts` and let wrangler's bundler handle it.
   Unit tests keep working via `node --experimental-strip-types` (stable
   type-stripping is in current Node LTS). The client is out of scope
   permanently — its type coverage comes from checked JSDoc.
3. **Never — a client transpilation pipeline.**

This ordering gets ~80% of the safety for ~10% of the disruption, and
step 1 is reversible by deleting two files.

---

## 3. MCP — for integrations, and as a product

**Verdict: do not rebuild the internal integrations on MCP. Formalize the
internal "enrichment" contract they already share. Separately — and much
more interestingly — expose DeepResearch itself *as* an MCP server.**

> **Status: shipped, both halves.** The enrichment contract is codified as
> the `ENRICHMENTS` registry in `src/enrichment.js` (Shodan + Google Maps;
> `pipeline.js` calls `runEnrichments()` once and never names an
> enrichment), and search-phase sources got the same treatment in
> `src/search-sources.js` (Hugging Face Hub is the first entry). The MCP
> server exists at `POST /mcp` (`src/mcp.js`): hand-rolled Streamable
> HTTP / JSON-RPC 2.0 exactly as sketched below — one `deep_research`
> tool, wired after the identity gate so it inherits the site's access
> control and usage recording.

### Why not MCP internally

MCP's value proposition is model- and client-facing: a standard way for
an *agent* to discover and invoke tools it didn't know about at build
time. This pipeline's integrations (Exa, Shodan, Nominatim, Google Maps,
Berget itself) are the opposite case on every axis:

- **Selection is deterministic.** `extractTargets()` and `extractPlace()`
  decide *in code* whether Shodan or Maps runs. There is no discovery
  problem — the orchestrator knows its tools at build time, and keeping
  that decision out of the model's hands is a design pillar (§1.1).
- **The transport adds nothing but failure surface.** An MCP server in
  front of Exa means the Worker calls a service that calls Exa: more
  latency in a pipeline that meticulously budgets seconds, a second
  timeout regime on top of the hard-won one in `berget.js`/`exa.js`, and
  a new deployment to operate. The hand-rolled clients are 180–520 lines
  each *including* their bounded-subset summarization, privacy-minimal
  request shaping, and fail-soft behavior — the parts an off-the-shelf
  MCP wrapper would not provide and MCP framing would not express.
- **The privacy posture is per-integration and deliberate.** "Only the
  IP/hostname crosses the wire", "only the coordinates, generic
  User-Agent", "AI-derived short queries, never the conversation" — these
  guarantees live in the request-shaping code. Generic tool plumbing
  works against auditable minimal requests.

"MCP exclusively" would therefore be architecture theater: wrapping REST
calls in a protocol whose benefits (dynamic discovery, model-driven
invocation, cross-client reuse) this pipeline structurally doesn't use.

### What to do instead internally: the Enrichment contract

The integrations have *converged* on a shape without it being named:

> deterministic target extraction (pure, unit-tested) → bounded,
> privacy-minimal lookup with its own timeout → summarize to a capped
> subset → append ONE labeled context block via `withAppendedText()` →
> emit a named activity step only when something real happened → fail
> soft in every branch → count into `state.*Count` for `chat.complete`.

Shodan, geocode, and Google Maps each hand-implement this today, wired by
individual `if (state.shodan) …` lines in `runPipeline()` and individual
gates in `chat.js`. Codify it: an `enrichments/` registry where each
entry declares `{ id, settingsKey, secretName, detect(conversation),
run(ctx) }`, iterated generically before the pipeline. That makes the
next enrichment (there will be more — this is clearly a product pattern)
a one-file drop-in instead of a five-file thread-through
(`settings.js` → `featureAvailability` → `chat.js` gate → `pipeline.js`
wiring → account-panel knob), and it gives §2's typechecker one interface
to enforce. This is the useful kernel of the MCP idea — a uniform tool
contract — without the protocol overhead.

### Where MCP genuinely fits: DeepResearch as an MCP server

The compelling MCP move points the other direction. A `deep_research`
tool — question in; cited, validated, source-diverse answer out — is
exactly the kind of high-leverage tool agent users want to hand to
Claude, Cursor, or any MCP client. The pipeline already is that tool; it
lacks only a transport:

- **Thin surface**: an `/mcp` route implementing Streamable HTTP (the
  modern remote-MCP transport, designed for exactly this serverless
  shape; Cloudflare's `agents`/`workers-mcp` tooling or a ~200-line
  hand-rolled JSON-RPC handler — the protocol is small). One tool,
  `deep_research({ question, time_budget_s })`, streaming progress
  notifications that map 1:1 onto the existing SSE `status` events.
- **Auth**: break-glass Basic Auth already works header-based and
  quota-exempt; per-user MCP access would ride the same session/API-key
  machinery, with usage recorded through the existing `usage_events`
  path so spend stays visible.
- **Why it's strategic**: it turns a single-tenant chat site into
  research infrastructure other agents compose with — the strongest
  possible expression of "stellar deep research agent", and it reuses
  ~100% of the pipeline. The invite-only, quota-gated access model
  transfers unchanged.

---

## 4. Skills and the development system

**Verdict: yes — restructure the project's Claude Code memory into a slim
CLAUDE.md plus on-demand skills. This is about the *development* loop,
not the Worker.**

> **Status: shipped.** `.claude/skills/` now holds 17 skills — including
> every one proposed below (`model-eval`, `storage-privacy`,
> `sse-protocol`, `live-verify`, and the enrichment how-to as
> `add-research-source`) plus ones this document didn't foresee
> (`chat-logs`, `feedback-loop`, `tokemon-game`, `add-llm-provider`, …) —
> and CLAUDE.md is the slim invariants-plus-layout file with one-line
> pointers into each. The boundary held: no product logic lives in skills.

CLAUDE.md is now a ~10,000-word monolith: architecture, six integration
guides, storage/encryption design, SSE protocol, testing conventions,
deploy gotchas, incident history. Every session pays its full token cost
up front, most sessions use a fraction of it, and — the sharper problem —
a document that long stops being reliably *followed*; critical invariants
("don't commit mid-battery", "never key sessions on ADMIN_PASS") sit in
paragraph twelve of section nine.

Progressive disclosure via `.claude/skills/` fits the material almost
embarrassingly well, because the doc already has skill-shaped seams:

- **CLAUDE.md keeps** (~1–2 pages): what the product is, the §1
  invariants, code layout table, git workflow, the test commands, and
  one-line pointers into each skill.
- **`model-eval` skill**: the battery methodology, `QUERY_SETS`
  discipline, the findings-ledger append-only rule, "don't deploy
  mid-battery", how to decide profile entries. Loads exactly when a
  battery is being run or a model quirk investigated.
- **`storage-privacy` skill**: the key hierarchy, the
  encrypted-vs-indexed-readable rule, the implicit-cloud sync semantics, and
  the "keep `/help/`, popover, privacy notice in sync" checklist —
  loaded when touching `storage.js`/`history-store.js`/`sync.js`/
  `projects.js`.
- **`sse-protocol` skill**: the event vocabulary + forward-compatibility
  rules (superseded by the typed `SseEvent` union from §2 once that
  exists — a skill can point at code).
- **`live-verify` skill**: the production-verification convention —
  Workers Logs queries, `npx wrangler tail`, the `x-request-id`/`(ref …)`
  correlation trick, what only breaks in production vs `wrangler dev`.
- **`add-enrichment` skill**: the §3 contract as a how-to, once
  formalized.

Additionally, routine operations that are currently prose ("re-capture
the help screenshots when the composer changes", "re-run the model eval
when the catalog changes") become slash commands — checklists that
execute instead of paragraphs that hope to be remembered.

One boundary to keep sharp: skills document and operate the system; no
*product* logic moves into them. The Worker must remain fully
comprehensible and deployable with no agent tooling present.

---

## 5. The pipeline itself — the road to stellar

The current pipeline is honest about what it is: breadth-scaled
single-pass research. The slider buys more angles, more results per
search, more gap rounds — but every source contributes only its Exa
highlights, synthesis is one streamed pass over a flat registry, and
validation is one whole-draft check. The gap between this and
state-of-the-art deep research systems (multi-phase agentic research à la
STORM/GPT-Researcher, outline-driven long-form synthesis, claim-level
verification) is well understood in the literature — and, notably, *every
one of the missing pieces is expressible in this codebase's deterministic
JSON-phase idiom*. No function calling required.

### 5.0 Measure first: scored evaluation

> **Status: shipped.** Two scored benchmarks now sit beside the model-eval
> harness: `tests/eval-bench.mjs` (LLM-judged rubric scores on ~27 fixed
> synthetic questions, ledger `tests/EVAL-BENCH-FINDINGS.md`) and
> `tests/hf-bench.mjs` (accuracy against external gold-answer HF question
> sets chosen for low contamination, ledger `tests/HF-BENCH-FINDINGS.md`),
> plus `tests/denoise-driver.mjs` for multi-sample A/Bs. They immediately
> earned their keep: the §5.1/5.2/5.4 phases below were merged, measured,
> found net-negative, and switched off on the numbers.

**This is the highest-leverage item in this document.** `model-eval.mjs`
collects raw SSE traces "read and analyzed by hand" — excellent for
finding integration bugs (its track record: timeouts, injection,
exceededCpu), but structurally unable to answer "did this change make
answers *better*?". Every pipeline idea below is a hypothesis; without a
score, merging them is guesswork and regressions are invisible.

Concretely, extending the existing harness (keeping the no-dependency
ethos; promptfoo/Braintrust exist but bring accounts/config for little
gain here):

- A fixed benchmark set of ~25–40 research questions with graded
  characteristics (multi-hop, recency-sensitive, contested claims,
  Swedish + English, unanswerable-by-design, source-diversity traps like
  the round-7 company-self-citation case).
- An **LLM-judge phase** in the harness scoring each answer on: citation
  faithfulness (does `[n]` support the sentence it's attached to —
  checkable because the trace contains the registry), source diversity
  (computable directly), coverage vs a rubric, calibration (does it hedge
  where sources conflict). Judge on a strong model; judge prompts live in
  the repo like `prompts.js` does.
- Scores land in a dated ledger next to `MODEL-EVAL-FINDINGS.md`, so the
  project hillclimbs on a number, not an impression.
- Privacy note: benchmark questions are synthetic, so this stays clear of
  the zero-retention promises.

### 5.1 Research memory: notes compression between rounds

> **Status: built, then disabled on the evidence.** Implemented as
> `src/notes.js` + the `maybeDigest` phase in `pipeline.js`, exactly the
> `{claim, source_ids, entities, contradicts?}` shape below — but the
> de-noised benchmark found the notes/full-content/claim-level trio
> NET-NEGATIVE at the deep tier (2.65 off → 2.43 on, with real regressions
> on focused questions and no real multi-hop gain), so all three are
> gated off behind `DEEP_TIER_FEATURES_ENABLED = false` in `src/budget.js`
> pending an intent-gated (triage-decided, not budget-decided) rework.
> The code and schema hardening remain.

Today the source registry accumulates raw highlights and synthesis eats
it whole (bounded by `sourceDigest`). At generous budgets this is the
binding constraint: more searches ≠ more *usable* context. Add a budgeted
**digest phase** after each search round — a JSON call (on the cheap JSON
model, like every planning phase) that compresses new results into
structured notes: `{claim, source_ids, entities, contradicts?}`. Gap
check then audits *notes* instead of raw text (sharper gap detection),
and synthesis receives notes + the registry for citation. This is the
"research memory" pattern every serious deep-research system converges
on, and it drops straight into the existing phase/EWMA/budget machinery
as one more phase type.

### 5.2 Full-content fetch for the sources that matter

> **Status: built, then disabled** — `fetchContents` in `src/exa.js`
> (Exa `/contents`, edge-cached, cost-accounted via
> `CONTENTS_COST_MULTIPLIER`), gated by `wantsFullContent` and switched
> off by the same `DEEP_TIER_FEATURES_ENABLED` flag as §5.1, for the
> same benchmark reason.

Highlights are token-efficient but shallow — a genuinely deep run should
*read* its best sources. After the gap rounds, a budget-gated step fetches
full text for the top 2–4 registry sources via Exa's `/contents` endpoint
(zero new dependencies, same API key, same client) and digests each into
notes (§5.1). Gate it to the ≥240s tiers alongside `searchDepth`, and
account its cost the same way deep search tiers already are.

### 5.3 Outline-first synthesis at large budgets

> **Status: not built.**

A 10-minute run currently ends in the same single-pass synthesis as a
15-second one, subject to one `max_tokens` ceiling and one chance at
structure. For the top budget tiers: a JSON outline phase (sections +
which sources feed each), then per-section synthesis streamed in order,
then the sources list. Costs: citation numbering must stay global
(already solved — the registry is fixed before synthesis), and
`discard_text` semantics need a per-section variant or validation moves
before streaming. Ship behind the budget planner so small budgets are
untouched.

### 5.4 Claim-level validation

> **Status: built, then disabled** — the per-claim path exists in
> `pipeline.js`'s `runValidation` (`claimExtractionPrompt` /
> `claimVerifyPrompt`), gated by `wantsClaimValidation` and switched off
> by the same flag as §5.1/5.2. Tight budgets still run the cheap
> single-pass validate, as before.

Validation is one JSON pass over the whole draft — coarse, and its
all-or-nothing `revise` is expensive UX (`discard_text` throws away a
full stream). Evolve to: extract check-worthy claims (JSON), verify each
against its cited sources (JSON, parallelizable with `Promise.all` like
`runSearches` already is), and revise *only* flagged sections (pairs
naturally with §5.3's sections). Same fail-soft rule: any failure
degrades to accepting the draft.

### 5.5 Sub-question decomposition at the top tier

> **Status: shipped in a lighter form.** Triage now emits `subquestions`
> (threaded into the gap-check and synthesis prompts so coverage is
> audited against each) and a `complexity` classification that caps
> research depth BELOW the budget for simple questions
> (`applyComplexityToPlan` in `src/budget.js` — the de-noised benchmark
> found over-researching simple questions net-negative). The full form
> below — concurrent bounded mini-pipelines per sub-question — remains
> unbuilt.

For the most generous budgets, triage can already produce multi-angle
plans; the next step is letting it produce *sub-questions*, each running
a bounded mini-pipeline (search → digest) concurrently, merging notes and
registries for one synthesis. Workers are excellent at concurrent fetch
fan-out and the paid-plan CPU ceiling (300s) leaves room. This is the
"multi-agent research" pattern *without* agents — the Worker stays the
only orchestrator. Sequence it last: it multiplies cost and only pays off
once §5.0 can prove it.

### 5.6 Adaptive fallback: model-chosen tools when no codified pipeline matches → learn and codify

> **Status: proposed (owner directive, 2026-07-18).** The web-search knob
> was decoupled from the depth slider in the same directive: the knob gates
> Exa only, and *depth is how deep you go given the available sources* — so
> a request with web search off still runs whatever sources apply (the HF
> Hub source, developer-mode source investigation, the enrichments) up to
> the time budget. The knob/slider/prompt/doc changes shipped; the adaptive
> fallback below is the open part.

Today every request is routed by a **codified pipeline**: a deterministic
gate (`triage`, `externalSourceIntent`, the `SEARCH_SOURCES` intents, the
enrichment `extractTargets`/`extractPlace`) decides which sources run, in
code, at build time. That is a design pillar (§1.1, §3) and it must stay
the *default*. But it has a blind spot: a request whose best research path
nobody has codified yet falls through to a generic web-search-then-
synthesize (or, web off, a plain model answer). The pillar says "keep tool
*selection* out of the model's hands"; it does **not** say "never let the
model select tools" — it says the *default hot path* must be deterministic
and work across the whole model catalog.

The proposal is a **bounded fallback**, entered only when no codified
pipeline matches:

1. **Detect the miss.** The deterministic router already knows when it has
   nothing specific — triage returns a bare "research" with no source
   intent firing, or a developer/tool-capable answer model is in use with
   sources that came back thin. That is the trigger, not every request.
2. **Let the model choose from the *available* tools.** Reuse the ONE
   existing authorized tool-use seam (developer mode's
   `grep_source`/`read_file`/`list_files`, plus `run_bash` on Se/cure —
   invariant §1's single exception) and widen the offered toolset to the
   registered sources for THIS request. Tool-capable models only;
   everything else keeps the deterministic fallback. This never touches the
   JSON planning phases (they stay on the fixed reliable model, invariant
   §3) and never becomes the default path.
3. **Learn and codify.** Log what the model chose and whether it helped
   (the eval ledgers + `chat_logs` already capture the raw material). When
   a chosen tool-path recurs and scores well, **promote it into a codified
   deterministic pipeline** — a new `SEARCH_SOURCES` entry or intent gate,
   authored the normal way (with EN+SV parity and a benchmark, §5.0). The
   fallback is thus a *discovery* mechanism for new codified pipelines, not
   a permanent replacement for them: over time the deterministic coverage
   grows and the fallback fires less.

**The tension, stated honestly.** This deliberately re-introduces
model-driven tool selection that §3 argued against — but *bounded* (only on
a codified-pipeline miss), *gated* (tool-capable answer models only, never
the JSON phases), and *self-liquidating* (its whole point is to breed new
deterministic pipelines that make it unnecessary). It only earns its place
if §5.0's benchmark shows the fallback beats the generic path on the misses
it fires for, and if the codify step actually happens (a fallback that
never graduates into a pipeline is just the function-calling agent this
project rejected). Sequence it **after** §5.0 can measure it, and treat the
"codify" half as the deliverable — the model-chooses step is scaffolding
for it.

### Sequencing

§5.0 first, alone, and let it baseline the current pipeline. Then §5.1
(it improves every budget tier), then §5.2/§5.3 (top tiers), then §5.4,
then §5.5 — each merged only when the benchmark says it earned it. §5.6
rides last and only once §5.0 can score the misses it targets.

---

## 6. Platform: Cloudflare Workflows, Durable Objects, and the recovery machinery

> **Status: not adopted** — none of the trigger conditions below has
> arrived; the hand-built recovery machinery (answers table, heartbeat,
> stale-run detection, client stall watchdog) remains in place and
> battle-tested.

A striking amount of hard-won code exists because a long research run
lives inside one fragile isolate: `ctx.waitUntil` survival, the D1
`answers` recovery table with TTL purge, the 15s heartbeat +
`RUNNING_STALE_MS` dead-run detection, the client stall watchdog, the
`pending-answer` relaunch pointer. It all works and is battle-tested —
*and* it is exactly the problem **Cloudflare Workflows** (durable
execution: steps with automatic retry/persistence, hours-long runs,
survives eviction natively) was built to remove. Each pipeline phase maps
cleanly onto a workflow step; the SSE stream becomes a thin reader over
workflow state; the entire heartbeat/recovery apparatus collapses into
platform behavior, plus recovery gains capabilities the hand-built
version can't offer (a run surviving a *deploy*, which currently
truncates in-flight streams — the documented mid-battery hazard).

Honest counterweights: Workflows adds a binding and a mental model;
step-granular persistence has I/O shape constraints; the current
machinery's failure modes are *known*, which is worth a lot; and streamed
synthesis-through-a-workflow needs design care. So: **not now.** The
trigger conditions that make it worth it — any of: budgets beyond ~10
minutes, §5.5 fan-out, scheduled/background research ("research this and
notify me"), or the recovery code demanding another significant
investment. When one arrives, migrate the *orchestration shell* and keep
every phase function intact — the phases are already pure-ish functions
of `ctx`, which is most of the port.

(**Durable Objects** solve a different problem — per-conversation
coordination/state. Nothing here needs that yet; conversations are
deliberately client-held. Revisit only if real-time multi-device sessions
become a goal. The **Agents SDK** is the model-driven-loop shape §1 rules
out, except possibly as scaffolding for §3's MCP server route.)

---

## 7. Libraries — case by case

The minimal-dependency stance has been validated repeatedly (the bugs
that mattered were *under* the abstractions a framework would have
added). The bar for a new dependency: it must encode knowledge this
project doesn't want to own. Assessed against that bar:

| Library | Verdict | Reasoning |
|---|---|---|
| `typescript` + `@cloudflare/workers-types` (dev) | **Adopt** — *adopted* | §2. Dev-only, zero runtime/deploy footprint, checked-JSDoc mode. |
| Schema validation — Valibot (~1KB core) or hand-rolled | **Adopt the pattern, maybe not the package** — *hand-rolled shipped as `src/schema.js` (lenient, never throws, behind the existing fail-soft fallbacks)* | Every JSON phase hand-parses model output (`normalizeTriage` and friends). Declaring the triage/gap/validate/settings shapes once — and validating with clear errors — hardens the exact boundary (model JSON → pipeline) this project's bugs come from, and doubles as the `SseEvent`/`Settings` source of truth for §2. Valibot tree-shakes to ~kB and has zero runtime deps of its own; if even that is too much, the same *contract* can be hand-rolled. Pair with Berget's structured-output / JSON-schema mode where models support it, validator behind it as the fail-soft net. |
| Content extraction (readability / HTML→text) | **Only if §5.2 can't use Exa `/contents`** | Prefer Exa's own contents endpoint first — same key, same client, no new dependency. Reach for a standalone extractor only if full-text reading needs sources Exa can't fetch, and weigh its bundle size against the Worker's cold-start budget. |
| Hono / a router framework | **Skip** | `index.js`'s hand-rolled router is small, readable, and correct. A framework tidies syntax and buys nothing the routing table needs. |
| Vercel AI SDK / OpenAI client / LangChain / LangGraph / Agents SDK | **Skip** | All assume model-driven control flow or agentic loops — the exact shape §1 rules out. The `fetch` calls in `berget.js`/`exa.js` are thin, own their timeouts and stream-loop invariants, and are the reason the hard-won bug fixes (missing `finish_reason`, `STREAM_MAX_CHARS`, connect timeouts) live where they can be seen. A framework would hide them. |
| promptfoo / Braintrust (eval) | **Skip; extend the in-repo harness** | §5.0's LLM-judge benchmark belongs next to `model-eval.mjs`, dependency-free and reading the same SSE traces. External eval platforms bring accounts and config for little gain at this scale, and would sit awkwardly against the zero-retention posture. |
| Vendored client libs — `marked`, `DOMPurify`, `jsPDF`, `pdf.js` | **Keep as-is** | Already vendored, import-safe, behind auth, lazy-loaded where heavy. No change. |

The through-line: adopt *dev-time* tooling that catches drift (§2's typechecker) and *one* narrow runtime pattern that hardens the model-JSON seam (schema validation). Everything that would re-introduce model-driven control flow, hide the integration layer, or add a build/account dependency stays out.

---

## 8. Closing judgement

The product's strength is its restraint: no function calling, no build
step, no runtime dependencies, and a relentless fail-soft, evidence-driven
discipline. The right architectural future spends none of that and points
it at harder problems. Type the load-bearing seams without a build step
(§2); formalize the enrichment contract the integrations already share
(§3); restructure the development memory into a slim CLAUDE.md plus
on-demand skills (§4); and put the real energy into *research quality* —
but only behind a scored benchmark (§5.0), because every pipeline idea
here is a hypothesis until a number says otherwise. MCP belongs on the
outbound edge (DeepResearch *as* a tool, §3), not the inbound one. Durable
execution (§6) is the right eventual spine, adopted when a concrete
trigger — longer budgets, fan-out, or scheduled research — actually
arrives, not before. Keep subtracting where you can; add only where it
buys depth, and prove the depth.