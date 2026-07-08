---
name: add-research-source
description: >-
  Load when adding a NEW data source to the deep-research pipeline (a search
  provider, platform API, or intelligence feed that should produce citable
  sources or context — "integrate X like Hugging Face/Shodan/Maps was
  integrated"), or when debugging why an existing source never fires or its
  results never show up. The end-to-end playbook: choosing the integration
  shape, intent routing, the triage-prompt layer, API client design,
  registry/diversity wiring, SSE visibility, and the validation protocol
  (unit tests → live probes → bench A/B → ledger).
---

# Integrating a new deep-research source

The end-to-end playbook for wiring a new external source into the pipeline,
distilled from the Hugging Face Hub integration (2026-07-08 — `src/hf.js`,
the worked example referenced throughout). Every step here exists because
skipping it produced a real bug that session. The per-provider reference
details live in the **integrations** skill; this skill is the *procedure*.

## 0. Invariants that bound every design choice

- **No function calling.** The source is called deterministically by the
  Worker (intent regex → direct fetch), never chosen by a model at runtime.
- **Fail-soft in every branch.** A dead API, a timeout, zero hits — all
  degrade to the pipeline running exactly as if the source didn't exist.
  The chat must never error or stall because an optional source did.
- **Minimal outbound data.** Only the AI-derived query / extracted target
  crosses the wire — never the conversation, filenames, or account
  identity.
- **Secrets are Worker secrets** (dashboard), never in the repo. Design the
  client so a missing secret still works if the API allows it (HF) or
  makes the feature invisible (Shodan/Maps).

## 1. Choose the integration shape

Two established shapes — pick by what the source contributes:

- **Search-phase source** (HF Hub): the source answers *the research
  question itself* with citable documents/records. It runs inside the
  search waves, its hits join the numbered source registry, and it's
  implicitly gated behind the web-search toggle. No settings knob needed
  when the request is query-only, free, and non-sensitive.
- **Pre-pipeline enrichment** (Shodan, Google Maps, geocode): the source
  resolves *something the message names* (a host, an address, GPS) into a
  labeled context block appended to the conversation before any model
  call. Needs an **opt-in knob** (`src/settings.js`) when it sends
  user-adjacent data to a third party or costs money per call.

If the source is billed per call, mirror Exa's cost accounting
(`costMultiplier` pattern in `budget.js`/`chat.js`) — never silently
under-count spend.

## 2. Intent routing (when does the source fire?)

- A **pure, unit-tested predicate** on the latest user message
  (`hfIntent(ctx.lastUser)` — a regex; `extractTargets`/`extractPlace` for
  entity shapes). No model decides this.
- Start conservative (explicit mentions only), then widen on real demand:
  a bare "hf" was added by user request, with the false-positive tradeoff
  (HF radio) documented at the predicate — acceptable because a spurious
  fire is free and its junk goes uncited.
- **No spurious activity**: when intent is absent there must be no step,
  no event, no fetch — an ordinary question shows nothing.

## 3. The triage-prompt layer — routing is NOT only code

**The bug that proves the step:** with `hfIntent` accepting bare "hf",
"Latest on cybersecurity on hf" still died — TRIAGE (the JSON planning
model) didn't know what "hf" means on this site and routed to
`clarify("what does 'hf' refer to?")`, one step before the search phase
could ever run. Code-level routing sits BELOW the planning model; if the
planner mis-triages or writes queries in the wrong vocabulary, the source
never sees the request.

So when a source introduces site-specific vocabulary (an abbreviation, a
product name, an entity class), teach the PROMPTS too
(`src/prompts.js`):
- **triagePrompt**: state the referent outright, forbid clarifying it,
  and tell it how to write queries ("spell it out as 'Hugging Face'" —
  which also searches better on Exa than the abbreviation).
- **gapPrompt**: same note — follow-up queries are written there.
- Add structural prompt tests (`prompts.test.js`) asserting the note is
  present, with the production failure quoted in the test comment.

## 4. The API client (`src/<source>.js`)

- **Probe the real API empirically BEFORE writing the client** — curl the
  endpoints with representative queries and LOOK at results. The HF client
  was redesigned twice because of unprobed assumptions: `?search=` turned
  out to be a NAME-substring matcher (verbose queries return nothing;
  every word must appear in the repo name), and the fix — single most
  distinctive term + `sort=downloads` — only emerged from probing
  ("swedish" alone returns the canonical 2.5M-download Swedish ASR model
  at rank 1). Record what you established in the client's header comment
  and in the **integrations** skill, dated.
- **Query adaptation is usually needed**: planned queries are written for
  a web search engine. For keyword/name-matching APIs: a noise-word
  stripper (`hfTerms`) covering platform words, question words, AND
  search-intent qualifiers the pipeline's own prompt rules inject
  ("independent reviews" comes from the independent-source rule) AND
  question-meta words ("variants", "versions") — each of those three
  classes produced junk results in a live probe before being stripped.
  Plus a bounded fallback ladder (`hfAttempts`, ≤3 attempts) if single
  attempts can miss.
- **Timeout-bound every fetch** (`AbortSignal.timeout` — HF uses 6s;
  Shodan 8s; geocode 4s). Concurrent sub-requests via `Promise.all`, each
  `.catch(() => [])` so one dead endpoint doesn't kill the rest.
- **Map results to registry items** with pure, unit-testable mappers:
  `{url, title, highlights: [...]}` — put the source's structured
  metadata (downloads, dates, license…) in the highlight line; that's
  what the synthesis model reads and cites from. Junk in → `null` out,
  never a throw.
- **Structured log line** per call (`hf.search` with counts +
  duration_ms) — the live-verify convention; Workers Logs is how you
  confirm behavior in production.

## 5. Pipeline wiring (`src/pipeline.js`)

- Hook into `runSearches` AFTER the Exa batch is processed (a
  `maybe<Source>Search(ctx, batch, round)` function) so source numbering
  stays deterministic. Use the wave's first planned query — the most
  on-topic angle; every planned query is self-contained per the triage
  rules.
- **Cap per request** (HF: 3 waves) and **dedup across waves** by a
  normalized key (`hfTermKey`) — gap-round follow-ups often reduce to the
  same terms; the probe showed repeat searches returning zero new sources.
- Feed hits through `addSources(state, items)` — never push into
  `state.sources` directly (dedup + diversity cap live there).
- **Diversity keying**: if the source is a PLATFORM hosting many
  independent authors (hf.co), extend `diversityKeyOf` in `src/sources.js`
  to key by owner namespace — otherwise the 3-per-domain cap throttles the
  whole platform to 3 sources while the cap's real job (no single AUTHOR
  dominating) still holds. Unit-test the keying.
