# AGENTS.md

Cross-agent guidance for **deepresearch.se** — a Cloudflare Worker that serves
a static chat UI and a streaming deep-research pipeline. This file is the
vendor-neutral entry point: it is meant to be read by **any** coding agent, on
**any** model or harness, not just Claude Code. It carries no model-specific
assumptions.

## Read these first

1. **`CLAUDE.md`** (repo root) — the always-load project brief, kept
   deliberately lean: mission, the load-bearing invariants (deterministic
   no-function-calling pipeline, split model routing, the privacy split,
   EN+SV parity), the git workflow, the test/deploy commands, and the skills
   index. Treat it as authoritative for *how this project is built and what
   must not be broken*. Its reference companions carry the detail:
   `docs/CODE-LAYOUT.md` (the per-module map), `docs/TESTING.md`,
   `docs/PRIVACY-MODEL.md`, `docs/BRANDING.md`. Everything in `CLAUDE.md`
   applies to you regardless of which model you run on.
2. **The skills catalog** — `.claude/skills/<name>/SKILL.md` — the repo's
   institutional **playbooks**: how each recurring kind of work is actually
   done here, written from empirically-observed practice (not docs). Each
   `SKILL.md` has YAML frontmatter with a `description` that says exactly *when
   to load it*. **Before working in an area, open the matching skill.** These
   were originally a Claude Code (CLI) convention, but the knowledge is
   model-agnostic — read them the same way whatever agent you are.
3. **The two SDKs** — the *constructive* counterpart to the operational
   skills, both distilled from this repository:
   - the **DeepResearch Platform SDK** (internal codename **DistillSDK**) —
     `sdk/` (start at `sdk/README.md`) — builds a whole **platform**: 34 module
     skills (`sdk/skills/<name>/SKILL.md`) covering how each of this product's
     capabilities is built from scratch, a machine-readable module registry
     (`sdk/MANIFEST.json`), an implementation-order rationale
     (`sdk/ROADMAP.md`), and a dependency-free CLI (`node sdk/pair-cli.mjs
     list|show|plan|validate|agents|agent`). Its complete standalone
     documentation is
     **`docs/DISTILLSDK.md`** — the platform abstraction, the capability
     classes, contracts PA-1..PA-10, the full module catalog, the CLI, and the
     implementation order, in one document;
   - the **DeepResearch Agents SDK** — builds a single **agent** inside a
     platform (a flavour: chat-input-pane controls, animations, theme, examples,
     share-link quota — data, not code: `sdk/AGENTS.json`,
     `public/js/agent-spec-core.js`). It is tailored to its two home surfaces:
     **Agent Studio** (the mode that builds and publishes agents at
     `/app/<slug>/` with the direct build tools) and the **integrated Linux
     environment** (the in-browser execution sandbox agents run and test code
     in). Its reference is **`docs/AGENT-PLATFORM.md`**.

   Load an SDK skill when building a capability anew (or wiring this app to SDK
   modules); load an operational skill when running or maintaining THIS
   deployment.

## How to use the skills, whatever agent you are

The skills are **load-on-demand** playbooks, not always-on context. The
workflow is the same for any agent:

- **Match the task to a skill** using the `description` frontmatter (it is the
  "load when …" trigger). If several match, read each.
- **Read the whole `SKILL.md`** before touching that area — it encodes the
  traps, the invariants, and the exact commands that were figured out the hard
  way.
- **When you solve something new that will recur**, extend the matching skill
  (or add one) so the knowledge survives — see the "Persist solved tasks as
  skills" note in `CLAUDE.md`.

If your harness has a native skill/plugin mechanism, these `SKILL.md` files are
already in the standard `.claude/skills/` layout and will be discovered by it.
If it does not, glob `.claude/skills/*/SKILL.md`, read the frontmatter, and load
the relevant body on demand — the effect is identical.

## The same catalog is surfaced to end users (regardless of model)

This catalog is not only for agents editing the repo. In the deployed product's
**introspection mode** (Se/rver: `chat_mode: "introspection"`; Se/cure: its `developerMode` knob —
DeepResearch.**Se/cure** and DeepResearch.**Se/rver**), the same skills catalog
is injected into the model's context as a first-class part of the introspection
block (`public/js/introspect-core.js` → `buildIntrospectionBlock`, via
`skillsCatalog`/`skillsIndex`). So *any* answer model — the whole Berget
catalog, plus Anthropic/OpenAI answer models — can quote or read a playbook by
name when a user asks how the site works. The playbooks and the RAG-indexed
`SKILL.md` bodies ride in the committed source snapshot
(`public/introspect/source-snapshot.json`), so what a deploy surfaces is by
construction the source that deploy runs. See the **introspection** skill.

## The catalog

Mirrors `.claude/skills/` (the frontmatter there is authoritative; regenerate
the summaries below with the parser in `introspect-core.js` if a skill's
`description` changes). Each `SKILL.md`'s frontmatter carries the full
"load when …" trigger.

