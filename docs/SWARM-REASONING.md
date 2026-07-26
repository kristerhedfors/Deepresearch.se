# Swarm reasoning — many tiny models, one task

**Status:** experimental, shipped 2026-07-25. **Code:**
`public/js/swarm-core.js` (the algorithm, pure), `public/js/swarm-runtime.js`
(the worker pool and the loop), `public/js/ondevice-engine.js`
`spawnSwarmMember` (one isolated browser worker per member),
`src/orchestrator-api.js` (`POST /api/orchestrator/plan`),
`src/orchestrator.js` (the `swarm` node kind in the executor).

A swarm is the Orchestrator's fourth sub-agent kind. Where a `deep_research`
node searches the web and an `introspection` node reads this site's own source,
a `swarm` node answers its task with **N copies of a 1-bit Bonsai model running
at once inside the user's browser** — each in its own Web Worker, with its own
model instance — and reduces their disagreement to one brief plus a measured
confidence number.

The reasoning never leaves the device. The weights are already in this
browser's OPFS (the on-device tier, `docs/BONSAI-27B-PHONE-INFERENCE.md`), the
task text goes to local workers, and the drafts, critiques and rejected
candidates exist nowhere else. Only the node's finished brief is attached to
the chat request.

## Why a swarm rather than one bigger call

A 1-bit 1.7B model is not a small frontier model; it is a noisy sampler. A
single draft from it is unreliable. What carries signal is the **spread** across
several drafts: where independent members land in the same place is usually
where the model actually knows something. The algorithm exists to extract that
signal and to *report how much of it there was* — a swarm that did not converge
says so in its own brief, and the merge phase is told to treat it as weak.

This is also the cheapest compute in the system. Members cost nothing but the
user's own GPU time, so a swarm is the right node for judgement calls,
option-ranking, brainstorming and sanity checks — and the wrong node for
anything needing a lookup.

## The algorithm: diverge → critique → converge

One round, repeated at most `rounds` times (default 2, max 3):

**1. Diverge.** All N members answer the same task simultaneously. Each is given
a distinct **stance** — direct, skeptic, concrete, structural, practical, risk
(`MEMBER_STANCES`, wrapping past six). Diversity has to be manufactured:
temperature alone does not spread tiny models far enough for a vote to mean
anything, and eight runs of one prompt produce eight paraphrases of one mistake.
A stance changes what a member looks for, never what it may conclude.

**2. Critique.** Members review each other on a **ring** — member *i* reviews
member *i+1*, the last reviews the first. N critiques rather than N², which
matters at phone speed and costs little: every draft is reviewed exactly once,
nobody reviews themselves. The reply is three fixed lines
(`VERDICT: support|dispute`, `FLAW:`, `KEEP:`) because it is **parsed**, not
read — asked for free-form review, a tiny model returns a fourth paraphrase.
An unparseable reply counts as an abstention, never as support.

**3. Converge — in plain code, with no model in the loop.** Each draft is scored
on two signals:

| signal | what it is | weight |
| --- | --- | --- |
| **centrality** | mean content-token overlap (Jaccard) with the other drafts — the swarm's centre of mass | 1.0 |
| **peer vote** | the one critique it received: support `+1`, dispute `−1`, abstention `0` | `VOTE_WEIGHT` = 0.35 |

Centrality leads because it survives a bad critique; the vote is one tiny
model's opinion, and tiny models cheerfully support a confident irrelevance. The
vote's weight is deliberately smaller than the spread centrality covers, so a
single enthusiastic critique can never promote an outlier over the consensus —
both directions are pinned in `swarm-core.test.js`. Empty drafts are excluded
outright: a member that produced nothing must not win by having no one disagree
with it.

The round's outputs are the **lead** draft, the deduplicated `KEEP` lines, the
`FLAW` lines from members that actually *disputed* (a supporter's nitpick is not
dissent), and the **agreement score** — mean pairwise overlap across all drafts,
0…1.

**The stop condition.** Another round costs a full parallel decode plus a
critique pass, so it has to buy something: the swarm continues only while rounds
remain *and* there is unresolved disagreement — agreement below
`AGREEMENT_FLOOR` (0.34) or an outright disputed lead. A converged swarm stops
after round 1, which is the common case; `rounds` is a ceiling, not a count. A
second round shows members the current lead **as a claim to check**, never as
"the best answer" — telling a tiny model it is looking at the winner collapses
the swarm into agreement with it, which is precisely the failure the agreement
score exists to detect.

