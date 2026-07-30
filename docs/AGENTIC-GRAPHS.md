# Agentic graphs — what holds up under checking, and what it means for this codebase

*(Research note, 2026-07-30. Written because "agentic graphs" is the current
loud idea and the request was to check what Boris Cherny says about it before
deciding whether it changes anything here. Short answer: the claim most often
attributed to him is not his, the underlying idea is real but older and
narrower than the hype, and this codebase already runs three graph-shaped
subsystems. The highest-value move is measurement, not architecture.
Companions: `docs/ARCHITECTURE-ROADMAP.md` §5.5/§6, `docs/ARCHITECTURE-GAP-ANALYSIS.md`
P4/P19, `docs/PIPELINE-LANGUAGE.md`, `docs/SWARM-REASONING.md`.)*

---

## 1. What Boris Cherny actually said

Two positions are verifiable and directly attributable.

**Loops, not prompts.** The line that started this thread of discussion:

> "I don't prompt Claude anymore. I have loops that are running. They're the
> ones that are prompting Claude and figuring out what to do."

That is the whole of "loop engineering" as he framed it — a claim about *who
writes the prompt*, not a claim about topology. It describes one agent's
autonomous cycle: find work → plan → act → check → continue or stop.

**Agentic search over vector RAG.** On Claude Code's retrieval design:

> "Early versions of Claude Code used RAG + a local vector db, but we found
> pretty quickly that agentic search generally works better. It is also
> simpler and doesn't have the same issues around security, privacy,
> staleness, and reliability."

Corroborated by Cat Wu (Anthropic): "We did use vector embeddings initially.
They're really tricky to maintain because you have to continuously
re-index… Claude is really good at agentic search." Anthropic removed the
embedding pipeline, local vector DB and chunking heuristics from Claude Code
and replaced them with glob/grep/read.

### What he did *not* say

A widely circulated X post claims "Boris Cherny just dropped a 7-page PDF on
Graph Engineering — how 4 Claude prompts replace 4 trained ML models"
(extraction → resolution → summarization → querying). **That PDF is not his.**
It is independently compiled and carries no affiliation with, or endorsement
by, Anthropic. The related open-source skill that circulated alongside it
(`codejunkie99/graph-engineering` — a 9-stage KG pipeline plus task-graph
patterns) credits a Southeast University graduate course and Google DeepMind ×
MIT's scaling work, and explicitly claims no Cherny or Anthropic affiliation.

Treat "Cherny on agentic graphs" as a misattribution. He is on record about
loops and about retrieval; the graph framing was built on top of him by others.

---

## 2. What an agentic graph actually is

Stripped of marketing, the definition is unremarkable and useful:

- **nodes** — a unit of work: a model call, ordinary code, a human decision;
- **edges** — routing: what runs next, and on what condition;
- **state** — what passes between nodes.

The relationship to loops is containment, not succession: *a loop is already a
graph — one whose path returns to an earlier node.* Graphs buy the things a
single loop cannot express: parallel branches, per-node model/tool choice,
independent verification of a node's output, and human approval gates.

So "loops → graphs" is not a paradigm shift. It is the same control-flow
vocabulary every workflow engine has had, applied to model calls.

### The critique, which is worth keeping

Ksenia Se's FOD#159 makes three charges that survive scrutiny:

1. **Terminology inflation.** "Graph" is being used for control flow,
   knowledge structures, execution traces, and improvement loops at once —
   four different problems, one word.
2. **False equivalence.** The viral "18% higher accuracy, 85% lower cost"
   figure comes from one specific GraphRAG study and was laundered into a
   claim about industry-wide adoption by Microsoft, Stanford and Anthropic.
   None of that is accurate.
3. **Unnecessary complexity.** Most workflows are linear and get nothing from
   a graph framework except state management, debugging overhead and new
   failure points.

Point 1 matters most for us, because the two senses of "graph" have opposite
implications for this codebase (§4 vs §5).

---

## 3. The real evidence: when multi-agent topologies help

The substantive research behind the trend is Google DeepMind × MIT's *Towards
a Science of Scaling Agent Systems*. Its findings are specific, and several of
them are uncomfortable for the hype:

| Finding | Number |
|---|---|
| Parallelizable tasks (financial reasoning), centralized coordination vs single agent | **+80.9%** |
| Sequential tasks (PlanCraft planning), *every* multi-agent variant | **−39% to −70%** |
| Error amplification, independent multi-agent | **17.2×** |
| Error amplification, centralized (orchestrator validates) | **4.4×** |
| Accuracy of a model predicting the right architecture from task properties | 87% (R² = 0.513) |

Three conclusions:

- **Task structure decides, not agent count.** Decomposable work parallelizes
  well; genuinely sequential work is actively damaged by splitting it, because
  coordination overhead eats the reasoning budget.
