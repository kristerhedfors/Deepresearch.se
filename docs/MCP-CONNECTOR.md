# Reaching the hosted chat clients — the MCP server as a web connector

**Status:** design and feasibility, not built. Written 2026-08-03 against
Anthropic's and OpenAI's connector documentation as it stood that day (see §7
for exactly what was read, and what has to be re-read before anyone builds
this).

Companion to the **mcp-server** skill, which documents the server that exists.
This one covers what it cannot do today: turn up in a hosted chat client —
Claude or ChatGPT — instead of only in a terminal.

Both clients were asked about on 2026-08-03 (owner: "I'd love to connect with
OpenAI as well"). They turn out to want **the same authorization server** and
differ in two bounded ways — the redirect URI, and a pair of tool names
ChatGPT insists on. §2 is Claude, §2a is ChatGPT, and §2b is what they share.

---

## 1. The problem, and the short answer

Today an account connects the server by minting a key in Settings → MCP server
and pasting one line into a terminal:

```
claude mcp add --transport http deepresearch https://mcp.deepresearch.se --header "Authorization: Bearer …"
```

That line is Claude Code's. A phone has no terminal to paste it into, and no
hosted chat app reads Claude Code's configuration. So the surface is reachable
from a laptop and invisible from a phone, which is the wrong way round for a
research assistant.

**The answer is a custom connector, and it is feasible.** Two facts make it
smaller than it sounds:

1. **There is no such thing as a "mobile MCP integration."** Anthropic's hosted
   surfaces — claude.ai on the web, Claude Desktop, Claude mobile, Cowork —
   share one connector infrastructure. A custom connector added once, by URL,
   from any of them shows up on all of them. Reaching the phone means
   *becoming addable as a connector*; the phone then follows. (ChatGPT's
   equivalent is documented as a web action and its mobile behaviour is not
   stated — see §7, where that is an open question rather than an assumption.)
2. **Transport is already right for Claude**, and probably for ChatGPT. A
   custom connector is a remote MCP server reachable from the public internet;
   Claude takes Streamable HTTP, which is exactly what `src/mcp.js` serves at
   `https://mcp.deepresearch.se`. OpenAI's docs disagree with each other about
   whether SSE is required — §2a.

What is missing is **authentication**. A connector cannot be handed an
`mck1.` key the way `claude mcp add --header` hands it one, because both
Add-connector dialogs take a URL and run OAuth. So the work is an OAuth
authorization server, not an MCP change — **and it is one authorization
server for both clients**, which is the finding that makes supporting ChatGPT
as well a small increment rather than a second project.

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

## 2a. What ChatGPT requires, and where it differs

Verified 2026-08-03 against `developers.openai.com/api/docs/mcp`, OpenAI's
developer-mode help article, and the FastMCP integration notes. Treat this
section as less settled than §2: OpenAI's connector surface has moved faster
than Anthropic's, several of the pages contradict each other on transport, and
one requirement below (the redirect URI) is reported by integrators rather than
stated in OpenAI's own reference.

**The auth work is the same work.** ChatGPT wants OAuth
2.1 with the same discovery documents, the same PKCE, and the same
public-client posture: it registers by **Client ID Metadata Document** where
the authorization server advertises it, falls back to **Dynamic Client
Registration** (which OpenAI's own docs now call the legacy option), and
authenticates at the token endpoint as a public client (`none`) or with
`private_key_jwt`. An authorization server built for §2 already satisfies
this. Two things differ:

**1. The redirect URI.** ChatGPT's callback is
`https://chatgpt.com/connector_platform_oauth_redirect`; integrators also
report a `https://chatgpt.com/backend-api/aip/connectors/links/oauth/callback`
form. So the redirect allowlist must be a **set**, not the single Claude value
in §2 — and since an exact-match failure is the commonest reported ChatGPT
connector error, the allowlist has to be data we can extend without a code
change, and the failure has to log the URI that was refused.

**2. ChatGPT demands two tools by name — and this is the real work.** Without
developer mode, ChatGPT **rejects any MCP server that does not expose tools
literally named `search` and `fetch`**, with a fixed contract:

| Tool | Input | Output |
|---|---|---|
| `search` | one query string | `{ results: [{ id, title, url }] }` |
| `fetch` | one document id | `{ id, title, text, url, metadata? }` |

Both must return the payload **twice** — as `structuredContent` and as
JSON-encoded text in the content array.

We are closer to this than it looks. `literature_search` already returns
records with an id, a title and a URL, and `literature_fetch` already resolves
an arXiv id or PMID to a record; the shapes are a rename and a projection
apart, not new retrieval. So the honest scoping is: **two thin adapter tools
over machinery that exists**, not a second search stack. What they should
search over is a real product decision and is left open in §7 — the two hosted
corpora are the natural answer, but `search`/`fetch` could equally front the
research pipeline.

Developer mode lifts the `search`/`fetch` requirement, but it is web-only,
restricted to paid tiers, and explicitly a developer setting. Requiring it
would mean telling every user to turn on a mode OpenAI labels dangerous, so
the adapter tools are the right answer rather than the workaround.

**Transport is the one genuinely unresolved item.** OpenAI's own reference
walks through an SSE endpoint ending in `/sse/`, while the connector setup
docs and the third-party guides say Streamable HTTP and SSE are both accepted.
We serve Streamable HTTP only. This is not a thing to settle from
documentation: point ChatGPT at the deployed server and read the error. If it
does require SSE, that is a transport adapter over the same JSON-RPC handler —
contained, but it is not zero, and it should be measured before anyone
promises a date.

---

## 2b. What the two clients share

Worth stating plainly, because it is the reason this is one project and not
two:

- One authorization server, one issuer, one set of discovery documents.
- CIMD preferred, DCR as the fallback; public client either way.
- PKCE S256 on every authorization request.
- A `401` carrying `WWW-Authenticate: Bearer resource_metadata="…"` as the
  entry point to the whole flow.
- Protected-resource metadata whose `resource` matches the URL the user typed.
- Rotating refresh tokens and RFC 6749 error codes.

What is client-specific is a redirect-URI allowlist entry and, for ChatGPT,
the two adapter tools. Neither touches the pipeline, the exposure config or
the quota path.

---

## 3. Separate URL? Separate subdomain? — the recommendation

**The connector URL should be `https://mcp.deepresearch.se`, unchanged, with
no new path and no new subdomain.** That is the same bare-origin form now
advertised everywhere else (2026-08-03: `src/mcp-api.js` `mcpEndpointUrl`
dropped the `/mcp` tail). Three reasons:

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

**Two clients do not mean two hosts.** The tempting shape — one subdomain per
vendor — buys nothing and costs a route, a certificate, a second exposure
config and a second thing to keep in sync. Claude and ChatGPT both connect to
a URL and both run OAuth against whatever `authorization_servers` names; they
never see each other. What is per-client is a redirect-URI allowlist entry,
which is a value in a list, not an origin.

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

**The redirect allowlist is data.** One list, holding Claude's
`https://claude.ai/api/mcp/auth_callback`, ChatGPT's
`https://chatgpt.com/connector_platform_oauth_redirect` (plus the reported
`backend-api` form), and the port-agnostic loopback pattern for Claude Code.
Adding a client is then an entry, not an edit to the flow. A refused
`redirect_uri` must log the value it refused: an exact-match failure with a
generic error is the single most reported ChatGPT connector problem, and it is
unfixable from the outside without knowing what arrived.

**For ChatGPT, two adapter tools** (§2a): `search` and `fetch`, named exactly
that, returning OpenAI's fixed shapes both as `structuredContent` and as
JSON-encoded content text. They project what `literature_search` and
`literature_fetch` already return, so they belong beside them in
`src/literature-tools.js` (pure) and `src/literature-run.js` (dynamic), under
the same file-layout rule — and, like every tool on this surface, each needs
its `MCP_TOOL_CATALOG` entry in the same change or the mirror test fails. Note
the exposure switch interacts with the requirement: an account that switches
`search` off is an account ChatGPT will refuse to connect to. The Settings
screen has to say so rather than leaving a user to discover it as a failed
connection.

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

**The consent screen's copy is part of the build.** It has to say what
connecting actually grants: the tools left switched on in Settings → MCP
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

**It is also Claude-only, and there is no ChatGPT equivalent.** OpenAI's
supported auth options are OAuth (CIMD, DCR, `private_key_jwt`) or none;
a fixed header typed into the dialog is not among them, and OpenAI's docs
separately warn against putting a token in the connector URL. So for anyone
without the Anthropic beta — and for everyone on ChatGPT — the answer today is
that the server cannot be added at all, and §4 is the only route to changing
that. That is the honest state, not a soft "not yet".

---

## 7. Before anyone builds this

**Re-read the sources.** Everything above is dated 2026-08-03 and both
vendors' connector documentation moves: Anthropic's building guide had already
relocated from the support site to the developer docs by the time this was
written, `static_headers` is mid-rollout, and OpenAI's pages contradict each
other on transport. Read, in this order:

- `claude.com/docs/connectors/building/authentication` and
  `claude.com/docs/connectors/custom/remote-mcp` — and check whether
  `static_headers` has left beta. If it has, §6 stops being a stopgap for
  Claude (it still does nothing for ChatGPT).
- `developers.openai.com/api/docs/mcp` for the `search`/`fetch` contract and
  the registration options, plus OpenAI's developer-mode help article for
  which plans and surfaces can add a connector at all.

§2a's redirect URI came from integrator reports rather than OpenAI's own
reference. Confirm it against a real connection attempt before treating it as
settled — and log what arrives, per §4.

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
3. **Live, on each real client** — add the connector on claude.ai in a
   browser, complete consent, call a tool. **Then open the Claude mobile app
   and confirm the connector is there and lists tools without any further
   setup.** Repeat the whole thing on ChatGPT, where the connection attempt is
   also what settles the two unknowns: whether Streamable HTTP is accepted,
   and whether the connector is usable from the iOS app. These live checks are
   the acceptance criterion, and none of them can be inferred from a green
   unit suite.

**Open questions for the owner:**

- **Is ChatGPT on a phone even reachable?** OpenAI documents adding a
  connector as a *web* action, on paid tiers, and says nothing about the iOS
  app either way. Anthropic states outright that its hosted surfaces share one
  connector infrastructure; OpenAI makes no such statement. So the Claude half
  of this work has a documented path to the phone and the ChatGPT half has an
  untested one. That is not a reason to skip ChatGPT — the auth work is shared
  and the desktop/web case is real on its own — but nobody should promise the
  iOS app until someone has held one.
- **What should `search`/`fetch` search?** The two hosted corpora (arXiv +
  PubMed) are the natural answer and reuse existing retrieval. Fronting the
  research pipeline instead would make ChatGPT's default experience the full
  cited answer, at pipeline cost per call and with a shape (`fetch` by id)
  that suits a corpus better than a synthesis. Decide before building, not
  after.
- Do we want a connector at all as a *public* thing, or only for approved
  accounts? The site gates sign-up today; a connector anyone can add still
  lands on the same approval gate, but either Add-connector dialog is a much
  wider front door than a minted key.
- Should a fresh connection expose the full tool list, or a narrower default?
  The literature tools are cheap and read-only; `deep_research` is the one
  that spends. The per-account exposure config already expresses this — the
  question is only what a fresh connection defaults to, and for ChatGPT it
  interacts with the `search`-must-exist rule (§4).
- Directory submission (`mcp-review@anthropic.com`, and OpenAI's equivalent
  review) is a separate decision with its own requirements, and is out of
  scope here.
