---
name: secure-workspaces
description: Load when working on SECURE WORKSPACES — the shareable, completely offline Se/cure workspaces contained only in a link (/cure/workspace#w=<ciphertext>) — or anything touching public/js/workspace-core.js (the hacka.re-cloned link crypto), the /cure/workspace pane in public/cure/drc.js, the Se/rver share row in public/js/account-settings.js, the per-token quota-adjust endpoints (POST /api/websearch/adjust, POST /api/proxy/adjust, PATCH /api/admin/websearch/:jti, PATCH /api/admin/proxy/:jti), or the reserved "workspace" publication slug. Also load for "share a workspace", "offline link", "workspace link", or hacka.re-mechanism questions.
---

# Secure workspaces

The full security architecture lives in **`docs/WORKSPACE-SECURITY.md`** —
read it first for anything non-mechanical. This skill is the working map.

## What it is

A workspace = a fully configured Se/cure session (keys, settings, chats,
borrowed grant tokens) sealed into ONE OFFLINE LINK:
`/cure/workspace#w=<base64url(salt10 ‖ nonce10 ‖ AES-256-GCM ciphertext)>`.
The fragment never reaches any server; the link IS the storage. Mechanism
cloned from github.com/kristerhedfors/hacka.re (owner directive,
2026-07-15): 8192-round iterative-SHA-512 KDF, dual keys (link key =
KDF(pw‖salt); never-transmitted master key = KDF(pw‖salt‖nonce)), namespace
= first 8 hex of SHA-256(blob), 12-char alphanumeric password shared
out-of-band. The ONE substitution vs hacka.re: AES-256-GCM instead of
XSalsa20-Poly1305 (no TweetNaCl dependency here; WebCrypto has no Salsa).

## The file map

| Piece | File |
|---|---|
| Pure core (crypto + payload build/apply/validate; Node-tested) | `public/js/workspace-core.js` + `.test.js` |
| /cure pane wiring (share composer + `#w=` unlock; `handleWorkspaceLink`) | `public/cure/drc.js` (+ markup in `public/cure/index.html`, styles in `drc.css`) |
| Se/rver minting row (ghost grants → link, sealed client-side) | `public/js/account-settings.js` |
| Per-token quota adjust (websearch) | `src/websearch.js` `adjustGrantQuota` + `handleWebSearchAdjust`; admin `PATCH /api/admin/websearch/:jti` |
| Per-token quota adjust (proxy) | `src/proxy.js` `adjustProxyGrantQuota` + `handleProxyAdjust`; admin `PATCH /api/admin/proxy/:jti` |
| Admin ± / Set… quota controls | `public/js/admin.js` grant/bundle lists |
| Reserved slug ("workspace" is never a publication) | `src/pub.js` `pubSlugOk`, `public/js/drc-page-core.js` `parsePublicationRef` |
| Public allowlist entry | `src/assets.js` (`/js/workspace-core.js`) |

## Rules that must hold

1. **Fragment-only transport.** The blob rides `#w=` (never the query); the
   app strips it from the address bar after opening. Never move workspace
   content into a query param or a server round-trip.
2. **Only URL-safe token tiers travel.** `wsk1` web-search tokens and `prg1`
   proxy GRANT tokens may be embedded; working `prx1` proxy tokens NEVER
   enter a link (two-tier design, src/proxy-grant.js).
3. **KDF constants are FROZEN** (salt 10, nonce 10, 8192 rounds, the
   expansion). Changing any breaks every workspace link in circulation.
4. **Fail-soft opens.** `openWorkspace` returns null on any problem;
   `applyWorkspacePayload` APPENDS conversations with fresh ids and only
   overwrites fields the payload carries. Grant hydration is optional and
   fail-soft (status read / exchange).
5. **Quota adjust is a control surface, not a data path.** Adjusts move the
   D1 row's quota (clamp ≥ 0; 0 = paused; increases budget-checked like a
   mint; owner scoping via `user_id`, foreign jti → 404). The tokens in
   circulation never change.
6. **"workspace" stays a reserved slug** in both pub.js and the client
   parser — a publication there would shadow the feature.

## Verifying changes

`node --test public/js/workspace-core.test.js src/websearch.test.js
src/proxy.test.js src/pub.test.js public/js/drc-page-core.test.js` covers
the core round-trip/dual-key/tamper cases, the adjust meter + endpoints, and
the reserved slug. `node --test src/workspace-grants.test.js` is the
CROSS-subsystem invariant suite for the quota-bound tokens a workspace
carries: the token-fixed/row-metered split under live adjusts, concurrency
overrun proofs, refund floors, expiry (row beats token; adjust can't
resurrect), budget ceilings (freed by pause/expiry, independent per
subsystem), owner-scoped 404 indistinguishability, the wsk1/prg1/prx1
prefix-swap forgery matrix, and the full mint → seal → open → hydrate →
spend → pause/top-up → revoke flow. The pane wiring is verified live (live-verify skill):
mint a link from `/admin` or the account panel, open it in a private window,
check the unlock → apply → grant-hydration flow and that the fragment is
stripped. The workspace-core suite costs ~15 s (the 8192-round KDF is the
point — don't "optimize" the tests by lowering rounds).