- Do NOT touch `state.searchCount` unless the call is billed like an Exa
  search — that counter drives quota/billing.

## 6. SSE visibility — sources must flow through `search_done`

**The bug that proves the step:** the first HF build emitted a generic
step (`step_start`/`step_done`) and its sources, though cited `[n]` in
answers, were INVISIBLE to (a) the client's source panel, (b)
`buildResearchDebugJson`, and (c) both eval harnesses — all three
reconstruct the registry from `search_done` events, and the eval judge
fact-checked against a registry missing them.

Emit ordinary `search_start`/`search_done` events with a labeled query
(`"Hugging Face Hub: <terms>"`) and `sources: [{title, url}]`. On failure,
`search_done` with `results: 0`. Clients ignore unknown fields
(**sse-protocol** skill) but reuse of the existing search vocabulary is
what makes the sources propagate everywhere for free. Enrichments (shape
2) keep using steps + labeled context blocks instead — they add context,
not citable sources.

## 7. Validation — the testing logic, in order

1. **Unit tests** for every pure part: intent predicate (both directions,
   incl. the documented false-positive tradeoffs), term
   stripping/ladders, item mappers (junk → null), diversity keying,
   dedup keys. Run `npm test` from the repo root.
2. **Live probe after deploy** (deploy skill: verify behaviorally, never
   trust the upload message): a small script against `/api/chat` with
   break-glass Basic Auth asserting a marker only the new code produces
   (the labeled `search_done`, the expected top hit). Probe the EXACT
   phrasing of any reported failure (the screenshot query, verbatim).
   Beware racing the deploy: a probe seconds after upload can hit the old
   isolate — poll until the new marker appears.
3. **Bench questions**: add 3–5 append-only questions (fresh ids, a new
   `kind`) to `tests/bench-questions.mjs` whose rubrics require the
   source's content (e.g. "cites huggingface.co pages among the
   sources"). Include a non-English one if the site serves one.
4. **The A/B protocol** (build → A → improve → B), all with FIXED
   budget/judge/question ids:
   - Optionally score the questions against the PRE-integration
     deployment first (the "does the source help at all" reference).
   - Deploy, run **A**, then read A's raw traces — not just scores:
     did the source fire every time? Were its results RELEVANT (junk is
     invisible to the judge because models don't cite junk — a probe
     catches it, a score doesn't)? Did its sources reach the
     reconstructed registry?
   - Implement fixes traced to specific A evidence; deploy; run **B**.
   - Expect A→B judge deltas to be noise at n=4×1 (±2 per cell) — the
     fixes' value is usually mechanism-level (relevance, dedup,
     visibility), verified by probes and trace inspection. Say so
     honestly in the ledger; de-noise (multi-sample) before trusting
     per-question deltas.
5. **Ledger entry** (`tests/EVAL-BENCH-FINDINGS.md`): the full cycle —
   scores table, what each fix traced to, carried-forward items.
   **Never deploy/push mid-battery** (a push to `main` auto-deploys and
   truncates in-flight streams).
6. **Docs**: extend the **integrations** skill (dated, evidence-based),
   the CLAUDE.md code-layout table, and this skill if the procedure
   itself grew a step.

## 8. Post-integration watch list

- Expect upstream drift: name-matching semantics, response shapes, and
  rate limits are all empirical findings with a date on them — re-probe
  when results look off, and update the dated notes.
- New junk vectors surface from real phrasings (each of "independent
  reviews", "variants", bare-"hf"-clarify was found from a live probe or
  a user screenshot AFTER the integration shipped). Fix at the layer the
  evidence points to: noise list (term extraction), prompt note (triage),
  or predicate (routing) — and add the failing phrasing as a test.
