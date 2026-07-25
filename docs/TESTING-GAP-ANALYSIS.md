# Testing — gap analysis (2026-07-24)

A full pass over the test surface: what runs, what runs it, what is
covered, and what is not. `docs/TESTING.md` stays the per-suite
enumeration; this file is the review of the surface as a *system* —
where automation is missing, where coverage is missing, and where the
structure is working against itself.

Companion to `docs/ARCHITECTURE-GAP-ANALYSIS.md` (P7 is its testing
entry; the bench gate shipped from it on 2026-07-23).

## Baseline measured

| | |
|---|---|
| Unit test files | 142 (73 `src/`, 66 `public/js/`, 2 `sdk/`, 1 `scripts/`) |
| Unit tests | 2299 in 233 suites, **18 s**, 0 failing, 0 skipped |
| Unit test lines | ~31 100 |
| `@ts-check` opt-in | 161 of 194 non-test modules (`src/` all but one; the 41 misses are in `public/js/`) |
| e2e (Playwright) | 54 tests — 43 mocked (free), 11 `@live` (spends tokens) |
| Eval harnesses | 3 (model matrix, rubric bench, HF bench) + the bench gate |
| **CI runs** | **none — there is no `.github/` directory** |

> **Measured 2026-07-24, before items 1–4 of the remediation below landed.**
> The numbers are left as measured so the findings stay legible against
> them; after items 1–4 the suite is 2366 tests in 241 suites, `@ts-check`
> covers 173 of 194 modules, and CI runs on every push and pull request.

`npm test` and `npm run typecheck` both pass. The suite is fast, dense,
and genuinely good at what it covers. Every finding below is about the
edges around it.

---

## A. Automation gaps

### A1 — Nothing runs the tests but a human (or an agent that remembers)

There is no `.github/workflows/`. The two git hooks (`.githooks/pre-commit`,
`pre-push`) run the secret scanner and print a bench-gate *reminder*; neither
runs `npm test`. `.claude/settings.json`'s SessionStart hooks sync main,
set up signing, and install the git hooks — no test step. The only thing that
runs the suite is the **pr** skill telling an agent to.

That means a 2299-test suite that finishes in 18 seconds gates nothing. A
branch can merge into `main` — and auto-deploy — red. This is the single
highest-leverage fix on the list, and it is cheap: one workflow running
`npm ci && npm test && npm run typecheck` on push and pull_request.

### A2 — Two test files are outside the runner

`npm test` globs `src/*.test.js public/js/*.test.js sdk/*.test.mjs
scripts/*.test.mjs`. It does not glob `tests/`. So
`tests/bench-score.test.js` and `tests/hf-bench-lib.test.js` — 43 passing
tests over the bench scoring and HF bench helpers — run only when someone
invokes `node --test` on them by hand. They pass today; nothing would tell
us if they stopped.

### A3 — `npm run typecheck` fails in a fresh clone

Nothing installs the root devDependencies. In this session's clone
`node_modules/` was empty, and `npm run typecheck` died with
`TS2688: Cannot find type definition file for '@cloudflare/workers-types'`
— which reads like a project misconfiguration, not a missing install. After
`npm install` it passes clean. A strict type gate that errors confusingly on
first contact is a gate people route around. Either add `npm install` to
SessionStart or make the script self-heal.

### A4 — The free e2e project is never run automatically

`npm run test:mocked` is 43 tests, intercepts `/api/chat`, and costs nothing.
It is also invisible: it needs break-glass credentials, `BASE_URL` defaults to
`https://deepresearch.se`, and `playwright.config.js` declares no `webServer`.
There is no way to run the browser suite against a local worker.

`BASE_URL` is already an env override, so pointing the suite at
`npx wrangler dev` (or at a branch preview URL) is a config change, not a
rewrite. That would make the mocked project runnable offline, in CI, and
against a PR's own preview — which is where it would actually catch
regressions before they ship.