- **access-control** — auth (`src/auth.js`, `google.js`, `login.js`,
  `accounts.js`), quotas (`src/quota.js`), the admin API/UI, alerts, and D1
  setup.
- **add-llm-provider** — adding a NEW LLM provider or new models to the
  dropdown; the provider registry seam, catalog contract, stream adapters,
  routing.
- **add-research-source** — adding a NEW data source to the deep-research
  pipeline (search provider, platform API, intelligence feed).
- **anti-ai-smell** — stripping LLM writing tells out of documentation prose;
  the tell taxonomy, the fact-preservation contract, the runnable Vale style.
  Also the Clean step every doc pass ends with.
- **arxiv-rag** — the arXiv RAG database (772,658 hosted vectors): the OAI-PMH
  bulk harvest, the binary index pack, Berget's three serving limits, and how
  to judge a corpus change on the SERVED path with paired significance.
- **bugreport-bugfix** — turning a bug reported as little more than a chat
  keyword into a verified fix via chatlogs.
- **bulk-corpus-etl** — the provider-agnostic discipline for turning any large
  external corpus into a hosted searchable index: two-source enumeration
  (one cannot find its own gaps), checkpointing, rate-limit citizenship,
  Vectorize's billing traps, the relevance floor.
- **cache-helper** — when the live site serves STALE content, and cache-control
  decisions for new assets/endpoints.
- **chat-logs** — the full-visibility chat interaction log (`src/chatlog.js`,
  D1 `chat_logs`) for debugging real interactions.
- **commit-analytics** — the "Project pulse" dashboard at `/pulse`
  (`scripts/build-pulse.mjs`, `public/pulse/`) and the landing's "What work has
  been done and when" card — the **activity graph**, so a bare "update activity
  graph" / "uppdatera aktivitetsgrafen" loads this skill.
- **decision-boards** — building/extending an admin DECISION BOARD; the shared
  core `src/board.js` and the panel ⇄ loop mechanism.
- **deploy** — how code reaches production (push-to-main auto-deploy, direct
  `wrangler deploy`), branch preview URLs, commit-signing remediation.
- **docs-drift-validation** — validating the canonical docs bottom-up against
  the code: the doc-age scan, the layer walk, and the owner-checkmark loop for
  capability/posture drift (`docs/DOC-DRIFT-LOG.md`).
- **execution-sandbox** — the in-browser Linux (CheerpX) sandbox and bash-lite
  agent; the COEP headers, fail-soft contract, file mounting, and the DREE/1
  choice of WHERE commands run.
- **feature-board** — running the FEATURE-BUILD loop (`src/features.js`,
  `FEATURES.md`), and the general playbook for a new priority board.
- **feature-maintenance** — routing a regression back to the worker who
  authored the fix, via a comment on its PR; the owners registry
  `docs/MAINTENANCE-OWNERS.md`.
- **feedback-loop** — the site's feedback pipeline as an agent loop
  (`src/feedback.js`); gather → decide → act → message back.
- **help-docs** — HELP MODE, the documentation-first layer of introspection:
  the docs corpus + index (symbol references, served doc images), the
  docs→source escalation, the `bundle:docs` regeneration discipline.
- **integrations** — external providers and the enrichment pattern (Berget,
  Anthropic, OpenAI, Exa, geocoding, Shodan, Google Maps, Hugging Face, and
  Google Scholar + the peer-reviewed literature — what Scholar's robots.txt
  permits, and the OpenAlex/Crossref/SerpApi traps).
- **intro-baseline** — the approved landing page and the controlled
  new-visitor intro phase (invariant 8). Load before editing the landing,
  either tier's first run, or anything a stranger meets first.
- **introspection** — introspection mode / the retired `developer_mode` knob: the
  source snapshot + RAG index, the shared pure core, both tiers' clients.
- **live-verify** — verifying against the live site, Workers Logs /
  `wrangler tail`, request-id correlation, disconnect/recovery machinery.
- **local-web-search** — running your own web-search service as an Exa
  alternative, configurable in both tiers.
- **mcp-server** — the site exposed AS an MCP tool (`POST /mcp`, hand-rolled
  JSON-RPC 2.0): the `deep_research`, `literature_*` and `sdk_*` families,
  the MCP key, the bare-origin `https://mcp.deepresearch.se`, and the
  per-account exposure config.
- **merge-branches** — reconciling the repo's unmerged feature branches; the
  merged-branch ledger and the rule-break guard.
- **model-catalog-refresh** — the freshness check over already-wired
  providers' static catalogs when a new release ships: replace-vs-add, the
  never-invent-a-price rule, following an id bump through every echo.
- **model-eval** — the model-matrix eval battery, `QUERY_SETS`, the findings
  ledger, and evidence-driven `model-profiles.js` entries.
- **models-agent** — the Models mode and the model lifecycle it owns
  (discovered → evaluated → enabled): the provider-agnostic catalog, the
  verification checks, `/api/models/*`, and the per-account enabled list.
