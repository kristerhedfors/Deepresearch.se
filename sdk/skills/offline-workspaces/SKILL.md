---
name: offline-workspaces
description: >-
  Load when building an agent pair's offline workspace links — a fully
  configured client-tier session (provider keys, settings, conversations,
  borrowed grant tokens) sealed into ONE link whose ciphertext rides the URL
  fragment and therefore never reaches any server: the
  [salt][nonce][cipher] base64url wire format, the iterative-KDF dual-key
  split (link key opens the blob; a never-transmitted master key for local
  at-rest use), namespace-from-hash, the URL-safe-token-tiers-only rule,
  minter-administered embedded grants, the reserved-slug rule, and the
  share/mint UX on both tiers. Also load when auditing what a leaked
  workspace link can and cannot expose.
---

# Offline workspace links (fragment crypto)

A workspace is a fully configured client-tier session — provider API keys,
settings, conversations, and optionally a set of temporary quota-bound grant
tokens — serialized to JSON, encrypted, and packed into the URL fragment of
one link: `…/workspace#w=<base64url(salt ‖ nonce ‖ ciphertext)>`. The link
IS the workspace: no server-side record, no storage row, no id. Everything
after `#` is the anchor, which browsers never send in HTTP requests and
strip from referrers — so even the server that serves the static page never
sees the ciphertext, let alone the plaintext. Opening one is completely
offline in the cryptographic sense; the only server involvement is serving
the same static assets it serves everyone.

