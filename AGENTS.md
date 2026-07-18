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
3. **DistillSDK** — `sdk/` (start at `sdk/README.md`) — the
   *constructive* counterpart to the operational skills: 33 module skills
   (`sdk/skills/<name>/SKILL.md`) covering how each of this product's
   capabilities is built from scratch, a machine-readable module registry
   (`sdk/MANIFEST.json`), an implementation-order rationale
   (`sdk/ROADMAP.md`), and a dependency-free CLI (`node sdk/pair-cli.mjs
   list|show|plan|validate`). Load an SDK skill when building a capability
   anew (or wiring this app to SDK modules); load an operational skill when
   running or maintaining THIS deployment. The SDK's complete standalone
   documentation is **`docs/DISTILLSDK.md`** — the abstraction, the
   capability classes, contracts PA-1..PA-10, the full module catalog, the
   CLI, and the implementation order, in one document.

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
**introspection mode** (the `developer_mode` knob, on both tiers —
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
- **bugreport-bugfix** — turning a bug reported as little more than a chat
  keyword into a verified fix via chatlogs.
- **cache-helper** — when the live site serves STALE content, and cache-control
  decisions for new assets/endpoints.
- **chat-logs** — the full-visibility chat interaction log (`src/chatlog.js`,
  D1 `chat_logs`) for debugging real interactions.
- **commit-analytics** — the "Project pulse" dashboard at `/pulse`
  (`scripts/build-pulse.mjs`, `public/pulse/`).
- **decision-boards** — building/extending an admin DECISION BOARD; the shared
  core `src/board.js` and the panel ⇄ loop mechanism.
- **deploy** — how code reaches production (push-to-main auto-deploy, direct
  `wrangler deploy`), live verification, commit-signing remediation.
- **execution-sandbox** — the in-browser Linux (CheerpX) sandbox and bash-lite
  agent; the COEP headers, fail-soft contract, file mounting.
- **feature-board** — running the FEATURE-BUILD loop (`src/features.js`,
  `FEATURES.md`), and the general playbook for a new priority board.
- **feedback-loop** — Claude Code as the back end of the feedback pipeline
  (`src/feedback.js`); the gather → decide → act → message-back loop.
- **help-docs** — HELP MODE, the documentation-first layer of introspection:
  the docs corpus + index (symbol references, served doc images), the
  docs→source escalation, the `bundle:docs` regeneration discipline.
- **integrations** — external providers and the enrichment pattern (Berget,
  Anthropic, OpenAI, Exa, geocoding, Shodan, Google Maps, Hugging Face).
- **introspection** — introspection mode / the `developer_mode` knob: the
  source snapshot + RAG index, the shared pure core, both tiers' clients.
- **live-verify** — verifying against the live site, Workers Logs /
  `wrangler tail`, request-id correlation, disconnect/recovery machinery.
- **merge-branches** — reconciling the repo's unmerged feature branches; the
  merged-branch ledger and the rule-break guard.
- **model-eval** — the model-matrix eval battery, `QUERY_SETS`, the findings
  ledger, and evidence-driven `model-profiles.js` entries.
- **on-device-trace** — remote-debugging a bug that only reproduces on a real
  device (iOS PWA); the visible build stamp + on-device event trace.
- **pipeline-architecture** — the research pipeline engine (phases, split model
  routing, time-budget/EWMA planner, per-model profiles, incident history).
- **publish-research** — publishing a frozen deep-research replay at
  `DeepResearch.Se/cure/<slug>` (`src/pub.js`, `public/cure/`).
- **refactor-clarity** — refactoring for clarity/modularity here without
  breaking behavior; the pure-core convention and what to preserve.
- **security-posture** — verifying/updating the security posture against
  `SECURITY-RISKS.md`; the secret-leak scans, header/CSP probes, review board.
- **sse-protocol** — the `/api/chat` SSE event vocabulary and the
  forward-compatibility rule for clients.
- **storage-privacy** — chat-history encryption, the implicit always-on
  cloud storage, RAG documents, projects, the secret-keyed vault, and DRC.
- **sync-main** — the fetch-latest-`origin/main`-first rule every session must
  follow before implementing anything.
- **tokemon-game** — the games subsystem (`src/games.js` registry) and the
  Tokemon open-world AR game.
- **tune-provider-models** — tuning newly added models for the pipeline's
  codified use cases and running their first eval battery.
- **ui-notes** — the client UI/UX facts: Markdown rendering, the PDF report,
  attachments/metadata, floating glass chrome, the static pages.
- **ux-conventions** — the numbered registry of codified UX interaction rules
  ("when X → then Y") that must feel the same everywhere.
