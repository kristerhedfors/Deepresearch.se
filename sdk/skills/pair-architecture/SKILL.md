---
name: pair-architecture
description: >-
  Load when starting ANY work on a platform built with this SDK — before
  generating a new platform, before adding a module to an existing one, when
  deciding which tier a capability belongs to, when naming a new platform (the
  stem/wordplay convention), or when reviewing whether a change violates a
  platform contract. This is the SDK's constitution: the platform abstraction, the
  zero-or-one-server property, the capability classes C/S/B/X/D and their
  module-graph rules, contracts PA-1..PA-10, and the test patterns that PIN
  the rules so they cannot silently erode.
---

# Pair architecture — the constitution of a platform

A **platform** is one AI-assistant product shipped as two tiers of the same
capability set: a **client tier** that runs wholly in the browser with no
server in the data path, and a **server tier** where exactly one server
component (an edge worker) sits between the browser and the upstream APIs.
This skill defines the rules every other SDK module builds under — the tier
split, the capability classes, the ten contracts, the naming convention, and
the test patterns that make the rules *provable* rather than aspirational.
Nothing here is style: each rule traces to a reproduced incident or a codified
directive in the reference implementation (this repository).

## Capability class & tier story

Manifest class: **D — development system.** This module ships no product
code; it is knowledge both tiers are built under. Its "tier story" is the tier
story mechanism itself:

- **The client tier** (reference: DeepResearch.**Se/cure**, `/cure`) — the
  assistant runs entirely in the browser. No accounts. If a server exists it
  serves static bytes and public read-only JSON and is in **no data path**:
  model calls go browser-direct to the user's own CORS-capable providers (or
  their own local OpenAI-compatible server — then *no* third party receives
  the conversation), the orchestration pipeline runs client-side, and state
  (chats, settings, API keys) rests sealed in browser-local storage under
  user-held secrets. Privacy is **structural**: the server could not log
  content or keys even in principle.
- **The server tier** (reference: DeepResearch.**Se/rver**, `/rver`) — the
  signed-in assistant. The one edge worker owns orchestration, identity,
  quotas, metering, cloud storage, observability, and the admin surface.
- **The zero-or-one-server property.** Across the whole platform there is at most
  ONE server component — no auth service, no search-proxy fleet, no mesh.
  Every server-side responsibility lives in the one worker, and the client
  tier must remain fully functional with that worker reduced to (or replaced
  by) a static file host. This is what makes the privacy claims *auditable*:
  the client tier's guarantees follow from the absence of a server in the
  data path, not from a policy document.

Every module is classified by where it can run:

| Class | Meaning | Hard rule |
|---|---|---|
| **C** — client-pure | Works on a static host; no server in the data path | Its module graph may NOT import a class-S module — pinned by tests |
| **S** — server-backed | Lives only in the one worker | Never imported into a class-C graph |
| **B** — bridged | A server capability *lent* to a client-tier session via metered grant tokens | Opt-in, disclosed, quota-metered, time-limited, fail-safe, minimal-payload — the ONLY sanctioned tier crossover |
| **X** — shared substrate | One pure core used by BOTH tiers | Import-safe in Node, dependency-free, server side is a façade re-export |
| **D** — development system | Loops/evals/boards/workflows | Not product code; keeps the platform maintainable by agent sessions |

## Contracts

This module *defines* PA-1..PA-10 (`sdk/DESIGN.md` §2); every later module
cites the subset it carries. One line each on what enforcing it means:

- **PA-1** Deterministic orchestration, no function calling — the orchestrator
  picks every phase/query; models fill in JSON or prose; exceptions are
  opt-in, capability-gated, with the deterministic path as universal fallback.
- **PA-2** Helper phases fail soft — search/gap/validation/enrichments degrade
  to a lesser answer, never an errored chat; every outbound call time-bounded.
- **PA-3** Split model routing — JSON planning phases on a fixed reliable
  model; only synthesis on the user's choice; accounting split the same way.
- **PA-4** The privacy split — ciphertext at rest everywhere it can be, with
  narrowly-declared readable exceptions; keys never rest beside ciphertext;
  outbound requests carry the minimum, never the conversation or identity.
- **PA-5** Minimal dependencies, no build step — plain-source deploys; a new
  runtime dep must encode knowledge the project doesn't want to own.
- **PA-6** Language parity in deterministic gates — every routing regex takes
  all supported languages with equal breadth, parity-tested in the same change.
- **PA-7** The shared-core rule — class-X logic written ONCE as a pure core
  under the client tree; the server façade's "surface IS the core" is pinned
  by a unit test; hand-mirrored copies are forbidden.
- **PA-8** The bridge discipline — all tier crossings ride grant tokens:
  namespace-separated families under one root secret, atomic meters, budget
  ceilings, instant revocation, upstream-APIs-only guarantee.
- **PA-9** Fail-safe metering — no meter backend ⇒ no spend, ever (contrast
  PA-2: helpers fail soft; money and quota fail safe).
