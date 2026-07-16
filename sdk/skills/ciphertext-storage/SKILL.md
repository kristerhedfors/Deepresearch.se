---
name: ciphertext-storage
description: >-
  Load when building the server tier's storage plane for an agent pair — the
  knob-gated cloud mirror of client-encrypted conversations/projects/files,
  the server-derived in-memory history key, the declared readable exception
  for RAG-indexed material, dual-write + bidirectional bulk sync with
  newer-wins reconciliation, the full drain-wipe, and the blind-blob vault
  tier under a user-held secret the server never sees. Also load when
  auditing what a generated pair's server can and cannot read at rest, or
  when any change touches the encryption-asymmetry rule.
---

# Cloud ciphertext storage & the vault tier

The server tier's storage plane, engineered so the server *stores* what it
cannot *read*: conversations and attached-file originals rest as
client-encrypted ciphertext in both the browser and (opt-in) the cloud blob
store, under a key that is derived server-side on demand but never written
to rest anywhere; the only readable material is the narrowly-declared
exception class that retrieval genuinely requires; and above it all sits the
blind-blob vault — archives sealed under a user-held secret the server never
sees, where even a live server compromise recovers nothing decryptable.

## Capability class & tier story

**Class S — server-backed.** This module exists only in the server tier:
the client tier has no accounts, no cloud knob, and no server in its data
path (its persistence is the sealed local state from `sealed-crypto`). The
client HALF of this module (the encrypting history store, the sync engine,
the OPFS original store, the vault pack/load orchestration) ships in the
server tier's authenticated client bundle and must NEVER enter the client
tier's public module graph — it drags the authenticated storage stack with
it. The vault is the bridge concept: it uses `sealed-crypto`'s primitives
client-side and reduces the server to a namespaced blob shelf.

## Contracts

- **PA-4 (privacy split)** — the module's whole purpose: ciphertext at rest
  in both locations, keys never at rest beside ciphertext, and the readable
  exceptions ENUMERATED and disclosed (RAG-indexed material and project
  chats), never silent.
- **PA-2 (fail soft)** — the cloud mirror is fire-and-forget: a failed PUT
  never surfaces as a chat error; sync reconciles later by `updatedAt`;
  undecryptable records are skipped and counted, never a crash. But note
  the deliberate inversion below —
- **PA-9's spirit applies to confidentiality** — key-unavailable paths fail
  CLOSED: no history key means nothing is stored, never a plaintext
  fallback (the reference states this as an explicit module contract).
- **PA-5 (minimal deps)** — both storage bindings (blob store, vector
  index) are OPTIONAL; absent bindings make the feature invisible, not
  broken. No new dependencies; plain WebCrypto client-side.
