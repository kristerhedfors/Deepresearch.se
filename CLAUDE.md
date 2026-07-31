# CLAUDE.md

Guidance for Claude Code when working in this repository. This file stays
SHORT on purpose — it is loaded into every session and its opening doubles as
the introspection orientation excerpt. The detail lives in `docs/` and the
on-demand skills under `.claude/skills/`; load what the task needs.

## Project

A Cloudflare Worker that serves a static chat UI (`public/`) and a streaming
`/api/chat` endpoint. Deployed via `npx wrangler deploy` (config in
`wrangler.toml`), git-connected to Cloudflare. The site is a *deep research*
assistant, matching its name: `/api/chat` runs a Worker-orchestrated pipeline
(triage → search → gap check → synthesis → validation) with **no function
calling** — every phase is a direct JSON-mode or streamed call, so it is
deterministic and works on any model in the catalog. The primary LLM provider
is **Berget.ai** (OpenAI-compatible); **Anthropic (Claude)** and **OpenAI
(GPT)** are secondary, key-gated providers for answer/synthesis models
(claude-* opus/sonnet/haiku — `src/anthropic.js`; bare gpt-* —
`src/openai.js`; hf:* — `src/hf-inference.js`, the OPEN catalog a user browses
and enables per account in the Models agent; all dispatched via the
`src/providers.js` registry; the JSON planning phases always stay on Berget).
Web search is **Exa**.

**Mission (2026-07-13):** the project is framed as **innovation and
research on the privacy capabilities of LLM applications** — how far a
real, useful research assistant can be pushed toward *provable* privacy,
and where that trades against capability. The **proof is the site itself**:
a fully open-sourced, independently verifiable **Se/cure + Se/rver platform**.
It is still experimental and nowhere near production-ready (say so; do not
frame it as a finished product). The "built over a weekend, phone-only"
origin is kept in FULL only on `/story/`, with brief non-leading pointers on
`/build/`, the landing, and the README — it is the origin, not the identity,
so don't lead with it elsewhere.

**The crisper formulation (2026-07-25 owner directive): this mission is a
DeepResearch SECURITY ARCHITECTURE** — how research is *distributed outward*
to people and machines the originator doesn't control, and how insight is
*aggregated back*, with the data exposure of every hop written down rather
than assumed. **The unit that travels is a WORKSPACE, and workspaces are the
centrepiece**: everything else (pipeline, sandbox, grants, SDKs) is machinery
a workspace uses. There are exactly two kinds — a **Se/cure workspace** (the
link IS the workspace; no server record) and a **Se/rver workspace** (account-
scoped, cloud-first). Complete spec of both, the exposure ledgers, and the
distribute→aggregate channels: **`docs/WORKSPACES.md`**; the whiteboard view
of every component is `docs/ARCHITECTURE.md` **§0 (the board)**.

**Branding rule (2026-07-10, amended 2026-07-12 and 2026-07-13):** the two
product tiers are ALWAYS written as their full URL without the scheme, in
CamelCase, with the wordplay tail in bold: DeepResearch.**Se/cure** (the
client-side tier) and DeepResearch.**Se/rver** (the signed-in tier). Where
running copy needs a SHORT name, use the slashed tail alone — **Se/cure**
and **Se/rver**. **Secure-first:** whenever the two are named together — a
sentence, a list, table columns, paired diagrams — Se/cure comes FIRST.
The CamelCase is a DISPLAY convention only: functional URLs, `href`s, route
paths, publish slugs, and host strings stay lowercase (`/cure`, `/rver`,
`deepresearch.se`). The acronyms DRC/DRS are INTERNAL names (code
identifiers, CLAUDE.md, skills, commit messages) and must not appear in
user-facing copy. In rendered UI the slash's spacing (the `.sl` span) is
font-dependent and gets MEASURED, never eyeballed — the **slash-spacing**
skill. **WORKSPACE, not "project" (2026-07-25):** user-facing copy calls a
named collection of chats + material a **workspace** in both tiers; the code
identifiers and wire paths (`/api/projects*`, R2 `projects/{uid}/…`,
`public/js/projects.js`, the project vault endpoints) keep their names, the
same internal/display split as DRC/DRS. Full rule + rationale:
`docs/BRANDING.md`.

## Git workflow

