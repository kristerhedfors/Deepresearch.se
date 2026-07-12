# Security Risk Register — deepresearch.se

**This is a LIVING document** — unlike `SECURITY-ASSESSMENT.md` (a point-in-time
source review, 2026-07-08), this file is maintained continuously. It tracks the
risks inherent in this project's core exposure — **the exact source code of the
live production system is published on the web** (public GitHub repo, MIT
licensed, git-connected auto-deploy from `main`) — plus every known-but-not-yet-
implemented security fix, in priority order.

## Maintenance rules

1. **The register is the single source of truth for open security work.** The
   old assessment's still-open findings are imported below (keeping their
   M-*/L-* ids); new findings get `R-<n>` ids. Don't re-open tracking in other
   files.
2. **When an item is fixed:** change its status to `✅ FIXED (YYYY-MM-DD)`, add
   one line describing the fix (file + mechanism), append a dated entry to the
   History log (§4), and move on to the next-highest open item. Fixed items
   stay in the list — the register doubles as the audit trail.
3. **Statuses:** `🔴 OPEN` (needs a fix), `🟡 PARTIAL` (mitigated, residual
   risk), `🟠 ACCEPTED` (conscious product decision — record who/when/why),
   `🔁 OPERATIONAL` (not a code fix; a recurring runbook duty), `✅ FIXED`.
4. **Priority order is the order of §3.** Re-sort when the landscape changes;
   log re-prioritisations in the History log.
5. **Verification:** the **security-posture** skill
   (`.claude/skills/security-posture/SKILL.md`) holds the concrete re-check
   procedure for every item here. Run it whenever this file is updated, after
   any auth/storage/headers change, and periodically. Keep skill and register
   in sync — a new risk here needs a check there.
6. **The admin review board mirrors §3.** `src/security-risks.js` carries a
   code catalog of the P-items (id/title/severity/status/summary) that the
   admin panel renders (`/admin` → Security risks) and the fix loop orders by
   (`/api/admin/security?format=text`, `scripts/security`). Any §3 edit —
   new item, status change, reworded summary — updates that catalog **in the
   same commit**. The admin's votes/scores/notes/priorities live in D1
   (`security_reviews`), keyed by these ids, so ids are stable forever: a
   fixed item keeps its id (rule 2), and new items take the next free P-n.
7. **The admin's explicit priority is the FIX ORDER.** When the admin has
   prioritized items on the board, the security-fix loop works through them
   in that order — it overrides this file's §3 default order. Unprioritized
   items follow by admin votes, then documented severity, then §3 order.
   Before starting a fix round, ALWAYS read the board
   (`scripts/security`); §3's order is only the default when the board is
   silent.
6. **This file is itself public** — see R-3. Write entries so they describe the
   risk and the fix without handing over a working exploit (no PoC payloads,
   no live identifiers beyond what the source already shows).

---

## 1. Threat model: what "exact source is public" changes

Publishing the exact running source is a deliberate transparency choice — it is
what lets DRC ("deep research secure") users *verify* the no-server-data-path
claim instead of trusting it. The register exists to make the costs of that
choice explicit and managed:

- **Zero security-by-obscurity.** Every route, gate, validation rule, quota
  window, cookie format, prompt, and cache-key scheme is attacker-readable.
  Anything that is only safe while unknown is *already broken*. Design rule:
  every control must hold with the source in the attacker's other hand —
  secrets in the environment are the ONLY private input.
- **One-commit-to-compromise.** A single accidentally committed credential is
  published instantly, permanently (git history), and auto-deployed. Secret
  hygiene is therefore the top risk class (§3, R-1).
- **Precision targeting.** Attackers don't probe — they read. Known
  weaknesses (a quota race, a missing header, an un-hardened prompt phase) go
  from "needs discovery" to "documented with file:line". This raises the
  effective severity of everything left open, including the findings this very
  file lists.
