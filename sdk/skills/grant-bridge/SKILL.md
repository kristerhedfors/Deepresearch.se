---
name: grant-bridge
description: >-
  Load when building THE bridge of a platform — the only sanctioned
  client-tier→server crossing: metered, expiring, revocable grant tokens
  lending bounded server capabilities (web search, proxied LLM completions)
  to sessions that otherwise never touch the server. Covers the token-crypto
  primitives leaf, the namespace separation that keeps token families
  mutually unforgeable under one root secret, the evolution to the
  consolidated permission-set JWT ("one ticket, one JWT"), THE SERVER-TOKEN
  GUARANTEE and its structural pins, the atomic reserve/refund meter, budget
  ceilings, fail-safe posture, the two mint paths, admin governance, and the
  client-tier disclosure UX. Also load when auditing quota integrity or
  adding a new grant family/service.
---

# The grant-token bridge between tiers

The platform's story collapses if the client tier quietly calls authenticated
server endpoints — so every client-tier↔server crossing rides a **grant
token**: a signed capability, minted by a signed-in user or an admin, that
lends a session a bounded, disclosed, metered, expiring, instantly-revocable
allowance of server-paid upstream calls. The design splits cleanly in two:
**the token authenticates; the meter row meters** — a self-contained token
cannot decrement a counter across requests, so quota lives in a database row
keyed by the token's `jti`, which is also what makes live governance
(adjust, pause, revoke) possible without ever touching a token in
circulation.

## Capability class & tier story

**Class B — bridged.** The server half (mint, meter, spend endpoints, admin
governance) lives in the one server component; the client half (link
readers, exchange, the disclosure UI, a provider-registry entry for the
proxied LLM) lives in the client tier's public bundle. Class-B rules apply
in full: opt-in (a master toggle), disclosed (the client UI says which APIs
are connected), quota-metered, time-limited, fail-safe, and minimal-payload
— only the query crosses for search; the LLM permission necessarily carries
the caller's prompt, so its disclosure must say exactly that.

## Contracts

- **PA-8 (bridge discipline)** — this module IS PA-8: token families under
  ONE root secret with structural namespace separation, atomic per-grant
  meter rows, global budget ceilings, instant revocation, and the guarantee
  that a token authorizes upstream API access only.
- **PA-9 (fail-safe metering)** — no meter DB → HTTP 503 for every mint and
  every spend; there is no unmetered spend path, ever. Deliberately the
  OPPOSITE of PA-2: helper phases fail soft, money fails safe.
- **PA-4 (privacy split)** — grants are the split's bounded, disclosed
  exceptions: the search permission carries a query and nothing else; the
  LLM permission is the ONE place client-tier content touches the server,
  and it is opt-in, disclosed per step, and transient (never written to any
  store).
- **PA-10 (verify)** — the cross-subsystem invariant checklist (forgery
  matrix, concurrency overrun, refund floors, expiry, budget, account
  binding, module-graph pin) is the acceptance gate, run over a combined
  in-memory meter-DB fake.

## Build plan

1. **The primitives leaf** — `src/token-crypto.js`: `b64url`/`b64urlDecode`,
   `toHex`, `safeEqual` (constant-time compare), and the namespaced
   `sign(env, ns, message)` — one HMAC-SHA-256 over `<namespace><message>`
   under the single root secret, hex tag. **Fail closed:** no root secret →
   throw, never a fallback key (the reference removed a weaker
   derive-from-admin-creds fallback after finding it). A leaf module:
   imports nothing, so no consumer's handler graph leaks into another's
   tests. Each token family keeps its OWN mint/verify (their claims differ
   deliberately) and passes its namespace into `sign` — the namespace IS
   the family separation: a valid token of one family can never verify as
   another, provable and test-pinned.
