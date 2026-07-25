# Se/rver tokens — one ticket, one JWT

*(2026-07-16, owner directive. Modules: `src/server-token.js` (the JWT half),
`src/server-grants.js` (mint/meter/endpoints), D1 table `server_tokens`,
config block `server_token`.)*

The consolidated grant credential. Where the earlier ticket families each
carried one narrow capability — the `wsk1` web-search grant
(`src/websearch-key.js` + `src/websearch.js`) and the `prg1`/`prx1`
per-service proxy pair (`src/proxy-grant.js` + `src/proxy.js`) — a
**Se/rver token** bundles the whole grant into a single signed JWT:

- **one permission set** (`perms`) naming which of the site's **upstream
  APIs** the token may call,
- **one duration** (`exp`) covering the whole grant,
- **one `jti`** keying the D1 rows that meter each permission's quota,
- **one minting account** (`sub`) for accountability.

The name is deliberate: it is called a **Se/rver token** so nobody ever
forgets that *using it sends data to a server somewhere*. It is the
credential for the server-touching path — never part of the pure
client-side Se/cure posture.

---

## THE SERVER-TOKEN GUARANTEE

> **A Se/rver token READS nothing Se/rver stores. It hands out no project
> contents, no chat contents, no conversation history, no account data. What
> it opens are doors leading OUT of the site — the upstream APIs its `perms`
> name — and it can never read its way back in.**

**Who this protects, and who it does not** (owner directive, 2026-07-24).
The guarantee exists for **Se/cure**, whose whole posture is pass-through
only: a Se/cure session has no account and no server-side state, so a token
it borrows must be incapable of reaching into Se/rver's stores. It is *not*
a general rule about the Se/rver tier. On Se/rver the server sits **inside
the trust boundary**, and agents collaborating and orchestrating through
server-side storage is the intended direction of the platform — that work is
not an exception to this guarantee, it is simply outside its scope. Read the
rule as *what a borrowed Se/cure credential may do*, never as *what the
platform may build*.

**The one write** (owner directive, 2026-07-24): `POST
/api/server-token/feedback` lets any live token CREATE a single feedback
row, so users of the client-side tier can reach the developers at all. It is
write-only — the readable feedback surface (`GET /api/feedback`) sits behind
the identity gate no token can satisfy — so the substance above holds: still
no reading. The route deliberately lives in `src/feedback.js`
(`handleServerTokenFeedback`) rather than `src/server-grants.js`, verified
against the pure `verifyServerToken` leaf, so the module-graph pin below
stays true. See `docs/PRIVACY-MODEL.md`.

And the corollary, stated just as hard:

> **A Se/rver token is never a login. The admin interface — `/admin` and
> every `/api/admin/*` route, including the token subsystem's own control
> surface — is reachable ONLY through a proper sign-in (a session identity
> with the admin role, or the break-glass Basic secrets). Tokens are
> administered FROM the admin interface; they can never open it.**

This is enforced structurally, not as a policy note, four ways:

1. **The permission vocabulary is closed.** `SERVER_TOKEN_SERVICES` in
   `src/server-token.js` names upstream services only (`web` = Exa search on
   the server key, `api` = Berget LLM completions on the server key). No
   value naming a data surface may be added to it — that closure is what
   makes the credential safe to lend to a Se/cure session, so agent
   collaboration over server-side storage must be built as its own
   Se/rver-side capability rather than by widening this vocabulary.
   `verifyServerToken`
   drops unknown permissions, so even a token minted with a hypothetical
   future perm authorizes nothing this deploy doesn't explicitly serve.
2. **The module graph is pinned by a test.** The endpoints live in
   `src/server-grants.js`, which touches nothing but the `server_tokens`
   meter table and the upstream providers. A unit test
   (`src/server-grants.test.js`) reads the module's import list and fails
   the suite if any data-bearing module (`storage.js`, `vault.js`,
   `chatlog.js`, `accounts.js`, `rag.js`, `pub.js`, …) ever appears.
3. **A Se/rver token can never pass the identity gate.** Every data-bearing
   `/api/*` route sits behind the session cookie (`src/auth.js`), which is
   verified by a different scheme entirely. The JWT is only ever examined by
   the `server-token` endpoints; presenting it anywhere else is just an
   unauthenticated request.
4. **The admin boundary is test-pinned.** `src/server-token.test.js` proves
   `identify()` rejects the JWT in every position it could be presented —
   as the session cookie (raw and mangled into the cookie's own
   `u.<uid>.<exp>.<sig>` shape), as a `Bearer` header, and smuggled into
   Basic credentials. `/api/admin/*` additionally requires
   `identity.role === "admin"` in the entrypoint, so even a future identity
   bug would still leave the admin surface role-gated.

The one nuance, stated plainly: an LLM call (`api` permission) necessarily
carries the **caller's own prompt** upstream — that is the caller's data
flowing OUT to a disclosed upstream provider, by their choice, exactly as
the legacy proxy bundle's `api` grant did. Nothing flows the other way, and
the exchange is not written to any store.

## Wire format

