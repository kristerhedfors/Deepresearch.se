# Which capabilities can be tested automatically (2026-07-29)

The question this answers: **which of the platform's capabilities can be
verified by solid automatic testing with little or no human input, which
cannot, and where is the cheapest climb?**

It is a companion to two existing files, not a replacement for either.
`docs/TESTING.md` enumerates the suites. `docs/TESTING-GAP-ANALYSIS.md`
(2026-07-24) reviewed the test surface as a system and produced an ordered
remediation list. This file adds the axis neither had: capability × *how
automatable is it*, measured rather than inferred, with a ratchet so the
answer keeps improving instead of being re-derived every few weeks.

---

## 1. Method

The 2026-07-24 pass inferred the untested surface from the import graph —
which modules a test file happens to `import` — and flagged that as the
weakness in its own evidence:

> Nothing measures line coverage. `node --test --experimental-test-coverage`
> is built in, needs no dependency, and would turn the whole of section B from
> an inference off import graphs into a number.

That is now `npm run coverage` (`scripts/coverage.mjs`). It runs the suite
under Node's built-in coverage, excludes test files from the report, and
weights each module by size. Two things it does that the raw Node output does
not:

- **Unloaded modules count as zero, not as absent.** Node reports 0% for a
  file it loaded and *nothing at all* for a file no test ever imports. The
  difference is the whole point: an unloaded module is not "poorly covered",
  it is untested, and it is invisible in the headline percentage. Node's own
  "all files" line read 81.50% on a tree where 18 146 lines were in modules no
  test had ever loaded.
- **It ratchets.** `npm run coverage:check` fails when the numbers fall below
  `docs/coverage-baseline.json`, and fails with no tolerance when a module
  that *was* reached stops being reached. It runs in CI after the suite.

There is deliberately **no per-module coverage threshold**. A blanket "every
file ≥80%" is satisfied by testing whatever is easiest to reach, which is
rarely what is worth testing. The ratchet asks only that the number not fall.

---

## 2. The measured baseline

Same script, same methodology, before and after this pass:

| | 2026-07-24 surface | after this pass | Δ |
|---|---:|---:|---:|
| line coverage | 69.25% | **71.92%** | +2.67 |
| branch coverage | 70.62% | **71.71%** | +1.09 |
| function coverage | 62.94% | **64.89%** | +1.95 |
| modules never loaded by any test | 40 | **32** | −8 |
| lines in never-loaded modules | 18 146 (16.9%) | **15 319 (14.3%)** | −2 827 |
| unit tests | 4 058 | **4 155** | +97 |

Both columns are measured on the same tree, so the delta is this change and
nothing else. The committed floor in `docs/coverage-baseline.json` is a little
different — 262 modules, 33 never loaded, line 71.93% — because it was
re-recorded after merging the latest `main`, which brought its own modules.
That is the number CI compares against; the table above is the attribution.

Per-module, where the work went:

| module | before | after |
|---|---:|---:|
| `src/chat.js` (1 195 lines) | 26.05% | **90.12%** |
| `src/pipeline.js` (2 387 lines) | 44.64% | **65.30%** |
| `src/index.js` (964 lines) | *never loaded* | **73.83%** |

The single structural result is worth stating on its own:

> **Every module in `src/` is now loaded by at least one test.** All 32
> remaining never-loaded modules are in `public/js/`.

That is not a coincidence, and it is the finding this document is really
about — see §4.

---

## 3. The testability tiers

Capabilities sort into five tiers by what a test of them costs. The tiers are
about *cost per run*, not about difficulty of writing: a hard test that then
runs free forever belongs in T1.

| tier | what it needs | can it gate every PR? |
|---|---|---|
| **T1 — free and deterministic** | Node, fakes, nothing else | yes, and does |
| **T2 — free but needs a DOM** | a headless browser or a DOM shim | yes, if a runner exists |
| **T3 — free but needs the app running** | a local Worker or a preview URL | yes, if wired |
| **T4 — costs money or a credential** | live provider keys, real D1, tokens | no — scheduled or on demand |
| **T5 — needs a human judgement** | someone looking at it | no |

