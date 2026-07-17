# DRSW/1 — the Deep Research Secure Workspace interchange protocol

*(2026-07-17, owner directive. This document defines the bundle of
information — required and optional — that constitutes a **deep research
secure workspace**, and specifies it as an open standard so that OTHER sites —
built on this source code or on completely separate foundations — can
implement the same bundle and move workspaces between each other. A site
implementing this protocol is a **node**; deepresearch.se is the reference
node, one of a potentially large number of data-compatible research nodes.
The companion documents are `docs/PIPELINE-LANGUAGE.md` (DRPL — the formal
language declaring the structure of the pipelines a workspace's research runs
under) and `docs/STACKLESS-RESEARCH.md` (the vision the two standards serve).
Machine-readable payload schema: `docs/schemas/drsw-payload-1.schema.json`.
Security architecture of the deployed reference implementation:
`docs/WORKSPACE-SECURITY.md`. Like everything in this project, the standard
is EXPERIMENTAL — a research artifact into the privacy capabilities of LLM
applications, not a ratified industry spec.)*

The key words **MUST**, **MUST NOT**, **SHOULD**, **SHOULD NOT**, and **MAY**
are to be interpreted as in RFC 2119.

## 1. Purpose and scope

A **Deep Research Secure Workspace (DRSW)** is a complete, portable research
context — provider credentials, behavior settings, conversations, borrowed
metered allowances, pipeline declarations, and a provenance/routing trail —
sealed into ciphertext that travels **only in places no server ever reads**:
a URL fragment, a downloaded file, a QR code. The workspace is the unit of
interchange between research nodes: the same sealed bundle opens at any
conforming node, so a user can conduct work on one **data foundation** across
many **purpose-built nodes** — a generalist node, a legal-research node, a
local-only node — each a different processor over the same portable state.

DRSW/1 standardizes three things:

1. **The envelope** (§3) — the crypto wire format that seals a payload.
2. **The payload** (§4–§5) — the bundle itself: which sections exist, which
   are required, what each may carry, and how a reader applies them.
3. **Node behavior** (§6–§8) — conformance classes, discovery, handoff
   between nodes, and migration paths, including workflows in which the data
   never touches any server.

Out of scope: how a node implements its research pipeline (that structure is
*declared*, not prescribed, via DRPL — `docs/PIPELINE-LANGUAGE.md`), and any
node's internal storage format for an opened workspace.

## 2. Terminology

- **Workspace** — the plaintext JSON payload (§4) plus the sealed envelope
  carrying it.
- **Node** — a site (or local application) implementing this protocol. A
  node MAY be a bare static-file host: nothing in the core protocol requires
  a server-side program.
- **Portal** — the node's page that opens workspaces (the reference node's
  is `/cure/workspace`).
- **Sealer / opener** — the party encrypting / decrypting a workspace;
  always end-user client code, never a server.
- **Grant** — a signed, quota-metered, time-limited capability token whose
  allowance is administered by the node that issued it (§5.4).
- **Fragment-only transport** — data placed after `#` in a URL, which
  browsers do not send in HTTP requests and strip from referrers.

## 3. The envelope (normative)

The envelope is the hacka.re shared-link mechanism (the owner's prior
project, github.com/kristerhedfors/hacka.re) as deployed in
`public/js/workspace-core.js`. Cipher suite **1** (the only suite in DRSW/1)
is:

```
link  = <portal-url> "#w=" blob
blob  = base64url( salt(10 bytes) ‖ nonce(10 bytes) ‖ ciphertext )
```

- **KDF** — iterative SHA-512, **8192 rounds**, over `password ‖ salt`
  (UTF-8 password bytes as round 0 input; each round hashes
  `previous(64 bytes) ‖ salt`), keeping all 64 bytes per round and slicing
  to 32 bytes at the end. This is the **link key**.
- **Master key** — the same construction over `password ‖ salt ‖ nonce`,
  rendered as lowercase hex. It MUST NOT be transmitted or placed in the
  blob; it exists so the opener can encrypt the opened workspace at rest
  locally with a key not derivable from the blob alone.
- **AEAD** — AES-256-GCM. The 12-byte IV is `SHA-512(nonce)` truncated to
  12 bytes. The plaintext is the UTF-8 JSON serialization of the payload.
