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
  host, its BARE-ORIGIN advertised URL (https://mcp.deepresearch.se, no /mcp
  tail — the form to hand out since 2026-08-03) and its public setup page
  public/connect/, and the per-account EXPOSURE
  configuration behind Settings → "MCP server" (src/mcp-config.js,
  src/mcp-api.js, public/js/account-mcp.js, /api/mcp/config + /api/mcp/key) —
  which tools an account exposes, the research defaults, and the override
  policy. Covers the file-layout rule (pure protocol helpers static, pipeline
  dynamic-imported), the catalog⇔tool-list mirror test, how a tool call reuses
  chat.js's per-request setup (quota gate, model routing, usage/billing
  recording), how to add or change a tool, the shared seams
  (model-routing.js, billing.js), the validation ladder, and debugging an MCP
  client that can't connect or whose tool call is refused. ALSO the go-to for
  the CUSTOM CONNECTOR on claude.ai and ChatGPT and the MOBILE question —
  "my connector won't connect", "connect it from my phone", "add it as a
  connector on claude.ai / in ChatGPT", "why is this terminal-only", the
  consent screen, OAuth/DCR/CIMD, PKCE, a WWW-Authenticate handshake, a
  redirect_uri that is refused, invalid_grant on refresh, or the ChatGPT-only
  `search`/`fetch` tools: the authorization server is BUILT (2026-08-03,
  src/oauth-metadata.js + src/oauth-store.js + src/oauth-authorize.js +
  src/oauth-token.js, F-20) and the full spec is docs/MCP-CONNECTOR.md.
---

# The MCP server — DeepResearch as a tool (`POST /mcp`)

## What this is and why it exists

`src/mcp.js` exposes the whole deep-research pipeline **as an MCP server**.
Its headline tool is `deep_research` — question in, cited/validated/
source-diverse answer out — callable by any MCP client (Claude, Cursor, an
agent SDK). Alongside it the server re-exposes four more families: the four
**literature tools** (`literature_search`, `literature_fetch`,
`literature_similar`, `literature_corpora`, via `LITERATURE_MCP_TOOLS` over
`src/literature-tools.js` + `src/literature-run.js`) that hand an agent the
two hosted scientific corpora directly — see the section below, it is the
family with the most surface; the two OpenAI **adapter tools** `search` and
`fetch`, which ChatGPT demands by name; and the six **extension tools** —
`street_view_look`, `place_nearby` and the host-intelligence family
`host_intel` / `host_search` / `domain_intel` / `cve_intel` (via
`EXTENSION_MCP_TOOLS` over `src/extension-tools.js`) — the only ones here that
reach a third party on the caller's behalf; and the three **platform tools**
(below) that point the pipeline at this codebase. Sixteen tools total; the
pipeline one is the reason the server exists.

**THE SURFACE IS SHAPED FOR CALLERS WITHOUT A SCREEN (owner directive,
2026-08-15).** That is the rule to apply to any proposed tool now: a voice client
reads the result aloud, so a tool whose answer is a file tree, a URL list or a
table has no way to land. It is why the four DistillSDK manifest tools
(`sdk_list_modules`, `sdk_show_module`, `sdk_plan`, `sdk_validate`) were REMOVED
in that change — they answered in build plans, with a build to run afterwards —
and why the three that replaced them return spoken prose and nothing else. The
CLI (`node sdk/pair-cli.mjs list|show|plan|validate`) and Agent Studio still
drive the same pure core, so nothing was lost; re-exposing them is a one-entry
change if an external planner ever asks.

A six-tool family for a browser-and-chat surface lived here from 2026-07-30
and was **removed on 2026-08-02 by owner directive**. Worth knowing as a
precedent for what belongs on this surface: a tool earns its place when a
caller WITHOUT a browser needs the answer. That surface already answered in
plain language in the chat and served its data over a plain GET endpoint — so
the six tools were paying for schemas, an exposure switch each and a
mirror-test row against a caller nobody could name. Deleting a tool family is
cheap here; adding one that nothing calls is the expensive mistake.

Every family splits the same way rather than breaking the file-layout rule:
schemas pure and statically imported, anything touching a binding, a provider or
the network behind a dynamic `import()` inside `tools/call`. `literature-tools.js`
⇄ `literature-run.js` is the original; `extension-tools.js` ⇄
`extension-tools-run.js` is the same cut, with one extra constraint — the
registry may name a service and **`src/mcp.js` may not** (invariant 7; it is in
`extensions.test.js`'s `CORE_MODULES`, and the guard reads code, so even a tool
DESCRIPTION naming Shodan inside `mcp.js` fails the build). Every family fails into an `isError` result rather than a
transport error, and `literature_*` degrades junk arguments to a described
default: a tool that throws is a model that retries the same call forever.
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
  `SERVER_INFO`, `capabilities: { tools: {} }`) — the HANDSHAKE era