- **The two tiers differ structurally.** The server tier (DRS, `/rver`) holds
  real data server-side — plaintext `chat_logs` in D1, R2 objects, Workers
  Logs — so server-bound data leakage is a real class (R-5). The client tier
  (DRC, `/cure`) has no server data path at all (browser → provider direct,
  browser-local sealed storage), so whole leak classes are structurally absent
  there; its residual risks are client-side (R-8).
- **Trust chain = GitHub account.** Push-to-`main` auto-deploys to production.
  Whoever controls the repo controls the site (R-9).

---

## 2. The risk catalog — typical issues inherent to a public-source deployment

Each entry: what the issue consists of, how it applies here, and the standing
mitigation posture. These are *risk classes* to hold the line on; concrete
open fixes live in §3.

### R-1 · Loss of API keys / secret leakage into the public repo — **the top risk**

**What it is.** Any credential that touches the repo — a committed `.dev.vars`,
a key pasted into a doc, a token in a test fixture, an eval-ledger excerpt, a
debug log snippet — is published to the world the moment it is pushed, and
remains recoverable from git history even after deletion. With auto-deploy,
compromise and publication are simultaneous.

**Secrets in scope** (all live ONLY as Cloudflare dashboard secrets, never in
the repo): `BERGET_API_TOKEN`, `EXA_API_KEY`, `ANTHROPIC_API_KEY`,
`OPENAI_API_KEY`, `SHODAN_API_KEY`, `GOOGLE_MAPS_API_KEY`,
`GOOGLE_MAPS_EMBED_KEY`, `GOOGLE_CLIENT_SECRET`, `SESSION_SECRET`,
`HISTORY_KEY_SECRET`, `ADMIN_USER`/`ADMIN_PASS` (+ legacy
`BASIC_AUTH_USER`/`BASIC_AUTH_PASS`), `HUGGINGFACE_API_TOKEN`, `ADMIN_EMAIL`
(not a secret but deliberately kept out of the repo). Locally: `.dev.vars`,
`.env`, and the e2e suite's env-var credentials.

**Current posture:** 🟡 sound but convention-enforced.
- ✅ Verified 2026-07-12: no credential patterns in the working tree or the
  fetched git history (see the skill for the scan; note session clones are
  SHALLOW — a full-history scan needs an unshallowed clone or GitHub secret
  scanning).