- **Sync first.** Always sync with the latest `origin/main` BEFORE
  implementing anything — new sessions are routinely off-sync. The
  SessionStart hook (`.claude/hooks/sync-main.sh`) fetches and fast-forwards;
  if it printed a WARNING, rebase onto `origin/main` before touching code.
  Re-fetch before every push. See the **sync-main** skill.
- **Both merge styles are supported (2026-07-13):** a change may land by a PR
  merged into `main` OR a direct branch merge / push to `main`. Always cut
  work on a feature branch off the latest `origin/main`; a merged branch is
  DONE — branch fresh from the updated `main`. See **merge-branches**.
- **ALWAYS watch a PR you open (owner directive, 2026-07-14):** subscribe with
  `subscribe_pr_activity` the moment you create it — don't wait to be asked.
  Investigate every CI failure / review comment; push small confident fixes;
  ask via `AskUserQuestion` when ambiguous. Webhooks don't deliver CI
  *success*, new pushes, or merge-conflict transitions, so also schedule a
  `send_later` self check-in ~1 h out. A subscription ends only when the PR
  is **merged or closed** (or the owner says stop).

```bash
git fetch origin main
git checkout -B <feature-branch> origin/main
git add -A && git commit -m "…"
git push -u origin <feature-branch>
# then EITHER open a PR targeting main, OR merge the branch into main directly
```

> ### MERGE BARRIER — check on EVERY prompt, before any change
>
> `docs/MERGE-STATUS.json` holds a one-time mass-reconciliation flag. **If the
> barrier is `active` AND your current branch does not contain the recorded
> `main_sha`, sync to `main` and CREATE A NEW BRANCH before doing any work —
> do not continue on your old (now-merged) branch:**
> `git fetch origin main && git checkout -B <fresh-branch> origin/main`.
> The `merge-barrier` hook checks this automatically and prints a notice, but
> the rule stands regardless. The owner clears the barrier by setting
> `active: false`. See the **merge-branches** skill.

> **Commit signing is NOT provisioned** — pushed commits show "Unverified"
> and that is EXPECTED (an owner TODO, not fixable in a session: no signing
> key material ships in these containers, and re-signing pushed history would
> need a blocked force-push — attempting it only wastes a turn). Ignore the
> warning and move on. The owner-side remediation lives in the **deploy**
> skill.

## Regression feedback loop & feature maintenance (2026-07-14 directive)

Fixes are authored by **worker sessions**, one per PR, each staying
subscribed to its own PR — **a GitHub comment on a PR wakes that PR's
author-worker**. That is the back-channel: to reach whoever wrote a fix,
comment on their PR. Some features — the in-browser Linux **sandbox** above
all — regress repeatedly, so a fix is not "done" at merge. When a shipped
feature breaks again:

1. **Do NOT silently fix it yourself.** Find the owning PR — the most recent
   merged PR touching the relevant files — and confirm against
   **`docs/MAINTENANCE-OWNERS.md`** (the subsystem → owning PR registry).
2. **Comment a precise regression report on that PR**
   (`mcp__github__add_issue_comment`): symptom, `chat_logs` id /
   `client_diag` counters, verbatim repro, which prior fix regressed, what
   "fixed" looks like. Merge the author's follow-up PR the normal way.
3. If the owner is closed/stale/unresponsive, fall back to the
   **feedback-loop** discipline (fix it yourself with a regression test) and
   note it in the registry.

Keep `docs/MAINTENANCE-OWNERS.md` current — when a newer fix PR merges, that
PR becomes the owner. The watcher/merger loop also sweeps for regressions
each tick (chatlogs failure signatures, live probes, user reports). Full
loop: the **feature-maintenance** skill.

## Load-bearing invariants

1. **Deterministic orchestration — NO function calling.** Every pipeline
   phase is a direct JSON-mode or streamed call, so the whole thing works
   across Berget's entire catalog, including models with unreliable
   tool-calling. Don't introduce function/tool-calling into the pipeline.
   ONE authorized exception (owner directive, 2026-07-12; extended to SDK
   mode 2026-07-18): DEVELOPER MODE's source investigation and SDK MODE's
   build flow — when the mode is on AND the answer model supports real tool
   use, the ANSWER model drives `grep_source` / `read_file` / `list_files`
   over the site's own source (Se/cure adds a real `run_bash` over the
   sandbox), and in SDK mode additionally the `sdk_*` planning tools +
   `write_file`/`publish_app`. This is DELIBERATE and must not be "fixed"
   back; models without tool use fall back to the deterministic source read
   loop (introspection) / the fenced `FILE:`-block convention (SDK mode),
   and the JSON planning phases (invariant 3) never use tools. See the
   **introspection** and **sdk-mode** skills.
