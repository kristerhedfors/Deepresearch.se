// @ts-check
// THE RESEARCH TOOL RUNNERS — everything the toolbox in src/research-tools.js
// actually does: the network calls, the corpus reads, the sandbox commands, and
// the request bookkeeping each one owes.
//
// Loaded only behind `await import("./research-tools-run.js")`, the pattern
// src/mcp.js uses for its own runners, so the schemas stay cheap to hold and the
// service modules never enter a static graph that does not need them.
//
// ---- THE BOOKKEEPING IS THE HARD PART --------------------------------------
//
// A model-issued search has to leave the request in exactly the state a planned
// one did, or three things break silently and none of them break loudly:
//
//   · `state.searchCount` / `state.cachedSearchCount` — what src/billing.js
//     prices and src/quota.js meters. A search that does not increment these is
//     a free search, which is the same defect the MCP extension tools shipped
//     with (src/extension-tools-run.test.js's header).
//   · `state.issuedQueries` — the ledger handed to the writer. It must record
//     what was ACTUALLY asked, or the answer attests to searches that never
//     happened.
//   · the `search_start` / `search_done` pair, carrying `source` AND `service`.
//     That event pair is how the client's source panel, the pipeline map,
//     buildResearchDebugJson and every eval harness reconstruct the source
//     registry. A leg that reports itself as a plain step is invisible to all
//     four — cited [n] in the answer and absent from every reconstruction.
//
// …plus `widenPlanCapacity` before `addSources` wherever a leg's results must
// not be pushed out of the digest by what arrived first (feedback #61), and
// `mergeRetrievalSpend` for the sources with a hosted dense tier, which cost
// Berget money per leg.
//
// ---- IT NEVER THROWS -------------------------------------------------------
//
// Every failure and every refusal is a sentence the model reads on its next
// round. A thrown transport error inside a tool loop costs the whole answer;
// invariant 2 says a helper degrades instead, and on this path the tool result
// IS the degradation channel.

import { fetchContents, webSearch } from "./exa.js";
import { readNamedUrls } from "./named-urls.js";
import { SEARCH_SOURCES } from "./search-sources.js";
import { addSources } from "./sources.js";
import { mergeRetrievalSpend } from "./dense-rag.js";
// The two wave-path helpers a model-issued leg must reuse rather than restate:
// the standing per-request caveat stamped onto every web item (feedback #69's
// "labelled as web reporting"), and the paired registry/digest widening whose
// two caps must move together or the reserve is a lie.
import { labelWebItems, widenPlanCapacity } from "./pipeline.js";
import { loadSamples } from "./aadr.js";
import {
  DEFAULT_RADIUS_KM,
  centroid,
  matchEntities,
  querySamples,
  sampleBlock,
  year,
} from "../public/js/aadr-core.js";
import { EXEC_CEILING_MS, STEP_BUDGET_MS } from "../public/js/lypning-core.js";
import { execContainerAvailable, handleExecApi, sanitizeSession } from "./exec-container.js";
import { LITERATURE_TOOL_NAMES } from "./literature-tools.js";
import { RESEARCH_TOOL_EXTENSION } from "./research-tools.js";
import { sourceDedupKey } from "./tool-admission.js";

/** @typedef {import('./types.js').Env} Env */
/** @typedef {import('./types.js').Logger} Logger */
/** @typedef {import('./search-sources.js').SearchSourceItem} SearchSourceItem */

/**
 * What the loop hands this runner. It is the pipeline context's research slice
 * and nothing more: the runner never sees the conversation, the prompts or the
 * model's transcript, which is what keeps "what a tool may reach" answerable by
 * reading this file.
 *
 * `exec` is the DREE/1 seam (docs/EXECUTION-ENVIRONMENTS.md): a function the
 * request already bound to an execution environment. When it is absent the
 * runner resolves one itself, and when there is none it SAYS SO — there is no
 * Worker-side Python and inventing one would be a different product.
 *
 * @typedef {{
 *   state: any,
 *   plan?: any,
 *   emit?: (event: object) => void,
 *   step?: (id: string, label: string) => void,
 *   stepDone?: (id: string, label: string, details?: string[], extra?: Record<string, unknown>) => void,
 *   model?: string,
 *   identity?: any,
 *   requestId?: string,
 *   round?: number,
 *   budget?: any,
 *   asked?: string,
 *   exec?: (command: string, opts: { timeoutMs: number }) => Promise<{ exitCode: number, stdout: string, stderr: string }>,
 *   execLabel?: string,
 * }} ResearchToolCtx
 */