- ✅ `.gitignore` covers `.dev.vars`, `.env`; no such files exist in the tree.
- ✅ All server code reads keys via `env.*` only; keys ride in
  headers/query-strings that are never logged (assessment §3 "secrets
  hygiene", re-confirmed).
- ⚠️ Nothing *mechanically* blocks a future leak: no pre-push secret scan, and
  GitHub push protection / secret scanning status is unverified (R-1a below).
- ⚠️ The agentic debugging workflows (chatlogs pulls, feedback queue, eval
  ledgers) routinely move LIVE data toward the repo — a pasted excerpt could
  carry a user-typed key or PII (R-6).

**Standing mitigations (the "keys capped" rule):** every provider key must be
**capped at the provider** so a leaked key is a bounded incident, not an open
wallet — this is the FIRST line of §3 and a recurring operational duty (R-1b):
spend/rate caps on Berget, OpenAI (hard monthly limit), Anthropic (workspace
spend cap), Exa; Shodan is credit-bounded by plan; Google Maps keys
API-restricted + quota-capped, and the browser-exposed Embed key
HTTP-referrer-locked to `*.deepresearch.se/*` (this lock is the load-bearing
mitigation for its deliberate exposure). Plus: rotation runbook — on any
suspected leak, rotate in the dashboard first, then clean history; never the
reverse order.

### R-2 · Exact attack-surface map / no security-by-obscurity

**What it is.** The attacker reads `index.js` routing, every gate order
(identity → approval → terms), every validation regex, the quota windows, the
cookie wire format (`u.<uid>.<exp>.<hmac>`), the admin API paths, the
break-glass Basic Auth mechanism, and the edge-cache key scheme. Anything
reachable-but-unhardened is found by reading, not scanning.

**How it applies here:** the design already assumes this (fail-closed gates,
server-derived ids everywhere, parameterised SQL, HMAC bounded only by
`SESSION_SECRET` entropy since the H-3 fix). The residual exposure is that
**publicly documented open findings become instructions** — which is why §3
items get fixed in priority order rather than accumulating.
**Posture:** 🟡 by-design; held by keeping §3 short and the entropy of
`SESSION_SECRET`/`ADMIN_PASS` high (R-1b).

### R-3 · The security docs themselves are published

**What it is.** `SECURITY-ASSESSMENT.md`, this register, skill files, and
`CLAUDE.md` describe weaknesses, incident history, and operational details in
attacker-readable form. A public register is a targeting guide for whatever it
lists as open.

**How it applies here:** conscious transparency trade-off — the same
publication is what makes the privacy claims verifiable, and hidden registers
rot. Managed by: fix-promptly discipline (§3), the no-PoC writing rule
(maintenance rule 6), and never recording live identifiers, real user content,
or operational secrets in any committed doc.
**Posture:** 🟠 ACCEPTED (2026-07-12, product decision inherent in the public
repo) with the writing rules above as guardrails.

### R-4 · Infrastructure identifiers in the repo

**What it is.** `wrangler.toml` publishes the Worker name, custom domains, D1
`database_id`, R2 bucket and Vectorize index names, plan details, and CPU
limits. None grant access by themselves (all require an API token /dashboard
session), but they hand an attacker exact resource names for social
engineering against the Cloudflare account, and they make any future
token/dashboard compromise instantly actionable.

**How it applies here:** unavoidable for a git-connected deploy (wrangler needs
the config in-repo). **Posture:** 🟠 ACCEPTED — compensate at the account:
Cloudflare 2FA, least-privilege API tokens (the deploy token already cannot
edit routes — see the **deploy** skill), and treating the Cloudflare account +
GitHub account as the real security boundary (R-9).

### R-5 · Server-bound data leakage (DRS tier)

**What it is.** Whatever the server can read, a server-side compromise (or the
operator, or a subpoena) can read — and the public source tells an attacker
*exactly* what is readable and where: plaintext `chat_logs` in D1 (every
non-incognito Q&A, append-only, not user-deletable — M-3), R2 ciphertext
alongside server-held derivation secrets (`HISTORY_KEY_SECRET` — a compromise
recovering it can decrypt cloud history, documented in `src/history-key.js`),
readable RAG-indexed material and project chats, and Workers Logs (currently
`LOG_LEVEL=debug` in production — R-7).

**How it applies here:** this is the documented privacy split — the DRS tier
accepts these exposures for its features; DRC exists precisely because they
are structural. The gap between the *claimed* and *actual* exposure is the
risk (M-3's help-page accuracy point, M-4's unenforced ciphertext invariant).
**Posture:** 🟡 PARTIAL — the split is real and documented, but M-3/M-4 (§3)
keep the server-side exposure larger than the docs imply.

### R-6 · Live user data leaking INTO the public repo

**What it is.** A public repo plus debugging workflows that handle production
data (chatlogs keyword searches, feedback threads, eval ledgers, bug-repro
"verbatim message as a regression test" conventions) creates a standing path
for real user content — questions, names, locations, even pasted user API
keys — to end up committed and published.

**How it applies here:** `bugreport-bugfix` explicitly encourages committing
the verbatim logged message as a test; ledgers append live-run outputs.
**Posture:** 🔁 OPERATIONAL — before committing anything derived from live
traffic: scrub identities/PII, never commit a full chatlog row, and check
excerpts for credential-shaped strings. (Added to the security-posture skill's
pre-commit checklist.)

### R-7 · Log verbosity is public knowledge

**What it is.** The source shows exactly what gets logged at each level.
`LOG_LEVEL=debug` is currently set in production (`wrangler.toml`, 2026-07-12,
"temporarily for sandbox-filesystem testing") — attackers know debug logging
is on, and debug paths log more request detail into Workers Logs (a
server-side data pool per R-5).

**Posture:** 🔴 OPEN as a standing item: revert to `info` when the sandbox
testing round ends (the file already says so); the register tracks it so
"temporarily" terminates. Generally: never log secrets/full conversations at
any level (currently holds), and treat log-level bumps as privacy changes.

### R-8 · Client-tier risks: key harvesting, clones, and browser storage (DRC)

**What it is.** DRC's structural strength (server in no data path) moves the
valuable secrets into the browser: user provider API keys live INSIDE the
sealed state in `localStorage`, unlocked by a user-held master secret. Public
source makes it trivial to build a pixel-perfect phishing clone of `/cure`
that harvests keys/master secrets, and documents exactly where in browser
storage the sealed blobs live (XSS on the real origin = sealed-state access
while unlocked).

**How it applies here:** origin is the trust anchor — users must check the
domain; the DRS-side XSS posture (DOMPurify + the still-OFF CSP, H-2
follow-up) is shared by `/cure`, so the CSP flip protects BOTH tiers' stored
secrets. Keys-inside-ciphertext-at-rest is verified by unit tests
(`drc-core`). **Posture:** 🟡 PARTIAL — sealed-at-rest holds; the CSP flip
(§3 P-4) is the missing second layer; domain-phishing is un-mitigatable in
code (🟠 ACCEPTED, standard for any web app).

### R-9 · Repo/deploy trust chain — push-to-main is push-to-production

**What it is.** Git-connected auto-deploy means the GitHub account, its
sessions/PATs, and anything with push rights (including CI agents and Claude
Code sessions like this one) are production-deploy credentials. Public repos
also invite malicious PRs; with no build step and no runtime deps the
classic supply-chain vectors are narrow, but vendored libs (`public/vendor/`)
are hand-updated with no integrity manifest (L-12).

**Posture:** 🔁 OPERATIONAL — GitHub 2FA, no long-lived broad PATs, review
anything that touches `public/vendor/` byte-for-byte, and the L-12 fix (§3)
adds the version+SHA-256 manifest so tampering is detectable.

### R-10 · Known-version vulnerability matching

**What it is.** Public source pins exact versions of everything —
vendored `marked`/`DOMPurify`, the CheerpX sandbox engine, compatibility
dates — so a disclosed CVE in any of them is immediately mappable to this
site by anyone.

**Posture:** 🔁 OPERATIONAL — periodic (monthly, and on any DOMPurify CVE
news) check of vendored-lib versions against upstream advisories; the L-12
manifest makes "what version are we on" a one-file answer. DOMPurify matters
most: until the CSP is on it is the sole XSS defence (H-2 follow-up).

---

## 3. Open fixes — priority-ordered backlog

Work top-down — but check the **admin review board first** (`scripts/security`
or `/admin` → Security risks): an admin-set priority there overrides this
default order (maintenance rule 7). Each entry: full description →
recommendation → status. Severity inputs: exploitability with public source,
blast radius, and whether it guards the top asset classes (secrets > user
privacy > spend).

### P-1 · Provider-side caps on every API key — 🔁 OPERATIONAL (verify + record) 
**The "all API keys capped" rule (top of the list by explicit product
decision, 2026-07-12).** The issue: a leaked or abused key (via R-1, or via
quota-race/rate-limit gaps M-1/M-2) is unbounded spend unless the PROVIDER
enforces a ceiling — in-app quota code cannot cap a key used from outside the
app. What to do: in each provider console set/verify hard caps — Berget
(spend limit), OpenAI (monthly hard limit), Anthropic (workspace spend cap),
Exa (plan/credit cap), Google Cloud (per-key API restrictions + daily quota
caps + billing alerts; Embed key referrer-locked to `*.deepresearch.se/*`),
Shodan (plan credits). Record the cap values and verification date in the
History log (values themselves are fine to publish — they are ceilings, not
credentials). Re-verify quarterly and after adding any provider.
**Status: 🔴 OPEN — caps unverified from this repo; needs a dashboard pass.**

### P-2 · Mechanical secret-leak prevention on the repo — 🟡 PARTIAL (2026-07-12)
The issue (R-1): nothing but convention stops a secret reaching a public
commit; detection was manual greps. Progress:
- ✅ (b) **Local mechanical scan shipped.** `scripts/scan-secrets` runs the
  credential-pattern set from the security-posture skill §1 (worktree /
  `--staged` / `--range A..B` modes, redacted matches, rotation runbook on
  fail), a `.githooks/pre-push` hook runs it over outgoing commits and blocks
  a push on a match, and `scripts/install-git-hooks` activates it in a clone
  (`git config core.hooksPath .githooks`). Verified: flags a planted fake
  credential, passes the real working tree clean, and does not self-match.
  Documented in `docs/SECRET-SCANNING.md`. Note the hook is repo-local and
  bypassable (`--no-verify`) — it is a fast first line, not the backstop.
- 🔴 (a) **GitHub secret scanning + push protection** — still to enable in the
  repo Settings → Code security (free for public repos; the server-side
  backstop that catches a push even without the local hook). Dashboard action,
  not code.
- 🔴 (c) **Full-history scan from an unshallowed clone** — still owed; session
  clones are shallow (`--range`/history scans cover only fetched commits), so
  a full-history verdict needs `git fetch --unshallow` first (or relies on
  (a)). Record the result here when run.

Rotation runbook if anything is ever found: rotate at the provider FIRST,
then rewrite history, then log the incident here.

### P-3 · M-1 + M-2 · Quota race + no rate limiting on expensive endpoints — 🟡 PARTIAL (2026-07-12)
A per-user **concurrent-request cap** now bounds the check-then-act race: a
small D1-backed reservation (`inflight` table; `reserveInflight`/
`releaseInflight` in `src/quota.js`, `INFLIGHT_CAP = 5`, `INFLIGHT_TTL_MS =
300 s`) is taken at admission — after the quota gate — and released in a
`finally` on every exit path (success, error, client disconnect via
`ctx.waitUntil`) on `/api/chat`, `/api/embed`, `/api/quiz/grade`, and
`/api/bash/step`. A refused reservation returns 429 (`inflightLimitResponse`,
no cost figures). This caps the ≈N× overspend at ≈`CAP`× per user, which —
**combined with the P-1 provider caps** — closes the spend-abuse class. The
gate is FAIL-SOFT (invariant 2): any D1 error fails open, never blocking a
user. Unit-tested against an in-memory D1 mock (`src/quota.test.js`, 35
tests: cap saturation, per-user isolation, release, TTL sweep, no-DB and
throwing-DB fail-open). **Residual (why PARTIAL, not FIXED):** the concurrency
cap bounds a burst but is not a true spend RESERVATION (a request's cost is
still recorded only on completion), and the true simultaneous-isolate race +
the disconnect-release lifecycle only reproduce in production — owed a
live-verify pass (see the **live-verify** skill). A stricter fix (reserve
estimated spend at admission, reconcile on completion) and/or Cloudflare
rate-limiting rules remain available if the cap proves insufficient.

### P-4 · H-2 follow-up · Flip the CSP on — 🔴 OPEN
The CSP is fully authored in `src/index.js` but `CSP_ENABLED = false`
(re-verified 2026-07-12). Until flipped, one DOMPurify bypass (or a tampered
vendored lib) is full session-context XSS — reaching IndexedDB (history key,
plaintext project chats) on DRS and the sealed-state/localStorage surface on
DRC (R-8). It is the single highest-leverage defence-in-depth item.
Recommendation: re-verify the two inline-script hashes + Maps/sandbox (COEP)
origins, flip the flag, watch a live page's console across app + Street View
+ sandbox flows. The integration surface was the stated reason to wait; the
sandbox work enlarging that surface is a reason to do it deliberately, not to
wait forever — set a review date each time this is deferred.

### P-5 · M-3 · Plaintext `chat_logs`: retention, drain, accurate copy — 🔴 OPEN
Imported. Every non-incognito exchange rests as PLAINTEXT in D1, append-only,
excluded from `DELETE /api/storage`, no deletion endpoint, no TTL
(re-verified 2026-07-12: `chat_logs` absent from the drain). The dominant
server-side privacy exposure (R-5), and public source documents it exactly.
Recommendation (any subset helps): (a) include `chat_logs` in the user drain;
(b) retention TTL (e.g. scheduled prune of rows older than N days);
(c) encrypt Q&A/meta columns at rest; (d) make `/help/` state the true
exposure plainly. The 2026-07-08 product decision wants full-visibility logs —
(a)+(b)+(d) preserve that utility while bounding the exposure window.

### P-6 · M-4 · Server accepts plaintext for the `convos` family — 🔴 OPEN
Imported; re-verified 2026-07-12 (`putEncRecord` still accepts `{data}` for
both families). The ciphertext-at-rest invariant for conversations is
client-enforced only: a client bug or XSS can silently persist readable
conversations in R2. Recommendation: reject `{data}` records for `convos`
server-side; allow plaintext only where the server can confirm
project/RAG membership.

### P-7 · M-6 · Anti-injection note missing on gap + validate prompts — 🔴 OPEN
Imported; re-verified 2026-07-12: `gapPrompt` and `validatePrompt` still lack
`ANTI_INJECTION_NOTE` while every other untrusted-content phase has it — and
the exact prompt text being public means injections can be crafted offline
against these two phases specifically (R-2). Blast radius: degraded research
integrity only (fail-soft phases, no secrets in prompts). Recommendation:
append the note to both builders; consider delimiter-wrapping untrusted spans.
Cheap fix — bundle with any prompts.js touch.

### P-8 · M-5 · Two unbounded outbound fetches — ✅ FIXED (2026-07-12)
Both hot-path fetches are now time-bounded: `exa.js` `webSearch` gained
`signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS)` (15 s) and `berget.js`
`fetchCatalog` gained `signal: AbortSignal.timeout(CATALOG_TIMEOUT_MS)`
(15 s) — a `TimeoutError` now lands in each function's pre-existing fail-soft
catch (a `failure()` digest string for search, a `null`/degraded catalog for
Berget), so a hung backend degrades instead of hanging, satisfying invariant
2. The values sit within the existing Berget/Exa bounds (connect 30 s, JSON
45 s, contents 20 s, embed 60 s). Verified: `src/exa.test.js` + `src/berget.test.js`.

### P-9 · Low-severity backlog (imported L-1 … L-12) — 🔴 OPEN
Re-verified still open 2026-07-12 unless noted. In rough order:
- **L-1** `activity.js:603` — validate scheme (`https?:` only) before
  `a.href = src.url` (in-origin `javascript:` executor if a search provider
  ever returns one; amplified while CSP is off).
- **L-2** `rag.js` — add post-query `metadata.u === uid` assertion behind the
  Vectorize filter (cross-user leak if the index filter ever fails open).
- **L-3** `/api/history-key` — add `Cache-Control: no-store` (key material
  must never be cacheable; re-verified: plain `jsonResponse`, no header).
- **L-4** stored-file responses — `Content-Disposition: attachment` (the
  global `nosniff` from the H-2 fix already covers the sniffing half).
- **L-5/L-6** OAuth hardening — timestamp bound into `state`; optional
  `id_token` JWKS verification / `nonce`.
- **L-7–L-11** Shodan resolved-IP re-check; Maps image byte cap;
  `encodeURIComponent` on lat/lon; thumbnail escaping; gate admin assets.
- **L-12** aggregate request-size cap + **vendored-lib version/SHA-256
  manifest** (elevated by R-9/R-10 — do the manifest half first).

### P-10 · R-7 · Revert production `LOG_LEVEL` to `info` — 🔴 OPEN
Time-boxed exception (2026-07-12, sandbox-filesystem testing). Revert in
`wrangler.toml` when that testing round completes; this register entry exists
so the exception terminates.

---

## 4. History log (append-only)

| Date | Event |
|---|---|
| 2026-07-08 | `SECURITY-ASSESSMENT.md` produced (six-domain manual review: 3 High, 6 Medium, 12 Low). H-1 (`/mcp` quota bypass), H-2 (security headers; CSP authored but held OFF), H-3 (session-HMAC fallback removed, `SESSION_SECRET` required) all **fixed same day**. |
| 2026-07-12 | **This register created** (product decision: continuously maintain public-source risk list + priority-ordered fix backlog + this log in one file). Companion **security-posture** verification skill added (`.claude/skills/security-posture/`). Re-verified against source: M-1–M-6 and L-1–L-12 all still open (CSP still off; `webSearch`/`fetchCatalog` still unbounded; `chat_logs` still outside the drain; gap/validate prompts still lack the anti-injection note; history-key response still cacheable). Secret scan over the working tree + fetched (shallow) git history: **clean**. New items opened: P-1 (provider-side key caps — top priority), P-2 (push protection + full-history scan), P-10/R-7 (`LOG_LEVEL=debug` in prod, time-boxed). New risk classes recorded for surfaces added since the assessment: `/api/bash/step` in the P-3 rate-limit scope, DRC key storage (R-8), sandbox COEP origins in the P-4 CSP checklist. |
| 2026-07-12 | **Admin review board added** (product decision): the §3 backlog gets an interactive admin-panel view (`/admin` → Security risks; `src/security-risks.js`, D1 `security_reviews`, `/api/admin/security*`, `scripts/security`) with up/down votes, a manual severity-score field (CVSS or free-form), notes, and an explicit per-item **priority that is the fix loop's fixed order** (maintenance rules 6–7 added). Two orderings: admin fix order ⇄ documented severity. |
| 2026-07-12 | **Security-fix round (admin-prioritized top items) — P-8 FIXED.** `exa.js` `webSearch` + `berget.js` `fetchCatalog` now use `AbortSignal.timeout` (15 s), degrading fail-soft on a hung backend (invariant 2). First of the round working down the admin board's fix order (`scripts/security`); P-1/P-2/P-3 addressed in the same round's following commits. |
| 2026-07-12 | **P-3 → PARTIAL.** Per-user concurrent-request cap added (D1 `inflight` table; `reserveInflight`/`releaseInflight` in `src/quota.js`, `CAP=5`, `TTL=300 s`, fail-soft) — reserved at admission, released in a `finally` on every exit path (incl. client disconnect via `ctx.waitUntil`) on `/api/chat`, `/api/embed`, `/api/quiz/grade`, `/api/bash/step`; 429 on refusal. Bounds the ≈N× overspend race at ≈`CAP`× per user (closes the spend-abuse class with the P-1 caps). 35 unit tests over an in-memory D1 mock. Residual: not a true spend reservation; simultaneous-isolate + disconnect-release paths owed a live-verify pass. |
| 2026-07-12 | **P-2 → PARTIAL.** Local mechanical secret-leak prevention shipped: `scripts/scan-secrets` (worktree/`--staged`/`--range` modes, redacted matches, the security-posture §1 pattern set), a `.githooks/pre-push` hook that blocks a push on a credential match, `scripts/install-git-hooks`, and `docs/SECRET-SCANNING.md`. Verified: flags a planted fake credential, passes the real tree clean, no self-match. Residual (both operational, not code): (a) enable GitHub secret scanning + push protection in repo Settings; (c) run a full-history scan from an unshallowed clone. |
