# What an MCP tool call costs

Measured 2026-08-05, against production. The question this answers: if
`POST /mcp` (`src/mcp.js`) were opened beyond the handful of approved
accounts it serves today, what would a call cost, and what would the bill
look like when someone abuses it.

One thing here is not about `/mcp` at all, and is here because this is where
it was found. The hosted retrieval tier §1 prices also runs inside the
`/api/chat` research pipeline, where the same tokens went unbilled for the
same reason — §4d records that fix and what a chat request's share of it
comes to.

**Short answer.** Per call the surface is cheap: 4 of the 16 tools spend
nothing at a provider, the literature family costs €0.002–€0.012, and
`deep_research` — the only expensive tool — costs €0.05 at the median and
**€0.62 at its analytic ceiling**. The per-call numbers are not what
decides feasibility. Three gaps do, and all three are in the metering
rather than the price: the literature family recorded no usage at all and
`/mcp` took no concurrency reservation — **both fixed 2026-08-05** (§4b) —
while the model and budget overrides remain open by default. A third gap
surfaced while closing the other two and is also fixed: neither bound had a
chosen failure direction, so a D1 error escaped as an unreadable refusal here
and as a 500 on `/api/chat` (§4b(4)). With those in, the surface is
affordable to publish; without them one key could outspend the site's entire
current monthly bill in an afternoon.

For context on the scale: the whole site's provider spend for the month
this was written was **€2.05 Berget + €5.11 Exa across 211 requests**
(`/api/admin/overview`, admin bucket).

---

## 1. Where the money goes

Four cost sources, and only two of them matter.

| source | price | provenance |
|---|---|---|
| Berget chat models | €0.3/M (Mistral Small) … €4.6 in / €27.6 out per M (GPT-5.6 Sol) | the live catalog, `GET /api/models` |
| Berget `bge-reranker-v2-m3` | **€0.10/M tokens** | Berget `/v1/models`, retrieved 2026-08-05 |
| Berget `multilingual-e5-large` (embeddings) | €0.03/M in, €0 out | same |
| Exa search | €0.005/search × the depth tier's `costMultiplier` (12/7 at ≥420 s) | `config.exa_cost_per_search_eur`, `src/budget.js` `searchDepthFor` |
| Cloudflare Vectorize | $0.01 per 1M queried dimensions → **$0.00001 per 1024-d query** | `docs/PUBMED-RAG.md`, `skills-disabled/bulk-corpus-etl` §"Billing" |

Workers request and CPU cost is real but rounds to nothing at this
granularity ($0.02/M requests, $0.02/M CPU-ms): even the 15 MB snapshot
parse a committed-data call does is ~€0.00001.

## 2. Per-call cost, by tool

| tool | provider work | cost/call | measured latency |
|---|---|---|---|
| `deep_research` | full pipeline: Exa + 1 synthesis + N JSON phases | **€0.051 typical / €0.62 ceiling** — §3 | 8–96 s |
| `literature_search` (1 angle, both corpora) | 1 embed + 2 Vectorize queries + 2 reranks | **€0.0021** | 814 ms |
| `literature_search` (6 angles, both corpora) | 1 embed + 12 Vectorize queries + 12 reranks | **€0.0124** | 1.7–3.8 s |
| `literature_similar` | 1 seed read + 2 Vectorize queries + 2 reranks | €0.0021 | ~1 s |
| `search` (the ChatGPT adapter) | same as 1-angle `literature_search` | €0.0021 | ~1 s |
| `literature_fetch` (≤20 ids) | `getByIds` key read, no embed, no rerank | ~€0 | ~0.5 s |
| `literature_corpora` | committed facts + `describe()` | €0 | 621 ms |
| `explain_internals` | the pipeline pointed at the committed source: 1 embed + source retrieval + an agentic read/tool loop + 1 synthesis. **No Exa** — `web_search` is forced off | **below `deep_research`** — §2b | not yet measured |
| `improvement_areas` | same as `explain_internals` | same — §2b | not yet measured |
| `platform_map` | committed snapshot + docs corpus through `ASSETS` | €0 | not yet measured |
| `street_view_look` | 1–2 Google imagery fetches + 1 vision description | **Google imagery + ~€0.001 vision** — §2a | not yet measured |
| `place_nearby` | 1 Places search (+1 free reverse geocode) | **Google Places, €0 at Berget** — §2a | not yet measured |
| `host_intel` | 1 Shodan lookup or search (+1 DNS resolve per hostname) | **Shodan credits, €0 at Berget** — §2a | not yet measured |
| `host_search` | 1 free count + 1 billed search, or 1 free count alone with `count_only` | **1 Shodan query credit at most, €0 at Berget** — §2a | not yet measured |
| `domain_intel` | 1 DNS-database read, twice when a hostname is retried one level up | **Shodan credits, €0 at Berget** — §2a | not yet measured |
| `cve_intel` | 1 read of `cvedb.shodan.io` | **€0 everywhere** — keyless, no query credits — §2a | not yet measured |

