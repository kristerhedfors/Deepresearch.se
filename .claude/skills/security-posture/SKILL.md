---
name: security-posture
description: >-
  Load when verifying or updating the project's security posture — "check
  security", "any leaked keys?", "is finding X still open?", auditing the
  public-source risk list, before/after touching auth (src/auth.js), headers
  (src/security-headers.js applySecurityHeaders/CSP), storage privacy, quota/rate limiting, or
  prompts that read untrusted web content — and WHENEVER SECURITY-RISKS.md is
  edited. Companion to SECURITY-RISKS.md (the living risk register): this
  skill holds the concrete re-check procedure for every register item — the
  secret-leak scans (working tree + git history, incl. the shallow-clone
  caveat), header/CSP probes, per-finding greps (M-1…M-6, L-1…L-12), the
  provider key-cap checklist, and the commit-time rules that keep live user
  data and credentials out of the public repo. ALSO load when running a
  security-FIX round or touching the admin review board
  (src/security-risks.js, /api/admin/security, scripts/security, the admin
  panel's Security risks view): the board's admin-set priority is the FIXED
  work order for fix rounds, and the code catalog must mirror the register's
  §3 in the same commit.
---

# Security posture verification

The register (`SECURITY-RISKS.md` at the repo root) is the source of truth for
open security work; this skill is HOW to verify each item. Rules of the loop:

- **Run the relevant section before AND after touching security-adjacent code**
  (auth, headers, storage, quota, prompts, providers).
- **When a check's result changes** (an item got fixed, or regressed), update
  the register: status tag, one-line fix description, dated History-log entry.
- **When adding a register risk, add its check here** in the same change.
- Everything here is read-only verification — safe to run any time. Findings
  are verified against SOURCE first; live probes confirm deploys, not truth.

## 0. Fix rounds start at the admin review board

The register's §3 backlog has an interactive admin surface: `/admin` →
**Security risks** (`src/security-risks.js`, D1 `security_reviews`,
`/api/admin/security*`). The admin votes items up/down, attaches a manual
severity score (e.g. a CVSS vector) and notes, and can set an explicit
per-item **priority — the FIXED order a security-fix round works through**,
overriding the register's default §3 order. Unprioritized items follow by
votes, then documented severity, then register order; fixed/accepted items
sink to the bottom.

Before starting a fix round, read the board's fix order (break-glass creds,
same env vars as scripts/chatlogs):

```bash
scripts/boards              # discover EVERY fetchable board first (security is one)
scripts/security            # the work order, readable text (?format=text)
scripts/security --json     # full JSON (also: --severity for the other view)
scripts/security --vote P-3 up
scripts/security --set P-3 '{"priority":1,"score":"CVSS 6.5","note":"…"}'
```

`scripts/boards` (the `src/admin-boards.js` discovery index —
`GET /api/admin/boards`) is the one-call entry point that lists every
admin board and its fetch line; the security board is one of them. For a
large round, fan out one sub-agent per top-of-board item **in the admin's
fixed priority order**, each on disjoint files, and integrate the
catalog/register status flips yourself (see the **decision-boards** skill's
"parallelize on the user's priority order" workflow).

Work top-down through the numbered open items. When an item is fixed, in the
SAME commit: flip its `status` in the `SECURITY_RISK_ITEMS` catalog
(`src/security-risks.js`), tag it `✅ FIXED` in the register §3, and append a
History-log entry (register rules 2 and 6). **The catalog is a code mirror of
§3** — item ids are stable forever (D1 review state is keyed by them); new
register items take the next free P-n and a catalog entry in the same change.
`src/security-risks.test.js` pins catalog shape and the ordering semantics.

## 1. Secret-leak scan (R-1 / P-2) — run before every push touching docs/tests/config

**Now packaged as `scripts/scan-secrets`** (P-2, FIXED 2026-07-15): it runs
this exact pattern set over the working tree (default), the staged diff
(`--staged`), or a commit range (`--range A..B`), redacts matches, and prints
the rotation runbook on a hit. TWO hooks gate history: `.githooks/pre-commit`
runs it over the staged diff and BLOCKS a commit on a match (the secret never
enters history), and `.githooks/pre-push` runs it over outgoing commits and
BLOCKS the push (the second line, for commits made while hooks were
inactive). Hooks are activated by `scripts/install-git-hooks` (sets
`core.hooksPath`) — run AUTOMATICALLY per session clone by the SessionStart
hook in `.claude/settings.json`, so in a remote session they are already
live. Both are bypassable (`--no-verify`) for verified false positives;
GitHub secret scanning + push protection (default-on for public repos) is the
server-side backstop. The one-time FULL-history scan was run 2026-07-15 from
an unshallowed clone (791 commits): **clean**. A future full-history re-scan
still needs `git fetch --unshallow` first (the shallow-clone caveat below).
See `docs/SECRET-SCANNING.md`.

The raw scan (what `scripts/scan-secrets` automates) — working tree + fetched
history, one command (from repo root):

```bash
git log --all -p --unified=0 | grep -aoE \
  "(sk-[A-Za-z0-9_-]{24,}|sk_ber_[A-Za-z0-9_-]{8,}|gsk_[A-Za-z0-9]{16,}|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AIza[0-9A-Za-z_-]{35}|xox[bpoas]-[A-Za-z0-9-]{10,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)" \
  | sort -u
```