2. **Helper phases fail soft, never break the request.** Search, gap check,
   validation, and every enrichment (geocode + every extension) degrade to a lesser
   result (fewer searches, accepted draft, conversation unchanged) rather
   than erroring the chat. Both Berget calls are time-bounded so a hung
   backend can't defeat that.
3. **Split model routing.** The three JSON planning phases (triage, gap
   check, validation) always run on the fixed reliable `DEFAULT_MODEL`
   (Mistral Small); only synthesis (and direct/search-off replies) run on
   the user's chosen model — regardless of which PROVIDER serves that model.
   Token accounting, budgeting, and profiles are all split accordingly.
4. **The privacy split.** Se/cure (`/cure`) is the never-cloud tier: the
   server is in NO data path — browser-direct provider calls (or the user's
   own local server), client-side pipeline, sealed browser-local state. On
   Se/rver, cloud storage is IMPLICIT (2026-07-16 owner directive — the TIER
   is the choice, no opt-out knob); conversations and attached files rest as
   ciphertext in both the browser and R2 (readable exceptions: RAG-indexed
   material and project chats — retrieval needs plaintext); the secret-keyed
   project vault is the strictest tier (server-undecryptable). The server
   keeps a full-visibility interaction log (`chat_logs`) UNLESS the request
   carries `incognito: true` — that API promise must keep suppressing the
   row. Outbound requests to third parties carry the minimum (a query, a
   coordinate, a host) — never the conversation, filename, or identity;
   secrets never appear in any log. EXACTLY TWO deliberate, bounded,
   opt-in, quota-metered exceptions route Se/cure traffic through the
   server: the temporary web-search GRANT (query-only) and the
   secure-research-space proxy bundle (its `api` grant is the ONE place
   Se/cure *content* touches the server — clearly disclosed in the UI).
   Secure workspaces add no third exception; the consolidated **Se/rver
   TOKEN** (2026-07-16, one HS256 JWT with a `perms` set over the same two
   upstream services) unifies the grant families going forward and carries
   THE SERVER-TOKEN GUARANTEE. That guarantee exists to protect **Se/cure**,
   whose posture is pass-through only: a token READS nothing Se/rver stores
   (no project, chat, history or account contents) and is NEVER a login (the
   admin surface rejects it everywhere, test-pinned). Its one write is
   Se/cure feedback (`POST /api/server-token/feedback` — write-only, no read
   path). It is NOT a rule about the Se/rver tier: there the server is
   INSIDE the trust boundary (owner directive, 2026-07-24), and agents
   collaborating and orchestrating over server-side storage is the intended
   direction, not an exception to be argued down.
   Full model, endpoints, token families, dated directives:
   `docs/PRIVACY-MODEL.md`.
5. **Minimal dependencies; evidence-driven exceptions.** No build step and
   **zero RUNTIME deps** — `package.json` has no `dependencies` block and
   `src/` imports nothing but `node:*` builtins and its own files. Dev-only
   packages are the narrow exception and are argued one at a time
   (`docs/DEPENDENCIES.md` §5, §8): `typescript` +
   `@cloudflare/workers-types` for the typecheck, and since 2026-07-27
   `cheerio` for one offline harvest script's DOM walk — which is why
   `npm test` now needs an `npm install` first. Per-model overrides
   (`model-profiles.js`) and any special-casing must trace back to a
   reproduced finding, not a guess.
6. **Equal Swedish and English support in ALL deterministic intent routing**
   (explicit product expectation, 2026-07-09). Every regex gate / phrase set
   that routes behavior — present or FUTURE — must take Swedish forms with
   the same breadth as English (definite forms, synonyms, common typos).
   When adding or extending a gate, add the Swedish forms AND a parity unit
   test in the same change — never English-only with Swedish "later". The
   "Swedish language parity" suite in `src/googlemaps.test.js` is the
   enforcement pattern.
