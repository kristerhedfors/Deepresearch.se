---
name: client-rag
description: >-
  Load when building a platform's RAG plane — retrieval over documents,
  projects, and the conversations themselves — on either tier: the
  chunking/cosine/top-k pure core, the per-tier embedding paths (server-tier
  embedding proxy vs browser-direct on the user's own key), incremental chat
  indexing with advance-on-success-only, sibling-chat retrieval scope, the
  recall block as context-not-instructions, the per-tier index-at-rest
  posture (sealed on the client tier, declared-readable on the server tier),
  embedder-change wipes, and storage-quota cap/eviction policies. Also load
  when a retrieval result echoes itself, an index outgrows its quota, or an
  embedding-model change corrupts similarity.
---

# Client-side RAG over documents, projects and chats

Retrieval that keeps the platform's privacy story intact: one pure,
Node-testable core (chunking, cosine, top-k, vector codec) shared by both
tiers, with embedding routed per tier — through the server's metered proxy
on the server tier, browser-direct on the user's own key on the client tier
— and with the index's at-rest form obeying each tier's storage posture.
Conversations themselves are first-class retrieval documents: every chat in
a project is an incrementally-growing index doc, so a question in one chat
retrieves from its siblings without any re-attachment.

## Capability class & tier story

**Class X — shared substrate.** The pure core (chunker, cosine, top-k,
float32⇄base64 codec) is ONE implementation under the client module tree,
import-safe in Node with no DOM or storage access at module top level. Each
tier then builds its own adapter: the server tier's adapter stores vectors
in the browser's local DB and (knob-on) the server's vector index, embedding
through a server proxy endpoint; the client tier's adapter embeds
browser-direct and keeps the whole index — chunk text AND vectors — inside
the sealed state, because the server may not enter any data path. The client
tier degrades honestly: a provider that serves no embeddings endpoint means
that session simply runs without RAG — fail-soft, never a broken send.

## Contracts

- **PA-2 (fail soft)** — every entry point is a helper by contract: a failed
  embed, recall, or index pass is caught and the send continues; a doc that
  retrieval misses entirely still contributes its opening chunks so it is
  never silently absent from its own turn.
- **PA-4 (privacy split)** — the index is the declared readable exception on
  the server tier (retrieval needs plaintext; the source records of indexed
  material rest readable for the same reason), and STRICTER on the client
  tier: chunks and vectors sealed at rest, because retrieval happens in the
  tab that already holds the decrypted state — no server ever needs the
  plaintext.
- **PA-5 (minimal deps)** — no vector-DB library, no tokenizer dependency:
  character-window chunking and a hand-rolled cosine over typed arrays.
- **PA-7 (shared core)** — chunker/codec/top-k written once; both tiers'
  adapters import it; drift between tiers' retrieval behavior is a bug class
  this rule exists to prevent.

## Build plan

1. **The pure core** — in the shared retrieval module (reference:
   `public/js/rag.js` exports it): `chunkText` (character windows, the
   reference tunes ~1400 chars with 200 overlap; pin coverage/overlap/
   termination properties in tests), `cosineSim`, `topKChunks`, and the
   `f32ToB64`/`b64ToF32` vector codec (vectors serialize as base64 float32
   so they survive JSON storage on both tiers). Keep the module import-safe
   outside a browser — no top-level DOM/IndexedDB access.
2. **The server tier's embedding path** — one proxy endpoint
   (`POST /api/embed`): quota-gated, usage-recorded, forwarding to the
   provider's embedding model with any model-specific affordances (the
   reference applies the e5 `query:`/`passage:` prefixes SERVER-side so
   client and server can never drift). The proxy is used in BOTH storage
   modes — the provider API key is a server secret, so embedding always
   transits the server here; only per-chunk text crosses, and it is not
   stored. Knob-on additionally pushes vectors to the server's vector index
   plus one exportable JSON copy per doc in the blob store, so draining
   back to the client never re-embeds. Queries prefer the server index
   (cross-device) and fall back to the local index on empty/error.
