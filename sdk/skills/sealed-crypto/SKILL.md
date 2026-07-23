---
name: sealed-crypto
description: >-
  Load when building a platform's sealed client-side crypto core — the
  user-held-secret key hierarchy the whole privacy plane rests on: copy-safe
  Crockford-base32 secrets with forgiving normalization, HKDF-independent
  derivations (public reference vs blob id vs blob key), AES-256-GCM archive
  sealing with tamper detection, the master-secret profile that keeps
  provider API keys INSIDE the sealed state, and the publicly-served
  dependency-free pure-core rule. Also load when auditing a generated platform's
  derivation constants, when a sibling subsystem needs its own derivation of
  the SAME secret, or when any change touches a frozen HKDF info string.
---

# Sealed client-side crypto core

The one crypto module the client tier's structural privacy claim rests on: a
dependency-free, publicly-served, Node-testable pure core that turns ONE
user-held secret into an entire key hierarchy — a locator, an encryption
key, and (for the client-tier profile) a public reference — such that the
server never sees the secret, any derived value, or any plaintext, and could
not decrypt even under full compromise. Everything else in the privacy plane
(ciphertext storage's blind-blob vault, the client tier's sealed state,
offline workspace payloads) builds on these primitives instead of inventing
crypto of its own.

## Capability class & tier story

**Class C — client-pure.** The core runs wholly in the browser (and in Node
for tests); it must work served from a static host. The server tier
*consumes* it in exactly one way: as the sealing format of blind blobs it
stores without being able to read (see `ciphertext-storage`). The client
tier builds its whole persistence model on it. The module graph rule is
absolute: the core imports NOTHING, and no server-backed (class S) module
may ever enter its import chain — in the reference this constraint was
learned live when a storage-orchestration import 401'd the public module
graph and killed the entire client tier (see Pitfalls).

## Contracts

- **PA-4 (privacy split)** — this module IS the structural (strongest) form
  of the split: content sealed under user-held secrets rests as ciphertext
  everywhere, and the key material is never at rest beside it — nor at rest
  anywhere at all.
- **PA-5 (minimal dependencies)** — WebCrypto primitives only
  (`crypto.subtle`, `crypto.getRandomValues`); zero third-party crypto
  dependencies is a standing invariant of the reference and must be of any
  generated platform.
- **PA-7 (shared-core rule)** — the core lives under the client module tree,
  is import-safe in Node, and is the ONE implementation every consumer
  (client tier, vault orchestration, workspace crypto) builds on; no
  hand-mirrored copies.
- **PA-10 (verify live / measure)** — determinism, independence, and tamper
  suites are the acceptance gate; a derivation change that breaks a stored
  secret must fail `npm test` before it can ship.

## Build plan

1. **Create the core module** — `public/js/sealed-core.js` (name it for what
   it is; the reference calls it `vault-core.js` for historical reasons).
   Rules of the file: `// @ts-check`-able plain ES module, imports nothing,
   no top-level DOM/storage access, every export pure or WebCrypto-async.
   Add it to the server's public-asset allowlist the moment it exists — the
   client tier's anonymous page must be able to load it.
2. **The secret format.** Define the alphabet
   `0123456789ABCDEFGHJKMNPQRSTVWXYZ` (Crockford base32: no I, L, O, U —
   nothing that misreads as 1 or 0), `SECRET_BYTES = 20` (160 bits, 32
   chars at 5 bits each), and a short uppercase `PREFIX` (e.g. `DR1`) that
   marks *what the string is* — a format label, never counted as entropy.
   `generateSecret()` = 160 bits from `crypto.getRandomValues`, rendered as
   `PREFIX-XXXX-XXXX-…` (8 groups of 4). Pick the prefix once and freeze it:
   it will end up in password managers and on paper.
3. **Forgiving normalization** — `normalizeSecret(input)`: uppercase, strip
   every non-alphanumeric, map the classic transcription misreads back
   (O→0, I→1, L→1) **before** the prefix check so even a mangled prefix
   ("DRl-…", "DRi-…") is recognized and stripped, then strip the prefix if
   present. `secretValid()` = normalized length is exactly 32 and every char
   is in the alphabet. This is the password-manager/paper/phone-call
   compatibility layer: a secret retyped from a photo or read aloud still
   works. Add the bit-exact `encodeCrockford`/`decodeCrockford` codec (no
   padding) alongside.
