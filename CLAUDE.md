# CLAUDE.md

Guidance for Claude Code when working in this repository. This file stays
SHORT on purpose — it is loaded into every session and its opening doubles as
the introspection orientation excerpt. The detail lives in `docs/` and the
on-demand skills under `skills-disabled/`; load what the task needs.

## Project

A Cloudflare Worker that serves a static chat UI (`public/`) and a streaming
`/api/chat` endpoint. Deployed via `npx wrangler deploy` (config in
`wrangler.toml`), git-connected to Cloudflare. The site is a *deep research*
assistant, matching its name: a research turn on `/api/chat` runs one of TWO
engines (the bespoke five-phase cascade was deleted 2026-08-29 — owner
directive, "don't keep this static pipeline"). The **agentic** engine
(`src/agentic.js`) hands the answer model a research brief and a toolbox and
lets it choose its own calls; the **standard** engine
(`src/pipeline-standard.js`) is the four-node compact graph
(generate_queries → web_research → reflect → finalize), every node a direct
JSON-mode or streamed call. `engineFor` picks: what the request asked for,
else what the agent declared, else the loop wherever the model can drive one —
and the standard graph everywhere else, which is the FALLBACK that keeps the
whole catalog working. The primary LLM provider
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

> ### FINISH EVERY CHANGE WITH A PULL REQUEST (owner directive, 2026-08-03)
>
> **When the work is complete and no further decision is needed from the
> owner, OPEN A PULL REQUEST. Always. Do not ask for permission first, and do
> not stop at a pushed branch — a pushed branch with no PR is unfinished
> work.** This is a STANDING instruction from the owner: it replaces any
> default "only open a PR when explicitly asked", and it applies to every
> change, however small (a one-line fix, a doc tweak, a test).
>
> The ONLY reason not to open the PR is that you genuinely need owner input —
> an ambiguous requirement, a decision that changes what gets built, a
> destructive or irreversible step. In that case ask (`AskUserQuestion`), get
> the answer, then finish and open the PR. "I could not fully verify it" or
> "part of it is blocked" is NOT a reason to hold the PR: open it, and say in
> the PR body what is unverified or left out.
>
> Then immediately `subscribe_pr_activity` on it — see the watch-your-PR
> directive below. Direct-to-`main` merges remain permitted, but a PR is the
> default and the expected outcome of a session.

- **Sync first.** Always sync with the latest `origin/main` BEFORE
  implementing anything — new sessions are routinely off-sync. The
  SessionStart hook (`.claude/hooks/sync-main.sh`) fetches and fast-forwards;
  if it printed a WARNING, rebase onto `origin/main` before touching code.
  Re-fetch before every push. See the **sync-main** skill.
- **Both merge styles are supported (2026-07-13), but the PR is the default
  (2026-08-03):** a change may land by a PR merged into `main` OR a direct
  branch merge / push to `main` — open the PR unless the owner asked for a
  direct merge. Always cut work on a feature branch off the latest
  `origin/main`; a merged branch is DONE — branch fresh from the updated
  `main`. See **merge-branches**.
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
# then open a PR targeting main (the default — see the directive above),
# and subscribe_pr_activity on it right away.
# A direct branch merge / push to main stays permitted when the owner asks.
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

1. **Deterministic orchestration — the FALLBACK is never optional.** The
   platform must work across Berget's entire catalog, including models with
   unreliable tool-calling, so every deterministic phase stays a direct
   JSON-mode or streamed call and nothing may depend on tool use being
   available. Authorized exceptions (owner directive, 2026-07-12; extended to
   SDK mode 2026-07-18, and to RESEARCH 2026-08-29): DEVELOPER MODE's source
   investigation, SDK MODE's build flow, and the AGENTIC research engine —
   when the answer model supports real tool use, IT drives the calls
   (`grep_source` / `read_file` / `list_files` over the site's own source,
   Se/cure adding a real `run_bash`; in SDK mode the `sdk_*` planning tools +
   `write_file`/`publish_app`; on the research path the toolbox in
   `src/research-tools.js`). Each one is DELIBERATE and must not be "fixed"
   back, and each one is paired with a fallback that carries the same request
   without tools: the deterministic source read loop (introspection), the
   fenced `FILE:`-block convention (SDK mode), and the four-node standard
   graph `src/pipeline-standard.js` (research — `engineFor` routes there for
   any model with no tool dialect and any run whose toolbox resolves empty).
   The JSON planning phases (invariant 3) never use tools. See the
   **introspection** and **sdk-mode** skills.