Empty output = clean. Also grep the WORKING TREE with the same pattern set
(catches not-yet-committed files), and check `ls .dev.vars* .env*` finds
nothing outside `.gitignore` (which must keep covering `.dev.vars` and `.env`).

**Shallow-clone caveat (learned 2026-07-12):** remote-session clones are
shallow (`git rev-parse --is-shallow-repository` → `true`), so the history
scan only covers fetched commits. A FULL-history verdict needs
`git fetch --unshallow` first, or GitHub's secret scanning on the server side.
Key patterns: OpenAI `sk-`, Berget `sk_ber_`, Groq `gsk_`, Anthropic is also
`sk-`-prefixed (`sk-ant-`), AWS `AKIA`, GitHub `ghp_`/`github_pat_`, Google
`AIza`, Slack `xox*`, PEM blocks. Extend the pattern when a new provider joins
(`add-llm-provider` skill).

**If a secret is EVER found:** rotate at the provider FIRST (the repo is
public — assume compromised the moment it was pushed), then rewrite history,
then log the incident in the register's History log.

## 2. Commit-time hygiene (R-6) — when committing anything derived from live traffic

Chatlog excerpts, feedback threads, eval-ledger entries, verbatim-message
regression tests (the `bugreport-bugfix` convention): before committing,
(a) scrub names/emails/locations that identify a user, (b) never commit a full
chatlog row, (c) run the §1 tree grep over the staged diff — users paste keys
into chats. The repo is public; a committed excerpt is published.

## 3. Provider key caps (P-1) — quarterly + on any new provider

Not verifiable from the repo — needs a dashboard pass per provider: Berget
spend limit, OpenAI monthly hard limit, Anthropic workspace spend cap, Exa
plan/credits, Google Cloud (per-key API restriction + quota caps + billing
alert; the Embed key MUST be referrer-locked to `*.deepresearch.se/*` — it is
deliberately browser-exposed and the lock is its only mitigation), Shodan plan
credits. Record cap values + date in the register's History log.

## 4. Headers & CSP (H-2 follow-up / P-4)

Source: `src/security-headers.js` — `CSP_ENABLED` flag (currently `false`) and
the always-on header set applied by `applySecurityHeaders` (nosniff, `X-Frame-Options: DENY`,
Referrer-Policy, HSTS, COOP, Permissions-Policy). Live probe:

```bash
curl -sI https://deepresearch.se/ | grep -iE \
  "content-security|x-content-type|x-frame|referrer-policy|strict-transport|permissions-policy"
```

All five non-CSP headers must be present on EVERY response class (HTML, JSON
`/api/*`, assets, SSE). When flipping `CSP_ENABLED`: re-verify the two
inline-script hashes, the Maps origins, AND the sandbox's COEP/cross-origin
needs (`execution-sandbox` skill), then watch a live console through app +
Street View + sandbox flows.

## 5. Register-item greps (imported findings) — each must stay/turn as tagged

| Item | Check (repo root) | OPEN looks like |
|---|---|---|
| M-1/M-2 concurrency cap (P-3, PARTIAL) | `grep -n "reserveInflight\|releaseInflight" src/chat.js src/quiz-api.js src/rag.js src/bash-api.js src/quota.js` | REGRESSED if the reserve/finally-release pair is gone from any endpoint; still-open residual = no true spend reservation (cap only), live-verify owed |
| M-3 chat_logs drain | `grep -n "chat_logs" src/storage.js src/chatlog.js` | absent from `handleStorageDelete`; no TTL/prune |
| M-4 plaintext convos | `grep -n "iv, ciphertext.*data\|{data" src/storage.js` | `putEncRecord` accepts `{data}` for convos |
| M-5 unbounded fetches | `grep -n "AbortSignal" src/exa.js src/berget.js` | `webSearch` + `fetchCatalog` have none |
| M-6 anti-injection | `grep -n "ANTI_INJECTION" src/prompts.js` then eyeball `gapPrompt`/`validatePrompt` tails | those two builders lack the note |
| L-1 href scheme | `grep -n "a.href = src.url" public/js/activity.js` | assignment with no scheme check |
| L-2 RAG post-filter | `grep -n "metadata" src/rag.js` around the query | no `m.metadata.u === uid` assertion |
| L-3 key cacheable | `grep -n -A3 "handleHistoryKey" src/user-api.js` | plain `jsonResponse`, no `no-store` |
| L-12 vendor manifest | `ls public/vendor/` | no version/SHA-256 manifest file |
| H-3 stays fixed | `node --test src/auth.test.js` | (regression) any fallback key reappearing |
| R-7 log level | `grep -n "LOG_LEVEL" wrangler.toml` | `debug` in prod past its testing window |

Full status history + remediation detail: the register §3 and
`SECURITY-ASSESSMENT.md` §2.

## 6. Invariants that must never regress (assessment §3 "verified sound")

Spot-check when touching the area: secrets only via `env.*` (never logged,
never in prompts); storage/RAG/answer keys scoped to SERVER-derived
`identity.user.id` with regex-validated ids; SQL always parameterised; no
Worker fetch of user/model-controlled URLs (SSRF); outbound minimum-data rule
(query/coordinate/host only); DOMPurify on every untrusted-HTML sink; OAuth
state CSRF cookie; fail-closed Basic Auth + `SESSION_SECRET`-only cookie HMAC;
DRC keys never at rest outside the sealed blob (`drc-core` tests pin this).
The unit suite (`npm test`) carries regression tests for most of these — a
security-relevant change without an accompanying test is a register entry.