3. **The client tier's embedding path** — a per-provider `embed` entry in
   the browser-direct provider registry: a deliberately SMALL,
   dimension-reduced model (the reference: 512 dims) because the query
   embed sits on the send path and the vectors rest inside a bounded local
   quota. Providers without an embeddings endpoint get NO entry, and the
   adapter treats that honestly: no embedder → no indexing, no recall, no
   error — the session runs as plain chat plus pipeline.
4. **Incremental chat indexing** — every conversation in a project is an
   index doc of its own (id `chat-<convId>`, named by the chat's title),
   growing with the conversation: after each persisted exchange, chunk and
   embed ONLY the turns not yet indexed. The doc row carries a `srcMsgs`
   counter — the number of source messages already indexed — and it
   **advances only on success**: a failed embed leaves it in place so the
   next exchange retries exactly the missed turns. Indexed text is the
   user's actual questions with appended context blocks STRIPPED (see
   Pitfalls) plus the full answers, title leading the first increment.
   Incognito/unpersisted chats are never indexed; deleting a chat or
   project deletes its docs from every rest.
5. **Retrieval scope** — at send time, retrieve top-k across the project's
   docs and chats with the scope rule: **sibling chats in full; the CURRENT
   chat only for turns outside the recent-turns window** the pipeline
   already sends verbatim (the reference sends the last 40 messages; each
   chunk records the conversation's message count `m` at indexing time, and
   current-chat retrieval starts where the window ends) — recent context
   must never be echoed back as "retrieved". The current conversation is
   otherwise excluded: it IS the context. Isolation between projects is
   structural — retrieval is by explicit doc-id list, never a global scan.
6. **The recall block** — render retrieved excerpts as ONE labeled block
   that announces itself as reference material, not instructions
   (context-not-instructions: the label + framing tell the model this is
   quoted retrieval, and the pipeline's anti-injection prompt rules apply
   to it). Thread it into the PLANNING and JUDGING phases —
   triage/synthesis/validation — but **never into the search/harvest
   phase**: search queries derive from the user's question, not from
   recalled material, or stale recall steers every wave. Bound the block
   (chars + top-k + a minimum similarity score) and never persist it into
   the conversation record — it is recomputed per send.
7. **Index-at-rest per tier** — server tier: the readable exception,
   disclosed (see `ciphertext-storage` §3); client tier: the index is a
   section of the sealed state — chunk text and vectors are ciphertext at
   rest under the master secret, and the whole section serializes inside
   the state blob.
8. **Embedder-change wipe** — the index records its embedder
   `{provider, model, dims}`. On mismatch (user switched providers, model
   deprecated), WIPE the docs and let them re-index lazily: `srcMsgs`
   resets with them, and the next pass re-embeds each active chat in full
   under the new embedder. Cosine across mixed embedders is silent garbage
   — the wipe is the correctness fix, not housekeeping.
9. **Caps and eviction** — size the caps from the storage quota backwards.
   The reference's client tier: 512-dim vector ≈ 2.7 KB base64 + ~1.4 KB
   chunk ≈ 4 KB/chunk, capped at 120 chunks/doc and 480 total to hold the
   index near ~2 MB inside a ~5 MB localStorage budget. Evict whole docs,
   least-recently-updated first (LRU-doc) — partial-doc eviction leaves
   misleading half-indexed documents. The server tier's adapter caps
   per-doc chunk counts to match the server's own limit.