/**
 * What every runner hands back. `found` separates "ran and found nothing" from
 * "could not run", which the chat logs must be able to tell apart; `sourcesAdded`
 * is what the loop reports as the call's delta.
 * @typedef {{ text: string, isError: boolean, found: boolean, sourcesAdded: number }} ResearchToolResult
 */

/** How much of one page's text a read_pages result carries. Matches Exa's
 * /contents cut, so the two extraction paths return the same size of page. */
export const MAX_PAGE_CHARS = 6000;
/** How much of a program's output comes back. Beyond this the model is reading
 * a log, not an answer, and paying for it every round. */
export const MAX_OUTPUT_CHARS = 4000;
/** Exa's published ratio for a `deep` search over a standard one — the same
 * figure src/budget.js's top tier carries. */
export const DEEP_COST_MULTIPLIER = 12 / 7;
/** The interpreters a run_python call tries, in fall-through order. lypning
 * first because in the sandbox image CPython cannot run a one-liner at all
 * (docs/LYPNING.md §2); python3 last because it is always correct. */
export const ENGINE_ORDER = ["lypning", "lypning-mp", "python3"];
/** lypning's refusal: exit 90, one line on stderr, NOTHING on stdout — which is
 * what makes the CPython retry safe rather than a second guess. */
export const REFUSAL_EXIT = 90;

/**
 * Dispatch one research tool.
 *
 * @param {Env} env
 * @param {Logger} log
 * @param {string} name
 * @param {any} args already admitted and scrubbed by src/tool-admission.js
 * @param {ResearchToolCtx} rctx
 * @returns {Promise<ResearchToolResult>}
 */
export async function runResearchTool(env, log, name, args, rctx) {
  const a = args && typeof args === "object" ? args : {};
  try {
    switch (name) {
      case "web_search":
        return await runWebSearch(env, log, a, rctx);
      case "read_pages":
        return await runReadPages(env, log, a, rctx);
      case "source_search":
        return await runSourceSearch(env, log, a, rctx);
      case "ancient_samples":
        return await runAncientSamples(env, log, a);
      case "run_python":
        return await runPython(env, log, a, rctx);
      default:
        if (LITERATURE_TOOL_NAMES.has(name)) return await runLiterature(env, log, name, a, rctx);
        if (RESEARCH_TOOL_EXTENSION[name]) return await runExtension(env, log, name, a, rctx);
        return fail(`There is no tool called "${String(name).slice(0, 60)}" on this server.`);
    }
  } catch (/** @type {any} */ err) {
    // The last line of the fail-soft ladder. A runner that throws here has a
    // bug; the answer must survive it anyway, and the model must be told
    // something it can act on rather than being handed a stack trace.
    log.warn("research_tool.failed", { tool: name, error: err?.message || String(err) });
    return fail(
      `The ${name} tool failed to run: ${String(err?.message || err).slice(0, 200)}. Nothing was retrieved. Try a different tool or answer from what you have.`,
    );
  }
}

// ---------------------------------------------------------------------------
// web_search
// ---------------------------------------------------------------------------

/**
 * @param {Env} env
 * @param {Logger} log
 * @param {any} args
 * @param {ResearchToolCtx} rctx
 * @returns {Promise<ResearchToolResult>}
 */
async function runWebSearch(env, log, args, rctx) {
  const { state } = rctx;
  const queries = Array.isArray(args.queries) ? args.queries : [];
  if (!queries.length) return fail("A web search needs at least one query.");
  const round = rctx.round || 0;
  const depth = resolveDepth(state, args);

  // Committed BEFORE the fetches, exactly as the wave path commits them: these
  // are what the request was charged for and what the ledger reports, and an
  // early return between the dispatch and the absorption must not be able to
  // lose them.
  state.searchCount = (state.searchCount || 0) + queries.length;
  for (const query of queries) (state.issuedQueries ||= new Set()).add(query);
  for (const query of queries) {
    emitStatus(rctx, { type: "search_start", round, query, source: "web", service: "Web search" });
  }

  const results = await Promise.all(
    queries.map((/** @type {string} */ query) =>
      webSearch(env, log, query, depth, { source: state.searchSource || "" }).catch((/** @type {any} */ err) => {
        log.warn("research_tool.web_search_failed", { error: err?.message || String(err) });
        return { content: "", items: [], sources: [], resultCount: 0, durationMs: 0 };
      }),
    ),
  );

  /** @type {string[]} */
  const lines = [];
  let added = 0;
  for (let i = 0; i < queries.length; i++) {
    const query = queries[i];
    const result = results[i];
    // A cache hit cost nothing upstream; counted so the account is not billed
    // for a query this request already paid for (src/billing.js subtracts
    // these). It still counts as a logical search — the angle was covered.
    if (result.cached) state.cachedSearchCount = (state.cachedSearchCount || 0) + 1;
    emitStatus(rctx, {
      type: "search_done",
      round,
      query,
      source: "web",
      service: "Web search",
      results: result.resultCount,
      duration_ms: result.durationMs,
      sources: result.sources,
      cached: !!result.cached,
    });
    const items = labelWebItems(state, result.items);
    addSources(state, items);
    added += items.length;
    lines.push(renderItems(query, items));
  }
  return {
    text: lines.join("\n\n"),
    isError: false,
    found: added > 0,
    sourcesAdded: added,
  };
}