**Consolidation.** One final member pass rewrites lead + keeps + dissent into
the brief. It is not load-bearing: if it fails, the lead draft is already a
usable answer.

### The agreement metric

Content tokens are words of 3+ characters with stopwords removed — **in both
English and Swedish**. This is not decoration: an English-only stopword list
scores two Swedish drafts that share nothing but *och/att/det/som* as nearly
identical, which would report a split swarm as converged. `swarm-core.test.js`
pins the two languages landing in the same band.

## How many browsers is "any number"

The plan may ask for up to `SWARM_MAX_MEMBERS` (12) members. The device
constraint is expressed as **concurrency**, not as a smaller team
(`planSwarmCapacity`): a phone runs a swarm of 8 as four waves of two rather
than silently shrinking it to two. Concurrency comes from
`navigator.hardwareConcurrency` and `navigator.deviceMemory` against the model's
own footprint, capped at 4 live workers; with no hints the pool stays
deliberately small. Workers are spawned once and reused across rounds, so each
pays the model compile only once, and members are not pinned to a worker —
generation is stateless, so a task queue beats affinity.

### The memory budget (feedback #26, 2026-07-26)

Two Safari tab crashes "after some thinking" were reported against orchestrator
mode. A renderer OOM is the expected signature, and N concurrent in-browser
models is by far the largest allocation this app makes, so the worker count is
now treated as a budget rather than a parameter:

- **The pool is sized against the model that is actually cached here.** The
  earlier sizing divided reported RAM by the model's footprint but fell back to
  a fixed two members when the browser reported nothing — and Safari and
  Firefox report nothing. A 1.2 GB build therefore got the same pool as a
  300 MB one. Now the unknown case divides an assumed budget
  (`ASSUMED_MEMORY_BUDGET_GB`) by the model's runtime footprint
  (`MODEL_RUNTIME_FACTOR` over its bytes on disk), so the bound can only fall
  as the model grows.