### A5 — Committed-artifact drift tests disable themselves

The four freshness checks in `src/introspect.test.js` and
`public/js/introspect-core.test.js` call `t.skip()` when the artifact file is
absent:

```js
t.skip("source-rag.json absent — dense retrieval off until `npm run bundle:rag` is committed");
```

The intent is sound (the rag index needs a Berget key to rebuild). The effect
is that *deleting* an artifact turns its guard green. Today all six artifacts
are committed and nothing skips, so the risk is latent — but the failure mode
is a silent pass, which is the worst kind. A repo-level test asserting the
expected artifact set exists would close it without touching the skips.

### A6 — The try-it queue is a machine-readable DSL driven by hand

`src/testpoints.js` defines eleven action types — `newChat`, `compose`
(with `send`), `setSearch`, `setBudget`, `selectModel`, `openSettings`,
`openAccount`, `openProjects`, `openHistory`, `highlight`, `note` — and
`public/js/testpoints.js` executes them on arrival. `docs/test-batches/`
holds ten curated batches of points. Every run is still a person clicking
through and recording a verdict.

Most of that grammar is exactly what a Playwright script does. A runner that
reads a batch JSON, opens each point's deep link, executes the actions, and
captures a screenshot + the `/api/chat` payload would automate the reachable
subset outright and leave humans only the points whose summaries say *attach a
PDF by hand*. The batches already mark those (`docs/test-batches/attachments.json`
is entirely `note`-driven), so the split is already encoded in the data.

### A7 — The bench gate is a reminder, not a gate

`pre-push` prints a note when outgoing commits touch pipeline-sensitive files
and stops there — correctly, since the gate needs live credentials and a
deployment. But that leaves the highest-signal quality check in the repo
entirely dependent on someone reading a hook's stderr. A `workflow_dispatch`
job (or a scheduled nightly against the deployment) would give it a place to
run without blocking a push.

---

## B. Coverage gaps

Import-based coverage — which modules any test file actually loads — differs
sharply from what the filename convention suggests.

### B1 — `src/pipeline.js` has no direct coverage at all

1905 lines. One export: `runPipeline`, a **1672-line function**. It is the
product. `src/pipeline.test.js` never imports it — the suite covers
`isTransientConnectStatus` and `contextOverflowMessage` from
`answer-stream.js`, `collectConflicts` from `pipeline-inputs.js`, and
`normalizeTriage` from `triage.js`. `docs/TESTING.md` lists the suite as
covering "`pipeline.js` + `pipeline-inputs.js` (the flow's pure pieces)",
which is true of the pieces and misleading about the module.

The five-phase orchestration — phase ordering, the fail-soft degradations
that invariant 2 promises, budget exhaustion, the search→gap→synthesis
handoff — is verified only live and only by the rubric bench's score.
Notably, `public/js/drc-research.test.js` *does* run the client-side pipeline
end to end against a mock provider (897 lines, phase order, split routing,
fail-soft triage). The server pipeline has no equivalent. The DRC test is the
existence proof that the harness is buildable.

### B2 — The request layer is untested

- `src/index.js` — 761 lines, ~93 path branches. **No test calls the fetch
  handler.** No route-table test, no method/404 matrix, no auth-gate matrix.
- `src/chat.js` — 868 lines. `src/chat.test.js` is 120 lines covering three
  re-exported helpers (`summarizeSpend`, `resolveJsonModel`,
  `quotaBlockedResponse`). `handleChat` itself is untested.

Concretely: **the incognito promise has no test.** Invariant 4 states the
`chat_logs` row must be suppressed when a request carries `incognito: true`.
That behaviour is `if (!incognito)` at `src/chat.js:438`, inside an untested
function. `src/chatlog.test.js` covers the row-building helpers thoroughly and
never touches the suppression decision. For a documented API promise in the
privacy model, that is the wrong side of the seam to be testing.

