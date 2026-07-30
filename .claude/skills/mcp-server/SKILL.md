---
name: mcp-server
description: >-
  Load when working on the MCP server surface — the site exposed AS a tool
  other agents (Claude Code, Cursor, any MCP client) can call — or when
  touching src/mcp.js, the POST /mcp route, the deep_research tool, its input
  schema, or the JSON-RPC 2.0 / Streamable-HTTP protocol handling (initialize
  / tools/list / tools/call / notifications/initialized). ALSO the go-to for
  CONNECTING an external client: "connect Claude Code", "claude mcp add", the
  MCP KEY bearer credential (src/mcp-key.js — mint/rotate/revoke, and why it
  is never a login and not a Se/rver token), the dedicated mcp.deepresearch.se
  host and its public setup page public/connect/, and the per-account EXPOSURE
  configuration behind Settings → "MCP server" (src/mcp-config.js,
  src/mcp-api.js, public/js/account-mcp.js, /api/mcp/config + /api/mcp/key) —
  which tools an account exposes, the research defaults, and the override
  policy. Covers the file-layout rule (pure protocol helpers static, pipeline
  dynamic-imported), the catalog⇔tool-list mirror test, how a tool call reuses
  chat.js's per-request setup (quota gate, model routing, usage/billing
  recording), how to add or change a tool, the shared seams
  (model-routing.js, billing.js), the validation ladder, and debugging an MCP
  client that can't connect or whose tool call is refused.
---

# The MCP server — DeepResearch as a tool (`POST /mcp`)

## What this is and why it exists

`src/mcp.js` exposes the whole deep-research pipeline **as an MCP server**.
Its headline tool is `deep_research` — question in, cited/validated/
source-diverse answer out — callable by any MCP client (Claude, Cursor, an
agent SDK). Alongside it the server re-exposes two more families:
DistillSDK's four **manifest tools** (`sdk_list_modules`, `sdk_show_module`,
`sdk_plan`, `sdk_validate`, via `SDK_MCP_TOOLS`) so an external agent can plan
against the SDK without shelling into the execution sandbox, and — since
2026-07-30, feedback #52 — the NHxx **watch-builder tools** (`watch_catalog`,
`watch_case`, `watch_build`, `watch_command`, `watch_check`, `watch_sourcing`,
via `WATCH_MCP_TOOLS` over `src/watch-tools.js`) so an agent can configure and
cost a mod build without a browser. Eleven tools total; the pipeline one is
the reason the server exists.

Both extra families are **pure** — committed data, a regex command parser, no
network, no D1, no model — which is why they are static imports in `mcp.js`
without breaking its keep-the-pipeline-dynamic file-layout rule, and why they
cost nothing to expose. Both also fail into an `isError` result rather than a
transport error, and `watch_*` degrades junk arguments to a described default:
a tool that throws is a model that retries the same call forever.
This is the ONE place the pipeline points *outward*: the architecture
roadmap (`docs/ARCHITECTURE-ROADMAP.md` §3) argues MCP belongs on the
outbound edge (DeepResearch *as* a tool other agents compose with), NOT as
internal plumbing — internal tool selection stays deterministic and in the
Worker's hands (invariant 1). So this server adds a transport over the
existing pipeline; it does **not** hand control flow to a model.

Transport is modern **Streamable HTTP**: JSON-RPC 2.0 over a single POST to
`/mcp`. The protocol surface is tiny, so it's **hand-rolled — no
dependency** (same minimal-deps stance as the rest of the repo). It
implements exactly the methods a minimal server needs:

- `initialize` → `initializeResult()` (reports `PROTOCOL_VERSION`,
  `SERVER_INFO`, `capabilities: { tools: {} }`)