- **Live heap pressure tightens it further** where the browser measures one
  (`heapUsedRatio` over Chrome's `performance.memory`): above 70 % the pool
  halves, above 85 % it runs one member at a time. An absent measurement is
  read as unknown, never as "plenty".
- **One run at a time.** A send calls `stopSwarms()` first, so a superseded
  swarm's workers are terminated instead of decoding alongside their
  replacements. Nothing used to stop a swarm whose turn was abandoned.
- **One pool per run**, shared by every swarm node in the plan, and **at most
  one swarm node per plan** (`normalizeWorkflow` downgrades the extras to
  `custom`; `validateWorkflow` reports them). The prompt already asked for one
  — this is the bound.
- **An abandoned generation's worker is retired, not reused.** A deadline
  rejects the wrapper without stopping the decode, so the runtime aborts what
  it can, terminates that worker and puts a fresh one in its slot.
- The **singleton engine's** resident model is freed before the pool spawns
  (`unloadOnDeviceModel`), a worker that reports an uncaught error is
  terminated rather than just dereferenced, and a member that crashes twice
  (`MEMBER_CRASH_BUDGET`) stops respawning.
- `pagehide` terminates everything.

### Catching what can be caught

A renderer OOM kills the page before any handler runs, so the catch is layered:

1. A durable **breadcrumb** (`ONDEVICE_CRASH_KEY` in `localStorage`) is written
   *before* the workers spawn and updated as the phase advances — the only
   thing that survives a tab the browser kills. A clean finish clears it.
2. `window` `error` / `unhandledrejection` guards for the failures that leave
   the page alive; a memory-class one stamps the breadcrumb and ends the swarm
   early rather than buying another round of allocations.
3. On the next request, `swarmCrashDiag()` reads the crumb back (once) as
   counters for the existing `client_diag` channel: `died`, the phase and
   round it stopped in, the member/concurrency counts, the model size in MB
   and a failure class. **Counters and classes only** — invariant 4: no task
   text, no node ids (they are slugified from plan names, which come from the
   user's request), no drafts.

## Where it runs, and why the request is split in two

The orchestrator executes server-side, the swarm executes in the browser, and
one streamed `/api/chat` request has no channel back to the page mid-run. So an
orchestrator send with a swarm-capable device is **two calls**, the same shape
as the sandbox's client-orchestrated loop:

1. `POST /api/orchestrator/plan` — the same JSON plan phase, on the same fixed
   `DEFAULT_MODEL` (invariant 3), returning the team as data. The `swarm` kind
   is offered to the planner only when the client announced a capability
   (`{modelId, modelLabel}`); the endpoint is gated on `developer_mode` like
   orchestrator mode itself, quota-gated, and its spend is recorded.
2. The browser renders the workflow graph, runs the swarm nodes locally, and
   then sends `/api/chat` with `orchestrator_mode: true`, the `workflow` it was
   given, and `swarm_results`. The executor skips its own plan phase, seeds
   those nodes as finished, runs the rest of the team, and merges.

The plan comes back through the identical `normalizeWorkflow` gate on the server
(`resolveSwarmResults` clamps the briefs) — a plan that took a detour through
the browser is still model output, never a client instruction. A swarm node is
**first-wave by construction**: it runs before the request exists, so it can
never depend on another node, and `normalizeWorkflow` drops any dependency the
plan invented. Other nodes may depend on *it*.

Fail-soft at every step (invariant 2): no capability, a failed plan fetch, a
dead engine, every member timing out — each of these ends with an ordinary
orchestrator request. A swarm node that arrives with no brief is run
server-side as a `custom` specialist, told that the swarm did not deliver.

## What the user sees

The workflow node is taller than its siblings and carries **one dot per member**
plus a readout of the round and the agreement so far (`R2/3 · 62%`). Dots light
up as members load, pulse while they decode, and settle to done or failed;
`swarm_update` events drive them (locally emitted today, wire-ready for a
server-hosted swarm). The activity trace narrates the same run in words. In the
graph backdrop the node is a green cluster of satellites around a hollow centre
— green because it is the only node running on the user's own device.

The brief handed to the merge leads with its provenance:

```
[Local swarm: 6 × Bonsai 1.7B · 1-bit in this browser, 2 rounds, peer
agreement 41%. The members did NOT converge — treat this as a weak signal.]
```

so the answer model can weigh it correctly. The brief ends with the unresolved
disagreement rather than dropping it.

## Bounds

| bound | value | why |
| --- | --- | --- |
| `SWARM_MAX_MEMBERS` | 12 | the plan's ceiling; the device sets concurrency |
| `SWARM_MAX_ROUNDS` | 3 | each round is a full parallel decode |
| `SWARM_DRAFT_MAX_TOKENS` | 320 | a draft is a paragraph |
| `SWARM_CRITIQUE_MAX_TOKENS` | 160 | three lines |
| `MEMBER_DEADLINE_MS` | 300 s | covers the first call's model compile on a phone |
| `SWARM_DEADLINE_MS` | 900 s | the node's own ceiling, now enforced per node |
| swarm nodes per plan | 1 | every one of them spawns model instances |
| `MEMBER_CRASH_BUDGET` | 2 | a crash that repeats is the device saying no |
| `ASSUMED_MEMORY_BUDGET_GB` | 1.0 | what a browser that hides its RAM is allowed to bet |
| `HEAP_TIGHT` / `HEAP_STOP` | 0.7 / 0.85 | live heap fill that halves the pool / drops it to one |

### Owed wiring (stream.js)

`swarm-runtime.js` exposes the seams, but the send path does not use all of
them yet:

- `runSwarmNodes` is still called **without a `signal`**, so an aborted send is
  only stopped by the supersession rule (the next send), not by the user's Stop
  button. Pass the send's `AbortSignal`.
- `stopSwarms()` should be called from the abort path and on a chat-mode
  switch, not only implicitly by the next run.
- `swarmCrashDiag()` should ride along in `payload.client_diag` (as `sw`), and
  `sanitizeClientDiag` (`src/validation.js`) has to whitelist that block before
  it reaches the chat log.

## Still owed (live-verify)

A real round trip on a device with cached Bonsai weights: pick Orchestrator, ask
a judgement question, confirm the plan includes a swarm node, the member dots
animate through both rounds, the agreement readout moves, the merged answer
reflects the brief, the reopened conversation replays the graph, and the
`chat_logs` row carries `orchestration.swarm`. Also a Swedish request (Swedish
member drafts, agreement measured with the Swedish stopword list) and a
knob-off device (the plan gets no swarm kind at all).
