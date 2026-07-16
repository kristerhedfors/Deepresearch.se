---
name: identity-access
description: >-
  Load when building the server tier's identity layer for an agent pair —
  OIDC sign-in with state-cookie CSRF and claims validation, the long-lived
  sliding session cookie HMAC-keyed solely by the session secret (fail
  closed, no fallback), one-time terms and approval gate pages (PWAs cannot
  answer a 401 challenge), break-glass Basic Auth, passwordless accounts
  CRUD with an admin-email bootstrap, the admin gate, and the structural
  rule that grant tokens are NEVER a login. Also load when reviewing any
  change to cookie signing, the identity gate's resolution order, or the
  no-DB degradation posture.
---

# Identity & access — the server tier's front door

The server tier is the signed-in half of the pair: exactly one identity
gate, in the one worker, resolves who is calling before any API or asset is
served. This module builds that gate from scratch: OIDC sign-in as the only
user-facing login (no passwords ever stored — the identity provider proves
the email), a year-long sliding session cookie whose HMAC is keyed solely by
one dedicated secret, server-rendered gate pages instead of HTTP auth
challenges, a break-glass Basic Auth identity for scripts and emergencies,
auto-provisioned accounts with an admin-email bootstrap, and the pinned
guarantee that no bridge token can ever pass the gate. Everything fails
CLOSED: a missing secret disables the site rather than weakening it.

## Capability class & tier story

