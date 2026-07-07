# Architectural directions for Deepresearch.se

A forward-looking assessment of where the codebase should go to keep
becoming a *stellar* deep-research agent — not a rewrite plan, a set of
judgement calls about which structural bets pay off and which don't.

Written against the code as of this branch: ~16k lines, 48 server modules
+ 35 client modules, a deterministic no-function-calling pipeline over
Berget.ai + Exa, deployed as a single Cloudflare Worker with **zero
runtime dependencies**. That baseline matters — most of the advice below
is about preserving what makes this fast and legible while adding the few
things that genuinely raise the ceiling.

---

## 0. TL;DR — the recommendation in one paragraph

Do **not** do a big-bang TypeScript rewrite, and do **not** replace the
direct-REST integrations with MCP-as-a-client — both trade away the two
properties (no build step, no dependencies, deterministic control flow)
that make this codebase unusually good. Instead: (1) add *incremental
typechecking* of the load-bearing contracts via `// @ts-check` + JSDoc,
zero build change; (2) formalize the enrichment integrations into a
**capability registry** (the real, useful core of the "skills" idea); (3)
adopt **Cloudflare Workflows** for durable, resumable research runs — this
replaces the hand-rolled heartbeat/answer-recovery machinery with a
platform primitive and is the single highest-leverage change; (4) invest
the remaining energy in *research quality* — adaptive planning, full-text
reading, and adversarial claim verification — because that, not the
plumbing, is what separates a good research agent from a great one. Expose
the pipeline **as** an MCP server (the one place MCP clearly pays off) so
other agents can call Deepresearch as a tool.

---

## 1. What to preserve (read this before changing anything)

The instinct behind "major architectural improvements" is usually to add
structure. This codebase's best decisions are subtractive, and they are
load-bearing. Any proposal that quietly erodes one of these is a
regression even if it looks like progress:

- **No function calling / deterministic phases.** Triage → search → gap →
  synth → validate are direct calls, so the pipeline works on *any*
  JSON-mode model and never depends on a model's tool-use reliability.
  This is why it survives Berget's heterogeneous, sometimes-flaky model
  fleet. Several proposals below (MCP-as-client, agentic loops, the AI SDK)
  are attractive precisely because they reintroduce model-driven control
  flow — which is the thing this architecture deliberately refuses.
