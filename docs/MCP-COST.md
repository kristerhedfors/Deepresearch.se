# What an MCP tool call costs

Measured 2026-08-05, against production. The question this answers: if
`POST /mcp` (`src/mcp.js`) were opened beyond the handful of approved
accounts it serves today, what would a call cost, and what would the bill
look like when someone abuses it.

**Short answer.** Per call the surface is cheap: 7 of the 11 tools spend
nothing at a provider, the literature family costs €0.002–€0.012, and
`deep_research` — the only expensive tool — costs €0.05 at the median and
**€0.62 at its analytic ceiling**. The per-call numbers are not what
decides feasibility. Three gaps do, and all three are in the metering
rather than the price: the literature family records no usage at all, `/mcp`
takes no concurrency reservation (**fixed 2026-08-05** — §4b(2)), and the
model and budget overrides are open by default. Fix those three and the
surface is affordable to publish; leave them and one key can outspend the
site's entire current monthly bill in an afternoon.

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
| Cloudflare Vectorize | $0.01 per 1M queried dimensions → **$0.00001 per 1024-d query** | `docs/PUBMED-RAG.md`, `.claude/skills/bulk-corpus-etl` §"Billing" |

Workers request and CPU cost is real but rounds to nothing at this
granularity ($0.02/M requests, $0.02/M CPU-ms): even the 15 MB snapshot
parse an `sdk_*` call does is ~€0.00001.

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
| `sdk_list_modules` / `sdk_show_module` / `sdk_plan` / `sdk_validate` | 15 MB snapshot fetch + parse, no provider call | €0 | 779 ms |

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

## 3. `deep_research`

### The cost model

One `deep_research` call spends in three buckets:

- **Exa** — `plan.maxSearches` capped at 20 (standard) / 26 (extended) /
  34 (full ≥420 s), priced at €0.005 × the tier multiplier.
- **The answer model** — exactly one call. `runSynthesis` is invoked once
  in `src/pipeline.js`; validation and the gap checks are JSON phases on
  the fixed `DEFAULT_MODEL` (invariant 3), so the expensive model the
  caller can name is billed for one prompt and one capped completion
  (`synthMaxTokens` 4096 / 6144 / 8192 by tier).
- **The JSON phases** — triage + up to 8 gap rounds + validation, all on
  Mistral Small at €0.3/M both ways. Large in tokens, small in money.

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
snapshot as context. `deep_research` takes no `chat_mode` argument and
cannot reach that path — worth knowing precisely because it is the cost
shape someone will find in the log and wrongly attribute to MCP.

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
| | | **€0.622** |

On the site default (Mistral Small answering) the same maximal run is
**€0.347**, Exa-dominated. So the model override roughly doubles the worst
case; it does not change its order of magnitude.

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

### 4b. Three gaps, in the order they matter

**(1) The literature family records no usage.** `src/literature-run.js`
contains no `recordUsage` / `recordModelUsage` / `recordDefaultModelUsage`
call. `literature_search` and `literature_similar` are *gated* on the quota
— an account already exhausted by chat or `deep_research` is refused — but
they never *increment* it, so they cannot exhaust it themselves. A key that
only ever calls `literature_search` is unmetered:

| shape | per call | at 1 call/s |
|---|---|---|
| 1 angle, both corpora | €0.0021 | €7.41/h · €178/day |
| 6 angles, both corpora | €0.0124 | €44.48/h · €1,068/day |

The 6-angle call is what the tool description actively encourages ("prefer
that over sequential calls"), and it is the cheap-per-call, expensive-in-
aggregate shape. This is the single item to fix before publishing.

**(2) `/mcp` takes no concurrency reservation — FIXED 2026-08-05.**
`reserveInflight` (`INFLIGHT_CAP = 5`) was taken on `/api/chat`,
`/api/embed`, `/api/quiz/grade` and `/api/bash/step` and nowhere else. The
race that cap exists to close is spelled out in `src/quota.js`'s own comment:
the quota gate is check-then-act, a request's spend is recorded only when it
finishes, so N concurrent calls all read the same pre-spend usage and all
pass. On `/mcp` that N was unbounded, and it multiplied the per-hour figures
in (1) directly.

`src/mcp.js` now reserves a slot for the four tools that reach a provider —
`deep_research`, `literature_search`, `literature_similar` and the `search`
adapter (`SPENDING_TOOL_NAMES`) — and releases it in a `finally` covering
success, a tool-level failure and a thrown error. The seven tools that cost
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
the time budget. That is what turns a €0.347 maximal run into a €0.622 one
and what lets every call sit at 600 s. It is a per-account switch, already
built and already exposed in Settings → MCP server — but the default is the
permissive one, and a public surface would inherit it.

### 4c. What is already right

- The quota gate is enforced *before* any spend, and admins are the only
  exemption.
- `deep_research` records `recordUsage` + `recordModelUsage` in a `finally`,
  so a partial or failed run is still billed to the caller.
- Every tool is switchable off per account (`MCP_TOOL_CATALOG`, mirror-
  tested), and `tools/call` enforces the switch, not just `tools/list`.
- An MCP key is never a login (test-pinned), so the blast radius of a
  leaked key is spend, not data.
- `literature_fetch` and `literature_corpora` sit outside the quota
  deliberately and cost nothing, so that exemption carries no spend risk.
- Since 2026-08-05 the four provider-touching tools also hold a concurrency
  slot (§4b(2)), so the ceilings in 4a are per account rather than per
  simultaneous connection.

## 5. Verdict

Publishing the **free seven** — the four `sdk_*` tools, `literature_fetch`,
`literature_corpora`, and `fetch` — carries no provider cost at all. Their
only exposure is Workers CPU, and the `sdk_*` snapshot parse is the one
worth watching (779 ms per call, uncached).

Publishing `deep_research` is affordable as it stands: the quota bounds an
account at ~€111/month, and the per-call ceiling is €0.62. Tightening
`allow_model_override` and `allow_budget_override` in the public default
would halve the ceiling.

Publishing `literature_search` / `literature_similar` / `search` is **not**
affordable until they record usage. They are the cheapest tools per call,
and the concurrency cap now bounds how fast one key can call them, but
nothing they spend counts against any window — so they still have no upper
bound of their own.

---

## How these numbers were produced

Reproducible; nothing here is an estimate where a measurement was available.

| number | method |
|---|---|
| rerank tokens per leg | one live `POST /v1/rerank` with 50 × 900-char documents; read `usage.total_tokens` from the response |
| model prices | `GET /api/models` (site catalog) and Berget `GET /v1/models` (reranker + embedder, which the site catalog does not carry) |
| leg counts | `npm run mcp:probe` — "600 candidates examined" for the 6-angle batch |
| tool latency | `npm run mcp:probe`, plus direct timed `tools/call` posts for `sdk_list_modules` and `literature_corpora` |
| cost distribution | all 1,208 `chat_logs` rows via `/api/admin/chatlogs?limit=200&before_id=…`, priced per row against the catalog |
| answer/JSON split | `/api/admin/user-cost` (`usage_model_events`), which attributes per model bucket |
| the worst-case run | one `tools/call` at `time_budget_s: 600`, `model: gpt-5.6-sol`; costs read back from `chat_logs` #1209 and the h5 usage window |
| quota ceilings | live `config.quotas` from `/api/admin/overview`, combined with `quotaExceeded`'s semantics in `src/quota.js` |

Re-run the whole thing after any change to `CANDIDATES`, `RERANK_DOC_CHARS`,
the budget planner's caps, or the catalog's prices — those are the four
inputs every figure above is built on.
