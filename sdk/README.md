# DistillSDK

A software development kit for building **agent pairs** — one AI-assistant
product shipped as two tiers of the same capability set:

- a **client tier** that runs wholly in the browser, with the server (if
  any) in **no data path** — the user's own upstream APIs or local model
  server, sealed local state, structural privacy;
- a **server tier** where exactly **one server component** (an edge worker)
  sits between the browser chat client and the optional upstream APIs,
  owning identity, orchestration, metering, storage and operations.

The reference implementation is **this repository** —
DeepResearch.**Se/cure** + DeepResearch.**Se/rver** — and the SDK is
distilled *from* it: every module points back at the files that already
realize it, and carries the incident history that made those files what
they are.

> **Status (2026-07-16): design + skill library only.** Nothing under
> `sdk/` is imported by `src/` or `public/`. Wiring the running
> application to SDK modules is a later, separate task (see
> `DESIGN.md` §5 and the `pair-generator` skill's adoption mode).

The SDK's complete standalone documentation — the abstraction, capability
classes, contracts, full module catalog, CLI and implementation order in one
document, integrated into the project's documentation corpus (so the in-app
help layer answers from it) — is **`docs/DISTILLSDK.md`**. This README is
the catalog front page of the `sdk/` directory itself.

## What's in the box

| File | What it is |
|---|---|
| `DESIGN.md` | The agent-pair abstraction: the zero-or-one-server property, capability classes (C/S/B/X/D), contracts **PA-1…PA-10**, the module model, the design decisions |
| `MANIFEST.json` | The machine-readable module registry: 33 modules with layer, class, dependencies, skill path, reference files, acceptance criteria |
| `ROADMAP.md` | The implementation-order rationale: six phases, why each module lands where it does, exit criteria per phase |
| `skills/<module>/SKILL.md` | One buildable capability module per skill — the complete capability foundation of deepresearch.se |
| `pair-cli.mjs` | The dependency-free CLI over the manifest: `list`, `show <id>`, `plan <id …>` (dependency closure → build order), `validate` (integrity + class rules). Runs on any desktop Node and inside the sandbox VM (`node /src/sdk/pair-cli.mjs …`); unit-tested by `pair-cli.test.mjs` in the repo's `npm test` |
| `drpl.mjs` | The DRPL/1 pipeline-language reference tooling: `validate`, `show`, `fingerprint`, `diff` over `*.drpl.json` documents — the formal, implementation-neutral language declaring a deep-research pipeline's structure (phases, dataflow, failure contracts, model routing, and privacy PLACEMENT), with canonical structural fingerprints for comparing pipelines across nodes. Spec: `docs/PIPELINE-LANGUAGE.md`; examples: `docs/examples/*.drpl.json`; unit-tested by `drpl.test.mjs` in the repo's `npm test` |

Each skill follows one shape: **capability class & tier story** → the
**PA contracts** it carries → a from-scratch **build plan** → the
**reference implementation map** into this repo → an **acceptance
checklist** → **pitfalls** (the institutional memory: real incidents,
evidence-driven decisions).

## The module catalog

**Layer 0 — Foundation (the mandatory baseplate)**

| Module | Class | Provides |
|---|---|---|
| `pair-architecture` | D | The contracts, capability classes, naming/wordplay convention, module-graph rules |
| `baseplate-worker` | S | The one server: routing, assets, headers, optional-D1, config, logging, test harness |
| `baseplate-client` | C | The no-build browser chat shell: composer, turns, markdown, SSE parser, pure-core convention |

**Layer 1 — Model & search plane**

| Module | Class | Provides |
|---|---|---|
| `provider-registry` | X | Multi-provider LLM registry both tiers + the hardened stream loop |
| `research-pipeline` | X | The deterministic no-function-calling research pipeline, both tiers |
| `web-search` | X | Default + pluggable search backends, source registry, diversity caps |
| `enrichments` | S | The opt-in context-enrichment registry (geocode/host-intel/maps pattern) |

**Layer 2 — The two tiers**

| Module | Class | Provides |
|---|---|---|
| `secure-tier` | C | The wholly-in-browser tier: sealed state, own keys, twin UX, static-host deployable |
| `identity-access` | S | OIDC sign-in, sessions, terms/approval gates, break-glass, admin gate |
| `quota-metering` | S | Windowed quotas, split billing, concurrency caps, alerts, message center |
| `sse-recovery` | S | The SSE contract + answer recovery/relaunch/stall machinery |

**Layer 3 — Privacy & storage plane**