**Provenance, stated honestly:** the mechanism is cloned element-for-element
from a named prior art — [hacka.re](https://github.com/kristerhedfors/hacka.re)
(its `CRYPTO_SPEC.md` / `crypto-utils.js`), the reference owner's earlier
project — with exactly ONE documented substitution: hacka.re's
XSalsa20-Poly1305 (TweetNaCl) becomes AES-256-GCM, because the reference
ships no crypto dependency (PA-5) and WebCrypto offers no Salsa-family
cipher. Both are AEADs; the 10-byte stored nonce is expanded by a single
SHA-512 exactly as the original does (24 bytes for NaCl there, 12 for the
GCM IV here). A generated pair keeps the provenance note in its module
header — cloned crypto claims its lineage; it does not pretend to be novel.

## Capability class & tier story

**Class C — client-pure.** The seal/open core is a dependency-free,
publicly-served, Node-testable module in the client tree; sealing and
opening work against a static host with zero server contact. The ONE
server-adjacent aspect is what a workspace may CARRY: borrowed grant tokens
from the bridge (class B), which remain quota-metered and live-administered
by their minter under the bridge's existing meters — the workspace adds no
new server data path, only a transport for capabilities that already have
one. Both tiers get a mint surface: the client tier seals its own local
session; the server tier mints its user's crossover grants and seals them
into a link **client-side**, so the server mints tokens but never sees the
password or the assembled link.

## Contracts

- **PA-4 (privacy split)** — the strongest transport form of the split: the
  payload travels only in a fragment no server ever receives; the sole
  server-touching contents are the bridge's existing bounded exceptions,
  reused under their existing meters.
- **PA-5 (minimal deps)** — the one cipher substitution vs the prior art
  exists BECAUSE of this contract; WebCrypto only, no vendored crypto.
- **PA-8 (bridge discipline)** — embedded grants obey every bridge rule
  unchanged: only URL-safe token tiers travel, quotas meter server-side,
  the minter's adjust/pause/revoke reaches a link in the wild instantly.
- **PA-10 (verify)** — seal→open round-trips, tamper/wrong-password
  fail-soft, KDF determinism, and the end-to-end
  mint→seal→open→hydrate→spend→pause→revoke flow are the acceptance gate.

## Build plan

1. **The pure core** — `public/js/workspace-core.js`-equivalent: a
   dependency-free ES module (it may import the pair's base64url helpers),
   import-safe in Node, publicly allowlisted. Freeze the constants on day
   one: salt 10 bytes, nonce 10 bytes, key 32 bytes, **8192 KDF rounds**,
   GCM IV 12 bytes. These are wire-format constants — changing any one
   breaks every link in circulation.
2. **The wire format** — `blob = base64url( salt(10) ‖ nonce(10) ‖
   AES-256-GCM ciphertext )`, carried as `…/workspace#w=<blob>`. Fresh
   CSPRNG salt + nonce per seal, which means: (a) the same workspace sealed
   twice yields two unlinkable blobs; (b) each blob is sealed under a
   unique key, so the derived-IV scheme below can never reuse an IV under a
   key.
3. **The KDF** — iterative SHA-512, 8192 rounds, keeping the full 64-byte
   state each round and slicing to 32 only at the end:
   `linkKey = KDF(password ‖ salt)`. The GCM IV is derived by nonce
   expansion: `SHA-512(nonce)[0:12]`. This KDF is deliberately NOT
   memory-hard (see Pitfalls) — passwords must compensate.
4. **The dual-key split** — alongside the link key, derive
   `masterKey = KDF(password ‖ salt ‖ nonce)`. The master key is
   **never transmitted** and is derivable only by someone who can already
   open the link; reserve it for encrypting the opened workspace at rest
   locally, so nothing on the recipient's disk is decryptable from the link
   blob alone — and the same link + password always re-derives the same
   master key (the multi-tab / persistent-namespace property). `open`
   returns it alongside the payload.
5. **The namespace** — `SHA-256(blob)[0:8 hex]`: a local-storage label
   identifying a workspace on the device (same link → same namespace;
   different links stay isolated) while revealing nothing — it hashes
   ciphertext.
6. **The password** — 12 alphanumeric CSPRNG chars (~71 bits) generated by
   default, or user-chosen; shared **out-of-band**, never part of the link.
   The UI on both tiers must instruct that link and password travel by
   different channels: an attacker needs both artifacts AND pays 8192
   SHA-512 rounds per guess.
7. **Fail-soft opening** — `open` returns `null` on ANY problem (bad
   base64, wrong password, tampered ciphertext, malformed JSON) — never an
   exception, no oracle beyond success/failure. GCM's authentication makes
   this safe: tamper is a hard decrypt failure, never partial plaintext.
   After a successful decrypt, run a structural payload validator before
   applying anything; apply conversations by APPENDING with fresh ids —
   never clobber local data — and overwrite only fields the payload
   carries.
8. **What may travel: the URL-safe-token-tiers-only rule.** A workspace may
   embed grant tokens from the bridge, but ONLY the tiers designed to ride
   URLs — link-grade grant tokens (the reference's `wsk1` and `prg1`
   families; the consolidated JWT once the payload schema carries it).
   Exchanged WORKING credentials (the reference's `prx1`) never enter a
   link — the bridge's two-tier design keeps them out of every URL, and
   the payload builder must assert it (no working-token prefix in the
   serialized payload; every embedded token matches the URL-safe
   character class).
9. **Embedded grants stay minter-administered.** The link is immutable;
   the allowance is not: the tokens are capabilities to metered rows, so
   the minter adjusts quota live — set / ± / pause (quota 0 pauses; clamp
   ≥ 0; increases budget-checked like a mint) — through the bridge's authed
   self-service adjust endpoints (owner-scoped, foreign ids → byte-identical
   404) and the admin's PATCH controls, without changing any token in
   circulation. Revocation (row delete) kills the link's allowance
   instantly. Opening stays offline: keys/settings/chats apply with no
   network; grants hydrate opportunistically through the bridge's fail-soft
   status/exchange paths — a revoked or expired token simply doesn't
   connect, and the opened workspace itself stays intact.
10. **The reserved-slug rule.** If the client tier serves published content
    under `…/<slug>` paths, the workspace path's own slug (`workspace` in
    the reference) must be RESERVED in both the server-side slug validator
    and the client-side path parser — a publication landing there would
    shadow the feature.
11. **The share/mint UX on both tiers** — client tier: a settings pane over
    the CURRENT session (tick what to include; warn explicitly when
    provider API keys are included — the composer must say what a leaked
    link+password would expose). Server tier: an account-settings row that
    mints the user's crossover grants server-side, then builds and seals
    the link entirely client-side. The unlock pane (a `#w=` arrival) is
    many recipients' first contact with the product — link the onboarding
    from it, and open such links in a way that never drops the pending
    fragment. Strip `#w=` from the address bar after opening.
12. **Tests** — KDF determinism + salt sensitivity; dual-key independence;
    seal→open round-trip; wrong-password/tamper/garbage → `null`; namespace
    derivation; fragment/link parsing; payload build→seal→open→apply end to
    end; the URL-safe-tiers pin; and (with the bridge's combined meter
    fake) the full mint→seal→open→hydrate→spend→pause→top-up→revoke flow.

## Reference implementation map

| Concept | File(s) in this repo |
|---|---|
| The pure core (KDF, dual keys, seal/open, namespace, password, payload build/validate/apply) | `public/js/workspace-core.js` (+ `.test.js`) |
| Base64url + the sibling fragment-crypto pattern (ciphertext in query, key in anchor) | `public/js/proxy-bundle.js` |
| The client-tier pane (share composer, `#w=` unlock, fragment strip, grant hydration) | `public/cure/drc.js` (`handleWorkspaceLink`), markup in `public/cure/index.html` |
| The server-tier minting row (grants minted server-side, sealed client-side) | `public/js/account-settings.js` |
| Minter quota-adjust surfaces (self-service + admin) | `src/websearch.js` `adjustGrantQuota` / `handleWebSearchAdjust`; `src/proxy.js` `adjustProxyGrantQuota`; admin `PATCH /api/admin/websearch/:jti`, `/api/admin/proxy/:jti`; shared clamp in `src/grant-http.js` |
| The reserved slug | `src/pub.js` (`pubSlugOk`), `public/js/drc-page-core.js` (`parsePublicationRef`) |
| Public allowlist entry | `src/assets.js` |
| Architecture + threat model + the hacka.re clone table | `docs/WORKSPACE-SECURITY.md`; crypto claims `docs/ENCRYPTION.md` §5.5 (E-26…E-31) |
| Cross-subsystem end-to-end flow suite | `src/workspace-grants.test.js`; methodology in `.claude/skills/quota-grant-assessment/SKILL.md` |
| Working map / operational rules | `.claude/skills/secure-workspaces/SKILL.md` |

## Acceptance checklist

- [ ] KDF suite green: 8192-round determinism, salt sensitivity, full
      64-byte state per round (pinned against a known vector), dual-key
      independence (link key ⊥ master key).
- [ ] Seal→open round-trip green; wrong password / flipped bit / truncated
      blob / junk input all return `null`, never throw.
- [ ] Two seals of the same payload yield unlinkable blobs (fresh
      salt+nonce), and the namespace differs.
- [ ] Payload pin: no working-credential token in any serialized payload;
      every embedded token matches `/^[A-Za-z0-9._-]+$/`.
- [ ] Apply semantics: conversations appended with fresh ids; local state
      never clobbered; structural validation rejects wrong-shape payloads
      after a successful decrypt.
- [ ] End-to-end flow green over the combined meter fake: mint → seal →
      open → hydrate (non-consuming) → spend to exhaustion → minter pause
      felt immediately → top-up (budget-checked) → revoke fails soft while
      the opened workspace stays intact.
- [ ] Reserved slug pinned in both the server validator and the client
      parser.
- [ ] Live probe: mint a link, open it in a private window, confirm unlock
      → apply → grant hydration, and that the fragment is stripped from the
      address bar and absent from server logs.
- [ ] The provenance note (prior art + the one substitution) present in the
      core's module header.

## Pitfalls

- **The KDF is a provenance clone, not a modern password-KDF choice.**
  8192×SHA-512 is not memory-hard; a GPU adversary holding a blob guesses
  far faster than against Argon2id. The reference accepts this
  (ENCRYPTION.md §11-2) with compensating controls: generated ~71-bit
  passwords, fragment-only transport, channel separation. Residual risk
  concentrates on weak USER-CHOSEN passwords — keep the generator the
  default and the warning honest. And never "optimize" the test suite by
  lowering the round count: the ~15 s the workspace suite costs IS the
  design working.
- **Frozen constants, again.** Salt/nonce lengths, round count, the
  expansion slice — all wire format. The reference pins them with tests
  precisely so a well-meaning tuning PR fails loudly instead of stranding
  every shared link.
- **Never let workspace content near a query param or a server round-trip.**
  The fragment-only rule is the entire security model; a debugging
  convenience that mirrors the blob into a query string (for logging, for
  a redirect) silently hands ciphertext to server logs — and the sibling
  bundle pattern (`?rp=` + `#rk=`) exists for exactly the case where a
  query-visible blob is acceptable because the KEY stays in the fragment.
- **Open-in-new-tab or lose the blob.** The reference's unlock pane links
  its onboarding page with `target=_blank` because navigating the unlock
  tab drops the pending `#w=` fragment — a recipient who clicks "what is
  this?" would destroy their own link.
- **Hydration is optional; treat it that way.** The workspace must open
  fully offline. Grant hydration (status read, exchange) is opportunistic
  and fail-soft — wiring it as a blocking step makes every expired token a
  broken workspace instead of a workspace without a borrowed allowance.
- **The append-don't-clobber rule earns its test.** Applying a payload
  over an existing local session was the reference's scariest edge:
  imported conversations get FRESH ids and merge in; a newer local state
  wins over an older import. The same rule guards the encrypted-backup
  import path in `drc-core.js` — reuse it, don't re-derive it.
- **XSS in the client tier's origin is out of scope here** — as in the
  prior art's own spec: a rogue script in the origin reads everything the
  page can. That is the site-wide CSP's job (tracked in the reference's
  SECURITY-RISKS.md), not this module's; don't let its impossibility here
  be used to argue the fragment crypto is pointless.