The boundary that matters most is **T1/T2**, because it is where this
codebase's own architecture already puts a seam: the pure-core convention.
Shared logic lives in `public/js/*-core.js` and is re-exported by a `src/`
façade, so the *logic* is T1 even when the *surface* is T2. Fifteen such pairs
exist and `src/facade-contract.test.js` pins them.

---

## 4. Capability by capability

### T1 — fully automatable, no human input, running today

Everything in `src/` is now here. Concretely:

| capability | where it is tested | notes |
|---|---|---|
| The 5-phase research pipeline | `src/chat-handler.test.js`, `public/js/drc-research.test.js` | server path added this pass; the client path was already the existence proof that the harness was buildable |
| Request routing, auth gate, security headers | `src/index.test.js` | added this pass |
| The incognito privacy promise | `src/chat-handler.test.js` | added this pass — see §5 |
| Split model routing (invariant 3) | `src/chat-handler.test.js` | planning phases pinned to `DEFAULT_MODEL` |
| Quota windows, budgets, cost accounting | `src/quota.test.js` | |
| Every intent gate, EN + SV (invariant 6) | `googlemaps.test.js`, `quiz.test.js`, `bash-core.test.js`, … | parity suites per gate |
| Grant/token subsystems | `server-grants`, `workspace-grants`, `proxy`, `pool` | |
| Crypto, key hierarchy, vault | `token-crypto`, `vault`, `workspace-core` | real KDF rounds, deliberately |
| SQL-injection guard, façade contracts, artifact freshness | repo-wide guard tests | the invariant-test pattern |
| The SDKs (manifest, spec validation, CLI) | `sdk/*.test.mjs` | |
| Games, space animations, RAG scoring | their own core suites | |

**Why the whole server surface is T1.** Every request handler in `src/` has the
same signature — `(request, env, log, identity)` → `Response`. None of it needs
a browser, a network, or a credential; it needs a plausible `env`. That was
always true, and the reason ~2 500 lines of it went untested was not difficulty
but the absence of a shared way to *build* that `env`: the repo had fifteen
hand-rolled D1 fakes of fifteen different fidelities and no `env` factory at
all. `src/test-helpers/` is that missing piece, and once it existed, `chat.js`
went from 26% to 90% in one file of tests.

### T2 — automatable, but needs a DOM; nothing runs them today

All 32 never-loaded modules, 15 319 lines. They are DOM glue: they query the
document, bind listeners, and mutate the page.

The big ones: `stream.js` (2 287), `admin.js` (1 519), `app.js` (1 231),
`watch-render.js` (1 108), `space-embed.js` (894), `history-ui.js` (642),
`account-settings.js` (539), `projects-ui.js` (535), `models-panel.js` (488),
plus the `account-*` panels and `attachments.js`.

Unit-testing them means a DOM shim (jsdom), which is a runtime dependency, and
invariant 5 is "no build step, no added runtime deps for the Worker/tests". So
the honest answer for this tier is **not "write unit tests" but "route it to
T3"** — these modules are exactly what a browser test exercises anyway, and
§6 item 2 is the cheaper path to the same coverage.

Where a T2 module contains logic worth pinning, the established move is to
extract it into a `*-core.js` and pin the façade. That is a per-module
judgement, not a campaign.

### T3 — automatable, needs the app running; wired but never run automatically

`npm run test:mocked` is 43 Playwright tests that intercept `/api/chat` and
cost nothing to run. They are invisible in practice: they need break-glass
credentials, `BASE_URL` defaults to the live site, and `playwright.config.js`
declares no `webServer`, so there is no way to run the browser suite against a
local Worker.