| Module | Class | Provides |
|---|---|---|
| `sealed-crypto` | C | User-held secrets, HKDF derivations, AES-GCM archives — the pure crypto core |
| `ciphertext-storage` | S | Knob-gated cloud ciphertext, the blind-blob vault, drain-wipe |
| `client-rag` | X | Chunking/embedding/retrieval over docs, projects and chats, per-tier postures |
| `grant-bridge` | B | The metered grant-token bridge — the only sanctioned tier crossing |
| `offline-workspaces` | C | A whole configured session sealed into one fragment link |

**Layer 4 — Operations & feedback plane**

| Module | Class | Provides |
|---|---|---|
| `observability` | S | Structured logs, request-id correlation, the opt-out interaction log, live-verify |
| `decision-boards` | S | Human-decides-agent-executes boards + the loop input format |
| `feedback-loops` | D | Feedback threads, try-it test points, the git test-request channel |
| `eval-harness` | D | Trace harness + two scored benchmarks + append-only ledgers |
| `agent-dev-workflow` | D | Skills-as-memory, fleet git discipline, regression routing, secret scanning |

**Layer 5 — Extension surfaces**

| Module | Class | Provides |
|---|---|---|
| `execution-sandbox` | X | In-browser Linux VM + the fenced-block shell agent |
| `introspection-help` | X | Self-source answering + the docs-first interactive help |
| `mcp-surface` | S | The pair exposed as an MCP tool (the outbound edge) |
| `publish-replays` | S | Frozen research sessions as public replay pages |
| `symbol-language` | X | Per-tier symbols, disclosure grammar, wordmark discipline, UX registry |
| `games-shelf` | S | The registry seam for whole product surfaces (worked example: a game) |
| `exec-engine` | X | Engine CheerpX (decided); building our own SMALL, FAST image from scratch (Alpine-i386 recipe, self-hosted, full-prefetch so commands never stall); the thin `ExecEngine` seam + c2w/v86/qemu fallback ladder as future-proofing; the in-VM agent egress design |
| `vm-toolchain` | X | The SDK inside the prepackaged Linux VM: our small fast Alpine image + full-prefetch, `/src/sdk` mount, the in-app `sdk/<name>` skills catalog, desktop parity |
| `workspace-fs` | S | Fast-track file plane: read/write/edit/grep/glob via MCP hit a host-side store directly (no VM); only shell routes through the VM, kept coherent by sync-in→exec→harvest. Server-tier |

**Layer 6 — Generation, studio & deploy**

| Module | Class | Provides |
|---|---|---|
| `pair-generator` | D | Selection → dependency closure → module-at-a-time generation; adoption mode |
| `pair-studio` | X | The in-app builder: prompt → SDK-guided generation in the VM → preview deploy in the same UI → save as a runnable test application; platform types (client-tier builds run instantly, server-tier builds export) |
| `deploy-pipeline` | S | Deploy the workspace and try it LIVE: a same-origin preview URL for client-tier builds, a push to the user's own edge account for server-tier builds (never the pair's origin). Server-tier |

## How to use it

**From a desktop** (VS Code, any editor, any agent harness): clone the repo,
open it, and work the skills directly — `node sdk/pair-cli.mjs list` for the
catalog, `plan <modules>` for a build order, `validate` before committing a
manifest change. The vendor-neutral `AGENTS.md` at the repo root points any
coding agent at both skill catalogs.

**From the application itself:** the SDK rides the committed source snapshot,
so both tiers can browse and quote every SDK skill in-app (cataloged as
`sdk/<name>` next to the operational playbooks), and the sandbox VM mounts
the whole SDK at `/src/sdk` — with a nodejs-equipped image (see
`vm-toolchain`), `node /src/sdk/pair-cli.mjs …` runs inside the browser's own
Linux. The `pair-studio` module is the full in-app loop: prompt an app, have
it designed in the VM, try it out in a preview pane in the same UI, and save
it as a runnable test application.

**To learn the architecture:** read `DESIGN.md`, then the
`pair-architecture` skill.

**To generate a new pair from scratch:** load the `pair-generator` skill.
In short: pick a selection (the baseplate is mandatory; three worked
selections are in `DESIGN.md` §3 — from a zero-server client-only
assistant up to the full reference), close it over `MANIFEST.json`
dependencies, then walk `ROADMAP.md`'s phase order executing one module
skill at a time, landing each with its tests green and acceptance
checklist satisfied before starting the next.

**To wire the existing application to SDK components (the later task):**
the same walk in adoption mode — per module: read the skill's reference
map, align the existing files to the module's stated contract, add any
missing acceptance tests, record the binding.

## Relationship to `.claude/skills/`

The repo's `.claude/skills/` are *operational* — they run and maintain
THIS deployment. The SDK skills are *constructive* — they build the
capability in a fresh repo (or bind it here). They deliberately share
vocabulary and cite the same incident history; where an operational skill
already documents a procedure, the SDK skill points at it rather than
duplicating it.