/**
 * The search depth one call runs at: the request's own tier, upgraded when the
 * model asked for `deep`.
 *
 * The upgrade RAISES the request's cost multiplier as well as its type, because
 * src/billing.js prices every billed search of a request at one tier
 * (`state.plan.searchDepth.costMultiplier`). A model-chosen deep leg that only
 * changed the wire argument would run at Exa's deep price and be billed at the
 * standard one — the one direction an accounting seam must never fail in.
 * @param {any} state
 * @param {any} args
 */
function resolveDepth(state, args) {
  const tier = state?.plan?.searchDepth || {};
  const numResults = typeof args.num_results === "number" ? args.num_results : tier.numResults || 5;
  if (args.depth !== "deep") return { numResults, type: tier.type || "auto" };
  if (state?.plan?.searchDepth) {
    state.plan.searchDepth = {
      ...tier,
      type: "deep",
      costMultiplier: Math.max(tier.costMultiplier || 1, DEEP_COST_MULTIPLIER),
    };
  }
  return { numResults, type: "deep" };
}

// ---------------------------------------------------------------------------
// read_pages
// ---------------------------------------------------------------------------

/**
 * Read pages the model already has URLs for.
 *
 * Two extractors, in this order, and the order is a privacy decision as much as
 * a cost one: src/named-urls.js fetches the page from its own origin — the same
 * request the user's browser would have made, carrying no conversation, no
 * identity and no referrer — while Exa's /contents is a third party and a bill.
 * So the direct read runs first and Exa only backfills what it could not
 * extract. A page neither can read is simply absent, which is what the tool
 * promises.
 *
 * @param {Env} env
 * @param {Logger} log
 * @param {any} args
 * @param {ResearchToolCtx} rctx
 * @returns {Promise<ResearchToolResult>}
 */
async function runReadPages(env, log, args, rctx) {
  const { state } = rctx;
  const urls = Array.isArray(args.urls) ? args.urls : [];
  if (!urls.length) return fail("No readable URL was given: read_pages takes absolute http(s) URLs.");

  // Rendered as a SEARCH card for the reason src/pipeline.js's named-URL reads
  // are: the pages land in the trail as the same expandable list of clickable
  // sources every other leg produces, and the client pairs start/done on
  // `source|query`, so both events carry the identical label.
  const label = `${urls.length} linked page${urls.length === 1 ? "" : "s"}`;
  const card = { round: rctx.round || 0, query: label, source: "named-urls", service: "Direct page read" };
  emitStatus(rctx, { type: "search_start", ...card });

  const started = Date.now();
  /** @type {Map<string, { title: string, url: string, text: string }>} */
  const pages = new Map();
  const direct = await readNamedUrls(env, log, urls).catch((/** @type {any} */ err) => {
    log.warn("research_tool.read_pages_failed", { error: err?.message || String(err) });
    return { items: /** @type {SearchSourceItem[]} */ ([]), durationMs: 0, attempted: urls.length };
  });
  for (const item of direct.items) {
    pages.set(item.url, { title: item.title, url: item.url, text: (item.highlights || []).join("\n\n") });
  }
  const missed = urls.filter((/** @type {string} */ u) => !pages.has(u));
  if (missed.length && env.EXA_API_KEY) {
    const backfill = await fetchContents(env, missed, log).catch(() => ({ results: [], durationMs: 0, cached: false }));
    for (const r of backfill.results) pages.set(r.url, { title: r.title || r.url, url: r.url, text: r.text });
  }

  const items = [...pages.values()].map((p) => ({
    title: p.title,
    url: p.url,
    highlights: [p.text.slice(0, MAX_PAGE_CHARS)],
  }));
  emitStatus(rctx, {
    type: "search_done",
    ...card,
    results: items.length,
    duration_ms: Date.now() - started,
    sources: items.map((i) => ({ title: i.title, url: i.url })),
  });
  if (!items.length) {
    return {
      text:
        `None of those ${urls.length} page${urls.length === 1 ? "" : "s"} could be read (refused, too slow, or not text). ` +
        "Nothing was invented in their place — search for the same material instead, or say it could not be retrieved.",
      isError: false,
      found: false,
      sourcesAdded: 0,
    };
  }
  // These pages were asked for BY NAME, so widen the registry and the digest
  // together before they are absorbed — otherwise a page the model chose to
  // read can be pushed out of the window by the search results that preceded
  // it (feedback #61, and the same pairing the named-URL leg makes).
  if (state.plan) widenPlanCapacity(state.plan, items.length);
  addSources(state, items);
  const text = items
    .map((i) => `PAGE: ${i.title}\nURL: ${i.url}\n${i.highlights[0]}`)
    .join("\n\n---\n\n");
  const absent = urls.filter((/** @type {string} */ u) => !pages.has(u));
  return {
    text: absent.length ? `${text}\n\nNOT READABLE: ${absent.join(", ")}` : text,
    isError: false,
    found: true,
    sourcesAdded: items.length,
  };
}