### B3 — Other modules no test imports

| Lines | Module | Note |
|---:|---|---|
| 1905 | `src/pipeline.js` | see B1 |
| 1074 | `src/maps-enrichment.js` | `runGoogleMapsEnrichment`; the *text* half (`googlemaps-text.js`) is covered well by `googlemaps.test.js` |
| 899 | `src/pool.js` | façade — its core is tested, but the façade identity is not pinned (B5) |
| 761 | `src/index.js` | see B2 |
| 749 | `src/testpoints.js` | façade; `testpoints.test.js` covers the core |
| 516 | `src/tokemon-api.js` | the game *core* is well covered; the API layer is not |
| 445 | `src/admin-api.js` | admin surface |
| 329 | `src/storage.js` | |
| 288 | `src/orchestrator.js` | `runOrchestration` — the whole sub-agent wave engine |
| 255 | `src/user-api.js` | |
| 245 | `src/login.js` | auth-adjacent |
| 203 | `src/accounts.js` | |
| 186 | `src/bash-api.js` | `/api/bash/step` |
| 157 | `src/enrichment.js` | the enrichment fan-out |
| 136 | `src/quiz-api.js` | |
| 108 | `src/geocode.js` | |

The pattern is consistent and deliberate: **pure cores are tested, request
handlers and orchestration drivers are not.** That is a defensible line, and
it is also where the untested surface has grown to ~5 000 lines including the
two most important files in the repo.

### B4 — 41 `public/js` modules carry no `@ts-check`

`src/` is essentially fully opted in (only `src/schema.js` missing). The
client is not — and the misses include *tested pure cores*, where the type
checker would be free signal on code that already has a test harness:

`drc-research.js` (1039), `space-core.js` (816), `ondevice-core.js` (722),
`drc-providers.js` (660), `turns.js` (644), `account-views.js` (512),
`drc-page-core.js` (353), `report.js` (331), `drc-core.js` (275),
`vault-core.js` (217), `activity-core.js` (163), `drc-store.js` (105).

The DOM-glue misses (`stream.js`, `admin.js`, `app.js`, `sandbox.js`) are a
separate, larger job. The cores are a same-day job.

### B5 — Façade contracts are pinned in 3 of 15 places

Fifteen `src/` modules re-export a `public/js/` core. Only `bash-agent.js`,
`feedback.js`, and (per `docs/TESTING.md`) `introspect-tools.js` assert
*identity* — that the façade's export **is** the core's function object, not a
copy that has quietly drifted. `pipeline.js`, `pool.js`, `proxy.js`,
`orchestrator.js`, `knowledge.js`, `space.js`, `agent-link.js`,
`agent-spec.js`, `ai-models.js`, `sdk-tools.js`, `websearch-backends.js`,
`introspect.js` do not. This is a one-line assertion per module and the whole
mirror discipline rests on it.

### B6 — Invariants without a guard test

The repo has exactly one repo-wide invariant test — `sql-injection-guard.test.js`,
which scans every `src/` module for interpolated SQL. It works, it is well
built, and it is the only one of its kind. Invariants with no mechanical
enforcement:

- **Invariant 1 (no function calling in the pipeline).** Nothing fails when
  someone adds `tools:` to a planning-phase call. The two authorized
  exceptions are enumerable, so an allowlist scan is straightforward.
- **Invariant 6 (Swedish/English parity in *every* routing gate).** Parity is
  tested extensively per gate — `googlemaps.test.js`'s parity suite,
  `hf.test.js`, `feedback.test.js`, `quiz.test.js`, `bash-core.test.js`,
  `introspect-core.test.js`, `tokemon-nav.test.js`. But the invariant says
  "present **or FUTURE**", and nothing discovers a *new* gate. A census test
  that enumerates exported `*Intent` functions and fails when one has no
  parity test would make the invariant self-enforcing.
