# Secure workspaces — security architecture

*(2026-07-15, owner directive. The feature: shareable, completely OFFLINE
Se/cure workspaces contained ONLY in the link that opens them, with the
mechanism cloned as closely as possible from
[github.com/kristerhedfors/hacka.re](https://github.com/kristerhedfors/hacka.re),
the owner's prior project. This document is the security architecture; the
implementation is `public/js/workspace-core.js` (pure core, Node-tested) plus
the `/cure/workspace` pane wiring in `public/cure/drc.js` and the Se/rver-side
minting row in `public/js/account-settings.js`.)*

## 1. What a workspace is

A **secure workspace** is a fully configured Se/cure session — provider API
keys, settings (research knob, sandbox, introspection, web-search backend),
conversations, and optionally a set of **temporary quota-bound grant tokens**
— serialized to JSON, encrypted, and packed into the **URL fragment** of one
link:

```
https://deepresearch.se/cure/workspace#w=<base64url( salt ‖ nonce ‖ ciphertext )>
```

The link **is** the workspace. There is no server-side record of it, no
storage row, no id. Everything after `#` is the anchor, which browsers do
not send in HTTP requests and strip from referrers, so even the server that
serves the static page never sees the ciphertext, let alone the plaintext.
Opening a workspace is **completely offline** in the cryptographic sense:
the only server involvement is serving the same static `/cure` assets it
serves everyone.

Every user "has" a workspace by construction: `/cure/workspace` with no
fragment opens the share composer over the CURRENT session; with a `#w=`
fragment it opens the unlock flow. Both tiers can mint:

- **Se/cure** (`/cure` → Settings → Secure workspace): seals the local
  session — keys, settings, chats, and any borrowed allowances it holds.
- **Se/rver** (the header's share icon, or account panel → *Share a Se/cure
  workspace* — a DEDICATED view, kept separate from the gear-icon Settings so
  it shows only what a link can lend): mints the signed-in account's temporary
  grants (the same ghost-crossover allowances) and seals them into a workspace
  link **client-side**. The server mints tokens but never sees the password or
  the assembled link. The view surfaces which capabilities can travel — web
  search (Exa) and the LLM **& embeddings** capability (Berget: completions
  plus the e5 embedding model that powers a borrowed session's RAG, both on the
  one `api` grant), each a per-link switch — and shows the server-only
  integrations (Shodan, Google Maps, and the automatic OpenStreetMap / Hugging
  Face enrichments) off-and-disabled with the reason they can't cross to a
  client-side session (server-side keys; no server may sit in a Se/cure data
  path).

## 2. The mechanism, cloned from hacka.re

hacka.re's shared-link system (its `CRYPTO_SPEC.md` / `js/utils/crypto-utils.js`)
is copied element for element:

| Element | hacka.re | Here |
|---|---|---|
| Wire format | `[salt(10)][nonce(10)][ciphertext]`, URL-safe base64, in the fragment | **identical** (`#w=` instead of `#gpt=`) |
| KDF | iterative SHA-512, **8192 rounds**, all 64 bytes kept per round, sliced to 32 at the end | **identical algorithm** (`deriveLinkKey`) |
| Dual keys | decryption key = KDF(password‖salt); **master key** = KDF(password‖salt‖nonce), never transmitted | **identical** (`deriveLinkKey` / `deriveMasterKeyHex`) |
| Namespace | first 8 hex chars of SHA-256(blob) | **identical** (`workspaceNamespace`) |
| Password | 12 alphanumeric chars (~71 bits), generated or chosen, shared out-of-band, never in the URL | **identical** (`generateWorkspacePassword`) |
| Nonce expansion | one SHA-512 over the 10-byte stored nonce, sliced to the cipher's IV size | **identical expansion** (sliced to 12 for GCM instead of 24 for NaCl) |
| AEAD cipher | XSalsa20-Poly1305 (TweetNaCl) | **AES-256-GCM** (WebCrypto) — the one substitution |

The single substitution is forced by this repo's minimal-dependency
invariant: hacka.re vendors TweetNaCl; this project ships **no crypto
dependency**, and WebCrypto (available identically in the Worker, the
browser, and Node ≥ 18) offers no Salsa-family cipher. AES-256-GCM is the
same class of primitive (authenticated encryption; wrong password or a
flipped bit fails closed to `null`), so the security architecture (what is
derived from what, what travels where, what the server can see) is
unchanged.

### The dual-key property

The **link key** (password + salt) opens the blob. The **master key**
(password + salt + nonce) is *derivable only by someone who can already open
the link*, is never transmitted, and is reserved for encrypting the opened
workspace at rest locally. Nothing stored on a device is decryptable
from the link blob alone, and the same link + password always re-derives the
same master key (hacka.re's multi-tab / persistent-namespace property).
`openWorkspace` returns it alongside the payload.

### Password channel separation

The password is never part of the link. The UI (both tiers) instructs the
sharer to send the link and the password through **different channels**. An
attacker needs both artifacts AND must pay 8192 SHA-512 rounds per guess
(hacka.re's "computational irreducibility" — a deliberate work factor on
offline brute force of weak passwords; the generated 12-char alphanumeric
default is ~71 bits, far beyond brute force even without the KDF).

## 3. What a workspace can carry, and what each part exposes

| Section | Contents | Exposure if the link+password leak together |
|---|---|---|
| `keys` | the user's own provider API keys (+ provider/model choice) | full use of those keys until rotated — the composer warns explicitly when keys are included |
| `settings` | booleans + the web-search backend config (may include a self-hosted service key) | configuration only |
| `conversations` | plain chat turns | the shared conversations, nothing else |
| `grants.ws` | a `wsk1.…` web-search grant token | a **bounded, metered** number of server-paid searches — same exposure class as an admin `?ws=` link |
| `grants.proxy` | `prg1.…` proxy GRANT tokens (web / api) | a **bounded, metered** allowance on the minter's account — same exposure class as an admin `?rp=…#rk=…` link |

Two deliberate token rules:

1. **Only URL-safe tiers travel.** The workspace embeds the web-search token
   (`wsk1`, designed for `?ws=` links) and the proxy **grant** tokens
   (`prg1`, the "token-granting tokens" designed to ride URLs) — never the
   working `prx1` proxy tokens, which stay out of every URL by the two-tier
   design (`src/proxy-grant.js`).
2. **The workspace itself opens offline; grants hydrate opportunistically.**
   Applying keys/settings/chats needs no network. The embedded grant tokens
   are handed to the existing fail-soft paths (`/api/websearch/status`
   non-consuming read; `/api/proxy/exchange`) — revoked or expired tokens
   simply don't connect.

## 4. The minter's live control: quota per token

The owner's requirement: *the minting user controls the tokens — adding or
removing quota per token.* The tokens are **capabilities to a metered D1
row**, not bearer amounts: the signed token authenticates, the row meters
(`used < quota`, atomic reserve/refund). So the allowance is administered
**live, without ever touching the links in circulation**:

- **Self-service (the minting user):** authed `POST /api/websearch/adjust`
  and `POST /api/proxy/adjust` — `{ jti, quota }` (absolute) or `{ jti,
  delta }` (relative), scoped to rows the caller minted (`user_id` match; a
  foreign jti reads as 404, never confirming its existence).
- **Admin (any grant):** `PATCH /api/admin/websearch/:jti` and
  `PATCH /api/admin/proxy/:jti`, with ±/Set controls on the grant rows in
  the `/admin` panel.
- Quota clamps at ≥ 0 — **quota 0 pauses** a token (the meter's
  `used < quota` guard stops reserving) and remaining reads clamp at 0.
- **Increases are budget-checked** against the same global
  outstanding-remaining ceiling as a mint, so handing out workspace links
  can never mint unbounded server spend.
- Revocation (row delete) still kills a token instantly.

## 5. Threat model

| Threat | Mitigation |
|---|---|
| Link leaks (chat log, history sync, shoulder surf) | ciphertext only; password out-of-band; 8192-round KDF on guesses |
| Password leaks without the link | nothing — the password alone locates and reveals nothing |
| Server compromise / logging | the fragment never reaches the server; there is nothing server-side to log or seize for the workspace itself |
| Referrer / history leakage | fragments are stripped from referrers; the app strips `#w=` from the address bar after opening |
| Tampered blob | AEAD (GCM) authentication fails closed → `null`, never a partial apply |
| Grant token abuse from a leaked workspace | quota-metered rows, global budget ceiling, TTL expiry, minter pause (quota 0) and revoke |
| Wrong-shape payload after successful decrypt | `validateWorkspacePayload` structural check; conversations are APPENDED with fresh ids, never clobbering local data |
| XSS in the /cure origin | out of scope of this feature (as in hacka.re's spec: a rogue script in the origin can read everything the page can) — mitigated site-wide by the CSP work tracked in SECURITY-RISKS.md |

## 6. The interchange standard (DRSW/1)

Since 2026-07-17 the workspace bundle is also specified as an OPEN STANDARD
(**DRSW/1, `docs/WORKSPACE-PROTOCOL.md`**) so other sites (on this source
code or entirely separate foundations) can implement the same envelope and
payload and MOVE workspaces between nodes: the required/optional section
registry, reader/writer conformance rules, test vectors generated from this
implementation, node discovery (`/.well-known/drsw.json`), the re-seal-per-hop
handoff, and the interchange extensions (`origin`, `pipelines`, `provenance`,
`route`, issuer-scoped `grants.tokens`). The pipeline-structure language
workspaces carry is `docs/PIPELINE-LANGUAGE.md` (DRPL); the vision both serve
is `docs/STACKLESS-RESEARCH.md`. This document remains the security
architecture of the DEPLOYED implementation; the protocol document
deliberately leads the code on the interchange extensions.

## 6a. Crowd research — distributed workspaces (DRCR/1)

Since 2026-07-23 the workspace is also the substrate for **crowd-sourced /
distributed deep research** — `docs/CROWD-RESEARCH.md` (**DRCR/1**). A Se/rver
organizer fans out a set of invite links (each a workspace carrying a new
`campaign` section: a per-campaign project PUBLIC key, an alias, the seeded
task), participants research in their own Se/cure sessions, and each **seals
their conclusion to the organizer's public key** and returns it by QR / file /
link. The organizer's live dashboard merges the returned results (a
Mentimeter-for-research model). This adds the ONE asymmetric primitive the
symmetric workspace envelope does not have — an ECIES sealed box (ECDH P-256 →
HKDF-SHA-256 → AES-256-GCM), seeded in `public/js/research-seal-core.js` and
specified in `docs/CROWD-RESEARCH.md`. The privacy accounting (where the crowd
flow does and does not touch a server) is that document's §7; the deployed
symmetric workspace below is unchanged.

## 7. Relationship to invariant 4 (the privacy split)

Secure workspaces add **no new server data path**. The transport is
fragment-only (server-blind), and the only server-touching contents (the
grant tokens) are exactly the two existing, deliberate, bounded exceptions
(the web-search grant and the secure-research-space proxy bundle), reused
under their existing meters and governance. The quota-adjust endpoints are
new *control* surfaces over those existing meters, not new data paths.
