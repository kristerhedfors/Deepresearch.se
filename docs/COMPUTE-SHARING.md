# Compute sharing — sharing your local LLM as pooled capacity

Design for the "share your LLM compute" capability: a signed-in user who runs a
local OpenAI-compatible model (Ollama / LM Studio / llama.cpp — the keyless
`local` provider) can lend that compute to other people on the platform. The
server is a thin BROKER that hands their prompts to the sharer's browser, which
runs them against the local model and returns the completion. The sharer holds a
dashboard of who is using their capacity and can cut anyone off.

This document is the whole model in one place: topology, the token, the broker,
metering, the dashboard, the workspace integration, the privacy framing, the
abuse surface, and the phased build. It is written against the ACTUAL seams in
the tree (file:line references throughout) so the implementation follows it
directly.

> **Status (2026-07-23, second change):** design + backend backbone + the
> CLIENT halves + workspace knowledge. Shipped now: the strict **DRSC/1 wire
> profile** (§5b — the broker forwards a fixed whitelisted shape, never a
> passthrough body), the sharer's provider loop + "Share my compute" toggle,
> the consumer's pool provider + `?pt=` / workspace `grants.pool` intake, the
> data-flow notice every participant sees, and the **workspace knowledge**
> flow (§9b: 👍-curated conclusions, ±blocks with undo/redo, sealed transport
> + the owner's Se/rver-panel import). The privacy framing in §7 touches
> CLAUDE.md invariant 4 ("EXACTLY TWO deliberate Se/cure server-touching
> exceptions") and the SERVER-TOKEN GUARANTEE — it is written as the
> RECOMMENDED framing and is flagged for owner sign-off; the CLAUDE.md
> invariant text is NOT changed by this document. §9b's knowledge submit is
> framed the same way (an explicit, disclosed, user-initiated share — like
> filing feedback — not a pipeline data path) and awaits the same sign-off.
> Not yet built: the sharer's full account-panel dashboard UI (the endpoints
> exist; today oversight runs through `/api/pool` + the admin panel).

---

## 1. The idea, in one paragraph

Alice runs Ollama on her laptop. She signs in, opens her local-provider settings,
and flips **Allow proxy use** on. Her browser registers with the server as an
online *provider* for her personal *pool* and starts a background loop that
long-polls for work. Alice mints a **pool token** and hands it to Bob (directly,
or embedded in a shared secure workspace). Bob's client points its "LLM provider"
at the pool: every completion Bob's research pipeline needs is POSTed to the
server, parked in a job queue, pulled by Alice's browser, run against her Ollama,
and returned to Bob. Alice sees Bob in her **shared-compute dashboard** — his job
count and token totals — and can remove him with one click, which kills his token
immediately. Any number of sharers can do this at once; each pool is independent.

---

## 2. Why a D1 job queue and not WebSockets / Durable Objects

The whole Worker today is **stateless + D1** — there are no Durable Objects, no
Queues, no WebSocket usage anywhere (`wrangler.toml` declares only `DB`,
`STORAGE`, `RAG_INDEX`). Adding a Durable Object or Queue binding is not free
here: the `cpu_ms` and R2/Vectorize incidents (documented in
`tests/MODEL-EVAL-FINDINGS.md` and `wrangler.toml`) show that a binding whose
resource does not pre-exist makes **every deploy fail outright**. "Very simple and
robust" plus invariant 5 ("minimal dependencies") points hard at staying inside
the primitive the codebase already runs on.

So the broker is a **D1-backed job queue with HTTP long-poll**, mirroring the
existing grant meters (`src/server-grants.js`) almost exactly:

- **Robust by construction.** A dropped provider's claimed jobs time out and
  requeue. No online provider ⇒ the consumer gets a fast `no_capacity` (fail-soft,
  invariant 2). No D1 ⇒ the whole feature is off (503), never an unmetered path.
- **No new infra.** Nothing added to `wrangler.toml`; no deploy fragility.
- **Familiar meter.** The same atomic `UPDATE … WHERE used < quota` reserve /
  refund-on-failure discipline the token grants already use and test.

The cost is latency: a job waits up to one poll cycle before a provider picks it
up, and the consumer's request is held open while the peer runs the model. For a
research pipeline whose phases are already multi-second LLM calls, a sub-second
dispatch overhead is invisible. Streaming across the relay is deliberately **out
of scope for v1** (see §11) — pooled completions return whole (`stream:false`),
which is exactly what the pipeline's JSON-mode and non-streamed phases already do.

---

## 3. Topology and vocabulary

```
   PROVIDER (sharer, signed in)              BROKER (Worker + D1)                 CONSUMER (holds a pool token)
   ┌───────────────────────────┐            ┌──────────────────────┐             ┌───────────────────────────┐
   │ browser tab, "Allow proxy │            │  pool_providers      │             │ Se/cure or Se/rver client │
   │ use" ON                   │            │  pool_jobs (queue)   │             │ LLM provider = the pool   │
   │                           │  poll ───▶ │  pool_consumers      │ ◀── submit  │                           │
   │ local Ollama/LM Studio    │  result ─▶ │  pool_tokens (meter) │  ── result  │ research pipeline         │
   └───────────────────────────┘            └──────────────────────┘             └───────────────────────────┘
              │  localhost /chat/completions          ▲   dashboard / revoke  │
              └───────────────────────────────────────┴───────────────────────┘
```

- **Pool** — a sharer's shared capacity. `pool_id == the sharer's account id`:
  one pool per user, dead simple. Oversight and accountability are naturally
  per-sharer ("who used *my* compute").
- **Provider** — one online browser tab serving a pool. A sharer with two tabs
  or two devices registers two provider rows under the *same* pool_id; the broker
  load-balances a pool's jobs across its online providers. That is the entire
  "distribute queries among available clients" mechanism — no cross-pool routing,
  no global scheduler, no fairness math.
- **Consumer** — whoever submits jobs, authorized by a **pool token**. Keyed by
  `consumer_key`: the account id for a signed-in consumer, or the token `jti` for
  an anonymous (Se/cure / workspace) consumer.
- **Platform = many independent pools.** "More than one client with shareable
  capacity sharing to a larger number of clients" is just many pools coexisting.
  Each sharer controls their own; a consumer may hold tokens to several.

---

## 4. The pool token

A pool token is a signed, self-describing capability, minted by the sharer,
carried to the consumer. It is a **separate token family** from the Se/rver JWT —
NOT a new `perm` on the consolidated Se/rver token — for two deliberate reasons:

1. **It binds a pool.** A pool token must name *which* pool it may submit to
   (`pool` claim). The Se/rver token's closed claim set has no such field.
2. **It keeps the SERVER-TOKEN GUARANTEE pristine.** That guarantee
   (`src/server-token.js:16-45`) is worded precisely around *server-operated*
   upstreams (Exa key, Berget key) and is pinned by tests. A pool token routes to
   a *peer-operated* upstream — a genuinely different disclosure. Rather than
   dilute the guarantee's wording, pool tokens get their own family and their own
   (parallel) guarantee.

Wire format mirrors the `wsk1`/`prg1` families (`src/token-crypto.js`), not the
JWT: namespace `pool.`, signing input `"pool." + b64url(JSON(claims))`, hex
HMAC-SHA-256 tag under the one `SESSION_SECRET`. Prefix `pt1.` so it is
recognizable and greppable.

```
pt1.<b64url(claims)>.<hex sig over "pool." + b64url(claims)>

claims = {
  jti:  <uuid>,        // the D1 meter row key + revocation handle
  pool: <account id>,  // which pool this token may submit to
  sub:  <minter id>,   // the sharer (== pool, but explicit for symmetry)
  iat, exp             // one duration for the whole grant
}
```

Family separation holds structurally the same way the existing families do: a
distinct namespace string means a `pool.` tag never validates as `websearch.` /
`proxygrant.` / `proxytoken.`, and the hex signature never parses as a Se/rver
JWT's base64url segment (`src/server-token.js:50-62` documents the same
reasoning). `src/pool-token.js` is the token half (mint + verify, pure over Web
Crypto); the meter is D1 rows, exactly as `server-token.js` splits from
`server-grants.js`.

### THE POOL-TOKEN GUARANTEE (the parallel to the server-token one)

> A pool token authorizes ONE thing: submitting LLM completion jobs to the ONE
> pool it names. It is never a login (`identify()` rejects it, like every token
> family — pinned by test), and it never unlocks any Se/rver data. What it *does*
> expose, and what makes it different from a Se/rver token, is stated plainly to
> the user: **the prompt you submit is read by the pool owner's machine.** That
> peer exposure is the feature, and it is disclosed at the point of use (§7).

---

## 5. The broker — data model and flows

### D1 tables (added to `src/db.js`'s `SCHEMA`, following `server_tokens`)

```sql
-- one row per ONLINE provider tab; heartbeated; stale ⇒ offline
CREATE TABLE pool_providers (
  provider_id TEXT PRIMARY KEY,      -- random per registration
  pool_id     TEXT NOT NULL,         -- == sharer account id
  user_id     TEXT NOT NULL,         -- sharer (accountability)
  label       TEXT,                  -- "Alice's Ollama"
  models_json TEXT,                  -- advertised model ids
  concurrency INTEGER NOT NULL DEFAULT 1,
  created_at  INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL      -- heartbeat; now - last_seen > STALE ⇒ gone
);
CREATE INDEX idx_pool_providers_pool ON pool_providers(pool_id, last_seen_at DESC);

-- the job queue: the consumer's prompt lives here transiently
CREATE TABLE pool_jobs (
  job_id       TEXT PRIMARY KEY,
  pool_id      TEXT NOT NULL,
  consumer_key TEXT NOT NULL,        -- account id or token jti
  token_jti    TEXT NOT NULL,        -- the meter row / revocation handle
  status       TEXT NOT NULL,        -- queued|claimed|done|error|expired
  provider_id  TEXT,                 -- which provider claimed it
  model        TEXT,
  request_json TEXT NOT NULL,        -- OpenAI-wire body (the PROMPT)
  response_json TEXT,                -- the completion
  error        TEXT,
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL,
  claimed_at   INTEGER,
  done_at      INTEGER,
  expires_at   INTEGER NOT NULL      -- job TTL; stale claimed ⇒ requeue/expire
);
CREATE INDEX idx_pool_jobs_dispatch ON pool_jobs(pool_id, status, created_at);
CREATE INDEX idx_pool_jobs_consumer ON pool_jobs(consumer_key, created_at DESC);

-- the meter + the dashboard aggregate + the allow/block list, in one row
CREATE TABLE pool_consumers (
  pool_id      TEXT NOT NULL,
  consumer_key TEXT NOT NULL,
  token_jti    TEXT,                 -- most recent token seen
  display      TEXT,                 -- email/name if authed, else short jti
  state        TEXT NOT NULL DEFAULT 'active',   -- active|blocked
  jobs         INTEGER NOT NULL DEFAULT 0,
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  first_at     INTEGER NOT NULL,
  last_at      INTEGER NOT NULL,
  PRIMARY KEY (pool_id, consumer_key)
);

-- the per-token quota meter (0 = uncapped: "any number of requests")
CREATE TABLE pool_tokens (
  jti        TEXT PRIMARY KEY,
  pool_id    TEXT NOT NULL,
  user_id    TEXT NOT NULL,          -- minter
  quota      INTEGER NOT NULL DEFAULT 0,  -- 0 = uncapped
  used       INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  label      TEXT,
  source     TEXT                    -- 'self' | 'workspace' | 'link'
);
CREATE INDEX idx_pool_tokens_pool ON pool_tokens(pool_id, expires_at DESC);
CREATE INDEX idx_pool_tokens_exp  ON pool_tokens(expires_at);
```

### Flow A — sharer turns on "Allow proxy use"

1. Toggle in the local-provider settings. **Requires a signed-in identity** (the
   dashboard, revocation, and accountability all need an account). From `/cure`
   the session cookie is same-origin, so the authed register endpoint identifies a
   signed-in ghost; a non-signed-in Se/cure visitor is offered a sign-in prompt
   instead of the toggle.
2. `POST /api/pool/register` (AUTHED) `{ label, models[], concurrency }` →
   upserts a `pool_providers` row keyed by a fresh `provider_id`, `pool_id =
   identity.id`. Returns `{ provider_id, pool_id }`.
3. The browser starts the **provider loop** (§6), modeled on
   `public/js/recovery.js`'s `recoverAnswer` poll loop.

### Flow B — provider loop (the sharer's browser, while ON)

```
loop while enabled and not aborted:
  POST /api/pool/poll {provider_id}         # AUTHED; heartbeats + claims one job
      → { job: {job_id, model, request} }   #   or { job: null } after a bounded wait
  if job:
      run request against the local model (browser fetch localhost/chat/completions)
      POST /api/pool/result {provider_id, job_id, response|error, usage}   # AUTHED
  else:
      short backoff, loop
```

Claiming is atomic and lost-provider-safe:

```sql
-- candidate then guarded update; retry on changes=0 (another provider won it)
UPDATE pool_jobs SET status='claimed', provider_id=?1, claimed_at=?2
 WHERE job_id=?3 AND status='queued';
```

`poll` also (a) bumps `last_seen_at` (the heartbeat), and (b) before claiming,
**requeues** any job of this pool whose `status='claimed'` and
`claimed_at < now - CLAIM_STALE` (its provider vanished mid-job) — so a dropped
provider never strands a consumer.

### Flow C — consumer submits a completion

```
POST /api/pool/chat/completions           # PUBLIC (token is the authority)
  Authorization: Bearer pt1.…
  body: OpenAI-wire { model, messages, ... }

server:
  1. verify pool token (family pool., pool claim ⇒ pool_id)          → 403 on bad/expired
  2. pool_consumers[pool_id, consumer_key].state == 'blocked'?       → 403 blocked
  3. is a provider online for this pool advertising `model`?         → 503 no_capacity (FAST, fail-soft)
  4. reserve one unit on pool_tokens[jti] (skip if quota==0)         → 429 quota_used
  5. INSERT pool_jobs (status='queued', request_json=body)
  6. long-poll: wait (bounded by job TTL) for status → done|error|expired
       done  → return response_json (OpenAI-wire); bump pool_consumers metrics; return remaining
       error → 502 upstream_error; refund the unit
       expire→ 504 timeout; refund the unit; mark job expired
```

Step 3 makes "no capacity" cheap and non-blocking — the consumer never waits on a
pool nobody is serving. Steps 4 and the refunds reuse the meter discipline
verbatim from `server-grants.js:301-342`.

### 5b. The DRSC/1 wire profile (the "proper solid protocol wrapper")

A pooled job relays a prompt to ANOTHER USER'S MACHINE, so the broker never
forwards an arbitrary passthrough body. Every `/api/pool/llm/chat/completions`
body is forced through `sanitizePoolRequest` (`public/js/pool-core.js` — a
pure core the Worker imports directly, so client and server enforce the SAME
function and can never drift). **DRSC/1** is a deliberately narrow profile of
the OpenAI chat-completions wire:

- **Whitelisted, nothing else:** `model` (required), `messages` as plain
  `{role, content:string}` pairs with roles limited to
  `system`/`user`/`assistant`, and exactly two tuning knobs — `temperature`
  (clamped 0..2) and `max_tokens` (capped). Unknown fields — tools, functions,
  `response_format`, `logit_bias`, `n`, `user`, vendor params — are STRIPPED,
  so ordinary OpenAI-compatible clients drive the surface unchanged.
- **Placeholders over flexibility:** no multimodal content parts, no
  streaming (`stream` is forced `false` by construction), fixed caps on
  message count and total characters (a pool must not be an amplifier).
- **Structural problems reject** with stable codes (`bad_role`,
  `bad_content`, `too_large`, …) before any queueing or metering.
- The sanitized request carries a `wire: "DRSC/1"` stamp for auditability;
  the provider loop strips it (`poolRequestToOpenAiBody`) before the job
  touches the local model.

The profile is pinned by `public/js/pool-core.test.js` (the wire spec as a
test suite) and endpoint-level by `src/pool.test.js`.

### Why the consumer request holds open

The consumer POST is the request/response bridge: it blocks (bounded) until the
peer answers. This is the simplest robust design — no callback URL, no second
fetch to collect the result, no client-side reconciliation. If the peer never
answers, the job TTL fires, the consumer gets a clean 504, and the reserved unit
is refunded. Workers Paid's 5-minute CPU ceiling (`wrangler.toml [limits]`) makes
a held request of tens of seconds a non-issue; the job TTL is set well under it.

---

## 6. Client pieces

### Provider side (the sharer)

- **Toggle home:** the DRC local-provider row `#localrow`
  (`public/cure/index.html:282-301`), reflected by `renderLocalRow()`
  (`public/cure/drc.js:1109`) and persisted next to `state.localBaseUrl`
  (`public/js/drc-core.js:154`). The signed-in Se/rver account also gets a
  **"Share my LLM compute"** panel (§8) that carries the same toggle plus the
  dashboard.
- **The loop:** new machinery modeled on `recoverAnswer`
  (`public/js/recovery.js:94-150`) — a signal-abortable, fail-soft, hard-capped
  `while` loop. It calls the local model through the existing
  `drcChatStream`/`drcCompleteJson` path (`public/js/drc-providers.js:334-423`)
  with `stream:false`.

### Consumer side

- A **pool provider entry** in the DRC registry, parallel to `proxyLlmProvider`
  (`public/js/drc-providers.js:171-195`): `base: origin + "/api/pool"`, the pool
  token as the bearer, `proxied: true`. The research pipeline then drives it
  unchanged, exactly as it drives the proxy provider today.
- Token intake mirrors `connectProxyGrants` (`public/cure/drc.js:2334-2369`): a
  `?pt=` link (or the workspace bundle field, §9) is read, verified via a public
  non-consuming `POST /api/pool/status`, and stored.

---

## 7. Privacy framing (touches invariant 4 — owner sign-off)

Consuming a pool routes the consumer's prompt **through the server** (the
`pool_jobs.request_json` row) **to a peer's machine**. Two exposures, both must be
honest:

- **The server sees the prompt** transiently in the job row. This is the same
  exposure class as the proxy `api` grant (`src/server-grants.js:501-575`), which
  already routes Se/cure conversation content through the server to Berget. The
  job row is deleted on completion / expiry and is never written to any store
  (`chat_logs`, R2, Vectorize are not in this path — enforced by the same
  module-graph discipline the token subsystems use).
- **A peer sees the prompt.** This is genuinely new and stronger than any existing
  exception: not an anonymous upstream API but *another named user's computer*.

**Recommended framing (this document's position, pending owner sign-off):** treat
pool consumption as a **documented variant of the existing exception #2** (the
proxy `api` path) — "an upstream LLM, operated by a peer instead of Berget" —
rather than a brand-new third category. It reuses the connected-APIs disclosure
surface Se/cure already shows, plus a **stronger, unmissable** line at the point
of use: *"Answers are computed by another user's machine ([who]). They can read
everything you send."* Consuming a pool is opt-in, per-session, and shown in the
same "which APIs are connected" banner.

Under this framing invariant 4's "EXACTLY TWO exceptions" is unchanged in spirit —
peer compute is a variant of the second (a server-relayed upstream completion),
distinguished only by who operates the upstream. The alternative (declare a
literal THIRD exception and amend the invariant to say three) is cleaner to
audit but changes a load-bearing, owner-directive sentence. **Neither is written
into CLAUDE.md by this change** — the code ships behind the recommended framing
and the disclosure, and the invariant text is left for the owner to amend.

