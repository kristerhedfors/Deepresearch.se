# Reaching the Claude mobile app — the MCP server as a web connector

**Status:** design and feasibility, not built. Written 2026-08-03 against
Anthropic's connector documentation as it stood that day (see §7 for exactly
what was read, and what has to be re-read before anyone builds this).

Companion to the **mcp-server** skill, which documents the server that exists.
This document answers a different question: the one thing our MCP surface
cannot do today is turn up on a phone.

---

## 1. The problem, and the short answer

Today an account connects the server by minting a key in Settings → MCP server
and pasting one line into a terminal:

```
claude mcp add --transport http deepresearch https://mcp.deepresearch.se --header "Authorization: Bearer …"
```

That line is Claude Code's. A phone has no terminal to paste it into, and the
Claude mobile app does not read Claude Code's configuration. So the surface is
reachable from a laptop and invisible from a phone — which is backwards for a
research assistant, the thing people most want to ask a question of while away
from a desk.

**The answer is a custom connector, and it is feasible.** Two facts make it
smaller than it sounds:

1. **There is no such thing as a "mobile MCP integration."** Anthropic's hosted
   surfaces — claude.ai on the web, Claude Desktop, Claude mobile, Cowork —
   share one connector infrastructure. A custom connector added once, by URL,
   from any of them shows up on all of them. Reaching the phone means
   *becoming addable as a connector*; the phone then follows.
2. **Transport is already right.** A custom connector is a remote MCP server
   over Streamable HTTP, reachable from the public internet. That is exactly
   what `src/mcp.js` serves at `https://mcp.deepresearch.se`.

What is missing is **authentication**. A connector cannot be handed an
`mck1.` key the way `claude mcp add --header` hands it one, because the
Add-connector dialog takes a URL and runs OAuth. So the work is an OAuth
authorization server, not an MCP change.

---

## 2. What Claude requires of a connector

Verified 2026-08-03 against `claude.com/docs/connectors/building/authentication`
and `claude.com/docs/connectors/custom/remote-mcp`.

### The authentication types Claude supports

| Type | What it is | Availability |
|---|---|---|
| `oauth_dcr` | OAuth 2.0 + Dynamic Client Registration (RFC 7591) | out of the box |
| `oauth_cimd` | OAuth 2.0 + Client ID Metadata Document | out of the box |
| `oauth_anthropic_creds` | Anthropic holds our client credentials | by arrangement (`mcp-review@anthropic.com`) |
| `static_headers` | a fixed API key / bearer token an admin types into the dialog | **beta**, rollout-gated |
| `none` | authless server | supported |

Two of these are dead ends for us. `none` is not an option — every call spends
an account's research quota and runs under an account's exposure config, so
the server has to know *whose* call it is. `static_headers` is the one that
would need no server work at all (paste `Bearer mck1.…` and be done), and it
is discussed in §6; it is beta, gated, and shaped for an org-shared
credential, so it is a stopgap and not the plan.

A machine-to-machine `client_credentials` grant is **explicitly not
supported**. Every connection goes through user consent. That is fine here —
consent is the honest shape for this — but it rules out the simplest possible
token endpoint.

### The handshake, concretely

1. **A `401` with a pointer.** An unauthenticated request must answer
   `401` with

   ```
   WWW-Authenticate: Bearer resource_metadata="https://mcp.deepresearch.se/.well-known/oauth-protected-resource"
   ```

   The `401` status is required — a `WWW-Authenticate` header on a `200` is
   ignored. Without the pointer Claude falls back to probing
   `/.well-known/oauth-protected-resource/<path>` and then
   `/.well-known/oauth-protected-resource` on the MCP origin, which costs
   round-trips and only works if the origin serves `/.well-known/*` at all.
   (The docs name "Cloudflare Workers without a `/.well-known/*` route" as a
   platform where the probe fails. We are a Worker that routes every path on
   that host, so both the header and the document are ours to serve.)

2. **Protected-resource metadata** (RFC 9728) whose `resource` field matches
   the URL **exactly as the user typed it into the dialog**, and whose
   `authorization_servers` lists our issuer. If more than one is listed,
   Claude uses the first and never falls back to the rest.

3. **Authorization-server metadata** — RFC 8414 or OpenID Connect Discovery —
   served at the issuer's `/.well-known/` path, from a host reachable from
   Anthropic's egress range `160.79.104.0/21`.

4. **PKCE, always.** Claude sends `code_challenge` with
   `code_challenge_method=S256` on every authorization request whatever the
   registration mechanism, and the metadata must advertise
   `"code_challenge_methods_supported": ["S256"]`.

5. **The redirect URI**, for every hosted surface including mobile:

   ```
   https://claude.ai/api/mcp/auth_callback
   ```

   Claude Code is separate: an RFC 8252 loopback redirect on an ephemeral
   port, declaring `http://localhost/callback` and `http://127.0.0.1/callback`,
   which an authorization server must match **ignoring the port**.

