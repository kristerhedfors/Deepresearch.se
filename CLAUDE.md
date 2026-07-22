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
`src/openai.js`; both dispatched via the `src/providers.js` registry; the
JSON planning phases always stay on Berget). Web search is **Exa**.

**Mission (2026-07-13):** the project is framed as **innovation and
research on the privacy capabilities of LLM applications** — how far a
real, useful research assistant can be pushed toward *provable* privacy,
and where that trades against capability. The **proof is the site itself**:
a fully open-sourced, independently verifiable **Se/cure + Se/rver pair**.
It is still experimental and nowhere near production-ready (say so; do not
frame it as a finished product). The "built over a weekend, phone-only"
origin is kept in FULL only on `/story/`, with brief non-leading pointers on
`/build/`, the landing, and the README — it is the origin, not the identity,
so don't lead with it elsewhere.

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
skill. Full rule + rationale: `docs/BRANDING.md`.

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
   validation, and every enrichment (geocode/Shodan/Maps) degrade to a lesser
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
   THE SERVER-TOKEN GUARANTEE: upstream APIs ONLY — never any Se/rver data —
   and NEVER a login (the admin surface rejects it everywhere, test-pinned).
   Full model, endpoints, token families, dated directives:
   `docs/PRIVACY-MODEL.md`.
5. **Minimal dependencies; evidence-driven exceptions.** No build step, no
   added runtime deps for the Worker/tests. Per-model overrides
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

> **Plan status (current): this Cloudflare account is on Workers PAID** —
> `wrangler.toml` sets `[limits] cpu_ms = 300_000` (5 min CPU/request). Do
> NOT reason from the old Free-plan 10 ms ceiling; an isolate dying is rare
> now. The historical exceededCpu record is in the **pipeline-architecture**
> skill.

## Code layout

`src/` is the Worker: entrypoint `index.js` (routing + identity gate),
pipeline `pipeline.js` + phase helpers, the provider registry
`providers.js` (Berget/Anthropic/OpenAI), the grant/token subsystems, the
admin decision boards, and one module per integration. `public/` is the
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
npm test            # unit: node --test src/*.test.js public/js/*.test.js sdk/*.test.mjs
npm run typecheck   # zero-build-step tsc, strict, opt-in per file via // @ts-check
cd tests && npm install && npm run fixtures   # e2e setup (once)
npm run test:mocked                           # Playwright vs live site, /api/chat intercepted (free)
npm run test:live                             # 5 live tests (real Berget tokens + one Exa run)
```

Unit tests (Node's built-in runner, no deps) cover pure logic and mockable
seams; anything touching a live provider, D1, or the DOM is still verified
live — that's where this project's real bugs have come from (the
**live-verify** skill). Editing tracked text or source can stale the
committed introspection artifacts — `npm test` names the drift; fix with
`npm run bundle` / `bundle:rag` / `bundle:docs` / `bundle:docs-rag`, never by
hand. What each suite covers, the e2e fixtures/quirks, and the three eval
harnesses (model-matrix, rubric bench, HF bench — append-only ledgers, don't
deploy mid-battery): **`docs/TESTING.md`**.

## DistillSDK and interchange standards

`sdk/` is **DistillSDK** (2026-07-16): the Se/cure + Se/rver pair
abstraction as a design (`sdk/DESIGN.md`), a 33-module registry
(`sdk/MANIFEST.json`) with one buildable skill per module, and a
dependency-free CLI (`node sdk/pair-cli.mjs list|show|plan|validate`,
unit-tested in `npm test`). Since 2026-07-18 the SDK is WIRED into the app:
the pure core `public/js/sdk-core.js` (façade `src/sdk-tools.js`; the CLI
re-exports it) powers **SDK mode** — the green "lovable experience" entry in
the chat-mode dropdown (Normal / Introspection / SDK) that DISTILLS this site —
above all the client-side **Se/cure** tier — into a new self-contained web-app
*flavour*, using the SDK's modules/skills as the method and the deployed Se/cure
source as the original, then publishes it live at `/app/<slug>/`
(`src/build-pub.js`, opaque-origin CSP sandbox) — and the `/mcp` `sdk_*` tools,
so agents plan against the manifest without shelling into the sandbox (where
`/src/sdk/pair-cli.mjs` also works in dev mode). (A separate khaki **SWE mode**
— "a new instance of Se/cure" — shipped 2026-07-18 and was folded into SDK mode
2026-07-19 as redundant; distilling Se/cure into flavours is now SDK mode's core
purpose, upholding Se/cure's privacy invariants when the flavour stays
client-side.) SDK mode's native tool loop rides invariant 1's SAME authorized
exception as introspection (deterministic `FILE:`-block fallback on non-tool
models); see the **sdk-mode** skill. Its complete standalone documentation is
`docs/DISTILLSDK.md`, updated in the same commit as any `sdk/` change.
The **interchange standards** (2026-07-17) specify the workspace bundle and
pipeline structure as open standards — **DRSW/1**
(`docs/WORKSPACE-PROTOCOL.md`) and **DRPL/1** (`docs/PIPELINE-LANGUAGE.md`,
tooling `sdk/drpl.mjs`); the vision is `docs/STACKLESS-RESEARCH.md`. The
standards deliberately LEAD the code (spec-first); the deployed workspace
feature is their reference implementation.

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
- **refactor-clarity** — refactoring for clarity here without breaking anything: the pure-core convention, what to preserve.
- **update-docs** — reconciling the whole documentation surface with the code: the inventory, drift greps, regenerate rules.
- **docs-drift-validation** — bottom-up docs⇄code validation: the doc-age drift scan, layer walk, and the OWNER-checkmark loop for capability/posture drift (ledger `docs/DOC-DRIFT-LOG.md`).
- **anti-ai-smell** — removing AI smell (LLM writing tells) from documentation prose: the tell taxonomy, the two de-smell modes (lint-guided edit vs. full regeneration + fact-verify), the fact-preservation contract, and the runnable Vale style. The one place rewriting docs for STYLE is the goal (update-docs deliberately does not); docs files only, never code.

Pipeline & models:

- **pipeline-architecture** — the research pipeline engine: the 5 phases, split routing, the budget planner, incident history.
- **model-eval** — the model-matrix eval harness, `QUERY_SETS` discipline, the findings ledger, evidence-driven profiles.
- **add-llm-provider** — adding a new LLM provider or models: the registry seam, catalog contract, validation ladder.
- **tune-provider-models** — tuning new models per codified use case and running their first eval battery.
- **add-research-source** — integrating a new deep-research source end to end (intent, registry, SSE visibility, validation).
- **local-web-search** — running your own web-search service as an Exa alternative, configurable in both tiers.
- **sse-protocol** — the `/api/chat` SSE event vocabulary, forward-compatibility rule, and the inline-quiz event.
- **mcp-server** — the site exposed AS an MCP `deep_research` tool (`POST /mcp`, hand-rolled JSON-RPC 2.0).
- **integrations** — external providers and the enrichment pattern (Berget, Anthropic, OpenAI, Exa, Nominatim, Shodan, Maps, HF).

Privacy, storage & grants:

- **storage-privacy** — chat-history encryption + key hierarchy, implicit cloud storage, RAG, projects, the vault.
- **secure-workspaces** — offline workspace links (`/cure/workspace#w=…`), the hacka.re-cloned crypto, quota-adjust surfaces.
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