`BASE_URL` is already an env override, so pointing the suite at `wrangler dev`
or at a branch preview URL is a config change, not a rewrite. This is the
single largest untapped automation in the repo: 43 already-written free tests,
plus the door to the whole T2 tier.

The **try-it queue** (`src/testpoints.js`) is the same story one level up. It
defines eleven action types — `newChat`, `compose`, `setSearch`, `setBudget`,
`selectModel`, `openSettings`, … — and `docs/test-batches/` holds ten curated
batches. That grammar is close to what a Playwright script does, and the
batches already mark which points genuinely need hands (`attachments.json` is
entirely `note`-driven). The split between automatable and human is therefore
**already encoded in the data**; nothing has read it yet.

### T4 — automatable but not free

Model evaluation (model matrix, rubric bench, HF bench), live provider
behaviour, the arXiv RAG served path, real D1. These are genuinely automatic —
they need no human — but each run spends tokens, so they belong on
`workflow_dispatch` or a schedule, never on a PR. The bench gate is currently a
`pre-push` *reminder* printed to stderr, which makes the highest-signal quality
check in the repo dependent on someone reading a hook's output.

### T5 — genuinely needs a human

Small, and worth naming precisely so effort is not spent trying to automate it:

- **Visual and motion judgement.** The intro animations, the spinners
  (`umbrella-spinner`, `plant-spinner`, `balloon*`), the backdrops, the
  wordmark slash gap. Note the slash gap is the exception that proves the rule:
  it was moved out of T5 by *measuring* it (`scripts/slash-gap.mjs`) rather
  than eyeballing it.
- **Answer quality.** Whether a research answer is *good* is a rubric
  judgement. The rubric bench approximates it with a model judge (T4), which is
  a proxy, not a replacement.
- **Device-specific behaviour.** iOS PWA quirks, the CheerpX sandbox on real
  hardware. `docs/…` on-device tracing exists precisely because this resists
  automation.
- **Whether a change is the right change.** Not a testing problem.

---

## 5. Weak points, ranked

Ordered by (risk closed) ÷ (effort), with what was done this pass marked.

1. **A documented privacy promise with no test.** ✅ *closed this pass.*
   Invariant 4 states the `chat_logs` row must be suppressed when a request
   carries `incognito: true`. That was one `if (!incognito)` inside a function
   no test called. `src/chat-handler.test.js` now pins it in both directions,
   pins that suppression is *exact* (usage accounting still runs — it is a
   promise about the interaction log, not about becoming invisible), and pins
   that it keys on the boolean `true` rather than on truthiness.

2. **No shared test helpers, so twelve suites tested against twelve different
   D1s.** ✅ *closed this pass.* `src/test-helpers/` provides one D1 fake, one
   fetch recorder, and `env`/`log`/`identity`/`ctx` factories. The capability
   none of the hand-rolled fakes had is **recording**, which is what lets a
   test assert a *negative* — that some statement never ran. That is exactly
   the shape of the incognito promise, and it is why that promise had no test:
   no fake could express it. The existing fifteen fakes are left in place;
   migrating them is mechanical follow-up, not a prerequisite.

3. **The two most important files in the repo were the least covered.**
   ✅ *largely closed.* `chat.js` 26% → 90%, `index.js` absent → 74%,
   `pipeline.js` 44% → 65%. `pipeline.js` is the remaining one: `runPipeline`
   is a 1 672-line function and the search→gap→synthesis ladder is still
   exercised only through the search-off and single-round paths.

4. **Invariant 4's outbound-minimum rule was asserted ad hoc or not at all.**
   ✅ *partially closed.* The fetch recorder makes "no outbound request carried
   the user's identity" and "the provider secret never reaches a log line" one
   assertion each, and `chat-handler.test.js` uses both. Generalising this to
   every enrichment is the follow-up.

5. **43 free browser tests that nothing runs** (T3 above). *Open.* Highest
   remaining ratio: the tests exist, the config change is small, and it opens
   the entire T2 tier.