6. **The token endpoint** must accept
   `Content-Type: application/x-www-form-urlencoded` — for both the initial
   exchange and refreshes. A DCR `/register` endpoint, if we serve one, takes
   `application/json` instead; the two do not share a body parser.

7. **Refresh behaviour.** Claude refreshes reactively on a `401`, and
   proactively up to five minutes before the stored expiry. A dead refresh
   token must come back as RFC 6749 `invalid_grant`, not a custom code. DCR
   and CIMD both register Claude as a *public* client, so refresh tokens must
   rotate (return the new one in the same response that invalidates the old).

8. **Scopes.** Whatever the `401`'s `WWW-Authenticate` names in a `scope`
   parameter; failing that, whatever protected-resource metadata advertises in
   `scopes_supported`. Claude appends `offline_access` if the authorization
   server lists it, to get a refresh token.

9. **Latency budget.** 10 s for discovery, registration and token; 30 s for
   refresh. Past that the flow fails even if the request eventually completes.
   Worth stating because our token endpoint would touch D1, and a cold D1 call
   inside a 10 s ceiling is comfortable but not unlimited.

---

## 3. Separate URL? Separate subdomain? — the recommendation

**The connector URL should be `https://mcp.deepresearch.se`, unchanged, with
no new path and no new subdomain.** That is the same bare-origin form now
advertised everywhere else (2026-08-03: `src/mcp-api.js` `mcpEndpointUrl`
dropped the `/mcp` tail), and it is the right one for three reasons that all
point the same way:

- **`resource` must match what the user typed, character for character.** Any
  ambiguity about the canonical form becomes a connection that fails with no
  useful error. One advertised URL, the shortest one, is what makes that
  matchable — and the bare origin is the form a person types from memory.
- **The host already exists and already serves only this.** Nothing about
  OAuth needs a different name; the metadata document and the `401` pointer
  are two more branches on a host we control end to end.
- **Every extra custom domain is a line in `wrangler.toml` that has to stay
  there.** The `mcp.` route was lost exactly once, to an unrelated deploy from
  a config that omitted it, and the host went unreachable until it was
  re-created. That is an argument against a second one that buys nothing.

**Where a split *is* right: the authorization server.** It should not be on
the MCP host. It belongs on `https://deepresearch.se` — the apex — because
that is where the account, Google sign-in and the session cookie already live,
and a consent screen is an ordinary browser page that a signed-in user must be
able to recognise as *this site*. A consent screen on a machine-facing
subdomain is worse on both counts. Claude handles a cross-host authorization
server with nothing special required: the `authorization_servers` field says
where it is, and Claude follows it.

So the shape is:

| Role | Host | New surface |
|---|---|---|
| Resource server (the MCP endpoint) | `mcp.deepresearch.se` | `/.well-known/oauth-protected-resource`; a `WWW-Authenticate` header on the existing `401` |
| Authorization server (issuer) | `deepresearch.se` | `/.well-known/oauth-authorization-server`, `/oauth/authorize`, `/oauth/token` (and `/oauth/register` only if we choose DCR) |

`/oauth/*` on the apex collides with nothing: the top-level wordplay map is a
fixed set, and the publication-slug namespace is under `/cure/`.

---

## 4. What building it would actually involve

Sketch, not a plan of record. The point is that it is additive: nothing about
the existing pipeline, tool list, exposure config or key family changes.

**New modules.** `src/oauth-metadata.js` (pure leaf — both metadata documents,
unit-testable with no bindings), `src/oauth-authorize.js` (the consent screen
and code issuance, behind `identify()` so an unauthenticated arrival gets the
normal sign-in), `src/oauth-token.js` (the form-urlencoded token and refresh
endpoint). The MCP server itself gains one thing only: a `WWW-Authenticate`
header on the `401` it already returns.

**Registration: prefer CIMD, skip client storage entirely.** Claude picks CIMD
when authorization-server metadata advertises **both**
`"client_id_metadata_document_supported": true` **and** `"none"` in
`token_endpoint_auth_methods_supported`; miss either and it falls back to DCR.
CIMD means the `client_id` is an HTTPS URL we fetch and validate — no client
table, no `/register`, nothing accumulating per connection. DCR's failure mode
in the docs is the opposite: a new registered client on every fresh
connection. Advertise CIMD; add `/register` only if something we care about
turns out to need it.

**Tokens: reuse the machinery, not the family.** The repo already signs four
token families HS256 over `SESSION_SECRET` with per-family namespaces
(`src/token-crypto.js`). An OAuth access token is a fifth: short-lived, its own
namespace, resolved beside `mck1.` in `resolveMcpKeyIdentity` so the endpoint
keeps exactly one identity seam. The authorization code can be a 60-second
signed token binding `{uid, client_id, redirect_uri, code_challenge, scope}` —
but single-use is a real requirement and a signature cannot enforce it, so
that needs one D1 row (or KV) per outstanding code. Refresh tokens rotate, so
they need a stored `jti` per connection, the same "token fixed, the record
governs" split `mck1.` and the grant families use.

