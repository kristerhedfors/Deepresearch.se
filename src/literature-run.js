// @ts-check
// The RUNNER half of the literature MCP tool family — everything that touches
// a Vectorize binding, the embedder or the cross-encoder.
//
// src/literature-tools.js holds the schemas, the parsing, the record mapping
// and the formatting, and imports nothing. This module holds the calls, and is
// loaded by src/mcp.js behind a dynamic import() inside tools/call — the same
// treatment the pipeline gets, and for the same reason: src/mcp.test.js must be
// able to import the protocol module without dragging src/berget.js in.
//
// ---- what makes it fast ----------------------------------------------------
//
// The pipeline's own search wave asks each corpus ONE question at a time,
// because that is what a research plan produces. An agent doing its own
// reading wants the opposite: several angles at once, both corpora, one round
// trip. Two things make that nearly free:
//
//   1. ONE embedding call for every angle. Berget's embeddings endpoint takes
//      an array, so six questions cost one request (src/dense-rag.js's
//      embedQueries). This is the leg that used to dominate — a single slow
//      embed once stalled an arXiv search for close to a minute (feedback #44).
//   2. Every (angle × corpus) retrieval then runs CONCURRENTLY, each one a
//      Vectorize query plus a cross-encoder pass over its own 50 candidates.
//
// So a six-angle sweep of both corpora is one embed plus twelve retrievals
// running together rather than twelve sequential searches.
//
// MEASURED against production, 2026-08-02, warm, median of 3 (the numbers, not
// the intuition — the first estimate written here was "a couple of seconds
// against most of a minute", and it was wrong by an order of magnitude):
//
//     1 angle  × both corpora ( 2 legs)    814 ms
//     3 angles × both corpora ( 6 legs)   1290 ms
//     6 angles × arXiv only   ( 6 legs)   1180 ms
//     6 angles × both corpora (12 legs)   1690 ms
//
// Six angles cost 2.1× one angle, not 6×, so the same work one call at a time
// (~4.9 s) takes 2–3× as long as the batch — 2.9× against these medians, 2.1×
// on a single-shot run of the probe's own check minutes later, which is the
// spread to expect from one sample over the open internet. Worth being precise
// about: the win is real and it is the reason to batch, but it is a factor of
// two or three, not the order of magnitude the shape of the code suggests.
// The flat-ish 6-legs-to-12-legs step (1180 → 1690 ms) also says RETRIEVAL_POOL
// is not the binding constraint at this size — the legs genuinely overlap.
//
// CONCURRENCY IS CAPPED at RETRIEVAL_POOL, deliberately. A Worker may hold only
// a handful of simultaneous outbound connections; beyond that they queue, and a
// queued request still counts down the 6 s AbortSignal it was created with. So
// firing twelve cross-encoder calls at once would not be twelve times faster —
// it would be six of them timing out. The pool keeps every in-flight call one
// that is actually being served.
//
// ---- what it deliberately does NOT do ---------------------------------------
//
// No model, no planning, no synthesis: these tools RETRIEVE, and the agent that
// called them does the thinking. That keeps them cheap enough to call several
// times in a turn, and it keeps invariant 1 untouched — the calling client's
// model chooses to call us; nothing inside here dispatches on a model's output.

// These three reach a provider or the accounting ledgers, which is exactly why
// this module is the dynamically imported half — see the header. berget.js is
// already behind dense-rag.js, and quota.js pulls only db.js + berget.js.
import { priceRetrievalSpend } from "./billing.js";
import {
  RERANK_FLOOR,
  RERANK_MODEL,
  addEmbedSpend,
  addRerankSpend,
  denseRetrieve,
  embedQueries,
  newRetrievalSpend,
  titleAbstractDoc,
  withTimeout,
} from "./dense-rag.js";
import { recordModelUsage, recordUsage } from "./quota.js";
// src/literature-authors.js is PURE (it imports nothing), so it rides a static
// import here exactly as src/literature-tools.js does. Only the two live API
// clients below it are loaded dynamically, and only when a call actually asks
// for an author — they pull the dense-tier modules in behind them.
import {
  AUTHOR_AMBIGUITY_NOTE,
  AUTHOR_DETECTED_NOTE,
  AUTHOR_LIMIT,
  AUTHOR_LIVE_NOTE,
  AUTHOR_PAGE_SIZE,
  AUTHOR_SORT_NOTE,
  arxivAuthorQuery,
  arxivAuthorRecord,
  europepmcAuthorQuery,
  europepmcAuthorRecord,
  interleaveAuthorRecords,
  resolveAuthors,
  topicTerms,
} from "./literature-authors.js";
import {
  CORPUS_FACTS,
  CORPUS_IDS,
  DEFAULT_LIMIT,
  FILTER_NOTE,
  MAX_QUERIES,
  MAX_TOTAL_RECORDS,
  OPENAI_SEARCH_LIMIT,
  RECORD_MAPPERS,
  RETRIEVAL_NOTE,
  applyFilters,
  capGroups,
  filtersActive,
  formatLiteratureResult,
  mergeRanked,
  normalizeAbstractMode,
  normalizeCorpora,
  normalizeLimit,
  normalizeQueries,
  openAiDocument,
  openAiFetchId,
  openAiMissDocument,
  openAiQuery,
  openAiSearchResults,
  parseFilters,
  parseLiteratureId,
  parseLiteratureIds,
  shapeAbstracts,
} from "./literature-tools.js";

/**
 * What every tool here returns. `payload` is the object `text` was serialized
 * FROM — the adapters below project one tool's payload into another's shape, and
 * re-parsing our own JSON to do it would be a second place for the two spellings
 * to drift. `structured` marks the results src/mcp.js must return twice, as
 * `structuredContent` as well as text.
 * @typedef {Object} LiteratureToolResult
 * @property {string} text
 * @property {any} payload
 * @property {boolean} isError
 * @property {number} queries
 * @property {number} records
 * @property {boolean} [structured]
 */

