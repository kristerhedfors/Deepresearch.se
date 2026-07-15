---
name: quota-grant-assessment
description: Load when asked to TEST, AUDIT, or ASSESS the quota-limited, account-bound temporary grant tokens (the secure-workspace borrowed capabilities) — "make sure quota holds up", "test the grant tokens", "verify the meters", "audit the token system" — or when extending the grant/meter machinery in src/websearch.js, src/websearch-key.js, src/proxy.js, src/proxy-grant.js, src/grant-http.js, src/token-crypto.js, or adding a NEW grant family/service. Owns the invariant checklist (token-fixed/row-metered, concurrency overrun, refund floors, expiry, budget ceilings, account binding, cross-family forgery), the combined-D1-fake test technique, and the cross-subsystem suite src/workspace-grants.test.js.
---

# Quota-grant assessment

The methodology for verifying that the temporary, quota-metered,
account-bound grant tokens hold up — established in the 2026-07-15
assessment that produced `src/workspace-grants.test.js` (15 tests, the
cross-subsystem suite). Load this to re-run the assessment after touching
the grant machinery, or to extend it when a new grant family/service is
added.

## The system under assessment

Two subsystems, one pattern: **the token authenticates, the D1 row meters**
(a self-contained token can't decrement a counter across requests).

| Piece | Files |
|---|---|
| Web-search grant (`wsk1`) | `src/websearch-key.js` (token) + `src/websearch.js` (mint/meter/adjust/revoke, endpoints) |
| Proxy bundle (`prg1` grant → `prx1` proxy, per-service `web`/`api`) | `src/proxy-grant.js` (tokens) + `src/proxy.js` (mint/exchange/meter/adjust, endpoints) |
| Shared crypto primitives | `src/token-crypto.js` (namespaced HMAC `sign` — the namespace IS the family separation) |
| Shared HTTP/clamp layer | `src/grant-http.js` (`resolveQuotaPatch`, `adjustResultResponse`, budget 409) |
| Workspace transport | `public/js/workspace-core.js` (payload carries `wsk1` + `prg1` only) + `public/js/proxy-bundle.js` |

Test suites: per-subsystem (`websearch.test.js`, `proxy.test.js`,
`websearch-key.test.js`, `proxy-grant.test.js`, `grant-http.test.js`,
`token-crypto.test.js`, `workspace-core.test.js`) cover each module in
isolation; **`src/workspace-grants.test.js`** is the cross-subsystem
invariant suite this skill's checklist maps onto. Run everything with:

```bash
node --test src/workspace-grants.test.js   # the invariant suite, ~3 s
npm test                                   # the whole unit suite
```

## The invariant checklist

An assessment is complete when every category below is pinned by a test
that would fail if the property broke. These are the properties that
matter across the seams — the per-module suites can't see them alone.

1. **Token-fixed / row-metered.** After a live quota adjust, the ORIGINAL
   token in circulation obeys the new allowance immediately (spends past
   its stale embedded `quota` claim after a raise; 429s right after a
   pause). The claim is mint-time provenance, never the meter. Adjust
   never moves `expires_at`. Exchanged `prx1` tokens keep working across
   adjusts of their row.
2. **Concurrency overrun.** A `Promise.all` burst of quota+k requests
   yields exactly `quota` 200s and k 429s, `used == quota` after — on BOTH
   subsystems' reserves. (The atomic guard is
   `used < quota AND expires_at >` in one UPDATE.)
3. **Refund floors.** Empty/failed operations refund; `used` never goes
   below 0 (`used > 0` guard); an exhaust → refund → top-up ledger
   balances exactly.
4. **Temporariness.** All token families die at exactly `exp*1000 <= now`
   (verify with the injectable `nowMs`). A lapsed ROW beats a still-valid
   token: reserve blocked (429), exchange refused — simulate by writing
   `expires_at` into the fake's row directly. Adjust cannot resurrect an
   expired grant. The ghost path mints fresh instead of reusing a lapsed
   grant.
5. **Budget ceilings.** `outstanding + increase == budget` passes, +1 is
   409. Pause and expiry both free the ceiling. A proxy adjust counts the
   whole table's outstanding (both services); the two subsystems' budgets
   are INDEPENDENT tables — pin that saturation of one never blocks the
   other.