Manifest class: **S — server-backed.** Layer 2; deps `baseplate-worker`.
This module exists only in the server tier; the client tier has no accounts
by definition, and no module here may ever enter the client tier's module
graph. Its client-tier story is purely negative and structural: the identity
gate is what the client tier's paths are routed BEFORE, and the gate is what
bridge tokens (class B) must provably never satisfy. The tier split gives
this module its clean shape — one gate, one cookie, one admin role — because
every other identity concern (the client tier's "who are you" question)
simply does not exist.

## Contracts

- **PA-4 (carries)** — accounts hold no passwords and no content: email,
  name, role, status, quota overrides, timestamps. Sign-in proves email
  ownership via the identity provider; nothing conversation-derived ever
  touches an account row.
- **PA-8 (enforces the gate half)** — grant tokens are NEVER a login: the
  one identity function rejects every bridge-token family in every position
  (cookie, Bearer, Basic), test-pinned, so the admin surface and user data
  stay reachable only through a proper sign-in.
- **PA-5 (enforces)** — the OIDC flow is hand-rolled server-side fetch, no
  SDK: the flow's four requests are small, and owning them is what makes
  the claims-validation and incident debugging tractable.
- **PA-2 (inverted, deliberately)** — identity does NOT fail soft: missing
  secrets fail the whole site closed (a configuration-error page), and a
  missing database degrades to break-glass-only with an honest message.
  Helper phases degrade; authentication never does.
- **PA-10 (carries)** — the sign-in round-trip, cookie longevity, and
  redirect-URI behavior are verified against the live deployment; provider
  URL env overrides exist solely so local tests can point at a mock.

## Build plan

1. **Create the shared HMAC-primitives leaf** (nothing imports anything):
   base64url encode/decode, hex rendering, a constant-time-ish string
   compare, and a NAMESPACED `sign(env, ns, message)` over the one root
   secret. The namespace argument is what later keeps session cookies,
   OAuth state, and every bridge-token family mutually unforgeable under a
   single secret. Fail closed: no secret configured → `sign` throws.
2. **Design the session cookie**: `u.<uid>.<exp>.<hmac(uid.exp)>`, HttpOnly
   + Secure + SameSite=Lax, ~365-day TTL with SLIDING reissue — any
   authenticated request past the half-life gets a fresh cookie appended by
   the entrypoint, so an installed PWA opened twice a year never re-logs-in
   (HttpOnly + server-set also exempts it from Safari ITP's 7-day cap on
   script-writable storage). The HMAC key is the dedicated session secret
   and NOTHING ELSE — no admin-credential fallback, ever (see Pitfalls for
   why). Unset secret → the entrypoint serves a configuration-error page
   before any auth flow can run keyless; rotation invalidates all sessions.
   Pin the security properties in unit tests: round-trip, rotation kills
   sessions, tamper fails, and — the critical one — no secret verifies
   NOTHING (fail closed), with no alternate key ever honored.
3. **Write the one identity function** (`identify(request, env)`): resolve
   Basic header first (break-glass admin via constant-time compare;
   explicit BAD Basic credentials return null WITHOUT falling through to
   the cookie), then the session cookie (verify HMAC + expiry, re-load the
   user row on EVERY request so disabling is immediate), and set a
   `refreshCookie` flag past the half-life. If the break-glass secrets are
   unset, return null for everything — the site fails closed.
4. **Implement OIDC sign-in, server side, no SDK.** Start route: mint 16
   random bytes as `state`, set a signed single-use state cookie
   (`<state>.<hmac>` under its own namespace, ~10-min TTL, Path-scoped to
   the callback), 302 to the provider's consent screen. Callback route:
   verify state (cookie equality AND signature), exchange the code
   server-to-server, decode the ID token's payload — signature verification
   is deliberately skipped when the token arrives directly from the
   provider's token endpoint over TLS, but the CLAIMS are validated: `iss`,
   `aud` (your client id), `exp`, and `email_verified === true`. Every
   failure path 303s to the login page with a flash CODE (detail goes to
   the log, never the user). Log the exact `redirect_uri` each start
   request builds — it is the ground truth behind redirect-URI mismatches.
5. **Auto-provision accounts on first sign-in.** Normalize the email; the
   one ADMIN-EMAIL environment variable gets (and keeps, re-asserted on
   every sign-in) the admin role, always active — the SOLE path to admin:
   the admin API deliberately cannot change roles, so no account can ever
   be promoted (sole-admin policy). Everyone else lands `pending` when the
   approval gate is on, `active` otherwise. Store the provider's stable
   subject id so the account stays pinned to that identity even if email
   ownership changes hands. A `disabled` row bounces with its own flash.
6. **Build accounts CRUD without passwords**: get-by-id/email, list,
   pending-count (feeds the admin badge), an ALLOWLISTED update patch
   (role/status/quota-overrides/name — unknown keys and invalid values are
   ignored, never written), one-time terms acceptance stamped with an
   `IS NULL` guard so the first timestamp stays authoritative, and delete
   cascading the usage history. Every read degrades to null/empty without
   the database; writes throw an honest "not configured".
7. **Render the gate pages server-side — never an HTTP auth challenge.**
   An installed PWA cannot answer a 401 `WWW-Authenticate` dialog (native
   prompt = black screen), so the worker NEVER emits one: unauthenticated
   HTML navigation gets the sign-in page (provider button + flash
   messages), unauthenticated `/api/*` gets a 401 JSON body. Two more
   one-time pages: the TERMS gate (shown after first sign-in until
   accepted; one short page, one Accept button posting to the accept
   route — resist consent-page sprawl) and the APPROVAL waiting room
   (auto-refreshing, sign-out as the only action, so approval takes effect
   on the next request with no re-login). Plus the configuration-error
   page for a missing session secret.
8. **Order the gates in the entrypoint**: request id → canonical-origin
   redirect → public allowlist + client-tier paths (all pre-identity) →
   public auth endpoints (login, OIDC start/callback) → `identify()` →
   terms gate → approval gate → routed surface. The admin surface
   (`/admin*`, `/api/admin/*`) additionally requires the admin role — 403
   for APIs, 302 home for HTML.
9. **Keep break-glass Basic Auth** as the emergency/scripting identity: the
   admin-secrets pair over an `Authorization: Basic` header only (never a
   form, never a challenge), no database and no identity provider needed,
   quota-EXEMPT but with usage still recorded under a fixed admin id so no
   spend is invisible. This is also what e2e suites authenticate with —
   they send the header preemptively on every request precisely because
   the server never challenges.
10. **Pin "a grant token is never a login".** Write the test that mints a
    real bridge token and asserts `identify()` returns null with it in
    EVERY position — session-cookie value, Bearer header, and both halves
    of a Basic pair — so bridge tokens are administered FROM the admin
    surface and can never open it. Structural separation (different
    namespaces, formats, and signature encodings under the one secret)
    makes this true; the test keeps it true.
11. **Verify live**: a full sign-in round-trip on the deployed site, cookie
    reissue past the half-life, disabling a user killing their live
    session, and the approval flow turning the waiting page into the app
    with no re-login.

## Reference implementation map

| Concept | Reference file(s) |
|---|---|
| Identity gate, session cookie, sliding reissue, state HMAC | `src/auth.js` (`identify`, `createSessionCookie`, `signState`/`verifyState`) |
| The sole-key / fail-closed property + its pins | `src/auth.js` (the `sessionHmacKeys` header comment), `src/auth.test.js` |
| Shared HMAC primitives leaf (namespaced sign) | `src/token-crypto.js` |
| OIDC start/callback, claims validation, provisioning | `src/google.js` (`handleGoogleStart`, `handleGoogleCallback`, `adminEmail`) |
| Gate pages (login/terms/pending/config-error; why no 401 challenge) | `src/login.js` |
| Accounts CRUD, allowlisted patch, terms stamp, sole-admin | `src/accounts.js` |
| Gate ordering in the entrypoint; admin 403/302 | `src/index.js` (`route`), `docs/ARCHITECTURE.md` §3 |
| "Never a login" test pin | `src/server-token.test.js` ("a Se/rver token is NOT a login: identify() rejects it in every position") |
| Admin surface handlers (role-gated) | `src/admin-api.js` |
| Break-glass usage by the e2e suite | `tests/` (Basic header on every request; `tests/package.json` README notes) |
| Live setup + provider registration walkthrough | `docs/GOOGLE-AUTH.md`, `.claude/skills/access-control/SKILL.md` |
| No-DB degradation posture | `src/db.js`, `src/google.js` (`nodb` flash), `docs/ARCHITECTURE.md` §4.7 |

## Acceptance checklist

- [ ] Cookie security suite green: mint→verify round-trip; secret rotation
      invalidates sessions; tampered cookie rejected; NO secret configured
      verifies nothing (fail closed) and no alternate key is honored.
- [ ] State-cookie CSRF pinned: callback rejects a missing/mismatched/
      forged state; the cookie is single-use and Path-scoped.
- [ ] Claims validation pinned: bad `iss`, wrong `aud`, expired token, and
      unverified email each bounce with the right flash code.
- [ ] The never-a-login test mints a real bridge token and proves
      `identify()` rejects it as cookie, Bearer, and Basic.
- [ ] Live sign-in round-trip on the deployed site: provision → terms →
      (approval) → app; disable kills the live session on the next request.
- [ ] With no database binding: break-glass works, sign-in bounces with an
      honest message, nothing throws.
- [ ] No `WWW-Authenticate` header is emitted anywhere (grep + live probe).
- [ ] Admin routes return 403 (API) / 302 (HTML) to non-admins; the admin
      role is unreachable through the admin API (sole-admin pinned).

## Pitfalls

- **Never fall back to admin credentials as the HMAC key.** The reference's
  original design derived the cookie key from the admin password when the
  session secret was unset — which made every issued cookie an OFFLINE
  brute-force oracle for the break-glass credentials (the message
  `<uid>.<exp>` is known to its holder; HMAC-SHA-256 is one fast hash), and
  even a never-approved user gets a signed cookie before approval. The
  fallback was removed: one dedicated high-entropy secret, or the site does
  not run sessions at all.
- **Canonicalize the HOST, don't just pin the redirect URI.** The reference
  worker answered on both apex and `www`; the provider's redirect-URI list
  is exact-match, so a `www` sign-in built a `www` callback →
  `redirect_uri_mismatch` (2026-07-11, Firefox Focus). Pinning only the URI
  would have split the CSRF state cookie across hosts — the fix is a 301
  `www→apex` at the very top of routing, before the identity gate, so
  state cookie, redirect URI, callback, and session all live on one host.
- **PWAs make dedicated pages mandatory, not cosmetic.** The 401 challenge
  path renders as a black screen in installed PWAs — that is WHY the
  login/terms/pending gates are server-rendered pages and the server never
  challenges. It also dictates the e2e-testing style: send the Basic header
  preemptively; a framework's "httpCredentials" waits for a challenge that
  never comes.
- **Bad Basic must not fall through to the cookie.** An explicit wrong
  Basic pair returns null immediately — falling through would let an
  attacker probe credentials while riding a valid session cookie.
- **Re-check the user row on every request.** Cheap, and it is what makes
  disabling immediate and approval take effect without re-login. Caching
  identity for a session's lifetime silently breaks both.
- **Keep legacy cookie formats verifying across upgrades.** The reference's
  pre-multiuser cookie format still maps to the admin identity so existing
  installs weren't logged out — plan the cookie format with an upgrade
  story, because rotating everyone's session is a real cost.
- **The terms page is one page, once.** Acceptance is a timestamp on the
  user row (first stamp authoritative). Resist adding consent screens — the
  reference's directive keeps it deliberately short, linking regulations
  rather than restating them.
- **Provider URL overrides are for tests only.** Env overrides pointing the
  OIDC endpoints at a mock exist so the flow is testable offline;
  production always uses the defaults. Never let an override reach a
  deployed configuration.
