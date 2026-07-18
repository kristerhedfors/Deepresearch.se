# DRPL/1 — the Deep Research Pipeline Language

*(2026-07-17, owner directive: "there should be a formal language declaring
the structure of deep research pipelines … to encode and explore and compare
such pipelines on a structural level" — established languages were surveyed
first (§2); none carries the two things this project needs declared, so this
language was defined. DRPL is the structural companion to the DRSW workspace
interchange standard (`docs/WORKSPACE-PROTOCOL.md` — workspaces carry DRPL
documents in their `pipelines` section, node manifests advertise DRPL
fingerprints) and to the vision both serve
(`docs/STACKLESS-RESEARCH.md`). Reference tooling: `sdk/drpl.mjs`
(dependency-free, unit-tested in `npm test`). JSON Schema:
`docs/schemas/drpl-1.schema.json`. Two committed real-world documents:
`docs/examples/pipeline-server.drpl.json` and
`docs/examples/pipeline-secure.drpl.json` — the reference node's two deployed
pipelines. Experimental, like everything here.)*

## 1. What DRPL declares, and why

A deep-research pipeline — triage → source gathering → gap audit →
synthesis → validation — has a *structure* that is independent of any
implementation: which phases exist, what feeds what, which phases are
optional or looped, what happens when one fails, which model class handles
each, and — the part this project cares most about — **where each phase runs
and which parties receive which data**. Today that structure lives buried in
orchestration code (`src/pipeline.js`, `public/js/drc-research.js`), visible
only by reading it.

DRPL makes the structure a first-class, machine-comparable artifact:

- **encode** — one JSON document per pipeline, declaring phases and their
  contracts;
- **explore** — render, inspect, and carry pipelines in workspaces and node
  manifests, so a user can see what processing their data went through and
  what a node offers *before* visiting;
- **compare** — canonical structural fingerprints and diffs at defined
  levels of abstraction, so "these two nodes run the same research,
  differently placed" is a checkable claim rather than marketing.