4. **The HKDF derivation pattern.** One helper imports the decoded secret as
   HKDF-SHA-256 IKM; one helper builds params
   `{ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(32), info }`.
   The **zero salt is deliberate and justified only here**: the IKM is
   already uniform CSPRNG output, which is the one case RFC 5869 explicitly
   permits a zero salt for — domain separation is carried entirely by the
   `info` strings. Every derived value gets its OWN info string, versioned
   (`"<product> vault id v1"`, `"<product> vault key v1"`), so all outputs
   are cryptographically independent: the locator reveals nothing about the
   key and vice versa. **Freeze the info strings the day the first secret is
   generated** — they are derivation constants that must survive product
   renames, file moves, and refactors forever (the reference still says
   "free" in its client-profile strings, from a pre-rename era, on purpose).
5. **The blind-blob pair of outputs** (the vault profile): `id` =
   HKDF(info=`…id v1`, 160 bits) → Crockford string, the storage locator;
   `key` = HKDF(info=`…key v1`) → a **non-extractable** AES-256-GCM
   `CryptoKey`. Knowing the secret is both *finding* the blob and
   *decrypting* it; the server stores an unlabeled opaque object it can
   neither locate without the id nor read with it.
6. **Archive sealing** — `encryptArchive(key, obj)` /
   `decryptArchive(key, bytes)`: JSON-serialize, seal as
   `12-byte CSPRNG IV ‖ AES-256-GCM ciphertext` — wire form and stored form
   are the same bytes. GCM's authentication tag is the tamper detection:
   wrong key or a flipped bit is a hard decrypt failure, never garbage
   plaintext. Add an archive-shape validator so a successful decrypt of the
   wrong *kind* of blob is also rejected. Include the **chunked base64
   helpers** (`bytesToB64`/`b64ToBytes` processing in bounded slices) —
   naive `String.fromCharCode(...bytes)` over a multi-MB archive blows the
   call stack.
7. **The client-tier master-secret profile** — a second thin module
   (`public/js/master-profile.js`; the reference: `drc-core.js`) that
   *builds on* the core rather than duplicating it: the SAME secret format
   and CSPRNG routine, HKDF with **three** independent info strings —
   - `refHash` (80 bits, lowercased) — the PUBLIC project reference: the
     `<hash>` in a bookmarkable deep link and the *username* the password
     manager files the secret under. Deliberately NOT a capability —
     knowing it grants nothing; document that in the module header.
   - `blobId` (160 bits) — the browser-local storage key the sealed state
     rests under.
   - `blobKey` (AES-256-GCM, non-extractable) — the sealing key.
   The profile's info strings must be distinct from the vault's, so the two
   subsystems' derivations of the SAME secret are mutually independent —
   pin that independence with a test. Any future sibling subsystem gets its
   own info-string family the same way; never reuse another's.
8. **The sealed state contains everything** — conversations, settings, the
   client-side RAG index (chunk text AND vectors), and **the user's
   provider API keys**. Version the state with an integer constant and
   evolve it additively (the reference: v2 moved keys inside, v3 added RAG,
   v4 added the local-server URL) with explicit migration on open. The seal
   reuses the archive format verbatim — invent nothing.
9. **Password-manager compatibility as a design input.** The UI that
   presents the secret must be a REAL username+password form
   (`autocomplete="username"` on the public reference,
   `"current-password"` on the secret field, switched to `"new-password"`
   on generate) so 1Password/Apple Passwords offer to save and autofill.
   The secret has **no recovery and no rotation** — losing it loses the
   data, a leaked one means re-creating under a new secret. Say so plainly
   in UI copy; do not soften it.
10. **Tests before wiring anything on top** — a Node suite pinning:
    generation format/entropy/uniqueness; normalization (case, separators,
    misreads, mangled prefix); codec round-trip; derivation determinism;
    independence of every derived value from every other AND from the
    sibling subsystem's derivation of the same secret; archive
    encrypt/decrypt round-trip; tamper → hard failure; state round-trip
    with API keys unreadable in the stored form; migration paths.