/** The binding each corpus reads. */
const BINDINGS = { arxiv: "ARXIV_INDEX", pubmed: "PUBMED_INDEX" };
/** The log tag each corpus files under, matching the existing dense tiers. */
const TAGS = { arxiv: "arxiv_rag", pubmed: "pubmed_rag" };

/** See the concurrency note in the header. */
export const RETRIEVAL_POOL = 5;
/** Bounds on the two binding calls that src/dense-rag.js does not already bound. */
export const FETCH_TIMEOUT_MS = 6000;
export const DESCRIBE_TIMEOUT_MS = 4000;

/**
 * The index binding for a corpus, or null when this deployment has none.
 * @param {any} env
 * @param {"arxiv"|"pubmed"} corpus
 */
function indexFor(env, corpus) {
  return env?.[BINDINGS[corpus]] || null;
}

/**
 * Which of the requested corpora can actually be served here, and what to tell
 * the caller about the ones that cannot. A missing binding is a DEPLOYMENT
 * fact, not a failure: it is reported in `unavailable` and the rest of the call
 * proceeds, exactly as the dense tiers degrade to their live APIs.
 * @param {any} env
 * @param {("arxiv"|"pubmed")[]} corpora
 * @returns {{ ready: ("arxiv"|"pubmed")[], unavailable: { corpus: "arxiv"|"pubmed", reason: string }[] }}
 */
function availableCorpora(env, corpora) {
  /** @type {("arxiv"|"pubmed")[]} */
  const ready = [];
  /** @type {{ corpus: "arxiv"|"pubmed", reason: string }[]} */
  const unavailable = [];
  for (const corpus of corpora) {
    if (!indexFor(env, corpus)) unavailable.push({ corpus, reason: `no ${BINDINGS[corpus]} binding in this deployment` });
    else if (!env?.BERGET_API_TOKEN) unavailable.push({ corpus, reason: "the embedding provider is not configured" });
    else ready.push(corpus);
  }
  return { ready, unavailable };
}

/**
 * Run tasks with a bounded number in flight. Small enough to keep here rather
 * than reach for a dependency (invariant 5), and the bound is the point — see
 * the concurrency note in the header.
 * @template T
 * @param {(() => Promise<T>)[]} tasks
 * @param {number} limit
 * @returns {Promise<T[]>}
 */