- **CODE-LAYOUT mirror discipline.** `docs/CODE-LAYOUT.md` is documented as
  having one row per `src/` module, kept current in the same commit. No test
  checks that. `features.js` and `security-risks.js` already demonstrate the
  catalog⇄markdown mirror test; this is the same shape.
- **Secrets never in logs.** Stated in invariant 4, enforced only by review.

---

## C. Structural issues

### C1 — Eleven hand-rolled D1 fakes, of eleven different fidelities

`fakeDb` / `stubDb` / `mockD1` are re-implemented in `agent-link` (25 lines),
`board` (16), `google` (33), `knowledge` (75), `pool` (130), `proxy` (91),
`quota` (33), `server-errors` (68), `server-grants` (86), `testpoints` (33),
`websearch` (75), `workspace-grants` (120) — roughly **750 lines of
duplicated fake**, plus a separate `fakeThreadingDb`/`fakeFeedbackDb` pair in
`feedback.test.js`.

Fidelity varies with the author's needs rather than with D1: only
`quota.test.js` meaningfully models `batch()`, none model `exec()`, and none
model constraint violations, transaction rollback, or a query that throws.
Tests therefore pass against twelve different approximations of the binding
they are standing in for. A single `src/test-helpers/d1.js` — one fake, one
SQL subset, error injection included — would cut the duplication and raise
everyone's fidelity at once. There are no shared test helpers of any kind in
the repo today.

### C2 — The same for `fetch` and `env`

Thirteen test files assign `globalThis.fetch` directly; two of them wrap it in
a local `mockFetch`. There is no shared request-recorder, no shared response
builder, and no shared `env` factory — every suite hand-rolls the bindings it
needs. The consequence shows up as C1's: assertions about *what was sent
upstream* are written differently in every file, so the "outbound requests
carry the minimum" privacy property (invariant 4) is asserted ad hoc where it
is asserted at all.

### C3 — Assertion strength is unmeasured, and coverage is uninstrumented

Census across `src/` + `public/js/`: 4406 `assert.equal`, 1053
`assert.match`, 973 `assert.ok`, 837 `assert.deepEqual`, 19
`assert.rejects`, 0 `assert.throws` — the whole repo has **one**
`assert.throws`, in `sdk/pair-cli.test.mjs:54`. The `assert.ok` share is
where weak assertions hide (`ok` on a truthy object passes for a great many
wrong objects), and 19 rejection assertions across 2299 tests is thin for a
codebase whose invariant 2 is *fail soft, never throw*.

Nothing measures line coverage. `node --test --experimental-test-coverage` is
built in, needs no dependency, and would turn the whole of section B from an
inference off import graphs into a number.

### C4 — Test time is already concentrated in one suite

Measured in isolation: `public/js/workspace-core.test.js` takes **10.0 s**
and `src/workspace-grants.test.js` another 1.9 s, against a 17.8 s full run.
`node --test` runs files in parallel, so workspace-core is the critical
path — the suite is as fast as that one file. Almost all of it is real
8192-round PBKDF iteration (`dual-key: the master key is nonce-dependent`
alone is 2.4 s). Exercising the real KDF is correct; it also makes the round
count a load-bearing constant for suite latency. Worth knowing before someone
raises it.

### C5 — Two test files are binary to standard tooling

`src/pool.test.js` (3 NUL bytes, in composite map keys like
`` `${pool}\x00${key}` ``) and `src/testpoints.test.js` (1 NUL, in a
control-character rejection case) contain literal NUL bytes, so `grep`
reports "binary file matches" and silently returns nothing useful — which is
how B1 nearly went unnoticed in this pass. Both uses are legitimate; writing
the byte as a backslash-x00 string escape keeps the semantics and restores
greppability.

---

## Recommended order

Ordered by (signal gained) ÷ (effort), not by section.