Providing (being a provider) is NOT a Se/cure exception: the provider's own data
never leaves; their browser receives *other* people's prompts and returns
completions. Providers must be signed in anyway, so sharing is a Se/rver-tier
action from the start.

**Minimal-outbound still holds for what the server forwards to the peer:** the
job carries the completion request the consumer chose to send and nothing else —
no identity, no filename, no account data. The consumer's `consumer_key`/display
is shown to the *pool owner* (that is the point of the dashboard) but is not sent
to the peer's model.

---

## 8. The sharer's dashboard ("full oversight")

There is no per-minter grant listing today — only admin-wide lists
(`src/websearch.js:236`, `src/proxy.js:635`). The dashboard is the main net-new
user surface. It slots into the account panel beside "Share a workspace"
(`public/js/account-views.js:404-411` for the button; a new
`public/js/account-pool.js` modeled on `public/js/account-feedback.js`).

- `GET /api/pool` (AUTHED) → the caller's pool: online providers, live tokens
  (with per-token quota/used), and the `pool_consumers` roster (display, jobs,
  prompt+completion tokens, first/last seen, state).
- `POST /api/pool/token` (AUTHED) → mint a pool token for the caller's pool
  (`{ label?, quota?, ttlHours? }`), returns `pt1.…` + a `?pt=` share link.