// ---------------------------------------------------------------------------
// source_search
// ---------------------------------------------------------------------------

/**
 * One named source, one query — the single-source shape the wave path has as
 * `runAuxSearch`, without a wave to belong to.
 *
 * `skipKeys` is derived from the source's own cross-wave ledger MINUS this
 * call's key, which admission has already committed: the source's internal
 * ladder must skip the rungs earlier calls consumed while still being allowed
 * to run the one it was just admitted for.
 *
 * @param {Env} env
 * @param {Logger} log
 * @param {any} args
 * @param {ResearchToolCtx} rctx
 * @returns {Promise<ResearchToolResult>}
 */
async function runSourceSearch(env, log, args, rctx) {
  const { state } = rctx;
  const source = SEARCH_SOURCES.find((s) => s.id === args.source);
  if (!source) return fail(`There is no source called "${String(args.source).slice(0, 40)}".`);
  const query = String(args.query || "");
  const round = rctx.round || 0;
  const key = sourceDedupKey(source, query);
  const ran = state.aux?.[source.id]?.ran;
  const skipKeys = new Set([...(ran || [])].filter((/** @type {string} */ k) => k !== key));

  emitStatus(rctx, { type: "search_start", round, query: key || query, source: source.id, service: source.service });
  const started = Date.now();
  /** @type {import('./search-sources.js').SearchSourceResult} */
  let result;
  try {
    // `asked` is the reader's own CLEAN latest message, handed to every source
    // whose FILTERING (not merely its ranking) turns on what was actually
    // asked. On this path the model composed the query, which makes the
    // distinction sharper than it was on the wave path: the query is now two
    // paraphrases away from the reader.
    result = await source.search(env, log, query, { skipKeys, asked: rctx.asked || query });
  } catch (/** @type {any} */ err) {
    log.warn(`${source.id}.search_failed`, { error: err?.message || String(err) });
    result = { items: [], durationMs: Date.now() - started, usedKeys: [] };
  }
  // A hosted dense tier costs Berget money per leg; accumulated across the
  // request so src/billing.js prices it once at the end. Read generically off
  // the result, exactly as the wave path reads it.
  mergeRetrievalSpend(state.denseTotals, result.spend);
  const items = result.items || [];
  state.aux ||= {};
  const st = (state.aux[source.id] ||= { count: 0, ran: new Set() });
  for (const k of result.usedKeys || []) st.ran.add(k);
  (state.issuedQueries ||= new Set()).add(key || query);

  emitStatus(rctx, {
    type: "search_done",
    round,
    query: key || query,
    source: source.id,
    service: source.service,
    results: items.length,
    duration_ms: result.durationMs || 0,
    sources: items.map((i) => ({ title: i.title, url: i.url })),
  });
  if (items.length && !st.reserved) {
    // The registry-capacity reserve, once per source: the web results already
    // absorbed can fill plan.maxSources before this source's items arrive, and
    // a source whose results land in overflow cannot be cited at all.
    st.reserved = true;
    if (state.plan) widenPlanCapacity(state.plan, Math.min(items.length, 8));
  }
  addSources(state, items);
  return {
    text: items.length
      ? renderItems(`${source.service}: ${query}`, items)
      : `${source.service} returned nothing for that query. That is an empty result, not a failure — the source was asked and had no match above its relevance floor. Try different terms, another source, or say the record is silent on this.`,
    isError: false,
    found: items.length > 0,
    sourcesAdded: items.length,
  };
}