export async function mapPool(tasks, limit = RETRIEVAL_POOL) {
  /** @type {T[]} */
  const out = new Array(tasks.length);
  let next = 0;
  const workers = new Array(Math.min(Math.max(1, limit), tasks.length || 1)).fill(0).map(async () => {
    while (next < tasks.length) {
      const i = next++;
      out[i] = await tasks[i]();
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * The relevance floor a call asked for. A caller's `min_score` above the tier's
 * own floor is pushed DOWN into retrieval rather than applied afterwards, so a
 * strict caller gets a full result set of strong matches instead of two
 * survivors of a list truncated at the default floor.
 * @param {number|null} minScore
 */
function effectiveFloor(minScore) {
  return minScore !== null && minScore > RERANK_FLOOR ? minScore : RERANK_FLOOR;
}

// ---------------------------------------------------------------------------
// METERING — what a retrieval costs, and how it reaches the quota.
//
// These tools were GATED on the four-window research quota from the day they
// shipped and never INCREMENTED it, so they could not exhaust it: a key that
// only ever called literature_search was unmetered, at €0.0021 (1 angle) to
// €0.0124 (6 angles) a call — €1,068/day at one 6-angle call per second
// (docs/MCP-COST.md §4b, the first of the three gaps it names).
//
// WHERE THE MONEY IS. Almost all of it is the cross-encoder: CANDIDATES (50)
// documents cut to RERANK_DOC_CHARS (900) per (angle × corpus) leg, measured at
// usage.total_tokens = 10,198 for one leg against the live endpoint, at €0.10
// per 1M tokens = €0.00102 a leg. The single embedding call that covers every
// angle is real but three orders of magnitude smaller (€0.03/M in, €0 out), and
// Vectorize's ~$0.00001 per 1024-d query is below the noise floor and is not
// billed here at all — it is neither Berget money nor an Exa search, so there is
// no column it honestly belongs in.
//
// THE TALLY AND ITS PRICE ARE SHARED. The /api/chat pipeline runs the same two
// tiers in its search wave and had the same hole, so the shape a caller
// accumulates into lives with the tier that spends the money (dense-rag.js's
// RetrievalSpend + newRetrievalSpend/addEmbedSpend/addRerankSpend) and pricing
// it lives with the request's other spend math (billing.js
// priceRetrievalSpend). What stays here is what is specific to THIS surface:
// one tally per tool call, recorded in runLiteratureTool's `finally`.
//
// COUNT DIMENSION: deliberately NOT `searches`. quotaExceeded's second dimension
// is a straight count whose live limits (300 per 5 h … 12,000 per month) are
// calibrated to Exa searches at €0.005 each, and `exa_cost` sits beside it as
// Exa's own money; folding a €0.001 dense leg into that count would make one
// column mean two prices and would show searches that bought no Exa. The EUR
// dimension bites on its own: the 5-hour €1 budget is ~476 one-angle or ~80
// six-angle calls, which is the bound that was missing.
// ---------------------------------------------------------------------------

/** @typedef {import('./dense-rag.js').RetrievalSpend} RetrievalSpend */

/**
 * Record one tool call's retrieval spend against the caller's quota.
 *
 * NEVER throws and never rejects: this runs in runLiteratureTool's `finally`,
 * exactly as src/mcp.js's runDeepResearch records there, and invariant 2 is
 * absolute — a missing `usage` field, an unreachable catalog or a D1 outage
 * degrades the ACCOUNTING, never the tool result the agent asked for.
 *
 * Two rows, mirroring /api/chat and deep_research: one usage_events row for
 * ENFORCEMENT (the model column names the reranker, which is what the money
 * went to) and the per-model usage_model_events attribution rows.
 *
 * @param {any} env
 * @param {import('./types.js').Logger} log
 * @param {{ identity?: { id?: string | number } | null, requestId?: string | null } | null | undefined} billing
 * @param {RetrievalSpend} spend
 * @param {number} durationMs
 */
export async function recordRetrievalSpend(env, log, billing, spend, durationMs) {
  try {
    const userId = billing?.identity?.id;
    // No identity means nothing to charge (a direct call in a test, or a future
    // caller outside the MCP surface), and no tokens means nothing was spent —
    // an argument error, or one of the two deliberately exempt tools. Either way
    // an empty row would only inflate the request count.
    if (userId === undefined || userId === null || userId === "") return;
    if (!spend.rerankTokens && !spend.embedTokens) return;

    const { berget_cost, by_model } = await priceRetrievalSpend(env, spend);
    await recordUsage(env, log, {
      user_id: userId,
      model: RERANK_MODEL,
      prompt_tokens: spend.rerankTokens + spend.embedTokens,
      completion_tokens: 0,
      // Exa-only, by design — see the COUNT DIMENSION note above.
      searches: 0,
      berget_cost,
      exa_cost: 0,
      duration_ms: durationMs,
    });
    await recordModelUsage(env, log, { user_id: userId, request_id: billing?.requestId || null, by_model });
    log.info("literature.spend", {
      rerank_tokens: spend.rerankTokens,
      embed_tokens: spend.embedTokens,
      rerank_calls: spend.rerankCalls,
      estimated_calls: spend.estimatedCalls,
      berget_cost,
    });
  } catch (/** @type {any} */ err) {
    // recordUsage and recordModelUsage already swallow their own D1 failures;
    // this catch covers everything else (the catalog lookup above all).
    log.warn("literature.spend_record_failed", { error: err?.message || String(err) });
  }
}

// ---------------------------------------------------------------------------
// The AUTHOR leg.
//
// src/literature-authors.js carries the full reasoning; the short version is
// that the hosted indexes cannot answer "everything by this person" — dense
// retrieval reads a name as a topic, there is no metadata index to filter on,
// and the stored author string is truncated from the end, which is where a
// life-science senior author sits. So this leg leaves the corpus and asks
// Europe PMC and arXiv, whose author FIELDS are real.
//
// It is an ENRICHMENT in invariant 2's sense: both fetches fail soft to empty,
// and a failed author leg degrades the response to its dense half rather than
// erroring the call.
// ---------------------------------------------------------------------------

/**
 * Look one author up in both live APIs, concurrently.
 * @param {import('./types.js').Logger} log
 * @param {string} name
 * @param {string[]} terms disambiguating topic terms
 * @param {("arxiv"|"pubmed")[]} corpora which corpora the caller asked for
 * @returns {Promise<{ name: string, records: any[], failed: string[] }>}
 */
async function lookupAuthor(log, name, terms, corpora) {
  const { europepmcAuthorFetch } = await import("./europepmc.js");
  const { arxivAuthorFetch } = await import("./arxiv.js");

  /** @type {string[]} */
  const failed = [];
  const wantPubmed = corpora.includes("pubmed");
  const wantArxiv = corpora.includes("arxiv");

  const [epmc, arx] = await Promise.all([
    wantPubmed
      ? europepmcAuthorFetch(log, europepmcAuthorQuery(name, terms), AUTHOR_PAGE_SIZE).catch((err) => {
          log.warn("literature.author_epmc_failed", { error: err?.message || String(err) });
          failed.push("pubmed");
          return { cited: [], recent: [] };
        })
      : Promise.resolve({ cited: [], recent: [] }),
    wantArxiv
      ? arxivAuthorFetch(log, arxivAuthorQuery(name, terms), AUTHOR_PAGE_SIZE).catch((err) => {
          log.warn("literature.author_arxiv_failed", { error: err?.message || String(err) });
          failed.push("arxiv");
          return [];
        })
      : Promise.resolve([]),
  ]);

  const pubmed = interleaveAuthorRecords(
    (epmc.cited || []).map(europepmcAuthorRecord).filter(Boolean),
    (epmc.recent || []).map(europepmcAuthorRecord).filter(Boolean),
    AUTHOR_LIMIT,
  );
  // arXiv returns one submission-ordered slice, so there is no second sort to
  // interleave — the same de-duplicating cap still applies.
  const arxiv = interleaveAuthorRecords((arx || []).map(arxivAuthorRecord).filter(Boolean), [], AUTHOR_LIMIT);

  return { name, records: [...pubmed, ...arxiv], failed };
}

// ---------------------------------------------------------------------------
// literature_search
// ---------------------------------------------------------------------------

/**
 * @param {any} env
 * @param {import('./types.js').Logger} log
 * @param {any} args
 * @param {RetrievalSpend} [spend] the call's running provider spend, folded into
 *   by every leg — runLiteratureTool owns it and records it in its `finally`.
 * @returns {Promise<LiteratureToolResult>}
 */
export async function runLiteratureSearch(env, log, args, spend) {
  const started = Date.now();
  const queries = normalizeQueries(args);
  // Resolved BEFORE the empty-query guard: `authors` alone is a complete
  // request ("everything by this person"), and rejecting it for having no
  // query would refuse the one shape the hosted index cannot serve.
  const { names: authorNames, detected: authorDetected } = resolveAuthors(args?.authors, queries);

  if (!queries.length && !authorNames.length) {
    return fail(
      "Nothing to search for: pass `query` (one question) or `queries` (up to " +
        `${MAX_QUERIES} angles, run in parallel), or \`authors\` to list a named researcher's ` +
        "papers. Ask in natural language — retrieval is by meaning, so a full question " +
        "retrieves better than keywords.",
    );
  }
  const corpora = normalizeCorpora(args?.corpus);
  const limit = normalizeLimit(args?.limit);
  const abstractMode = normalizeAbstractMode(args?.abstract);
  const filters = parseFilters(args);
  const floor = effectiveFloor(filters.minScore);

  const { ready, unavailable } = availableCorpora(env, corpora);
  // A missing binding no longer ends the call outright when an author lookup
  // was asked for: that leg is live and needs no index at all.
  if (!ready.length && !authorNames.length) {
    return fail(
      "No hosted corpus is available in this deployment: " +
        unavailable.map((u) => `${u.corpus} (${u.reason})`).join("; ") +
        ". Use deep_research, which falls back to the live arXiv and Europe PMC APIs.",
    );
  }

  // The author leg is fired FIRST and awaited last, so the live APIs overlap
  // the embed and the dense retrievals instead of adding their latency to them.
  // The names are excluded from their own narrowing terms — see topicTerms.
  const authorTerms = authorNames.length ? topicTerms(queries, 6, authorNames) : [];
  const authorWork = authorNames.length
    ? Promise.all(authorNames.map((name) => lookupAuthor(log, name, authorTerms, corpora)))
    : Promise.resolve([]);

  // ONE embedding call for every angle — the batching this whole tool is for.
  /** @type {number[][]} */
  let vectors = [];
  const embedStarted = Date.now();
  let embedFailure = "";
  if (queries.length) {
    try {
      const embedded = await embedQueries(env, queries);
      vectors = embedded.vectors;
      addEmbedSpend(spend, embedded);
    } catch (/** @type {any} */ err) {
      // With an author leg in flight this is a DEGRADED call, not a dead one —
      // the live records are still worth returning (invariant 2).
      embedFailure = err?.message || String(err);
      log.warn("literature.embed_failed", { error: embedFailure });
    }
    if (!embedFailure && vectors.length !== queries.length) {
      embedFailure = "the embedding provider returned an unusable result";
    }
    if (embedFailure && !authorNames.length) {
      return fail(`Could not embed the queries: ${embedFailure}. The corpora are unreachable for now.`);
    }
    if (embedFailure) vectors = [];
  }
  const embedMs = Date.now() - embedStarted;

  // Every (angle × corpus) pair retrieves concurrently, bounded by the pool.
  /** @type {{ qi: number, corpus: "arxiv"|"pubmed" }[]} */
  const plan = [];
  if (vectors.length) {
    for (let qi = 0; qi < queries.length; qi++) for (const corpus of ready) plan.push({ qi, corpus });
  }

  const retrieved = await mapPool(
    plan.map(({ qi, corpus }) => async () => {
      const found = await denseRetrieve(env, log, {
        index: indexFor(env, corpus),
        qvec: vectors[qi],
        query: queries[qi],
        docOf: titleAbstractDoc,
        tag: TAGS[corpus],
        startedAt: embedStarted,
        floor,
      });
      addRerankSpend(spend, found);
      return { qi, corpus, found };
    }),
  );

  /** @type {{ query: string, records: any[] }[]} */
  const groups = queries.map((query) => ({ query, records: [] }));
  /** @type {{ corpus: string, error: string }[]} */
  const failures = [];
  let reranked = true;
  let candidates = 0;

  for (const { qi, corpus, found } of retrieved) {
    if (!found) {
      // One corpus failing does not fail the call: the other one's results are
      // still worth returning, and the caller is told which leg went missing so
      // it can read a thin result set correctly.
      if (!failures.some((f) => f.corpus === corpus)) {
        failures.push({ corpus, error: "retrieval failed or timed out — results below exclude this corpus" });
      }
      continue;
    }
    candidates += found.candidates;
    if (!found.scored) reranked = false;
    const mapper = RECORD_MAPPERS[corpus];
    const records = applyFilters(
      /** @type {any[]} */ (found.matches.map(mapper).filter(Boolean)),
      filters,
    ).slice(0, limit);
    groups[qi].records.push(...records);
  }

  // Within one angle, order across the two corpora by relevance — a caller
  // reading the top of a list should get the best matches, not all of arXiv's
  // followed by all of PubMed's.
  for (const group of groups) group.records.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));

  const capped = capGroups(groups, MAX_TOTAL_RECORDS);
  const merged = queries.length > 1 ? mergeRanked(capped, MAX_TOTAL_RECORDS) : null;
  const dense = capped.reduce((n, g) => n + g.records.length, 0);

  // The live leg, awaited here so it overlapped everything above.
  const authorGroups = (await authorWork).filter((a) => a && a.records.length);
  const authorTotal = authorGroups.reduce((n, a) => n + a.records.length, 0);
  for (const a of await authorWork) {
    for (const corpus of a?.failed || []) {
      if (!failures.some((f) => f.corpus === `${corpus} (author lookup)`)) {
        failures.push({ corpus: `${corpus} (author lookup)`, error: "the live author API failed or timed out" });
      }
    }
  }
  const total = dense + authorTotal;

  /** @type {string[]} */
  const notes = [];
  if (queries.length) notes.push(RETRIEVAL_NOTE);
  if (embedFailure) {
    notes.push(
      `The semantic half of this call could not run (${embedFailure}), so the records below are ` +
        "the author lookup alone. Retry for the topical results.",
    );
  }
  if (filtersActive(filters)) notes.push(FILTER_NOTE);
  if (!reranked) {
    notes.push(
      "At least one leg fell back to raw vector order because the cross-encoder was " +
        "unavailable or out of budget: `score` may be missing and the relevance floor was not applied there.",
    );
  }
  if (authorNames.length) {
    notes.push(AUTHOR_LIVE_NOTE, AUTHOR_SORT_NOTE, AUTHOR_AMBIGUITY_NOTE);
    if (authorDetected) notes.push(AUTHOR_DETECTED_NOTE);
    if (!authorTotal) {
      notes.push(
        `No papers were found for ${authorNames.map((n) => `'${n}'`).join(", ")} in the live author ` +
          "indexes. Check the spelling (both APIs match the name as indexed — 'Surname I' as well as " +
          "the full form), and note that a lookup narrowed by subject terms can miss work outside " +
          "that subject.",
      );
    }
  } else if (!queries.length) {
    notes.push("No author name was usable, so nothing was looked up.");
  }
  if (!dense && queries.length && !embedFailure) {
    notes.push(
      "Nothing cleared the relevance floor. Before concluding the literature is silent, check " +
        "literature_corpora — both indexes are windows onto their sources, and a topic outside " +
        "the window is a miss here but not a miss in the field." +
        (authorNames.length
          ? ""
          : " If the question was about a PERSON's body of work, pass `authors` — dense retrieval " +
            "reads a name as a topic and cannot answer authorship."),
    );
  }
  for (const u of unavailable) notes.push(`Corpus '${u.corpus}' was not searched: ${u.reason}.`);

  const payload = {
    tool: "literature_search",
    corpora_searched: ready,
    queries: capped.map((group, qi) => ({
      index: qi,
      query: group.query,
      count: group.records.length,
      results: shapeAbstracts(group.records, abstractMode),
    })),
    ...(authorNames.length
      ? {
          authors: authorGroups.map((a) => ({
            name: a.name,
            count: a.records.length,
            source: "live author-field API (Europe PMC / arXiv), not the hosted index",
            ...(authorTerms.length ? { narrowed_by: authorTerms } : {}),
            results: shapeAbstracts(a.records, abstractMode),
          })),
        }
      : {}),
    ...(merged
      ? {
          merged: {
            note: "Every angle's results de-duplicated across queries and corpora, best score kept. `found_by` indexes into `queries`; a paper several angles agreed on is ranked first.",
            count: merged.length,
            results: shapeAbstracts(merged, abstractMode),
          },
        }
      : {}),
    stats: {
      queries: queries.length,
      candidates_examined: candidates,
      records_returned: total,
      ...(authorNames.length ? { author_records: authorTotal, authors_looked_up: authorNames } : {}),
      reranked,
      relevance_floor: floor,
      embed_ms: embedMs,
      duration_ms: Date.now() - started,
    },
    ...(failures.length ? { degraded: failures } : {}),
    notes,
  };

  log.info("literature.search", {
    queries: queries.length,
    corpora: ready.join(","),
    candidates,
    results: total,
    // Counts only — the author NAMES are query text and stay out of the logs
    // for the same reason the query strings already do (invariant 4).
    ...(authorNames.length ? { authors: authorNames.length, author_results: authorTotal } : {}),
    reranked,
    duration_ms: Date.now() - started,
  });

  return { text: formatLiteratureResult(payload), payload, isError: false, queries: queries.length, records: total };
}

// ---------------------------------------------------------------------------
// literature_fetch
// ---------------------------------------------------------------------------

/**
 * Fetch exact records by id. Vectorize's getByIds is a direct key read — no
 * embedding, no cross-encoder, no relevance question to get wrong — so this is
 * both the cheapest tool here and the only one that can answer "is this exact
 * paper in the corpus" truthfully.
 * @param {any} env
 * @param {import('./types.js').Logger} log
 * @param {any} args
 * @returns {Promise<LiteratureToolResult>}
 */
export async function runLiteratureFetch(env, log, args) {
  const started = Date.now();
  const { refs, unreadable } = parseLiteratureIds(args?.ids);
  const abstractMode = normalizeAbstractMode(args?.abstract);
  if (!refs.length) {
    return fail(
      "No readable identifier. Pass `ids` as arXiv ids ('2401.12345'), PMIDs ('41610285'), " +
        "prefixed forms ('arxiv:…', 'pmid:…') or URLs to either site." +
        (unreadable.length ? ` Could not read: ${unreadable.join(", ")}.` : ""),
    );
  }

  /** @type {Record<string, string[]>} */
  const byCorpus = {};
  for (const ref of refs) (byCorpus[ref.corpus] ||= []).push(ref.vectorId);

  const wanted = /** @type {("arxiv"|"pubmed")[]} */ (Object.keys(byCorpus));
  const { ready, unavailable } = availableCorpora(env, wanted);

  const fetched = await Promise.all(
    ready.map(async (corpus) => {
      try {
        const rows = await withTimeout(
          indexFor(env, corpus).getByIds(byCorpus[corpus]),
          FETCH_TIMEOUT_MS,
          `${corpus} getByIds`,
        );
        return { corpus, rows: Array.isArray(rows) ? rows : [], error: "" };
      } catch (/** @type {any} */ err) {
        log.warn("literature.fetch_failed", { corpus, error: err?.message || String(err) });
        return { corpus, rows: [], error: err?.message || String(err) };
      }
    }),
  );

  /** @type {any[]} */
  const records = [];
  /** @type {{ corpus: string, error: string }[]} */
  const failures = [];
  const found = new Set();
  for (const { corpus, rows, error } of fetched) {
    if (error) failures.push({ corpus, error });
    for (const row of rows) {
      const rec = RECORD_MAPPERS[/** @type {"arxiv"|"pubmed"} */ (corpus)](row);
      if (!rec) continue;
      records.push(rec);
      found.add(`${corpus}:${rec.id}`);
    }
  }

  // Every id the caller asked for that did not come back, with the reason it
  // could not have. Silence about a miss is what makes an agent re-ask.
  const misses = refs
    .filter((ref) => !found.has(`${ref.corpus}:${ref.id}`))
    .map((ref) => ({
      id: ref.id,
      corpus: ref.corpus,
      reason: unavailable.some((u) => u.corpus === ref.corpus)
        ? /** @type {any} */ (unavailable.find((u) => u.corpus === ref.corpus)).reason
        : failures.some((f) => f.corpus === ref.corpus)
          ? "the corpus lookup failed — retry rather than treating this as absent"
          : "not in this corpus's window",
      window: CORPUS_FACTS[ref.corpus].window,
    }));

  const payload = {
    tool: "literature_fetch",
    count: records.length,
    results: shapeAbstracts(records, abstractMode),
    ...(misses.length ? { not_found: misses } : {}),
    ...(unreadable.length ? { unreadable_ids: unreadable } : {}),
    ...(failures.length ? { degraded: failures } : {}),
    stats: { requested: refs.length, duration_ms: Date.now() - started },
    notes: [RETRIEVAL_NOTE],
  };

  log.info("literature.fetch", { requested: refs.length, found: records.length, duration_ms: Date.now() - started });
  return { text: formatLiteratureResult(payload), payload, isError: false, queries: 0, records: records.length };
}

// ---------------------------------------------------------------------------
// literature_similar
// ---------------------------------------------------------------------------

/**
 * More-like-this from a known paper.
 *
 * The seed's OWN stored vector is used when the binding returns it, which makes
 * this a true nearest-neighbour query: it finds work that describes the same
 * idea in different words, which no paraphrase of a query can reliably reach.
 * When values are not returned, the seed's title and abstract are embedded as a
 * query instead — a slightly different neighbourhood (e5 is asymmetric, and
 * that path uses the query prefix against passage vectors), but the same
 * question, and always available.
 *
 * @param {any} env
 * @param {import('./types.js').Logger} log
 * @param {any} args
 * @param {RetrievalSpend} [spend] see runLiteratureSearch
 */
export async function runLiteratureSimilar(env, log, args, spend) {
  const started = Date.now();
  const ref = parseLiteratureId(args?.id);
  if (!ref) {
    return fail(
      "`id` must be an arXiv id ('2401.12345'), a PMID ('41610285'), a prefixed form " +
        "('arxiv:…', 'pmid:…') or a URL to either site.",
    );
  }
  const corpora = normalizeCorpora(args?.corpus);
  const limit = normalizeLimit(args?.limit);
  const abstractMode = normalizeAbstractMode(args?.abstract);
  const filters = parseFilters(args);

  const seedIndex = indexFor(env, ref.corpus);
  if (!seedIndex) {
    return fail(
      `Corpus '${ref.corpus}' is not available in this deployment (no ${BINDINGS[ref.corpus]} binding), ` +
        "so the seed paper cannot be looked up.",
    );
  }

  /** @type {any} */
  let seedRow = null;
  try {
    const rows = await withTimeout(seedIndex.getByIds([ref.vectorId]), FETCH_TIMEOUT_MS, "seed getByIds");
    seedRow = Array.isArray(rows) ? rows[0] : null;
  } catch (/** @type {any} */ err) {
    log.warn("literature.similar_seed_failed", { error: err?.message || String(err) });
    return fail(`Could not look up ${ref.corpus}:${ref.id}: ${err?.message || String(err)}.`);
  }
  if (!seedRow) {
    return fail(
      `${ref.corpus}:${ref.id} is not in the hosted corpus, so there is no vector to search from. ` +
        `${CORPUS_FACTS[ref.corpus].window} Search by topic with literature_search instead.`,
    );
  }

  const seed = RECORD_MAPPERS[ref.corpus](seedRow);
  const seedTitle = seed?.title || "";
  /** @type {number[] | null} */
  let qvec = Array.isArray(seedRow.values) && seedRow.values.length ? Array.from(seedRow.values) : null;
  let vectorSource = "stored passage vector";
  if (!qvec) {
    const text = [seedTitle, seed?.abstract || ""].filter(Boolean).join(". ").slice(0, 900);
    if (!text) return fail(`${ref.corpus}:${ref.id} carries no usable text or vector to search from.`);
    try {
      const embedded = await embedQueries(env, [text]);
      addEmbedSpend(spend, embedded);
      qvec = embedded.vectors[0] || null;
      vectorSource = "re-embedded title and abstract (the index did not return the stored vector)";
    } catch (/** @type {any} */ err) {
      return fail(`Could not embed the seed paper: ${err?.message || String(err)}.`);
    }
  }
  if (!qvec) return fail("Could not build a search vector for the seed paper.");

  const { ready, unavailable } = availableCorpora(env, corpora);
  if (!ready.length) return fail("No hosted corpus is available to search in this deployment.");

  const retrieved = await mapPool(
    ready.map((corpus) => async () => {
      const found = await denseRetrieve(env, log, {
        index: indexFor(env, corpus),
        qvec: /** @type {number[]} */ (qvec),
        // The cross-encoder judges neighbours against the seed's TITLE: Berget
        // serves the reranker behind a 512-token window covering query AND
        // document together, so a full abstract as the query would push every
        // pair past it and the whole batch would be rejected.
        query: seedTitle || ref.id,
        docOf: titleAbstractDoc,
        tag: TAGS[corpus],
        startedAt: started,
        floor: effectiveFloor(filters.minScore),
      });
      addRerankSpend(spend, found);
      return { corpus, found };
    }),
  );

  /** @type {any[]} */
  let records = [];
  /** @type {{ corpus: string, error: string }[]} */
  const failures = [];
  for (const { corpus, found } of retrieved) {
    if (!found) {
      failures.push({ corpus, error: "retrieval failed or timed out — results below exclude this corpus" });
      continue;
    }
    const mapper = RECORD_MAPPERS[corpus];
    const mapped = /** @type {any[]} */ (found.matches.map(mapper).filter(Boolean))
      // The seed is its own nearest neighbour; returning it would waste a slot
      // and read as a result.
      .filter((rec) => !(rec.corpus === ref.corpus && rec.id === ref.id));
    records.push(...applyFilters(mapped, filters).slice(0, limit));
  }
  records.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  records = records.slice(0, MAX_TOTAL_RECORDS);

  /** @type {string[]} */
  const notes = [RETRIEVAL_NOTE, `Neighbourhood searched from the ${vectorSource}.`];
  if (filtersActive(filters)) notes.push(FILTER_NOTE);
  for (const u of unavailable) notes.push(`Corpus '${u.corpus}' was not searched: ${u.reason}.`);

  const payload = {
    tool: "literature_similar",
    seed: seed ? { corpus: ref.corpus, id: ref.id, title: seed.title, url: seed.url, date: seed.date } : { corpus: ref.corpus, id: ref.id },
    corpora_searched: ready,
    count: records.length,
    results: shapeAbstracts(records, abstractMode),
    ...(failures.length ? { degraded: failures } : {}),
    stats: { records_returned: records.length, duration_ms: Date.now() - started },
    notes,
  };

  log.info("literature.similar", {
    corpus: ref.corpus,
    id: ref.id,
    results: records.length,
    duration_ms: Date.now() - started,
  });
  return { text: formatLiteratureResult(payload), payload, isError: false, queries: 0, records: records.length };
}

// ---------------------------------------------------------------------------
// literature_corpora
// ---------------------------------------------------------------------------

/**
 * What is actually indexed. The live vector count comes from the binding when
 * it answers; the coverage window, the stored fields and the retrieval
 * semantics are committed facts (src/literature-tools.js CORPUS_FACTS), because
 * they are what a `describe()` call cannot tell you and what an agent needs in
 * order to read a miss correctly.
 * @param {any} env
 * @param {import('./types.js').Logger} log
 */
export async function runLiteratureCorpora(env, log) {
  const started = Date.now();
  const corpora = await Promise.all(
    CORPUS_IDS.map(async (corpus) => {
      const facts = CORPUS_FACTS[corpus];
      const index = indexFor(env, corpus);
      const base = {
        corpus,
        name: facts.name,
        available: Boolean(index && env?.BERGET_API_TOKEN),
        covers: facts.covers,
        coverage_window: facts.window,
        id_format: facts.id_format,
        fields_stored: facts.fields,
        vectors_at_last_fill: facts.vectors_at_fill,
        live_fallback: facts.live_fallback,
        documentation: facts.doc,
      };
      if (!index) return { ...base, unavailable_reason: `no ${facts.binding} binding in this deployment` };
      try {
        const info = await withTimeout(index.describe(), DESCRIBE_TIMEOUT_MS, `${corpus} describe`);
        return {
          ...base,
          vectors_live: info?.vectorCount ?? info?.vectorsCount ?? null,
          dimensions: info?.dimensions ?? null,
        };
      } catch (/** @type {any} */ err) {
        log.warn("literature.describe_failed", { corpus, error: err?.message || String(err) });
        return { ...base, vectors_live: null, describe_error: err?.message || String(err) };
      }
    }),
  );

  const payload = {
    tool: "literature_corpora",
    corpora,
    retrieval: {
      method: "dense retrieval (intfloat/multilingual-e5-large, 1024 dims, cosine) reranked by BAAI/bge-reranker-v2-m3",
      candidates_per_query: 50,
      relevance_floor: RERANK_FLOOR,
      languages: "Queries work in English and Swedish; the embedding model is multilingual.",
      full_text:
        "Abstracts only. Neither index stores full text, so a question whose answer is in a paper's " +
        "results section is one to follow to the source URL rather than to ask this corpus.",
      filtering:
        "No server-side metadata filtering: neither index carries a Vectorize metadata index, so " +
        "since/until/categories/journals are applied to the reranked candidates after retrieval.",
      parallelism: `literature_search takes up to ${MAX_QUERIES} queries and runs them, across both corpora, concurrently in one call — prefer that over sequential calls.`,
    },
    limits: {
      max_queries_per_call: MAX_QUERIES,
      default_limit: DEFAULT_LIMIT,
      max_records_per_response: MAX_TOTAL_RECORDS,
    },
    stats: { duration_ms: Date.now() - started },
  };
  return { text: formatLiteratureResult(payload), payload, isError: false, queries: 0, records: 0 };
}

// ---------------------------------------------------------------------------
// search / fetch — the two adapter tools ChatGPT requires by name
// (docs/MCP-CONNECTOR.md §2a; the schemas and projections are in
// src/literature-tools.js).
//
// Both are THIN: `search` is runLiteratureSearch with one angle and the
// abstracts turned off, `fetch` is runLiteratureFetch with one id. Nothing new
// retrieves, nothing is embedded twice, and every fail-soft property the
// literature family already has — a dead corpus degrading, an honest miss, the
// relevance floor — arrives here for free because it is the same call.
//
// Their results carry a `structured: true` flag, which is src/mcp.js's cue to
// return the payload BOTH as `structuredContent` and as the JSON text of the
// content array. That dual return is not belt-and-braces: it is how the client
// reads the result at all.
// ---------------------------------------------------------------------------

/**
 * Wrap an adapter payload in the runner's result shape. The text is the SAME
 * object serialized, never a second rendering of it — two spellings of one
 * result is exactly the drift a connector would surface as a parse failure.
 * @param {any} payload
 * @param {boolean} isError
 * @param {number} records
 */
function structuredResult(payload, isError, records) {
  return { text: formatLiteratureResult(payload), payload, structured: true, isError, queries: 0, records };
}

/**
 * `search` — one query over both hosted corpora, projected to
 * `{ results: [{ id, title, url }] }`.
 *
 * On failure the shape is preserved (an empty `results` plus an `error`) rather
 * than replaced by an error string: a client that asked for a documented shape
 * and got something else reports a broken server, which is a worse thing to
 * debug than an empty result set.
 *
 * @param {any} env
 * @param {import('./types.js').Logger} log
 * @param {any} args
 * @param {RetrievalSpend} [spend] passed straight through to the inner call:
 *   the adapter is a projection of literature_search, so it meters exactly like
 *   it and can never be the cheap way around the meter.
 */
export async function runOpenAiSearch(env, log, args, spend) {
  const query = openAiQuery(args);
  if (!query) {
    return structuredResult(
      { results: [], error: "`query` is required: a question or topic in natural language." },
      true,
      0,
    );
  }

  const inner = await runLiteratureSearch(
    env,
    log,
    {
      query,
      limit: OPENAI_SEARCH_LIMIT,
      // The projection carries no abstract, so retrieving them would be payload
      // nobody reads.
      abstract: "none",
    },
    spend,
  );
  if (inner.isError) {
    return structuredResult({ results: [], error: inner.payload?.error || "The corpora are unreachable." }, true, 0);
  }

  // The dense records first, then the author leg's — which runLiteratureSearch
  // adds by itself when the query asked for a person's work. Before it did,
  // THIS was the whole failure: "Love Dalén's life works" retrieved ancient-DNA
  // papers by other people, every one of them below the floor, and the tool
  // answered `{"results":[]}` with nothing to say why. A client model reads
  // that as "the corpus is empty" and stops, which is what the user reported as
  // Claude never searching (src/literature-authors.js has the full account).
  const records = [
    ...(inner.payload?.queries?.[0]?.results || []),
    ...(inner.payload?.authors || []).flatMap((/** @type {any} */ a) => a.results || []),
  ];
  const results = openAiSearchResults(records);
  log.info("literature.openai_search", { results: results.length });
  if (!results.length) {
    // An empty `results` is a legal response and a useless one. OpenAI's
    // contract fixes the `results` key, not the whole object, so the reason
    // rides alongside it — a caller that ignores the extra field is exactly as
    // well off as before, and one that reads it stops concluding the corpus is
    // silent when it is only the wrong instrument.
    return structuredResult(
      {
        results: [],
        note:
          "No match cleared the relevance floor. This searches two hosted corpora by MEANING " +
          "(arXiv from October 2023; a PMID slice of PubMed), so three things read as empty here " +
          "and are not empty in the literature: a topic outside those windows, a question about " +
          "a PERSON's body of work (authorship is not something semantic retrieval can match — " +
          "call literature_search with `authors`), and a query stripped to keywords. " +
          "Call literature_corpora for what is actually indexed.",
      },
      false,
      0,
    );
  }
  return structuredResult({ results }, false, results.length);
}

/**
 * `fetch` — one document id to `{ id, title, text, url, metadata }`.
 *
 * @param {any} env
 * @param {import('./types.js').Logger} log
 * @param {any} args
 */
export async function runOpenAiFetch(env, log, args) {
  const raw = openAiFetchId(args);
  const ref = parseLiteratureId(raw);
  if (!ref) {
    // No corpus and no id to name, so there is no document shape to fill
    // honestly — this is the one branch that answers with an error alone.
    return structuredResult(
      {
        id: raw,
        title: "",
        text:
          "Unreadable id. Pass the `id` from a `search` result ('arxiv:2401.12345', " +
          "'pmid:41610285'), a bare arXiv id or PMID, or a URL to arxiv.org or pubmed.ncbi.nlm.nih.gov.",
        url: "",
        error: "unreadable id",
      },
      true,
      0,
    );
  }

  const inner = await runLiteratureFetch(env, log, { ids: [raw], abstract: "full" });
  if (inner.isError) {
    return structuredResult(openAiMissDocument(ref, inner.payload?.error || "the lookup failed."), true, 0);
  }
  const record = inner.payload?.results?.[0];
  if (!record) {
    const miss = inner.payload?.not_found?.[0];
    return structuredResult(openAiMissDocument(ref, miss?.reason || "not in this corpus's window."), true, 0);
  }
  log.info("literature.openai_fetch", { corpus: ref.corpus });
  return structuredResult(openAiDocument(record), false, 1);
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

/**
 * An argument problem or an unavailable corpus, returned as a tool-level result
 * rather than thrown: an MCP error makes a client report a transport failure,
 * while a described failure is something the calling model can act on.
 * @param {string} message
 */
function fail(message) {
  const payload = { error: message };
  return {
    text: formatLiteratureResult(payload),
    payload,
    isError: true,
    queries: 0,
    records: 0,
  };
}

/**
 * Run one literature tool by name.
 *
 * The `finally` is the whole metering seam, and it is deliberately the SAME
 * shape src/mcp.js's runDeepResearch uses: whatever the tool did — answered,
 * degraded, refused its arguments or threw — the provider spend it actually
 * incurred is recorded against the caller before the result leaves. The two
 * tools that spend nothing (literature_fetch is a key read, literature_corpora
 * is committed facts, and `fetch` is a projection of the first) leave the
 * accumulator at zero and so record nothing, which is the same exemption they
 * already have from the quota GATE in src/mcp.js: an agent out of budget must
 * still be able to resolve an id it was handed.
 *
 * @param {any} env
 * @param {import('./types.js').Logger} log
 * @param {string} name
 * @param {any} args
 * @param {{ identity?: { id?: string | number } | null, requestId?: string | null } | null} [billing]
 *   who to charge. Absent (a direct call, a test) means the spend is measured
 *   and logged but not recorded — there is nobody to record it against.
 * @returns {Promise<LiteratureToolResult>}
 */
export async function runLiteratureTool(env, log, name, args, billing) {
  const started = Date.now();
  const spend = newRetrievalSpend();
  try {
    switch (name) {
      case "literature_search":
        return await runLiteratureSearch(env, log, args, spend);
      case "literature_fetch":
        return await runLiteratureFetch(env, log, args);
      case "literature_similar":
        return await runLiteratureSimilar(env, log, args, spend);
      case "literature_corpora":
        return await runLiteratureCorpora(env, log);
      // The two adapter tools ride the same dispatch so src/mcp.js needs one
      // dynamic import and one branch, not two of each.
      case "search":
        return await runOpenAiSearch(env, log, args, spend);
      case "fetch":
        return await runOpenAiFetch(env, log, args);
      default:
        return fail(`Unknown literature tool: ${name}`);
    }
  } finally {
    // Never throws — see recordRetrievalSpend. A `finally` that can reject
    // would replace the tool's result with an accounting error, which is
    // exactly what invariant 2 forbids.
    await recordRetrievalSpend(env, log, billing, spend, Date.now() - started);
  }
}