- **PA-10** Verify live; measure before believing — external integrations are
  probed against the live deployment; quality changes land behind a scored
  benchmark; ledgers are append-only.

## Build plan

For a NEW platform, land this module first — it is documents, conventions, and
pinned tests, not features:

1. **Pick the stem and wordplay.** The two tiers are named by ONE wordplay: a
   shared brand stem whose URL path completes a word per tier (the reference:
   `DeepResearch.Se` + `/cure` → "Secure", + `/rver` → "Server"). Choose a
   domain whose TLD (or path boundary) can complete two English words — one
   evoking the client tier's privacy, one naming the server. Test the split
   out loud: the capital tail letter must make the hidden word readable
   (**Se/cure** → "Secure"). Reserve both lowercase paths in the router plan.
2. **Codify the naming rules** in the platform's CLAUDE.md-equivalent, verbatim
   from the reference convention:
   - Display form: full URL without scheme, CamelCase, wordplay tail in bold —
     `Brand.`**St/em-a** and `Brand.`**St/em-b**; plain text drops the bold,
     never the full-URL form. No space inside the URL.
   - Short form: the slashed tail alone (**Se/cure**-style) — the slash is the
     distinguishing marker.
   - **Client-tier-first ordering**: whenever the two tiers are named together
     (sentence, list, table columns, paired diagrams), the client tier comes
     FIRST. A single tier named in its own context is exempt.
   - **Lowercase functional URLs**: CamelCase is display-only; `href`s, fetch
     paths, publish slugs, and host strings stay lowercase — the host is
     case-insensitive, the paths are not.
   - **No internal acronyms in user-facing copy**: code identifiers (the
     reference's DRC/DRS) live in code, internal docs, and commits only — a
     third name pair confuses readers (reference directive, 2026-07-12).
   - If the rendered UI tightens the slash with a spacing span, the margin is
     font/weight-dependent and must be MEASURED, never eyeballed (the
     reference's `.sl` span + `scripts/slash-gap.mjs`; see the
     `symbol-language` module).
3. **Write the platform's DESIGN.md** restating §1–2 of `sdk/DESIGN.md` with the
   platform's own names: the tier definitions, the zero-or-one-server property,
   the class table, and PA-1..PA-10 quoted by number so every later module and
   PR can cite them.
4. **Write the platform's MANIFEST.json** (clone `sdk/MANIFEST.json`'s shape):
   `id`/`layer`/`class`/`deps`/`skill`/`reference`/`provides`/`acceptance`
   per module; declare the baseplate (`pair-architecture`, `baseplate-worker`,
   `baseplate-client`) mandatory and everything else selectable.