2. **Helper phases fail soft, never break the request.** Search, the reflect
   round, validation, and every enrichment (geocode + every extension) degrade
   to a lesser result (fewer searches, an unreflected wave, accepted draft,
   conversation unchanged) rather than erroring the chat — and on the agentic
   engine every tool refusal is a SENTENCE the model reads next round, never a
   throw. Both Berget calls are time-bounded so a hung
   backend can't defeat that.
3. **Split model routing.** Every JSON/structured phase — the standard
   graph's `generate_queries` and `reflect` nodes, validation, the quiz gate,
   the orchestrator plan — runs on the fixed reliable `DEFAULT_MODEL`
   (Mistral Small), through `jsonPhase` and `ctx.jsonModel`; only synthesis,
   the AGENTIC tool loop, and direct/search-off replies run on the user's
   chosen model — regardless of which PROVIDER serves that model. The agentic
   engine is the deliberate half-exception: its planning IS the loop, so the
   user's model plans its own tool calls there — but its report is still
   validated on the planning model, and a model that cannot drive the loop
   falls back to the standard graph, where the split is total. Token
   accounting, budgeting, and profiles are split accordingly (`jsonTotals`
   vs `totals`).
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
   secrets never appear in any log. FOUR deliberate, bounded, opt-in,
   quota-metered exceptions (owner ruling, 2026-08-15) route Se/cure
   traffic through the server: the temporary web-search GRANT
   (query-only); the secure-research-space proxy bundle (its `api` grant
   is the grant subsystem's one content-bearing exposure — clearly
   disclosed in the UI); SHARED COMPUTE, where a workspace's `pt1` pool
   token (`grants.pool`, `public/js/workspace-core.js`) relays the
   consumer's prompt through this server to a named peer's machine
   (`docs/COMPUTE-SHARING.md`); and WORKSPACE KNOWLEDGE, where a
   conclusion sealed to the import agent and POSTed to
   `/api/knowledge/submit` (`src/knowledge.js`) rests as ciphertext in D1
   `knowledge_inbox` that the server CAN decrypt, because that agent's
   private key lives in D1 (`knowledge_agent.private_jwk`) — deliberate,
   and disclosed in the participant-facing data-flow notice. Workspaces
   are how the last two arrive rather than an exception of their own; the
   consolidated **Se/rver TOKEN** (2026-07-16, one HS256 JWT with a
   `perms` set over the same two upstream services) unifies the grant
   families going forward and carries THE SERVER-TOKEN GUARANTEE. That
   guarantee exists to protect **Se/cure**, whose posture is pass-through
   only: a token READS nothing Se/rver stores (no project, chat, history
   or account contents) and is NEVER a login (the admin surface rejects it
   everywhere, test-pinned). Its one write is Se/cure feedback
   (`POST /api/server-token/feedback` — write-only, no read path). It is
   NOT a rule about the Se/rver tier: there the server is INSIDE the trust
   boundary (owner directive, 2026-07-24), and agents collaborating and
   orchestrating over server-side storage is the intended direction, not an
   exception to be argued down.
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
npm test            # unit: node --test src/*.test.js public/js/*.test.js public/app-kit/*.test.js
                    #                  public/games/*/js/*.test.js sdk/*.test.mjs scripts/*.test.mjs
                    #                  scripts/*/*.test.mjs tests/*.test.js
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
hand. What each suite covers, the e2e fixtures/quirks, and the six eval
harnesses (model-matrix, rubric bench, HF bench, and since 2026-08-05 the
GROUND-TRUTH battery `tests/dr-eval.mjs` — published gold answers over
`POST /mcp`, a loss breakdown that separates a retrieval miss from a synthesis
miss, and a no-search control arm that measures the memorised share instead of
assuming it; append-only ledgers, don't deploy mid-battery):
**`docs/TESTING.md`**.

## Python in the sandbox — it is lypning, and it lives elsewhere now

The interpreter the sandbox runs is **[lypning](https://github.com/kristerhedfors/lypning)**,
a MIXTURE OF PYTHONS: a Rust subset, a MicroPython variant with a frozen shim
stdlib, and real CPython, with a classifier that picks per program. It used to
live here as `pygram/` + `mopy/`; it was broken out on 2026-08-29 and **this
repository now depends on it rather than carrying it** (`docs/LYPNING.md`).

Why a subset at all: `python3 --version` alone costs **8573 ms cold** in the
browser VM and can cross the 30 s ceiling that destroys it, while a frozen
subset opens **zero** files. In the image `scripts/build-sandbox-image.sh`
builds, a plain `python3 -c 'print(1+1)'` has been measured NEVER COMPLETING —
so this is not a preference between interpreters, it is the difference between
the sandbox having Python and not having it.

When a tier meets something outside its subset it refuses the same way every
tier does — exit **90**, one `<engine>: unsupported: <kind>: <detail>` line on
stderr, nothing on stdout — and the dispatcher falls onward to the next tier.
**That is why you do not have to write to a subset**: the mixture answers
everything, and a wrong route costs one wasted process spawn rather than a wrong
answer. Write ordinary Python; the router pays for the parts it cannot take.

What is still THIS repository's to get right is the SEAM, and all of it can fail
quietly:

- `scripts/build-sandbox-image.sh` installs both engines and must **skip
  loudly** when they are absent or not i386 — an image built without them is the
  failure that looks like success. CheerpX is 32-bit x86 only.
- `tests/e2e/sandbox-perf.spec.js` pairs both engines against the three CPython
  probes, using a builtin `[ -x … ]` test and never `command -v`: a PATH walk
  for a missing tool once consumed the whole 30 s exec ceiling and destroyed
  the VM, taking every later probe with it.
- `/lypning/` measures them in a real browser VM and plots the project's own
  history (`npm run lypning`, `npm run lypning:check`). Its one editorial rule
  is lypning's own third invariant: **never present a remembered number as a
  measurement.** A figure is either measured here or labelled as a quote.

The engine's own gates — the build shape, and the CPython conformance run where
MISMATCH is fatal and UNSUPPORTED is just the build order — run in lypning's CI,
against an artifact this repository does not build.

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
`ANSWER_PHASE_RUNNERS`). **The roster is SPECIFIC and has no general member
(owner directive, 2026-08-13):** the `normal` mode and its `research` agent —
the catch-all labeled "Deep Research" — are retired (`RETIRED_CHAT_MODES` keeps
old clients resolving); **Deep Science (`science` / agent `scholar`) is the
default and terminal fallback**, so an unrouted request now gets a POLICY
(literature-first: the peer-reviewed record leads and is numbered first, and
since 2026-08-14 a knob-gated web leg runs BEHIND it, labelled as web reporting
and barred from standing in for the literature on a scientific claim — feedback
#69, `docs/SCHOLAR.md` §4a) instead of open-web research, and it
alone among the mode defaults declares `requires: []`; and a new **Cyber**
(`cyber`) agent owns cybersecurity and OSINT. `capability.context` became
EXECUTED with it — `capHasContext` gates the enrichment and search-source
registries, so Deep Science exclusively owns arXiv + PubMed + the peer-reviewed
leg (palaeogenomics keeps `literature-pubmed`) and Cyber exclusively owns host
intelligence, street imagery, the OSINT methods and the OWASP corpus. Since
2026-07-18 the SDK is WIRED into the app: the pure core
`public/js/sdk-core.js` (façade `src/sdk-tools.js`; the CLI re-exports it) powers
**SDK mode** — labeled **Agent Studio** in the UI (2026-07-23; renamed from
"Agent Builder"; the mode id stays `sdk`, internally still "SDK mode"/DistillSDK)
— the green "lovable experience" entry in the chat-mode dropdown (Deep Science /
Cyber / Introspection / Agent Studio / Orchestrator / Outrospection / Models)
that DISTILLS this site — above all the client-side **Se/cure** tier — into
either a new individual **agent** OR an entire new **platform**, using the SDK's
modules/skills as the method and the deployed Se/cure source as the original,
then publishes it live at `/app/<slug>/` (`src/build-pub.js`, opaque-origin CSP
sandbox). (The `/mcp` `sdk_*` tools were removed 2026-08-15 when that surface
was reshaped for voice callers; the CLI and Agent Studio drive the same core) (where `/src/sdk/pair-cli.mjs` also works in
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

Detailed guidance is split into on-demand skills under `skills-disabled/` —
load the relevant one before working in its area. Each skill's `description`
frontmatter is its load trigger; the list below is the index.

> **PARKED (owner experiment, 2026-08-16).** The whole tree was moved from
> `.claude/skills/` to `skills-disabled/`, so the Claude Code CLI no longer
> auto-loads any of them and `/<name>` no longer resolves. The point is to
> find out **which skills are actually needed** — with nothing loaded by
> default, a skill only enters a session when the work genuinely calls for it
> and you go read it. **They are not deleted and not stale: the content is
> unchanged and still authoritative.** When the index below tells you a skill
> covers what you are about to do, `Read skills-disabled/<name>/SKILL.md`
> yourself before starting — that is now a manual step, not an automatic one.
> Re-enabling is one command with no code change:
> `git mv skills-disabled .claude/skills`. The site is unaffected —
> introspection's catalog matches both roots (`SKILL_PATH_RE`), so every
> playbook is still surfaced to users and to any answer model.

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
- **ground-truth-eval** — measuring whether answers are RIGHT rather than well-written: the gold-answer battery `tests/dr-eval.mjs` over `POST /mcp`, the three published sets, the no-search CONTROL ARM that measures the memorised share instead of assuming it (and why a set rejected as contaminated is usable behind one), the loss breakdown that names retrieval vs synthesis, the A/B deploy dance this account forces (no preview URL; a branch push ships to production), and the four measurement traps already paid for.
- **add-llm-provider** — adding a new LLM provider or models: the registry seam, catalog contract, validation ladder.
- **model-catalog-refresh** — checking which model menus need updating when a provider ships a new release (e.g. Opus 5): the replace-vs-add decision, never-invent-a-price rule, and following an id bump through every echo.
- **tune-provider-models** — tuning new models per codified use case and running their first eval battery.
- **add-research-source** — integrating a new deep-research source end to end (intent, registry, SSE visibility, validation).
- **local-web-search** — running your own web-search service as an Exa alternative, configurable in both tiers.
- **sse-protocol** — the `/api/chat` SSE event vocabulary, forward-compatibility rule, and the inline-quiz event.
- **mcp-server** — the site exposed AS a tool other agents call (`POST /mcp`, hand-rolled JSON-RPC 2.0, TWO protocol revisions side by side since 2026-08-15: the handshake `2025-06-18` and the stateless `2026-07-28`). The surface is shaped for callers WITHOUT A SCREEN: `deep_research` (with an `agent` and a voice `style`), the four `literature_*` corpus tools, ChatGPT's two adapters, and the six extension tools that answer in spoken prose — `street_view_look` / `place_nearby`, and the host-intelligence family `host_intel` / `host_search` / `domain_intel` / `cve_intel` (widened 2026-08-16 from the host lookup alone to the population, the domain and the vulnerability); connecting Claude Code via an MCP key at the advertised bare origin `https://mcp.deepresearch.se` (no `/mcp` tail), the per-account exposure config under Settings → MCP server, and the OAUTH CONNECTOR that makes the surface addable in Claude and ChatGPT — and so reachable from a phone — (`src/oauth-{metadata,store,authorize,token}.js`, the `search`/`fetch` adapters ChatGPT requires by name, `docs/MCP-CONNECTOR.md`; built 2026-08-03, not yet accepted against a live client).
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
- **lypning** — the Python the sandbox runs, which is now a SEPARATE PROJECT (`docs/LYPNING.md`, github.com/kristerhedfors/lypning): a mixture of three interpreters — a Rust subset, a MicroPython variant with a frozen shim stdlib, and CPython — with a classifier that picks per program and one refusal contract (exit 90, one line on stderr, nothing on stdout) that makes a wrong pick cost one wasted spawn instead of a wrong answer. What is left HERE is the seam and it can fail quietly: the image installer that must skip loudly rather than ship an image with no fast Python, the paired e2e probes that use a builtin `[ -x … ]` and never `command -v` (a PATH walk for a missing tool once ate the whole 30 s exec ceiling and destroyed the VM), the `/lypning/` dashboard that measures both engines in a real browser VM, and `scripts/build-lypning.mjs`, which walks a lypning clone's history into the committed dataset the dashboard plots. Its one editorial rule is lypning's own third invariant — never present a remembered number as a measurement — which the page enforces by labelling every figure MEASURED HERE or QUOTED and by rendering a commit that published no table as a GAP rather than a zero. Why any of this exists: `python3 --version` costs 8573 ms cold in that VM and a plain `python3 -c 'print(1+1)'` has been measured never completing, while a frozen subset opens zero files. The engine's own gates — build shape, and the CPython conformance run where MISMATCH is fatal and UNSUPPORTED is just the build order — run in lypning's CI against an artifact this repository does not build.

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
- **cyber** — the crimson Cyber agent (`chat_mode: "cyber"`), the cybersecurity/OSINT domain and the only agent allowed outward-facing intelligence: what it exclusively owns (host intelligence, street imagery, the entity + person OSINT methods, the OWASP corpus), how each is declared as a `capability.context` block and enforced by `capHasContext`, the AND-gate with the per-account extension knobs, the exclusivity guard, and how to add a new OSINT source.
- **models-agent** — the amber Models agent and the model LIFECYCLE it owns (discovered → evaluated → enabled): the provider-agnostic catalog (`src/model-catalog.js`, the ALLOWANCE), the established verification checks (`src/model-checks.js` — status, never blockers), the mode's enrichment (forced Hub search + the EN/SV lifecycle gate + the priced catalog block + the `model_cards` event), `/api/models/{catalog,verify,enable,disable}`, the per-account record, and the left-sidebar board that promotes a model into every OTHER mode's dropdown.
- **palaeogenomics** — the ancient-DNA agent: the two legs that make it (Europe PMC for the life-science literature, whose query grammar is the INVERSE of arXiv's — AND by default, so the ladder climbs by dropping terms; and a committed corpus of 20,927 published ancient individuals queried by radius/date window/haplogroup/coverage with no outbound request at all, not even a geocoder), the domain conventions an answer gets wrong without them (`Ignore_`, BP=1950, one-way haplogroup prefixes, dates as intervals), the entity-matching traps found only against the real corpus, and the seam worth copying: an enrichment gated on the agent spec's declared context block rather than on a mode or a knob. ALSO the reference for the JS `\b` Swedish-boundary trap, which silently kills bilingual regex gates repo-wide (invariant 6).
- **outrospection** — introspection's mirror image: the chat mode that answers from the outward feed, and the feed page at `/outrospect/`: the seven-lens registry, the offline scan + per-visit refresh that fill it, and the feedback STRATEGY lane.
- **sdk-mode** — the green Agent Studio "lovable experience" mode: the chat-mode dropdown (Deep Science / Cyber / Introspection / Agent Studio / Orchestrator / Outrospection / Models), the Platform-SDK (DistillSDK) build flow that distils an individual agent OR a whole platform, `/app/<slug>/` publishing.
- **orchestrator-mode** — the violet sub-agent workflow mode: one JSON plan phase decomposes a request into a team of sub-agents (Web research / Introspection / swarm / custom) the Worker runs in parallel waves, the `workflow`/`agent_update` SSE events, the live workflow graph view.
- **publish-app** — the admin/CLI bridge (`scripts/publish-app`, `PUT /api/build/:slug`) that publishes an already-built bundle (sandbox outbox, hand-assembled files) into sdk-mode's `/app/<slug>/` without a chat/tool loop.
- **help-docs** — help mode, the documentation-first layer of introspection: the docs corpus/index, docs-first routing.
- **publish-research** — publishing frozen replays at `DeepResearch.Se/cure/<slug>`; slugs must complete the phrase.
- **intro-baseline** — the APPROVED landing page and the tightly-controlled new-visitor intro phase (invariant 8): the ordered sequence, the first-visit keys, the twelve rules, and the contract tests. Load it before editing the landing, either tier's first run, or anything a stranger meets first.
- **ui-notes** — client UI/UX conventions: rendering, attachments, static pages, the public (no-auth) surface.
- **ux-conventions** — the numbered registry of codified UX interaction rules (UX-1 …); add an entry per new decision.
- **slash-spacing** — measuring the wordmark slash gap (`scripts/slash-gap.mjs`); never eyeball `.sl` margins.
- **space-animations** — the public /space/ archive of playable wireframe animations (one "animation skill" per common space question, EN+SV matched): the only-stars-glow rendering rule, real-scale zoom, the gallery feedback queue.
- **tokemon-game** — the games registry seam + the Tokemon AR game (Pokémon Gen-1 mechanics verbatim, no invented rules).
- **video-capture** — recording the site in a browser and turning it into a shareable clip: the run matrix over selected AGENTS × selected MODELS × the shipped example prompts (`npm run capture`), the activity TIMELINE the driver writes (which is the only reason dead air can be cut at all — ffmpeg's scene detection cannot tell "the pipeline is thinking" from "the answer paused"), the cut/speed knobs and the ffmpeg settings LinkedIn actually plays (`npm run capture:edit`), and the admin SWIPE DECK where a capture is liked (right) or sent back with feedback (left). Reference: `docs/VIDEO-CAPTURE.md`.
- **commit-analytics** — the public `/pulse` dashboard and its `npm run pulse` refresh workflow; also the landing's "What work has been done and when" card and the code-volume backdrop behind its curves — the **activity graph**, so a bare "update activity graph" / "uppdatera aktivitetsgrafen" loads this skill.
- **WHAT IS INGESTED (no skill — read `docs/CORPORA.md`)** — the canonical answer to "what literature can this thing actually search", and the public page `/corpora/` it describes. Both are GENERATED by `node scripts/build-corpora.mjs`, which pages the live indexes, because the equivalent claim hand-maintained in code (`CORPUS_FACTS.arxiv.window`) went stale by 42,307 papers and told agents to stop looking. Neither corpus is a uniform window: arXiv is a swept band **2310–2607** PLUS topic-shaped tails back to 1991, PubMed is a **load-order** slice (recent *edits*, so old revised papers are in and recent unrevised ones are not) — never a publication-date range. Regenerate it after ANY fill, named-list ones included; nothing in the test suite fails when it is stale.
- **pubmed-ingest** — RE-RUNNING the PubMed ingest into `deepresearch-se-pubmed`: the two runbooks (a full rebuild, ~1.64 M citations and ~2.3 h; a delta, only the archive files added since the marker in `docs/PUBMED-RAG.md` §7, minutes), why a delta needs no record of what is already indexed (upsert is keyed by `pmid:`, and deleting an absent id is a no-op), the annual-baseline cutover that turns a delta back into a rebuild, and the four traps that broke the first fill — parallel `npx` racing its own cache, background processes dying at turn boundaries, `pkill -f` matching the calling shell, and duplicate loaders double-embedding in silence.
- **arxiv-ingest** — RE-RUNNING the arXiv ingest into `deepresearch-se-arxiv`, the sibling of **pubmed-ingest**: the same two runbooks (a full rebuild of the 34-month band; a delta of the months added since the marker in `docs/ARXIV-RAG.md` §1, ~10 min per month), but arXiv's delta is a DATESTAMP WINDOW rather than a file number — so `--until` and `--keep-months` are what decide whether the run silently under-harvests — plus why a delta needs no record of what is already indexed (upsert keyed by the version-less arXiv id), why there is no prune leg, and verification against the GCS enumeration rather than the run's own counters.
- **arxiv-rag** — the arXiv RAG search database (arXiv since late 2023, Berget-embedded; 823,722 vectors hosted in Vectorize — measured into `public/corpora/data.json` on 2026-08-09, not hand-maintained — widened from 13 to 34 months on 2026-07-29): the OAI-PMH bulk-harvest pattern and the `--until` trap that silently under-harvests a historical band, the GCS enumeration mirror, the binary index pack, the three Berget serving limits that break long builds, the LaTeXML full-text extractor, and the evaluation discipline that keeps a RAG bake-off honest — including how to measure the SERVED path (not the local pack) and judge a corpus change with paired significance.
- **rag-hillclimb** — MEASURING and improving the hosted dense-retrieval indexes (arXiv + PubMed as one pipeline): the single instrument `scripts/rag-eval.mjs` (sample/goldset/coverage/run/compare/judge/parity/probe), the coverage-first order, the paired McNemar that decides every verdict rather than the eye, the loss-breakdown table that says which STAGE to work on, the adjacent-domain control the relevance floor cannot be tuned against, and the append-only ledger `docs/RAG-EVAL-LEDGER.md` that keeps a settled negative result settled.
- **bulk-corpus-etl** — the PROVIDER-AGNOSTIC discipline for turning any large external corpus into a hosted, searchable vector index (its §12 is the PubMed instance — `docs/PUBMED-RAG.md`, the biomedical corpus beside arXiv): enumerating from two independent sources (one cannot detect its own gaps — a 48% hole reported itself as success), "kept" vs unique counts, the window-boundary bug class, rate-limit citizenship and flow-control-is-not-failure, checkpointing that survives an ephemeral machine, Vectorize's billing model and serialization traps, and the relevance floor that stops dense retrieval answering off-topic questions with confident nonsense.