DRPL is **descriptive, not executable**: it declares what a pipeline's
structure *is*; it is not a workflow engine's input. That is deliberate
(§2 explains why the executable languages don't fit), and it is what keeps
the language small enough that two independently built nodes can honestly
compare declarations.

## 2. Prior art: is there an established language for this?

Surveyed before inventing (per the owner's directive). Three families
exist, none fits:

**Scientific workflow languages.** The
[Common Workflow Language](https://www.commonwl.org/) (CWL) is the
established vendor-neutral open standard for declaring analysis workflows;
[WDL](https://openwdl.org/), [Nextflow](https://www.nextflow.io/), and
[Snakemake](https://snakemake.github.io/) are its widely used siblings.
They declare **task DAGs over files on compute stacks**: inputs, outputs,
containers, resource hints. They have no vocabulary for LLM research phases
(triage/gap-audit/synthesis semantics), no failure-degradation contracts
(fail-soft "degrade to fewer sources" has no CWL encoding), and — decisive
here — **no data-path/privacy placement semantics**: nothing in CWL can say
"this step runs in the user's browser and only the search query reaches a
third party". They also presuppose an engine executing the description,
i.e. exactly the stack this project's client tier exists to not have.

**Orchestration/workflow-engine formats.**
[Argo Workflows](https://argoproj.github.io/workflows/), Kubeflow
Pipelines, [AWS Step Functions' ASL](https://states-language.net/), the
CNCF [Serverless Workflow](https://serverlessworkflow.io/) specification,
BPMN 2.0; imperative-code siblings Airflow/Dagster/Prefect. Generic control
flow (states, retries, branches) bound to a specific executor or cloud.
Same gaps as above, plus their retry/error models describe *engine*
behavior, not *product* degradation semantics, and a browser-resident
pipeline has no place in any of them.

**LLM-agent flow formats.** LangGraph (code, not a document format),
Microsoft Prompt Flow (YAML DAGs), Langflow/Flowise/n8n/Dify (tool-specific
JSON/YAML exports), and a fast-moving 2025–26 research literature on
declarative agent-workflow languages — e.g. [a declarative language for
building and orchestrating LLM agent workflows](https://arxiv.org/abs/2512.19769),
[DADL](https://arxiv.org/pdf/2605.05247) for enterprise tool libraries, and
[Credo](https://arxiv.org/pdf/2604.14401)'s belief/policy control of LLM
pipelines. These get closest in vocabulary (LLM steps, tools, judges) but
every one is either bound to its runtime or aimed at *executing* flows;
none is a vendor-neutral standard, none declares privacy placement or
degradation contracts, and most presuppose function calling — the exact
mechanism this project's pipelines are built to avoid (invariant 1).

**Adjacent but different purpose.** W3C PROV / OpenLineage describe what
*did* happen (provenance/lineage events), not what a pipeline's structure
*is*; RO-Crate packages research artifacts (DRSW's cousin, credited there).

Conclusion: the two load-bearing requirements — **privacy placement as
declared structure** and **implementation-neutral structural
comparability** — exist in no established language. DRPL defines them and
deliberately nothing else; where DRPL ends (task execution, resources,
containers), the established languages above are the right tools.

## 3. The language

A DRPL document is JSON (the project's lingua franca; YAML is a fine
authoring surface that serializes to the same structure):

```json
{ "drpl": 1,
  "id": "example.org/my-research/secure",
  "title": "prose — never structural",
  "meta": { "anything": "— never structural" },
  "phases": [ … ] }
```

`drpl` (the version), `id` (stable document identifier,
`<node-or-org>/<name>[/<variant>]`), and a non-empty `phases` array are
required.

### 3.1 Phases

One object per phase:

```json
{ "id": "gap-check",
  "kind": "gap-check",
  "needs": ["search", "notes"],
  "optional": false,
  "repeats": { "max": 3 },
  "exec": { "at": "server" },
  "calls": [ { "party": "model-provider", "carries": ["question", "source-digest"] } ],
  "model": { "route": "planning", "mode": "json", "tools": false },
  "failure": { "policy": "soft", "degradesTo": "current coverage accepted" },
  "title": "prose", "notes": "prose" }
```

- **`kind`** — the phase's research role. Registered vocabulary: `triage`,
  `enrichment`, `recall`, `search`, `notes`, `gap-check`, `synthesis`,
  `validation`, `tool-loop`, `transform`, `grade`, `human-gate`. Open via
  `x-…`. Note `search` covers **both** live web search and its offline
  knowledge-harvest counterpart — same structural role, different placement
  (that identity is the point; see §5).
- **`needs`** — dataflow: the phase ids this phase consumes. Must form a
  DAG.
- **`optional`** — true for phases that run only when configured/available
  (enrichments, recall, granted web search).
- **`repeats`** — bounded looping: `true` or `{ "max": n }` means the phase
  and its `needs` subgraph may re-run up to the bound (the gap-check →
  follow-up-search loop). *That a pipeline loops* is structure; *how many
  times* is detail (§4's levels).
- **`exec.at`** — `client` (the user's browser/device) or `server` (the
  node's server component). The zero-or-one-server pair model
  (`docs/DISTILLSDK.md`) needs no finer grain.
- **`calls`** — the privacy placement: which parties **receive data**
  during the phase, each with `carries`, the explicit list of what crosses
  the wire. Registered parties: `origin-server`, `model-provider`,
  `search-provider`, `embedding-provider`, `enrichment-provider`,
  `self-hosted` (+ `x-…`). Absent/empty `calls` asserts **no data leaves
  the executing tier**. This is the minimal-outbound rule (CLAUDE.md
  invariant 4) as checkable declaration: "only the search QUERY reaches
  the server and Exa" becomes `carries: ["search-queries"]`.
- **`model`** — present when the phase calls an LLM: `route`
  (`planning` | `answer` — the split-model-routing invariant as structure),
  `mode` (`json` | `stream`), `tools` (`false` = deterministic, no function
  calling — the default posture; a list of tool names declares an agentic
  loop explicitly, the way the reference's dev-mode source investigation is
  a declared exception).
- **`failure`** — `policy: "soft"` (degrades to a lesser result, pipeline
  continues — invariant 2) or `"hard"` (the phase failing fails the
  request); optional structural `retry` (e.g. `{ "failover": true }`);
  `degradesTo` is prose.
- **`title`/`notes`/`meta` and all prose fields** — for humans; never part
  of any structural comparison.

Validation is exactly `validateDrpl` in `sdk/drpl.mjs` (the schema mirrors
it; the tooling is authoritative).

## 4. Structural comparison

### 4.1 Canonical form

`canonicalForm(doc, level)` projects a document to a comparable value:
phases in **deterministic topological order** (Kahn's algorithm,
lexicographic id tiebreak), **ids replaced by positions** (so naming never
matters), prose stripped, keys sorted. Two documents are structurally equal
at a level iff their canonical forms are byte-equal — which is what the
**fingerprint** hashes:

```
drpl1:<level>:<first 16 hex of SHA-256(canonical JSON)>
```

### 4.2 The three levels

| Level | Adds | Answers |
|---|---|---|
| `shape` | kind, dataflow, optionality, loop-or-not, failure policy | *what research happens* — placement-blind |
| `placement` | `exec.at`, `calls` (party + carries), `model` routing | *who runs it and who receives what* — the privacy posture |
| `full` | loop bounds, retry, emits, remaining structural fields | *everything but prose* |

### 4.3 The spine projection

`--spine` drops `optional: true` phases first, **rewiring dataflow through
them transitively** (a phase needing a dropped phase inherits its needs),
then compares at the chosen level. The spine is the *required research
core* — what the pipeline always does, with the configuration-dependent
extras removed.

### 4.4 Diff

`diffDrpl(a, b, level)` aligns phases by id and reports
added / removed / changed-with-fields / same — the exploratory tool the
fingerprints summarize.

## 5. The reference pair, encoded — the demonstration

The two committed examples encode the reference node's two deployed
pipelines: the Se/cure client tier's (`public/js/drc-research.js`) and the
Se/rver tier's (`src/pipeline.js`). The punchline, straight from the
tooling:

```
$ node sdk/drpl.mjs fingerprint docs/examples/pipeline-server.drpl.json --spine
drpl1:spine-shape:24f0fd90325d4ae5
$ node sdk/drpl.mjs fingerprint docs/examples/pipeline-secure.drpl.json --spine
drpl1:spine-shape:24f0fd90325d4ae5          # ← EQUAL: the same research spine

$ node sdk/drpl.mjs diff docs/examples/pipeline-server.drpl.json \
                         docs/examples/pipeline-secure.drpl.json --spine --level placement
level: spine-placement
  ~ gap-check  (at)
  ~ search  (at, calls, model)
  ~ synthesis  (at)
  ~ triage  (at)
  ~ validation  (at)
```

The two tiers are **structurally identical research** (one spine-shape
fingerprint) whose every phase differs in **placement** — `server` vs
`client`, and in `search` also *what kind of party receives what*: the
server tier sends `search-queries` to a `search-provider`; the client tier
harvests from the `model-provider`'s knowledge (and its optional granted
`web-search` phase declares the one bounded `origin-server` exception in
`calls`, exactly as invariant 4 states it in prose). At plain `shape` (no
spine), the diff instead names the optional phases each tier adds:
`enrichment`/`notes` server-side, `recall`/`web-search` client-side.

That is the language doing its job: the privacy split — this project's
central claim — expressed as two fingerprints and a five-line diff.

## 6. DRPL in the federation

Where documents travel (all specified in `docs/WORKSPACE-PROTOCOL.md`):

- **Workspaces** carry DRPL documents (`pipelines` section) and DRPL
  fingerprints in their `provenance` trail — the "enrichment states" a
  workspace has been through are declared structures, not vibes.
- **Node manifests** (`/.well-known/drsw.json`) advertise offered pipelines
  with fingerprints, so clients compare nodes structurally before visiting
  ("same spine, client-placed" is a routing criterion).
- **Routes** name the DRPL id intended at each hop.

## 7. Conformance and versioning

A conforming DRPL implementation accepts every document `validateDrpl`
accepts, rejects what it rejects, and reproduces the canonical
forms/fingerprints of `sdk/drpl.mjs` bit-for-bit (the unit suite
`sdk/drpl.test.mjs` doubles as the conformance test set; the two example
documents' spine-shape equality is pinned there). Versioning: additive
optional phase fields do not bump `drpl` (they surface only at `full`
level); changes to vocabularies, required fields, canonicalization, or
levels bump it. Registered vocabularies (`kind`, `party`) grow by revision
of this document; `x-…` terms are always open and compare like any other
value.