- **Centralization is the error control.** An orchestrator that inspects node
  output before passing it on cuts error amplification by roughly 4×. Peer-to-peer
  agent meshes are the worst case.
- **Architecture is predictable from measurable task properties**, which means
  a cheap up-front classifier beats a heuristic.

---

## 4. Where this codebase already is

This is not a system that needs to discover graphs. It runs three, and they
were built before the term got loud.

**The Orchestrator is a task-graph engine.** `public/js/orchestrator-core.js`
validates a plan into a DAG (`validateWorkflow`), resolves it into parallel
waves (`workflowWaves`), and executes deterministically. It has a closed node
vocabulary (`AGENT_KINDS`), cycle detection and cycle *breaking*, bounded
fan-out (`MAX_AGENTS = 6`), bounded depth (`MAX_WAVES = 3`), and per-node
lifecycle events on the wire (`workflow`, `agent_update`). The plan is data;
the executor is code — which is how it upholds invariant 1 without function
calling.

**DRPL/1 is a declarative graph language** (`docs/PIPELINE-LANGUAGE.md`,
`sdk/drpl.mjs`). It already declares phases, edges, optionality, failure
degradation, model class *and* — the part no other workflow language carries —
where each node runs and which parties see which data. It is descriptive
rather than executable, deliberately.

**Swarm reasoning is a third topology** (`docs/SWARM-REASONING.md`): N
independent replicas, then critique, then convergence with a measured
agreement score.

### The scorecard against the evidence

Measured against §3, the existing design lands well:

- It is **centralized** — one plan phase, one Worker executor, one synthesis
  merge. That is the 4.4× side of the error-amplification result, not the
  17.2× side.
- It **caps sequential depth** at three waves and instructs the planner to
  "prefer the fewest that genuinely divide the work". That is the PlanCraft
  finding, encoded as a bound.
- It **keeps dependency-ordered work serial**: the fan-out design explicitly
  restricts itself to comparison/survey questions, and multihop questions stay
  in the serial cascade (`src/pipeline.js`). Again, exactly what the evidence
  says to do.
- Swarm output carries a **confidence number**, and a swarm that did not
  converge says so — the verification edge the graph literature keeps
  rediscovering.

The gap is not the architecture. It is that the largest parallelism win is
**built and switched off**: `runSubquestionFanout` exists in `src/pipeline.js`,
gated by `SUBQ_FANOUT_ENABLED = false` (`src/budget.js:460`), pending
bench-gate evidence. `docs/ARCHITECTURE-GAP-ANALYSIS.md` independently rates
P4 (determinism over parallelism) at **Δ −15** — over-applied — and names
sub-question fan-out "the largest untapped lever". The outside research agrees
with the repo's own audit.

---

## 5. What to actually do

Ranked by value over cost. Nothing here requires a new framework.

### 5.1 Flip the fan-out with evidence (highest value, already scoped)

The DeepMind×MIT result raises the prior that `SUBQ_FANOUT_ENABLED` pays off,
because it targets precisely the decomposable case where the +80.9% lives, and
it is centrally orchestrated. It does not remove the need to measure — the
same paper is why the deep-tier features were switched off after benching.
Run `tests/bench-gate.mjs` before and after; flip only on a scored win; migrate
the orchestration shell to Cloudflare Workflows in the same effort, as
`src/budget.js` and roadmap §6 already bind.

### 5.2 Classify task shape, not just complexity (cheapest new win)

> **Status: shipped 2026-07-30.** Triage emits `decomposition`
> (`"independent"` | `"sequential"`), and `subquestionsAreIndependent`
> (`src/pipeline.js`) is what the fan-out now gates on. `multihop` is refused
> on both paths whatever the classifier says, and an absent field falls back to
> the old comparison/survey proxy, so behaviour degrades to exactly what it
> was. It is INERT until §5.1 flips `SUBQ_FANOUT_ENABLED` — this change makes
> that flip better-targeted, it does not perform it.

Triage already emits `complexity`, and `applyComplexityToPlan` uses it to cap
depth. The paper's 87%-accurate predictor says the *decomposability* of a task
is separately measurable and separately decisive. Extend the triage JSON with a
parallelizability signal and let it choose between fan-out and the serial
cascade, rather than budget alone choosing. This stays a JSON field the Worker
branches on — invariant 1 intact, invariant 3 intact (fixed `DEFAULT_MODEL`),
and it needs EN+SV parity like every other routing gate (invariant 6).

### 5.3 Give DRPL a topology vocabulary

DRPL declares structure so two independently built nodes can compare
pipelines honestly. It cannot currently express fan-out degree, wave depth, or
where verification sits — the three properties the evidence says determine
whether a topology works. Adding them makes "these two nodes run the same
research, differently placed" checkable at the level that matters, and it is
pure spec work with a reference implementation already in `sdk/drpl.mjs`.