- **PA-10 (verify live)** — the round-trips run against mocked storage in
  unit tests, but knob flips, drains, and cross-device sync are verified on
  the live deployment (that is where the reference's bugs lived).

## Build plan

1. **The per-user history key** — `src/history-key.js`: one env root secret
   (`HISTORY_KEY_SECRET`, distinct from the session-signing secret) and a
   deterministic derivation
   `HMAC-SHA-256(secret, "history-key.v1." + userId)` → base64. Deterministic
   means no key is ever stored: the same signed-in identity always
   re-derives it. Expose `historyKeyConfigured(env)` and make every caller
   gate on it — **fail closed**: without the secret the endpoint 503s, the
   client hides the feature entirely, and nothing may fall back to storing
   plaintext. Serve it over an authenticated `GET /api/history-key`.
2. **The client-side encrypting store** — `public/js/history-store.js`
   (server tier's client bundle): fetch the key once per page load, hold it
   **only in a module-level variable** — never localStorage, never
   IndexedDB, never sessionStorage. Two stored shapes: JSON records
   (conversations, project records) as `{iv, ciphertext, updatedAt,
   createdAt}` — AES-256-GCM, fresh 12-byte CSPRNG IV per record, **titles
   inside the ciphertext** (they reveal topic; listing the sidebar means
   decrypting each record, fine at personal scale); and a raw-byte form
   `IV ‖ ciphertext` for attached-file originals (stored in OPFS via
   `public/js/opfs.js`, mirrored to the cloud as the same bytes).
   Undecryptable records (corruption, rotated secret) are skipped AND
   counted — the sidebar says "N conversations can't be decrypted", never a
   silently empty list.
3. **Declare the readable exception — once, precisely.** The storage rule:
   *indexed material rests readable*, because a retrieval index necessarily
   holds the text in the clear — encrypting the source record would protect
   nothing the index doesn't already expose. The exception class is exactly:
   RAG-indexed documents (their index, their originals) and project chats
   (indexed for cross-chat retrieval; stored as a readable `{data}` record
   — the client chooses the form per record, `readRecordData` handles
   both). Everything else — non-project conversations, images, unindexed
   files — is ciphertext in BOTH rests. Disclose the split in the settings
   UI, the help page, and the first-run notice, and keep all three in sync
   with the code forever.
4. **The server storage endpoints** — `src/storage.js`: per-user-namespaced
   key families in the blob store (`convos/{uid}/{id}`,
   `projects/{uid}/{id}`, `files/{uid}/{fileId}`, plus the RAG export
   family). The server stores the client's blob VERBATIM — it never
   encrypts, decrypts, or transforms. Files carry the client's encryption
   flag (`x-file-enc` header → object metadata) so the server knows *which
   stored form* it holds without being able to tell the contents. Enforce
   caps (the reference: 8 MB/record, 30 MB/file, 1000 objects per family)
   and id validation (client-generated UUIDs only). Blobs go to the blob
   store, not the SQL DB — records with inline images blow past SQL row
   ceilings (the reference's judgement call at a 2 MB row limit).
5. **The opt-in knob** — `src/settings.js`: a per-user `server_history`
   boolean in the account's settings JSON. Decide the default deliberately
   and report the EFFECTIVE state: an identity that cannot use storage
   (break-glass auth, missing blob-store binding) always reads as off, so
   clients never dual-write into 503s. **Writes (PUT) require the knob ON;
   reads and deletes stay allowed while OFF — that IS the drain path.**
6. **Dual-write + bulk sync** — steady-state, the client's save path writes
   locally and mirrors to the cloud in the same call (fire-and-forget,
   fail-soft); `public/js/sync.js` owns the bulk moves: knob ON →
   `syncToServer()` pushes every eligible local record in its STORED FORM
   (ciphertext moved as-is, no decrypt/re-encrypt round trip; vectors ride
   along so nothing re-embeds); knob OFF → `syncToClient()` pulls
   everything newer/missing down, and ONLY if every item came down clean
   fires the one-call full wipe. Reconciliation is last-write-wins by
   `updatedAt`, per-item fail-soft (a failed item is counted and skipped,
   never a wedged sync); `pullNewer()` on sidebar open/boot makes cloud
   mode double as cross-device sync. Per-project knobs reuse the same
   machinery scoped to one project's ids.
7. **The drain-wipe** — `DELETE /api/storage`: wipes conversations, files,
   RAG exports and vectors in one call, **with the vault family explicitly
   excluded** — vault copies are often made precisely because the knob is
   going off; each vault store was its own consent and only an explicit
   vault delete removes one. Pin the exclusion with a test.
8. **The blind-blob vault** — `src/vault.js` + client orchestration over
   `sealed-crypto`: one client-encrypted archive per user-held secret,
   stored at `vault/{uid}/{id}` where BOTH the id and the AES key are
   HKDF-derived client-side from the secret (the server can neither locate
   nor read a blob; it knows only that *this user* stored *a* blob).
   Deliberately **not knob-gated** — each store is its own explicit consent
   act, and the point is serving knob-off (local-only) content; gate only
   on storage availability. The archive is self-contained under the secret
   alone: pack file originals DECRYPTED from their history-key form first,
   so the archive doesn't depend on any server-derivable key. Re-storing
   rotates: upload under the new secret's id, delete the old blob — the old
   secret stops working. Caps per archive and per user (reference: 100 MB,
   50 objects). On load, everything returns to its normal storage form
   (files re-encrypted under the history key; no key → skipped, never
   stored readable), LWW by `updatedAt`.
9. **Import honors the archived posture.** A local-only project loads as
   local-only — the archive records its own cloud setting, and loading
   never silently uploads anything readable.
10. **Tests**: history-key determinism + configured gate; storage endpoints
    against a mocked blob store (round-trip, caps, per-user namespacing, id
    validation); vault round-trip + works-with-knob-OFF + drain-exclusion;
    client store's ciphertext-only-at-rest and skipped-and-counted paths;
    sync's stored-form-verbatim and partial-pull-never-deletes properties.

## Reference implementation map

| Concept | File(s) in this repo |
|---|---|
| History-key derivation + threat model header | `src/history-key.js` |
| Encrypting client store (two shapes, titles inside ciphertext, skip-and-count) | `public/js/history-store.js` |
| Attached-file originals client-side | `public/js/opfs.js`, `public/js/attachments.js` |
| Knob-gated server endpoints, verbatim blobs, `x-file-enc`, drain reads/deletes | `src/storage.js` |
| The knob + effective-state reporting | `src/settings.js`, `public/js/settings.js` |
| Dual-write, bulk sync, `pullNewer`, project scopes | `public/js/sync.js`, `public/js/projects.js` |
| Blind-blob vault endpoints / orchestration / crypto | `src/vault.js`, `public/js/vault.js`, `public/js/vault-core.js` |
| The declared readable exception (rule + disclosure) | `docs/ENCRYPTION.md` §6–7 (E-16…E-19), `.claude/skills/storage-privacy/SKILL.md` |
| Full at-rest matrix and adversary table | `docs/ENCRYPTION.md` §5.2, §6 |
| Test suites | `src/vault.test.js`, `src/history-key.test.js`, `src/settings.test.js`, `src/rag.test.js` (`idOk`) |

## Acceptance checklist

- [ ] History key: derivation deterministic per user; endpoint 503s without
      the root secret; client hides the feature rather than degrading.
- [ ] No plaintext fallback ANYWHERE: key unavailable at attach time stores
      nothing (pinned); no code path writes a readable conversation outside
      the declared exception class.
- [ ] Key residency: never in localStorage/IndexedDB/sessionStorage —
      grep-verified plus a code-review pin in the store module's header.
- [ ] Server stores blobs verbatim (byte-equality test against a mocked
      blob store); encryption flag round-trips on files.
- [ ] Vault: round-trip vs mocked storage; id+key derived client-side only;
      works with the knob OFF; excluded from the drain-wipe; re-store
      rotates and deletes the old blob.
- [ ] Sync: stored-form-verbatim moves; LWW by `updatedAt`; a partial pull
      never triggers the wipe; per-item failures counted, not fatal.
- [ ] Skip-and-count: a deliberately corrupted local record yields the
      counter, not a crash (live probe).
- [ ] Disclosure surfaces (settings UI, help page, first-run notice) name
      the exact readable exception class and match the code.

## Pitfalls

- **The plaintext fallback temptation.** Every outage-shaped bug report
  ("history vanished when the secret rotated") invites a fallback to
  unencrypted storage. The reference made fail-closed an explicit contract
  in `src/history-key.js`'s header because the temptation recurs; a
  fallback silently converts the whole tier's promise into a lie.
- **Effective-state reporting saved real 503 storms.** Before
  `/api/settings` reported storage availability, break-glass identities and
  binding-less deploys dual-wrote every save into 503s. Report what the
  caller can actually do, not what the flag says.
- **Reads/deletes stay open while the knob is off — deliberately.** They
  ARE the drain. A well-meaning "knob off should block everything" change
  strands users' only cloud copies. Same class: the drain deletes only
  after a *fully clean* pull — a partial pull that deletes is data loss.
- **The vault is not knob-gated and not wiped — both are product decisions
  with tests.** The 2026-07-10 design explicitly serves knob-off projects
  and survives the account wipe. Any refactor that routes vault writes
  through `serverHistoryEnabled` or the wipe through `vault/` breaks them.
- **Blob store vs SQL DB sizing.** Conversation records with inline images
  run to several MB — past D1's 2 MB row ceiling in the reference. Blobs
  belong in the blob store; the SQL DB gains only the settings column.
  Also: declaring a binding for a nonexistent resource fails every deploy —
  keep optional bindings commented out until provisioned.
- **Self-heal legacy forms in sync, not in a migration.** The reference's
  `syncToServer` re-encrypts legacy plaintext files in place and re-uploads
  wrong-form remote copies opportunistically — a one-shot migration would
  have missed offline devices.
- **`projectId` rides plaintext locally, and only locally** — a random UUID
  revealing grouping, not content; sync needs it to honor per-project knobs
  without decrypting. Don't "fix" it into the ciphertext (sync breaks) and
  don't mirror it server-side beyond the record itself.
- **The live-server caveat belongs in the disclosure.** This model is
  "combination required", not end-to-end: a live compromised server can
  derive any user's key (it holds the root secret) — it just holds no
  ciphertext unless the knob is on. The reference discloses this at
  `/help/` (E-12/§11-1); a generated pair that markets it as E2EE is
  overclaiming, and the vault/client tier are the honest answers for users
  who need server-excluded crypto.
