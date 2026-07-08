# Security Assessment — deepresearch.se

**Date:** 2026-07-08
**Scope:** the Cloudflare Worker application in this repository — `src/` (server),
`public/` (client), `wrangler.toml`, and vendored assets.
**Method:** manual source review across six domains (authentication & access
control; the `/api/chat` + `/mcp` pipeline and prompt injection; storage,
cryptography & the privacy model; external integrations & SSRF; client-side
XSS/DOM; and HTTP headers/quota/config/secrets). Highest-impact findings were
re-verified directly against source. Findings are labelled **Confirmed**
(traced to exact code) or **Suspected** (latent / depends on a precondition).

> **Update (2026-07-08): the three HIGH-severity findings (H-1, H-2, H-3) have
> been remediated** in the same commit that lands this document. Each is marked
> **✅ Fixed** below with the change made. The Medium/Low findings remain open and
> are tracked in the action plan (§4). All 595 unit tests pass after the fixes.

---

## 1. Executive summary

The codebase is, overall, carefully built. The cryptography is sound, SQL is
consistently parameterised, the client renders untrusted model/web content
through a conservative DOMPurify configuration, OAuth CSRF is properly enforced,
break-glass Basic Auth fails closed, and no secrets are committed to the repo or
leaked to logs or third parties. The documented "privacy split" holds for the
R2/IndexedDB ciphertext path.

The material risks are concentrated in a few places:

1. **The `/mcp` deep-research tool bypasses the quota gate and usage accounting
   entirely** — the one confirmed, directly exploitable hole. Any approved user
   can drive unlimited, unmetered Berget + Exa spend through it.
2. **No HTTP security headers are set anywhere** — no CSP, no `nosniff`, no
   `frame-ancestors`. The app renders untrusted LLM and web content, so the
   entire XSS defence rests on a single DOMPurify call with no second layer, and
   the authenticated app is clickjackable.
3. **Session-cookie integrity is permanently reducible to the admin password's
   entropy**, even when a dedicated `SESSION_SECRET` is configured — defeating
   the module's own stated design goal.
4. **A check-then-act quota race** lets a concurrency burst overspend the
   per-window budget, and there is **no rate limiting** on the expensive
   LLM/search endpoints.
5. **The plaintext `chat_logs` interaction log** is the true residual privacy
   exposure; it is not user-deletable and is excluded from the account drain.

None of these is a remote unauthenticated compromise. The realistic threat model
is an **approved but malicious/compromised account** (cost abuse, quota bypass)
and **defence-in-depth gaps** that would turn a future client bug or DOMPurify
bypass into a full account-context XSS.

### Severity counts

| Severity | Count |
|---|---|
| Critical | 0 |
| High | 3 |
| Medium | 6 |
| Low | 12 |

---

## 2. Findings

### HIGH

---

#### H-1 · `/mcp` deep-research bypasses quota enforcement and usage accounting — Confirmed · ✅ Fixed
**Location:** `src/mcp.js` — `runDeepResearch` (lines 230–344); routed at
`src/index.js:240-242`.

**✅ Fix applied:** `runDeepResearch` now applies the same quota gate as
`/api/chat` (`effectiveQuota`/`getUsage`/`quotaExceeded`, admins exempt) *before*
running the pipeline — a blocked user gets a clear tool error naming the reset
time — and records spend afterward via `recordUsage` in a `finally` (the same
split-billing math: per-model buckets priced at catalog rates + Exa searches at
their depth-tier price + the `/contents` surcharge). Spend is now visible in the
usage bars and admin cost totals, and volume is capped by the quota.

`/mcp`'s `deep_research` tool runs the full research pipeline but contains **no
quota gate and no usage recording**. `runDeepResearch` records to the `chat_logs`
table (`recordChatLog`, mcp.js:315) but never checks `quotaExceeded` and never
calls `recordUsage`. A grep of `mcp.js` for `recordUsage|getUsage|quotaExceeded`
returns zero matches, versus `/api/chat` which gates on quota before running
(`chat.js:79-95`) and records spend afterward (`chat.js:283`).