- `tools/list` → `toolsListResult(config)` (`ALL_MCP_TOOLS` = `DEEP_RESEARCH_TOOL`
  + `SDK_MCP_TOOLS`, filtered by the account's exposure config)
- `tools/call` → `handleToolCall()` → `runDeepResearch()`
- `notifications/initialized` → no-op ack (a notification has no `id`, so it
  returns no response body)

## Getting in: the two auth paths and the `mcp.` host

The route is wired in `src/index.js` twice, deliberately, and both sides ask
the same `isMcpEndpoint(url, method)` predicate (`src/mcp-config.js`) so they
can never disagree about what the endpoint is:

- **Below the identity gate** (`routeApi`) — a signed-in session or the
  break-glass Basic header, exactly as before.
- **Above it** — an **MCP key** (`src/mcp-key.js`), the bearer credential an
  external client carries because it has no cookie jar. `src/mcp-api.js`'s
  `resolveMcpKeyIdentity` resolves it, and the router consults that function
  for this endpoint and nothing else. Its three outcomes matter: `null` (no
  key — fall through to the gate), `{identity, config}`, and `{error}` — a
  key that was PRESENTED and refused must come back as a 401 JSON-RPC error,
  never the sign-in HTML, or the client reports a transport failure and its
  user hunts the wrong problem.

**An MCP key is never a login**, and that is structural, not a promise:
`identify()` reads a `Basic` header and the `dr_session` cookie, so an
`mck1.` bearer cannot satisfy it in any position (test-pinned in
`src/mcp-key.test.js`, alongside the cross-family forgery matrix). It is
also deliberately **not** the Se/rver token — that family's closed
upstream-only vocabulary exists to protect Se/cure, whereas a key acts for a
Se/rver account inside the trust boundary. One key per account; minting
rotates, revoking rewrites the stored `jti` the token must match. The token
is returned once at mint and never stored (only `jti` + a six-character
hint), so "I lost it" is answered by minting again, not by reading it back.

Production also serves the endpoint on **`mcp.deepresearch.se`** (a
`custom_domain` route in `wrangler.toml`, provisioned through the Workers
custom-domains API — `PUT /accounts/<id>/workers/domains` with
`{environment, hostname, service, zone_id}`, which creates the DNS record and
the certificate; the host answered within ~20 s).

> **Declare it in `wrangler.toml` or lose it.** Observed 2026-07-26: the
> domain was created by API, an unrelated merge to `main` auto-deployed from
> a `wrangler.toml` that did not list it, and **the deploy removed the
> domain** — the host went unreachable until it was re-created. The API call
> and the config entry are not alternatives; a domain missing from `routes`
> does not survive the next deploy.

Same Worker, same code path. On that host the BARE
ORIGIN answers too — clients disagree about whether the configured URL
includes the path, and a wrong-URL 404 is the commonest way an MCP setup
fails — and a `GET` serves the public setup page `public/connect/`
(allowlisted in `src/assets.js`). `src/canonical.js` leaves the host alone:
it only rewrites `http` → `https` and strips `www.`.

## What is exposed: per-account configuration

`src/mcp-config.js` is a pure leaf owning WHAT the surface offers, edited in
Settings → **MCP server** (`public/js/account-mcp.js`, one level below the
gear icon's Settings, the same treatment as LLM sharing) through
`GET`/`PUT /api/mcp/config` and `POST`/`DELETE /api/mcp/key`.

- `MCP_TOOL_CATALOG` **mirrors the served tool list exactly** —
  `src/mcp-config.test.js` fails the build when they drift, so a tool cannot
  ship on this surface without a switch to turn it off. Adding a tool means
  adding a catalog entry in the same change.
- The config is read at CALL time and lives on the ACCOUNT, not in the token:
  narrowing takes effect on the next call for every outstanding key, with
  nothing to re-issue. The config endpoints are behind the identity gate, so
  a key holder can see the effects and never change them.
- `tools/list` is filtered by it and `tools/call` ENFORCES it (a client that
  cached an older listing still cannot reach a switched-off tool — reported
  as unknown-tool, since from the caller's side it does not exist).
- `resolveResearchArgs` reconciles a `deep_research` call's arguments with the
  account's defaults and override policy before `runDeepResearch` sees them.
  Asymmetry worth keeping: a caller may always DECLINE web search, and can
  never switch it back on.

Defaults are "everything exposed, site defaults, no key" — byte-for-byte the
behaviour that existed before the configuration did, so an account that never
opens the screen sees no change.

## The load-bearing file-layout rule

`src/mcp.test.js` must unit-test the protocol **without loading the
pipeline**. So the module is split by import weight:

- **Top of file — PURE, statically importable:** `parseJsonRpc`, the
  envelope builders (`jsonRpcResult`, `jsonRpcError`, `toolResult`),
  `initializeResult`, `toolsListResult`, the RPC error-code constants, and
  `DEEP_RESEARCH_TOOL` (the tool schema). The only static imports are leaf
  modules: `http.js` (`jsonResponse`), `model-routing.js`
  (`resolveJsonModel`) and `mcp-config.js` (the exposure seam) — none of
  which pulls the pipeline graph in.
- **Inside `tools/call` — DYNAMIC `import()`:** the pipeline and its deps
  (`pipeline.js`, `berget.js`, `budget.js`, `validation.js`, `providers.js`,
  `config.js`, `quota.js`, `billing.js`) are imported *inside*
  `runDeepResearch`, so importing the module (as the test does) never drags
  in `pipeline.js`/`berget.js`/etc.

**Keep this rule.** New pure protocol logic goes at the top; anything that
needs the pipeline stays behind the dynamic import. `mcp.test.js` asserts
the module loads without the pipeline — breaking the split fails the suite.

## How a tool call runs (`runDeepResearch`)

`tools/call` for `deep_research` mirrors `src/chat.js`'s per-request setup
**without editing chat.js** — it deliberately re-does the same steps so a
change to the chat path doesn't silently change MCP:

1. Guard `BERGET_API_TOKEN`; build a single-turn `[{role:"user",
   content:question}]` conversation and `validateMessages` it.
2. Resolve the model against the catalog (fail-soft to default if the
   catalog is unreachable), honoring `args.model` then the admin default.
   `resolveJsonModel(catalog, model, DEFAULT_MODEL)` picks the fixed JSON
   planning model — the SAME split-routing decision `chat.js` uses (shared
   via `model-routing.js`, invariant 3).
3. Budget: `clampBudget(args.time_budget_s ?? 120)` then
   `Math.min(…, config.max_time_budget_s)` — chat.js's exact two-step clamp.
4. **Quota gate — the same one `/api/chat` enforces.** Admins
   (`isSecretAdmin` / `role === "admin"`) are never blocked; every regular
   user is checked against their four-window budget BEFORE any spend. This
   is load-bearing: without it, `/mcp` would be an unmetered bypass of the
   quota `/api/chat` applies — each call runs the full pipeline for real
   Berget + Exa money.
5. Run `runPipeline`, collect the streamed answer into one string, append
   the Sources list (`withSources`).
6. **Record usage** (`recordUsage`) with the split-billing totals
   (`summarizeSpend` / `exaCost` from the shared `billing.js`) so MCP spend
   shows up in the usage bars and admin cost totals just like chat spend.

The tool's input schema (`DEEP_RESEARCH_TOOL.inputSchema`): required
`question`; optional `time_budget_s` (default 120, clamped 15–600), `model`
(Berget id; JSON phases stay on the reliable model regardless), `web_search`
(default true; false = answer directly, no search provider contacted).

## Adding or changing a tool

- **Change the deep_research schema:** edit `DEEP_RESEARCH_TOOL` at the top,
  read the new arg in `runDeepResearch` with a fail-soft default, and update
  the `tools/list` assertion in `mcp.test.js`. Keep descriptions written for
  an LLM caller (they're what the client model sees).
- **Add ANOTHER tool:** add its schema constant at the top, put it in
  `ALL_MCP_TOOLS`, add its `MCP_TOOL_CATALOG` entry in `src/mcp-config.js`
  **in the same change** (the mirror test fails otherwise — and an account
  needs a way to switch it off), and branch on `parsed.params.name` in
  `handleToolCall` — which already dispatches the `sdk_*` family by
  `SDK_TOOL_NAMES` membership before falling through to `deep_research`;
  anything matching neither is method-not-found. Any heavy work its handler
  needs stays behind a dynamic import. Ask whether the tool actually belongs
  here — the roadmap's thesis is a few high-leverage tools, not a tool zoo; a
  new one should be a genuinely distinct outward capability, not a pipeline
  knob. (The `sdk_*` four earned their place by answering manifest questions
  the sandbox would otherwise have to shell out for.)
- **Never** introduce model-driven tool *selection* on the inbound side —
  that's the exact function-calling shape invariant 1 rules out. The MCP
  client's model chooses to call `deep_research`; inside, orchestration
  stays deterministic.

## Validation ladder

1. **Unit** — `node --test src/mcp.test.js src/mcp-config.test.js
   src/mcp-key.test.js src/mcp-api.test.js`: the pure protocol helpers and
   the loads-without-the-pipeline guarantee; the catalog⇔tool-list mirror
   and the argument resolution; the key's crypto, the not-a-login pin and
   the cross-family forgery matrix; key resolution (revoked / rotated /
   disabled account / surface off) and the config endpoints.
   `npm run typecheck` (all four are `// @ts-check`).
2. **Live JSON-RPC probe** against the deployed site. Sanity sequence:
   `initialize` → `tools/list` (expect `deep_research` + the four `sdk_*`
   tools, with schemas) → `tools/call` with a cheap
   `{question, time_budget_s: 15}` and confirm a cited answer comes back
   and the spend lands in the usage totals. Run it BOTH ways — with the
   break-glass Basic header on `/mcp`, and with a minted key against
   `https://mcp.deepresearch.se/mcp` — since only the second exercises
   the above-the-gate path and the custom domain. Then check the negatives:
   revoke the key and confirm the next call is a 401 JSON-RPC error (not
   HTML), and switch a tool off and confirm it vanishes from `tools/list`
   AND is refused on `tools/call`. See the **live-verify** skill for
   `wrangler tail` / `x-request-id` correlation and the **access-control**
   skill for the Basic Auth credentials.
   ```bash
   curl -sS https://mcp.deepresearch.se/mcp -H "content-type: application/json" \
     -H "Authorization: Bearer $MCP_KEY" \
     -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
   ```
3. If the change touched the pipeline path, the pipeline's own checks apply
   — see **pipeline-architecture**.

## The stateless revision — what's coming (F-19)

**Read this before touching the protocol surface.** `PROTOCOL_VERSION` is
`"2025-06-18"` and has never been bumped — the published spec revision is
`2025-11-25`, so the server already reports a version two behind, and the
NEXT revision rewrites exactly the methods above. Tracking it is
`FEATURES.md` F-19, opened from user feedback #33 (2026-07-26).

Verified against `modelcontextprotocol.io/specification/draft/changelog` on
2026-07-26 (a *draft* — re-read it before building; a reported RC date of
2026-07-28 was **not** confirmed by the published revision list):

- **The handshake is removed.** No `initialize`, no
  `notifications/initialized`. Each request carries its protocol version and
  client capabilities in `_meta`
  (`io.modelcontextprotocol/protocolVersion`, `…/clientCapabilities`,
  `…/clientInfo`); each result returns `…/serverInfo` in its own `_meta`.
  Mismatch → `UnsupportedProtocolVersionError` (`-32022`).
- **`server/discover` is MANDATORY** — a new RPC advertising supported
  versions, capabilities and identity. New surface, not a renamed
  `initialize`.
- **Protocol sessions and `Mcp-Session-Id` are gone.** List endpoints no
  longer vary per connection; cross-call state becomes a server-minted
  handle passed as an ordinary tool argument.
- **Results carry a required `resultType`** — `"complete"`, or
  `"input_required"` for the multi-round-trip pattern. A missing field from
  an older server MUST read as `"complete"`.
- **`tools/list` results require `ttlMs` + `cacheScope`** and SHOULD be
  deterministically ordered — ours already are (a static array).
- **`extensions` joins client/server capabilities.** This is MCP's own
  extension concept and is unrelated to invariant 7's `src/extensions.js`
  registry; the shared word is a trap.
- **`Mcp-Method` / `Mcp-Name` request headers become required**
  (`HeaderMismatch`), and the server-error range is re-partitioned:
  `-32020`–`-32099` reserved for the spec, `-32000`–`-32019` left
  implementation-defined. Our `RPC_*` constants are all standard JSON-RPC
  codes and are unaffected; new codes must come from the right range.
- **Irrelevant to us — confirm, don't implement:** `ping`,
  `logging/setLevel`, `notifications/roots/list_changed`, SSE resumability
  (`Last-Event-ID`), the HTTP+SSE transport, and Roots / Sampling / Logging
  all go away or get deprecated. We implement none of them.

Two things shape the design. **Serve both revisions at once:** the spec's new
feature-lifecycle policy guarantees a minimum twelve-month deprecation window
and removes nothing inside it, so `initialize` keeps working for existing
clients — deleting it is the wrong move, and how to support both cleanly is
the question to settle first. And **the two standing rules still bind**: all
of this is pure protocol logic, so it lives at the TOP of the file with
`mcp.test.js` still loading without the pipeline (the file-layout rule), and a
richer inbound protocol is still the *client's* model choosing to call us —
invariant 1's ban on function calling inside the pipeline is untouched.

## Related

- **pipeline-architecture** — what `runPipeline` actually does (the phases
  the tool runs).
- **model-routing.js** / **billing.js** — the split-routing and split-billing
  math this server shares verbatim with `chat.js` (leaf modules; don't fork
  them).
- **chat-logs** — MCP calls log to the same interaction log on channel
  `mcp` (status `ok` / `error` / `disconnected`).
- **access-control** — the identity gate `/mcp` sits behind and the quota
  model it enforces.
