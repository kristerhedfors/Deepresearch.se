# DRCR/1 — Deep Research Crowd Research (distributed secure workspaces)

*(2026-07-23, owner directive. This document specifies the **complete
information flow and workflow** for a use case not yet covered technically:
**crowd-sourced / distributed deep research**. A Se/rver user (the
**organizer**) sets up one shared research task, mints a fan of invite links,
each with its own password and its own **alias identity**, and hands them
out. Each recipient (a **node**) does their part of the research in their own
Se/cure session, packages the conclusions, **seals them to the organizer's
project public key**, and channels the sealed result back by link, file,
message, or **QR code**. The organizer watches a **live dashboard**, one per
campaign, showing lights, activity notifications, and an aggregate conclusion
that updates as results arrive. Think of it as **Mentimeter for deep
research**: the pipeline merges the returned conclusions into one answer.*

*This builds on the secure-workspace machinery (`docs/WORKSPACE-SECURITY.md`)
and the DRSW/1 interchange protocol (`docs/WORKSPACE-PROTOCOL.md`). It adds
three things DRSW/1 does not have. First, an **asymmetric** result-sealing
envelope: every crypto path today is symmetric password-KDF, and sealing a
result **to** the organizer without letting the recipient read other
recipients' results needs public-key crypto. Second, **multi-alias campaign
minting**: one task, many links, many identities. Third, a **server-side
aggregation dashboard**. Like everything here it is EXPERIMENTAL, a research
artifact into the privacy capabilities of LLM applications, not a finished
product. The status section (§11) states plainly what is seeded in code vs.
specified ahead of it, per this repo's spec-first culture.)*

The key words **MUST**, **MUST NOT**, **SHOULD**, **SHOULD NOT**, **MAY** are
to be interpreted as in RFC 2119.

## 1. The use case

The current pipeline is one machine researching one question. The crowd model
distributes the question across many people (or many of one person's devices)
and folds their answers back together:

> An organizer poses "*What is the state of open-source phone-inference
> runtimes in 2026?*". They cut ten invite links — `#alpha`, `#beta`, … each
> with its own password — and message them to ten researchers. Each researcher
> opens their link on a phone or laptop, lands in a ready-to-go Se/cure session
> seeded with the task and their slice of it, runs the deep-research pipeline on
> their own keys (or on borrowed grants the link carries), and gets a
> conclusion. They tap **Return result** → a QR code appears → the organizer's
> phone (or the dashboard's camera) reads it. On the organizer's dashboard the
> `#beta` light turns green, a notification says "beta returned", and the
> **aggregate conclusion** re-synthesizes to include beta's findings.

Two properties make this more than a shared Google Doc:

- **The task fans out and the answers fan in.** The organizer never has to be
  in any recipient's data path to collect their work; the recipient seals it
  and sends it.
- **The privacy split holds per node.** Each recipient's own research is a
  normal Se/cure session (server in no data path). The only thing that ever
  reaches the organizer is the conclusion the recipient chose to seal and
  return.

## 2. Actors and terminology

- **Organizer** — the Se/rver (signed-in) user who creates the campaign, holds
  the **project private key**, and reads the dashboard.
- **Campaign** — one shared research task: a title, a prompt, a **project
  keypair**, a set of **alias slots**, and the collected results. Server-side
  it is a D1 row owned by the organizer.
- **Project keypair** — a per-campaign **P-256 ECDH** keypair. The **public
  key** travels inside every invite link; the **private key** stays with the
  organizer (client-held; the server stores only ciphertext, §7). It is what
  lets a node seal a result that ONLY the organizer can open.
- **Alias** — an identity slot in the campaign (`alpha`, `beta`, a display
  name). One invite link per alias; each alias carries its own password.
- **Invite link** — a DRSW/1 workspace (`/cure/workspace#w=…`) whose payload
  carries a new `campaign` section (§4) alongside the usual settings, seeded
  conversation, and optional grants. Opening it is completely offline, exactly
  as any workspace (`docs/WORKSPACE-SECURITY.md` §1).
- **Node / participant** — the person and browser that open an invite link and
  do the research. Identical to a DRSW node; "participant" is the crowd-model
  word for it.
- **Result envelope** — the node's conclusion, sealed to the project public key
  (§5). `kind: "drcr-result"`. Travels by link, file, message, or QR, and never
  needs the organizer online at send time.
- **Aggregate** — the merged conclusion the pipeline synthesizes from all
  returned results, shown live on the dashboard (§6).

## 3. The complete workflow (lifecycle)

```
ORGANIZER (Se/rver)                         PARTICIPANT (Se/cure)
──────────────────                          ─────────────────────
1. create campaign
   ├─ generate project keypair (ECDH P-256)
   ├─ write title + task prompt
   └─ define N alias slots
2. mint N invite links               ──▶    3. open link  #w=<blob> + password
   each link carries, sealed:                  ├─ offline unlock (DRSW envelope)
   ├─ campaign id + kid                         ├─ apply seeded task/settings/grants
   ├─ alias                                     └─ land in a ready Se/cure session
   ├─ project PUBLIC key
   ├─ task prompt (seeded conversation)   4. research (normal pipeline, own keys
   └─ optional grants (web/api)              or borrowed grants) → a conclusion
                                          5. Return result
   (links handed out out-of-band:            ├─ build result payload {alias, kid,
    message, QR, printed card)                │   answer, sources, notes, ts}
                                              ├─ SEAL to project public key (§5)
                                              └─ emit as QR / link / file / msg
6. dashboard ingests returns          ◀──    (channel: scan QR at dashboard,
   ├─ open envelope w/ private key             paste link, upload file, webhook)
   ├─ route by kid → this campaign
   ├─ alias light → green, notify
   └─ re-synthesize AGGREGATE (pipeline)
7. organizer reads/exports the merged answer
```

The organizer's private key is the hinge: steps 2 and 6 are the only two that
need it, and both happen in the organizer's own browser. The server relays and
stores **ciphertext** (§7).

## 4. What an invite link carries — the `campaign` section

An invite link is a DRSW/1 workspace payload (`kind: "drc-workspace", v: 1`)
with one new registered section. Adding a section does not bump DRSW's `v`
(readers ignore unknown members — DRSW/1 §10); a plain workspace reader that
does not understand crowd research simply opens a normal seeded session.

```json
"campaign": {
  "id": "cmp_9f3a…",                 // opaque campaign id (routing only)
  "kid": "bb0ae363",                 // first 8 hex of SHA-256(project pubkey raw)
  "alias": "beta",                   // this link's identity slot
  "title": "Phone-inference runtimes 2026",
  "pubkey": "BEXo…",                 // base64url(raw P-256 public key, 65 bytes)
  "return": {                        // where/how to send the sealed result back
    "channels": ["qr", "link", "file"],
    "post": "https://deepresearch.se/api/campaign/return"  // OPTIONAL relay
  },
  "task": { "prompt": "…your slice of the question…",
            "conversationSeeded": true }   // the seed lands as conversation[0]
}
```

Rules:

- The `pubkey` MUST be the raw uncompressed P-256 point (65 bytes, `0x04‖X‖Y`),
  base64url. `kid` MUST equal the first 8 lowercase-hex chars of
  `SHA-256(rawPubkey)` — it is a **routing hint only**, never a secret and never
  load-bearing for security (the envelope authenticates cryptographically, §5).
- The `task.prompt` seeds the participant's first conversation turn
  (DRSW `conversations` reader rules apply — appended, never clobbering).
- `campaign.return.post` is OPTIONAL. If absent, the ONLY return channels are
  offline (QR / file / paste) — a fully server-blind campaign is possible where
  even the *return* never touches a server until the organizer scans it.
- The invite link's password is per-alias (DRSW §3 password rules unchanged:
  12+ chars, generated, out-of-band). Different aliases with different
  passwords means one leaked invite reveals ONLY that alias's seeded task, not
  the others'.
- `grants` (DRSW §5.4) MAY be included so participants research on the
  organizer's borrowed, metered web/api allowance instead of their own keys —
  the ghost-crossover pattern, unchanged. This is optional and per-campaign.

The project **private** key is NEVER in an invite link (it never leaves the
organizer). Only the public key travels — so a recipient can seal *to* the
organizer but can neither open another recipient's sealed result nor
impersonate the organizer.

## 5. The result envelope (normative) — sealing a conclusion back

This is the one new cryptographic construction. It is a standard ECIES-style
sealed box over WebCrypto primitives this repo already uses (ECDH + HKDF +
AES-256-GCM — the vault's HKDF/GCM pattern, `public/js/vault-core.js`, made
asymmetric). Reference implementation: **`public/js/research-seal-core.js`**
(pure core, Node-tested), machine schema
`docs/schemas/drcr-result-1.schema.json`.

### 5.1 Seal (participant side)

```
recipient  = project public key (raw P-256, from campaign.pubkey)
1. eph        = fresh ECDH P-256 keypair (per result — ephemeral)
2. shared     = ECDH(eph.private, recipient)            // 32-byte X coordinate
3. key        = HKDF-SHA-256(ikm=shared,
                             salt=eph.publicRaw,          // binds key to this eph
                             info="deepresearch.se/drcr result seal v1",
                             len=32)                       // AES-256 key
4. iv         = 12 random bytes
5. ct         = AES-256-GCM(key, iv, plaintext)           // plaintext = UTF-8 JSON result
6. envelope   = { v:1, kind:"drcr-result", kid,
                  epk: base64url(eph.publicRaw),
                  iv:  base64url(iv),
                  ct:  base64url(ct) }
```

The ephemeral keypair gives **per-result forward secrecy**: each returned
conclusion uses fresh key material, and compromising one does not compromise
others. The organizer's long-term private key is the only thing that can
derive `shared`, so **only the organizer can open the envelope** — a recipient,
or anyone who intercepts the QR/link, holds only the public key and cannot
decrypt.

### 5.2 Open (organizer side)

```
1. eph.public = import base64url(epk) as ECDH P-256 public
2. shared     = ECDH(project.private, eph.public)         // same 32 bytes
3. key        = HKDF-SHA-256(shared, salt=epk-raw, info=…, 32)
4. plaintext  = AES-256-GCM-decrypt(key, iv, ct)          // fail-closed → null
5. result     = JSON.parse(plaintext)
```

Openers MUST fail closed: any failure (bad base64, wrong curve point, GCM
authentication failure, malformed JSON) yields **no partial result** — exactly
DRSW §3's discipline. `kid` selects which campaign private key to try; a
mismatched `kid` is skipped without attempting decrypt.

### 5.3 The result plaintext

```json
{ "v": 1, "kind": "drcr-result",
  "campaign": "cmp_9f3a…", "alias": "beta",
  "answer": "…the participant's conclusion (markdown)…",
  "sources": [ { "title": "…", "url": "…" } ],
  "notes": "…optional caveats/confidence…",
  "pipeline": "drpl1:…",          // OPTIONAL DRPL fingerprint of how it was produced
  "producedAt": 1784930000000 }
```

`answer` is the content-bearing member (required). `campaign`/`alias` let the
dashboard place the result even when it arrived out of band (a scanned QR the
organizer can't otherwise attribute). `pipeline` (DRPL fingerprint,
`docs/PIPELINE-LANGUAGE.md`) is optional provenance so the organizer can see
*how* each node produced its slice.

### 5.4 Cipher suite and lineage

Suite **1** (the only suite in DRCR/1): ECDH P-256 · HKDF-SHA-256 ·
AES-256-GCM. Chosen because (a) WebCrypto ships all three in the Worker, the
browser, and Node ≥ 18 identically — the same constraint that fixed DRSW on
AES-GCM (`docs/WORKSPACE-PROTOCOL.md` §3.2); (b) it reuses this repo's existing
HKDF-then-GCM shape (`vault-core.js`) so there is no new primitive to audit,
only a new *composition*; (c) no added dependency (minimal-deps invariant). A
future suite (e.g. X25519 for TweetNaCl nodes) would be negotiated by the `v`
byte — DRCR/1 defines no in-band negotiation: one suite, no downgrade surface.

## 6. Return channels — link, file, message, QR

The sealed envelope is small structured text (base64url), so it moves over any
channel. In descending order of "no shared account needed":

1. **QR code** — the headline channel for phone-to-phone. The participant's
   result screen renders the envelope as a QR; the organizer's dashboard reads
   it with the device camera. See §6.1 for the size reality and chunking.
2. **File** — the envelope saved as a `.drcr` file, uploaded to the dashboard.
   Survives any transport including sneakernet; no size limit.
3. **Link** — `…/campaign/return#r=<envelope-b64url>` (fragment transport, so
   even a return *link* is server-blind until the organizer opens it). Practical
   for small results.
4. **Relay POST** — if the campaign declared `return.post`, the participant's
   browser MAY POST the **already-sealed** envelope to that endpoint. The server
   stores ciphertext and pushes a dashboard notification. This is the ONE
   channel that touches a server before the organizer is online; it is optional,
   disclosed, and carries only the sealed blob (§7).

### 6.1 QR size and chunking (normative when QR is used)

A single QR code holds roughly ~2–3 KB of base64url text at readable error
correction. A result with a long answer and many sources easily exceeds that,
so DRCR/1 defines a **chunk framing** any QR encoder/decoder pair MUST follow:

```
chunk = "drcr1:" <i> "/" <n> ":" <slice>
```

where the whole envelope base64url string is split into `n` equal slices and
`<i>` is the 1-based index. The participant screen cycles through the `n`
chunks (animated "QR reel"); the reader accumulates distinct `i` until it holds
all `n`, then concatenates in index order and opens. Rules:

- Chunks are **idempotent and order-independent** on receipt (keyed by `i`);
  the reel MAY loop so a reader that missed a frame catches it next pass.
- A reader MUST validate it has exactly `1..n` before reassembling and MUST
  fail closed if the reassembled envelope does not open.
- For anything that would need more than a small number of chunks, writers
  SHOULD prefer the **file** channel — QR is for convenience, not bulk.
  Chunk framing helpers live beside the crypto in
  `public/js/research-seal-core.js` (`chunkResult` / `reassembleChunks`).

QR **reading** (camera → text) is the one piece that pragmatically wants a
vendored decoder (finder-pattern detection + Reed-Solomon is large and
error-prone to hand-roll); QR **generation** (text → matrix) is a bounded
algorithm that can be written dependency-free. The split is an implementation
choice recorded in §11, not a protocol requirement — DRCR/1 specifies only the
chunk framing and the fail-closed reassembly, not the QR codec itself.

## 7. Privacy model — where this touches a server, and where it does not

DRCR/1 is deliberately explicit about invariant 4 (the privacy split), because
unlike plain workspaces it introduces an **inbound** flow the organizer
consumes. Threaded against the invariants:

| Step | Server sees | Why it's within the model |
|---|---|---|
| Mint invite links | nothing of the payload | Sealed client-side; the `#w=` blob never reaches the server (DRSW fragment-only). The server MAY mint grants (existing ghost path) but never the password or assembled link. |
| Participant research | nothing (Se/cure tier) | A normal Se/cure session — server in no data path; own keys or the two existing bounded grant exceptions. |
| Return via QR / file / paste-link | **nothing** | Fully offline: the sealed envelope goes phone-to-phone / device-to-dashboard; the server is never in the path. This is the default, server-blind campaign. |
| Return via relay POST (opt-in) | **ciphertext only** | A NEW, bounded, disclosed inbound path. The server stores and relays the sealed `drcr-result` blob it CANNOT open (it holds no private key). Same posture as R2 chat ciphertext: server-undecryptable at rest. Off unless the campaign declares `return.post`. |
| Dashboard open + aggregate | plaintext of returned results, in the organizer's browser | Decryption happens client-side with the organizer's private key. The AGGREGATE synthesis is a normal pipeline call (§6 / §8) — the organizer's own research turn over content they are authorized to read. |
| Campaign at rest (D1) | ciphertext + routing metadata | Results rest as `drcr-result` ciphertext; the organizer's private key rests wrapped by the account key hierarchy (`docs/ENCRYPTION.md`), server-undecryptable — the vault posture. Routing metadata (campaign id, kid, alias, timestamps, light state) is plaintext, like any `chat_logs`-class operational record; honors `incognito`. |

Consequences that MUST hold:

- **The relay never holds a key.** `return.post` stores the sealed envelope and
  nothing that can open it. The organizer's private key is the only opener and
  it never leaves the organizer's browser (wrapped at rest, like the project
  vault secret).
- **The SERVER-TOKEN GUARANTEE is untouched** (`docs/SERVER-TOKENS.md`): any
  grants an invite carries authorize upstream APIs only, never Se/rver data,
  never a login. A campaign result is not a credential.
- **Minimum outbound.** Nothing about the campaign leaks a participant's
  identity to third parties; participant research carries the usual minimum
  (a query, a coordinate) and never the campaign.
- **Asymmetric = compartmentalized.** Because results are sealed to a public
  key, a leaked invite link (or a nosy relay) can send *in* but cannot read any
  other participant's returned conclusion. Only the private-key holder
  aggregates.

## 8. The organizer dashboard (Mentimeter-for-research)

One dashboard per campaign, in the Se/rver account surface (rendered like the
admin decision boards, `docs/DECISION-BOARD-LOOPS.md` / the **decision-boards**
skill — a server-produced list the organizer acts over, here read-mostly + live).

- **Alias lights.** One indicator per alias slot: grey (not opened), amber
  (opened, no result yet — derived from an optional non-identifying "opened"
  beacon the participant MAY send, or simply "invited"), green (result
  returned), red (result failed to open — tampered/mismatched kid).
- **Activity notifications.** Reuse the existing alerts/notification center
  (`src/alerts.js` + `public/js/notifications.js`): "beta returned",
  "aggregate updated", "gamma's result failed to open". Live via the same
  mechanism the account message-center uses.
- **Live aggregate conclusion.** The headline: as results arrive, the pipeline
  **re-synthesizes** a merged answer. This MUST stay within invariant 1
  (**no function calling**): the merge is the existing deterministic synthesis
  phase given the returned `answer`s as its notes/sources, run on the
  organizer's chosen answer model, with the JSON phases (if any) on the fixed
  `DEFAULT_MODEL` (invariant 3, split routing). Concretely it reuses
  `src/notes.js` (the research-notes merge) + the synthesis call — no new
  orchestration primitive. The aggregate is itself a `drc-workspace`
  conversation the organizer can continue, publish, or export.
- **Per-result drill-down.** Each green light expands to that alias's full
  returned `answer` + sources + optional DRPL fingerprint (how they produced
  it).
- **Controls.** Re-mint an alias link (new password), pause/adjust any carried
  grants (existing per-token quota adjust, `docs/WORKSPACE-SECURITY.md` §4),
  close the campaign (stop accepting returns), export the aggregate.

Server-side data model (sketch, D1, owner-scoped like every account row):

- `campaigns` — `id, user_id, title, kid, pubkey, created, state, incognito`.
  The wrapped **private** key rests here as ciphertext (account-key-wrapped) OR
  is held only client-side and never persisted (organizer's choice — the
  strictest campaign keeps the private key off the server entirely, like the
  vault secret).
- `campaign_aliases` — `campaign_id, alias, label, light, opened_at,
  returned_at`.
- `campaign_results` — `campaign_id, alias, kid, envelope (ciphertext), received_at`.
  The server stores the sealed blob; it never holds a key to open it.

Endpoints (all fail-safe, EN+SV parity for any intent gates that route to them):

- `POST /api/campaign` (authed) — create a campaign; body carries the public
  key + kid + alias slots; the server persists routing metadata only.
- `POST /api/campaign/return` (public, opt-in relay) — accept a sealed
  `drcr-result` for a known `kid`; store ciphertext; push a notification.
  Rate-limited, size-bounded, ciphertext-only; rejects anything that isn't a
  well-formed sealed envelope.
- `GET /api/campaign/:id` (authed, owner-scoped) — the dashboard's data
  (metadata + sealed results the organizer's browser then opens).
- Admin/list surfaces mirror the decision-board catalog pattern.

## 9. Relationship to DRSW/1 and the registries

DRCR/1 is a **profile of DRSW/1**, not a fork:

- The invite link is a DRSW workspace with the new registered payload section
  `campaign` (§4). Legacy DRSW readers ignore it (DRSW §4.1).
- The result envelope is a NEW top-level `kind: "drcr-result"` with its own
  cipher suite (asymmetric, §5.4). It is registered here.
- Registry additions (this document is the registry of record for the crowd
  layer): payload section `campaign`; envelope kind `drcr-result` with cipher
  suite 1 (ECDH-P256/HKDF-SHA256/AES-256-GCM); return channel identifiers
  (`qr`, `file`, `link`, `post`); QR chunk framing `drcr1:`.
- DRSW's `route`/`provenance`/`pipelines` sections compose unchanged: a
  campaign's aggregate can carry a DRPL fingerprint, and a participant's result
  can declare the pipeline that produced it.

## 10. Threat model additions

Beyond DRSW §5 / `docs/WORKSPACE-SECURITY.md` §5:

| Threat | Mitigation |
|---|---|
| Intercepted result (QR photographed, relay compromised, link leaked) | Sealed to the project public key — only the organizer's private key opens it; interception yields ciphertext. |
| Malicious participant returns garbage / a bogus alias | Results are advisory content, never authority; the organizer reviews per-alias before trusting the aggregate; a forged `alias`/`kid` still can't decrypt-to-something-else (GCM authenticates the whole plaintext). |
| Relay abused as a dropbox / DoS | `return.post` is rate-limited, size-bounded, and only stores well-formed sealed envelopes for a known `kid`; unknown kids are rejected; it holds no key so stored blobs are inert. |
| Organizer private-key loss | Campaign becomes unreadable (by design — no server-side recovery). The organizer is warned at creation; the key can be escrowed only into the account vault (wrapped), never to the server in the clear. |
| Cross-campaign correlation | Each campaign has its own keypair + kid; results from different campaigns are cryptographically unrelated. |
| Replay of a returned result | `producedAt` + per-alias dedup at ingest; a replayed identical envelope is idempotent (same alias, same content). |
| Weak per-alias password | Same 8192-round KDF work factor as DRSW; generated 12-char default (~71 bits). |
| XSS in the /cure or dashboard origin | Out of scope of the feature (site-wide CSP work, `SECURITY-RISKS.md`) — same boundary DRSW draws. |

## 11. Status — seeded vs. specified ahead

Per this repo's spec-first culture (the standard leads the code; the reference
node implements the seed, not the whole):

**Seeded in code (this pass), verifiable now:**

- `public/js/research-seal-core.js` — the pure core for the one new primitive:
  project keypair generation (`generateProjectKeypair`, `exportProjectPublicKey`,
  `projectKid`), the asymmetric seal/open (`sealResult` / `openResult`,
  fail-closed), and the QR chunk framing (`chunkResult` / `reassembleChunks`).
  WebCrypto-only, import-safe, Node-testable — the `vault-core.js` / `proxy-bundle.js`
  arrangement.
- `public/js/research-seal-core.test.js` — real round-trip tests: seal→open,
  wrong-key rejection, tamper rejection, kid derivation, chunk split/reassemble
  (incl. out-of-order and missing-chunk).
- `docs/schemas/drcr-result-1.schema.json` — the machine-readable result-envelope
  schema.
- Allowlisted as a public asset (`src/assets.js`) so the client tiers can import
  it, exactly like `workspace-core.js`.

**Specified ahead of code (next, in rough order):**

1. The **campaign minter** UI in the Se/rver account surface — extend the
   existing "Share a Se/cure workspace" view (`public/js/account-settings.js`)
   to mint N alias links, each with the `campaign` section, from one form.
2. The **participant return** UI on the Se/cure result screen — build the result
   payload, `sealResult`, render QR / offer file / link.
3. The **QR codec** — a dependency-free generator + a vendored reader
   (§6.1), wired to the chunk framing.
4. The **dashboard** — the campaign board, alias lights, notifications
   (reusing `alerts.js`), and the live aggregate synthesis (reusing `notes.js`
   + the synthesis phase — no function calling, split routing).
5. The **server endpoints + D1 tables** (§8), all fail-safe, ciphertext-only,
   owner-scoped, with EN+SV intent parity for any routing gate.

Each step is small and independently testable, and, as with DRSW, someone
else's node implementing DRCR/1 on separate source is as legitimate a next step
as ours.
</content>
</invoke>