- **Namespace** — the first 8 lowercase-hex chars of `SHA-256(blob)`:
  a content-derived local identifier (same link → same namespace) revealing
  nothing about the contents.
- **Password** — 12+ characters (the reference generator: 12 alphanumeric,
  ~71 bits). It MUST NOT appear anywhere in the link; implementations MUST
  instruct users to share link and password through **different channels**.

Openers MUST fail closed: any failure (malformed base64, short blob, GCM
authentication failure, malformed JSON) yields *no partial result*.
Sealers MUST use fresh random salt and nonce per seal, so re-sealing the
same workspace yields unlinkable blobs.

**Fragment discipline.** The blob MUST travel in the URL fragment (never
path or query) when transported by link, and portals SHOULD remove the
fragment from the address bar after opening.

### 3.1 Test vectors

Generated from the reference implementation (`workspace-core.js`); any
independent implementation MUST reproduce them.

```
password  = "CorrectHorse"
salt      = 00 01 02 03 04 05 06 07 08 09
nonce     = 0a 0b 0c 0d 0e 0f 10 11 12 13

linkKey   = afb743c519c9c445442f924cfcbdef6576a269aba58747d81e6636582c5a7b31
masterKey = 0579cb1528bb8b82fb801255683128b159157446ceda7c34a6961c770f002b19
GCM IV    = 372e14236095d3291715de24

plaintext = {"v":1,"kind":"drc-workspace","name":"Test vector"}
blob      = AAECAwQFBgcICQoLDA0ODxAREhPFbP67tjukFu0ZwoSPyRBraxKuDuES4aZSmdUqVUxP-gTfjKSKu1RsoQQWeryLUX21poKXTucknMPtx-H-Erg89U_W
namespace = bb0ae363
```

### 3.2 Suite lineage

hacka.re's original suite uses XSalsa20-Poly1305 with a 24-byte expanded
nonce; DRSW/1 substitutes AES-256-GCM (12-byte expanded IV) because
WebCrypto — the only crypto this standard assumes — ships no Salsa-family
cipher. Everything else (wire format, KDF, dual keys, namespace, password
rules) is byte-for-byte the hacka.re architecture. Future suites (e.g. a
NaCl suite for TweetNaCl-based nodes) would be negotiated by a version
byte — DRSW/1 deliberately defines no in-band negotiation: one suite, no
downgrade surface.

## 4. The payload (normative)

The plaintext is one JSON object. **Required members:**