7. **Third-party integrations are EXTENSIONS, never core** (owner directive,
   2026-07-25). Google Maps / Street View and Shodan are *example*
   integrations woven into research; the platform core is about the agent
   logic and how agents integrate, and must read as if no external service
   existed. `src/extensions.js` is the ONLY `src/` module that may name an
   individual service at the architectural seam, and the only one core
   imports: one descriptor owns its knob, its slice of `state.ext`, its
   enrichment runner, its log-meta keys, and its capability line — core
   consumes all five generically. Adding or removing an integration touches
   NO core file. `src/extensions.test.js`'s core-purity guard fails the build
   when a core module names a service in code or imports an integration
   module. Do NOT "simplify" this back by wiring a service straight into
   `chat.js`, `settings.js`, `validation.js`, `prompts.js` or `types.d.ts`.
   Full boundary: `docs/ARCHITECTURE.md` §4.2a.
8. **The INTRO PHASE is a controlled, approved baseline** (owner directive,
   2026-07-26). The landing page at `600c7300` is the ACCEPTED front door —
   **we are not going back to an earlier landing; work BUILDS ON this one.**
   The whole first-visit sequence is tightly controlled: `/` serves the
   landing IN PLACE (never a redirect) → the `#wintro` overlay (name →
   tagline → does/doesn't, ≤6 bullets) → one mascot beat → the page and its
   doors, every one of them reachable signed out → inside a tier, one intro
   animation, one greeter, then the COMPOSER (no promotional pane
   auto-opens). No language model is in the intro; the signed-out helper is
   the badged prepackaged responder. Nothing new is inserted into this
   sequence, and no part of it changes, without the same commit amending
   **`docs/INTRO-BASELINE.md`** (the spec: §2 the surfaces, §3 the
   first-visit keys, §4 the twelve rules, §5 how each is ensured) and its
   contract tests `src/intro-phase.test.js` + `src/landing.test.js`. Load
   the **intro-baseline** skill before touching any of it; UX-19 is the
   interaction rule.

> **Plan status (current): this Cloudflare account is on Workers PAID** —
> `wrangler.toml` sets `[limits] cpu_ms = 300_000` (5 min CPU/request). Do
> NOT reason from the old Free-plan 10 ms ceiling; an isolate dying is rare
> now. The historical exceededCpu record is in the **pipeline-architecture**
> skill.

## Code layout

`src/` is the Worker: entrypoint `index.js` (routing + identity gate),
pipeline `pipeline.js` + phase helpers, the provider registry
`providers.js` (Berget/Anthropic/OpenAI), the grant/token subsystems, the
admin decision boards, and — behind the `extensions.js` registry (invariant
7) — one module per third-party integration. `public/` is the
client: the Se/rver app (`index.html` + `public/js/`), the Se/cure tier
(`public/cure/` + the `drc-*.js` modules), the admin UI, games, and vendored
libs. Shared pure cores live under `public/js/` (`bash-core.js`,
`introspect-core.js`, …) because the browser can only import served modules;
server files re-export them as façades.

**The AUTHORITATIVE per-module map is `docs/CODE-LAYOUT.md`** — one row per
`src/` module plus the client-module prose. Keep it current in the same
commit that adds/moves a module (mirror discipline; the **update-docs**
skill's drift greps target it).

## Tests

```bash
npm install         # once: the suite needs the root devDependencies (see below)
npm test            # unit: node --test src/*.test.js public/js/*.test.js public/games/*/js/*.test.js
                    #                  sdk/*.test.mjs scripts/*.test.mjs tests/*.test.js
npm run typecheck   # zero-build-step tsc, strict, opt-in per file via // @ts-check
cd tests && npm install && npm run fixtures   # e2e setup (once)
npm run test:local                            # Playwright vs a Worker on this machine — free, no creds; what CI runs
npm run test:mocked                           # Playwright vs live site, /api/chat intercepted (free)
npm run test:live                             # 5 live tests (real Berget tokens + one Exa run)
```

Unit tests (Node's built-in runner, no test framework) cover pure logic and
mockable seams; anything touching a live provider, D1, or the DOM is still verified
live — that's where this project's real bugs have come from (the
**live-verify** skill). Editing tracked text or source can stale the
committed introspection artifacts — `npm test` names the drift; fix with
`npm run bundle` / `bundle:rag` / `bundle:docs` / `bundle:docs-rag`, never by
hand. What each suite covers, the e2e fixtures/quirks, and the five eval
harnesses (model-matrix, rubric bench, HF bench — append-only ledgers, don't
deploy mid-battery): **`docs/TESTING.md`**.

## The SDKs and interchange standards

Two DISTINCT SDKs, both distilled from this repo (division per owner directive,
2026-07-24). `sdk/` is the **DeepResearch Platform
SDK** (codename **DistillSDK**, 2026-07-16): building an entire
DeepResearch.se-LIKE agent platform — the Se/cure + Se/rver tiers as one
distillable two-tier product — as a design
(`sdk/DESIGN.md`), a 34-module registry (`sdk/MANIFEST.json`) with one buildable
skill per module, and a dependency-free CLI (`node sdk/pair-cli.mjs
list|show|plan|validate|agents|agent`, unit-tested in `npm test`). Its companion
is the **DeepResearch Agents SDK** (`docs/AGENT-PLATFORM.md`, `sdk/AGENTS.json`,
`public/js/agent-spec-core.js`), tailored specifically to **Agent Studio and
the integrated Linux environment** (the execution sandbox): an agent is one
flavour of the platform (its chat-input-pane controls, theme, animations,
examples, share-link quota) — data, not code — and the Agents SDK also owns
Agent Studio's direct build tools (`write_file`/`publish_app`) and the
sandbox surface agents run and test code in. Since **spec 0.2.0**
(2026-07-25) a spec also declares what the agent DOES — the **capability
block**: answer phase, prompt set, tool classes, context blocks, search and
routing policy, gates, bounds, emitted events, required knob, sub-agent
team. It is a SELECTOR over shipped behaviour, never a definition of new
behaviour, so the dispatch stays code and the spec stays data (invariant 1
holds for the routing as for the run); validation enforces invariants 1, 3,
4 and 6 as rules rather than prose. The seven chat modes are the seven
**default agents**, bound to their mode by the registry's ordered
`defaults` table, which is what `/api/chat` routes on
(`src/agent-registry.js` → `src/chat.js` → `src/pipeline.js`
`ANSWER_PHASE_RUNNERS`). Since 2026-07-18 the SDK is WIRED into the app: the pure core
`public/js/sdk-core.js` (façade `src/sdk-tools.js`; the CLI re-exports it) powers
**SDK mode** — labeled **Agent Studio** in the UI (2026-07-23; renamed from
"Agent Builder"; the mode id stays `sdk`, internally still "SDK mode"/DistillSDK)
— the green "lovable experience" entry in the chat-mode dropdown (Deep Research /
Introspection / Agent Studio; the `normal` mode id displays as **Deep Research**)
that DISTILLS this site — above all the client-side **Se/cure** tier — into
either a new individual **agent** OR an entire new **platform**, using the SDK's
modules/skills as the method and the deployed Se/cure source as the original,
then publishes it live at `/app/<slug>/` (`src/build-pub.js`, opaque-origin CSP
sandbox) — and the `/mcp` `sdk_*` tools, so agents plan against the manifest
without shelling into the sandbox (where `/src/sdk/pair-cli.mjs` also works in
dev mode). (A separate khaki **SWE mode** — "a new instance of Se/cure" —
shipped 2026-07-18 and was folded into SDK mode 2026-07-19 as redundant;
distilling Se/cure into flavours is now SDK mode's core purpose, upholding
Se/cure's privacy invariants when the flavour stays client-side.) SDK mode's
native tool loop rides invariant 1's SAME authorized exception as introspection
(deterministic `FILE:`-block fallback on non-tool models); see the **sdk-mode**
skill. The Platform SDK's complete standalone documentation is
`docs/DISTILLSDK.md` and the Agents SDK's is `docs/AGENT-PLATFORM.md`, each
updated in the same commit as its `sdk/` change.
The **interchange standards** (2026-07-17) specify the workspace bundle and
pipeline structure as open standards — **DRSW/1**
(`docs/WORKSPACE-PROTOCOL.md`) and **DRPL/1** (`docs/PIPELINE-LANGUAGE.md`,
tooling `sdk/drpl.mjs`); the vision is `docs/STACKLESS-RESEARCH.md`. The
standards deliberately LEAD the code (spec-first); the deployed workspace
feature is their reference implementation.

**Feature surfaces are examples, not architecture (owner directive,
2026-07-24).** Orchestrator, Agent Studio, the games, the space archive,
on-device inference, compute sharing — read these as **examples and
pre-bundled agents** demonstrating what the platform carries, and build them
on the two SDKs as far as possible rather than as bespoke subsystems. When
adding a surface, ask which SDK should carry it FIRST. Several already have
their Platform-SDK module; Orchestrator, on-device inference, compute
sharing, workspace knowledge and quiz are still bespoke and owe one
(`docs/ARCHITECTURE.md` §15).

## Skills

Detailed guidance is split into on-demand skills under `.claude/skills/` —
load the relevant one before working in its area. Each skill's `description`
frontmatter is its load trigger; the list below is the index.

**Persist solved tasks as skills.** When a task gets solved in a session and
is likely to recur — a deployment path, a debugging workflow, an eval
procedure, an API quirk that cost real time — write (or extend) a skill
before the session ends. Prefer extending an existing skill over a
near-duplicate; keep entries evidence-based (what was observed, not what
docs claim); update this list plus the skill's `description` frontmatter.

Workflow & docs:

- **sync-main** — sync with latest `origin/main` before any work; the SessionStart hook; re-fetch before every push.
- **merge-branches** — reconciling unmerged feature branches; the merged-branch ledger `docs/MERGED-BRANCHES.md` + push guard.
- **pr** — the one-word trigger that PREPARES the branch: rebase, regenerate artifacts, test gate, push, open a focused PR.
- **deploy** — how code reaches production; branch preview URLs; the commit-signing / Verified-badge remediation.
- **refactor-clarity** — refactoring for clarity here without breaking anything: the five gates a cut must pass, the pure-core convention, what to preserve, the `scripts/dup-scan.mjs` survey, and the standing-decline register so a pass never re-argues a settled candidate.
- **update-docs** — reconciling the whole documentation surface with the code: the inventory, drift greps, regenerate rules.
- **docs-drift-validation** — bottom-up docs⇄code validation: the doc-age drift scan, layer walk, and the OWNER-checkmark loop for capability/posture drift (ledger `docs/DOC-DRIFT-LOG.md`).
- **anti-ai-smell** — removing AI smell (LLM writing tells) from documentation prose: the tell taxonomy, the two de-smell modes, the fact-preservation contract, and the runnable Vale style. The one place rewriting docs for STYLE is the goal (update-docs deliberately does not); docs files only, never code. It is ALSO the **Clean step** wired into every doc pipeline (owner directive, 2026-07-23): any doc updated or changed — via update-docs, docs-drift-validation, pr, or a hand edit — leaves the pass **Cleaned** (the anti-ai-smell tail applied in place to the touched prose). We keep only that.

Pipeline & models:

- **pipeline-architecture** — the research pipeline engine: the 5 phases, split routing, the budget planner, incident history.
- **model-eval** — the model-matrix eval harness, `QUERY_SETS` discipline, the findings ledger, evidence-driven profiles.
- **add-llm-provider** — adding a new LLM provider or models: the registry seam, catalog contract, validation ladder.
- **model-catalog-refresh** — checking which model menus need updating when a provider ships a new release (e.g. Opus 5): the replace-vs-add decision, never-invent-a-price rule, and following an id bump through every echo.
- **tune-provider-models** — tuning new models per codified use case and running their first eval battery.
- **add-research-source** — integrating a new deep-research source end to end (intent, registry, SSE visibility, validation).
- **local-web-search** — running your own web-search service as an Exa alternative, configurable in both tiers.
- **sse-protocol** — the `/api/chat` SSE event vocabulary, forward-compatibility rule, and the inline-quiz event.
- **mcp-server** — the site exposed AS an MCP `deep_research` tool (`POST /mcp`, hand-rolled JSON-RPC 2.0); connecting Claude Code via an MCP key on `mcp.deepresearch.se`, and the per-account exposure config under Settings → MCP server.
- **integrations** — external providers and the enrichment pattern (Berget, Anthropic, OpenAI, Exa, Nominatim, Shodan, Maps, HF, **Google Scholar + the peer-reviewed literature**: what Scholar's robots.txt permits — profiles and venue metrics yes, `/scholar` never — the OpenAlex/Crossref/SerpApi traps, and why sorting a literature by citations answers with methods papers nobody asked about; the agent itself is `docs/SCHOLAR.md`).

Privacy, storage & grants:

- **storage-privacy** — chat-history encryption + key hierarchy, implicit cloud storage, RAG, projects, the vault.
- **secure-workspaces** — offline workspace links (`/cure/workspace#w=…`), the hacka.re-cloned crypto, quota-adjust surfaces. The workspace CONCEPT across both tiers — the two kinds, their exposure ledgers, the distribute→aggregate channels, and the specified-ahead arrival disclosure + 👍/👎 curation — is `docs/WORKSPACES.md`.
- **quota-grant-assessment** — testing/auditing the grant tokens: the invariant checklist + the combined-D1-fake technique.
- **access-control** — Google sign-in, terms/approval gates, quotas, break-glass Basic Auth, the admin interface, D1 setup.
- **security-posture** — the living risk register `SECURITY-RISKS.md`: re-check procedures, scans, and the security board.

Debugging & live verification:

- **live-verify** — Workers Logs / `wrangler tail`, request-id correlation, the recovery/heartbeat/stall machinery.
- **cache-helper** — every cache layer + the stale-site playbook (first remedy: Cloudflare Development Mode).
- **chat-logs** — the full-visibility interaction log: pulling live Q&A for debugging; the incognito opt-out.
- **bugreport-bugfix** — keyword → chatlogs search → replay through the gates → fix with the verbatim message as a test.
- **on-device-trace** — remote-debugging device-only bugs (iOS PWA) via build stamp + copyable on-device event trace.
- **sandbox-debug** — the sandbox boot-hang playbook: debug switches, the `boot_stage` timeline, the stall watchdog.
- **sandbox-perf-eval** — measuring how long sandbox commands take: the cold/warm battery + agent-turn trace, and the two traps (cross-origin auth kills the boot; the 30 s ceiling destroys the VM).

Feedback, boards & testing loops:

- **feedback-loop** — the user-feedback queue as a human-in-the-loop agent loop (gather → decide → act → message back).
- **feature-maintenance** — routing regressions back to the author-worker via PR comments; the owners registry.
- **decision-boards** — the admin board ⇄ agent-loop mechanism (`src/board.js`): catalogs, façades, `?format=text` inputs.
- **feature-board** — the feature-build loop over `FEATURES.md` + the playbook for standing up a new priority board.
- **testable-interaction-points** — the try-it queue: declaring linkable test points, the action grammar, verdicts.
- **test-feedback-loop** — the standing loop over the try-it queue: sync verdicts, mine every note, mint the next batch.
- **request-testing** — the worker side: ship test cases inside your PR as `docs/test-requests/<branch>.json`.
- **test-batches** — the standing library of standard test cases per pipeline case + the `scripts/test-batch` CLI.
- **starter-prompts** — the four opening questions on an empty chat and the cross-agent system that ranks them: the per-agent queue (4 shown, 20+ deep, exploit/explore rotation), the synthetic-provenance rule (never lift a starter from `chat_logs`), the judged dimensions + dead-end cap, the live battery `tests/starter-eval.mjs`, how a `rank` gets promoted with evidence, and the Settings knob **starter prompt evaluation** that turns the strip into a cross-agent review batch (proven/weak/untried/candidate bands + 👍👎).

Features & surfaces:

- **execution-sandbox** — the in-browser Linux sandbox + bash-lite agent: COEP isolation, the fenced-block loop, file mounts. ALSO the choice of WHERE commands run (`docs/EXECUTION-ENVIRONMENTS.md`): the DREE/1 seam and its three environments — the browser VM, a runner on the user's own machine, and (Se/rver only, because it is the one with the server in the data path) an ephemeral Cloudflare Container per session.
- **introspection** — introspection mode (`chat_mode: "introspection"`; the `developer_mode` knob it replaced): the committed snapshot + rag artifacts, both tiers' wiring.
- **models-agent** — the amber Models agent and the model LIFECYCLE it owns (discovered → evaluated → enabled): the provider-agnostic catalog (`src/model-catalog.js`, the ALLOWANCE), the established verification checks (`src/model-checks.js` — status, never blockers), the mode's enrichment (forced Hub search + the EN/SV lifecycle gate + the priced catalog block + the `model_cards` event), `/api/models/{catalog,verify,enable,disable}`, the per-account record, and the left-sidebar board that promotes a model into every OTHER mode's dropdown.
- **palaeogenomics** — the ancient-DNA agent: the two legs that make it (Europe PMC for the life-science literature, whose query grammar is the INVERSE of arXiv's — AND by default, so the ladder climbs by dropping terms; and a committed corpus of 20,927 published ancient individuals queried by radius/date window/haplogroup/coverage with no outbound request at all, not even a geocoder), the domain conventions an answer gets wrong without them (`Ignore_`, BP=1950, one-way haplogroup prefixes, dates as intervals), the entity-matching traps found only against the real corpus, and the seam worth copying: an enrichment gated on the agent spec's declared context block rather than on a mode or a knob. ALSO the reference for the JS `\b` Swedish-boundary trap, which silently kills bilingual regex gates repo-wide (invariant 6).
- **outrospection** — introspection's mirror image: the FIFTH chat mode (answers from the outward feed) and the feed page at `/outrospect/`: the seven-lens registry, the offline scan + per-visit refresh that fill it, and the feedback STRATEGY lane.
- **sdk-mode** — the green Agent Studio "lovable experience" mode: the chat-mode dropdown (Deep Research / Deep Science / Introspection / Agent Studio / Orchestrator / Outrospection / Models), the Platform-SDK (DistillSDK) build flow that distils an individual agent OR a whole platform, `/app/<slug>/` publishing, the MCP `sdk_*` tools.
- **orchestrator-mode** — the violet sub-agent workflow mode: one JSON plan phase decomposes a request into a team of sub-agents (Deep Research / Introspection / custom) the Worker runs in parallel waves, the `workflow`/`agent_update` SSE events, the live workflow graph view.
- **publish-app** — the admin/CLI bridge (`scripts/publish-app`, `PUT /api/build/:slug`) that publishes an already-built bundle (sandbox outbox, hand-assembled files) into sdk-mode's `/app/<slug>/` without a chat/tool loop.
- **help-docs** — help mode, the documentation-first layer of introspection: the docs corpus/index, docs-first routing.
- **publish-research** — publishing frozen replays at `DeepResearch.Se/cure/<slug>`; slugs must complete the phrase.
- **intro-baseline** — the APPROVED landing page and the tightly-controlled new-visitor intro phase (invariant 8): the ordered sequence, the first-visit keys, the twelve rules, and the contract tests. Load it before editing the landing, either tier's first run, or anything a stranger meets first.
- **ui-notes** — client UI/UX conventions: rendering, attachments, static pages, the public (no-auth) surface.
- **ux-conventions** — the numbered registry of codified UX interaction rules (UX-1 …); add an entry per new decision.
- **slash-spacing** — measuring the wordmark slash gap (`scripts/slash-gap.mjs`); never eyeball `.sl` margins.
- **space-animations** — the public /space/ archive of playable wireframe animations (one "animation skill" per common space question, EN+SV matched): the only-stars-glow rendering rule, real-scale zoom, the gallery feedback queue.
- **tokemon-game** — the games registry seam + the Tokemon AR game (Pokémon Gen-1 mechanics verbatim, no invented rules).
- **commit-analytics** — the public `/pulse` dashboard and its `npm run pulse` refresh workflow.
- **arxiv-rag** — the arXiv RAG search database (arXiv since late 2023, Berget-embedded; 772,658 vectors hosted in Vectorize, widened from 13 to 34 months on 2026-07-29): the OAI-PMH bulk-harvest pattern and the `--until` trap that silently under-harvests a historical band, the GCS enumeration mirror, the binary index pack, the three Berget serving limits that break long builds, the LaTeXML full-text extractor, and the evaluation discipline that keeps a RAG bake-off honest — including how to measure the SERVED path (not the local pack) and judge a corpus change with paired significance.
- **bulk-corpus-etl** — the PROVIDER-AGNOSTIC discipline for turning any large external corpus into a hosted, searchable vector index: enumerating from two independent sources (one cannot detect its own gaps — a 48% hole reported itself as success), "kept" vs unique counts, the window-boundary bug class, rate-limit citizenship and flow-control-is-not-failure, checkpointing that survives an ephemeral machine, Vectorize's billing model and serialization traps, and the relevance floor that stops dense retrieval answering off-topic questions with confident nonsense.