The route sits only behind the identity + approval gates (`index.js:240`), so
**any approved non-admin user** — otherwise capped by the four-window quota on
`/api/chat` — can issue unlimited deep-research runs of up to
`config.max_time_budget_s` (clamped ≤600s) each via `POST /mcp`, every one
spending real Berget + Exa money.

**Impact:** (a) complete quota bypass for regular users; (b) because spend is
never written to `usage_events`, the cost is invisible in both the user's usage
bars **and** the admin cost totals — unmetered cost DoS. The per-call budget is
clamped, but nothing limits call *volume*.

**Remediation:** in `runDeepResearch`, mirror `chat.js`: load config/usage, apply
`quotaExceeded` (admins exempt) before `runPipeline`, and `recordUsage(...)` with
the split `state.totals`/`state.jsonTotals` and billed searches in a `finally`.
All the needed helpers are already imported elsewhere.

---

#### H-2 · No HTTP security headers (CSP, nosniff, frame-ancestors, HSTS, Referrer-Policy) — Confirmed · ✅ Fixed
**Location:** every response path — `src/http.js` `jsonResponse` (11–19) /
`sseResponse` (26–33); `src/index.js` `htmlResponse` (314–319) and `serveAsset`
(137–148). A repo-wide grep for the standard header names returns **zero
matches**.

The application serves untrusted LLM output and third-party web-search content
and renders it into the DOM, yet ships no `Content-Security-Policy`, no
`X-Content-Type-Options: nosniff`, no `X-Frame-Options`/`frame-ancestors`, no
`Referrer-Policy`, and no HSTS at the app layer.

**Impact:**
- **No CSP** ⇒ the entire XSS defence is a single `DOMPurify.sanitize` call
  (`markdown.js:56`). Any DOMPurify bypass (mutation-XSS/parser confusion are
  found regularly), a stale/tampered vendored `purify.min.js`, or an
  un-sanitised sink (see L-1) executes script with full session-context access —
  including IndexedDB, where the chat-history AES key and plaintext project chats
  live.
- **No `frame-ancestors`/`X-Frame-Options`** ⇒ clickjacking of the authenticated
  app.
- **No `nosniff`** ⇒ MIME-sniffing of served/stored content.