**The reranker is the whole cost of the literature family**, and it was
measured rather than estimated. `src/dense-rag.js` reranks `CANDIDATES = 50`
documents per (angle × corpus) leg, each cut to `RERANK_DOC_CHARS = 900`.
One such call against the live endpoint reports `usage.total_tokens =
10,198` — so a leg costs 10,198 × €0.10/M = **€0.00102**, and the rest
(embedding, Vectorize, Workers) is three orders of magnitude below it. The
`limit` argument does not change this: it slices the output after
retrieval, so a 6-angle call costs €0.0124 whether it returns 8 records or
60. `npm run mcp:probe` confirms the leg count directly — its 6-angle batch
reports "600 candidates examined", which is 12 legs × 50.

### 2b. The platform family, and why its ceiling is BELOW `deep_research`'s

`explain_internals` and `improvement_areas` (2026-08-16) run
`runDeepResearch` itself, so every figure in §3 applies to them — with one
structural subtraction and one addition, and the subtraction is the larger.

**Subtracted: Exa, entirely.** `resolveIntrospectArgs` forces
`web_search: false`, and a caller cannot switch it back on. §3's ceiling is
€0.62, of which the 34-search allowance at the deep tier is the dominant term;
none of it is reachable here. The gap-check rounds that spend those searches do
not run either — the turn routes to `runSourceResearch` instead.

**Added: retrieval over the committed source, plus a read loop.** One query
embed, a cosine rank against the committed index (no Vectorize — the index is a
static asset of this deploy, so it costs a fetch and no provider call), then
either an agentic tool loop capped at `MAX_SOURCE_TOOL_ROUNDS = 6` or the
deterministic read loop, billed to the answer model. That is bounded by the
round cap and the time budget, whose voice default is 60 s.

So the shape is: **a floor near a plain synthesis, and a ceiling set by the
answer model over at most six investigation rounds** — comfortably inside
`deep_research`'s €0.62, and typically well under its €0.051 median because the
searches are gone. It is **not measured yet**, and it should be before the
surface is widened; the reason it is not blocking is that both tools pass the
same `researchQuotaBlock` and hold the same concurrency slot as
`deep_research`, so nothing here is unmetered — only unpriced.

`platform_map` is the fourth free tool beside `literature_fetch`,
`literature_corpora` and `fetch`: it reads two committed artifacts through the `ASSETS`
binding and contacts no provider. It is outside the quota gate and holds no
concurrency slot, for the reason those two are — an agent whose budget is gone
should still be able to learn what exists, and a slot held on a free call could
only deny the caller its own next call.

The same €0.00102 leg is what a `/api/chat` search wave buys when it reaches
the hosted arXiv or PubMed index — the tier is one module and `/mcp` is not
its only caller. §4d.

## 3. `deep_research`

### The cost model

One `deep_research` call spends in four buckets:

- **Exa** — `plan.maxSearches` capped at 20 (standard) / 26 (extended) /
  34 (full ≥420 s), priced at €0.005 × the tier multiplier.
- **The answer model** — exactly one call. `runSynthesis` is invoked once
  in `src/pipeline.js`; validation and the gap checks are JSON phases on
  the fixed `DEFAULT_MODEL` (invariant 3), so the expensive model the
  caller can name is billed for one prompt and one capped completion
  (`synthMaxTokens` 4096 / 6144 / 8192 by tier).
- **The JSON phases** — triage + up to 8 gap rounds + validation, all on
  Mistral Small at €0.3/M both ways. Large in tokens, small in money.
- **Hosted retrieval** — the arXiv and PubMed dense tiers, when the question
  engages a literature source. At most 8 legs (§4d), so at most €0.008: the
  smallest of the four, and the only one that was invisible until 2026-08-05.