2. **Know the evolution — it's the design rationale.** Three generations,
   all still verifiable in the reference:
   - **Gen 1, single-service HMAC family**: `wsk1.<b64url(JSON)>.<tag>`,
     claims `{jti, uid, quota, iat, exp}`, one namespace, one service.
     Simple, URL-safe, still the smallest correct shape.
   - **Gen 2, two-tier grant/proxy**: a GRANT token (`prg1`, "the
     token-granting token") designed to travel in URLs, EXCHANGED once
     (`POST …/exchange`) for a working PROXY token (`prx1`) that **never
     appears in any URL** — a leaked link never carries the working
     credential. One token per service (`svc: web | api`), each its own
     namespace.
   - **Gen 3, the consolidated server token**: ONE standard HS256 JWT per
     grant carrying a permission SET (`perms: ["web","api"]`), one
     duration, one `jti`, `sub` for accountability — and deliberately **no
     quota claims**: quota lives ONLY in the meter rows, one row per
     permission, so a grant stays administrable (adjust/pause/top-up/
     revoke) while the token in circulation never changes — the
     **token-fixed / rows-metered** discipline. New platforms should build Gen
     3 directly and keep Gen 1's URL-safety lesson and Gen 2's
     never-in-URL lesson as constraints on what may ride a link.
3. **JWT family separation is structural, not conventional.** Under the one
   root secret: other families sign `<ns> + <one dot-free b64url segment>`;
   the JWT's signing input is `<canonical header>.<payload>` — always
   starts with the pinned header segment and contains a dot, which no
   other family's input can. Signature encodings differ (base64url for the
   JWT, hex elsewhere). Verification constant-compares the header segment
   against the ONE canonical minted header — killing `alg:none`, algorithm
   swaps, and re-serialized headers before any signature check. Verify
   **signature first, then expiry** — a forged token must never reach the
   meter. Pin all of it with a cross-family forgery matrix: every family's
   token relabeled as every other must fail; only the diagonal verifies.