1. ~~**Add CI.**~~ **Done 2026-07-25** — `.github/workflows/ci.yml` runs
   `npm ci && npm test && npm run typecheck` on push, pull_request and
   workflow_dispatch, with per-branch concurrency. Closes A1, and the `npm ci`
   step closes A3.
2. ~~**Widen the test glob**~~ **Done 2026-07-25** — `npm test` now globs
   `tests/*.test.js` too (+43 tests, closing A2), and `src/artifacts.test.js`
   asserts the committed-artifact set is present, git-TRACKED, non-trivial,
   and parses — the half the self-skipping freshness guards could not cover
   (A5).
3. ~~**`@ts-check` the tested `public/js` cores.**~~ **Done 2026-07-25** — all
   twelve opted in, 483 reported errors resolved with real JSDoc (shared
   `DrcProvider`/`DrcCallOpts` and `Vec3`/`Mesh` typedefs, not blanket `any`).
   What it caught is in the note below. The 29 remaining DOM-glue modules
   (`stream.js`, `admin.js`, `app.js`, `sandbox.js`, …) are still open.
4. ~~**Pin the unpinned façade contracts.**~~ **Done 2026-07-25** —
   `src/facade-contract.test.js` DISCOVERS the façades by scanning `src/` for
   `../public/js/*` imports rather than listing them, so a new façade is
   covered the day it lands. 17 pairs pinned. What it caught is in the note
   below.
5. **Shared test helpers** — `d1.js`, `fetch.js`, `env.js` — and migrate the
   twelve fakes onto them (C1, C2). *Days: 1–2, and it unblocks 6 and 7.*
6. **A `runPipeline` harness** on the DRC-research pattern: mock provider,
   mock search, in-memory env, assert phase order, the fail-soft ladder, and
   budget exhaustion (B1). The single biggest coverage win in the repo.
   *Days: 2–3.*
7. **A request-layer suite** over `index.js` and `chat.js`: route matrix, auth
   gates, and the incognito suppression promise (B2). *Days: 1–2.*
8. **Turn on `--experimental-test-coverage`** and record a baseline (C3).
   *Hours: 1.*
9. **Invariant census tests** — Swedish-parity discovery, no-function-calling
   allowlist, CODE-LAYOUT mirror (B6), modeled on
   `sql-injection-guard.test.js`. *Days: 1–2.*
10. **Point Playwright at `wrangler dev`** via `webServer` + `BASE_URL`, and
    run the mocked project in CI (A4). *Days: 1–2.*
11. **A try-it batch runner** that executes the action grammar headlessly
    (A6). Largest payoff of the lot; also the largest build.
    *Days: 3–5.*

Item 8 is still an hour's work and worth doing next; it would replace this
document's import-graph inference with a measured number.

### What items 1–4 turned up (2026-07-25)

Three defects surfaced the moment the checks were switched on, which is the
argument for the rest of the list:

- **A hand-mirrored `deepLink`.** `src/testpoints.js` carried its own copy of
  `public/js/testpoints-core.js`'s `deepLink` — byte-equivalent apart from
  inlining `TRY_PARAM` as the literal `"try"`. Exactly the drift the mirror
  discipline exists to prevent, invisible until the façade guard compared the
  function objects. Collapsed onto the core.
- **A duplicate key in the PDF transliteration map.** `public/js/report.js`
  listed `"→"` twice in `PDF_TRANSLIT` (both times as `"->"`, so no behaviour
  change). `@ts-check` reports it as TS1117; nothing else would have.
- **A projection narrower than its data.** `drc-page-core.js`'s
  `serverTokenService` promised `remaining?: number|null` while the wire — and
  `serverTokenLive`, which coerces with `Number()` — allows a string. The
  types now say what the data actually is.

One legitimate divergence was found and recorded rather than "fixed":
`websearch-backends.js`'s `runBackendSearch` takes an `env` the core doesn't,
and delegates. It sits in the guard's `DELIBERATE_OVERRIDES` map, so a *new*
divergence still fails.