- `POST /api/pool/adjust` (AUTHED) → change a token's quota live (owner-scoped,
  the `adjustServerTokenQuota` pattern `src/server-grants.js:358`).
- `DELETE /api/pool/consumer/:key` (AUTHED) → **remove a user**: set
  `pool_consumers.state='blocked'`. Future jobs from that `consumer_key` are
  refused. Block-by-key survives token re-mints.
- `DELETE /api/pool/token/:jti` (AUTHED) → revoke a token (delete its meter row;
  the token stops working immediately, the `revokeServerToken` pattern).

"Any number of requests" is the default: a token minted with `quota=0` is
uncapped and only *counted*, never blocked. The dashboard is where the sharer
watches those counts and decides to block. Quotas are the opt-in cap for the
"transactional, metered" case the owner described.

---

## 9. Secure-workspace integration

Workspaces already carry the two existing grant families in the encrypted bundle
(`public/js/workspace-core.js:346-357`: `grants:{ ws?, proxy?[] }`) and hydrate
them on unlock via `connectProxyGrants` (`public/cure/drc.js:2659`). Pool sharing
slots in the same seam with **no new server exception** (same as the workspace
privacy note, `docs/WORKSPACE-SECURITY.md:169-175`):

- Extend the bundle payload with `grants.pool?: "pt1.…"` — a pool token the
  workspace owner minted for their pool. It rides entirely in the URL fragment
  (never sent to a server), exactly like the other grants.