- `server/discover` → `discoverResult()` — the STATELESS era's replacement for it
- `tools/list` → `toolsListResult(config)` (`ALL_MCP_TOOLS` = `DEEP_RESEARCH_TOOL`
  + `LITERATURE_MCP_TOOLS` + `OPENAI_MCP_TOOLS` + `PLATFORM_MCP_TOOLS`
  + `EXTENSION_MCP_TOOLS`, filtered
  by the account's exposure config)
- `tools/call` → `handleToolCall()` → `runDeepResearch()` / a family runner
- `notifications/initialized` → no-op ack (a notification has no `id`, so it
  returns no response body)

Both revisions are served side by side and the era is decided PER REQUEST — see
"Two revisions, one endpoint" below, which replaced the old forecast section.

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

Same Worker, same code path. **On that host the advertised URL is the BARE
ORIGIN** — `https://mcp.deepresearch.se`, no `/mcp` tail (owner directive
2026-08-03; `mcpEndpointUrl` in `src/mcp-api.js` is what the Settings screen
and the `claude mcp add` line render). Both forms answer and always have
(`isMcpEndpoint` takes `/mcp` on any host plus the bare origin on this one),
so this changed what we TELL people, not what works. Hand out the bare origin
because it is the shortest URL a client cannot get wrong: clients disagree
about whether the configured URL includes the path, a wrong-URL 404 is the
commonest way an MCP setup fails, and on this host neither convention misses.
It also matters for a claude.ai connector: the protected-resource metadata's
`resource` field must match the URL the user TYPED, character for character,
and only one canonical advertised form makes that matchable. And the host
serves exactly one thing, so `mcp.deepresearch.se/mcp` states it twice. A
preview or local deploy keeps the path — there the bare origin is the app and
only `/mcp` is the endpoint. A `GET` on the dedicated host serves the public
setup page `public/connect/` (allowlisted in `src/assets.js`).
`src/canonical.js` leaves the host alone: it only rewrites `http` → `https`
and strips `www.`.

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
   Berget + Exa money. It **fails CLOSED** when it cannot decide (a D1 error
   reading the config row or the usage windows) — see the fail-direction note
   below.
5. Run `runPipeline`, collect the streamed answer into one string, append
   the Sources list (`withSources`).
6. **Record usage** (`recordUsage`) with the split-billing totals
   (`summarizeSpend` / `exaCost` from the shared `billing.js`) so MCP spend
   shows up in the usage bars and admin cost totals just like chat spend —
   plus `denseSpend`, the fourth bucket (2026-08-05): the search wave can
   reach the hosted arXiv/PubMed indexes, and those tokens are Berget money
   that no chat catalog can price. Added into the SAME row, never a second
   one. `docs/MCP-COST.md` §4d.

The tool's input schema (`DEEP_RESEARCH_TOOL.inputSchema`): required
`question`; optional `time_budget_s` (default 120, clamped 15–600), `model`
(Berget id; JSON phases stay on the reliable model regardless), `web_search`
(default true; false = answer directly, no search provider contacted),
`agent`, and `style`.

`agent` picks WHICH SPECIALIST answers: `scholar` (Deep Science, the default),
`cyber`, `palaeogenomics`, `introspection`, `outrospection`, `models`. It is
resolved by `resolveMcpAgent` through the same registry and grant chain
`chat.js` uses, so the account's own extension knobs still gate what the agent
may reach. An unknown id, a missing grant or an unreadable registry all fall
back to the default agent-less run rather than failing a call the caller is
paying for (invariant 2); Agent Studio and Orchestrator are the one case that
is refused out loud (`MCP_AGENT_PHASES`), because they build and orchestrate
instead of answering, and both are long side-effecting flows that need the app.

`style` is `text` (default) or `voice`. `voice` returns speakable prose: no
markdown, no `[n]` markers, no URLs, sources named in a closing sentence. It
also lowers the DEFAULT budget to `MCP_VOICE_BUDGET_DEFAULT` = 60 s
(`src/mcp-config.js`), because two minutes of silence ends a voice session. A
budget the caller names wins in either style.

## The platform family — this server asked about itself (2026-08-16)

Three tools that point the pipeline at THIS codebase instead of at the world:
**`explain_internals`** (how a part of the platform works), **`improvement_areas`**
(where it has room to improve) and **`platform_map`** (what is there to ask about
at all — free, contacts nothing). Schemas and lens notes in the pure
`src/platform-tools.js`; the map's runner in `src/platform-tools-run.js` behind
the usual dynamic import.

**The capability already existed and the ROUTING did not, and that distinction
is the whole justification.** `deep_research` has taken an `agent` since
2026-08-15, and `introspection` is one of the ids it resolves — so a caller who
knew to pass it already got exactly this. Nobody does. A voice caller asks "how
does the research pipeline actually work" into a phone, the client's model picks
`deep_research` with no `agent`, and that resolves to Deep Science, the terminal
fallback (2026-08-13) — which answers about deep research as a FIELD, from the
peer-reviewed literature, fluently, with citations, about somebody else's work.
Nothing errors and nothing looks wrong. **A model routes on tool NAMES far more
reliably than on an optional enum it has to know exists**, which is why this is
three names rather than a better-worded `agent` description.

Four things about the shape, each of which will look like something to tidy:

1. **The two answering tools have no runner, on purpose.** They fall through to
   the same `runDeepResearch` `deep_research` uses, with their arguments forced
   by `resolveIntrospectArgs` (`src/mcp-config.js`) — introspection agent,
   `web_search: false`, `style` defaulting to voice. They ARE the research
   pipeline with a lens, so a runner of their own would mean a second copy of
   the quota gate, the billing, the progress plumbing and the `chat_logs` write:
   four things that must not be able to disagree with the ones deep_research
   uses. The shared tail is `runResearchToolCall`.
2. **The lens note does two jobs, and the second is easy to break.** It is
   appended to the question (never substituted — the caller's words reach the
   model as written), so it instructs the model AND steers retrieval, because
   the introspection enrichment embeds the last user turn and the note is part
   of it. That is why the notes are short and why their vocabulary is chosen:
   lengthen one and the query vector dilutes and the retrieved code gets worse.
   Pinned by a length assertion in `src/platform-tools.test.js`.
3. **`improvement_areas` carries the settled-negative rule, and it is the
   load-bearing sentence in the family.** Several subsystems here keep a
   register of experiments already run, measured and rejected — the pygram
   skill's §2d ("compiler optimisation is FINISHED here — do not re-survey it")
   is the clearest — written down precisely so nobody spends another session on
   them. An improvement answer that reads one of those back as an opportunity is
   a confident instruction to redo finished work, and **a listener has no way to
   see that the source said the opposite**. So the lens asks for the
   distinction explicitly, and the words it uses are also what pull those
   sections into retrieval.
4. **`web_search` is forced off and cannot be switched back on.** The
   introspection agent declares no web leg anyway, and the pipeline's
   introspection-first routing (`pipeline.js runResearch`, `ctx.hasSource`)
   already suppresses the wave — but forcing it here makes the tool cheap and
   keeps out the failure that routing exists to prevent: a search wave for "deep
   research" pulls in unrelated third-party repos that share the name and
   presents them as sources. A caller wanting outside material has
   `deep_research`.

**Why `platform_map` earns a slot on a surface that deletes tools.** It is the
`literature_corpora` argument, and it is the same failure: an agent that cannot
check what exists concludes that whatever it asked about does not. Ask about a
subsystem under a name this repo does not use, get nothing, and the client's
model reports that the platform lacks it. So the map is free (committed
artifacts, no provider, no quota — it holds no concurrency slot either, since one
held there could only deny the caller its own next call), it is derived rather
than curated (top-level areas come from paths that EXIST; a hand-written list
would go stale silently), and **a miss says so out loud**: "that does not mean
the platform lacks it — ask the question directly and the source gets read."

Everything is spoken rather than rendered — no markdown, counts agreeing with
their nouns, slugs said as words, and list items joined with "with" rather than a
second comma, because the list separator is already a comma and a listener cannot
hear where one item ends. Those are not cosmetic: `1 files` was a real bug the
suite caught, and on this surface nobody can see the original to correct it.

Validation: `node --test src/platform-tools.test.js src/platform-dispatch.test.js
src/mcp.test.js src/mcp-config.test.js src/mcp-inflight.test.js`. The dispatch
suite drives the real `handleMcp` and pins the thing unit tests structurally
cannot — that every LISTED tool has a branch behind it. A name in
`ALL_MCP_TOOLS` with no dispatch answers "Unknown tool" to a client that just
read it off the listing, which is the most confusing failure this surface can
produce. The two answering tools are observed at their hand-off to the pipeline
by giving the env no `BERGET_API_TOKEN`: the refusal lands after argument
resolution and before any spend, so the test proves the routing and costs
nothing.

## The literature family — the corpora as knowledge bases (2026-08-01)

`deep_research` answers a question. The literature tools hand an agent the
**corpus** and let it do the research itself: `docs/ARXIV-RAG.md`'s 772,658
arXiv vectors and `docs/PUBMED-RAG.md`'s 1,638,756 PubMed vectors, previously
reachable only from inside the pipeline's own search wave.

- **`literature_search`** — dense retrieval, structured records out (id, url,
  title, authors[], date, category/journal, abstract, cross-encoder score).
  Takes **`queries`: up to 6 angles** run in parallel across both corpora, and
  **`authors`** — which does not use the corpora at all (see below).
- **`literature_fetch`** — exact records by arXiv id / PMID, mixed in one call
  (URLs and prefixed forms accepted). How an agent follows a citation.
- **`literature_similar`** — more-like-this from a known paper.
- **`literature_corpora`** — live vector counts, coverage windows, stored
  fields, retrieval semantics. Contacts nothing.

### The author leg — the question the corpora cannot answer (2026-08-05)

**`authors` on `literature_search` does not search the hosted indexes.** It
queries the LIVE Europe PMC (`AUTH:"Surname I"`) and arXiv (`au:`) author
fields. That is not a shortcut; it is the only thing that works, and the reason
is worth keeping because it will look like a bug later:

1. **Dense retrieval cannot match authorship.** A personal name embeds as the
   TOPICS it co-occurs with, so "Elsa Ekström's papers" retrieves ancient-DNA
   papers by other people. Always. This is not a tuning problem.
2. **There is no metadata index**, so no `authors CONTAINS` filter can be
   pushed into the query even in principle (same root as `FILTER_NOTE`).
3. **The stored author string was cut from the FRONT** — `slice(0, 8)` in both
   indexers. In the life sciences the senior author is LAST, so a 40-author
   genomics paper stored the eight people least likely to be asked about. Fixed
   at the source (`storedAuthors` in `public/js/arxiv-rag-core.js` keeps head
   AND tail), but **the ~2.4M vectors already in Vectorize keep the old string
   until a re-upsert** — don't claim otherwise when reading a live record.

The trigger was a real report: a user connected the MCP server to Claude and
asked for a named palaeogeneticist's body of work. `search` answered
`{"results":[]}`, `literature_search` answered with other people's ancient-DNA
papers, and the client model concluded the corpus was empty and stopped. The
user reported it as "Claude never searched" — which is what silence looks like
from outside. The papers were there the whole time; only the name was missing.

Three things follow from that, and each is load-bearing:

- **Both sort orders are fetched and interleaved** (`CITED desc` +
  `P_PDATE_D desc`). Citation order is what makes a *body of work* question
  answerable — the top of a cited list is what someone is known for. Recency
  alone answers a different question.
- **Names are not disambiguated, and the response says so.** Europe PMC's ORCID
  field is too thinly populated to use (checked on the records in question:
  absent), and `AUTH:"Ekström E"` genuinely mixes a palaeogeneticist with a
  paediatric-nutrition researcher. The lever that works is `queries` passed
  alongside — the subject terms are ANDed onto the author query, which took a
  live probe from 243 mixed records to 115 clean ones (2026-08-05).
- **`search` no longer returns a bare `[]`.** OpenAI's contract fixes the
  `results` key, not the whole object, so an empty result now carries a `note`
  naming the three things that read as empty here and are not empty in the
  literature: a topic outside the corpus windows, an authorship question, and a
  query stripped to keywords. An unexplained empty is the failure mode that
  ended the reported session.

`authors` is valid **with no `queries` at all** — that is the shape the hosted
index cannot serve, so refusing it for having no query was refusing the whole
question. The leg is fired before the embed and awaited after the dense
retrievals, so its latency overlaps rather than adds; and it is an enrichment
in invariant 2's sense, so a dead live API degrades the response to its dense
half and a dead embedder degrades it to the author records.

The bilingual gate (`authorIntent`) reads a name out of the query when no
`authors` is passed. Invariant 6 applies in full, and two traps are pinned in
`src/literature-authors.test.js`: the possessive forms MIX languages (the report
was literally "elsa ekströms life works" — Swedish genitive, English noun), and a
bare `s` genitive is ambiguous in English, so only nouns that cannot follow
anything but a person are accepted after it, or "mammoth genomics studies"
reads as a researcher named Mammoth Genomic.

**The speed is the batching, and it is the point.** One `embedTexts` call
covers every angle (`dense-rag.js`'s `embedQueries`), then every
(angle × corpus) pair retrieves concurrently through `denseRetrieve`. Six
angles over both corpora is *one embed plus twelve overlapping retrievals*,
not twelve searches. Concurrency is capped at `RETRIEVAL_POOL` = 5 on purpose:
a Worker holds only a handful of simultaneous outbound connections, and a
QUEUED fetch still counts down the 6 s `AbortSignal` it was constructed with —
so an unbounded fan-out is not faster, it is a batch of timeouts.

**Measured, so quote these rather than the intuition** (production, warm,
median of 3, 2026-08-02):

| shape | legs | median |
|---|---|---|
| 1 angle × both corpora | 2 | 814 ms |
| 3 angles × both corpora | 6 | 1290 ms |
| 6 angles × arXiv only | 6 | 1180 ms |
| 6 angles × both corpora | 12 | **1690 ms** |

Six angles cost 2.1× one angle, so serial (~4.9 s) is **2–3×** the batch:
2.9× against these medians, 2.1× on a single-shot run of the probe's own
check minutes later. Quote the range, not either endpoint — one sample over
the open internet does not distinguish them. A factor of two or three, not
the order of magnitude the code's shape suggests; the first estimate written
into the module header claimed "a couple of seconds against most of a
minute", which was wrong. The flat 6→12 leg step also says the pool is not
the binding constraint at this size, so raising it is not the lever it looks
like.

> **The probe's own first number was 1.4×, and it was measuring the wrong
> thing.** It timed the batch inside `search-batch` — the first call in the run
> to touch the PubMed index, cold — against a serial loop that ran afterwards,
> warm. Cold-vs-warm dressed as batched-vs-serial. Both legs are now timed in
> `batch-speedup` after a warm-up. A benchmark whose ordering biases the result
> is worse than none: it reports a real number for a comparison nobody meant to
> make.

Four things about this surface are load-bearing and easy to get wrong later:

1. **The file-layout rule is preserved by a split, not an exception.**
   `src/literature-tools.js` imports **nothing** (schemas, parsing, mappers,
   filters, formatting) and is a static import; `src/literature-run.js` holds
   every call that touches a binding or Berget and is loaded by a dynamic
   `import()` inside `tools/call`. `mcp.test.js` pins both halves — merging
   the two modules is the natural "simplification" and it breaks the suite.
2. **There is no server-side metadata filtering, and the response says so.**
   Neither index carries a Vectorize metadata index, so `since` / `until` /
   `categories` / `journals` are applied to the reranked candidate pool AFTER
   retrieval. A narrow filter can return nothing while the corpus holds
   hundreds of matches. `min_score` is the exception — it REPLACES the
   relevance floor during retrieval, so a strict bound returns a full set of
   strong matches instead of the survivors of an already-cut list. Adding a
   real filter means `wrangler vectorize create-metadata-index` plus a
   re-upsert of ~2.4 M vectors; don't imply it works until that happens.
3. **Coverage windows travel with every answer.** arXiv starts at submission
   month 2310; PubMed is a PMID/load-order slice, not "recent PubMed". Both
   are in `CORPUS_FACTS`, quoted on every miss, and `literature_corpora`
   exists so an agent checks before concluding the literature is silent.
   Abstracts are stored cut at **900 chars** (`abstract_cut: true` says so),
   and there is **no full text** at runtime — that lives only in
   `scripts/arxiv-fulltext.mjs`, offline.
4. **Quota, but only where money moves.** `literature_search` and
   `literature_similar` go through `researchQuotaBlock` — the same four-window
   gate `/api/chat` and `deep_research` enforce, extracted into a shared helper
   in the same change. `literature_fetch` (a key read) and `literature_corpora`
   (committed facts + `describe()`) are deliberately OUTSIDE it: an agent that
   has run out of budget should still be able to resolve an id it was handed
   and learn what exists. **The METER matches the gate exactly** (2026-08-05):
   `runLiteratureTool` records the retrieval's spend in a `finally`, and the
   same two tools that skip the gate leave the accumulator at zero and so
   write no row. A gate without a meter cannot bite — that is precisely the
   defect this closed. Unlike `deep_research` these calls write no
   `chat_logs` row — a retrieval is not an interaction to log, and the query
   text stays out of Workers Logs (only counts are logged, as the dense tiers
   already do).

Validation for a change here: `node --test src/literature-tools.test.js
src/literature-run.test.js src/mcp.test.js src/arxiv-rag.test.js`. The run
suite drives the real code against a fake Vectorize binding and a stubbed
Berget, and it is where the batching (one embed for six angles), the
fail-soft legs, the floor, and the honest miss are pinned. Note the fake
deliberately scores its LAST candidate below the floor, so a test that wants
*n* results needs *n+1* rows.

## A long call must not go silent (progress over SSE, 2026-08-13)

`deep_research` runs for as long as its budget allows — 120 s by default, up to
600 s. Until 2026-08-13 the whole of that was ONE buffered JSON response: not a
byte left the Worker between the POST and the finished answer. That is what a
hung server looks like from the outside, and a client cannot tell the two
apart.

**The incident.** A voice session against `mcp.deepresearch.se` (Workers Logs,
2026-08-13 05:41–05:43): two `deep_research` calls, 86.5 s and 50.5 s of wall
time, **both `status: ok`** with `mcp.complete` logged and full answers written
to `chat_logs` (#1725, #1726). The user's side never got them — the question
"just got stuck". Seconds after the second one returned, the connector POSTed a
fresh `initialize` + two `tools/list`: a reconnect, which is what a client does
after it has given up on a connection. `scripts/chatlogs --errors` was empty and
`mcp.tool_failed` never fired, because nothing failed HERE. **When a user
reports a stuck MCP call and the server says `ok`, stop looking for a server
error and start looking at how long the caller sat in silence.**

**The fix is a transport wrapper, not a pipeline change.** Streamable HTTP lets
the server answer a POSTed request with `text/event-stream` and send
notifications before the response (spec 2025-06-18, Transports §"Sending
Messages to the Server" 5–6), and the timeout rule says a client MAY reset its
timeout clock on a progress notification "as this implies that work is actually
happening". So `tools/call` — and only `tools/call`, the one method that can
run for minutes — is answered on a stream when the client's `Accept` includes
`text/event-stream`:

- `: keepalive` comment lines every `PROGRESS_INTERVAL_MS` (10 s), the same
  trick `/api/chat` uses, which keep the CONNECTION from idling out;
- `notifications/progress` on the same tick, carrying the pipeline's current
  `step_start` label and elapsed seconds ("Searching the web (35s)") — the half
  a client's timeout can read;
- the JSON-RPC response as the last frame, then close.

Four things about the shape are load-bearing:

1. **Progress notifications only when the caller sent a `progressToken`.** The
   spec forbids referencing a token that was never provided, so no token means
   keepalives and nothing else. Never invent one.
2. **`progress` MUST increase every time**, so it counts TICKS, not seconds —
   two notifications inside one second would otherwise repeat a value. No
   `total` is sent: the time budget bounds the research, not the call, and a
   bar that stalls at 100% is worse than no bar.
3. **The envelopes are untouched.** `run` is the same `handleToolCall` the JSON
   path calls and its Response is unwrapped and re-emitted, so a tool-level
   failure, a quota refusal and a concurrency refusal all still arrive as the
   `isError` results they always were. A client that does not accept SSE gets
   the buffered JSON byte for byte.
4. **`initialize` and `tools/list` stay plain JSON.** They answer in
   milliseconds; streaming them buys nothing and risks a client that reads the
   body as JSON.

Pinned by `src/mcp-progress.test.js`, which drives the real `handleMcp` with a
fake index that hangs until the test releases it plus `node:test`'s timer mocks
— so the ticking is exercised without waiting 10 s per tick.

**What this does NOT fix**, and is the next thing to measure if a stuck call is
reported again: the answer still arrives in one frame at the end. A client whose
ceiling is a HARD wall-clock limit rather than an idle timeout will still cut a
600 s call. If that turns up, the answer is streaming the synthesis text itself,
which is a protocol question (MCP has no partial-result shape on `tools/call`),
not another keepalive.

## Adding or changing a tool

- **Change the deep_research schema:** edit `DEEP_RESEARCH_TOOL` at the top,
  read the new arg in `runDeepResearch` with a fail-soft default, and update
  the `tools/list` assertion in `mcp.test.js`. Keep descriptions written for
  an LLM caller (they're what the client model sees).
- **Add ANOTHER tool:** add its schema constant at the top (or in a pure schema
  module, if it is a family), put it in `ALL_MCP_TOOLS`, add its
  `MCP_TOOL_CATALOG` entry in `src/mcp-config.js` **in the same change** (the
  mirror test fails otherwise — and an account needs a way to switch it off),
  decide whether it belongs in `SPENDING_TOOL_NAMES` (does it reach a provider?
  then yes — it holds a concurrency slot and goes behind `researchQuotaBlock`),
  and branch on `parsed.params.name` in `dispatchToolCall` — which dispatches the
  extension families by `EXTENSION_TOOL_NAMES` membership, the literature family
  and its adapters, and the free platform tool `platform_map`, before falling
  through to `deep_research`; anything matching none of them is
  method-not-found. A family does not have to bring a runner: the two ANSWERING
  platform tools fall through to `deep_research` itself with their arguments
  forced by `resolveIntrospectArgs` and the shared tail `runResearchToolCall`,
  which is the cheapest way to add a tool that IS the pipeline pointed somewhere
  new — one gate, one meter, one log row, no second copy to drift. Any heavy work its handler needs stays behind a dynamic
  import. Two questions to answer before writing any of it: does it belong here
  at all (the roadmap's thesis is a few high-leverage tools, not a tool zoo), and
  **can a caller with no screen use its answer** (the 2026-08-15 directive — that
  is what the four `sdk_*` tools failed).
- **A tool that reaches a THIRD PARTY is not added here at all.** It goes in
  `src/extension-tools.js` as an entry on its integration's family, with its
  schemas in a pure module and its runner in `extension-tools-run.js`. Three
  things follow automatically and none of them should be hand-rolled: `mcp.js`
  never learns the service's name (invariant 7's core-purity guard), the catalog
  row appears in Settings, and the call is gated on the account's per-extension
  KNOB as well as the exposure switch. Those two gates mean different things —
  the switch says whether the tool exists on this surface, the knob is the
  account's consent to reach that third party — and only the switch filters
  `tools/list`, deliberately: a caller should be able to SEE the capability and
  be told why it is unavailable rather than have it vanish.
- **Never** introduce model-driven tool *selection* on the inbound side —
  that's the exact function-calling shape invariant 1 rules out. The MCP
  client's model chooses to call `deep_research`; inside, orchestration
  stays deterministic.

## Validation ladder

1. **Unit** — `node --test src/mcp.test.js src/mcp-config.test.js
   src/mcp-key.test.js src/mcp-api.test.js src/mcp-inflight.test.js`: the
   pure protocol helpers and
   the loads-without-the-pipeline guarantee; the catalog⇔tool-list mirror
   and the argument resolution; the key's crypto, the not-a-login pin and
   the cross-family forgery matrix; key resolution (revoked / rotated /
   disabled account / surface off) and the config endpoints; the concurrency
   reservation's take/release lifecycle and its JSON-RPC refusal.
   `npm run typecheck` (all four are `// @ts-check`).
2. **Live JSON-RPC probe** — `npm run mcp:probe` (`scripts/mcp-probe.mjs`),
   which is this rung, automated. Dependency-free, exit code = failure count.

   ```bash
   BASIC_AUTH_USER=… BASIC_AUTH_PASS=… npm run mcp:probe   # zero setup
   MCP_KEY=mck1.… npm run mcp:probe                        # the external-client path
   npm run mcp:probe -- --deep --json                      # also run deep_research
   ```

   It covers the protocol (`initialize`, the 202 notification ack, `tools/list`
   against `ALL_MCP_TOOLS` in order, `-32601`/`-32700`/`-32602`), the whole
   literature family end to end (`literature_corpora` live vector counts →
   `search-one` → a 6-angle batch → `fetch` round-tripping an id the search
   just returned → `similar` → the post-retrieval filter disclosure), and it
   MEASURES the batching claim: the same six angles batched against six
   separate calls, failing only if batching is slower. Its assertions are
   unit-tested in `scripts/mcp-probe.test.mjs`, because a probe whose checks
   are only exercised live is one nobody can trust when it goes red.

   **Know what a green run did not cover.** The report ends with an explicit
   gap list. Break-glass Basic exercises the tool battery but NOT
   `resolveMcpKeyIdentity` (it satisfies `identify()` instead) and NOT the
   quota gate (`isSecretAdmin` is exempt); only `MCP_KEY` covers those. And
   break-glass **cannot mint a key** — `requireAccount` rejects an identity
   with no D1 row, which break-glass is by construction, so the key has to come
   from a signed-in account at Settings → MCP server.

   > Its first live run (2026-08-01) found a real defect: an unauthenticated
   > POST to `/mcp` fell through to the identity gate and returned the sign-in
   > **HTML** at 401. The refused-KEY branch above the gate already answered
   > JSON-RPC; the no-credential case — the commoner one, a key forgotten or an
   > authorization header a proxy stripped — did not, so a misconfigured client
   > reported a transport failure and its user never saw "authenticate". Fixed
   > in `src/index.js`, pinned in `src/index.test.js`.

   **Two negatives the probe cannot automate**, because both need account
   access it does not have: revoke the key and confirm the next call is a 401
   JSON-RPC error rather than HTML, and switch a tool off and confirm it
   vanishes from `tools/list` AND is refused on `tools/call`. Do those by hand
   after any change to `mcp-key.js` or `mcp-config.js`. See the **live-verify**
   skill for `wrangler tail` / `x-request-id` correlation and the
   **access-control** skill for the Basic Auth credentials.
   ```bash
   curl -sS https://mcp.deepresearch.se -H "content-type: application/json" \
     -H "Authorization: Bearer $MCP_KEY" \
     -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
   ```
3. If the change touched the pipeline path, the pipeline's own checks apply
   — see **pipeline-architecture**.

## Reaching a phone — the OAuth connector (F-20, BUILT 2026-08-03)

Every way in above needs a terminal. `claude mcp add` writes Claude Code's own
configuration, which the Claude mobile app never reads, and a phone has
nowhere to paste that line anyway. The fix is being addable as a **custom
connector**: claude.ai on the web, Claude Desktop, Claude mobile and Cowork
share ONE connector infrastructure, so a connector added once *by URL* appears
on all of them, and ChatGPT's dialog works the same way. Transport was already
right — a connector is a remote MCP server over Streamable HTTP on a public
host, which is what `src/mcp.js` serves. The gap was auth, and that is what
got built.

Full spec, vendor requirements and the by-hand walkthrough:
**`docs/MCP-CONNECTOR.md`** (§4 what exists, §4a how to verify it, §2/§2a what
Claude and ChatGPT each demand). What follows is what a session needs to
reason about — and debug — the surface without opening it.

**The modules.** `src/oauth-metadata.js` (pure leaf: both discovery
documents, the redirect allowlist, `issuerFor`), `src/oauth-store.js` (the
`oac1.` code / `oat1.` access / `ort1.` refresh families, D1 rows for the two
that need single use and rotation), `src/oauth-authorize.js` (consent + code
issuance; needs a signed-in identity, and the CIMD document it fetches for the
client's display name degrades to the hostname rather than failing the
connection), `src/oauth-token.js` (`POST /oauth/token`, form-urlencoded, RFC
6749 errors). The access token resolves beside `mck1.` in
`resolveMcpKeyIdentity`, so exposure config, quota, billing and the
`chat_logs` row apply unchanged — and the not-a-login pin extends to it
verbatim.

**The endpoints, and which host serves them.** The split is the thing to
remember: the resource server is the MCP host, the authorization server is the
apex (that is where the account, Google sign-in and the session cookie live,
and where a consent screen reads as this site).

| Host | Path | Public? |
|---|---|---|
| `mcp.deepresearch.se` | `/.well-known/oauth-protected-resource` | yes |
| `mcp.deepresearch.se` | the existing `401`, now carrying `WWW-Authenticate` | — |
| `deepresearch.se` | `/.well-known/oauth-authorization-server` | yes |
| `deepresearch.se` | `/oauth/authorize` | no — needs a signed-in identity (otherwise a sign-in page) |
| `deepresearch.se` | `/oauth/token` | yes (a client has no credential yet) |

That is what production *advertises*. Both well-known documents actually
answer on any host, and `issuerFor` collapses to the request's own origin
off the `mcp.` host — which is what lets a preview or a local run drive the
whole flow without a second deployment.

**CIMD preferred, DCR built, and still no client storage.** The
authorization-server document advertises
`client_id_metadata_document_supported: true` **and** `"none"` in
`token_endpoint_auth_methods_supported`, so a capable client picks CIMD, where
the `client_id` is an HTTPS URL and there is nothing to store.

It ALSO advertises a `registration_endpoint` now, and that change is the fix
for the 2026-08-05 ChatGPT failure. Advertising CIMD alone left any client that
does not implement it with nowhere to obtain a `client_id` at all: the flow
died at discovery, before consent, and reached the user as the same generic
"couldn't connect" as everything else. `src/oauth-register.js` is RFC 7591, and
it keeps the property CIMD was chosen for by issuing a **signed stateless**
`client_id` (`orc1.`) that carries its own registration — so there is still no
client table. A registration cannot widen where a code may be sent: every
`redirect_uris` entry is checked against the same allowlist at registration and
again at use.

> **The old assertion was the bug's hiding place.** `oauth-metadata.test.js`
> pinned the ABSENCE of a `registration_endpoint`, and a second test pinned the
> resource path being DROPPED. Both were faithful to the design and both
> described a server ChatGPT cannot use. A test that pins an assumption makes
> it permanent — when a connector fails, suspect the pins before the code.

**The redirect allowlist is DATA** (`REDIRECT_ALLOWLIST` +
`redirectAllowed`): exact strings for Claude's
`https://claude.ai/api/mcp/auth_callback` and ChatGPT's two LEGACY callbacks,
plus the RFC 8252 port-agnostic loopback for Claude Code. A third client is an
entry, not a code change.

**ChatGPT's current callback is PER CONNECTOR and cannot be an entry** —
`https://chatgpt.com/connector/oauth/<callback_id>`, matched by shape in
`isChatgptConnectorRedirect`. This was the prime cause of the 2026-08-05
failure: the allowlist held only `…/connector_platform_oauth_redirect`, which
OpenAI keeps working for apps *already published*, so a connector added today
sent a URL nothing could match and got a rendered refusal. The pattern is
bounded like the loopback one is (exact origin, the `/connector/oauth/` prefix,
exactly one id-shaped segment, no query or fragment, no userinfo) — a pattern
arm is a bigger promise than a string, so it is worth reading the negative
tests before widening it.

**For ChatGPT only:** it refuses any server without tools named literally
`search` and `fetch` (without developer mode, which is web-only and paid-tier,
so it is not an answer). Those are thin adapters over the hosted corpora
beside `literature_search`/`literature_fetch`, returning OpenAI's fixed shapes
both as `structuredContent` and as JSON-encoded content text. Consequence to
remember when reading a support report: **an account that switches `search`
off is an account ChatGPT will refuse to connect to.**

### Debugging a connector that won't connect

Both clients report nearly every failure as one unhelpful line ("Couldn't
reach the MCP server"), so work the handshake in order rather than guessing.
`docs/MCP-CONNECTOR.md` §4a is the same sequence with copy-pasteable `curl`.

1. **The `401` and its header — this is where it fails most.** An
   unauthenticated POST must answer **`401`** carrying
   `WWW-Authenticate: Bearer resource_metadata="…/.well-known/oauth-protected-resource"`.
   The status is part of the protocol: the same header on a `200` is ignored,
   and a `403`, a redirect to the sign-in page, or HTML instead of JSON all
   end the flow before OAuth starts. Check this first, always.
2. **`resource` must equal the URL the user typed**, character for character.
   Claude is handed the bare origin (`mcpEndpointUrl`) and ChatGPT's form is
   told to type `…/mcp` (`chatgptEndpointUrl`), so BOTH spellings are real and
   both are served: the origin document at `/.well-known/oauth-protected-resource`
   and the RFC 9728 §3.1 path-inserted one at `…/oauth-protected-resource/mcp`,
   each stating the resource it belongs to. The `401`'s pointer picks whichever
   matches the URL the request arrived on. Before 2026-08-05 only the origin
   document existed, so a ChatGPT user who followed OpenAI's own instructions
   got a mismatch and the client said nothing useful about why.
3. **`authorization_servers[0]` is the only entry read** — both clients take
   the first and never fall back. If it points somewhere that does not serve
   the RFC 8414 document, the flow dies there.
4. **A connector that sends the user to sign in and never comes back.** An
   authorization request needs a signed-in account, and until 2026-08-05 an
   unauthenticated arrival got the site's generic sign-in card while the Google
   callback hard-redirected to `/rver` — so the request, its PKCE challenge and
   the client's `state` were discarded and the popup waited forever. The tell is
   that it works for whoever is already signed in and fails for everyone else,
   which is precisely how it survived the first live run. `/oauth/authorize` now
   redirects into `/auth/google?next=…` and `src/google.js` resumes it; the log
   line is `login.resume`, and its absence during a failed connection means the
   return path regressed.

5. **A failure at the *last* click is ours, not the client's.** If the flow
   reaches the consent screen and **Connect** answers "This form was submitted
   from another site", read `docs/MCP-CONNECTOR.md` §4b before anything else:
   the consent page was served `Referrer-Policy: no-referrer`, which makes a
   browser send `Origin: null` on the page's OWN form POST (Fetch's
   append-a-request-`Origin`-header step reads the referrer policy for a
   non-CORS non-GET request), and the CSRF guard refused it. That is the whole
   of the first live run's failure, 2026-08-04. Fixed two ways — the pages are
   `same-origin` now, and a `null` origin is treated as opaque rather than
   foreign (`oauth.consent_opaque_origin`) — but the general lesson outlives
   it: **a security response header can disable the endpoint it protects**, and
   a unit suite that builds its own requests never notices, because every test
   here set `Origin` by hand. Drive the real form in a browser.
6. **A refused `redirect_uri` is LOGGED, deliberately.** An exact-match
   failure is the commonest reported ChatGPT connector problem and it is
   invisible from the outside, so the refused string goes to Workers Logs as
   **`oauth.redirect_refused`** (with `client_id`) — `wrangler tail | grep
   oauth.` while the user retries, and the answer is usually a callback URL a
   vendor changed. Fix = an entry in `REDIRECT_ALLOWLIST`. Neighbouring keys
   worth knowing: `oauth.authorize_rejected` (every other RFC 6749 error,
   which bounces to the client rather than rendering) and
   `oauth.consent_token_rejected` (an expired or wrong-account consent form —
   the user left the screen open, so tell them to start again from the
   client). A refused redirect renders a page and never a `Location`, on
   purpose: an unvalidated redirect target is what an open redirector is made
   of.
7. **`invalid_grant` on refresh is correct behaviour, not a bug**, if the
   refresh token was reused: rotation kills the old `jti` in the same call
   that mints the new one. What would be a bug is any *other* error code
   there — clients branch on `error`, and only `invalid_grant` makes a client
   re-authorize instead of retrying a dead token forever.
8. **Latency ceilings are real**: 10 s for discovery, registration and the
   initial token exchange, 30 s for a refresh. Past that the flow fails even
   if the request eventually completes, which reads as an intermittent
   connector.

**Acceptance is a live check on the phone, and it has NOT been run** (as of
2026-08-03): add the connector on claude.ai in a browser, complete consent,
call a tool, then open the mobile app and confirm the connector is there and
lists tools with no further setup — then the same on ChatGPT, which is also
what settles whether it accepts Streamable HTTP and whether its iOS app can
use a connector at all. No green unit suite implies any of it. Until then,
F-20 is `PARTIAL`.

### Where the instructions live, and the three URLs they hand out

Two surfaces carry the same guidance: the public page `public/connect/` and
the signed-in screen **Settings → MCP server** (`public/js/account-mcp.js`,
connector section added 2026-08-03). Both put the CONNECTOR first and the
`claude mcp add` terminal path second — it is the only route that works from a
phone and the only one needing no key, and both screens used to bury it. On
`/connect/` that was measured: 1,421 px down a 390 px viewport, now 369 px.

**Three URLs are in play and they are not interchangeable**, which is the
commonest way this setup fails:

| who | string | built by |
|---|---|---|
| Claude, Claude Code, everything else | the bare origin `https://mcp.deepresearch.se` | `mcpEndpointUrl` |
| ChatGPT's add-a-connector form | `…/mcp` — OpenAI's setup expects the path | `chatgptEndpointUrl` |
| the one-tap button | `claude.ai/customize/connectors?modal=add-custom-connector&…` | `claudeInstallUrl` |

All three live in `src/mcp-api.js` and travel in the `/api/mcp/config` payload
(`endpoint`, `chatgpt_endpoint`, `claude_install_url`), so a surface renders
them and never assembles them. All are derived from the request, so a preview
deploy advertises and prefills the preview.

**The vendor menu paths rot faster than anything else in this repo.** Both
Claude and ChatGPT renamed theirs inside six months (Settings → **Customize**;
Connectors → apps → **Plugins**, plus a Developer-mode switch under **Security
and login**), and the pages here printed the old ones until an owner tried them
and found nothing. **No test can catch this** — it is someone else's UI. So:
every path carries a source URL and a retrieval date in `docs/MCP-CONNECTOR.md`
§2d, and when a report says a path is gone, believe the report and re-read the
vendor's docs. §7's acceptance check verifies the SERVER connects, not that the
menus still exist.

**The stopgap is still there:** **`static_headers`** in Claude's
Add-connector dialog takes a fixed `authorization: Bearer mck1.…` with no
server involvement at all. Beta, rollout-gated, and shaped for a credential an
organization shares — but it is the fallback if the OAuth flow fails its live
check on Claude, and it does nothing for ChatGPT.

## Two revisions, one endpoint (protocol 2026-07-28 — SHIPPED 2026-08-15)

**Read this before touching the protocol surface.** The CURRENT MCP revision is
`2026-07-28`, and it is the largest rewrite since launch: the `initialize`
handshake is gone and with it the protocol session. We serve it BESIDE the
handshake revision `2025-06-18`, which `initialize` still reports and which every
client that can reach us today opens with. All of the new revision's logic lives
in `src/mcp-modern.js` — pure, imports nothing, unit-tested without a Worker.

**Era is decided per REQUEST** (`isModernRequest`), because a stateless protocol
leaves nothing to decide it once. Three signals say modern — the method
`server/discover`, a `_meta` declaring a protocol version, or an
`MCP-Protocol-Version` header naming the modern revision — and one exception
outranks all of them: an `initialize` is ALWAYS legacy. That is the spec's own
dual-era rule ("an `initialize` request selects legacy semantics"), and it
matters because a legacy client has no fall-forward mechanism: answer it with a
modern error and it has nowhere to go.

### The four codes, and why confusing them is not cosmetic

A conforming client BRANCHES on the first error it gets. A recognized modern
JSON-RPC error means "modern server — correct the request and retry"; anything
else means "legacy server — fall back to `initialize` and stay there". So a wrong
code, or a right code at a wrong status, silently downgrades every client that
ever connects, and nothing in the logs says so.

| what is wrong | code | HTTP |
|---|---|---|
| a required `_meta` field is missing | `-32602` Invalid params | 400 |
| the request needs a client capability it did not declare | `-32021` MissingRequiredClientCapability | 400 |
| the version is one we do not implement | `-32022` UnsupportedProtocolVersion | 400 |
| a mirrored header is missing or disagrees with the body | `-32020` HeaderMismatch | 400 |
| the method is one we do not implement | `-32601` Method not found | **404** |

The 404 is deliberate: "the JSON-RPC error body distinguishes this case from a
`404` returned by a legacy HTTP+SSE server that does not host the modern MCP
endpoint." And `-32022` carries `data: { supported, requested }` — both required
by the schema, because `supported` is how a client retries instead of giving up.

### What every modern request must carry, and what every result carries back

Required in `params._meta`: `io.modelcontextprotocol/protocolVersion` and
`io.modelcontextprotocol/clientCapabilities` — the second even though
`clientInfo` is only SHOULD, because a stateless server has no earlier request to
learn capabilities from. **An empty `{}` is a valid answer** ("no optional
capabilities") and must be accepted; only its absence is the error.

Mirrored into headers, and validated against the body: `MCP-Protocol-Version`,
`Mcp-Method` (all requests), and `Mcp-Name` (`tools/call`, `resources/read`,
`prompts/get` — decoded first if it arrives in the `=?base64?…?=` sentinel). The
rule is a security one rather than a formality: an intermediary may route on the
header while we execute on the body, and the two disagreeing is exactly what must
not be served.

Going back: `resultType: "complete"` on EVERY result, `_meta`'s
`io.modelcontextprotocol/serverInfo`, and — on a cacheable listing only —
`ttlMs` + `cacheScope`, which are REQUIRED members rather than hints. Ours are
`private` for `tools/list` (it is filtered per account, so a shared cache must
never hand one account's listing to another) and `public` for `server/discover`
(identical for every caller). We stamp `resultType`/`_meta` on both eras: they are
additive, a legacy client ignores them, and one result shape is one thing to test.

### Deliberate deviations, each with a reason

- **A bare `server/discover` with no `_meta` is refused** with `-32602`, not
  answered. The spec makes `_meta` required on it, a conforming modern client
  always sends it, and the refusal is still a recognized modern error — so the
  client learns the right thing about us either way.
- **A `GET` of the bare origin is not 405; `GET`/`HEAD` on `/mcp` is.** The
  spec's SHOULD covers a modern-ONLY server shedding legacy session traffic, and
  on the `mcp.` host a `GET` of the BARE ORIGIN still serves the human setup
  page `public/connect/`, which is worth more than the SHOULD. The `/mcp` PATH
  stopped doing that on 2026-08-05 (`docs/MCP-CONNECTOR.md` §4c item 5): a
  client that reads HTML there concludes the URL is not an MCP endpoint, so it
  now answers 405 with `Allow: POST` and a -32600 body (`src/index.js`, pinned
  by `src/index.test.js`). `DELETE` is still not 405; revisit if a client is
  ever observed sending one.
- **The `Origin` rule is narrowed.** The transport says validate `Origin` on all
  connections; here the real threat is not DNS rebinding but that `/mcp` is
  reachable with the site's own session cookie as well as a bearer key. So
  `forbiddenOrigin` refuses exactly the forgeable case — cross-site Origin AND no
  Authorization header of its own — and 403s it before the body is read.

### Not implemented, and the next things to want

`extensions` capability negotiation, MRTR (`resultType: "input_required"`),
`subscriptions/listen`, and the `x-mcp-header` tool-parameter mirroring. None is
needed by a tools-only server; all are additive when one is. The nearest real gap
is unchanged from the progress work: a `tools/call` answer still arrives in ONE
frame at the end, so a client with a hard wall-clock ceiling still cuts a long
call.

Validation: `node --test src/mcp-modern.test.js src/mcp-era.test.js` (the first
pins the rules, the second drives both eras through the real `handleMcp`), then
`npm run mcp:probe`, whose `discover` / `modern-tools-list` / `header-mismatch` /
`unsupported-version` checks are the live half. **Not yet run against
production** as of 2026-08-15.

## What a call costs (before widening the audience)

`docs/MCP-COST.md` prices the surface against production
(2026-08-05), the extension tools excepted (below). The three
figures worth carrying: `deep_research` is €0.051 at the median
of a month of real runs and **€0.62 at its analytic ceiling** (34 searches
× the 12/7 deep-tier multiplier, plus one synthesis on the priciest model);
a maximum-budget call actually measured **€0.2355**, because the gap check
saturated at round 2 and spent 9 of its 34 permitted searches. The
literature family costs €0.0021 (1 angle) to €0.0124 (6 angles) — **all of
it the reranker**, 50 candidates × 900 chars per angle-corpus leg, measured
at 10,198 tokens per leg at €0.10/M. Only `literature_fetch`,
`literature_corpora`, `fetch` and `platform_map` cost nothing now.

**The extension tools are a NEW cost shape and are not priced yet.** They
spend nothing at Berget except `street_view_look`'s one vision description, but
they bill Google (imagery, places) and Shodan (credits) — money the four-window
quota does not model, because it counts Berget EUR and Exa searches. They hold a
concurrency slot and pass the quota gate anyway, which bounds the RATE; what is
missing is a price per call. Measure it before the surface is widened.

`cve_intel` is the odd one and worth knowing about before someone "fixes" it: its
upstream (`cvedb.shodan.io`) is keyless and charges nothing, and it is in
`SPENDING_TOOL_NAMES` regardless. The flag decides whether a tool passes the
quota gate and takes a concurrency slot, not whether an invoice arrives — and an
outbound tool with neither bound is the exact defect §4b describes. The same
reasoning covers `host_search`'s count leg, which is free at Shodan and metered
here: it is counted as one outbound unit like everything else in that module.

Two metering gaps decided whether the surface can be published, both in the
register as P-3, and **both are now closed (2026-08-05)**.

**Metering** — `src/literature-run.js` recorded no usage, so the searching
tools were gated on the quota but never incremented it and could not exhaust
it. `runLiteratureTool` now records in a `finally` from the cross-encoder's
own `usage.total_tokens` (which `rerankMatches` used to read past) plus the
embedder's, priced through `rawModelEntry` + `eurPerTokenFromBerget` because
neither model is in the chat catalog `bergetCost` prices from — `fetchCatalog`
filters to `model_type: "text"`, which is why `GET /api/models` lists neither.
It counts as `berget_cost` and never as `searches`: that count is Exa's,
calibrated to €0.005 a search.

**Concurrency** — `/mcp` now takes `reserveInflight` on every tool that
reaches a provider (`deep_research`, `literature_search`, `literature_similar`,
`search`, the two platform answering tools `explain_internals` and
`improvement_areas`, and since 2026-08-15 the extension tools
`street_view_look`, `place_nearby` and the host-intelligence family
`host_intel` / `host_search` / `domain_intel` / `cve_intel` — twelve in all,
the exported `SPENDING_TOOL_NAMES`), released in a `finally` on every exit path, so an
external key gets the same CAP=5 bound `/api/chat` has. Three things about
that shape are worth keeping: the four free tools
hold NO slot (one held there could only deny the caller its own next call);
the refusal is a JSON-RPC `isError` result, never an HTTP 429, because an MCP
client reads the envelope and a bare 429 reads to it as a broken server; and
admins are NOT exempt, unlike on the quota gate — a spend cap is one an
operator is trusted to exceed, an abuse cap is not. `quota.js` is reached by
a dynamic `import()` like everything else heavy here, so the file-layout rule
holds; `src/mcp-inflight.test.js` drives the real `handleMcp` against an
in-memory D1.

The two are complements, not substitutes: the cap bounds PARALLELISM, the
meter bounds RATE. Without the meter a sequential caller was unbounded;
without the cap the check-then-act race made every ceiling a per-connection
one. `deep_research` itself meters correctly and always did; a public
account is capped at ~€111/month, which is `budget_eur` €8 plus 12,000
searches at the deep tier — note `quotaExceeded` caps Berget cost in EUR
but Exa only by COUNT, so the real Exa ceiling is 71% above what the count
nominally prices.

### The two bounds fail in OPPOSITE directions, on purpose

Decided 2026-08-05, after the concurrency work turned up that neither had a
chosen direction at all: every step of the quota gate reaches D1 (the lazy
migration inside `getDb`, the config row, the usage windows), none of those
reads was wrapped, and the throw simply escaped — as `Literature tool failed:
d1 down` here and as a generic 500 out of `handleChat` on `/api/chat`. Both
surfaces refused, neither deliberately, and a D1 outage broke `/mcp` for every
non-admin caller.

- **The quota gate fails CLOSED.** It is the spend barrier, and "I cannot read
  usage" is not a yes. Letting the call through would spend at exactly the
  moment the spend cannot be RECORDED either (`recordUsage` writes to the same
  database), so the overrun is unbounded, invisible, and unlike a refused call
  it cannot be undone.
- **The reservation fails OPEN**, as its `quota.js` header always said. It is
  abuse mitigation on top of a gate that already said yes.

The full argument (including why this matches `identify` /
`resolveMcpKeyIdentity` degrading an unreadable account row to "no identity")
lives above `QUOTA_UNAVAILABLE_STATUS` in `src/quota.js`. On this surface the
refusal is `quotaUnavailableToolMessage()` — an `isError` result, worded so the
client's model retries later rather than stopping, since "quota exceeded" and
"quota unreadable" call for opposite next moves. `/api/chat` says the same
thing as a **503** with `quota_unavailable` (not a 500, which reads as a crash;
not a 429, which would claim a limit the user has not hit). Both log
`*.quota_unverifiable` with the reason. Two things stay open by construction:
a site with **no `DB` binding** (a supported configuration — nothing throws
there, so nothing is refused) and one whose windows are all `0`
(`quotaEnforced` — no limit for an unreadable ledger to hide).

## Related

- **pipeline-architecture** — what `runPipeline` actually does (the phases
  the tool runs).
- **model-routing.js** / **billing.js** — the split-routing and split-billing
  math this server shares verbatim with `chat.js` (leaf modules; don't fork
  them). `billing.js` also owns the hosted-retrieval bucket both channels
  bill (`denseSpend`), priced from Berget's RAW catalog because the chat
  catalog carries neither the cross-encoder nor the embedder.
- **chat-logs** — MCP calls log to the same interaction log on channel
  `mcp` (status `ok` / `error` / `disconnected`).
- **access-control** — the identity gate `/mcp` sits behind and the quota
  model it enforces.