- **on-device-trace** — remote-debugging a bug that only reproduces on a real
  device (iOS PWA); the visible build stamp + on-device event trace.
- **orchestrator-mode** — the sub-agent workflow mode: one JSON plan phase
  decomposes a request into a team the Worker runs in parallel waves; the
  `workflow`/`agent_update` events and the live graph view.
- **outrospection** — introspection's mirror image: the mode that answers from
  an outward feed, the `/outrospect/` page, the seven-lens registry.
- **palaeogenomics** — the ancient-DNA agent: the Europe PMC leg, the
  committed 20,927-individual corpus queried with no outbound request, and the
  domain conventions an answer gets wrong without them. Also the reference for
  the JavaScript `\b` Swedish-boundary trap (invariant 6).
- **pipeline-architecture** — the research pipeline engine (phases, split model
  routing, time-budget/EWMA planner, per-model profiles, incident history).
- **pr** — the one-word trigger that prepares a branch: rebase, regenerate
  artifacts, test gate, push, open a focused PR.
- **publish-app** — the admin/CLI bridge that publishes an already-built bundle
  into `/app/<slug>/` without a chat/tool loop.
- **publish-research** — publishing a frozen deep-research replay at
  `DeepResearch.Se/cure/<slug>` (`src/pub.js`, `public/cure/`).
- **pubmed-ingest** — re-running the PubMed ingest: the full-rebuild and delta
  runbooks, the annual-baseline cutover, and the four traps that broke the
  first fill.
- **quota-grant-assessment** — testing/auditing the grant tokens: the
  invariant checklist and the combined-D1-fake technique.
- **rag-hillclimb** — measuring and improving the hosted dense-retrieval
  indexes: `scripts/rag-eval.mjs`, the coverage-first order, the paired
  McNemar that decides every verdict, the append-only ledger.
- **refactor-clarity** — refactoring for clarity/modularity here without
  breaking behavior; the pure-core convention and what to preserve.
- **request-testing** — shipping test cases inside your PR as
  `docs/test-requests/<branch>.json`.
- **sandbox-debug** — the sandbox boot-hang playbook: debug switches, the
  `boot_stage` timeline, the stall watchdog.
- **sandbox-perf-eval** — measuring how long sandbox commands take: the
  cold/warm battery, the agent-turn trace, and the two traps that void a run.
- **sdk-mode** — Agent Studio: the mode that distils this site into a new agent
  or a whole platform using the Platform SDK, publishes it at `/app/<slug>/`,
  and exposes the `sdk_*` MCP tools.
- **secure-workspaces** — offline workspace links (`/cure/workspace#w=…`), the
  cloned crypto, the quota-adjust surfaces, and the workspace concept across
  both tiers (`docs/WORKSPACES.md`).
- **security-posture** — verifying/updating the security posture against
  `SECURITY-RISKS.md`; the secret-leak scans, header/CSP probes, review board.
- **slash-spacing** — measuring the wordmark slash gap
  (`scripts/slash-gap.mjs`); never eyeball the `.sl` margins.
- **space-animations** — the `/space/` archive of playable wireframe
  animations (EN+SV matched), the only-stars-glow rule, real-scale zoom.
- **sse-protocol** — the `/api/chat` SSE event vocabulary and the
  forward-compatibility rule for clients.
- **starter-prompts** — the opening questions on an empty chat and the
  cross-agent system that ranks them: the per-agent queue, the
  synthetic-provenance rule, the judged dimensions, the live battery.
- **storage-privacy** — chat-history encryption, the implicit always-on
  cloud storage, RAG documents, projects, and the secret-keyed vault.
- **sync-main** — the fetch-latest-`origin/main`-first rule every session must
  follow before implementing anything.
- **test-batches** — the standing library of standard test cases per pipeline
  case, and the `scripts/test-batch` CLI.
- **test-feedback-loop** — the standing loop over the try-it queue: sync
  verdicts, mine every note, mint the next batch.
- **testable-interaction-points** — the try-it queue: declaring linkable test
  points, the action grammar, the verdicts.
- **tokemon-game** — the games subsystem (`src/games.js` registry) and the
  Tokemon open-world AR game.
- **tune-provider-models** — tuning newly added models for the pipeline's
  codified use cases and running their first eval battery.
- **ui-notes** — the client UI/UX facts: Markdown rendering, the PDF report,
  attachments/metadata, floating glass chrome, the static pages.
- **update-docs** — reconciling the whole documentation surface with the code:
  the inventory, the drift greps, the regenerate-never-hand-edit rules.
- **ux-conventions** — the numbered registry of codified UX interaction rules
  ("when X → then Y") that must feel the same everywhere.
- **video-capture** — recording the site in a browser across selected agents
  and models and turning it into a shareable clip: the activity timeline that
  makes dead air cuttable, the speed/cut knobs, the ffmpeg settings LinkedIn
  actually plays, and the admin review feed that scrolls every clip and likes,
  sends back or undoes any one of them.