- On unlock, hydrate it beside the proxy grants: verify via `POST
  /api/pool/status`, register the pool provider entry (§6), done.
- The workspace owner's oversight is the *same* dashboard (§8): workspace members
  who consume show up in `pool_consumers` keyed by their token `jti`, and the
  owner blocks/adjusts them there. Full oversight, one surface.

This is the "sharing through a token" the owner asked for, unified with the
platform case: a workspace pool token is just a pool token with `source:
'workspace'`.

**Every participant is told how data flows.** Unlocking a workspace that
carries `grants.pool` pops the privacy notice with the shared-compute
data-flow lines appended — `poolDataFlowNotice` (`public/js/pool-core.js`) is
the ONE source of that text, reused by the settings row's ⓘ and the sharer's
toggle copy: your prompt → this site's server (held only while the job runs,
never stored or logged) → the sharer's machine (which can read everything you
send) → back the same way; requests limited to the DRSC/1 shape; conclusions
you pass along are sealed before they leave the browser.

### 9b. Workspace knowledge — 👍-curated conclusions back to the owner

The return path: shared compute pushes the owner's models OUT to the
workspace; workspace knowledge passes curated CONCLUSIONS back IN. Pure core
`public/js/knowledge-core.js`, server half `src/knowledge.js`, curation pane
in `public/cure/drc.js`, owner import view `public/js/account-knowledge.js`.

