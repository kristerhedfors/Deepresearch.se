# Secure workspaces — security architecture

> **Scope note (2026-07-25).** This document is the security architecture of
> the **Se/cure workspace LINK** — its envelope, its crypto lineage, its
> threat model. The workspace *concept* across both tiers — the two kinds,
> what each holds and exposes, the distribute→aggregate channels, and the
> two surfaces specified ahead of the code (the arrival disclosure and 👍/👎
> message curation) — is **`docs/WORKSPACES.md`**. Read that first for the
> whole picture; read this one for the link's cryptography.

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
| `grants.pool` | a `pt1.…` shared-compute pool token (minted fresh for the workspace when the sharer includes grants) | prompts relayed through this server to the pool owner's machine: a **bounded, metered**, revocable allowance, but *the owner's machine sees everything sent* — every recipient is shown the shared-compute data-flow notice on unlock (`public/js/pool-core.js`) and the crossing needs mutual consent (`docs/COMPUTE-SHARING.md` §8b) |

Two deliberate token rules:

1. **Only URL-safe tiers travel.** The workspace embeds the web-search token
   (`wsk1`, designed for `?ws=` links) and the proxy **grant** tokens
   (`prg1`, the "token-granting tokens" designed to ride URLs) — never the
   working `prx1` proxy tokens, which stay out of every URL by the two-tier
   design (`src/proxy-grant.js`). The `pt1` pool token qualifies by the same
   reasoning: it authorizes only submitting completion jobs to the one pool
   it names, and is quota- and revocation-governed on that pool's row.
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

The workspace TRANSPORT still adds no server data path: it is fragment-only
(server-blind), and the grant tokens it carries for the first two exceptions
(`grants.ws`, `grants.proxy` — the web-search grant and the
secure-research-space proxy bundle) are reused under their existing meters
and governance. The quota-adjust endpoints are new *control* surfaces over
those meters, not new data paths.

Two things a workspace enables DO reach this server and are counted as the
third and fourth exceptions to invariant 4 (owner ruling, 2026-08-15):

1. **Shared compute** — `grants.pool` carries a `pt1` pool token
   (`public/js/workspace-core.js`; minted in `public/cure/drc.js`). Using it
   relays the consumer's prompt through the server's blind job queue to the
   pool owner's machine (`/api/pool/llm`, `src/pool.js`). Governed by the
   compute-sharing framing, the mutual-consent gate and the data-flow notice
   every recipient sees (`docs/COMPUTE-SHARING.md` §8b,
   `docs/PRIVACY-MODEL.md`).
2. **Workspace knowledge** — the curation flow seals a conclusion to the
   site's import-agent public key and POSTs it to `/api/knowledge/submit`
   under that same pool token. The envelope rests as ciphertext in D1
   `knowledge_inbox`, but the agent's private half is in D1
   `knowledge_agent.private_jwk`, so **the server can decrypt it**
   (`src/knowledge.js`). That is a deliberate, disclosed data path of its
   own, not a reuse of the first two exceptions. For knowledge the server
   must never read, the DRCR/1 campaign path (§6a, client-held keys) is the
   tool.