### What it actually costs, from the log

Every row of `chat_logs` for the month before this was written — 1,208
requests, 2026-07-08 → 2026-08-02 — priced at its own row's model:

| | p50 | p90 | p99 | max |
|---|---|---|---|---|
| search-enabled runs (n=453) | **€0.051** | €0.100 | €0.206 | €0.279 |
| — of which Exa | €0.040 | €0.060 | €0.080 | €0.090 |
| — of which LLM | €0.007 | €0.075 | €0.165 | €0.249 |
| searches per run | 8 | 12 | 16 | 18 |
| duration | 42.6 s | 67.6 s | 123 s | 251 s |

`deep_research`'s own history is one row (2026-07-27, €0.003) — nobody has
used the surface. The chat rows are the right proxy: `runDeepResearch`
re-does `src/chat.js`'s setup deliberately and then runs the same
`runPipeline`.

Two things the table says that the ceiling analysis does not. **Exa is the
larger half of a median run** — €0.040 of €0.051 — because the default
model is cheap and searches are not. And **the highest bills in the log are
not research runs at all**: the ten most expensive requests ever
(€0.87–€1.25 each) are zero-search, 300k–435k-prompt-token Claude Sonnet
calls, which are introspection and Agent Studio mode carrying the source
snapshot as context.

**That last claim changed on 2026-08-15 and the ceiling above has not been
re-derived.** `deep_research` now takes an `agent` argument, and `introspection`
is one of the agents it accepts — which is exactly the shape that produced those
€0.87–€1.25 requests. Three things bound it rather than the old
cannot-reach-it argument: the agent must pass the account's own
`developer_mode` grant (`chatModesAvailable`, the same one a chat turn uses), the
build and workflow phases are refused outright on this surface
(`MCP_AGENT_PHASES` in `src/mcp.js`), and the four-window quota meters it like
any other spend. Someone re-deriving §3's ceiling should start here: a
snapshot-carrying agent on the priciest model is the new worst case, and it is
NOT the 34-search figure §3 computes.

### The measured worst case

One call, deliberately built to be as expensive as the surface allows:
600 s budget, `gpt-5.6-sol` (the priciest model in the catalog at
€4.6 in / €27.6 out), and a five-jurisdiction comparison question chosen to
keep the gap checker asking for more.

```
chat_logs #1209 · 2026-08-05 · budget_s=600 · 9 searches · 35 sources · 95.9 s
  answer  gpt-5.6-sol      9,910 tok   €0.1532
  json    Mistral Small   17,520 tok   €0.0053
  exa     9 × €0.005 × 12/7            €0.0771
                                 total €0.2355
```

It finished in 96 s of a 600 s budget and ran 9 of its 34 permitted
searches, because the gap check reported coverage complete at round 2. That
is the honest headline for a realistic worst case: **€0.24**. The Exa line
also confirms the deep-tier multiplier is live — 9 searches billed €0.0771,
which is 9 × €0.005 × 12/7 exactly.

### The ceiling

The measured run is not the bound, because a question that keeps the gap
checker unsatisfied would spend the rest. Every term is capped in code, so
the ceiling is arithmetic:

| term | cap | cost |
|---|---|---|
| Exa | `maxSearches` 34 at the full tier, ×12/7 | €0.291 |
| answer model | ~12,000 prompt (`digestCap` 24,000 chars + 28 sources) + 8,192 completion, on GPT-5.6 Sol | €0.281 |
| JSON phases | ~165,000 tokens on Mistral Small | €0.050 |
| hosted retrieval | 8 legs (both literature sources leading, at 4 angles each) × 10,198 tokens × €0.10/M | €0.008 |
| | | **€0.630** |

On the site default (Mistral Small answering) the same maximal run is
**€0.355**, Exa-dominated. So the model override roughly doubles the worst
case; it does not change its order of magnitude.

The retrieval row is new on 2026-08-05 and is the one figure in this document
that the chat-path fix (§4d) moved: the ceiling was **€0.622** before it, and
the default-model ceiling €0.347. Both were understatements, not because the
arithmetic was wrong but because the term was invisible — the tokens were
spent and nothing counted them. 1.3% is what the correction is worth, which
is also why nothing else in this document changes.

## 4. What actually bounds a public surface

The per-call prices above are affordable. What decides feasibility is what
stops a caller repeating them.

### 4a. The quota, and what it does not cover