// ---------------------------------------------------------------------------
// ancient_samples
// ---------------------------------------------------------------------------

/**
 * The STRUCTURED entry point the corpus core does not have: `parseSampleQuery`
 * reads a natural-language message, and there is no message here — the model
 * has already decided what to filter on and says so in arguments.
 *
 * Everything it must still do itself is the part that is not a field read: a
 * radius needs an ANCHOR, and the only gazetteer here is the corpus's own
 * sample centroids (no geocoder, by design). A location that anchors nothing
 * has to be REPORTED rather than silently dropped, because "no samples near
 * there" and "the place was never resolved" are different findings and only one
 * of them is true.
 *
 * @param {import('../public/js/aadr-core.js').SampleDataset} d
 * @param {any} args
 * @returns {import('../public/js/aadr-core.js').SampleQuery}
 */
export function sampleQueryFromArgs(d, args) {
  const a = args && typeof args === "object" ? args : {};
  /** @type {string[]} */
  const notes = [];

  /** @type {{ lat: number, lon: number, km: number, label: string } | null} */
  let near = null;
  /** @type {number[] | null} */
  let places = null;
  /** @type {number | null} */
  let country = null;
  const nearText = String(a.near || "").trim();
  if (nearText) {
    // matchEntities requires a single-word place key to be CAPITALIZED, because
    // it normally reads a sentence and place strings contain ordinary words
    // ("Above", "River Mouth"). A structured argument is not a sentence — the
    // whole string IS the place name — so the heuristic would only cost us a
    // lowercase "stockholm". Title-case it for the lookup; the dictionary match
    // itself is case-folded either way.
    const ent = matchEntities(d, nearText.replace(/(^|\s)(\p{L})/gu, (_m, s, c) => s + c.toUpperCase()));
    places = ent.places;
    country = ent.country;
    const km = numberOr(a.radius_km, DEFAULT_RADIUS_KM);
    const anchorLabel = ent.placeLabel || (ent.country !== null ? d.countryLower[ent.country] : nearText);
    const c = ent.places || ent.country !== null ? centroid(d, { places: ent.places, country: ent.country }) : null;
    if (c) {
      near = { lat: c.lat, lon: c.lon, km, label: anchorLabel };
      notes.push(`within ${km} km of ${anchorLabel} (anchored on the ${c.n} samples recorded there — no geocoder)`);
    } else {
      notes.push(
        `a proximity radius was asked for around "${nearText}" but could not be anchored: no place or country in this ` +
          "corpus matched it, and the corpus is the only gazetteer here (no geocoder)",
      );
    }
  }

  /** @type {{ from: number, to: number, label: string } | null} */
  let when = null;
  const from = numberOr(a.from_year, NaN);
  const to = numberOr(a.to_year, NaN);
  if (Number.isFinite(from) || Number.isFinite(to)) {
    const lo = Number.isFinite(from) ? from : -1_000_000;
    const hi = Number.isFinite(to) ? to : 3000;
    when = { from: Math.min(lo, hi), to: Math.max(lo, hi), label: `${year(Math.min(lo, hi))} … ${year(Math.max(lo, hi))}` };
    notes.push(`dated ${when.label}`);
  }

  const haplo = {
    y: textOr(a.y_haplogroup),
    mt: textOr(a.mt_haplogroup),
    either: /** @type {string|null} */ (null),
  };
  if (haplo.y) notes.push(`Y-haplogroup ${haplo.y}*`);
  if (haplo.mt) notes.push(`mtDNA haplogroup ${haplo.mt}*`);

  const group = textOr(a.group);
  if (group) notes.push(`population label with the segment "${group}"`);

  /** @type {1|2|null} */
  const sex = a.sex === "M" ? 1 : a.sex === "F" ? 2 : null;
  if (sex) notes.push(sex === 1 ? "genetically male" : "genetically female");

  const minCoverage = Number.isFinite(numberOr(a.min_coverage, NaN)) ? numberOr(a.min_coverage, NaN) : null;
  if (minCoverage !== null) notes.push(`coverage ≥ ${minCoverage}×`);

  const includeIgnored = a.include_ignored === true;
  if (includeIgnored) notes.push("Ignore_-flagged individuals included (normally excluded)");

  return {
    near,
    when,
    haplo,
    group: group || null,
    // A radius already restricts geography; keeping the place/country filter as
    // well ANDs two readings of the same argument and answers a far narrower
    // question than the one asked (the disambiguation note in matchEntities).
    country: near || places ? null : country,
    places: near ? null : places,
    sex,
    minCoverage,
    // Present-day reference individuals are a third of the corpus and would
    // dominate any query that did not state a date. The structured form has no
    // switch for them, so they stay out and the block says so.
    ancientOnly: true,
    includeIgnored,
    notes,
  };
}

