---
name: storage-privacy
description: >-
  Load when touching src/storage.js, src/vault.js, src/settings.js,
  src/rag.js, public/js/history-store.js, sync.js, projects.js,
  public/js/vault.js, or anything about chat-history encryption, the
  per-account server_history cloud-storage knob, RAG document indexing,
  projects, the secret-keyed project vault (store/load a project with a
  DR1-… secret), DRC — "deep research secure", the client-side public tier
  at /cure (the root redirects there; /my/project-<hash>; public/cure/,
  public/js/drc-core.js, drc-providers.js, drc-research.js, drc-store.js:
  no-account deep research with DIRECT browser→provider calls on user keys
  — OpenAI + Groq, the CORS-capable providers — and BROWSER-LOCAL sealed
  storage; the server is in no DRC data path), or the
  privacy/encryption model (encrypted-at-rest except RAG-indexed and
  project chats; keys never at rest beside ciphertext).
---

# Storage, encryption & privacy model

## The interaction log — full Q&A logged server-side (ghost opts out)

Since 2026-07-08 (explicit product decision, superseding the earlier
metadata-only-logs posture): every completed research exchange is logged
server-side IN FULL — complete question, complete answer, conversation
as sent, research metadata, errors — to the D1 `chat_logs` table
(`src/chatlog.js`; read API `/api/admin/chatlogs`, built for the agentic
debugging workflow — see the **chat-logs** skill). The ONE exception is
the ghost (incognito) toggle below: an incognito conversation sends
`incognito: true` and no log row is ever written for it. This log is a
separate thing from chat HISTORY (the sidebar store documented next) —
history remains browser-first and encrypted; the log is the server's
own product-improvement record. Keep `/help/`, the privacy notice, and
the ghost button titles consistent with this whenever any of it changes.

## Chat history — encrypted (project chats excepted); browser-local, with an opt-out cloud copy