5. **Establish the class-C module-graph pin.** Before the first client-tier
   feature lands, add the test pattern that DERIVES the client tier's public
   module graph from the real source on disk (walk static + dynamic imports
   from the client page's `<script src>` entries) and asserts every reachable
   module is on the server's public allowlist AND that no class-S module is
   reachable. Reference: `src/assets.test.js` ("every module reachable from
   the /cure page is public (derived from the real import graph)") — added
   after the same breakage class shipped FOUR times. The corollary rule:
   `vault.js` (class S — it imports the server tier's storage stack) must
   never enter the `/cure` graph; public modules import the pure
   `vault-core.js` instead (found live 2026-07-11 when the whole client tier
   went dark).
6. **Establish the class-B module-graph pin.** Any bridged module's server
   endpoints live in a file whose imports are asserted against a closed
   allowlist, with data-bearing modules banned BY NAME — so "hand server data
   to a token call" is impossible by module graph, not just by review.
   Reference: `src/server-grants.test.js`'s SERVER-TOKEN-GUARANTEE pin (an
   import allowlist plus a banned list of `storage.js`, `vault.js`,
   `chatlog.js`, `accounts.js`, …; and the token module itself pinned to
   import ONLY the crypto-primitives leaf).
7. **Establish the class-X façade pin.** Every shared core lives as a pure,
   dependency-free, Node-import-safe module under the client tree (the
   browser can only import served modules; the worker bundler can import from
   anywhere — so the core goes where BOTH can reach it). The server file is a
   pure re-export, and a unit test asserts identity: `facade[name] ===
   core[name]` for every export — "re-exported, not re-implemented".
   Reference: `src/bash-agent.test.js` ("every façade export IS the core's
   implementation (same function object)"); the same pattern pins
   `introspect-tools.js` and `board.js` consumers.
8. **Write the generator gates** (or, hand-building, the review checklist):
   refuse any selection/change that puts a class-S import in a class-C graph,
   adds an unmetered tier crossing, or introduces model-driven control flow —
   there is no "just this once" flag.

## Reference implementation map

| Concept | Reference file(s) |
|---|---|
| The platform abstraction, classes, PA contracts | `sdk/DESIGN.md` §1–2 |
| The machine-readable module registry | `sdk/MANIFEST.json` |
| The load-bearing invariants as lived rules | `CLAUDE.md` ("Load-bearing invariants" 1–6) |
| The proven-decision rationale (what must not change) | `docs/ARCHITECTURE-ROADMAP.md` §1, §7–8 |
| The full system realization of the platform | `docs/ARCHITECTURE.md` §1–3, §9–10 |
| Naming/wordplay rules incl. secure-first, lowercase URLs, no internal acronyms | `CLAUDE.md` ("Branding rule"), `src/index.js` (the wordplay URL map comment) |
| Wordmark slash spacing (measured, not eyeballed) | `.claude/skills/slash-spacing/SKILL.md`, `scripts/slash-gap.mjs` |
| Class-C graph pin (derived import walk + allowlist) | `src/assets.test.js`, `src/assets.js` (`isPublicAsset`) |
| The vault.js-never-in-the-client-graph rule | `src/assets.js` (the vault-core comment), `public/js/vault-core.js` vs `public/js/vault.js` |
| Class-B graph pin (upstream-only guarantee) | `src/server-grants.test.js`, `src/server-token.js`, `docs/SERVER-TOKENS.md` |
| Class-X façade pattern + surface-IS-the-core pin | `public/js/bash-core.js` + `src/bash-agent.js` + `src/bash-agent.test.js`; `public/js/introspect-core.js` + `src/introspect-tools.js` |
| The client tier holding PA-1/2/3 client-side | `public/js/drc-research.js` (+ its test) |
| The bridge realized (grant families, meters, budget) | `src/server-grants.js`, `src/websearch.js`, `src/proxy.js`, `src/token-crypto.js` |

## Acceptance checklist

- [ ] The platform's DESIGN.md restates the tier definitions, the
      zero-or-one-server property, and PA-1..PA-10 by number; the manifest
      declares every module's class and deps.
- [ ] Every later module's skill/PR cites the PA contracts it touches by
      number (spot-check the first three modules landed).
- [ ] The derived client-tier module-graph test exists and fails `npm test`
      by name when an import is added without its allowlist entry — verify by
      temporarily adding an unlisted import.
- [ ] No class-S module is reachable from the client tier's entry page
      (asserted by the same walker, or a dedicated banned-list check).
- [ ] Every class-B endpoint module carries an import-allowlist test with
      data-bearing modules banned by name.
- [ ] Every class-X core is import-safe in Node (`node --test` passes with no
      DOM/Worker runtime) and its server façade has the same-function-object
      identity test.
- [ ] The naming rules are written down where sessions will see them
      (CLAUDE.md-equivalent), and a grep of user-facing copy finds no internal
      acronyms and no uppercase functional URLs.
- [ ] Both tiers' names appear client-tier-first everywhere they are paired
      (grep the docs and UI copy for the reversed order).

## Pitfalls

- **The client tier goes dark as a CLASS of bug.** Four separate reference
  incidents (2026-07-10, -11, -13, -15) shipped an import into the client
  tier's public module graph without its server allowlist entry: the module
  401s for unauthenticated visitors, the whole ES-module graph fails to link,
  and the tier is inert while the static HTML still paints. A hand-maintained
  allowlist cannot catch this by construction — only the derived-graph test
  does. Land the test BEFORE the graph grows.
- **A class-S import hiding one hop away.** The 2026-07-11 incident: the
  client core imported `vault.js` for one helper, and vault.js's static chain
  pulled the whole server-tier storage stack — dead client tier. The fix
  pattern is a split: extract the pure part (`vault-core.js`), keep the
  orchestration server-side, and document "import the core, never the
  orchestrator" AT the allowlist.
- **Hand-mirrored copies WILL drift.** PA-7 exists because the reference
  maintained mirrored server/client copies of the bash-agent logic with a
  parity test — and still converged on the façade re-export (2026-07-11)
  because a re-export cannot drift while a mirror merely *usually* doesn't.
- **The third name pair.** The reference briefly had brand names, slashed
  short names, AND internal acronyms in user copy; the 2026-07-12 directive
  banned the acronyms from anything user-facing. Two public names per tier
  maximum: full form and slashed short form.
- **CamelCase in a functional URL.** The display convention leaked into an
  `href` more than once; hosts forgive it, paths don't. Grep for the
  CamelCase form in `href`/`fetch` strings during review.
- **Bold changes the slash.** The wordmark's slash-tightening margin was
  tuned for regular weight; in bold the ink touches. Any new surface
  rendering the wordmark gets its gap measured (`scripts/slash-gap.mjs`),
  with a scoped override — never a copy-pasted constant.
- **"Just this once" is how the story collapses.** Every pressure to let the
  client tier quietly call an authenticated server endpoint, or to let a
  model pick the control flow "only for this feature", is the same pressure
  the contracts exist to resist. The sanctioned answers are: a class-B grant
  (disclosed, metered, revocable) or a scoped, gated PA-1 exception with the
  deterministic fallback intact.