/**
 * @param {Env} env
 * @param {Logger} log
 * @param {any} args
 * @returns {Promise<ResearchToolResult>}
 */
async function runAncientSamples(env, log, args) {
  const d = await loadSamples(env);
  if (!d) {
    return fail(
      "The ancient-sample corpus is not available on this deployment, so no rows were read. It is a build artifact, " +
        "not a service, so this will not resolve by retrying — answer from the literature instead and say the corpus was not consulted.",
    );
  }
  const q = sampleQueryFromArgs(d, args);
  const limit = Math.max(1, Math.min(100, numberOr(args.limit, 30)));
  const res = querySamples(d, q, { limit });
  log.info("research_tool.ancient_samples", { matched: res.total, rows: res.rows.length });
  return { text: sampleBlock(d, q, res), isError: false, found: res.total > 0, sourcesAdded: 0 };
}

// ---------------------------------------------------------------------------
// run_python
// ---------------------------------------------------------------------------

/**
 * Run a program in the execution environment bound to this request.
 *
 * There is NO Worker-side Python and this function will not invent one. The
 * three environments are the browser VM, a runner on the user's own machine and
 * — on Se/rver only, because it is the one with the server in the data path —
 * an ephemeral cloud container (docs/EXECUTION-ENVIRONMENTS.md). The first two
 * are browser-direct: a Worker in the middle of an answer cannot reach them, so
 * when neither the caller nor this deploy binds one, the honest result is a
 * sentence saying nothing ran.
 *
 * @param {Env} env
 * @param {Logger} log
 * @param {any} args
 * @param {ResearchToolCtx} rctx
 * @returns {Promise<ResearchToolResult>}
 */
async function runPython(env, log, args, rctx) {
  const source = String(args.source || "");
  if (!source.trim()) return fail("run_python needs a program in `source`. Print what you want to see.");
  const exec = execEnvironmentFor(env, log, rctx);
  if (!exec) {
    return fail(
      "No execution environment is bound to this request, so the program was not run and nothing was computed. " +
        "Python here runs in a Linux sandbox — in the reader's browser, on their own machine, or in a cloud container " +
        "this deploy does not carry — and none of those is reachable from inside this answer. Do the arithmetic in " +
        "the answer instead, and say which figures you computed by hand.",
    );
  }

  /** @type {Array<{ engine: string, exitCode: number, stdout: string, stderr: string, refusal: ReturnType<typeof parseRefusalLine> }>} */
  const runs = [];
  let engine = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const command = pythonCommand(source, { engine, stdin: String(args.stdin || "") });
    const res = await exec.run(command, { timeoutMs: STEP_BUDGET_MS }).catch((/** @type {any} */ err) => ({
      exitCode: 1,
      stdout: "",
      stderr: String(err?.message || err),
    }));
    const stderr = String(res.stderr || "");
    const ran = /^drpy-engine:(\S+)/m.exec(stderr);
    const cleanErr = stderr.replace(/^drpy-engine:\S+\n?/m, "");
    const used = ran ? ran[1] : "unknown";
    const refusal = res.exitCode === REFUSAL_EXIT ? parseRefusalLine(cleanErr.trim().split("\n")[0] || "") : null;
    runs.push({ engine: used, exitCode: res.exitCode, stdout: String(res.stdout || ""), stderr: cleanErr, refusal });
    // A refusal is a FORK, not a wall: the engine exited 90 having run nothing
    // and written nothing to stdout, so retrying the identical program on
    // CPython is always safe and always correct. Anything else — an answer, a
    // traceback, a timeout — is the program's own result and is returned as it
    // is.
    if (res.exitCode !== REFUSAL_EXIT || used === "python3") break;
    engine = "python3";
  }
  log.info("research_tool.run_python", {
    where: exec.label,
    engines: runs.map((r) => r.engine),
    exit_code: runs[runs.length - 1].exitCode,
  });
  return {
    text: formatPythonResult(runs, exec.label),
    isError: runs[runs.length - 1].exitCode !== 0,
    found: true,
    sourcesAdded: 0,
  };
}