Conversations are encrypted client-side before they rest anywhere
(the cloud-storage mode below stores the same ciphertext), with ONE
deliberate exception: **chats inside a project rest READABLE**, in both
locations, because they are RAG-indexed for cross-chat retrieval (see
"Projects" below) and the app's storage rule is that indexed material
rests readable — the index already holds the text in the clear, so
encrypting the record would protect nothing the index doesn't expose
(the same exception RAG-indexed documents have always had; disclosed in
`/help/`, the privacy notice, and the cloud-knob popover — the history
sidebar's own footnote was removed 2026-07-08 to declutter the pane).
Unlike
the original ephemeral-only design (history erased by "New chat" or a
reload), every conversation **persists across reloads inside the
browser itself**, listed in a left-side history panel (`history-ui.js`)
the same way a normal chat app's sidebar works: labelled by its first
question, clickable to reopen, renamable, deletable. Accounts that
switch the cloud knob OFF (see the next section) hold their history in
this browser ONLY — nothing conversation-derived server-side.

**Storage**: IndexedDB (`history-store.js`, database `dr_history`) — the
modern, higher-capacity, async successor to `localStorage`, appropriate
here since a conversation with attached images can be sizeable. Every
non-project record is AES-256-GCM encrypted before it is written; even
the title
(which can reveal the topic) lives inside the ciphertext, so listing
conversations for the sidebar means decrypting each one — fine at the
scale one person's history reaches. Project chats are stored as a
readable `{data}` row instead (`readRecordData` handles both forms).

**Key hierarchy — the actual security property being engineered for**:
the encryption key is deterministically derived server-side
(`GET /api/history-key`, `src/history-key.js`: HMAC-SHA256 of a
`HISTORY_KEY_SECRET` Worker secret + the user's id) and fetched by the
client fresh once per page load, held **only in a module-level JS
variable — never written to `localStorage`, `IndexedDB`, or any other
disk-backed storage**. This split key-vs-ciphertext residency is the
whole design:
  - **Offline extraction of the browser's storage** (a stolen device, a
    disk image, IndexedDB pulled at rest) recovers only ciphertext — the
    key was never persisted there to find.
  - **A server compromise** recovers `HISTORY_KEY_SECRET` (and could
    derive any user's key on demand) but recovers no ciphertext at all,
    since conversation content never leaves the browser.
  - Only the **combination** — a live compromise able to mint the key,
    AND separate access to that specific browser's storage — can decrypt
    anything. This is disclosed as the honest limitation at `/help/`, not
    hidden: it is a materially higher bar than either alone, not a claim
    that either compromise is harmless in every context.
  - Deterministic derivation means the same signed-in identity always
    re-derives the same key — this does NOT sync history across
    devices/browsers (each one's IndexedDB is its own copy), it only
    means no key itself ever needs to be the thing that's persisted.

**Fails closed, not soft, and deliberately so**: unlike D1-backed
features elsewhere in this app, there is no plaintext fallback when
`HISTORY_KEY_SECRET` is unset — `/api/history-key` returns 503, and the
client hides the History button entirely (`historyAvailable()` in
`history-store.js`) rather than silently storing conversations
unencrypted. A plaintext fallback would defeat the point of the feature.

**Incognito (the ghost toggle)**: a ghost button in the upper right,
directly LEFT of the account button (`#ghostbtn`, wired in `app.js`,
state in `stream.js`). Pressed BEFORE the first message of a fresh
conversation, that conversation is never written to chat history at
all — `persistConversation` is a no-op for it, so neither the encrypted
local store nor the cloud copy ever sees it — AND every send carries
`incognito: true`, which keeps it out of the server's interaction log
too (`src/chatlog.js` — see "The interaction log" above); it exists
only in the tab's memory until "New chat"/reload discards it. The
choice locks once
the conversation has started, in either direction — an ordinary chat
can't retroactively vanish, an incognito one can't retroactively
persist (or retroactively un-log). Once an ORDINARY conversation starts
the button is REMOVED
from the header (the choice can no longer be made, so the affordance
goes away); an incognito conversation keeps it visible-but-disabled as
the "nothing is being saved" indicator. Resets to off on every new
chat; loading a saved conversation is by definition not incognito.
Always shown for a fresh conversation — it used to hide when encrypted
history wasn't available, but the server-log opt-out is meaningful
regardless of local storage. The mini-row below the account button
that the ghost used to occupy now holds `#copybtn` — the
copy-conversation-to-clipboard button (`conversationCopyText` in
`message-content.js`): plain-text "User:/Assistant:" turns with images
and appended context blocks reduced to one-line references, never the
block bodies. Elements the pipeline embedded beside an answer (Street
View panorama / vision frames) are referenced too, as id-numbered
"[Embedded element #N: …]" lines — `stream.js` records them in
`convEmbeds` and persists that list in the conversation record
(`embeds`, an additive field inside the encrypted blob), so the export
stays complete after a reload even though the live embeds themselves
are session-only.

**What's stored per conversation**: title, the same `{role, content}`
message array `stream.js` already sends to `/api/chat`, plus the model /
time-budget / web-search settings it was sent with (restored when you
reopen it — `app.js`'s `onLoad` callback) and the ids/names of any
RAG-indexed documents (`ragDocs` — so follow-up questions keep
retrieving from them after a reload). Live-session-only details
(activity step traces, per-turn stats) are NOT persisted — reopening a
conversation shows the final messages, not a replay of the research
steps. Document-attachment names aren't reconstructed as chips on reload
either (their text was already embedded inline in the message when
sent) — both are accepted, cosmetic simplifications, not correctness
gaps.

## Cloud storage — the per-account `server_history` knob (default ON)

`/api/settings` (`src/settings.js`, stored in `users.settings_json`)
carries two knobs, rendered in the account panel's **Settings sub-view**
(its own level below the summary, like "Full usage & history" — a list
of `.settings-row` slide-switch rows, the ORIGINAL pre-spiderweb toggle
design as generic `.switch` classes, so future settings just add rows):
**"Store history in the cloud"** (documented here) and **"Shodan host
intelligence"** (default OFF — see "Shodan host intelligence" below). PUT
accepts a partial body (`{server_history?, shodan_mcp?}`) so each knob
saves independently. Each row is a SINGLE line — label, an **ⓘ** glyph,
and the switch — with the full explanation behind a press-and-hold (or
click-the-ⓘ) popover, the same gesture the composer's web-search knob
uses (`wireSettingPopovers` in `public/js/account.js`); the popover keeps
the panel compact as knobs are added. The cloud knob is remembered
server-side (follows the account). **ON is the default** (an explicit product decision when
the feature shipped — only a stored, explicit `false` opts out; absent/
malformed settings mean on), and `/api/settings` reports the EFFECTIVE
state: an identity that can't use storage (break-glass, missing R2
binding) always reads as off, so clients never dual-write into 503s.
Because most accounts never touch the knob, `app.js` runs a quiet,
fail-soft boot reconcile whenever the effective state is on: a diff-only
`syncToServer()` push plus `pullNewer()`. OFF restores exactly the
original posture above — nothing conversation-derived stored
server-side.

**The storage split is the point to preserve when touching any of this:**
- **Conversations** (`src/storage.js`, R2 `convos/{uid}/{convId}`): the
  SAME record the browser writes to its own IndexedDB — the encrypted
  `{iv, ciphertext}` blob (under the same `/api/history-key` mechanism
  regardless of where it rests) for ordinary chats, a readable `{data}`
  record for project chats (RAG-indexed — the exception above; the
  client chooses the form per record, the server stores what it's
  given, the same posture as `x-file-enc` on files). `history-store.js`
  dual-writes each save and propagates
  deletes; `sync.js`'s `pullNewer()` (on sidebar open) downloads records
  written from other devices — cloud mode is therefore also cross-device
  history sync, which local-only mode deliberately never was.
- **Original attached files** (`files/{uid}/{fileId}`): stored in
  STORAGE FORM — AES-GCM ciphertext under the same never-persisted
  history key (raw-bytes helpers in `history-store.js`; `attachments.js`
  encrypts before anything rests anywhere, OPFS included) for EVERY file
  — images especially — except the ONE deliberate exception: RAG-indexed
  documents, whose search index needs readable text anyway. The `enc`
  flag rides in `x-file-enc` / R2 customMetadata / the OPFS meta rows;
  sync moves the stored bytes as-is (no decrypt/re-encrypt round trip),
  and `syncToServer` self-heals legacy plaintext (re-encrypts in place,
  re-uploads a remote copy in the wrong form). A file that should be
  encrypted but can't be (no key) is stored NOWHERE — never a plaintext
  fallback.
- **RAG index** (`src/rag.js`): vectors in **Vectorize** (ids
  `{uid}:{docId}:{seq}`, metadata `{u, d, seq, text}`, metadata index on
  `u`), plus one exportable JSON copy per document in R2
  (`rag/{uid}/{docId}`, chunks + base64 vectors) so draining back to the
  client never re-embeds. Also not encrypted — retrieval needs readable
  chunk text.

**Why R2 (+ Vectorize) and not D1** — the storage judgement call:
conversation records with inline images run to several MB (past D1's
2 MB row ceiling), original files up to 25 MB, and similarity search
inside the Worker would burn the CPU budget the pipeline already
competes for. D1 only gained the `settings_json` column; every blob
lives in R2; vectors live in Vectorize. Both bindings are OPTIONAL and
commented out in `wrangler.toml` (creating them is a one-time
`wrangler r2 bucket create` / `vectorize create` — see the file's
comments; declaring a binding for a nonexistent resource fails every
deploy). Without them the feature is invisible: `/api/settings` reports
it unavailable and the UI never shows the knob.

**Flipping the knob is a sync, not just a flag** (`public/js/sync.js`):
- **On** → push all local conversation ciphertexts (compared by
  `updatedAt`), OPFS originals, and locally-indexed RAG docs (vectors
  included). Local copies stay — the app keeps working local-first, with
  the cloud as the account-wide copy.
- **Off** → pull down everything newer/missing, and ONLY if every item
  came down clean, `DELETE /api/storage` wipes convos + files + RAG
  exports + vectors in one call. A partial pull never deletes the only
  complete copy; the toggle reports it kept the cloud copies and can be
  retried. Read/delete endpoints deliberately stay open while the knob
  is off — that IS the drain path.

## Large documents — RAG (OPFS + IndexedDB locally, Vectorize + R2 in cloud mode)

Documents whose extracted text exceeds the 9K inline budget are no
longer truncated to their first ~2 pages — `attachments.js` parses them
in full (up to ~8M chars, i.e. thousands of pages), stores the original
bytes in **OPFS** (`opfs.js` — all attached files, images included, keep
their originals there; metadata rows live in the `dr_rag` IndexedDB),
and indexes them for retrieval (`public/js/rag.js`): ~1.4K-char chunks
with 200-char overlap, embedded in batches through **`POST /api/embed`**
— a quota-gated, usage-recorded proxy to **Berget's embedding model**
(`intfloat/multilingual-e5-large`, 1024 dims, e5 `query:`/`passage:`
prefixes applied server-side so client and server can't drift). The
attachment card shows live indexing progress; sending waits for it
(`indexingBusy()`); an indexing failure degrades to exactly the old
behavior (first 9K chars inline, marked truncated).

At send time (`stream.js`), every question retrieves the top-k most
relevant chunks across ALL of the conversation's indexed docs and embeds
them as labeled excerpt blocks (bounded to ~12K chars) — follow-up
questions keep retrieving without re-attaching. Where retrieval runs
follows the knob: local mode does cosine top-k over IndexedDB vectors in
the browser; cloud mode queries Vectorize (`POST /api/rag/query`) — which
can hold docs indexed on another device — and falls back to the local
index if the server comes up empty or errors. A newly attached doc that
retrieval misses entirely still contributes its opening chunks
(`firstChunks`) so it is never silently absent from its own turn.

**Encryption asymmetry, stated once more because it's the design**:
non-project conversations AND attached-file originals (images included)
are ciphertext in BOTH locations; the plaintext, in both locations, is
exactly what's indexed — the RAG index itself, RAG-indexed documents'
originals, and project-chat records (indexed by `chat-rag.js`) — because
retrieval requires readable text. Keep the settings UI, `/help/`, and
the privacy notice consistent with that whenever any of it changes.

## Projects — collections of chats and files, with their own cloud knob

A project (`public/js/projects.js` data/rules, `projects-ui.js` panel,
`project-context.js` pure builders) is a named collection of
conversations and materials. Everything reuses the machinery above —
nothing project-specific was invented storage-side:

- **The record**: one encrypted blob per project (name, file inventory
  incl. extracted metadata, the per-project knob — all inside the
  ciphertext), in the `dr_history` IndexedDB's `projects` store (DB v2)
  and mirrored to R2 `projects/{uid}/{id}` (same handler as
  conversations, `src/storage.js`). Conversation rows carry a `projectId`
  — plaintext LOCALLY only (a random uuid revealing grouping, not
  content; sync needs it to honor project knobs without decrypting), and
  additionally inside the record data. The project's CONVERSATIONS are
  the readable exception documented under "Chat history" — their records
  rest plaintext because of the chat indexing below.
- **Chats are indexed too** (`public/js/chat-rag.js`): every conversation
  in a project is a RAG doc of its own (`chat-<convId>`, named by the
  chat's title), **growing with the conversation** — after each persisted
  exchange, `stream.js` calls `indexChatTurns`, which chunks/embeds ONLY
  the turns not yet indexed (the doc row's `srcMsgs` counter tracks
  progress; a failed embed retries on the next exchange) and appends them
  (`rag.js`'s `appendToDoc`; the cloud mirror re-pushes the whole doc —
  vectors ride along, nothing re-embeds). Indexed text is the user's
  actual questions (appended context blocks stripped — re-indexing
  retrieval excerpts would echo documents back as second-hand chunks)
  plus the full answers, with the title leading the first increment.
  Incognito chats are never indexed (nothing persists at all), and
  deleting a conversation/project deletes its chat docs from both rests
  (`deleteChatIndex`).
- **Materials**: added via picker or drag-drop onto the panel, or as a
  text note (title + content). Documents and notes are ALWAYS indexed
  (project material is reference material — no 9K inline cutoff logic
  here), their originals stored readable per the RAG exception; images
  get EXIF extracted (`exif.js`) into the inventory and their originals
  encrypted; unsupported types are archived encrypted, unindexed.
- **Scope**: a chat inside a project retrieves across the project's
  indexed docs, its SIBLING CHATS in the project (`siblingChatDocs` —
  newest first, capped; the current conversation is excluded since it IS
  the context; excerpts render under a "Related project chat" header,
  `message-content.js`), PLUS its own attachments — never another
  project's
  (retrieval is by explicit docId list; isolation is structural and
  e2e-asserted). Each send also carries the project-materials block
  (inventory + image EXIF — how a text pipeline "sees" project images).
  A fresh chat adopts the ACTIVE project on its first send; reopening a
  conversation re-enters its project (header chip shows which).
- **The per-project knob** (top of the open project panel, same slide
  switch): `serverStorage !== false` follows the account setting; an
  explicit false keeps the whole project — record, conversations, files,
  index — out of the cloud. Dual-writes consult it (`projectCloudOn`),
  bulk sync skips cloud-off projects, and flipping it drives the scoped
  moves (`sync.js`: `pushProjectScope` / `drainProjectScope` — the drain
  deletes ONLY that project's cloud objects, item by item, after
  confirming local copies; never the account-wide wipe).
- **Deleting a project** removes its files, index entries (chat docs
  included), conversations and record from BOTH rests; the per-project
  drain (`drainProjectScope`) likewise pulls down and deletes the
  project's chat docs alongside its files and records.

## The project vault — store/load a whole project under a user-held secret

The strictest storage tier (added 2026-07-10): any project — INCLUDING a
local-only one (its knob off, or the whole account knob off) — can be
parked server-side as ONE client-encrypted archive and loaded back on any
of the account's devices, without the server ever holding anything
readable or any key material. `src/vault.js` (endpoints) +
`public/js/vault.js` (everything cryptographic + the pack/load
orchestration); UI in `projects-ui.js` (the panel's "Encrypted copy,
keyed by a secret" store section, the sidebar's "🔑 Load project from
secret" form).

- **The secret is the whole key hierarchy**: 160 CSPRNG bits, shown once
  as `DR1-` + 8×4 Crockford base32 chars (no I/L/O/U — copy-safe;
  normalization forgives case, separators, and O→0 / I,l→1 misreads,
  including in a mangled prefix). HKDF-SHA-256 derives BOTH the storage
  id (`info="…vault id v1"`) and the AES-256-GCM key
  (`info="…vault key v1"`) — the secret locates AND decrypts; the server
  stores an unlabeled opaque blob at `vault/{uid}/{id}` it can never
  read. This is deliberately stronger than the history-key model: there
  the server could re-derive the key; here it holds nothing derivable.
  The secret is NEVER persisted anywhere — losing it loses the copy, by
  design (no recovery path; say so in UI copy, don't soften it).
- **The archive is self-contained under the secret alone**: project
  record, its conversations, file ORIGINALS (decrypted from their
  history-key storage form first, so the archive doesn't depend on that
  key), and its RAG docs with vectors (nothing re-embeds on load). On
  load everything returns to its normal storage form: files re-encrypted
  under the history key (RAG-indexed docs readable, as always; no key →
  file skipped, never stored readable), records via the normal
  save paths, LWW by updatedAt, gap-filling.
- **Import honors the archived project's own cloud posture** — a
  local-only project loads as local-only (`cloud` follows the record's
  `serverStorage`), so loading never silently uploads anything readable.
- **NOT `server_history`-gated** (unlike every `src/storage.js` write):
  each store is its own explicit consent act, and the whole point is
  serving knob-off projects. Gated only on `storageAvailability` (R2
  binding + user row). Per-user namespacing means a vault blob is only
  reachable from the account that stored it — the secret alone is not
  enough from another account.
- **Excluded from the drain-wipe**: `DELETE /api/storage` (account knob
  off) deliberately does NOT touch `vault/{uid}/` — those copies are
  often made precisely because the knob is going off. Keep it that way.
- **Re-storing rotates**: the record remembers its `vaultId` (inside the
  encrypted record); a new store uploads under the NEW secret's id,
  updates `vaultId`, deletes the old blob — the old secret stops
  working. Caps: 100 MB/archive, 50 objects/user (`MAX_VAULT_OBJECTS`).
- Disclosed at `/help/` ("Backing up or moving a project with a secret" +
  a "Privacy, in full" bullet) — keep those consistent with any change
  here.


## DRC — "deep research secure": the client-side public tier at /cure

The two product tiers, named by the .se wordplay (2026-07-10 directive):

- **DRC** — deepresearch.se/**cure** = "deep research SECURE"; the **C**
  also reads CLIENT-side. The public, no-account tier: minimal server
  components BY DESIGN, direct browser→provider model calls, and
  BROWSER-LOCAL storage only. The root `/` 302s to `/cure`.
- **DRS** — deepresearch.se/**rver** = "deep research SERVER"; the **R**
  reads REMOTE, as in a remote cloud-server. The signed-in tier: the
  hosted pipeline, live web search, accounts, quotas, cloud storage —
  everything else this skill documents. Sign-in/terms redirects land on
  /rver; the PWA manifest starts there.

DRC's modularity is the design requirement: the page
(`public/cure/index.html` + `drc.js` + `drc.css`) is wiring over four
self-contained, Node-tested modules — `public/js/drc-core.js` (one
master secret → HKDF-derived reference/blob id/blob key; the sealed
state; NOTE: the HKDF info strings and state-kind constant are frozen
pre-rename "free" values — changing them breaks existing secrets),
`drc-providers.js` (the CORS-capable provider registry: OpenAI + Groq
ONLY — providers without browser CORS can't join, that's the admission
ticket), `drc-research.js` (the client-side pipeline: triage → parallel
knowledge harvest → gap audit → streamed synthesis → validation, the
pipeline invariants held client-side), and `drc-store.js` (the storage
SEAM: sealed-state bytes in localStorage, injectable backend — a future
remote adapter slots in here, it is not a rewrite).

What the server does for DRC: serve static files and public replay
JSONs (`/api/pub`, src/pub.js — replays open in place at /cure/<slug>
and are continued by just typing, on the visitor's own key). Nothing
else. No blob store, no proxying, no keys in any form — "no content
logging" is structural: there is nothing to log. Projects are sealed
under the user's DR1-… master secret (password-manager form: real
username+password fields) and rest as ciphertext in THIS browser only;
a /my/project-<hash> link reopens a project only on a device that holds
it — the secret alone carries nothing across devices (that's DRS
territory, and a deliberate product line).