### 5.4 The genuinely missing half: knowledge-graph memory

> **Status: shipped for the Se/rver tier, 2026-07-30** — the owner directed it
> in the same session this note was written. Account-scoped memory now exists
> as `docs/ACCOUNT-MEMORY.md`: durable linked notes stored in Obsidian's shape,
> downloadable as a vault, opt-in and off by default. The exposure argued for
> below was written down rather than assumed (`ACCOUNT-MEMORY.md` §4), and the
> Se/cure answer is the one this section anticipated — **no memory of this
> kind, and a different design if it is ever wanted there**. Two things this
> section asked for are still open: RETRIEVAL (notes are written and exported,
> but nothing reads them back into a request — that changes every answer, so it
> belongs behind the bench gate as its own change) and the WORKSPACE-scoped
> form (what shipped is account-scoped).

The *other* sense of "graph" — entity/relation memory that outlives a context
window — had no implementation here at all. There is RAG, there are projects,
there are workspaces; there was no linked entity store. The pipeline forgot
everything structural between runs.

The right home is the **workspace**, since the workspace is the unit that
travels. A workspace-scoped knowledge graph, built by the extraction →
resolution → summarization → query pattern (which is sound regardless of who
wrote the PDF), would let research accumulate across sessions instead of
restarting.

**It needed a privacy ruling before it needed code.** A knowledge graph is not
a cache of what the user already had — it is a distilled, linked, cross-
referenced summary of everything a workspace ever saw, which is materially
easier to re-identify from than the raw chats. That makes it a new exposure
surface, and it needs an explicit answer for the Se/cure tier (where the server
is in no data path, so the graph must be built and held client-side or not at
all). This is the one item here that touches invariant 4, which is why it went
to the owner rather than straight into a branch.

If the workspace-scoped form is built later, that exposure still owes a row in
the `docs/WORKSPACES.md` ledger — the account-scoped version that shipped is
governed by `ACCOUNT-MEMORY.md` §4 instead, because nothing about it travels.

### 5.5 What not to do

- **Do not adopt a graph framework.** LangGraph and its siblings would break
  invariant 5 (zero runtime dependencies) to replace an executor that is ~430
  lines, already tested, and already fits the wire protocol. The
  "unnecessary complexity" critique in §2 applies squarely.
- **Do not let graphs re-introduce model-driven control flow.** The plan is
  data and the executor is code; that is what makes the Orchestrator work on
  models with unreliable tool calling. Any node-routing decision that migrates
  into a model at run time is invariant 1 being lost by increments.
- **Do not "fix" the arXiv RAG by citing Cherny.** His agentic-search result
  is about code on a filesystem the agent can grep, and this repo *already*
  follows it there — introspection uses `grep_source` / `read_file` /
  `list_files` over real source, not embeddings. The 772,658-vector arXiv index
  is the case his argument does not reach: there is no filesystem to grep, no
  staleness problem of the kind he describes, and dense retrieval is the only
  way in. Same conclusion, opposite mechanism, and the distinction is worth
  keeping written down.

---

## 6. Summary

"Agentic graph" is a useful piece of vocabulary carrying an inflated claim, and
the loudest version of that claim rests on a misattribution.

The scaling study is the part worth acting on. It says four things: centralize,
parallelize only what decomposes, verify at the node, and predict the topology
from the task rather than guessing it. This codebase does the first three
already. The fourth is half-built — the fan-out exists and is switched off.

So the near-term work is not architectural. Measure the fan-out that is already
written, and teach triage to tell a decomposable question from a chained one.
The knowledge-graph half is a separate question and a privacy one first, which
is why §5.4 sends it to the owner before it sends it to a branch.

## Sources

- Boris Cherny on agentic search vs RAG — <https://x.com/bcherny/status/2017824286489383315>
- Building Claude Code with Boris Cherny (Pragmatic Engineer) — <https://newsletter.pragmaticengineer.com/p/building-claude-code-with-boris-cherny>
- What Is Loop Engineering? — <https://explainx.ai/blog/what-is-loop-engineering-ai-agents-2026>
- FOD#159: Is Graph Engineering Real? (Ksenia Se, Turing Post) — <https://www.turingpost.com/p/is-graph-engineering-real-why-everyone-is-talking-about-it>
- Towards a Science of Scaling Agent Systems (Google DeepMind × MIT) — <https://research.google/blog/towards-a-science-of-scaling-agent-systems-when-and-why-agent-systems-work/>
- graph-engineering skill (attribution disclaimers) — <https://github.com/codejunkie99/graph-engineering>
- Agentic search over vector embeddings (awesome-agentic-patterns) — <https://github.com/nibzard/awesome-agentic-patterns/blob/main/patterns/agentic-search-over-vector-embeddings.md>