Feedback, boards & testing loops:

- **feedback-loop** — the user-feedback queue as a human-in-the-loop agent loop (gather → decide → act → message back).
- **feature-maintenance** — routing regressions back to the author-worker via PR comments; the owners registry.
- **decision-boards** — the admin board ⇄ agent-loop mechanism (`src/board.js`): catalogs, façades, `?format=text` inputs.
- **feature-board** — the feature-build loop over `FEATURES.md` + the playbook for standing up a new priority board.
- **testable-interaction-points** — the try-it queue: declaring linkable test points, the action grammar, verdicts.
- **test-feedback-loop** — the standing loop over the try-it queue: sync verdicts, mine every note, mint the next batch.
- **request-testing** — the worker side: ship test cases inside your PR as `docs/test-requests/<branch>.json`.
- **test-batches** — the standing library of standard test cases per pipeline case + the `scripts/test-batch` CLI.

Features & surfaces:

- **execution-sandbox** — the in-browser Linux sandbox + bash-lite agent: COEP isolation, the fenced-block loop, file mounts.
- **introspection** — introspection mode / `developer_mode`: the committed snapshot + rag artifacts, both tiers' wiring.
- **sdk-mode** — the green SDK "lovable experience" mode: the chat-mode dropdown, the DistillSDK build flow, `/app/<slug>/` publishing, the MCP `sdk_*` tools.
- **publish-app** — the admin/CLI bridge (`scripts/publish-app`, `PUT /api/build/:slug`) that publishes an already-built bundle (sandbox outbox, hand-assembled files) into sdk-mode's `/app/<slug>/` without a chat/tool loop.
- **help-docs** — help mode, the documentation-first layer of introspection: the docs corpus/index, docs-first routing.
- **publish-research** — publishing frozen replays at `DeepResearch.Se/cure/<slug>`; slugs must complete the phrase.
- **ui-notes** — client UI/UX conventions: rendering, attachments, static pages, the public (no-auth) surface.
- **ux-conventions** — the numbered registry of codified UX interaction rules (UX-1 …); add an entry per new decision.
- **slash-spacing** — measuring the wordmark slash gap (`scripts/slash-gap.mjs`); never eyeball `.sl` margins.
- **tokemon-game** — the games registry seam + the Tokemon AR game (Pokémon Gen-1 mechanics verbatim, no invented rules).
- **commit-analytics** — the public `/pulse` dashboard and its `npm run pulse` refresh workflow.