`researchQuotaBlock` applies the same four-window gate `/api/chat` uses.
The live values, and what each account could spend before hitting them:

| window | `budget_eur` (Berget only) | searches | ceiling incl. Exa |
|---|---|---|---|
| 5 h | €1 | 300 | €2.50 – €3.57 |
| day | €2 | 1,000 | €7.00 – €10.57 |
| week | €4 | 4,000 | €24.00 – €38.29 |
| month | €8 | 12,000 | €68.00 – €110.86 |

The ranges are standard-tier vs. deep-tier Exa pricing. The asymmetry is
worth naming: `quotaExceeded` compares `budget_eur` against `berget_cost`
only — Exa is bounded by a **count**, never a EUR figure — so the deep
tier's 12/7 multiplier makes the real Exa ceiling 71% above what the search
count nominally prices. **A public account's month is capped at ~€111**,
and that is the number to reason about, not the €8 in the config.

### 4b. Four gaps, in the order they matter

**(1) The literature family recorded no usage — FIXED 2026-08-05.** As
written, `src/literature-run.js` contained no `recordUsage` /
`recordModelUsage` call. `literature_search` and `literature_similar` were
*gated* on the quota — an account already exhausted by chat or
`deep_research` is refused — but never *incremented* it, so they could not
exhaust it themselves. A key that only ever called `literature_search` was
unmetered:

| shape | per call | at 1 call/s |
|---|---|---|
| 1 angle, both corpora | €0.0021 | €7.41/h · €178/day |
| 6 angles, both corpora | €0.0124 | €44.48/h · €1,068/day |