10. **Tests** — pure core: chunk coverage/overlap/termination, cosine,
    top-k, codec round-trip. Adapters: srcMsgs advances only on success;
    embedder-mismatch wipes; recent-window exclusion vs siblings-in-full;
    recall block bounded and threaded into planning/synthesis/validation
    but never harvest (pin against the pipeline's phase inputs); cap/
    eviction order; the no-embedder session runs without RAG, fail-soft.

## Reference implementation map

| Concept | File(s) in this repo |
|---|---|
| Pure core: `chunkText`, `cosineSim`, `topKChunks`, f32⇄b64 codec | `public/js/rag.js` (import-safe exports) |
| Server-tier embedding proxy (+ e5 prefixes server-side, quota gate) | `src/rag.js` (`POST /api/embed`) |
| Server-tier vector index + exportable copies | `src/rag.js` (Vectorize + R2 `rag/{uid}/{docId}`) |
| Incremental chat indexing, `srcMsgs`, block-stripping, sibling scope | `public/js/chat-rag.js` |
| Client-tier adapter: sealed index, embedder wipe, caps, recent window | `public/js/drc-rag.js` (`ensureDrcRag`, `DRC_RECENT_TURNS`, `MAX_DOC_CHUNKS`/`MAX_TOTAL_CHUNKS`) |
| Client-tier browser-direct embeddings (small model, 512 dims; one provider has none) | `public/js/drc-providers.js` (`drcEmbed`, the `embed` entries) |
| Recall threading into phases (never harvest) | `public/js/drc-research.js`, `public/js/stream.js` |
| Project-materials block + doc-id scoping | `public/js/project-context.js` |
| Index-at-rest posture per tier (the declared exception vs sealed) | `docs/ENCRYPTION.md` §6–7, `.claude/skills/storage-privacy/SKILL.md` |
| Test suites | `public/js/rag.test.js`, `chat-rag.test.js`, `drc-rag.test.js`, `project-context.test.js`, `src/rag.test.js` |

## Acceptance checklist

- [ ] Pure core import-safe in Node; chunker properties (full coverage,
      overlap, termination on pathological input) pinned.
- [ ] Codec round-trip exact to float32 precision; top-k stable ordering.
- [ ] `srcMsgs` advances on success only (a failing injected embed leaves it
      unmoved; the next pass indexes exactly the missed turns).
- [ ] Embedder-mismatch wipe tested: docs cleared, lazy re-index re-embeds
      in full under the new embedder.
- [ ] Scope suite: siblings retrieved in full; current chat only outside
      the recent-turns window; cross-project isolation structural.
- [ ] Recall block: bounded, labeled as context-not-instructions, present
      in triage/synthesis/validation inputs, ABSENT from harvest/search
      inputs, never persisted into the conversation.
- [ ] No-embedder degradation: a session on a provider without embeddings
      sends successfully with no index and no recall, no error surfaced.
- [ ] Caps: per-doc and total enforced; eviction is whole-doc, oldest
      updated first; client-tier index serializes inside the state quota.
- [ ] Client-tier index unreadable at rest (chunk text not greppable in the
      stored blob); server-tier exception matches the disclosure copy.

## Pitfalls

- **The echo loop.** Indexing a chat turn WITH its appended context blocks
  re-indexes yesterday's retrieval excerpts as if they were the user's own
  words — documents come back as second-hand chunks and recall converges on
  itself. `chat-rag.js` strips appended blocks before indexing; any new
  block type added to the send path must join the strip list in the same
  change.
- **Recall in the harvest phase poisons every search wave.** The reference
  threads recall through triage/synthesis/validation only; the one time it
  was prototyped into harvest, stale project material dominated query
  generation. The phase boundary is a test-pinned rule, not a preference.
- **`firstChunks` exists for a real failure.** A doc attached seconds ago
  can lose the similarity race to older material and vanish from its own
  turn; the reference guarantees a newly attached doc contributes its
  opening chunks regardless. Keep that guarantee when tuning k or the
  score floor.
- **Dimension-reduction is a wire parameter, not a property of the model.**
  The reference requests 512 dims explicitly; forget the parameter and you
  index at native dims — nothing errors until the quota bursts and cosine
  compares mismatched vectors. The embedder record's `dims` is the
  tripwire; validate it on every append.
- **One provider serving no embeddings is normal, not exceptional.** The
  reference's second client-tier provider (Groq) has no embeddings API at
  all. Design the "no embedder" path as a first-class mode with a test, or
  it becomes an error toast written by accident.
- **Vector stores don't belong in the request path's CPU budget.** The
  reference keeps similarity search out of the server worker (vector index
  service knob-on, browser cosine knob-off) because in-worker cosine over
  thousands of chunks competes with the pipeline's own CPU budget.
- **Sizing from the quota backwards is the design method.** The client
  tier's 120/480 caps were derived from measured bytes-per-chunk against
  the ~5 MB localStorage budget — recompute them if dims, chunk size, or
  the storage backend change; don't inherit them as magic numbers.