/**
 * The execution environment this request can reach, or null.
 * @param {Env} env
 * @param {Logger} log
 * @param {ResearchToolCtx} rctx
 * @returns {{ label: string, run: (command: string, opts: { timeoutMs: number }) => Promise<{ exitCode: number, stdout: string, stderr: string }> } | null}
 */
export function execEnvironmentFor(env, log, rctx) {
  // A caller that already holds a DREE/1 runner (the client tier's browser VM,
  // a runner on the user's own machine) passes it in. It wins over anything
  // this server could offer, which is the privacy-preserving direction:
  // browser-direct environments keep the program, its stdin and its output off
  // this server entirely.
  if (typeof rctx?.exec === "function") {
    return { label: rctx.execLabel || "the runner bound to this request", run: rctx.exec };
  }
  if (execContainerAvailable(env, rctx?.identity)) {
    const session = sanitizeSession(rctx?.requestId) || "research";
    return {
      label: "an ephemeral cloud container",
      run: async (command, opts) => {
        // The same DREE/1 wire the local runner and the browser VM speak, at
        // this deploy's same-origin base. Reached through the endpoint rather
        // than through the Durable Object stub so there is exactly one place
        // that knows how to drive a container.
        const url = new URL("https://internal/api/exec/exec");
        const request = new Request(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ command, session, timeoutMs: opts.timeoutMs }),
        });
        const resp = await handleExecApi(request, env, url, log, rctx?.identity);
        const body = /** @type {any} */ (await resp.json().catch(() => null));
        return {
          exitCode: typeof body?.exitCode === "number" ? body.exitCode : 1,
          stdout: String(body?.stdout || ""),
          stderr: String(body?.stderr || body?.error || ""),
        };
      },
    };
  }
  return null;
}

/**
 * The shell program that runs one Python program.
 *
 * Three things it must get right, all of them paid for already:
 *
 *  · **Probe, never assume.** The stock sandbox image has CPython only; an
 *    image built by scripts/build-sandbox-image.sh also has lypning. Resolving
 *    the engine INSIDE the command costs one round trip instead of two and
 *    cannot go stale between the probe and the run.
 *  · **Say which engine answered.** The marker line on stderr is stripped
 *    before the model sees the output; without it a subset refusal and a
 *    CPython answer are indistinguishable, which is the whole value of the
 *    refusal contract.
 *  · **Never cross the ceiling.** A command that crosses the VM's exec ceiling
 *    does not fail, it DESTROYS the VM (EXEC_CEILING_MS). Every program is run
 *    under `timeout` with its own budget, well inside it.
 *
 * @param {string} source
 * @param {{ engine?: string, stdin?: string, budgetMs?: number }} [opts]
 * @returns {string}
 */
export function pythonCommand(source, opts = {}) {
  const budgetMs = Math.min(opts.budgetMs || STEP_BUDGET_MS, EXEC_CEILING_MS - 5_000);
  const seconds = Math.max(1, Math.round(budgetMs / 1000));
  const engines = opts.engine ? [opts.engine] : ENGINE_ORDER;
  const probe = engines.map((e) => `command -v ${e} 2>/dev/null`).join(" || ");
  const src = heredoc("DRPY_SRC", source);
  const stdin = opts.stdin ? heredoc("DRPY_IN", opts.stdin) : null;
  return [
    `E=$(${probe})`,
    `[ -n "$E" ] || { echo "no Python interpreter is installed in this sandbox" >&2; exit 127; }`,
    `printf 'drpy-engine:%s\\n' "\${E##*/}" >&2`,
    `P=/tmp/drpy-$$.py`,
    `cat >"$P" ${src}`,
    stdin ? `timeout ${seconds} "$E" "$P" ${stdin}` : `timeout ${seconds} "$E" "$P" </dev/null`,
    `S=$?`,
    `rm -f "$P"`,
    `exit $S`,
  ].join("\n");
}

/**
 * A quoted heredoc, with the one guard it needs: a body containing its own
 * delimiter would end the document early and the rest of the program would be
 * executed as shell. The delimiter is extended until it does not occur in the
 * body, which always terminates.
 * @param {string} tag
 * @param {string} body
 * @returns {string}
 */
function heredoc(tag, body) {
  let delim = tag;
  while (body.includes(delim)) delim += "_X";
  return `<<'${delim}'\n${body.replace(/\n$/, "")}\n${delim}`;
}

/**
 * lypning's refusal line: `<engine>: unsupported: <kind>: <detail>`, one line on
 * stderr with nothing on stdout. Null for anything else — a traceback is the
 * program's own failure, not the engine's refusal, and confusing the two would
 * retry a program that already answered.
 * @param {string} line
 * @returns {{ engine: string, kind: string, detail: string } | null}
 */