The 6-angle call is what the tool description actively encourages ("prefer
that over sequential calls"), and it is the cheap-per-call, expensive-in-
aggregate shape. This was the single item to fix before publishing.

`runLiteratureTool` now records it in a `finally`, the same shape
`runDeepResearch` uses. Two things about the fix are worth carrying:

- **The token counts are the provider's own, not estimates.** Berget's
  `/v1/rerank` response carries a `usage` block that `rerankMatches` was
  reading past; it is plumbed out through `denseRetrieve` now, and
  `embedQueries` returns `embedTexts`' `usage` the same way. The chars/token
  fallback (`RERANK_CHARS_PER_TOKEN`, derived from the 45,000-char → 10,198-
  token measurement above) only runs when a response omits `usage` entirely.
- **Priced from the RAW catalog, not the site one.** `quota.js`'s
  `bergetCost` prices from a chat-catalog entry, and `fetchCatalog` filters
  that list to streaming json_mode text models — which is why `GET
  /api/models` shows neither model. Both are in Berget's raw `/v1/models`,
  so the spend is priced the way `src/rag.js` already prices an embedding
  call: `rawModelEntry` + `eurPerTokenFromBerget`. No price is hard-coded,
  and an unreachable catalog records the tokens at €0 rather than guessing.

It counts against `berget_cost` only, never `searches`: that count's live
limits are calibrated to Exa searches at €0.005 each and sit beside
`exa_cost`, so a €0.001 dense leg has no honest place in it. The EUR
dimension bounds a literature-only key on its own — the 5-hour €1 budget is
~476 one-angle or ~80 six-angle calls.

**(2) `/mcp` takes no concurrency reservation — FIXED 2026-08-05.**
`reserveInflight` (`INFLIGHT_CAP = 5`) was taken on `/api/chat`,
`/api/embed`, `/api/quiz/grade` and `/api/bash/step` and nowhere else. The
race that cap exists to close is spelled out in `src/quota.js`'s own comment:
the quota gate is check-then-act, a request's spend is recorded only when it
finishes, so N concurrent calls all read the same pre-spend usage and all
pass. On `/mcp` that N was unbounded, and it multiplied the per-hour figures
in (1) directly.

`src/mcp.js` now reserves a slot for every tool that reaches a provider —
`deep_research`, `literature_search`, `literature_similar`, the `search`
adapter, the two platform answering tools `explain_internals` and
`improvement_areas` (since 2026-08-16), and (since 2026-08-15) the extension
tools `street_view_look`, `place_nearby` and the host-intelligence family —
`host_intel`, and since 2026-08-16 `host_search`, `domain_intel` and
`cve_intel` (`SPENDING_TOOL_NAMES`, whose extension half comes from
`src/extension-tools.js`) — and releases it in a `finally` covering
success, a tool-level failure and a thrown error. The four tools that cost
nothing stay outside it, because a slot held there could only deny the caller
its own next call. A refusal is a JSON-RPC result with `isError`, not an HTTP
429: an MCP client reads the envelope, and a bare 429 reads to it as a
transport failure rather than a condition its model can act on. Admins take a
slot like anyone else, unlike on the quota gate — a spend cap is something an
operator is trusted to exceed, an abuse cap is not, and the admin credential
is the one whose leak matters most. So the (1) figures below are now
per-account rather than per-connection, times at most 5.

**(3) Model and budget override are open by default.**
`defaultMcpConfig()` sets `allow_model_override: true` and
`allow_budget_override: true`, so a caller picks both the answer model and
the time budget. That is what turns a €0.355 maximal run into a €0.630 one
and what lets every call sit at 600 s. It is a per-account switch, already
built and already exposed in Settings → MCP server — but the default is the
permissive one, and a public surface would inherit it.

**(4) Neither bound had a chosen fail direction — FIXED 2026-08-05.** Found
while building (2): a test asserting that a broken D1 fails open came back
`Literature tool failed: d1 down`. The reservation does fail open; the quota
gate then threw, because every step of it reaches D1 (the lazy migration inside
`getDb`, the config row, the usage windows) and none of those reads was
wrapped. The same hole sat on `/api/chat`, where the throw escaped `handleChat`
and became a generic 500. Both surfaces refused, neither on purpose.

The two bounds now fail in deliberate opposite directions, and the reasoning is
in one place (above `QUOTA_UNAVAILABLE_STATUS` in `src/quota.js`). The **quota
gate fails CLOSED**: it is the spend barrier, and an unreadable ledger is not a
yes — letting the call through spends at exactly the moment the spend cannot be
recorded either, so the overrun would be unbounded, invisible and irreversible,
where a refusal costs a retry. The **reservation keeps failing OPEN**: it is
abuse mitigation on top of a gate that already said yes. `/mcp` refuses with an
`isError` result (`quotaUnavailableToolMessage`) worded so the client's model
retries later rather than stopping; `/api/chat` answers 503 with
`quota_unavailable`. Admins stay exempt from the gate on both. A site with no
`DB` binding, and one whose windows are all `0`, are untouched — nothing throws
in the first and there is no limit to hide in the second.

### 4c. What is already right

- The quota gate is enforced *before* any spend, admins are the only
  exemption, and it refuses rather than guesses when it cannot read usage
  (§4b(4)).
- `deep_research` records `recordUsage` + `recordModelUsage` in a `finally`,
  so a partial or failed run is still billed to the caller — and since
  2026-08-05 `runLiteratureTool` does the same for the retrieving literature
  tools.
- Every tool is switchable off per account (`MCP_TOOL_CATALOG`, mirror-
  tested), and `tools/call` enforces the switch, not just `tools/list`.
- An MCP key is never a login (test-pinned), so the blast radius of a
  leaked key is spend, not data.
- `literature_fetch`, `literature_corpora` and `platform_map` sit outside the
  quota deliberately and cost nothing, so that exemption carries no spend risk.
- The provider-touching tools also hold a concurrency slot (§4b(2)) — the
  four named there since 2026-08-05, seven when the first three extension
  tools joined on 2026-08-15, and twelve since the host-intelligence family
  widened and the two platform answering tools joined on 2026-08-16 — so the
  ceilings in 4a are per account rather than per simultaneous connection.

### 4d. The same hole on the higher-traffic path — FIXED 2026-08-05

`/mcp` is not the dense tier's only caller. `src/dense-rag.js` also runs
inside the `/api/chat` research pipeline: `src/arxiv.js` and
`src/europepmc.js` consult the hosted index BEFORE their live API, so an
ordinary chat turn about the literature buys the same €0.00102 legs a
`literature_search` does. Those tokens reached no `usage_events` row, no
budget bar and no admin cost total, for exactly the reason the literature
tools' did not: the tier returned the counts and nothing on that path
consumed them. This is the higher-traffic surface of the two.

**Where the spend now goes.** A fourth per-request bucket beside the three
model buckets `src/billing.js` already prices — `state.denseTotals`, a
`RetrievalSpend` tally (`src/dense-rag.js`) that every leg folds into. The
registry carries it generically: a source's result may report `spend`
(`SearchSourceResult`), `pipeline.js`'s `runOneAuxSearch` merges it into the
request's tally, and the orchestrator never names a source. At the end of
the request `billing.js`'s `denseSpend` prices it once and the caller adds it
to the SINGLE `recordUsage` row `summarizeSpend` produced, plus `rerank` /
`embed` rows on the existing `recordModelUsage` call. Both request channels
do this — `/api/chat` and `deep_research`, which runs the same pipeline.

It is a separate bucket rather than a fourth entry in `summarizeSpend`
because the three there are (model id → chat-catalog entry → `bergetCost`),
synchronous and pure, and the reranker and the embedder are not in the chat
catalog at all (§4b(1)). Pricing them needs Berget's raw `/v1/models` and is
therefore async. Same fail-soft rules throughout: an unreachable catalog
records the tokens at €0, a failed leg reports 0 tokens, and a request that
touched no hosted index records byte-identically to what it recorded before.
Not counted as `searches`, for the reason §4b(1) gives.

**What a chat request's dense spend comes to.** One leg per (source ×
corpus), and each source has a per-request cap:

| turn | legs | dense cost |
|---|---|---|
| no literature source engaged (the common case) | 0 | **€0** |
| one source, one angle | 1 | €0.0010 |
| one source at its cap (`ARXIV_MAX_PER_REQUEST` / `EUROPEPMC_MAX_PER_REQUEST` = 2) | 2 | €0.0020 |
| both sources at their caps | 4 | €0.0041 |
| a source LEADING (the message names it; cap 4) | 4 | €0.0041 |
| both leading — the arithmetic ceiling | 8 | €0.0082 |

Against §3's €0.051 median run that is 2–4% for a turn that engages the
literature, and 0% for one that does not; against the €0.62 ceiling it is
+1.3% (§3, "The ceiling"). So the correction is small — but it was
unbounded in the sense that mattered, because nothing counted it at all.

## 5. Verdict

Publishing the **free four** — `literature_fetch`,
`literature_corpora`, `fetch` and `platform_map` — carries no provider cost at
all. Their only exposure is Workers CPU.

Publishing `deep_research` is affordable as it stands: the quota bounds an
account at ~€111/month, and the per-call ceiling is €0.63. Tightening
`allow_model_override` and `allow_budget_override` in the public default
would halve the ceiling.

Publishing `literature_search` / `literature_similar` / `search` was **not**
affordable until they recorded usage — they were the cheapest tools per call
and the only ones with no upper bound at all. Both halves of that are now
closed: they record their reranker and embedder spend against `berget_cost`
(§4b), and the concurrency reservation bounds how many can run at once. The
meter bounds rate, the cap bounds parallelism; neither substitutes for the
other, which is why both were needed.

---

## How these numbers were produced

Reproducible; nothing here is an estimate where a measurement was available.

| number | method |
|---|---|
| rerank tokens per leg | one live `POST /v1/rerank` with 50 × 900-char documents; read `usage.total_tokens` from the response |
| model prices | `GET /api/models` (site catalog) and Berget `GET /v1/models` (reranker + embedder, which the site catalog does not carry) |
| leg counts | `npm run mcp:probe` — "600 candidates examined" for the 6-angle batch |
| tool latency | `npm run mcp:probe`, plus direct timed `tools/call` posts for `literature_corpora` |
| cost distribution | all 1,208 `chat_logs` rows via `/api/admin/chatlogs?limit=200&before_id=…`, priced per row against the catalog |
| answer/JSON split | `/api/admin/user-cost` (`usage_model_events`), which attributes per model bucket |
| the worst-case run | one `tools/call` at `time_budget_s: 600`, `model: gpt-5.6-sol`; costs read back from `chat_logs` #1209 and the h5 usage window |
| quota ceilings | live `config.quotas` from `/api/admin/overview`, combined with `quotaExceeded`'s semantics in `src/quota.js` |
| chat-path leg counts (§4d) | read off the code, not measured: `ARXIV_MAX_PER_REQUEST` / `EUROPEPMC_MAX_PER_REQUEST` (2) and their lead caps (4), one leg per source per wave in `pipeline.js`'s `runAuxSearch` |

Re-run the whole thing after any change to `CANDIDATES`, `RERANK_DOC_CHARS`,
the budget planner's caps, the per-source search caps, or the catalog's
prices — those are the inputs every figure above is built on.