| Member | Type | Meaning |
|---|---|---|
| `v` | integer | payload schema version — `1` for this document |
| `kind` | string | payload type discriminator — `"drc-workspace"` is the registered baseline kind (the reference implementation's deployed value, kept for compatibility) |

Everything else is OPTIONAL — a workspace can be as small as a settings
preset or as full as keys + chats + grants + provenance. **Registered
optional sections** (§5 adds the interchange extensions):

| Section | Contents | Sensitivity |
|---|---|---|
| `name` | display name (≤ 80 chars) | none |
| `note` | welcome note shown on open (≤ 2000 chars) | none |
| `keys` (+ `providerId`, `model`) | provider API credentials by provider id | **highest** — full use of the keys until rotated |
| `settings` | behavior knobs: `research`, `bashLite`, `developerMode`, `searchBackend`, `localBaseUrl` | configuration (searchBackend may carry a self-hosted service key) |
| `conversations` | `[{id?, title?, messages: [{role, content}]}]` | the shared conversations |
| `grants` | borrowed metered capability tokens (§5.4) | bounded, metered allowance on the issuer's account |

**Reader rules** (all MUST):

1. **Ignore unknown members** — forward compatibility. A reader rejects a
   payload only for a wrong `v`/`kind` or a structurally invalid known
   section (the reference validator: `validateWorkspacePayload`).
2. **Append, never clobber** — incoming conversations get fresh local ids
   and join the local list; they never overwrite local state.
3. **Overwrite only what is carried** — keys/settings apply per-field;
   absent fields leave local values untouched.
4. **Disclose before applying** — show which sections the workspace carries
   (and a carried `note`) before any of it takes effect.

**Writer rules** (all MUST):

1. **Omit, don't empty** — an unused section is absent, not `{}`/`[]`,
   keeping links minimal and disclosure honest.
2. **Warn on keys** — including `keys` requires an explicit, per-share user
   decision with a warning (the reference composer's behavior).
3. **Carry something** — a payload with no content-bearing section beyond
   `v`/`kind`/`name` is not a workspace (the reference guard:
   `workspacePayloadCarries`).

## 5. Interchange extensions (optional, normative when present)

These sections make a workspace portable *between* nodes. They are additive
members of the same `kind: "drc-workspace", v: 1` payload — legacy readers
ignore them by rule 4.1; conforming nodes (§6, class N) understand them.

### 5.1 `origin` — where this bundle came from

```json
"origin": { "node": "https://deepresearch.se",
            "software": "github.com/kristerhedfors/Deepresearch.se",
            "exportedAt": 1784678400000 }
```

Provenance of the exporting node. Private (inside the ciphertext), purely
informational, never load-bearing: a reader MUST NOT vary its parsing by
`origin`.

### 5.2 `pipelines` — the declared research structure

An array of **DRPL/1 documents** (`docs/PIPELINE-LANGUAGE.md`) describing
the pipelines this workspace's research ran under, or is intended to run
under at the next node. Carrying pipelines lets any node *show* the user
what processing produced the data they are holding, *compare* it structurally
with the node's own pipelines (DRPL fingerprints), and *choose* an
equivalent pipeline to continue with.

### 5.3 `provenance` and `route` — the trail and the itinerary

```json
"provenance": [ { "node": "https://deepresearch.se", "at": 1784678400000,
                  "pipeline": "deepresearch.se/deep-research/server",
                  "fp": "drpl1:placement:c9cff8aa4ac82c56" } ],
"route":      { "cursor": 1,
                "hops": [ { "node": "https://deepresearch.se", "pipeline": "deepresearch.se/deep-research/server" },
                          { "node": "https://biolit.example", "intent": "domain-literature pass" },
                          { "node": "https://local-node.example", "intent": "offline synthesis on my own model" } ] }
```

`provenance` is the append-only record of **which nodes, running which
declared pipeline structures, have transformed this workspace** — the
"data processing and enrichment states" trail. `route` is the forward plan:
an ordered itinerary of nodes the user intends to carry the workspace
through. Both live inside the ciphertext: they are user-held navigation,
invisible to every server including the nodes themselves. A node's client
SHOULD append a provenance entry when its pipeline transforms the workspace,
SHOULD advance `route.cursor` on handoff, and MUST leave both fully
user-editable — the user owns their trail.

### 5.4 `grants` — borrowed metered capabilities, generalized

The reference node's two shorthand forms remain registered as-is
(`grants.ws` — a `wsk1.…` web-search grant token; `grants.proxy` —
`prg1.…` proxy grant tokens per service). The interchange form is
issuer-qualified:

```json
"grants": { "tokens": [ { "issuer": "https://deepresearch.se", "type": "server-token", "token": "eyJhbGciOi…" },
                        { "issuer": "https://biolit.example", "type": "web", "token": "…" } ] }
```

Grant rules (the properties that make lending allowances across nodes safe;
they mirror the deployed grant subsystems — see the **quota-grant-assessment**
skill):

- A grant MUST be a **capability to a metered record at the issuer**, not a
  bearer amount: the token authenticates; the issuer's row meters
  (`used < quota`, atomic reserve/refund) — so the minter administers the
  allowance **live** (raise/lower/pause/revoke) without changing any token
  in circulation.
- Only **URL-safe token tiers** may travel in a workspace (the reference's
  `wsk1`/`prg1`/Se/rver-token JWT families) — never post-exchange working
  credentials.
- Grants MUST be **issuer-scoped**: a token spends only at its issuer, and
  a workspace MAY carry grants from several issuers at once.
- Hydration MUST be **opportunistic and fail-soft**: the workspace opens
  fully offline; grant tokens are checked against their issuers only when
  (and if) used, and a revoked/expired grant simply doesn't connect.
- A grant MUST authorize **upstream API access only** — never the issuing
  node's own stored data (the reference's SERVER-TOKEN GUARANTEE,
  `docs/SERVER-TOKENS.md`).

### 5.5 `materials` (reserved)

Bulk research materials (attached documents, RAG indexes) are RESERVED for
a future revision: fragment transport has practical size limits
(§9, "size"), and the reference implementation today re-derives indexes
rather than shipping them. The name `materials` MUST NOT be used for
anything else.

## 6. Conformance classes

**Class R — reader.** Can open and apply a workspace: implements the §3
envelope (open side), §4 reader rules, and fail-closed semantics. The
minimum for "this site accepts DRSW workspaces".

**Class W — writer.** Can mint: §3 envelope (seal side), §4 writer rules,
password generation and channel-separation UX.

**Class N — node.** R + W, plus:

- **Discovery** (§7.1): serves `/.well-known/drsw.json`.
- **Interchange sections** (§5): understands `origin`/`pipelines`/
  `provenance`/`route`; appends provenance on transform; offers the
  next-hop handoff when a `route` is present.
- **Progressive trust** (§9): stages `keys` application behind explicit
  consent when the workspace's `origin.node` differs from the opening node.

The reference node is class N for its own shorthand grant forms and class
R/W for the payload core; the interchange sections are specified here first
and adopted by implementations as they land (this is a draft standard — the
spec deliberately leads the code).

## 7. Node federation

### 7.1 Discovery: `/.well-known/drsw.json`

A node advertises itself with one static JSON file — deliberately servable
by a bare static host:

```json
{
  "drsw": 1,
  "node": { "name": "DeepResearch.Se/cure", "operator": "deepresearch.se",
            "software": "github.com/kristerhedfors/Deepresearch.se" },
  "portal": "/cure/workspace",
  "kinds": [ { "kind": "drc-workspace", "v": [1] } ],
  "sections": ["keys", "settings", "conversations", "grants", "pipelines", "provenance", "route"],
  "grantTypes": [ { "issuer": "https://deepresearch.se", "types": ["web", "api", "server-token"] } ],
  "pipelines": [ { "id": "deepresearch.se/deep-research/secure",
                   "drpl": "/pipelines/deep-research-secure.drpl.json",
                   "fp": "drpl1:spine-shape:24f0fd90325d4ae5" } ],
  "peers": ["https://biolit.example"]
}
```

- `portal` — where a `#w=` fragment opens.
- `sections` — which payload sections this node can apply (a node that
  ignores `grants` still conforms; it just says so).
- `pipelines` — the node's offered pipelines as DRPL documents with
  structural fingerprints, so a client can compare nodes **before** visiting:
  "this node runs the same research spine I've been using, placed
  client-side".
- `peers` — optional, purely advisory node links (a discovery convenience,
  never a trust statement).

### 7.2 Handoff: moving a workspace to another node

The handoff is a **client-side link composition** — no protocol message
between nodes exists, by design:

```
1. open (or hold) the workspace locally
2. optionally: append provenance, advance route.cursor
3. re-seal with fresh salt/nonce (same or new password)
4. compose  https://<next-node><its portal>#w=<blob>
5. the user follows the link and enters the password (or the same password
   they already hold)
```

Rules:

- Handoff MUST re-seal rather than reuse the incoming blob when the
  workspace changed, and SHOULD re-seal even unchanged: fresh salt/nonce
  yields an unlinkable blob and a fresh namespace, so colluding nodes cannot
  correlate one workspace's visits by blob hash.
- The receiving node's server learns **nothing** at handoff: the fragment
  never reaches it. The first thing it can ever see is what the user's
  browser later chooses to send (e.g. a grant spend at its own metered
  endpoint).
- A node SHOULD render the next hop of a carried `route` as an explicit
  "continue at <node>" affordance — the user always initiates the hop.

### 7.3 Migration paths

Four standard ways a workspace moves, in descending order of convenience:

1. **Link** — the `#w=` fragment link (§7.2). Zero server contact.
2. **File** — the sealed blob saved as a `.drsw` file (the reference's
   `.drc` backup generalized: same bytes as the fragment, base64url or raw).
   Restores on any device at any node's portal; survives browser-storage
   eviction; travels over any channel including sneakernet.
3. **QR** — the link rendered as a QR code, for cross-device moves without
   any shared account. Practical for small payloads (§9, "size").
4. **Grant crossover** — for moving from an account-holding node to a
   stateless node: the account node mints grants (§5.4) and seals them into
   the workspace client-side (the reference's ghost-crossover pattern) — the
   account lends bounded capability without lending identity.

An **easy migration path** for users is a conformance concern, not a
courtesy: a class-N node MUST offer export (link + file) of everything the
user created there. Data a node cannot re-export into the workspace it came
from is a bug against this standard.

## 8. Zero-server workflows (scenario Z)

The standard's strongest configuration, spelled out so implementations can
claim it precisely. A workspace whose:

- model calls go to the user's **own local server** (`settings.localBaseUrl`
  — Ollama / LM Studio / llama.cpp; the keyless provider),
- `grants` section is absent,
- transport is link / file / QR (§7.3),

conducts research on which **no server anywhere receives the conversation,
the keys, or the workspace** — not the nodes (fragment-only transport; static
assets are all they serve), not any model provider (local inference), not any
search provider (offline harvest pipelines; see the DRPL `search` kind's
offline counterpart). Every hop between nodes preserves the property: the
data foundation moves between purpose-built research nodes while remaining,
end to end, in user custody. Nodes SHOULD surface when a session is in
scenario Z (the reference node's privacy notice does exactly this) — and
MUST NOT claim it when a carried grant or remote provider is in use.

## 9. Security considerations

Beyond the deployed threat model (`docs/WORKSPACE-SECURITY.md` §5), the
federation surface adds:

- **The malicious node.** Any node the user opens a workspace at runs code
  that can read what gets applied there. Mitigations are structural, not
  promises: progressive trust (class N stages `keys` behind explicit consent
  at foreign-origin opens; users SHOULD share keyless workspaces to unknown
  nodes), section disclosure before apply (§4 rule 4), and — the deep
  mitigation — **open source with the client tier's server in no data path**,
  so a node's actual behavior is auditable (the mission's "provable privacy"
  applied federation-wide). A workspace is a capability; opening it
  somewhere is granting that somewhere what it carries. The standard makes
  the grant *visible and minimal*, it cannot make it safe against a node the
  user should not have trusted.
- **Cross-node correlation.** Two nodes comparing received blobs could link
  a user's visits; re-seal-per-hop (§7.2) removes the shared identifier.
  Grants are inherently issuer-linkable (the issuer meters them) — carrying
  a grant to many nodes lets each spend against the same row; the minter's
  live controls (pause/revoke) bound the damage.
- **Size.** Practical fragment limits are browser-dependent (tens of KB are
  routinely fine; 1 MB is not). Writers SHOULD prefer file transport (§7.3)
  for large payloads rather than testing URL limits; `materials` stays
  reserved (§5.5) until a chunked-file convention exists.
- **The `route` section is advice, not authority.** A client MUST treat
  hops as suggestions requiring user action; auto-following a route would
  turn a shared workspace into a redirect weapon.
- **Grant scope.** Everything in §5.4 exists to keep a leaked workspace's
  blast radius at "a bounded, metered, revocable allowance" — implementers
  adding grant types MUST keep the meter-at-issuer and
  upstream-APIs-only properties.

## 10. Versioning and registries

- **Payload versioning:** additive optional members do NOT bump `v`
  (readers ignore unknowns); a breaking change to a registered section
  bumps `v` and readers MUST reject higher `v` than they implement.
- **Registries** (this document is the registry of record for all three):
  payload `kind`s (`drc-workspace`), envelope cipher suites (suite 1,
  AES-256-GCM), and grant `type`s (`web`, `api`, `server-token`).
  Additions land as revisions to this spec.
- **Extension escape hatch:** implementation-specific payload members
  SHOULD be prefixed `x-` to stay clear of future registered names.

## 11. Prior art

- **hacka.re** — the envelope mechanism, verbatim lineage (§3.2).
- **RO-Crate** (researchobject.org) — packaging research data with metadata
  and provenance into one portable object; DRSW shares the "the bundle IS
  the artifact" stance but adds sealed-by-default crypto, capability
  grants, and fragment transport.
- **W3C PROV** — the provenance vocabulary generalizing what §5.3 records
  minimally; a future revision may map `provenance` entries onto PROV-O
  terms.
- **Solid pods / remoteStorage** — user-held data with app interop; DRSW
  differs structurally: there is no storage server at all — the link/file
  is the pod.
