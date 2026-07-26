---
name: mcp-server
description: >-
  Load when working on the MCP server surface — the site exposed AS a tool
  other agents (Claude, Cursor, any MCP client) can call — or when touching
  src/mcp.js, the POST /mcp route, the deep_research tool, its input schema,
  the JSON-RPC 2.0 / Streamable-HTTP protocol handling (initialize /
  tools/list / tools/call / notifications/initialized), or debugging an MCP
  client that can't connect or call the tool. Covers the file-layout rule
  (pure protocol helpers static, pipeline dynamic-imported), how a tool call
  reuses chat.js's per-request setup (quota gate, model routing, usage/billing
  recording), how to add or change a tool, the shared seams
  (model-routing.js, billing.js), and the validation ladder (mcp.test.js →
  live JSON-RPC probe).
---

# The MCP server — DeepResearch as a tool (`POST /mcp`)

## What this is and why it exists

`src/mcp.js` exposes the whole deep-research pipeline **as an MCP server**.
Its headline tool is `deep_research` — question in, cited/validated/
source-diverse answer out — callable by any MCP client (Claude, Cursor, an
agent SDK). Alongside it the server re-exposes DistillSDK's four **manifest
tools** (`sdk_list_modules`, `sdk_show_module`, `sdk_plan`, `sdk_validate`,
via `SDK_MCP_TOOLS`) so an external agent can plan against the SDK without
shelling into the execution sandbox. Five tools total; the pipeline one is
the reason the server exists.
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
- `tools/list` → `toolsListResult()` (`DEEP_RESEARCH_TOOL` + `SDK_MCP_TOOLS`)
- `tools/call` → `handleToolCall()` → `runDeepResearch()`
- `notifications/initialized` → no-op ack (a notification has no `id`, so it
  returns no response body)

The route is wired in `src/index.js` (`if (url.pathname === "/mcp" &&
request.method === "POST")` → `handleMcp(...)`) **AFTER the identity gate**,
so MCP inherits the SAME access control as the rest of the site: break-glass
Basic Auth via header works, a signed-in session works too.

## The load-bearing file-layout rule

`src/mcp.test.js` must unit-test the protocol **without loading the
pipeline**. So the module is split by import weight:

- **Top of file — PURE, statically importable:** `parseJsonRpc`, the
  envelope builders (`jsonRpcResult`, `jsonRpcError`, `toolResult`),
  `initializeResult`, `toolsListResult`, the RPC error-code constants, and
  `DEEP_RESEARCH_TOOL` (the tool schema). The only static imports are leaf
  modules: `http.js` (`jsonResponse`) and `model-routing.js`
  (`resolveJsonModel`) — neither pulls the pipeline graph in.
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
- **Add ANOTHER tool:** add its schema constant at the top, return it from
  `toolsListResult()`, and branch on `parsed.params.name` in
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

1. **Unit** — `node --test src/mcp.test.js`: the pure protocol helpers
   (parse/envelope/initialize/tools-list/tool-result) and the
   loads-without-the-pipeline guarantee. `npm run typecheck` (the file is
   `// @ts-check`).
2. **Live JSON-RPC probe** against the deployed site (break-glass Basic
   Auth header). Sanity sequence: `initialize` → `tools/list` (expect
   `deep_research` + the four `sdk_*` tools, with schemas) → `tools/call` with a cheap
   `{question, time_budget_s: 15}` and confirm a cited answer comes back
   and the spend lands in the usage totals. See the **live-verify** skill
   for `wrangler tail` / `x-request-id` correlation and the **access-control**
   skill for the Basic Auth credentials.
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