- **Tap 👍 on any stored reply** (visible while a workspace pool token is
  present). The exchange becomes a CONCLUSION: a deterministic **context
  summary** (the preceding turns compressed client-side, editable) + the
  **query** + the **reply split into text blocks**.
- **Curate with ± :** tapping **＋** on a block tags it along as key context
  wherever the conclusion is used; **−** removes the block ENTIRELY — it is
  not shown in the pane and not included in anything exported. Every step
  runs through a pure reducer with full **undo/redo**, so a mis-tap never
  loses work (`curate`/`curationState`, test-pinned).
- **Sealed transport, one envelope, two routes.** The finalized bundle seals
  to the site's IMPORT-AGENT public key (`GET /api/knowledge/key`) as a
  `drskn-bundle` — the DRCR/1 ECIES suite (ECDH P-256 · HKDF-SHA-256 ·
  AES-256-GCM) with its own frozen kind + HKDF info so the two seal families
  can never cross-open. DEFAULT route: `POST /api/knowledge/submit`
  (authorized by the workspace's pool token; revocation- and block-aware;
  backlog-capped), resting as CIPHERTEXT in `knowledge_inbox`. MIGRATION
  route: the same envelope downloads as a **`.drskn` file** for out-of-band
  delivery.
- **The owner imports in the Se/rver panel** (account panel → **Workspace
  knowledge**): list (metadata only), Import (the server decrypts with the
  agent key and returns the bundle to the owner alone), Copy-as-context
  (`conclusionToContext` — summary + question + key points, ready to paste
  into any chat or project), Delete — and an upload box for `.drskn` files,
  which the server refuses to open unless the bundle's `owner` field IS the
  caller (the pool id the sender's token named), so a stray blob can't be
  read by a signed-in bystander.
- **Posture, stated plainly:** the import agent's private key lives in D1,
  so THE SERVER CAN DECRYPT these envelopes — deliberate (the owner asked
  for "encrypted with the server agent's public key") and disclosed in the
  data-flow notice. What the seal buys: ciphertext at rest, plaintext only
  at the owner's explicit import, nothing about a conclusion ever logged.
  For knowledge the server must never be able to read, the DRCR/1 campaign
  path (client-held keys, `docs/CROWD-RESEARCH.md`) is the tool.

---

## 10. Abuse surface and mitigations

- **A malicious provider returns garbage / poisoned completions.** Inherent to
  trusting a peer's model — mitigated by disclosure (the consumer chose this pool)
  and by keeping pools *named* (you consume a specific person's pool, not an
  anonymous swarm). Not mixed across pools, so a bad actor can only affect people
  who accepted *their* token.
- **A malicious consumer floods a pool.** Per-token quota (opt-in) + the sharer's
  one-click block. The provider's own browser is the rate limiter — it pulls one
  job at a time per `concurrency`.
- **Prompt exfiltration by the provider.** This is the core disclosed risk (§7),
  not a bug. The dashboard makes the *reverse* visible (who used you); the
  consumer's protection is that they opted into a named peer.
- **Server as amplifier.** The job row is bounded (request size capped like the
  proxy body), TTL'd, and deleted. No unmetered path: no D1 ⇒ 503. The global
  budget ceiling pattern (`config.pool.budget`) caps total outstanding quota like
  the other grant families.
- **Token leakage.** A leaked pool token lets a stranger use the sharer's compute
  — bounded by quota and killed by revocation, same blast radius as a leaked
  proxy grant. Short default TTL.
- **Provider registration abuse (non-sharer spamming register).** `register` is
  authed and one pool per account; providers are heartbeat-expired.

---

## 11. Explicitly out of scope for v1 (and why)

- **Streaming completions across the relay.** The pipeline's pooled phases run
  `stream:false`; the user-facing synthesis stream stays on the consumer's own
  primary model. Relaying token-by-token would need a second channel and buys
  little for a research pipeline. Revisit if pooled synthesis is wanted.
- **Cross-pool / global scheduling.** Per-pool keeps accounting honest and the
  system simple. A "meta-pool" that spreads one consumer across many sharers'
  compute raises fairness and trust questions the owner did not ask for.
- **Non-LLM compute (embeddings, vision).** The token vocabulary is completion
  jobs only for v1; embeddings could be a second job `kind` later, metered the
  same way.

---

## 12. Build phases

1. **Backbone (this change).** `src/pool-token.js` (mint/verify + tests),
   `src/pool.js` (broker: register/poll/result/submit/status + dashboard/admin
   endpoints + tests), `pool_*` tables in `src/db.js`, the `pool` config block in
   `src/config.js`, routes in `src/index.js`, admin dispatch in `src/admin-api.js`.
   All framing-independent, all unit-tested against the meter/queue logic.
2. **Sharer client.** The `#localrow` toggle + the provider poll loop + the
   account "Share my LLM compute" dashboard panel.
3. **Consumer client.** The pool provider registry entry + `?pt=` intake.
4. **Workspace + admin UI.** The `grants.pool` bundle field + hydration; the admin
   "Compute pool" section.
5. **Live verification.** `wrangler tail` correlation, a two-browser end-to-end
   (one sharing, one consuming), and the Swedish-parity gate for any intent copy.

---

## 13. Code layout (new modules)

| Module | Role |
|---|---|
| `src/pool-token.js` | The `pt1.` token family — mint + verify, pure over Web Crypto (mirrors `server-token.js`). |
| `src/pool.js` | The broker + all endpoints + the D1 meter/queue (mirrors `server-grants.js`); enforces DRSC/1 via the shared core. |
| `src/knowledge.js` | The workspace-knowledge inbox: import-agent keypair, sealed submit, owner list/import/open/delete (§9b). |
| `public/js/pool-core.js` | The DRSC/1 wire profile (`sanitizePoolRequest`) + the data-flow notice — ONE pure core, imported by client AND Worker. |
| `public/js/pool-provider.js` | The provider poll loop (mirrors `recovery.js`); dependency-injected transport, Node-tested. |
| `public/js/knowledge-core.js` | Conclusions, ±block curation with undo/redo, the `drskn-bundle` ECIES seal (§9b). |
| `public/js/account-knowledge.js` | The owner's "Workspace knowledge" import view in the account panel (§9b). |
| `public/js/account-pool.js` | The sharer dashboard account panel (mirrors `account-feedback.js`) — NOT YET BUILT (endpoints live). |

Server files re-export any shared pure core per the mirror discipline. This table
is reflected into `docs/CODE-LAYOUT.md` in the same change that adds the modules.