6. **Account binding.** Minted tokens carry the minter's `uid`; ghost
   grants are per-user AND per-source (`link` rows never reused by the
   ghost path); a foreign owner's adjust is a 404 **byte-identical** to a
   missing jti (`assert.deepEqual` the response bodies — no confirmation
   leak). Admin PATCH reaches any row.
7. **Cross-family forgery.** The full prefix-swap matrix: mint identical
   claims as `wsk1`/`prg1`/`prx1`, relabel each token's prefix as each
   other family — only the diagonal verifies (the prefix gate passes on a
   swap, so the namespace-bound HMAC is what's on trial). At the endpoint
   level, wrong-family tokens 403 with **nothing metered**.
8. **The workspace flow end to end.** Ghost mint → `buildWorkspacePayload`
   (assert no `prx1.` in the serialized payload — only URL-safe tiers
   travel; tokens match `/^[A-Za-z0-9._-]+$/`) → seal → open → apply →
   hydrate (status/exchange, non-consuming) → spend all meters → minter
   pause/top-up via the AUTHED endpoints felt immediately by the holder →
   revoke kills exchange/spend fail-soft (null/403, never a throw) while
   the opened workspace itself stays intact (offline contract).

## The test technique (what made this cheap)

- **One combined in-memory D1 fake** serving BOTH tables
  (`websearch_grants` + `proxy_grants`), routing statements by table name
  in the SQL, mirroring the two per-suite fakes. This is what makes
  cross-subsystem properties (budget independence, the workspace flow)
  testable at all. The reserve guard's check-and-increment stays
  synchronous inside `run()` — an async function runs synchronously to its
  first await, which models D1's row-level atomicity correctly for
  `Promise.all` bursts.
- **Config selects return null** → the real `DEFAULT_CONFIG` applies
  (websearch quota 25; proxy web 25 / api 40). Don't fake config rows.
- **One fetch dispatcher** routes by upstream URL: `berget` → LLM
  response, else → Exa results. Exa's edge cache is fail-soft absent in
  Node (`caches` global doesn't exist), so no cross-test leakage.
- **Direct row manipulation** (`db._ws.get(jti).expires_at = past`) is the
  way to simulate row-vs-token expiry divergence — there is no API for it,
  deliberately.
- **Budget as an option, not config**: `adjustGrantQuota(..., { budget })`
  and `mintWebSearchGrant({ budget })` take the ceiling directly — no need
  to fake the admin config for boundary tests.
- **Mind the KDF cost**: `sealWorkspace`/`openWorkspace` run the frozen
  8192-round SHA-512 KDF (~1 s per open incl. master key). Use ONE
  seal + ONE open for the whole end-to-end test; do revocation and
  fail-soft checks after the spend flow in the same test rather than
  re-opening.

## Gotchas

- **New `src/*.test.js` files enter the committed introspection
  snapshot** — run `npm run bundle` and commit the regenerated
  `public/introspect/source-snapshot.json`, or the freshness test fails
  `npm test`. The rag index (`npm run bundle:rag`, needs a Berget key)
  deliberately EXCLUDES test files and its freshness check only requires
  existing refs to resolve — adding tests does NOT require re-embedding.
- `npm run typecheck` needs `npm install` first in a fresh container
  (dev-only deps).
- The status codes to expect: 400 missing input, 403 bad/expired/revoked
  token or missing row, 429 exhausted/paused (row exists, reserve
  refused), 409 budget, 404 foreign/missing jti on adjust, 503 no D1.

## Extending the assessment

When a NEW grant family or proxied service is added:

1. Give it its OWN HMAC namespace via `token-crypto.js`'s `sign` and add
   it to the forgery matrix (every existing family relabeled as the new
   prefix and vice versa must fail).
2. Add its meter to the combined fake and re-run categories 1–5 against
   it (adjust, burst, refund, expiry, budget).
3. If it can travel in a workspace link, extend the end-to-end flow and
   the "URL-safe tiers only" pin (working credentials never enter a
   link).
4. Keep the not-found indistinguishability: any owner-scoped surface it
   grows must read foreign rows as byte-identical 404s.