export function parseRefusalLine(line) {
  const m = /^([A-Za-z0-9_-]+):\s*unsupported:\s*([^:]+):\s*(.*)$/.exec(String(line || "").trim());
  return m ? { engine: m[1], kind: m[2].trim(), detail: m[3].trim() } : null;
}

/**
 * What the model reads back. It states WHICH engine answered and, when the
 * first one refused, why — so a subset gap costs a fallback the model can see
 * rather than a mystery. A generic "python failed" would throw the refusal
 * contract away.
 * @param {Array<{ engine: string, exitCode: number, stdout: string, stderr: string, refusal: { engine: string, kind: string, detail: string } | null }>} runs
 * @param {string} where
 * @returns {string}
 */
export function formatPythonResult(runs, where) {
  const out = [];
  const last = runs[runs.length - 1];
  for (const r of runs.slice(0, -1)) {
    out.push(
      r.refusal
        ? `${r.engine} refused this program (${r.refusal.kind}: ${r.refusal.detail}) and ran nothing, so it was retried on the next interpreter.`
        : `${r.engine} exited ${r.exitCode}; retried on the next interpreter.`,
    );
  }
  out.push(`Ran on ${last.engine} in ${where}. Exit code ${last.exitCode}.`);
  if (last.exitCode === 124) {
    out.push("The program was killed for running past its time budget — nothing was returned. Make it cheaper, not longer.");
  }
  const stdout = last.stdout.slice(0, MAX_OUTPUT_CHARS);
  const stderr = last.stderr.slice(0, MAX_OUTPUT_CHARS);
  out.push(`STDOUT:\n${stdout || "(empty)"}`);
  if (stderr.trim()) out.push(`STDERR:\n${stderr}`);
  return out.join("\n");
}

// ---------------------------------------------------------------------------
// the two families that already have runners
// ---------------------------------------------------------------------------

/**
 * @param {Env} env
 * @param {Logger} log
 * @param {string} name
 * @param {any} args
 * @param {ResearchToolCtx} rctx
 * @returns {Promise<ResearchToolResult>}
 */
async function runLiterature(env, log, name, args, rctx) {
  const { runLiteratureTool } = await import("./literature-run.js");
  const r = await runLiteratureTool(env, log, name, args, {
    identity: rctx?.identity || null,
    requestId: rctx?.requestId || null,
  });
  return { text: r.text, isError: r.isError, found: (r.records || 0) > 0, sourcesAdded: 0 };
}

/**
 * @param {Env} env
 * @param {Logger} log
 * @param {string} name
 * @param {any} args
 * @param {ResearchToolCtx} rctx
 * @returns {Promise<ResearchToolResult>}
 */
async function runExtension(env, log, name, args, rctx) {
  const { runExtensionTool } = await import("./extension-tools-run.js");
  const r = await runExtensionTool(env, log, name, args, {
    identity: rctx?.identity || null,
    requestId: rctx?.requestId || "",
  });
  return { text: r.text, isError: r.isError, found: r.found, sourcesAdded: 0 };
}

// ---------------------------------------------------------------------------
// shared shaping
// ---------------------------------------------------------------------------

/**
 * Results as the model reads them. Numbered per call rather than by registry
 * position: the registry's [n] is assigned in absorption order and is what the
 * WRITER cites, while the loop only needs to tell one result from another.
 * @param {string} heading
 * @param {SearchSourceItem[]} items
 * @returns {string}
 */
function renderItems(heading, items) {
  if (!items.length) {
    return `${heading}\n(no results — the provider was asked and found nothing)`;
  }
  const lines = items.map((item, i) => {
    const highlights = (item.highlights || []).join(" … ").slice(0, 1200);
    return `${i + 1}. ${item.title}\n   ${item.url}${highlights ? `\n   ${highlights}` : ""}`;
  });
  return `${heading}\n${lines.join("\n")}`;
}

/**
 * @param {ResearchToolCtx} rctx
 * @param {Record<string, unknown>} status
 */
function emitStatus(rctx, status) {
  if (typeof rctx?.emit === "function") rctx.emit({ status });
}

/** @param {unknown} v @param {number} fallback */
function numberOr(v, fallback) {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

/** @param {unknown} v */
function textOr(v) {
  const s = typeof v === "string" ? v.trim() : "";
  return s || null;
}

/** @param {string} message @returns {ResearchToolResult} */
function fail(message) {
  return { text: message, isError: true, found: false, sourcesAdded: 0 };
}