6. **The invariants have almost no mechanical enforcement.** *Open.* The repo
   has exactly one repo-wide invariant test (`sql-injection-guard.test.js`) and
   it works well. Invariant 1 (no function calling in planning phases) has no
   guard — nothing fails when someone adds `tools:` to a planning call, and the
   two authorized exceptions are enumerable, so an allowlist scan is
   straightforward. Invariant 6 is tested per gate but nothing *discovers* a
   new gate, and the invariant explicitly says "present or FUTURE".

7. **The bench gate is a printed reminder, not a gate** (T4 above). *Open.*

8. **Assertion strength is unmeasured.** *Open.* 19 `assert.rejects` and
   (until this pass) one `assert.throws` across 4 000+ tests, in a codebase
   whose invariant 2 is *fail soft, never throw*. The `assert.ok` share is
   where weak assertions hide.

### A finding recorded rather than fixed

Building the fail-soft tests turned up one behaviour worth the owner's
attention rather than a unilateral change.

`getDb` (`src/db.js`) applies the schema on first use with an uncaught
`await db.batch(statements)`. A database that is *absent* is handled — it
returns `null`, and the documented contract is "callers must handle null
(feature off, not an error)". A database that *errors* is not: the exception
propagates out of the handler, and `src/index.js` turns it into a clean 500.

That is fail-**closed**, and for a binding that gates authentication and quotas
it is arguably the correct direction — degrading to "no database" would mean
degrading to "no quota enforcement", and several callers treat a null `db` as
"no restriction". So the test
(`chat-handler.test.js` → "a TOTAL D1 outage surfaces as an error rather than a
silent answer") **documents the behaviour instead of asserting it away**, with
a comment saying why. If someone later makes `getDb` swallow the error, that
failing test is the prompt to think about the quota-bypass consequence first.
Direction-ambiguous drift like this is the `docs-drift-validation` skill's
Class C: it needs an owner checkmark, not a session's opinion.

---

## 6. The ordered climb from here

1. **Point Playwright at a local Worker** — `webServer` + `BASE_URL` in
   `playwright.config.js` — and run the mocked project in CI. Unlocks 43
   existing free tests and the whole T2 tier. *Days: 1–2.*
2. **A try-it batch runner** that executes the eleven-verb action grammar
   headlessly against that Worker, leaving humans only the points the batches
   already mark as hands-on. *Days: 3–5.*
3. **Invariant guard tests**, modelled on `sql-injection-guard.test.js`: a
   no-function-calling allowlist scan (invariant 1), a Swedish-parity census
   that fails when a new `*Intent` export has no parity test (invariant 6), and
   a `CODE-LAYOUT.md` mirror check. *Days: 1–2.*
4. **Deepen `runPipeline`** onto the multi-round search path — search → gap
   check → second round → synthesis → validation, and the budget-exhaustion
   ladder. The harness exists now; this is writing cases against it.
   *Days: 1–2.*
5. **Migrate the fifteen hand-rolled D1 fakes** onto `src/test-helpers/d1.js`.
   Mechanical, and it raises every migrated suite's fidelity to include error
   injection. *Days: 1–2.*
6. **Give the bench gate somewhere to run** — `workflow_dispatch`, or a
   schedule against the deployment. *Hours.*

Items 1 and 2 are where the remaining 14.3% lives. Everything else on the list
is about making the covered surface *mean* more, rather than covering more of
it.

---

## 7. Keeping this file honest

The numbers above are reproducible in one command:

```bash
npm run coverage -- --list     # measure, and list where the climb is cheapest
npm run coverage:check         # fail if it went backwards (runs in CI)
npm run coverage -- --save     # raise the floor after a real gain
```

`docs/coverage-baseline.json` is the floor and is committed. When a pass
genuinely improves coverage, re-record it in the same commit — that is what
makes the next pass's "before" number trustworthy rather than something to be
re-derived by hand.