**Nothing else moves.** The OAuth token resolves to the same identity the key
does, which means `tools/list` filtering, `tools/call` enforcement, the
four-window quota, split billing and the `chat_logs` row all apply unchanged.
That property is the whole argument for doing it this way: OAuth adds a door,
not a second surface with its own rules to keep in sync.

**The not-a-login pin extends to the new family.** `identify()` reads a
`Basic` header and the `dr_session` cookie; an OAuth access token is neither,
so `/admin` and every data-bearing route stay unreachable by construction —
the same structural argument `src/mcp-key.js` makes, and it needs the same
test, including the cross-family forgery matrix in both directions.

**Consent copy is part of the build, not decoration.** The screen has to say
what connecting actually grants: the tools left switched on in Settings → MCP
server, spending against this account's research quota, and every question
landing in the full-visibility interaction log. The MCP spec also requires the
redirect URI's hostname to be displayed on the consent screen — so a user can
see that they are authorizing `claude.ai` and not something that merely says
so.

---

## 5. What it does and does not change about privacy

Nothing in invariant 4 moves. An MCP call was already a **Se/rver** call:
the question reaches this server, goes upstream to the model and the search
provider, and is recorded in the interaction log on channel `mcp`. A connector
is the same call with a different door, and `public/connect/` already says
this plainly — that page's "What crosses the wire" section covers a connector
verbatim.

Two things are genuinely new and belong in `docs/PRIVACY-MODEL.md` when this
ships:

- **A consent screen that names the exposure**, which is a privacy *gain* over
  a pasted bearer token: today nothing tells an account what a key can reach at
  the moment it is minted.
- **A per-connection credential that is revocable per connection.** One
  `mck1.` key per account means revoking the laptop revokes the phone. OAuth
  refresh tokens are per connection, so they can be listed and killed
  individually.

---

## 6. The stopgap that exists today

`static_headers` — the Request headers section of the Add-connector dialog —
would work with the server exactly as it stands: choose `authorization`, enter
`Bearer mck1.…` (the scheme included; Claude sends the value verbatim), done.
Anyone who already has the beta can connect the mobile app today with no
change on our side, and that is worth saying on `public/connect/`.

It is not the plan for two reasons. It is **beta and rollout-gated**, so it
cannot be documented as the way to connect. And it is shaped for a credential
*an organization shares* — the docs are explicit that per-user sign-in means
OAuth — which is the opposite of what an `mck1.` key is: one per account,
tied to that account's quota and exposure config.

---

## 7. Before anyone builds this

**Re-read the sources.** Everything above is dated 2026-08-03 and the
connector documentation moves: the building guide had already relocated from
the support site to the developer docs by the time this was written, and
`static_headers` is mid-rollout. Read
`claude.com/docs/connectors/building/authentication` and
`claude.com/docs/connectors/custom/remote-mcp` first, and check whether
`static_headers` has left beta — if it has, §6 stops being a stopgap and this
document's §4 becomes optional work rather than the only path.

**The validation ladder** (extending the **mcp-server** skill's):

1. **Unit** — both metadata documents; PKCE S256 verification including
   rejection of a wrong verifier; authorization-code single use; refresh
   rotation and `invalid_grant`; the redirect-URI allowlist including the
   port-agnostic loopback match; the not-a-login pin for the new family.
2. **Handshake by hand** — `curl` the unauthenticated `POST`, confirm `401` +
   `WWW-Authenticate`, follow the pointer, follow `authorization_servers[0]`,
   confirm the discovery document. This is the sequence Claude runs, and a
   failure anywhere in it surfaces as the same unhelpful "Couldn't reach the
   MCP server."
3. **Live, on the real client** — add the connector on claude.ai in a browser,
   complete consent, call a tool. **Then open the mobile app and confirm the
   connector is there and lists tools without any further setup.** That last
   step is the acceptance criterion for this whole document, and it is the one
   that cannot be inferred from a green unit suite.

**Open questions for the owner:**

- Do we want a connector at all as a *public* thing, or only for approved
  accounts? The site gates sign-up today; a connector anyone can add still
  lands on the same approval gate, but the Add-connector dialog is a much
  wider front door than a minted key.
- Should the mobile path expose the full tool list, or a narrower default? The
  literature tools are cheap and read-only; `deep_research` is the one that
  spends. The per-account exposure config already expresses this — the
  question is only what a fresh connection defaults to.
- Directory submission (`mcp-review@anthropic.com`) is a separate decision with
  its own review requirements, and is out of scope here.
