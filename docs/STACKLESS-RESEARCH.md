# Stackless deep research — the vision

*(2026-07-17, owner directive. The forward-looking essay tying together the
two standards this repo now defines — DRSW, the secure-workspace interchange
protocol (`docs/WORKSPACE-PROTOCOL.md`), and DRPL, the pipeline structure
language (`docs/PIPELINE-LANGUAGE.md`) — into what they are actually for.
Companion reading: the mission statement in CLAUDE.md, DistillSDK
(`docs/DISTILLSDK.md`), and the deployed feature the standards generalize
(`docs/WORKSPACE-SECURITY.md`). This is a vision document: deepresearch.se
implements the seed of it, not the whole of it, and says so.)*

## 1. The inversion

Every research assistant today is a **stack**: your conversations, sources,
keys and working state live inside one operator's servers, and you visit
them there. Moving providers means export-if-you're-lucky, import-if-they-
bother. The stack is the product; you are a tenant in it.

**Stackless deep research** inverts this. The workspace — the complete
research context: conversations, settings, credentials, borrowed
allowances, pipeline declarations, provenance — is a **sealed, portable
value in user custody**, riding in a URL fragment, a file, a QR code. Sites
become **nodes**: interchangeable, purpose-built processors that a
workspace visits, does work at, and leaves. No node holds the state; the
state holds the itinerary. The name means it double:

- **no stack** — there is no server-side session, database row, or vendor
  silo behind a workspace. A conforming node can be a static file host.
  There is nothing to subpoena, breach, or hold hostage; nothing to
  migrate off of, because you were never *on* it.
- **stackless like a coroutine** — the computation *suspends into a link*.
  A research session frozen mid-flight is one sealed blob; opening it at
  any node resumes exactly there, with the full context. The link is a
  continuation.

The pieces, and where each is specified:

| Piece | Role | Where |
|---|---|---|
| the workspace | the value being computed on | DRSW payload, `WORKSPACE-PROTOCOL.md` §4–5 |
| the envelope | custody — sealed, server-blind transport | DRSW envelope, §3 |
| nodes | the functions applied to the value | conformance class N, §6 |
| handoff links | function composition | §7.2 |
| grants | bounded, revocable fuel lent across nodes | §5.4 |
| DRPL documents | the type language of the functions | `PIPELINE-LANGUAGE.md` |
| provenance + route | the trail behind, the itinerary ahead | §5.3 |

## 2. Nodes: purpose-built, data-compatible

Once the workspace is portable, nodes stop competing on *holding your data*
and start competing on *what they can do to it*. deepresearch.se is the
reference node — a generalist deep-research pair. The interesting future is
the specialized fleet it becomes one of:

- a **domain-literature node** — same pipeline spine, but its `search`
  phase is wired to bio/legal/patent corpora and its validation phase to
  domain rubrics;
- a **local-only node** — every phase `exec.at: client`, `calls` empty or
  self-hosted, for scenario-Z work (the zero-server workflow,
  `WORKSPACE-PROTOCOL.md` §8) on material that must never leave the
  machine;
- an **enrichment node** — no chat at all: it takes a workspace, runs one
  declared transform (geocoding every place name; building a citation
  graph; grading claims against a fresh corpus), appends provenance, and
  hands the workspace back;
- an **institutional node** — a university or newsroom instance whose
  grants lend its subscriptions (search, models) to workspaces that visit,
  metered and revocable, without the visitor ever holding an account.

"Data-compatible" is the load-bearing property: all of them open the same
sealed bundle, apply the sections they understand, ignore the rest, and
re-seal. A user's research career becomes one workspace lineage flowing
through many nodes — **the same data foundation, various purpose-built
processors** — instead of a scatter of incompatible accounts.

## 3. Navigation: routing across processing states

A workspace at any moment is a **data processing/enrichment state**: what
has been gathered, synthesized, validated, and (via the `provenance`
trail) *which declared pipeline structures produced it*. DRPL is what makes
those states navigable rather than anecdotal:

- every hop records the structural fingerprint of what ran
  (`fp: "drpl1:…"`), so "how was this conclusion produced?" has a
  machine-checkable answer reaching back through every node visited;
- every node advertises its offered pipelines as DRPL documents in its
  discovery manifest, so **choosing the next node is a structural
  decision**: *find me a node running my current spine, client-placed* is a
  query over fingerprints, not a reading of privacy policies;
- the `route` section makes multi-node plans first-class: triage and
  gather at a generalist node → domain pass at a literature node →
  final synthesis at the local-only node — authored as an itinerary,
  executed by the user link by link, invisible to every server involved.

This is a new kind of data pipeline: **a pipeline whose steps are sites.**
It is not a workflow engine scheduling containers but a human (or their
agent) carrying a sealed state through a graph of specialized processors,
with structure declared at every edge. The composition primitive is a link;
the type discipline is DRPL; the audit log is provenance; the budget is
grants. Nothing orchestrates it from above, which is precisely why nothing
above it can log, block, or monetize the whole.

## 4. Why the privacy properties survive composition

Each mechanism was built and verified in this repo singly; the standards
make them compose:

- **fragment-only transport** means adding more nodes adds zero servers to
  the data path — the N-node case is exactly as server-blind as the 1-node
  case;
- **re-seal per hop** keeps colluding nodes from correlating a workspace's
  journey;
- **grants stay issuer-metered** — lending capability across the fleet
  never becomes lending identity or unbounded spend, and the minter's
  pause/revoke reaches every node a token wandered to, instantly, because
  the meter never left home;
- **DRPL placement declarations** turn each node's posture into a claim the
  open-source implementation can be audited against — the mission's
  "provable privacy", extended from one site to a federation;
- **scenario Z composes**: a route through exclusively local-placed,
  grant-free nodes is end-to-end serverless research across arbitrarily
  many sites.

## 5. What exists, what's next

**Exists (deployed on the reference node):** the sealed workspace and its
envelope (`/cure/workspace`, hacka.re lineage), grants with live minter
control, ghost crossover, the `.drc` file backup, both pipelines the DRPL
examples encode, and the privacy notice that names a session's actual data
paths. **Specified ahead of code (this pass):** the interchange sections
(`origin`/`pipelines`/`provenance`/`route`), the generalized issuer-scoped
grants, `/.well-known/drsw.json`, and DRPL itself with its tooling
(`sdk/drpl.mjs` — working today).

**Next, in rough order:** the reference node serving its own discovery
manifest and DRPL documents; the workspace composer writing
`origin`/`provenance`; a second node (even a toy local-only one) to prove
the handoff loop end to end; then the routing UX. The standards are written
so each step is small and independently testable, and so that somebody
else's node, on entirely different source code, is as legitimate a next
step as ours.
