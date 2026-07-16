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

> **A Se/rver token grants access to the site's UPSTREAM APIs ONLY. It
> never hands out any of Se/rver's own data: no project contents, no chat
> contents, no conversation history, no account data. An API call bearing a
> Se/rver token cannot read anything Se/rver stores — in either direction,
> the token only opens doors that lead OUT of the site, never doors that
> lead into its storage.**

This is not a policy note; it is enforced structurally, three ways:

1. **The permission vocabulary is closed.** `SERVER_TOKEN_SERVICES` in
   `src/server-token.js` names upstream services only (`web` = Exa search on
   the server key, `api` = Berget LLM completions on the server key). No
   value naming a data surface may ever be added to it. `verifyServerToken`
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
| `GET/POST/PATCH/DELETE /api/admin/server-token*` | admin | List (grouped by jti) / mint / per-permission adjust (`/:jti/:svc`) / revoke (`/:jti`) |

## Governance

Config block `server_token` (admin-edited via `PUT /api/admin/config`):
master `enabled` switch, per-permission default quotas (`web_quota`,
`api_quota`), one default `ttl_hours` for the whole token, and a global
`budget` ceiling on total outstanding-remaining across all live rows —
the same governance vocabulary as the legacy families.

## Migration

The legacy families (`wsk1` web-search grants, `prg1`/`prx1` proxy bundles)
keep working **unchanged** — every existing link, workspace, and client flow
is intact. New grants should be Se/rver tokens; client-side consumption in
`/cure` (a `?st=` link reader + settings wiring, mirroring `?ws=`/`?rp=`)
and an admin-panel section are the natural follow-ups. Once clients have
moved, the legacy mint paths can be retired — the *verification* paths stay
until the last legacy token has expired.
