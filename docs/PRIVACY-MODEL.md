# The privacy split — the full model (CLAUDE.md invariant 4)

The complete statement of the privacy model behind CLAUDE.md's invariant 4,
split out of CLAUDE.md (2026-07-17) so the always-loaded guide carries the crisp
rules and this file carries the full subsystem map, endpoints, token families
and dated owner directives. Companions: `docs/ENCRYPTION.md`,
`docs/SERVER-TOKENS.md`, `docs/WORKSPACE-SECURITY.md`, and the
**storage-privacy** / **secure-workspaces** / **quota-grant-assessment**
skills.

**This model applied per workspace: `docs/WORKSPACES.md`.** The rules below
are stated per subsystem; the workspace document restates them per *place a
user works* — a Se/cure workspace and a Se/rver workspace, each with an
exposure ledger ("an attacker who has X gets Y"), plus the channels that
distribute research outward and aggregate findings back. Where this file says
*project*, read **Se/rver workspace**: the noun changed in user-facing copy on
2026-07-25 while the code identifiers (`/api/projects*`, R2
`projects/{uid}/…`) deliberately did not (`docs/BRANDING.md`).

**The rule.** Cloud storage is IMPLICIT on the Se/rver tier
(2026-07-16 owner directive — the TIER is the choice, not a switch):
every conversation and project is always stored in the cloud, with NO
per-account or per-project opt-out (the former `server_history` knob and
project knob are gone); the never-cloud tier is Se/cure, where the
server is in no data path at all. Conversations and attached-file
originals rest as ciphertext in BOTH the browser and R2. The ONLY
readable exceptions are RAG-indexed material and project chats, because
retrieval needs plaintext. The encryption key is derived server-side and
held only in memory, never at rest beside the ciphertext. The
secret-keyed project vault (`src/vault.js` + `public/js/vault.js`) is
the strictest tier: archives rest server-side as ciphertext under a
user-held secret the server never sees and cannot derive. Since 2026-07-08
(explicit product decision) the server ALSO keeps a full-visibility
interaction log (`src/chatlog.js`, D1 `chat_logs`): every completed
exchange's complete question, answer, and research metadata — UNLESS the
conversation carries `incognito: true` on `/api/chat`, the
anonymous-chat API promise that must keep suppressing the log row.
Since 2026-07-10 the ghost BUTTON no longer toggles that flag — its new
meaning is THE DOOR TO DRC (clicking it navigates to /cure, the
structurally stronger anonymity); the API contract stays honored for
any client that sends the flag. DRC — "deep research secure", the
public CLIENT-side tier at `/cure` — extends the strict tier to a whole
surface, structurally: no accounts, and the server is in NO data path
at all. The browser calls the user's own CORS-capable providers
(OpenAI, Anthropic, Groq, Berget — or, since 2026-07-15, ANY other
OpenAI-compatible endpoint, the keyless `local` provider entry; point that
at a server on the user's OWN machine — Ollama / LM Studio / llama.cpp —
and NO third party receives the conversation at all) directly, runs the
research pipeline client-side, and
stores the sealed project state (chats AND the user's API keys inside)
in the BROWSER's own storage. The server serves static files and public
replay JSONs, so it could not log content or keys even in principle.
Secrets never appear in any log.
Outbound requests to third parties carry the minimum (a query, a
coordinate, a host), never the conversation, filename, or account
identity.

**Browser-local answer routes on Se/rver.** Two Se/rver sends never
reach `/api/chat` at all, so they produce no `chat_logs` row and no
provider call from the server: (1) introspection's PRIVATE route — the
user picked an own-key model in TIN's panel, and the exchange runs
browser-direct on that key through the client-side pipeline; (2) the
ON-DEVICE models (2026-07-24, `public/js/ondevice-drs.js` +
`stream.js runOnDeviceExchange`) — a downloaded 1-bit Bonsai model runs
inside the browser on WebGPU (the same engine Se/cure ships,
`docs/BONSAI-27B-PHONE-INFERENCE.md`), so the question reaches NO
provider and no server pipeline; live web search, RAG retrieval, and the
server-side enrichments are off for those sends because each one is a
server call. Both routes still persist the conversation under the tier's
normal rule above (ciphertext in the browser and R2) — the tier's
implicit cloud storage is unchanged; it is the ANSWERING path that stays
local. The weights are public model files fetched from huggingface.co
into OPFS — the server is not in that path either.

**A PARTIAL browser-local route: the Orchestrator's swarm node**
(2026-07-25, `docs/SWARM-REASONING.md`). Not a third exception and not a
private route — a hybrid worth stating plainly. When a `swarm` sub-agent
runs, its whole reasoning loop happens on the device (many tiny Bonsai
models drafting, reviewing each other and converging), so the drafts, the
critiques and the discarded candidates never exist anywhere but this
browser. What DOES reach the server is the node's finished brief,
attached to the ordinary `/api/chat` request and merged into the answer
like any other sub-agent's — normal Se/rver traffic, logged in
`chat_logs` with the rest of the turn (unless the request is incognito).
The plan call that precedes it (`POST /api/orchestrator/plan`) carries
the conversation exactly as `/api/chat` would, plus the model id this
device can host. Se/cure is not wired for this at all: it has no chat
modes.
**TWO deliberate, bounded exceptions to "the server is in NO DRC data
path".** Count precisely: two is the number of *exposure classes* — `web`
(query-only) and `api` (content-bearing) — while the credential FAMILIES
able to reach them are currently three: the legacy `wsk1` web-search
grants, the legacy `prg1`/`prx1` proxy bundle, and the consolidated
Se/rver TOKEN (2026-07-16) that subsumes both going forward. A newer key
shape for the same two classes — never a third kind of data crossing.
The FIRST exception (2026-07-14 directive) is the **temporary web-search
GRANT subsystem**
(`src/websearch.js` + `src/websearch-key.js`; client glue in
`public/cure/drc.js` + `public/js/drc-research.js`; admin panel in
`public/js/admin.js`; defaults in `src/config.js`'s `websearch` block).
A short-lived, quota-metered token (HMAC-signed with `SESSION_SECRET` under
an independent `websearch.` namespace; the quota is a D1
`websearch_grants` row keyed by the token's `jti`) authorizes a fixed
number of live web searches run on the server's side — so a
Se/cure session keeps the strong posture (own/local model, browser-local
storage) while still getting fresh web results. It stays inside the
minimal-outbound rule: only the search QUERY reaches the server, never the
conversation. Since 2026-07-25 the grant call carries a `source` naming WHICH
engine the server should point at — Exa, or the server's own Worker-native
backend (`src/websearch-cf.js`), set by the "Exa web search" knob in settings.
That is a routing choice INSIDE the existing exception, not a new one: the
same single query crosses, the far side simply may be Cloudflare's edge
rather than Exa's index. The stronger option remains unchanged and still
outranks it — a browser-direct search backend configured in the Se/cure
settings drawer means no query touches this server at all. **TWO ways to receive a grant:** (1) the GHOST
CROSSOVER — a signed-in Se/rver user crossing to Se/cure mints/reuses their
own grant (authed `POST /api/websearch/grant`, offered only when the ghost
set the intent marker, so a plain visitor never pings the server); (2) a
SHAREABLE LINK — an admin mints a grant in the **control panel** (`/admin` →
Web search grants) and gets a `…/cure?ws=<token>` link anyone can follow
(`POST /api/admin/websearch`); the follower's browser reads it via public
`POST /api/websearch/status` (non-consuming) and spends it via public
`POST /api/websearch`. The control panel sets the DEFAULT quota/TTL, the
master `enabled` switch, and a **global budget** ceiling on the total
outstanding remaining across all live grants (the "entire set of quota"
governance). It is OPT-IN (a toggle in Se/cure settings) and FAIL-SAFE
(no D1 → no grants can be minted or metered, so there is no unmetered
server-paid search); the public search is metered ONLY by the token+D1 row
(an atomic `UPDATE … WHERE used < quota`), and revoking a grant (deleting
its row) kills its link immediately.
The SECOND (2026-07-14 directive): the **SECURE-RESEARCH-SPACE proxy BUNDLE**
(`src/proxy.js` + `src/proxy-grant.js` + the shared bundle crypto
`public/js/proxy-bundle.js`; client glue in `public/cure/drc.js` +
`public/js/drc-providers.js`'s `proxyLlmProvider`; admin panel in
`public/js/admin.js`; defaults in `src/config.js`'s `proxy` block; D1
`proxy_grants`). It GENERALIZES the web-search grant into a whole "secure
research space" a signed-in Se/rver user (ghost crossover) or an admin
(shareable link) LENDS a Se/cure session: a bundle of temporary,
account-connected proxy grants, **one per SERVICE** — `web` (proxied Exa,
query-only, exactly like the first exception) and `api` (proxied LLM
completions **and embeddings** on the server's Berget key —
`/api/proxy/llm/chat/completions` and `/api/proxy/llm/embeddings`, both
metered on the one `api` grant; the embeddings route (2026-07-17) lets a
borrowed Se/cure session run the same client-side RAG the signed-in tier
does, on Berget's e5 model, an embedding being the same exposure class of
upstream call as the completion the grant already lends). **The `api` grant
DOES route the conversation through the server** (an LLM call carries the
prompt; an embedding carries the document text) — this is the one place a
Se/cure session's *content* touches the server — so it is OPT-IN,
quota-metered, time-limited, Berget-ONLY (bounded account exposure),
and **clearly DISCLOSED in the Se/cure UI** ("which APIs are connected"): a
connected-APIs banner + a Settings row + a master toggle that turns the whole
borrowed space off. **TWO-TIER tokens** (the owner's directive): the bundle
carries GRANT TOKENS (`prg1.…`, namespace `proxygrant.`, the "token-granting
tokens") that travel in the URL; the client EXCHANGES each
(`POST /api/proxy/exchange`) for a PROXY TOKEN (`prx1.…`, namespace
`proxytoken.`) that never appears in a URL and authorizes the metered service
(`POST /api/proxy/web`; the OpenAI-wire reverse proxy `/api/proxy/llm/*` which
the DRC provider registry drives unchanged). **Bundle TRANSPORT:** the bundle
is AES-256-GCM sealed; the ciphertext rides the URL query (`?rp=`,
server-visible but opaque) and the decryption key rides the URL ANCHOR
(`#rk=`, never sent to any server, stripped from referrers). Mint paths:
authed `POST /api/proxy/grant` (ghost, reuse-per-user) and
`POST /api/admin/proxy` (link). Same FAIL-SAFE posture (no D1 → 503, no
unmetered spend), the same atomic reserve/refund meter, and per-service
quota/TTL + a shared global `budget` ceiling governed in the control panel.
**SECURE WORKSPACES (2026-07-15) add NO third exception:** a workspace
link (`/cure/workspace#w=<ciphertext>` — `public/js/workspace-core.js`,
`docs/WORKSPACE-SECURITY.md`) travels entirely in the URL FRAGMENT, which
never reaches any server; the only server-touching things it can carry are
the two grant families above, reused under their existing meters — plus
the per-token quota-ADJUST control surfaces (authed
`/api/websearch/adjust`, `/api/proxy/adjust`; admin PATCH), which move a
grant row's allowance without changing any token in circulation.
**THE CONSOLIDATED Se/rver TOKEN (2026-07-16) also adds NO new exception —
it unifies the two above going forward:** "one ticket, one JWT"
(`src/server-token.js` + `src/server-grants.js`, D1 `server_tokens`,
`docs/SERVER-TOKENS.md`) — one standard HS256 JWT per grant carrying a
permission SET (`perms: ["web","api"]`) over the SAME two bounded upstream
services, one duration, per-permission quota rows (token fixed, rows
metered, same governance/budget/fail-safe posture). It carries THE
SERVER-TOKEN GUARANTEE (owner directive, stated so it is never diluted):
**an API call bearing a Se/rver token reaches UPSTREAM APIs ONLY — it is
NEVER handed project contents, chat contents, or any other Se/rver data**
(closed permission vocabulary + a module-graph unit-test pin + the JWT can
never pass the identity gate). **And a Se/rver token is NEVER a login:
the admin interface (/admin, /api/admin/*) is reachable only through a
proper sign-in** — `identify()` rejects the JWT in every position
(cookie/Bearer/Basic), test-pinned, so tokens are administered FROM the
admin interface and can never open it. The name is the reminder: it's
called a SERVER token so nobody forgets it goes to a server somewhere. The legacy
`wsk1`/`prg1`/`prx1` families keep working unchanged; new grants should be
Se/rver tokens.

**WHAT THE TOKEN GUARANTEE IS FOR (owner directive, 2026-07-24).** Read the
guarantee as a rule about **Se/cure**, not about the platform. Se/cure has no
account and no server-side state, so a credential it borrows must be
pass-through only — that is the whole reason the guarantee is worded as hard
as it is. On **Se/rver** the server is INSIDE the trust boundary: agents
collaborating and orchestrating through server-side storage is the intended
direction of the platform, and such work does not need to argue itself past
this rule, because the rule was never about it. Two things stay fixed
regardless: a Se/rver token still READS nothing Se/rver stores, and it is
still never a login. Building the collaboration surfaces means building
Se/rver-side capabilities behind the identity gate — not widening the
token's closed permission vocabulary, whose closure is what keeps it safe to
lend outward (`docs/SERVER-TOKENS.md`).

**THE ONE WRITE EXCEPTION — Se/cure feedback (owner directive, 2026-07-24):**
there is exactly ONE place a Se/rver token touches Se/rver-stored data, and it
is **WRITE-ONLY**. `POST /api/server-token/feedback` lets a token CREATE one
feedback row — the confirmed **feedback** path from Se/cure, which has no
identity of its own — so users can reach the developers from the client-side
tier too. It can NEVER READ anything back: the readable feedback surface
(`/api/feedback` GET) sits behind the identity gate a token can never satisfy,
so the guarantee's substance holds — **a token still cannot read any project,
chat, history, or account data.** No new permission names a data surface (the
closed vocabulary is unchanged); **any live token may submit**, and the row is
attributed to the token's minting account (`sub`) so the developers' replies
reach that user in their Se/rver account panel. The write is DELIBERATELY not in
`src/server-grants.js` (whose module graph stays upstream-only, test-pinned) —
it lives in the feedback data module (`src/feedback.js` `handleServerTokenFeedback`),
verified with the pure `verifyServerToken` leaf. On the client, Se/cure catches
the "feedback" keyword (the shared `public/js/feedback-core.js` gate) and PROMPTS
for confirmation before anything is sent — nothing leaves the browser silently,
matching the same opt-in, per-use posture as the web-search grant and the
research-space proxy.

## Where shell commands run — the third execution environment (2026-07-26)

The execution sandbox has three environments (`docs/EXECUTION-ENVIRONMENTS.md`)
and only two of them are silent about this model. The in-browser CheerpX VM and a
DREE/1 runner on the user's own machine are **browser-direct**: no command, no
output and no mounted file passes through this server, in either tier, which is
why the local runner needed no exception when it shipped — it is a different
endpoint for the same browser-side call.

The third, an ephemeral Cloudflare Container this platform starts per
conversation (`src/exec-container.js`), **does** put the server in the path: it
runs the commands. That is stated, not smoothed over, and it is bounded by
tier rather than by policy:

- **Se/rver: admissible, and not an exception.** The server is inside the trust
  boundary on this tier (owner directive, 2026-07-24), and the conversation, its
  attachments and its project are already stored there (cloud storage is implicit).
  A container that runs `grep` over those same files does not widen the boundary
  already drawn — so this is not a new crossing to count, it is work done inside
  an existing one. The commands, their output and the pushed mount archive are
  server-visible while the container lives; the container's disk is ephemeral and
  destroyed with it (idle reaper, session lifetime, or `DELETE` on New chat).
- **Se/cure: refused, in code, twice.** `selectRunner`
  (`public/js/exec-backends-core.js`) requires an explicit `tier:"server"`, so a
  Se/cure caller — or any caller that forgets to say — lands on the browser VM;
  and `/api/exec/*` sits behind the identity gate, which Se/cure never passes.
  **The count of Se/cure's deliberate server-touching exceptions is therefore
  UNCHANGED at two** (the web-search grant and the research-space proxy bundle).
  A hand-edited sealed state naming the backend gets the browser VM, not a third
  channel. Pinned by `public/js/exec-backends-core.test.js`.

The container starts with `enableInternet:false` — no internet, no LAN, matching
the browser VM — and on EU-jurisdiction infrastructure. What each environment
hands to whom is tabulated in `docs/EXECUTION-ENVIRONMENTS.md` §5; the option is
absent entirely on a deploy without the (optional, off-by-default) container
binding.

## Compute sharing — peer-operated upstream (2026-07-23, PROPOSED framing, owner sign-off pending)

`docs/COMPUTE-SHARING.md` designs a capability where a signed-in user LENDS
their local LLM as pooled capacity: the server is a thin BROKER that relays a
consumer's completion request to the sharer's browser, which runs it against
their local model. This adds the `pt1` **pool-token** family
(`src/pool-token.js`) and the D1 job-queue broker (`src/pool.js`).

It touches this model in one place that is genuinely NEW and is therefore
flagged, NOT silently adopted: **consuming a pool routes the consumer's prompt
through the server to ANOTHER NAMED USER'S machine** — a peer-operated upstream,
not the server's own Exa/Berget keys. The recommended framing (this section is
descriptive; the CLAUDE.md invariant 4 text is unchanged pending the owner's
decision) is to treat pool consumption as a **documented variant of the existing
`api` exception** — "an upstream LLM, operated by a peer instead of Berget" —
reusing the connected-APIs disclosure PLUS a stronger, unmissable line at the
point of use: *the pool owner's machine can read everything you send.* Under that
framing the "EXACTLY TWO exceptions" count is unchanged in spirit (peer compute
is a variant of the second, a server-relayed upstream completion). The
alternative — a literal THIRD exception, amending the invariant to say three —
is cleaner to audit but rewrites a load-bearing owner-directive sentence.

What is already firm and enforced by code: a pool token carries THE POOL-TOKEN
GUARANTEE (upstream/peer completion access ONLY, never Se/rver data, never a
login — same structural + module-graph enforcement as the Se/rver token, pinned
by `src/pool.test.js`); the server forwards to the peer ONLY the completion body
the consumer chose to send (no identity, filename, or account data);
**SHARING** (being a provider) is a Se/rver-tier, signed-in action that exposes
none of the provider's own data and adds no Se/cure exception. See
`docs/COMPUTE-SHARING.md` §7 for the full analysis.

**MUTUAL CONSENT (2026-07-25, owner directive — shipped).** Whichever framing
the exception count ends up with, the crossing is no longer authorized by a
token alone. A relayed completion is refused — before its body is parsed,
parked or metered — unless BOTH parties have said yes to each OTHER's
platform-verified identity: the sharer to this consumer reaching their machine
(**ingress**), and the consumer to their prompts leaving for that machine
(**egress**). Neither implies the other; both are remembered per identity pair
and reversible at any time; and each side is shown who the other is as the
SERVER resolved them from a session, never as the peer described themselves —
where the platform cannot verify (an anonymous workspace consumer) the surface
says "unverified" rather than dressing a token up as a person. The unmissable
line at the point of use is therefore a question the person has to answer, not
a notice they can scroll past.
`docs/COMPUTE-SHARING.md` §8b; enforced in `src/pool.js`, worded once in
`public/js/pool-core.js`, verified live by `tests/e2e/llm-sharing.live.spec.js`.
