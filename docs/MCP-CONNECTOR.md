# Reaching the hosted chat clients — the MCP server as a web connector

**Status: BUILT 2026-08-03; first observed working from a Claude client on
2026-08-05 (§7 rung 3), still PARTIAL pending the mobile and ChatGPT halves.** The authorization server
is `src/oauth-metadata.js` + `src/oauth-store.js` + `src/oauth-authorize.js` +
`src/oauth-token.js`, wired into the router and the D1 schema, unit-tested,
and described module by module in §4. On 2026-08-05 a Claude client had this
server connected and called its tools against production for the first time
(§7 rung 3) — so it is no longer only a flow that passes its own tests. What
has still NOT happened is the rest of that rung: nobody has confirmed the
connector on the Claude MOBILE app, and nothing on the ChatGPT side has been
attempted at all.

§2, §2a and §2b stay as written — they are the vendor requirements the build
was aimed at, dated 2026-08-03, and they remain the reference to check the
implementation against. §7 says what was read and what to re-read.

Companion to the **mcp-server** skill, which documents the MCP surface itself.
This one covers the door onto it: turning up in a hosted chat client — Claude
or ChatGPT — instead of only in a terminal.

Both clients were asked about on 2026-08-03 (owner: "I'd love to connect with
OpenAI as well"). They turn out to want **the same authorization server** and
differ in two bounded ways — the redirect URI, and a pair of tool names
ChatGPT insists on. §2 is Claude, §2a is ChatGPT, and §2b is what they share.

---

## 1. The problem, and the short answer

Until §4, the only way in was minting a key in Settings → MCP server and
pasting one line into a terminal:

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

What was missing is **authentication**. A connector cannot be handed an
`mck1.` key the way `claude mcp add --header` hands it one, because both
Add-connector dialogs take a URL and run OAuth. So the work was an OAuth
authorization server, not an MCP change — **and it is one authorization
server for both clients**, which is the finding that made supporting ChatGPT
as well a small increment rather than a second project. §4 is what got built.

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

## 2c. What `/connect/` tells a person, and why it is ordered that way

The page led with **minting a key** and the `claude mcp add` command, and put
the connector — the only route that works on a phone, and the one needing no
key at all — third. Measured on a 390 px viewport, the connector instructions
began **1,421 px down**: about three and a half screens, behind a terminal
command a phone cannot use. Reordered 2026-08-03 (owner: *"should be very
straight forward and clearly documented"*), the connector is section 1 at
**369 px**, with the URL in a one-tap copy block and per-client steps
immediately under it. The terminal path keeps everything it had and is now
section 2, prefaced with who it is for.

**The page also used to overclaim on ChatGPT.** It said, of both clients, that
you *"add it once on the web or desktop; it then appears in the mobile app with
nothing further to do"* — true for Claude, whose surfaces share one connector
list (§1), and **not established for ChatGPT**, whose mobile behaviour OpenAI
does not document. The body asserted it while the note below it admitted the
doubt. The two now agree: Claude's step says there is no separate mobile step,
ChatGPT's says to add it in a browser and then *check the app*, and says why
that check is real. A page that hedges in a footnote and promises in the body
has told the reader the promise.

**And then the paths themselves turned out to be wrong.** The reordering above
is right and stands; the navigation steps inside it were not. An owner tried
them the same day and reported: *"I dont find custom connector in claude app?
And the settings path for chatgpt was not found neither!"* Both were carried
from this document into the page and had never been checked against either
vendor's UI — §7's acceptance check covers whether the SERVER connects, and
nobody had confirmed that the menus a person is told to walk still exist under
those names. The page now says outright that the paths are unverified, in place
of printing them, while the real ones are established from Anthropic's and
OpenAI's own documentation. **The lesson is narrow and worth keeping: a
build-side acceptance check does not cover the instructions, and vendor UI
labels are the fastest-rotting facts in this document.** They need a date and a
source line each, the way the redirect URIs in §2a have.

## 2d. The verified paths and the install link (retrieved 2026-08-03)

Both vendors had **renamed the menu**, which is the whole explanation for the
two reported failures. Every line here carries its source; re-check by date.

**Claude — `claude.ai/customize/connectors`.** It moved out of Settings into a
**Customize** section (Skills / Connectors / Plugins) in February 2026, so
"Settings → Connectors" finds nothing.

> "Navigate to **Customize > Connectors** / Click "+" then "Add custom
> connector." / Add your connector's remote MCP server URL."
> — support.claude.com/en/articles/11175166

Team and Enterprise are Owner-only, at `claude.ai/admin-settings/connectors`.
Free, Pro and Max add it themselves; Free is capped at one custom connector.
**Mobile:** "installing connectors on mobile is currently in beta — Claude
Desktop and web remain the primary path", and one added on web "will be
available to use the next time you log in to your account on Claude for iOS or
Android" (article 11176164). The phone USES it; add from a browser. Anthropic's
own two sources disagree on the label — the developer docs still say "Settings
> Connectors" — but the deep links are unambiguous and are what we print.

**THE INSTALL LINK IS THE ANSWER TO "why isn't this one tap".** Anthropic
documents a prefilled dialog, needing no directory listing, no review and no
Team plan:

> "For a connector that is not in the directory, link to the **Add custom
> connector** dialog with the name and URL prefilled:
> `https://claude.ai/customize/connectors?modal=add-custom-connector&connectorName=NAME&connectorUrl=ENCODED_URL`"
> — claude.com/docs/connectors/building/directory-vs-custom

> "Install links only prefill the form. They do not bypass review by the user,
> and they do not grant your server any permissions the user has not confirmed."

`/connect/` now leads with that as an **Add to Claude** button. Note the shipped
parameter names are `connectorName` / `connectorUrl` — the originating GitHub
issue proposed `mcpName` / `mcpServerUrl`, which do not work.

**ChatGPT — Developer mode, then `chatgpt.com/plugins`.** Renamed twice:
Connectors → apps → **Plugins**. A self-hosted server additionally needs
**Developer mode**, which is not in that menu:

> "In ChatGPT, open **Settings → Security and login** and turn on **Developer
> mode**." … "The plus button will only create developer-mode apps after you
> turn on Developer mode."
> — developers.openai.com/api/docs/guides/developer-mode

> "Under **Connection** … enter the MCP server URL, **including the `/mcp`
> path**." — developers.openai.com/plugins/deploy/connect-chatgpt

**That last line matters here:** we advertise the bare origin (§2b) and ChatGPT
tells people to include `/mcp`. Both answer identically (verified live), so the
page prints the bare origin for Claude and the `/mcp` form for ChatGPT.
Developer mode is **web only**, on Plus/Pro/Business/Enterprise/Education —
**not Free** — and Business/Enterprise admins can gate it.

**ChatGPT does not reach mobile at all:** "Plugins aren't available in Chat,
the IDE extension, or mobile" (developers.openai.com/codex/plugins). §1 left
this as an open question; it is settled, in the unhelpful direction. Claude
reaches the phone, ChatGPT does not.

**Two §2a claims are corrected by OpenAI's own pages.** `search`/`fetch` are
NOT required for a developer-mode connector — "Developer mode does not require
`search`/`fetch` tools" — only for deep research and company knowledge, where
they stay mandatory. And transport is settled: "Supported MCP protocols: SSE
and streaming HTTP", so our Streamable HTTP is accepted. Keeping `search`/
`fetch` costs nothing and buys the deep-research path.

**No ChatGPT install link exists** in OpenAI's documentation, and there is no
cross-vendor standard — the `.well-known` discovery SEPs (1649, 1960) are open
drafts about capability discovery, not installation. MCPB/`.mcpb` bundles are
**local servers only** and cannot carry a hosted one. Listing in the open MCP
Registry explicitly does **not** surface a server in Claude.

## 2e. The same guidance inside the app (Settings → MCP server)

`/connect/` is a public page a signed-out stranger can read, which is exactly
why it could not be the only place this lives: **the person most likely to
want a connector is the one already signed in and looking at the MCP screen**,
and that screen used to open with minting a key and a `claude mcp add` line —
the same defect §2c measured on `/connect/`, in the surface where an account
holder actually stands. Added 2026-08-03 (owner: *"Mcp menu under settings
should guide user in chatgpt and anthropic"*).

`public/js/account-mcp.js` now renders four sections instead of three, and the
connector is first: an **Add to Claude** button on the same prefilled link, a
copyable connector URL, and the two vendor walkthroughs as collapsed
`<details>` so neither reader scrolls past the other's. The terminal path
keeps everything it had as section 2, prefaced with who it is for. Section 3
(Tools exposed) already carried the `search`/`fetch` warning that a switched-off
pair makes ChatGPT refuse the connection; the ChatGPT walkthrough now points
at it.

**The two URLs are built by the SERVER, not by the screen.**
`src/mcp-api.js` exports `chatgptEndpointUrl()` and `claudeInstallUrl()` and
puts both in the `/api/mcp/config` payload as `chatgpt_endpoint` and
`claude_install_url`. Claude takes the bare origin and OpenAI's form wants the
`/mcp` path (§2d), so there are now three related strings in play and pasting
the wrong one is the commonest way this setup fails — one module decides, two
surfaces render. Both are derived from `mcpEndpointUrl`, so a preview deploy
prefills the preview rather than production, which is what makes the flow
testable anywhere but production.

Neither surface can be tested for correctness of the vendor paths — they
describe someone else's UI, which is how §2c's failure happened. What
`public/js/account-mcp.test.js` pins is what is ours: that the URLs come from
the payload rather than being assembled or hard-coded client-side, that the
two stay distinct, that payload strings are escaped, and that a server which
does not send the connector fields degrades to the walkthroughs instead of
rendering a button pointing at nothing.

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

## 4. What was built

Two owner decisions on 2026-08-03 turned §1–§3 into code: build it now, and
point `search`/`fetch` at the two hosted corpora. The result is additive, as
designed — nothing about the pipeline, the tool list, the exposure config or
the `mck1.` key family changed. Four new modules, a few routes, two new D1
tables, and two adapter tools.

**`src/oauth-metadata.js` — the pure leaf.** Imports nothing, so the router
and `src/mcp.js` can use it without dragging a handler graph into anyone's
tests. It owns both discovery documents (`protectedResourceMetadata`,
`authorizationServerMetadata`), the `WWW-Authenticate` value
(`wwwAuthenticateValue`), where the resource document lives
(`resourceMetadataUrl`), the scopes (`research`, `offline_access`), and
`issuerFor` — the one function that encodes the host split, mapping
`mcp.deepresearch.se` to `https://deepresearch.se` while a preview or a local
run issues from its own origin so the whole flow can be exercised on one host.

**The redirect allowlist is data, and it lives there too.**
`REDIRECT_ALLOWLIST` holds Claude's `https://claude.ai/api/mcp/auth_callback`
and both ChatGPT callbacks; `redirectAllowed` is exact match against that list
OR the RFC 8252 loopback carve-out (`isLoopbackRedirect`: `http`,
`localhost`/`127.0.0.1`, path `/callback`, port ignored, no query or fragment).
Adding a client is an entry, not an edit to the flow. The caller logs what it
refused — a redirect mismatch surfaces to the user as a generic "couldn't
connect", so the refused string is the only diagnostic anyone gets.

**`src/oauth-store.js` — the three token families and their records.** The
repo already signs every credential it lends HS256 over `SESSION_SECRET` under
a per-family namespace, which is what makes the families mutually unforgeable
(`src/token-crypto.js`); this adds three more under the same scheme: the
authorization code `oac1.` (60 s, namespace `oauthcode.`), the access token
`oat1.` (1 h, `oauthaccess.`), and the refresh token `ort1.` (90 days,
`oauthrefresh.`). Codes and refresh tokens are
signed **and** carry a D1 row keyed by `jti` (`oauth_codes`,
`oauth_refresh_tokens`), because a signature cannot
express single use or revocation — the same "token fixed, the record governs"
split `mck1.` and the grant families use. Access tokens are signed only: no
row, no lookup on the hot path, revocation by refusing the refresh. Redemption
(`redeemAuthCode`) enforces signature, expiry, single use, `client_id` match,
`redirect_uri` match and PKCE S256 in one call; `rotateRefreshToken` kills the
old `jti` in the same call that mints the new one, so a public client's
rotation cannot half-happen. The table's DDL is exported as
`OAUTH_SCHEMA_SQL` and pasted into `src/db.js`, so the store owns its own
schema. Pasted rather than imported because `oauth-store.js` imports `getDb`
from `db.js` and the reverse edge would be a cycle — and because the copy is
therefore unavoidable, `oauth-store.test.js` compares the two BOTH ways.
Without that guard a column added to one copy alone fails nothing: `db.js` is
what actually creates the tables, so a store-side edit is inert and a
`db.js`-side edit leaves the store's own schema quietly wrong.

**`src/oauth-authorize.js` — the consent screen and code issuance.** The one
page a human sees in the whole flow, and it needs a signed-in identity: an
unauthenticated arrival gets a sign-in page rather than a code. That is the
whole reason the authorization server is on the apex rather than the
machine-facing `mcp.` host, and it also settles who can connect at all —
either Add-connector dialog is a wider front door than a minted key, but it
opens onto the same sign-in and the same account gates.

The validation order is security rather than tidiness. `redirect_uri` is
settled first, and its failure is the ONE error that renders a page instead of
redirecting, because an unvalidated redirect target is what an open redirector
is made of; it logs `oauth.redirect_refused` with the value it refused. Every
other RFC 6749 §4.1.2.1 error bounces back to the client with `state` intact.
Fetching the CIMD document buys a friendly name on the screen and a second,
independent statement of which redirects the client owns — and it degrades the
DISPLAY only, so a blip at a vendor's end costs the name and not the
connection; a document that *does* list `redirect_uris` without the requested
one is a hard refusal, because fail-soft applies to the fetch and never to a
check the document answered. The form carries a signed consent token (`oct1.`,
its own namespace, bound to the account, ten minutes) holding the request that
was validated, so the POST reads no client parameters back from the browser
and cannot be re-pointed at a redirect the user never saw.

What the screen says is part of the build rather than decoration: connecting
grants the tools left switched on in Settings → MCP server, spends this
account's research quota, and lands every question in the full-visibility
interaction log. The MCP spec also requires the redirect URI's hostname, so a
user can see they are authorizing `claude.ai` and not something that merely
claims to be.

**`src/oauth-token.js` — the wire.** The one endpoint both clients drive
unattended forever, which is why every detail is a vendor requirement rather
than a preference. `application/x-www-form-urlencoded` is the primary body
parser and JSON is a fallback, never the reverse. Failures land on RFC 6749
§5.2 codes at HTTP 400, because clients branch on `error` and only
`invalid_grant` gets a user out of a dead connection without deleting and
re-adding the connector. `client_credentials` is refused explicitly with
`unsupported_grant_type` — Anthropic does not support it, and saying so beats
a generic error in the one place an integrator looks. There is no client
authentication: the registered token-endpoint auth method is `none`, and the
security comes from PKCE plus the redirect allowlist, not a shared secret. The
store is behind a dynamic `import()`, per the file-layout rule, which is also
the seam the tests inject a fake through.

**Registration: CIMD, and no client storage at all.** The authorization-server
metadata advertises `"client_id_metadata_document_supported": true` together
with `"none"` in `token_endpoint_auth_methods_supported`, which is what makes
both clients pick Client ID Metadata Document over DCR; miss either and they
fall back. So the `client_id` is an HTTPS URL rather than a row — no client
table, no `/register`, nothing accumulating per connection. No
`registration_endpoint` is advertised; add one only if something we care about
turns out to need it.

**Two adapter tools for ChatGPT** (§2a): `search` and `fetch`, named exactly
that, returning OpenAI's fixed shapes both as `structuredContent` and as
JSON-encoded content text. **The owner settled what they front: the two hosted
corpora** (arXiv + PubMed), not the research pipeline — so they project what
`literature_search` and `literature_fetch` already return and live beside them
in `src/literature-tools.js` (pure) and `src/literature-run.js` (dynamic),
under the same file-layout rule, each with its `MCP_TOOL_CATALOG` entry or the
mirror test fails. The exposure switch interacts with the requirement: an
account that switches `search` off is an account ChatGPT will refuse to
connect to, and the Settings screen has to say so rather than leaving a user
to discover it as a failed connection.

**Nothing else moves.** The access token resolves to the same identity the
`mck1.` key does, beside it in `resolveMcpKeyIdentity`, so the endpoint keeps
exactly one identity seam and `tools/list` filtering, `tools/call`
enforcement, the four-window quota, split billing and the `chat_logs` row all
apply unchanged. That property is the whole argument for this shape: OAuth
adds a door, not a second surface with its own rules to keep in sync.

**The not-a-login pin extends to the new family.** `identify()` reads a
`Basic` header and the `dr_session` cookie; an `oat1.` token is neither, so
`/admin` and every data-bearing route stay unreachable by construction — the
same structural argument `src/mcp-key.js` makes, pinned the same way,
including the cross-family forgery matrix in both directions.

---

## 4a. Verifying the flow by hand

The sequence below is what a client runs, in order. Each step is where a
connector dies, and each failure reaches the user as the same unhelpful
"couldn't reach the MCP server", so walk it in order and stop at the first
surprise.

**1. The `401` and its pointer.** An unauthenticated POST must answer `401`
with the header — not a `200`, which clients ignore:

```bash
curl -isS https://mcp.deepresearch.se \
  -H "content-type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | head -20
# expect: HTTP/2 401
#         www-authenticate: Bearer resource_metadata="https://mcp.deepresearch.se/.well-known/oauth-protected-resource"
```

**2. Follow the pointer.** The `resource` field must equal the URL a user
would type into the dialog, character for character, and
`authorization_servers[0]` is the only entry either client reads:

```bash
curl -sS https://mcp.deepresearch.se/.well-known/oauth-protected-resource
# expect: resource == "https://mcp.deepresearch.se"
#         authorization_servers == ["https://deepresearch.se"]
```

**3. Follow the issuer.** Check the two fields that decide registration
(`client_id_metadata_document_supported` and `"none"`), and `S256`:

```bash
curl -sS https://deepresearch.se/.well-known/oauth-authorization-server
```

**4. Authorize in a browser**, signed in, with a PKCE pair you generated:

```bash
V=$(openssl rand -hex 32)
C=$(printf %s "$V" | openssl dgst -binary -sha256 | openssl base64 | tr '+/' '-_' | tr -d '=\n')
echo "verifier=$V challenge=$C"
# then open, signed in:
# https://deepresearch.se/oauth/authorize?response_type=code
#   &client_id=<a CIMD URL>&redirect_uri=http://127.0.0.1:8976/callback
#   &code_challenge=$C&code_challenge_method=S256
#   &scope=research%20offline_access&state=xyz
```

Consent redirects to the `redirect_uri` with `?code=…&state=…`. A refused
redirect never gets that far, and the refused value is in the logs — that is
what the logging is for.

**Click the button, and click it in a browser.** The `curl` walk skips the one
step no request built by hand exercises: the consent form's own POST back to
`/oauth/authorize`. That POST carries browser-set headers, it is checked
against them, and it is where the first live run died (§4b). A hand-built POST
sets its own `Origin` and proves nothing about it.

**5. Exchange the code**, form-encoded, within its 60 seconds:

```bash
curl -sS https://deepresearch.se/oauth/token \
  -H "content-type: application/x-www-form-urlencoded" \
  -d grant_type=authorization_code -d "code=$CODE" \
  -d "redirect_uri=http://127.0.0.1:8976/callback" \
  -d "client_id=$CLIENT_ID" -d "code_verifier=$V"
```

Then check the three things unit tests cover but a hand run confirms end to
end: replaying the same code answers `invalid_grant`; the `oat1.` token works
as a `Bearer` on the MCP endpoint (`tools/list` returns the account's exposed
tools); and `grant_type=refresh_token` returns a NEW refresh token, after
which the old one answers `invalid_grant`.

**What none of this proves.** Every step above can pass while the connector
still fails, because the client is doing things this walk does not: fetching
and validating the CIMD document, matching the typed URL, and enforcing its
own latency ceilings. §7's rung 3 is the acceptance criterion, and it has not
been run.

---

## 4b. The first live run (2026-08-04): the consent page refused its own form

Claude's connector flow was driven from an iPhone for the first time on
2026-08-04. Everything the sections above describe worked — discovery, the
`401` and its pointer, both metadata documents, the CIMD fetch (`client_name`
came back as "Claude"), the consent screen — and then the **Connect** button
produced `invalid_request`: *"This form was submitted from another site."*
Nothing was granted, and the user had no way to tell why.

```
12:56:56Z  oauth.consent_shown          client_id=https://claude.ai/oauth/mcp-oauth-client-metadata
                                        client_name=Claude redirect_host=claude.ai
                                        scope="research offline_access"
12:57:19Z  oauth.consent_cross_origin   origin="null"   ← 23 s later, the same user
```

**The cause was our own response header.** `Referrer-Policy` does not only
govern `Referer`. Fetch's *append a request `Origin` header* step reads the
request's referrer policy when the request is non-CORS and its method is
neither `GET` nor `HEAD`, and under `no-referrer` it serializes the origin as
the literal string `null` — for a same-origin submission as much as any other.
The consent page was served `Referrer-Policy: no-referrer`, chosen so the
authorize query string could not leak; the form it carried therefore POSTed
with `Origin: null`; and the CSRF guard in `handleAuthorizePost` compared that
against `url.origin`, found a mismatch, and returned 403. The page refused its
own form. Reproduced in Chromium against a two-line server: `no-referrer` →
`Origin: null`, `same-origin` / `strict-origin-when-cross-origin` /
`no-referrer-when-downgrade` → the real origin.

Both halves were fixed, and both are pinned in `src/oauth-authorize.test.js`:

- The pages are served **`Referrer-Policy: same-origin`**. It keeps the
  property `no-referrer` was chosen for — a cross-origin navigation still gets
  no referrer, so the code challenge and the state do not leave this origin —
  and it leaves the POST's `Origin` intact. The 302 back to the client keeps
  `no-referrer`; a redirect is not a form and nothing's `Origin` depends on it.
- The guard now treats `Origin: null` as **opaque, not foreign**: accepted, and
  logged as `oauth.consent_opaque_origin`. A browser serializes `null` for an
  ordinary same-origin POST under conditions the server does not control — a
  page's referrer policy, a sandboxed context, an embedded webview's own rules
  — so refusing it refuses honest submissions and withholds nothing from an
  attacker. What actually stops a cross-site POST is structural and untouched:
  `dr_session` is `SameSite=Lax`, so the cookie is not sent at all, and the
  consent token is signed, expiring and bound to the uid it was shown to.

**Two things this says about the rest of the surface.** A unit suite that
builds its own requests will pass over any bug of this shape — every POST test
here set `Origin` by hand, so all of them agreed with each other and none of
them agreed with a browser. And a security header is part of the flow's
behaviour, not a coat of paint on top of it: this one was added for a good
reason, was correct about referrers, and silently disabled the endpoint it was
protecting.

---

## 4c. The second live run (2026-08-05): ChatGPT could not connect at all

Reported as "ChatGPT MCP connection failed", alongside a connector tile showing
a letter **D** on a green background. Five separate defects, each sufficient on
its own to end the flow, and none of them visible to the user as anything but
"couldn't connect".

**1. ChatGPT's callback is per connector, and the allowlist only had the legacy
one.** OpenAI now redirects to `https://chatgpt.com/connector/oauth/<callback_id>`
and states that the previous `…/connector_platform_oauth_redirect` "continues to
work" for apps **already published**. A connector added today gets a fresh
`callback_id`, so no exact string could match it: `redirectAllowed` refused,
`/oauth/authorize` rendered a refusal, and no code was ever issued. Fixed with
`isChatgptConnectorRedirect` — a bounded SHAPE match (exact origin, the
`/connector/oauth/` prefix, exactly one id-shaped segment, no query or
fragment), sitting beside the exact list rather than replacing it. §2a's note
that this URL came from integrator reports rather than OpenAI's reference is
now settled: the reported form was the legacy one.

**2. Signing in destroyed the authorization request.** `/oauth/authorize` sat
below the identity gate, so an unauthenticated arrival met the site's generic
sign-in card — and the Google callback hard-redirected to `/rver`. The user
signed in, landed in the app, and the request they arrived with (PKCE challenge,
client state) was gone; the connector popup waited for a code nobody could still
mint. **This broke Claude too** — the 2026-08-04 run only reached consent
because the owner was already signed in on that device, which is exactly the
kind of accident that hides a bug of this shape. Fixed by redirecting an
unauthenticated authorization request into `/auth/google?next=…` and carrying
the return path in its own short-lived cookie, validated against a closed
prefix list on the way in AND on the way out.

**3. No DCR, so a client that does not speak CIMD had nowhere to register.**
The authorization-server metadata advertised CIMD only and no
`registration_endpoint`; `POST /oauth/register` fell through the identity gate
and answered `401` with HTML. OpenAI's docs do describe CIMD as preferred, but
DCR is selectable in their dialog and is what a builder who picks it uses — and
a dead end at discovery is invisible. Fixed by building the fallback that
`oauth-metadata.js` had described from the start (`src/oauth-register.js`). The
recorded objection to DCR — a client row per connection — is answered by issuing
a **signed stateless `client_id`** (`orc1.`) that carries its own registration,
so there is still no client table. A registration cannot widen where a code may
be sent: every `redirect_uris` entry is checked against the same allowlist, at
registration and again at use.

**4. The `resource` did not match the URL ChatGPT users are told to type.**
OpenAI's setup says to enter the endpoint *with* its `/mcp` path (which is why
`chatgptEndpointUrl` hands out that spelling), but only the bare-origin
document existed and it advertised `resource: "https://mcp.deepresearch.se"`.
A client validating `resource` against what was typed gets a mismatch it
reports as an unreachable server. Fixed by serving the RFC 9728 §3.1
path-inserted document at `/.well-known/oauth-protected-resource/mcp` as well,
and by pointing the `401`'s `WWW-Authenticate` at whichever document matches
the URL the request arrived on. Note this REVERSES a previous pin: the path
used to be dropped, which was right about not appending to the resource and
wrong about discarding it.

**5. `GET /mcp` answered `200 text/html`.** The `mcp.` host served the
`/connect/` page for both `/` and `/mcp`. Streamable HTTP says a server
offering no SSE stream on `GET` returns `405`, and a client reading HTML there
can conclude the URL is not an MCP endpoint. The bare origin still serves the
page — a person typing the host into a browser — and `/mcp` now answers as an
endpoint. CORS was absent throughout (`OPTIONS` on every OAuth route fell to
the identity gate and returned an HTML `401`); the discovery documents, the
token and registration endpoints and the MCP `401` now answer it, with
`WWW-Authenticate` exposed.

**And the green D was not a broken asset.** Every icon this site ships serves
`200`; the connector had simply never been told any of them existed, so the
client generated a tile from the first letter of `serverInfo.name`. Two causes,
both fixed: `serverInfo` now carries the SEP-973 `icons` and `websiteUrl`
fields (unknown fields are ignored by clients predating the `2025-11-25`
revision, so this is free on the one we report), and the conventional
root-level icon probes — `/apple-touch-icon.png` above all — used to hit the
identity gate and get an HTML `401`, which is the *generic letter* failure
`src/assets.js` already documented, reached by the one path its allowlist did
not cover.

**What this run says generally.** Four of these six were the same mistake:
believing a vendor's documented preference over what its client actually sends,
and pinning that belief in a test. `oauth-metadata.test.js` asserted the
ABSENCE of a registration endpoint and the DROPPING of the resource path — both
assertions were faithful to the design and both described a server ChatGPT
cannot use. A test that pins an assumption makes it permanent.

---

## 4d. The third live run (2026-08-13): connected, and still stuck

Not a connection failure — the first one where every part of §4a was working.
Reported as a research question that "just got stuck" during a voice session.

Workers Logs for `mcp.deepresearch.se`, 05:41–05:43: two `deep_research` calls,
86.5 s and 50.5 s of wall time, **both `ok`**, both logged by `mcp.complete`,
both written to `chat_logs` in full (#1725, #1726). `scripts/chatlogs --errors`
was empty and `mcp.tool_failed` never fired. Seconds after the second one
returned, the connector POSTed a fresh `initialize` and two `tools/list` — a
reconnect, which is what a client does after it has given up.

The cause was silence. `tools/call` was answered as one buffered JSON response,
so between the POST and the finished answer the server sent nothing at all —
for a minute and a half. A client cannot distinguish that from a hung server,
and nothing on this side records that it happened, because on this side nothing
went wrong.

Fixed by answering `tools/call` on an SSE stream when the client accepts one:
keepalive comments every 10 s, `notifications/progress` on the same tick when
the caller supplied a `progressToken` (the spec's timeout rule lets a client
reset its clock on one), then the same JSON-RPC response as the last frame. The
dispatch, the envelopes and the results are untouched, and a caller that did not
ask for a stream still gets the buffered JSON. Details, the four rules the shape
has to keep, and the failure this does NOT fix (a client with a hard wall-clock
ceiling rather than an idle timeout) are in the **mcp-server** skill.

**What this run says generally.** A green connection check says a client can
reach the server, not that it can wait for it. The tool battery in
`npm run mcp:probe` never surfaced this: every literature call answers in
seconds, and the one tool that runs for minutes is the one the probe skips
unless `--deep` is passed.

---

## 5. What it does and does not change about privacy

Nothing in invariant 4 moves. An MCP call was already a **Se/rver** call:
the question reaches this server, goes upstream to the model and the search
provider, and is recorded in the interaction log on channel `mcp`. A connector
is the same call with a different door, and `public/connect/` already says
this plainly — that page's "What crosses the wire" section covers a connector
verbatim.

Two things are genuinely new, and they are now stated in
`docs/PRIVACY-MODEL.md` alongside the MCP key they extend:

- **A consent screen that names the exposure**, which is a privacy *gain* over
  a pasted bearer token: today nothing tells an account what a key can reach at
  the moment it is minted.
- **A per-connection credential that is revocable per connection.** One
  `mck1.` key per account means revoking the laptop revokes the phone. OAuth
  refresh tokens are per connection, so they can be listed and killed
  individually.

---

## 6. The stopgap it replaces

Kept because it still works, and because it is the fallback if §4's flow turns
out to fail its live check on Claude.

`static_headers` — the Request headers section of the Add-connector dialog —
works against the server exactly as it stood before §4: choose
`authorization`, enter
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
without the Anthropic beta — and for everyone on ChatGPT — it was never an
answer at all, which is why §4 got built rather than documented around.

---

## 7. Before anyone touches this again

**Re-read the sources.** §2, §2a and §2b are dated 2026-08-03 and both
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

**The validation ladder** (extending the **mcp-server** skill's), and where
the build actually stands on it:

1. **Unit — done.** Both metadata documents; PKCE S256 verification including
   rejection of a wrong verifier; authorization-code single use; refresh
   rotation and `invalid_grant`; the redirect-URI allowlist including the
   port-agnostic loopback match; the not-a-login pin for the new family.
   `node --test src/oauth-*.test.js`.
2. **Handshake by hand — §4a**, which is this rung written out: `curl` the
   unauthenticated `POST`, confirm `401` + `WWW-Authenticate`, follow the
   pointer, follow `authorization_servers[0]`, confirm the discovery document,
   then run a code exchange and a refresh. This is the sequence a client runs,
   and a failure anywhere in it surfaces as the same unhelpful "Couldn't reach
   the MCP server."
3. **Live, on each real client — the CLAUDE half is now PASSING in part; the
   ChatGPT half is untouched.** The Claude half was driven from a phone on
   2026-08-04 and reached the consent screen before failing on the approval
   POST (§4b — a header of ours, fixed and merged as #377).

   **First observed working end to end: 2026-08-05.** A Claude client had this
   server connected and called its tools for real — `literature_corpora`
   answered in 89 ms with live `vectorCount`s off both Vectorize bindings, and
   the same call was used as the instrument that caught a stale
   `CORPUS_FACTS.arxiv.window` during the #380 merge. So the server is
   reachable from a Claude client, its tool list is discoverable, and
   `tools/call` runs against production bindings. That is the first evidence
   for any of it beyond a unit suite.

   **Be precise about what that does and does not settle**, because the
   temptation is to read it as the whole rung:

   | | |
   |---|---|
   | server reachable from a Claude client | **yes, observed** |
   | `tools/list` + `tools/call` against production | **yes, observed** |
   | which auth path carried it (OAuth connector vs an `mck1.` key) | **not observable from inside the session** — check Workers Logs for `oauth.` events against the timestamp to settle it |
   | the connector visible in Claude MOBILE with no further setup | **not observed** |
   | ChatGPT: added at all, transport accepted, reachable on iOS | **not observed, all three** |

   So the remaining work is unchanged in shape and smaller in size: confirm
   the phone, and do the whole ChatGPT half. Neither can be run from a build
   container — both need a browser, an account and a phone — and neither can
   be inferred from a green unit suite. **F-20 stays `PARTIAL`** until the
   mobile confirmation lands, but "nobody should tell a user the connector
   works" is now too strong for Claude on the web: it demonstrably does.

**Open questions for the owner:**

- **Is ChatGPT on a phone even reachable?** OpenAI documents adding a
  connector as a *web* action, on paid tiers, and says nothing about the iOS
  app either way. Anthropic states outright that its hosted surfaces share one
  connector infrastructure; OpenAI makes no such statement. So the Claude half
  of this work has a documented path to the phone and the ChatGPT half has an
  untested one. That is not a reason to skip ChatGPT — the auth work is shared
  and the desktop/web case is real on its own — but nobody should promise the
  iOS app until someone has held one.
- Should a fresh connection expose the full tool list, or a narrower default?
  The literature tools are cheap and read-only; `deep_research` is the one
  that spends. The per-account exposure config already expresses this — the
  question is only what a fresh connection defaults to, and for ChatGPT it
  interacts with the `search`-must-exist rule (§4).
- Directory submission (`mcp-review@anthropic.com`, and OpenAI's equivalent
  review) is a separate decision with its own requirements, and is out of
  scope here.