4. **THE SERVER-TOKEN GUARANTEE.** State it in the module header at
   verbatim strength and never dilute it:

   > A server token grants access to the platform's UPSTREAM APIs ONLY. It
   > never hands out any of the server tier's own data: no project
   > contents, no chat contents, no conversation history, no account data.
   > And a server token is NEVER a login: the admin surface is reachable
   > only through a proper sign-in — tokens are administered FROM the admin
   > interface and can never open it.

   Enforce it structurally, four ways: (a) a **closed permission
   vocabulary** — the services constant names upstream services only, and
   verification DROPS unknown perms, so a token minted with a hypothetical
   future perm authorizes nothing this deploy doesn't serve; (b) a
   **module-graph unit test** — the grants module's import list is read by
   a test that fails if any data-bearing module (storage, vault, chat log,
   accounts, RAG, publishing) ever appears; (c) **the identity gate rejects
   the token in every position** — as the session cookie (raw and mangled
   into the cookie's own shape), as a Bearer header, smuggled into Basic
   credentials — all test-pinned; (d) the admin routes additionally require
   the admin role at the entrypoint, so even a future identity bug leaves
   them role-gated. The **name is itself a disclosure device**: call it a
   *server* token so nobody — user or developer — forgets that using one
   sends data to a server somewhere.
5. **The atomic meter** — one row per (jti, permission) in the meter DB:
   `{jti, service, user_id, quota, used, expires_at, source}`. The reserve
   is ONE guarded update:
   `UPDATE … SET used = used + 1 WHERE jti=? AND service=? AND used < quota AND expires_at > ?`
   — zero rows changed means refused (429), so a concurrent burst can never
   overrun. Empty/failed operations REFUND with the mirror guard
   (`used > 0` — the refund floor; `used` never goes below zero). Row
   deletion = instant revocation; a lapsed ROW beats a still-valid token.
6. **Budget ceilings** — a global config ceiling on total
   outstanding-remaining (`Σ max(quota−used, 0)`) across all live rows,
   checked at mint AND at every quota increase (an adjust is budget-checked
   like a mint), so shareable links can never mint unbounded server spend.
   Pauses and expiries free the ceiling.
7. **The two mint paths.** (a) **Authed self-grant on tier-crossover**: a
   signed-in user crossing to the client tier mints — or REUSES — their own
   grant (one live crossover grant per user per TTL window, bounding
   per-user upstream exposure), and only when an explicit intent marker was
   set, so a plain visitor never pings the server. (b) **Admin shareable
   links**: the admin panel mints a grant and yields a link anyone can
   follow; the follower reads remaining via a public NON-consuming status
   endpoint and spends via the public metered endpoints. Spending is
   public by design — a client-tier session has no identity; the token is
   the authority.
8. **Admin governance** — one config block (master `enabled` switch,
   per-permission default quotas, default TTL, the global budget) plus a
   panel: list live grants grouped by `jti`, per-permission adjust
   (set / ± / pause — quota clamps at ≥ 0 and **0 pauses**), revoke
   (delete rows = kill every copy of the link instantly). Self-service
   adjust for minters over their OWN grants, owner-scoped: a foreign `jti`
   answers a 404 **byte-identical** to a missing one — no existence
   confirmation. Status-code ladder to build against: 400 bad input, 403
   bad/expired/revoked token, 404 foreign/missing jti on adjust, 409
   budget, 429 exhausted/paused, 503 no meter DB.
9. **The spend endpoints** — per permission: a query-only search endpoint
   (reserve → upstream search on the server's key → refund on empty/fail),
   and an LLM reverse proxy speaking the standard completion wire format
   (models list non-metered, completions metered) so the client tier's
   provider registry drives it UNCHANGED as just another provider entry.
   Restrict the LLM permission to ONE upstream provider — bounded account
   exposure.
10. **Bundle transport for multi-grant handoff** — when a bundle of grants
    must reach a browser via URL: seal it AES-256-GCM under a fresh random
    key; the **ciphertext rides the query** (server-visible but opaque),
    the **key rides the fragment** (never sent to any server, stripped
    from referrers). A leaked server log or Referer carries a blob it can
    never open. With the Gen-3 JWT a single grant can ride a plain query
    param (claims are readable by design — IDs, numbers, timestamps, no
    content); strip it from the URL/history immediately on read.
11. **Client-tier disclosure UX** — a connected-APIs banner on arrival, a
    settings row per grant (per-permission remaining + a master OFF
    toggle), and per-step notices whenever an online capability runs —
    saying plainly, for the LLM permission, that the conversation routes
    through the server. The token is a temporary credential in plain local
    storage, deliberately NEVER part of the sealed project state.
12. **Tests** — the full invariant checklist over a combined in-memory
    meter-DB fake (see the reference's `quota-grant-assessment` skill):
    token-fixed/rows-metered under live adjusts; `Promise.all` burst of
    quota+k → exactly quota successes; refund floors; expiry (row beats
    token; adjust cannot resurrect; crossover never reuses a lapsed
    grant); budget boundary + freed-by-pause/expiry; account binding with
    byte-identical 404s; the forgery matrix; the module-graph pin; the
    identity-gate rejection suite.

## Reference implementation map

| Concept | File(s) in this repo |
|---|---|
| Primitives leaf (b64url/toHex/safeEqual/namespaced sign, fail-closed) | `src/token-crypto.js` |
| Gen 1: single-service HMAC family (`wsk1`) | `src/websearch-key.js` + `src/websearch.js` |
| Gen 2: two-tier grant/proxy (`prg1`/`prx1`, exchange, never-in-URL) | `src/proxy-grant.js` + `src/proxy.js` |
| Gen 3: the consolidated JWT + guarantee + canonical-header pinning | `src/server-token.js` (`SERVER_TOKEN_SERVICES`), `docs/SERVER-TOKENS.md` |
| Gen 3 mint/meter/endpoints + module-graph guarantee | `src/server-grants.js` (+ `src/server-grants.test.js` graph pin) |
| Shared pure presentation (budget 409, adjust ladder, quota-patch clamp) | `src/grant-http.js` |
| Bundle transport (ciphertext in query, key in fragment) | `public/js/proxy-bundle.js` |
| Client consumption: link readers, crossover, disclosure banner/rows | `public/cure/drc.js`, `public/js/drc-page-core.js` (`grantLive`, `grantFlagEnabled`) |
| Proxied-LLM provider entries | `public/js/drc-providers.js` (`proxyLlmProvider`, `serverTokenLlmProvider`) |
| Admin governance panels | `public/js/admin.js`; config defaults in `src/config.js` |
| Identity-gate rejection pins | `src/server-token.test.js`, `src/auth.js` (`identify`) |
| The invariant methodology + combined-fake technique | `.claude/skills/quota-grant-assessment/SKILL.md`, `src/workspace-grants.test.js` |
| Crypto claims register | `docs/ENCRYPTION.md` §5.1, §5.6 (E-1…E-11, E-32) |

## Acceptance checklist

- [ ] Primitives: sign fails closed without the root secret; `safeEqual`
      constant-time; namespace separation pinned.
- [ ] Forgery matrix green: every family relabeled as every other fails;
      JWT canonical-header pinning rejects alg:none/alg-swap/re-serialized
      headers; signature verified before expiry.
- [ ] Meter: burst of quota+k yields exactly quota successes and
      `used == quota`; refunds floor at 0; exhaust→refund→top-up ledger
      balances exactly.
- [ ] Token-fixed/rows-metered: the ORIGINAL token obeys a live adjust
      immediately (spends past a raised stale claim; 429s right after a
      pause); adjust never moves `expires_at` and cannot resurrect an
      expired grant.
- [ ] Budget: `outstanding + increase == budget` passes, +1 is 409;
      pause/expiry free the ceiling.
- [ ] Fail-safe: every mint and spend endpoint 503s with no meter DB — no
      code path spends unmetered.
- [ ] THE GUARANTEE pinned three ways: closed perms vocabulary (unknown
      perms dropped), module-graph test (no data-bearing import), identity
      gate rejects the token as cookie/Bearer/Basic.
- [ ] Account binding: crossover reuse-per-user; foreign-owner adjust is a
      byte-identical 404.
- [ ] Disclosure UX live-verified: banner on arrival, settings row with
      remaining + master toggle, per-step notice on the LLM path; token
      never serialized into the sealed state.

## Pitfalls

- **The fallback-key removal (E-4).** The reference once derived a fallback
  signing key from admin credentials when `SESSION_SECRET` was unset; the
  security pass removed it — fail closed, one root secret, full stop. Any
  "make it work in dev without the secret" convenience recreates the bug.
- **Quota claims inside tokens go stale by design.** The Gen-1 tokens carry
  a `quota` claim; treat it as mint-time provenance ONLY — the meter row is
  the truth, and the workspace-era tests exist precisely because a live
  adjust must beat the embedded claim. Gen 3 removed quota claims entirely;
  do the same.
- **`prx1`-class working credentials never enter URLs.** The whole point of
  the Gen-2 exchange; the reference's workspace payload builder asserts no
  working token in the serialized output. Extending what may ride a link
  starts from that pin, not from convenience.
- **Byte-identical 404s.** The owner-scoped adjust answers foreign and
  missing jtis with literally the same body (`assert.deepEqual` in the
  suite) — a differing error message is an existence oracle.
- **The reserve's atomicity depends on the single-statement guard.** A
  read-then-write refactor ("check remaining, then increment") reintroduces
  the concurrency overrun the burst test exists for. In test fakes, keep
  the check-and-increment synchronous to the first await — that models the
  DB's row atomicity correctly.
- **Refund on empty results, not just errors.** An upstream search that
  returns zero hits refunds the unit in the reference — users' allowances
  otherwise bleed on unlucky queries, which surfaces as "the grant ran out
  and nobody searched ten times".
- **The crossover must be intent-gated.** The reference only offers the
  self-grant when the tier-crossing button set an explicit marker — a plain
  client-tier visitor never pings the server. Wiring the grant probe into
  page boot silently breaks the tier's "no server contact" claim for
  everyone.
- **Legacy families stay verifiable after consolidation.** The reference
  retired the old MINT paths' primacy but keeps verification alive until
  the last outstanding token expires — links in the wild don't know about
  your refactor.