## Reference implementation map

| Concept | File(s) in this repo |
|---|---|
| The dependency-free pure core (secret, codec, HKDF, archive, chunked base64) | `public/js/vault-core.js` |
| The client-tier master-secret profile (refHash / blobId / blobKey, sealed state, versioning) | `public/js/drc-core.js` (`deriveDrcProfile`, `DRC_STATE_V`) |
| The blind-blob consumer (server stores what it cannot read) | `src/vault.js` + `public/js/vault.js` |
| The sealed-state store seam (localStorage rows of ciphertext) | `public/js/drc-store.js` |
| Public-asset allowlist entry | `src/assets.js` (`isPublicAsset`) |
| Frozen-constant discipline + zero-salt justification | `docs/ENCRYPTION.md` §5.3–5.4, §9 (claims E-20…E-25) |
| Test suites | `src/vault.test.js` (via `vault.js` re-exports), `public/js/drc-core.test.js` |
| Password-manager form wiring | `public/js/projects-ui.js`, `public/cure/drc.js` |

## Acceptance checklist

- [ ] Core imports nothing; `node --test` runs the suite with no DOM shims.
- [ ] Secret suite green: 160-bit CSPRNG, format, uniqueness, normalization
      incl. misreads-before-prefix, codec round-trip.
- [ ] Derivation suite green: determinism; every output independent of every
      other; profile outputs independent of the vault outputs for the SAME
      secret (distinct info strings pinned by name).
- [ ] Archive suite green: seal→open round-trip; tampered byte → hard
      failure, never partial plaintext; shape validator rejects foreign
      blobs.
- [ ] Sealed-state round-trip: provider API keys present after open,
      unreadable (no substring match) in the stored form.
- [ ] No plaintext key material at rest anywhere in the module; derived
      `CryptoKey`s non-extractable.
- [ ] The core is on the server's public allowlist; the client tier's page
      loads it anonymously (live probe on a fresh browser).
- [ ] Info strings and the state-kind constant documented as FROZEN in the
      module header, with the version integer and migration notes.

## Pitfalls

- **The dead-module-graph incident (2026-07-11).** The reference's `/cure`
  page went completely dead in production because `drc-core.js` originally
  imported `vault.js`, whose store/load orchestration statically imports the
  DRS storage stack (`history-store.js`/`opfs.js`/`projects.js`) — none of
  which are public assets, so anonymous visitors got a 401 mid-graph and the
  whole tier's JS died. The fix was the core split itself: `vault-core.js`
  is allowlisted and dependency-free; `vault.js` deliberately is NOT public.
  When generating a platform, create the split from day one.
- **Frozen constants survive renames.** `drc-core.js`'s info strings say
  `"deepresearch.se free ref v1"` etc. — "free" predates the product name.
  Renaming them would silently break every existing secret and sealed state.
  A generated platform should choose neutral strings, then never touch them; a
  "cleanup" PR that modernizes an info string is a data-loss bug.
- **Misreads map BEFORE the prefix strip.** `normalizeVaultSecret` maps
  O→0/I,L→1 first so `DRl-…` still parses. Reordering the two steps passes
  every happy-path test and fails real users retyping from paper.
- **The zero HKDF salt is NOT a general pattern.** It is safe here solely
  because the IKM is 160 uniform CSPRNG bits. Deriving from a *password*
  with this pattern would be a vulnerability — passwords go through the
  workspace module's iterative KDF (see `offline-workspaces`), never
  through bare HKDF.
- **Chunked base64 is load-bearing.** Reference archives run to tens of MB
  (file originals inside); the chunked helpers exist because the naive
  spread-into-`String.fromCharCode` version crashed on real archives.
- **No recovery is the feature.** Every support-shaped instinct ("add a
  reset email", "escrow the key server-side") re-introduces the server into
  the trust boundary and voids the tier's structural claim. The reference's
  UI copy states loss-is-loss plainly; keep that in any generated platform.
- **`crypto.subtle` needs a secure context.** Serve the client tier over
  HTTPS in every environment including previews, or the core throws at
  import-adjacent time on `crypto.subtle` being undefined — Node ≥ 18 and
  all modern browsers on HTTPS are fine.