A **standard HS256 JWT** (RFC 7519): `header.payload.signature`, all
base64url — the claims are inspectable with any JWT tool (nothing hidden in
a Se/rver token; transparency is part of the mission). Signed with
`SESSION_SECRET`, the site's sole HMAC key.

Claims:

```json
{
  "iss": "deepresearch.se",
  "sub": "<minting user id>",
  "jti": "<grant id — the D1 rows' key>",
  "perms": ["web", "api"],
  "iat": 1752624000,
  "exp": 1752710400
}
```

Deliberately **no quota claims**: quotas live in the D1 rows so a live grant
stays administrable (adjust / pause / top-up / revoke) while the token in
circulation never changes — the *token-fixed, rows-metered* discipline the
secure-workspaces work established.

**Family separation** under the shared `SESSION_SECRET` is structural and
test-pinned (`src/server-token.test.js`'s forgery matrix):

- other families sign `"<ns>" + <one dot-free base64url segment>`; the JWT
  signing input is `<canonical header>.<payload>` — always starts with the
  pinned header segment and contains a dot, which no other family's input can;
- signature *encodings* differ (base64url here, hex everywhere else);
- verification constant-compares the header segment against the ONE
  canonical minted header, so `alg:none`, algorithm swaps, and re-serialized
  headers are rejected before the signature is even checked.

## Metering

One D1 `server_tokens` row **per permission**, primary key `(jti, service)`.
The reserve is the same atomic row guard as the legacy meters
(`UPDATE … SET used = used + 1 WHERE … used < quota AND expires_at > now`),
so a concurrent burst can never overrun a grant; failed/empty operations are
refunded. **Fail-safe:** no D1 → the whole feature answers 503 — no
unmetered server-paid usage is possible.

## Endpoints

| Endpoint | Auth | What |
|---|---|---|
| `POST /api/server-token/grant` | session | Ghost-crossover mint/**reuse** (one live ghost grant per user per TTL window) |
| `POST /api/server-token/adjust` | session | Minter self-service quota control, per permission (`{ jti, svc, quota \| delta }`) |
| `POST /api/server-token/status` | token | Non-consuming live per-permission state |
| `POST /api/server-token/web` | token | One metered Exa search — only the query string crosses the wire |
| `GET /api/server-token/llm/models` | token (`api`) | Berget catalog, non-metered |
| `POST /api/server-token/llm/chat/completions` | token (`api`) | One metered OpenAI-wire completion (JWT as bearer; shares `src/proxy.js`'s forwarders) |
| `GET/POST/PATCH/DELETE /api/admin/server-token*` | admin **login only** (a token is never accepted) | List (grouped by jti) / mint / per-permission adjust (`/:jti/:svc`) / revoke (`/:jti`) |

## Governance

Config block `server_token` (admin-edited via `PUT /api/admin/config`):
master `enabled` switch, per-permission default quotas (`web_quota`,
`api_quota`), one default `ttl_hours` for the whole token, and a global
`budget` ceiling on total outstanding-remaining across all live rows —
the same governance vocabulary as the legacy families.

## Client consumption (Se/cure)

The `/cure` client consumes Se/rver tokens end to end (`public/cure/drc.js`,
pure helpers `serverTokenService`/`serverTokenLive` in
`public/js/drc-page-core.js`):

- **Arrival** — a shared `…/cure?st=<jwt>` link (read via the public status
  endpoint, then stripped from the URL/history), or the **ghost crossover**,
  which now asks `POST /api/server-token/grant` FIRST and leaves the intent
  marker for the legacy web-search grant only if that fails (fallback
  against an older deploy). A plain visitor never pings the server.
- **Web search** — the token's `web` permission is the first choice in
  `drcServerWebSearch` (before the proxy bundle and the legacy grant),
  spending `POST /api/server-token/web`.
- **LLM** — `serverTokenLlmProvider` (`public/js/drc-providers.js`): the
  same Berget-wire provider as the proxy bundle's, pointed at
  `/api/server-token/llm` with the JWT itself as the bearer (no exchange
  tier). It appears first in the model dropdown while live.
- **Disclosure** — the connected-APIs banner on arrival, a dedicated
  Settings row (per-permission remaining + master off switch), and the
  same ℹ privacy-notice treatment as the proxy path (the header notice
  says plainly that the conversation routes through the server on the
  `api` permission — `privacyNoticeLines`, docs/SYMBOL-LANGUAGE.md §6).
- The token is a temporary credential in localStorage (like the legacy
  grants), never part of the sealed project state.

The admin `/admin` → **Se/rver tokens** panel mints shareable `?st=` links,
lists live tokens grouped by `jti`, adjusts each permission's quota in place
(±10 / set / pause), and revokes; defaults live in Configuration.

## Migration

The legacy families (`wsk1` web-search grants, `prg1`/`prx1` proxy bundles)
keep working **unchanged** — every existing link, workspace, and client flow
is intact; only the ghost crossover prefers the consolidated token now.
Remaining follow-up: secure-workspace links (`workspace-core.js`) still
embed the legacy grant tokens only — extending the workspace payload to
carry a Se/rver token is future work. Once everything has moved, the legacy
mint paths can be retired — the *verification* paths stay until the last
legacy token has expired.
