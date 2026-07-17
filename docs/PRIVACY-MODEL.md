# The privacy split — the full model (CLAUDE.md invariant 4)

The complete statement of the privacy model behind CLAUDE.md's invariant 4,
split out of CLAUDE.md (2026-07-17) so the always-loaded guide carries the crisp
rules and this file carries the full subsystem map, endpoints, token families
and dated owner directives. Companions: `docs/ENCRYPTION.md`,
`docs/SERVER-TOKENS.md`, `docs/WORKSPACE-SECURITY.md`, and the
**storage-privacy** / **secure-workspaces** / **quota-grant-assessment**
skills.

**The rule.** Cloud storage is IMPLICIT on the Se/rver tier
(2026-07-16 owner directive — the TIER is the choice, not a switch):
every conversation and project is always stored in the cloud, with NO
per-account or per-project opt-out (the former `server_history` knob and
project knob are gone); the never-cloud tier is Se/cure, where the
server is in no data path at all. Conversations and attached-file
originals rest as
ciphertext in BOTH the browser and R2 — the ONLY
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
at all — the browser calls the user's own CORS-capable providers
(OpenAI, Groq, Berget — or, since 2026-07-15, the user's OWN local
OpenAI-compatible server: Ollama / LM Studio / llama.cpp, the keyless
`local` provider entry, with which NO third party receives the
conversation at all) directly, runs the research pipeline client-side, and
stores the sealed project state (chats AND the user's API keys inside)
in the BROWSER's own storage; the server serves static files and public
replay JSONs, so it could not log content or keys even in principle.
Secrets never appear in any log.
Outbound requests to third parties carry the minimum (a query, a
coordinate, a host) — never the conversation, filename, or account
identity.
**TWO deliberate, bounded exceptions to "the server is in NO DRC data
path".** The FIRST (2026-07-14 directive) is the **temporary web-search
GRANT subsystem**
(`src/websearch.js` + `src/websearch-key.js`; client glue in
`public/cure/drc.js` + `public/js/drc-research.js`; admin panel in
`public/js/admin.js`; defaults in `src/config.js`'s `websearch` block).
A short-lived, quota-metered token (HMAC-signed with `SESSION_SECRET` under
an independent `websearch.` namespace; the quota is a D1
`websearch_grants` row keyed by the token's `jti`) authorizes a fixed
number of live web searches routed through the server's Exa key — so a
Se/cure session keeps the strong posture (own/local model, browser-local
storage) while still getting fresh web results. It stays inside the
minimal-outbound rule: only the search QUERY reaches the server and Exa —
never the conversation. **TWO ways to receive a grant:** (1) the GHOST
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