**✅ Fix applied:** `withRequestId` in `src/index.js` (which already
post-processes every response) now sets a full header set on every response:
an **enforcing** `Content-Security-Policy`, `X-Content-Type-Options: nosniff`,
`X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`,
`Strict-Transport-Security: max-age=63072000; includeSubDomains`,
`Cross-Origin-Opener-Policy: same-origin`, and a locked-down `Permissions-Policy`.
The CSP `script-src` is a strict allowlist — `'self'`, the two Google Maps hosts,
and the **SHA-256 hashes of the only two inline scripts** (index.html's boot
guard and story's inline module); **no `'unsafe-inline'`, no `'unsafe-eval'`**, so
injected inline `<script>`/`on*=` handlers cannot run. `object-src 'none'` and
`base-uri 'self'` close the plugin/base-tag vectors. Maps subresources are
allowed via `*.googleapis.com`/`*.gstatic.com`; if any are ever missed,
`renderStreetViewEmbed` already fails soft to the keyless google.com Embed
iframe (`frame-src`), so Street View degrades rather than breaks. `img-src`
stays broad (`data: blob: https:`) for user uploads and server data-URL frames.

**Original remediation (for reference):** add a shared header wrapper
(`withRequestId` in `index.js` already post-processes every response) setting
`Content-Security-Policy`,
`X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`,
`frame-ancestors 'none'` (or `X-Frame-Options: DENY`), and
`Strict-Transport-Security: max-age=63072000; includeSubDomains`. Two constraints
require care when authoring the CSP (do not just set `script-src 'self'`):
- Load-bearing **inline classic scripts** exist (`public/index.html:178` boot
  guard, `public/story/index.html:85`) plus inline `<style>` in the
  server-rendered login pages — hash/nonce the inline scripts and allow
  `style-src 'unsafe-inline'` (or hash the styles).
- External origins actually used: `script-src 'self' https://maps.googleapis.com`;
  `frame-src https://www.google.com` (Street View iframe fallback,
  `activity.js:134`); `img-src 'self' data: https:`;
  `connect-src 'self' https://maps.googleapis.com`.

---

#### H-3 · Session integrity permanently reducible to the admin password's entropy — Confirmed · ✅ Fixed
**Location:** `src/auth.js:166-177` (key list), `:190-196` (verify loop).

**✅ Fix applied:** `sessionHmacKeys()` now returns **only** the `SESSION_SECRET`
key when it is configured; the admin-credential-derived key is used *solely* as
a fallback when `SESSION_SECRET` is absent. With a `SESSION_SECRET` set, session
cookies are no longer forgeable/brute-forceable from the admin password. The
one-time cost — cookies minted under the old admin-derived key stop verifying
once `SESSION_SECRET` is introduced (a single re-login) — is documented in the
module header, and the unit test was updated to assert the new secure behavior.
Recommendation still stands to set a high-entropy `SESSION_SECRET` in production
so the fallback path is never exercised.

`sessionHmacKeys()` **always** appends a fallback HMAC key derived from the admin
credentials — `` `${creds.user} ${creds.pass}` `` — and `verifyHmac()` accepts a
tag valid under *any* candidate key. Because `identify()` fails closed unless
`adminCreds(env)` is set, that admin-derived key is therefore *always* a valid
signing/verification key for session cookies — **even when `SESSION_SECRET` is
configured.**

Consequences:
- The forgeability of every session cookie
  (`u.<uid>.<exp>.<hmac>`, `createSessionCookie` at auth.js:90-97) is bounded by
  the entropy of `ADMIN_USER`/`ADMIN_PASS`, not by `SESSION_SECRET`.
- The cookie message (`<uid>.<exp>`) is fully known to its holder, so a single
  captured user cookie enables an **offline** brute-force/dictionary attack
  against `ADMIN_PASS`. If recovered, an attacker can forge a cookie mapping to
  `ADMIN_ID` (full admin) or to any `uid` (impersonate any user).

This directly contradicts the module's own rationale (auth.js:22-25: "`SESSION_SECRET`
is deliberately not the admin password, which the cookie would otherwise expose
to offline brute force"). Severity is **High if `SESSION_SECRET` is unset**
(sole line of defence is then the admin password) and **Medium when it is set**
(the weaker legacy key still validates). Flagged independently by two auditors.

**Remediation:** include the admin-credential key in `sessionHmacKeys()` **only**
when `SESSION_SECRET` is genuinely absent (or drop it and require
`SESSION_SECRET`, failing closed if unset). Once migrated, verification should
accept only `SESSION_SECRET`. Ensure both `ADMIN_PASS` and `SESSION_SECRET` are
high-entropy random values.

---

### MEDIUM

---

#### M-1 · Check-then-act quota race lets a concurrency burst overspend — Confirmed
**Location:** `src/chat.js:79-95` (check) vs `:283` (record); same shape in
`src/quiz-api.js:37-43`/`63` and the `/api/embed` path.

Quota is read at request admission and spend is recorded only after the pipeline
finishes — no reservation/increment at admission. A user near their limit can
fire N concurrent `/api/chat` (or, worse, `/mcp` — see H-1) requests that all
pass the gate before any records usage, overspending by ≈N×. `getUsage`
(`quota.js:170-195`) is a plain D1 SUM, so there is no atomic increment to race
against. With `max_time_budget_s` up to 600, each in-flight request can plan many
Exa searches + a large synthesis, so the per-burst multiplier is significant.

**Remediation:** reserve/increment usage at admission (short-TTL in-flight
counter, D1 conditional update, or a Durable Object lock) and reconcile actual
cost on completion; or cap per-user concurrent in-flight requests.

---

#### M-2 · No rate limiting on expensive authenticated endpoints — Confirmed
**Location:** routing in `src/index.js:233-297`.

`/api/chat`, `/mcp`, `/api/embed`, and `/api/quiz/grade` are protected only by the
cost quota (itself racy — M-1). The approval gate limits *who*, not *how fast*.
`/api/client-error` (`user-api.js:37-54`) writes a Workers Logs entry per call
with no rate cap (authenticated, 2 KB body cap, fields truncated — low-severity
log-flood only).

**Remediation:** add a lightweight per-user/per-IP limiter (Cloudflare Rate
Limiting rules or a Durable Object token bucket) in front of the pipeline and
helper LLM endpoints.

---

#### M-3 · Plaintext `chat_logs` is the dominant residual privacy exposure and is not user-deletable — Confirmed
**Location:** `src/chatlog.js`; schema `src/db.js:58-83`; drain `src/storage.js:250-263`.

Every non-incognito exchange stores the **complete question, answer, full
conversation, and metadata in cleartext** in D1 (a documented product decision).
As a factual matter for anyone relying on the "conversations rest as ciphertext"
claim: the client-side encryption provides **no confidentiality against the
server operator or a D1 compromise**, because D1 holds the same content in
plaintext, readable by any admin via `GET /api/admin/chatlogs`.

Aggravating: **`DELETE /api/storage` (the drain) does not touch `chat_logs`** — it
wipes only convos/projects/files/rag. There is **no endpoint that deletes
`chat_logs` rows at all**; the table is append-only and never pruned. A user who
turns the cloud knob off and drains everything still leaves a permanent,
un-wipeable plaintext copy of all prior conversations server-side. An incognito
choice also cannot be applied retroactively.

**Remediation:** encrypt `question`/`answer`/`conversation_json`/`meta_json` at
rest, and/or add a retention/TTL policy, and include `chat_logs` in the user
drain. Ensure `/help/` accurately describes the true residual exposure rather
than implying encryption protects all conversation content.

---

#### M-4 · Server accepts plaintext for the `convos` family — ciphertext-at-rest is client-enforced only — Confirmed
**Location:** `src/storage.js:152-167` (`putEncRecord`).

`putEncRecord` accepts either `{iv, ciphertext}` **or** a readable `{data}` record
for **both** `convos` and `projects`, chosen entirely by the client. The server
cannot distinguish a RAG-indexed project chat from an ordinary conversation, so
nothing prevents a plaintext conversation being stored under `convos/{uid}/`. The
invariant "conversations rest as ciphertext in R2" is thus an unenforced
client-side convention: a client bug, a modified/compromised client, or XSS could
silently persist cleartext conversations in R2 with no server-side detection.

**Remediation:** reject `{data}` for the `convos` family (accept plaintext only
where the server can independently confirm project/RAG membership), or tag
records and refuse plaintext for anything not provably indexed.

---

#### M-5 · Two unbounded outbound fetches violate the time-bound invariant — Confirmed
**Location:** `src/exa.js:98-110` (`webSearch` primary search) and
`src/berget.js:85-87` (`fetchCatalog` models fetch).

Load-bearing invariant #2 requires outbound calls to be time-bounded so a hung
backend degrades rather than hanging the request. Two fetches have no `signal`:
- **`exa.js:98` — the hot path.** `pipeline.js:884` runs
  `Promise.all(batch.map(webSearch…))` with no outer deadline, so a single
  stalled Exa `/search` backend hangs the whole `/api/chat` request. Notably the
  sibling `fetchContents` in the same file *is* bounded (`CONTENTS_TIMEOUT_MS`) —
  an inconsistent oversight, not a deliberate exception.
- **`berget.js:85` — `fetchCatalog`.** A third Berget call not covered by the
  "both Berget calls are time-bounded" invariant; a hung `/models` endpoint hangs
  `/api/models` and per-request model validation (the 5-min cache limits
  frequency, not the hang).

**Remediation:** add `signal: AbortSignal.timeout(...)` to both and keep the
existing fail-soft `catch` blocks. (All other outbound calls are correctly
bounded.)

---

#### M-6 · Anti-injection instruction missing on the two phases that read untrusted web content — Confirmed
**Location:** `src/prompts.js` — `gapPrompt` (123–137) and `validatePrompt`
(173–179).

`ANTI_INJECTION_NOTE` is appended to triage, synth, notes, direct, claim-extract,
claim-verify, revise, and quiz prompts — but **not** to `gapPrompt` or
`validatePrompt`, both of which are fed the untrusted source digest (and
`validatePrompt` also the draft). A malicious page in the source set can attempt
to steer the coverage audit (`{"complete":true}` → cut research short) or the
fact-check (`{"verdict":"pass"}` → wave through fabrications). Blast radius is
limited — these are fail-soft JSON planning phases and **no secret is ever
present in any prompt**, so there is no exfiltration path; the harm is degraded
research integrity, plus an inconsistent defence.

**Remediation:** append `ANTI_INJECTION_NOTE` to both builders. As
defence-in-depth, wrap untrusted spans (web highlights via `sourceDigest`, full
page text up to `CONTENTS_MAX_CHARS`) in explicit delimiters rather than plain
labels.

---

### LOW

| ID | Finding | Location | Status |
|---|---|---|---|
| L-1 | Search-source anchor `href` set from `src.url` with **no scheme validation** — a `javascript:`/`data:` URL from a search provider becomes a clickable in-origin executor (`rel=noopener`/`target=_blank` do not stop it). Amplified by H-2. Low exploitability (URLs come from Exa/HF crawl, not model/user). | `public/js/activity.js:363` | Confirmed |
| L-2 | Cross-user RAG isolation relies **solely** on the Vectorize `filter:{u}`; no post-query assertion that `m.metadata.u === uid`. If the metadata index ever fails open, user A gets user B's chunk text. Add a hard post-filter. | `src/rag.js:334-347` | Suspected |
| L-3 | `/api/history-key` returns the per-user AES key with no `Cache-Control: no-store`/`Pragma: no-cache`. Key material should never be cacheable by any intermediary. | `src/user-api.js:61-67` | Confirmed |
| L-4 | `getFile` reflects the client-supplied `x-file-type` MIME with no `nosniff` / `Content-Disposition: attachment`. Self-XSS only (files are uid-scoped), but missing hardening. | `src/storage.js:198-212` | Confirmed |
| L-5 | Google `id_token` RS256 signature not verified and no `nonce`. Acceptable in the server-to-server auth-code flow, but breaks if `GOOGLE_TOKEN_URL` is ever mis-set. Keep the endpoint hard-coded in prod or verify against JWKS. | `src/google.js:118-124` | Confirmed |
| L-6 | OAuth `state` carries no timestamp and is not consumed server-side — within the 600s cookie TTL the same state+cookie pair could be replayed. CSRF protection itself still holds (per-request random, HttpOnly, single-use `code`). Bind a timestamp and reject stale state. | `src/auth.js:104-111`; `src/google.js:64-94` | Confirmed |
| L-7 | Shodan IPs from `/dns/resolve` reused in `/shodan/host/{ip}` without re-running `isPublicIpv4`. Not SSRF (request still targets `api.shodan.io`), but wastes a credit on private/metadata resolutions. | `src/shodan.js:239` | Confirmed |
| L-8 | `fetchImageDataUrl` does `resp.arrayBuffer()` with no byte cap before base64-encoding into memory. Bounded in practice by the 6s timeout and small Google images; add a `Content-Length`/size guard. | `src/googlemaps.js:232` | Suspected |
| L-9 | `lat`/`lon` interpolated into the Nominatim URL without `encodeURIComponent`. Safe today only because `validateImageLocations` coerces them to finite numbers; latent if reached from a less-validated path. | `src/geocode.js:29` | Suspected |
| L-10 | Locally-generated thumbnail data-URL interpolated into `innerHTML` unescaped, unlike every sibling field. Not exploitable (canvas data-URL can't contain a quote); consistency/defence-in-depth. | `public/js/projects-ui.js:209` | Suspected |
| L-11 | Admin UI assets (`/js/admin.js`, `/css/admin.css`) are served to any authenticated user (they fall through to `serveAsset`). Leaks admin UI structure/endpoint names only; `/api/admin/*` still enforces admin server-side. | `src/index.js:311` | Confirmed |
| L-12 | No aggregate request-size cap: per-message text (32 KB) and total image chars (750 KB) are capped, but not total text across up to 60 messages (~1.9 MB). Fails soft at Berget's ~1 MB limit → 400. Wasted round-trip. Also: vendored libs (`public/vendor/`) carry no version/integrity manifest — since H-2 leaves DOMPurify as the sole XSS defence, record exact versions + SHA-256 and a verified update step. | `src/validation.js:9-82`; `public/vendor/` | Confirmed |

Also noted (informational): `safeEqual` early-returns on length mismatch, leaking
operand length (auth.js:201 — negligible for hex tags); upstream Berget error
text (≤300 chars) is surfaced to the client/log (pipeline.js:1105 — will not
contain our tokens, which ride only in headers).

---

## 3. Verified sound (checked, no action)

- **Cryptography.** History key = HMAC-SHA256(server secret, `"history-key.v1."+userId`)
  → 32-byte AES-256 key with per-user domain separation; no password KDF needed
  (input is a high-entropy secret). AES-GCM uses a fresh 12-byte
  `crypto.getRandomValues` IV on every encrypt; automatic auth tag; no
  IV/nonce reuse, no ECB. Fails closed when the secret is absent.
- **IDOR / storage isolation.** Every storage/RAG/answer key is scoped to a
  **server-derived** identity (`identity.user.id`), never a client value; ids are
  regex-validated `^[A-Za-z0-9_-]{1,80}$` (no path traversal); answer queries
  bind `AND user_id = ?`.
- **SQL injection.** Bound parameters throughout; `?q=` LIKE uses `\ % _`
  escaping with a matching `ESCAPE '\'`; the only string-interpolated SQL uses
  server-computed numeric window timestamps, not user input.
- **SSRF.** Every outbound `fetch` targets a hard-coded provider host; user input
  only reaches query params/bodies or a strictly range-validated IP path segment.
  No user/model-controlled URL is fetched by the Worker.
- **Outbound data minimisation (invariant #4).** Only a query / coordinate / host
  crosses to each third party — no conversation text, filename, account identity,
  or secret. API keys ride in headers (or, for Shodan/Maps, query strings that
  are never logged or cached).
- **Edge cache.** Synthetic `.internal` keys; values written only from real
  provider responses (no poisoning); only public data cached (no cross-user
  private leakage).
- **Client XSS core.** `renderMarkdownInto` parses then `DOMPurify.sanitize`s
  before `innerHTML`, forbids `<img>`, rewrites anchors to
  `target=_blank rel=noopener`; everywhere else untrusted text uses `textContent`
  or `escapeHtml`. No `postMessage`, no prototype-pollution merge, no open
  redirect. Login pages use `flash` as an allowlist key and `escapeHtml` the
  email.
- **Auth & access control.** Break-glass Basic Auth fails closed and uses
  `safeEqual`; session cookies are `Secure; HttpOnly; SameSite=Lax` with `uid`
  bound into the HMAC; disabled users rejected immediately; admin API + UI both
  enforce `role === "admin"`; admin PATCH refuses role changes; OAuth CSRF
  enforced via signed single-use state cookie; terms/approval gates run before
  all APIs and app content.
- **Secrets hygiene.** No secrets committed (`.gitignore` covers
  `.dev.vars`/`.env`); no secret leakage in logs; no verbose error/stack leakage
  to clients (500s return only `{error, request_id}`); no CORS headers set
  (same-origin intact).
- **Resource bounds in the pipeline.** Search fan-out, gap iterations, claim
  count (≤12), and content fetches (top-4, `CONTENTS_MAX_CHARS`) are all bounded;
  `STREAM_MAX_CHARS` caps runaway generation; model-output JSON parsing is
  string-aware, linear-time, and fail-soft; no ReDoS found.

---

## 4. Prioritised action plan

### Phase 1 — ✅ DONE (exploitable / highest leverage)

1. **H-1 · Gate `/mcp` on quota + record usage.** ✅ Done — `runDeepResearch`
   now mirrors the `chat.js` gate/record. Closes the confirmed unmetered-spend
   hole and removes the M-1 blast-radius multiplier on that endpoint.
2. **H-2 · Add security headers.** ✅ Done — enforcing CSP (strict `script-src`
   with hashed inline scripts, no `'unsafe-inline'`/`'unsafe-eval'`), `nosniff`,
   `X-Frame-Options`/`frame-ancestors`, `Referrer-Policy`, HSTS, COOP, and
   `Permissions-Policy` via `withRequestId`. Converts every latent DOM sink
   (L-1, L-10, future DOMPurify bypass) from potential-XSS to contained.
   *Post-deploy: confirm the app + Street View render clean with no CSP console
   violations (see §Verification note).*
3. **H-3 · Fix the session-HMAC fallback.** ✅ Done — the admin-credential key is
   used only when `SESSION_SECRET` is absent. **Operational follow-up:** ensure a
   high-entropy `SESSION_SECRET` (and `ADMIN_PASS`) is set in the Worker secrets
   so the fallback path is never used.

### Phase 2 — this sprint (cost/abuse + privacy correctness)

4. **M-1 / M-2 · Close the quota race and add rate limiting.** Reserve spend at
   admission (or per-user in-flight counter) + a per-user/IP token bucket on
   `/api/chat`, `/mcp`, `/api/embed`, `/api/quiz/grade`.
5. **M-3 · `chat_logs` privacy.** Encrypt the Q&A/metadata columns at rest and/or
   add retention + include the table in `DELETE /api/storage`; align `/help/`
   copy with the true exposure.
6. **M-4 · Enforce ciphertext for `convos`.** Reject plaintext `{data}` records
   for the conversation family server-side.
7. **M-5 · Bound the two unbounded fetches** (`exa.js:98`, `berget.js:85`).
8. **M-6 · Append `ANTI_INJECTION_NOTE`** to `gapPrompt` and `validatePrompt`.

### Phase 3 — backlog (defence-in-depth)

9. **L-1** validate anchor scheme before `a.href = src.url` (`https?:` only).
10. **L-2** add a post-query `metadata.u === uid` filter in `ragQuery`.
11. **L-3 / L-4** `Cache-Control: no-store` on `/api/history-key`;
    `nosniff` + `Content-Disposition: attachment` on stored-file responses.
12. **L-5 / L-6** bind a timestamp into OAuth `state` and reject stale; optionally
    verify the Google `id_token` signature / add a `nonce`.
13. **L-7 – L-12** the remaining hardening items (Shodan resolved-IP re-check,
    image byte cap, `encodeURIComponent` on lat/lon, thumbnail escaping, gating
    admin assets, aggregate size cap, and a vendored-lib version/integrity
    manifest).

---

*Prepared as a point-in-time source review. It complements — does not replace —
the project's live-verification and eval disciplines; anything touching an
external provider or D1 should still be verified against production after a fix.*