- **Split-model routing** (JSON phases pinned to Mistral Small, synthesis
  on the user's model). This is a hard-won fix for a real class of bug
  (GLM corrupting triage into echoing the raw user message). Keep it.
- **Fail-soft everywhere.** Every helper phase degrades rather than
  breaks. Every new capability must inherit this or it doesn't ship.
- **Evidence-driven model profiles + the eval battery.** `model-eval.mjs`
  → `MODEL-EVAL-FINDINGS.md` → `model-profiles.js` is a genuine
  hill-climbing loop. Most teams guess; this one reproduces. Protect it.
- **Zero runtime dependencies.** On a Worker this buys tiny cold starts, a
  minimal supply-chain surface, and no bundler surprises. The bar for
  adding a dependency should stay very high.

The rest of this document is written to *add* capability without spending
any of the above.

---

## 2. TypeScript — yes to typechecking, no to a rewrite

**The tension.** `package.json` and `wrangler.toml` lean on "no build
step — deploy reads `src/` as plain JS." That's a real virtue. But the
codebase has grown a lot of *implicit* structural contracts that now drift
silently:

- the `ctx` object threaded through every pipeline phase (`src/pipeline.js`),
- the per-request `state` shape (counters, registries, `jsonModel`, the
  budget `plan`),
- the SSE event vocabulary (documented in prose in CLAUDE.md, enforced
  nowhere),
- the Berget model-catalog entry shape, and
- the `plan` object from `budget.js` consumed across chat/pipeline/exa.

These are exactly the interfaces where a refactor introduces a
hard-to-test bug.

**The honest cost/value read.** A full `.ts` migration is high-cost
(touch every file, introduce a compile step, re-verify a no-build deploy
path) for *moderate* value, because the code is already disciplined and
well-tested. The high-value / low-cost move is **`// @ts-check` + JSDoc
typedefs**:

- Add a `tsconfig.json` with `checkJs: true`, `allowJs: true`,
  `noEmit: true`. **No build step, no runtime change** — `tsc` runs only
  in CI/`npm test` as a linter.
- Define the load-bearing types once (a `types.d.ts` or JSDoc `@typedef`
  blocks): `PipelineCtx`, `RequestState`, `BudgetPlan`, `ModelCatalogEntry`,
  `SseEvent` (a discriminated union of the status types — this alone
  documents the protocol in a way the code can enforce).
- Annotate function signatures incrementally, load-bearing modules first
  (`pipeline.js`, `chat.js`, `budget.js`, `berget.js`).

This catches the drift class above, turns the SSE-protocol prose into a
checked union, and costs one CI step and no deploy risk. If, after a
quarter of that, the team wants full `.ts`, Wrangler already bundles with
esbuild and supports `.ts` natively — so "no build step" was always
slightly mythical (Wrangler bundles regardless), and the migration
becomes mechanical. **Recommendation: `@ts-check` now; defer full `.ts`
until the JSDoc types have proven their worth.**

---

## 3. Integrations & MCP — expose one, don't consume via MCP

The question "switch to MCP exclusively for integrations" deserves a
precise answer because the codebase's own note ("a Cloudflare Worker can't
hold a stdio MCP process") is *half* right and the conclusion drawn from
it hides the real trade-off.

**What's outdated:** MCP now has a **Streamable HTTP transport**. A Worker
absolutely can be an MCP *client* to a remote HTTP MCP server (Cloudflare
actively promotes remote MCP servers on Workers). So the stdio objection
doesn't rule MCP out on technical grounds.

**Why MCP-as-client still doesn't pay off here.** MCP's core value is
*dynamic tool discovery and model-driven tool selection* — letting a model
find and choose tools at runtime. That is exactly the thing this pipeline
rejects (Section 1). The integrations you have — Exa, Shodan, Nominatim,
Google Maps — are:

- few, thin, and fully understood,
- called *deterministically* by the Worker, not chosen by a model,
- already fail-soft with bespoke timeouts and summary-shaping.

Wrapping them in MCP adds a protocol layer, a round-trip, a
version-compat surface, and (for hosted MCP servers) a third-party
dependency — to reach APIs that are one `fetch()` away. That's cost
without benefit. **Do not replace the direct-REST enrichments with
MCP clients.**

**What *is* worth doing — two things:**

1. **A uniform internal capability interface (do this regardless of MCP).**
   `shodan`, `geocode`, and `googlemaps` already share a shape:
   *deterministically extract a target from the message → look it up →
   append one labeled context block → emit a named activity step → fail
   soft.* Formalize that into a small registry:

   ```
   interface Enrichment {
     id: string;                 // "shodan" | "geocode" | "maps" | …
     enabled(env, identity): boolean;
     extract(message): Target[]; // pure, unit-testable (already is)
     lookup(env, targets): Promise<Block | null>;
     step: { start: string; done: (r) => string };
   }
   ```

   `pipeline.js` then iterates a list instead of hand-wiring each one.
   Adding a source (say, arXiv or Semantic Scholar) becomes "write one
   module, register it" — no edits to the orchestrator. This is the real,
   useful core of the "move logic into skills" idea (see Section 4). It
   keeps determinism, keeps fail-soft, and makes each capability an
   independently testable unit. A registry entry *may* be backed by a
   remote MCP server if a future source only ships MCP — but the pipeline
   never learns that; MCP becomes an implementation detail of one
   `lookup()`, not the integration architecture.

2. **Expose Deepresearch itself *as* an MCP server.** This is where MCP
   genuinely earns its place. A `/mcp` endpoint exposing a single
   `deep_research(query, time_budget_s)` tool (Streamable HTTP, reusing
   the exact pipeline) turns the whole product into a callable tool for
   Claude, Claude Code, and any other MCP-aware agent. That's a
   distribution and composability win the direct-REST integrations can
   never provide, and it fits the auth model you already have (the
   session/break-glass gate extends to `/mcp`). **This is the MCP
   investment to make.**

---

## 4. "Skills" — the concept maps to modules, not to Claude skills

Worth being exact, because the term is overloaded. **Claude Code / Agent
SDK "skills" (markdown + scripts loaded into a Claude agent's context) do
not apply to this runtime at all** — Deepresearch runs Berget models via
plain JSON mode inside a Worker; there is no Claude agent host to load a
skill into. Trying to "move logic into skills" in that literal sense is a
category error.

But the *instinct* — self-contained, self-describing, pluggable units of
capability — is correct and is exactly Section 3.1's registry. So:

- **Enrichments** → the `Enrichment` registry above.
- **Pipeline phases** (triage/gap/synth/validate) are already
  single-responsibility functions sharing `ctx`; they don't need
  "skillifying," but they *do* benefit from the typed `PipelineCtx`
  (Section 2) so a phase's contract is explicit.
- **Prompts** are already centralized in `prompts.js`. Keep them there;
  don't scatter them into per-capability files (central prompts are how
  the anti-injection note and independent-source rules stay consistently
  applied — the unit tests assert exactly this).

Net: the value the user is reaching for with "skills" is *modular
capability registration*, and the codebase is ~80% there structurally.
Finish that; don't import a skill framework that assumes a different
runtime.

---

## 5. Durable execution — the single highest-leverage change

Read the observability section of CLAUDE.md and you'll find a *remarkable
amount of hand-rolled machinery* doing one job: keeping a long research
run alive and recoverable across client disconnects, PWA freezes, and
isolate death. `ctx.waitUntil`, the D1 `answers` table, 15s heartbeats,
`RUNNING_STALE_MS` staleness detection, `projectAnswer`, the client stall
watchdog, `pending-answer.js` resume-across-relaunch — this is, in
aggregate, a bespoke **durable-execution engine** built out of primitives.

It works, and the engineering is genuinely careful. But it's a lot of
surface area maintaining a property the platform now offers directly:

- **Cloudflare Workflows** (durable execution) gives resumable,
  step-checkpointed, automatically-retried long-running jobs with
  observable state — *exactly* the shape of a research run (triage →
  searches → gap rounds → synth → validate, each a durable step). A run
  survives isolate eviction by construction; "recover the parked answer"
  becomes "query the workflow's state" instead of a heartbeat/TTL dance.
- The pieces map almost one-to-one: each pipeline phase → a workflow step;
  the answer-recovery poll → a workflow-status read; the heartbeat/stale
  logic → deleted (the platform owns liveness).

This is the change that most improves *prolonged development*: it removes
a category of subtle failure (dead-run detection, TTL windows, the "stuck
on recovering…" class of bug) and replaces ~several modules of clever code
with a platform primitive that Cloudflare maintains. It's not a weekend
job — SSE streaming semantics have to be reconciled with Workflows'
step model (likely: the Workflow produces the answer durably; the SSE
endpoint tails its progress), and it changes the CPU/limits story — but
it's the right long-term spine.

**Recommendation:** prototype one path (a single research run as a
Workflow, SSE tailing its steps) behind a flag; if the streaming
reconciliation is clean, migrate and delete the recovery machinery. If
Workflows' streaming story isn't ready, **Durable Objects** are the
fallback: one DO per in-flight run gives you the same durable, addressable,
resumable state with full control over the SSE stream, and still retires
most of the heartbeat/TTL code.

---

## 6. The research-quality frontier (where "stellar" is actually won)

Plumbing (Sections 2–5) makes the system *robust*. None of it makes the
*research better*. A stellar deep-research agent is differentiated by how
it plans, reads, and verifies. This is where sustained investment should
go, and the good news is the current architecture extends cleanly into it.

**6.1 Adaptive planning instead of fixed rounds.** Today triage plans N
queries and gap-check runs a *budgeted number of rounds*. Frontier
research agents decompose the question into **sub-questions**, and let
*findings* drive depth: a sub-question that turns up thin or contradictory
evidence earns another round; a well-covered one stops. Keep it
deterministic — this is still Worker-orchestrated, not model-tool-loop —
but let the gap-check phase return a *structured coverage assessment per
sub-question* and let `budget.js` spend remaining time on the weakest
ones. This is the biggest quality lever and fits the existing
plan-then-execute shape.

**6.2 Read full sources, not just highlights.** Exa `highlights` are
token-efficient excerpts — great for breadth, weak for depth. A great
research answer often hinges on reading *one* source thoroughly. Add a
"read" step: for the top few most-relevant results, fetch full contents
(Exa `/contents`, or a fetch + readability extraction) and run a cheap
"reader" model to distill claims. This is the single change most likely
to raise answer *depth*. Cost it against the budget planner like any other
phase.

**6.3 Adversarial claim verification.** The current post-validation is one
fact-check pass over the draft. The state of the art (and, notably, the
`deep-research` skill available in this very environment) is:
*extract discrete claims → verify each independently against the source
registry → drop or flag unsupported ones.* Structure it as a phase that
emits per-claim verdicts; on failure it does what validation already does
(`discard_text` + corrected answer), but now with *claim-level* precision
instead of a whole-draft yes/no. This directly attacks the failure mode
research tools are judged on: confident, uncited, or misattributed claims.

**6.4 A findings/evidence model, not just a source registry.** `state`
currently holds a flat numbered source list. Introduce a light structured
layer — `{ claim, supportingSources[], contradictingSources[],
confidence }` — accumulated across phases. This is the substrate that
makes 6.1–6.3 possible *and* enables surfacing **contradictions** to the
user (a hallmark of serious research) and precise inline citation. It's
additive: synthesis still reads sources, but now also reads findings.

**6.5 Source diversity is already handled well** (the per-domain cap +
overflow backfill + prompt-level rules from the round-7 work). Extend the
same principle to *source type* diversity once you have more than Exa
(academic vs news vs primary vs vendor), so a topic isn't answered
entirely from one *kind* of source.

Everything here preserves determinism and fail-soft. None of it requires
function calling.

---

## 7. Libraries — stay conservative; two are worth it

The near-zero-dependency stance is correct for a Worker and should hold.
Most "modern agent" libraries (Vercel AI SDK, LangChain/LangGraph,
framework-y orchestration) are *net-negative* here because they assume
model-driven control flow — the exact thing this pipeline rejects — and
they're heavy. Skip them.

Two narrow additions clear the high bar:

- **A tiny schema validator for the LLM-JSON contracts.** Triage/gap/
  validate outputs are hand-parsed (`normalizeTriage` and friends).
  **Valibot** (or Zod, but Valibot tree-shakes to ~kB) would let those
  contracts be *declared* and validated with clear errors and typed
  results, replacing hand-rolled coercion and pairing naturally with the
  `@ts-check` types (Section 2). This is the one dependency with a clear
  ROI: it hardens exactly the boundary (model JSON → pipeline) where this
  project's real bugs have historically come from. Consider also using
  provider **structured-output / JSON-schema mode** where Berget models
  support it, with Valibot as the fail-soft validator behind it.
- **A readability/content-extraction helper** *if* you build 6.2 and don't
  use Exa `/contents` — e.g. a small HTML-to-text extractor. Evaluate
  bundle size on a Worker carefully; prefer Exa's own contents endpoint
  first (no new dependency).

Everything else — routing (the hand-rolled router in `index.js` is small
and fine; Hono would be tidier but isn't needed), an OpenAI client (the
`fetch` calls are thin and correct), a test framework (`node:test` is
right) — leave alone.

---

## 8. Data & memory layer

The storage architecture (R2 for blobs, Vectorize for vectors, D1 for
accounts/quota/answers, the encryption-asymmetry design) is coherent and
well-reasoned; don't disturb it. Two forward directions:

- **Cross-session research memory.** The Projects + RAG infrastructure is
  already a memory substrate. A stellar research agent *remembers what it
  found* — a prior report's verified findings should be retrievable when a
  related question comes later. This is mostly a *retrieval-scope* and
  *provenance* problem on top of infrastructure you already have, not new
  infrastructure.
- **Findings as first-class stored objects** (follows Section 6.4): once
  research produces a structured findings graph, persisting *that*
  (readable, like project chats, since it's derived reference material)
  makes reports composable and auditable over time.

---

## 9. Evaluation as a first-class, standing discipline

`model-eval.mjs` + `MODEL-EVAL-FINDINGS.md` is already better than most
teams have. Grow it from a *manual model-quirk sweep* into a *standing
quality regression*:

- Add **rubric-scored** research queries (coverage, citation accuracy,
  contradiction handling, injection resistance) with a judge model, so a
  change to planning/reading/verification can be measured, not just
  eyeballed.
- Keep the append-only findings ledger discipline — it's the reason
  evaluation here hill-climbs instead of restarting.
- When Sections 6.1–6.4 land, each gets an eval that would *fail on the old
  behavior*, so the improvement is provable and protected against
  regression.

This is what converts "we added adaptive planning" from a vibe into a
number.

---

## 10. Prioritized roadmap

Ordered by leverage-per-unit-risk, not by size:

1. **`@ts-check` + JSDoc types** for the load-bearing contracts, run in CI.
   Low risk, immediate drift protection, prerequisite for confident
   refactors. *(Section 2)*
2. **Capability registry** for enrichments (the real "skills" win). Low
   risk, unlocks fast addition of new sources. *(Sections 3.1, 4)*
3. **Valibot for the LLM-JSON contracts** + provider structured-output
   where available. Hardens the historically-buggy boundary. *(Section 7)*
4. **Adaptive planning + full-text reading + claim verification** — the
   research-quality core, sequenced with evals. Highest *product* value.
   *(Sections 6, 9)*
5. **Cloudflare Workflows (or Durable Objects) for durable runs.** Highest
   *robustness/maintenance* value; larger effort, do behind a flag.
   *(Section 5)*
6. **Expose Deepresearch as an MCP server.** Distribution/composability;
   independent of the rest. *(Section 3.2)*

Explicitly **not** recommended: a full TypeScript rewrite, replacing REST
integrations with MCP clients, adopting an agent framework / the AI SDK,
or introducing model-driven tool-calling control flow. Each spends one of
the Section-1 virtues for a benefit this architecture doesn't need.

---

## 11. Risks & failure modes to watch

- **Determinism erosion.** The most likely way this architecture degrades
  is by incrementally reintroducing model-driven control flow "just for
  this one feature." Guard it: any new phase must work on the weakest
  JSON-mode model in the catalog, and the eval battery must prove it.
- **Dependency creep.** Each library in Section 7 is justified *narrowly*.
  The moment "well, we already have Valibot" becomes "let's add the whole
  framework it's part of," the Worker's cold-start and supply-chain
  advantages start leaking.
- **Durable-execution migration risk.** Workflows changes the streaming
  and limits story; a half-migrated state (some runs durable, some not) is
  worse than either end. Do it behind a flag, all-or-nothing per code
  path, with the recovery machinery kept until the new path is proven
  live (this project's own "verify live" convention applies hard here).
- **Quality changes without evals.** Adaptive planning / reading /
  verification are exactly the changes that can *look* better while
  regressing on some query classes. None should merge without an eval that
  distinguishes it from the prior behavior.

---

## 12. Closing judgement

This codebase's excellence is its restraint — it says no to function
calling, no to dependencies, no to a build step, and yes to determinism,
fail-soft, and evidence. The right architectural future is *more of that
discipline pointed at harder problems*: type the contracts without a build
step, modularize capabilities without a framework, make runs durable with
a platform primitive instead of clever code, and spend the real energy on
*research quality* — planning, reading, verifying — because that is the
only axis on which "stellar" is actually measured. MCP belongs on the
*outbound* edge (expose the pipeline as a tool), not the inbound one
(don't route your clean REST calls through it). Keep subtracting where you
can; add only where it buys depth.
