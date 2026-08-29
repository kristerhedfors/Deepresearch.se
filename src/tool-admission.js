// @ts-check
// TOOL ADMISSION — the server-side check every model-issued tool call passes
// before anything runs.
//
// This is the module the amended invariant 1 rests on. The answer phase may
// drive a tool loop, but the model chooses only the ORDER of calls inside a
// toolbox that was fixed before it ran: the classes come from the agent's
// declared `capability.tools` through src/tool-sets.js, and then every
// individual call arrives here and is re-checked against the SAME policy the
// deterministic phases enforced — the context-block declaration, the account's
// extension knob, the search policy, the source registry's own caps, the
// request's budget, and finally the arguments themselves.
//
// It is a dedicated module rather than a branch inside the engine for one
// reason: docs/WORKSPACES.md §4.7 makes a SECURITY claim about what a request
// can reach, and a claim that lives in prose is not a claim. Everything below is
// pinned in src/tool-admission.test.js.
//
// ---- two rules that are easy to get backwards ------------------------------
//
//  1. **A refusal is a SENTENCE, never a throw.** The caller is a tool loop
//     mid-answer; an exception there costs the whole turn, while a sentence is
//     something the model reads and routes around. Invariant 2, at the call
//     layer.
//  2. **The NULL-capability asymmetry.** A request that resolved no agent (the
//     MCP channel, an unreadable registry) KEEPS every search source and LOSES
//     every declared context block. Those two directions look inconsistent and
//     are not: src/search-sources.js's `capabilityAllowsSource` opens the
//     corpus door because the alternative is an outage that reads as an empty
//     answer, and src/enrichment.js's `capHasContext` closes the third-party
//     door because "no agent was resolved" must never widen into third-party
//     reach. Getting either backwards is a real defect, so both are asserted in
//     both directions.
//
// ---- checks are ORDERED; the commit happens ONCE ---------------------------
//
// The eight checks run in a fixed order, cheapest and most conclusive first, so
// a refusal message names the FIRST reason a call is not allowed rather than
// whichever reason happened to be tested. Nothing is committed until the last
// one passes: an admitted call has spent its slot in every ledger (the query
// dedup set, the per-source counter, the tool budget), a refused one has spent
// none. The alternative — commit as you go — makes a late refusal charge the
// request for a search it never ran.

import { capHasContext } from "./agent-spec.js";
import { SEARCH_SOURCES, capabilityAllowsSource } from "./search-sources.js";
import { extensionOffMessage } from "./extension-tools.js";
import { fitsDeadline } from "./budget.js";
import { takeSearchBatch } from "./pipeline-inputs.js";
import {
  MAX_READ_URLS,
  MAX_SAMPLE_ROWS,
  MAX_WEB_QUERIES,
  RESEARCH_SPENDING_TOOLS,
  RESEARCH_TOOL_CONTEXT,
  RESEARCH_TOOL_EXTENSION,
  RESEARCH_TOOL_NAMES,
} from "./research-tools.js";

/** @typedef {import('./agent-spec.js').AgentCapability} AgentCapability */
/** @typedef {{ searches: number, reads: number, spendCalls: number, perSource: Map<string, number>, stop?: boolean }} ToolBudget */
/** @typedef {{ ok: true, args: any } | { ok: false, message: string }} Admission */

/**
 * A single argument that reaches a third party may be no longer than this.
 *
 * Invariant 4 at the ARGUMENT layer, and this is the layer that needs it: the
 * privacy model promises an outbound request carries the minimum — a query, a
 * coordinate, a host — and never the conversation. On the deterministic path
 * that was structurally true, because a query was written by a planner into a
 * fixed schema. A model composing tool arguments out of the conversation is
 * exactly the mechanism that can defeat it, by pasting the conversation into a
 * "query". Nothing else in the system checks this.
 */
export const MAX_QUERY_CHARS = 300;
/** URLs one read_pages call may name. */
export const MAX_URLS_PER_CALL = MAX_READ_URLS;
/** Calls to a metered upstream one run may make, across every spending tool.
 * The ceiling on what one answer can cost when the model, not the planner,
 * decides how many searches it wants. */
export const MAX_SPENDING_CALLS = 6;
/** A program is not an outbound argument, so it is bounded for size rather than
 * scrubbed for content: it runs in the sandbox the request already has, and
 * nothing about it reaches a third party. */
export const MAX_PROGRAM_CHARS = 10_000;
export const MAX_STDIN_CHARS = 20_000;
/** A short structured filter (a place, a haplogroup, a population segment).
 * Long enough for "volga river valley", short enough that a conversation cannot
 * be smuggled through one. */
export const MAX_FILTER_CHARS = 80;
/** What one tool call is assumed to cost when the plan carries no estimate —
 * used only for the deadline check, where being roughly right early beats being
 * exactly right too late. */
export const ASSUMED_TOOL_MS = 6_000;

/**
 * A fresh per-run tool budget. Separate from `plan` because a plan is a
 * FORECAST (what this request may spend) and a budget is a LEDGER (what it has
 * spent); merging them means a retried run silently inherits the last one's
 * spend.
 *
 * `plan` is accepted and deliberately unused: a budget is created at the one
 * place the request's forecast is already in hand, and taking it here keeps
 * that call site honest — but nothing in the ledger is DERIVED from it, because
 * deriving a spent-so-far from a forecast is the exact merge this split exists
 * to prevent.
 * @param {any} [plan]
 * @returns {ToolBudget}
 */
export function newToolBudget(plan) {
  void plan;
  return { searches: 0, reads: 0, spendCalls: 0, perSource: new Map() };
}

/**
 * The cross-wave dedup key for a query against one source — the source's own
 * normalizer where it has one, a lowercased trim otherwise. Exported because
 * admission COMMITS the key and the runner has to derive the same one to build
 * that call's `skipKeys`; two spellings of this would let a source re-fetch the
 * result set it just returned.
 * @param {import('./search-sources.js').SearchSource} source
 * @param {string} query
 * @returns {string}
 */
export function sourceDedupKey(source, query) {
  return source?.dedupKey ? source.dedupKey(query) : String(query || "").toLowerCase().trim();
}

/**
 * Is this extension's knob on for this request?
 *
 * Reads the one field every descriptor's own `enabled` predicate reads
 * (src/extensions.js: `enabled: (slice) => !!slice.on`), off the request's
 * `state.ext` bag, which src/chat.js resolves from the account's settings
 * before the loop starts. Read here rather than through the registry because
 * admission must answer synchronously and stay clear of the provider graph
 * src/extensions.js pulls in; pinned against the descriptors themselves in
 * src/tool-admission.test.js so the two cannot drift.
 *
 * A state with no `ext` bag has no extensions on, which is the safe direction:
 * a channel that applies no per-account knobs reaches no third party.
 * @param {any} state
 * @param {string} id
 * @returns {boolean}
 */
export function extensionSliceOn(state, id) {
  return state?.ext?.[id]?.on === true;
}

/**
 * Admit — or refuse in words — one model-issued tool call.
 *
 * @param {string} name
 * @param {any} args as the model composed them: untrusted, unshaped, unbounded.
 * @param {{
 *   state: any,
 *   env?: any,
 *   identity?: any,
 *   budget: ToolBudget,
 *   plan?: any,
 *   policy?: { web?: boolean, auxSources?: boolean, maxQueries?: number|null },
 *   tools?: Array<{ name: string }> | string[] | null,
 *   now?: number,
 * }} opts `tools` is the run's RESOLVED toolbox and is required in effect —
 *   omitting it admits nothing, never everything (see check 1).
 * @returns {Admission}
 */
export function admitToolCall(name, args, opts) {
  const state = opts?.state || {};
  const budget = opts?.budget || newToolBudget(opts?.plan);
  const plan = opts?.plan || state.plan || {};
  const policy = opts?.policy || {};
  const cap = /** @type {AgentCapability|null} */ (state.capability ?? null);
  const given = args && typeof args === "object" ? args : {};

  // ---- 1. is this tool in the resolved toolbox at all? ---------------------
  // Two questions, not one: the registry decides whether the NAME exists, the
  // run's resolved list decides whether this agent was handed it. A model that
  // hallucinates a tool gets the first answer; a model repeating a tool from an
  // earlier conversation gets the second.
  //
  // An OMITTED `tools` admits NOTHING. It read `if (opts?.tools && …)` first,
  // which made a forgotten argument open the whole registry to the call — the
  // one mistake at this layer that cannot be seen at the call site, because a
  // caller that forgets it gets more reach rather than an error. Defaulting to
  // an empty set inverts that: forgetting it costs the run its tools, which
  // fails loudly in the answer and reaches nothing at all.
  if (!RESEARCH_TOOL_NAMES.has(name)) {
    return refuse(
      `There is no tool called "${String(name).slice(0, 60)}" on this server. Use one of the tools you were given, or answer from what you already have.`,
    );
  }
  if (!resolvedNames(opts?.tools).has(name)) {
    return refuse(
      `The ${name} tool exists on this server but is not part of this run's toolbox, so it was not called. Retrying will not change that — use the tools you were given.`,
    );
  }

  // ---- 2. the context block the answering agent must declare ---------------
  const block = RESEARCH_TOOL_CONTEXT[name] || null;
  if (block && !capHasContext(cap, block)) {
    return refuse(
      `The ${name} tool needs the "${block}" capability and this agent does not carry it, so nothing was looked up. ` +
        `This is a standing property of the agent, not a transient failure: retrying will not help, and no other tool call will unlock it.`,
    );
  }

  // ---- 3. the account knob that consents to reaching a third party ---------
  const extension = RESEARCH_TOOL_EXTENSION[name];
  if (extension && !extensionSliceOn(state, extension)) {
    return refuse(extensionOffMessage(name));
  }

  // ---- 4. the request's search policy --------------------------------------
  // The agent's declared ceiling ANDed with what the caller asked for
  // (searchPolicyFor). A knob that is off stays off however the model phrases
  // the call.
  if (name === "web_search" && policy.web === false) {
    return refuse(
      "Web search is switched off for this request, so no query was sent. The other sources you were given are unaffected — use them, or answer from what you have and say the open web was not consulted.",
    );
  }
  if (name === "source_search" && policy.auxSources === false) {
    return refuse(
      "The specialist sources are not available on this request, so nothing was searched. Use the other tools you were given.",
    );
  }

  // ---- 5. may this agent consult the source it named? ----------------------
  /** @type {import('./search-sources.js').SearchSource | null} */
  let source = null;
  if (name === "source_search") {
    const id = String(given.source || "").trim();
    source = SEARCH_SOURCES.find((s) => s.id === id) || null;
    if (!source) {
      return refuse(
        `There is no source called "${id.slice(0, 40) || "(none given)"}". The sources on this server are: ${SEARCH_SOURCES.map((s) => s.id).join(", ")}.`,
      );
    }
    // The null capability KEEPS the source here — see the header's asymmetry
    // note, and capabilityAllowsSource's own comment for why an unaddressed
    // request must still reach the corpora.
    if (!capabilityAllowsSource(cap, source)) {
      return refuse(
        `The ${source.id} source (${source.service}) belongs to another agent on this server and was not searched. That is a standing division of the corpora, not a failure — use the sources you do have, and say which record the answer rests on.`,
      );
    }
    if (!String(given.query || "").trim()) {
      return refuse(`A ${source.id} search needs a query. Ask it in natural language — this source retrieves by meaning.`);
    }
  }

  // ---- 6. the source's own caps, the cross-wave dedup, the query budget ----
  /** @type {string[]} */
  let batch = [];
  /** @type {() => void} */
  let undo = () => {};
  /** @type {string} */
  let sourceKey = "";
  if (name === "web_search") {
    const queries = scrubQueries(given.queries, policy.maxQueries);
    if (!queries.length) {
      return refuse("A web search needs at least one query. Send up to four distinct angles in one call — they run in parallel.");
    }
    // takeSearchBatch is the wave path's own gate: it drops queries this
    // request already ran and stops at plan.maxSearches. Calling it here rather
    // than reimplementing the rule is the point — a model-issued search is
    // budgeted and deduped exactly like a planned one.
    // Called through a defensive view of the state rather than the state
    // itself: `ranQueries` is shared by reference, so the dedup commit is real,
    // but a request that arrived without a plan (a caller mid-refactor, a test)
    // gets an unbounded ceiling instead of a TypeError out of a function whose
    // whole contract is that it refuses in words.
    const ranQueries = state.ranQueries instanceof Set ? state.ranQueries : (state.ranQueries = new Set());
    batch = takeSearchBatch(
      { ranQueries, searchCount: state.searchCount || 0, plan: { maxSearches: plan.maxSearches ?? Infinity } },
      queries,
      MAX_WEB_QUERIES,
    );
    // takeSearchBatch is the one check that WRITES as it decides (it records
    // the queries in state.ranQueries so a later wave cannot repeat them), so
    // the commit-once rule needs an undo for the checks that follow it.
    // Without one, a call refused for being out of budget would still have
    // burned its angles' dedup slots, and the same angle could never be asked
    // again on a request that later had room for it.
    undo = () => {
      for (const query of batch) state.ranQueries.delete(query.toLowerCase());
    };
    if (!batch.length) {
      const spent = (state.searchCount || 0) >= (plan.maxSearches ?? Infinity);
      return refuse(
        spent
          ? `The search budget for this answer is spent (${state.searchCount} of ${plan.maxSearches}). Read what you already have, or answer from it and say where the evidence stops.`
          : "Every one of those queries was already searched on this request, so nothing new was sent. Ask a genuinely different angle, read one of the sources you already have, or answer.",
      );
    }
  }
  if (source) {
    const st = state.aux?.[source.id];
    const override = state.auxMaxPerRequest?.[source.id];
    const perRequestCap = typeof override === "number" && override > 0 ? override : (source.maxPerRequest ?? 3);
    const used = st?.count || 0;
    if (used >= perRequestCap) {
      // arXiv's cap is 2 because arXiv publishes one request per three seconds
      // and sells no way past it; the number is the source's, stated here so
      // the model reads a reason rather than a wall.
      return refuse(
        `${source.service} allows ${perRequestCap} search${perRequestCap === 1 ? "" : "es"} per request and this run has used ${used}. That ceiling is the source's own rate limit, not a budget you can spend elsewhere — use what came back, or another source.`,
      );
    }
    sourceKey = sourceDedupKey(source, String(given.query || ""));
    if (st?.ran?.has(sourceKey)) {
      return refuse(
        `That ${source.service} search was already run on this request and returned what it had. Re-running it fetches the identical result set — ask a different angle, or use what is already in the sources list.`,
      );
    }
  }

  // ---- 7. the run's tool budget and its deadline ---------------------------
  const spends = RESEARCH_SPENDING_TOOLS.has(name);
  if (spends && budget.spendCalls >= MAX_SPENDING_CALLS) {
    undo();
    return refuse(
      `This answer's tool budget is spent: ${budget.spendCalls} of ${MAX_SPENDING_CALLS} calls to a paid source have been made. The free tools you were given still work; otherwise write the answer from what you have and say what you could not check.`,
    );
  }
  if (!withinDeadline(state, plan, opts?.now)) {
    undo();
    return refuse(
      "The time budget for this answer is nearly spent, so no further lookup was made. Write the answer now from what you have, and say plainly what is missing.",
    );
  }

  // ---- 8. the arguments themselves ----------------------------------------
  const scrubbed = scrubArgs(name, given, { queries: batch, maxQueries: policy.maxQueries });

  // ---- commit -------------------------------------------------------------
  // Everything above passed, so this call is happening: charge it once, here.
  if (spends) budget.spendCalls++;
  if (name === "web_search") budget.searches += batch.length;
  if (name === "read_pages") budget.reads += (scrubbed.urls || []).length;
  if (source) {
    state.aux ||= {};
    const st = (state.aux[source.id] ||= { count: 0, ran: new Set() });
    st.count++;
    st.ran.add(sourceKey);
    budget.searches++;
    budget.perSource.set(source.id, (budget.perSource.get(source.id) || 0) + 1);
  }
  return { ok: true, args: scrubbed };
}

/**
 * Argument scrubbing — invariant 4 at the argument layer, per tool.
 *
 * Everything that can reach a third party is trimmed, newline-collapsed and cut
 * at MAX_QUERY_CHARS; everything that stays on this platform is bounded for
 * size alone. Cutting rather than refusing is deliberate: a model that pasted
 * too much into a query still gets a search, and the search still carries only
 * a query.
 *
 * @param {string} name
 * @param {any} args
 * @param {{ queries?: string[], maxQueries?: number|null }} [pre] values an
 *   earlier check already resolved (the deduped web batch), so they are not
 *   computed twice with two chances to differ.
 * @returns {any}
 */
export function scrubArgs(name, args, pre = {}) {
  const given = args && typeof args === "object" ? args : {};
  switch (name) {
    case "web_search":
      return {
        queries: pre.queries?.length ? pre.queries : scrubQueries(given.queries, pre.maxQueries),
        depth: given.depth === "deep" ? "deep" : "auto",
        num_results: clampNumber(given.num_results, 1, 10, 5),
      };
    case "read_pages":
      return { urls: scrubUrls(given.urls) };
    case "source_search":
      return { source: String(given.source || "").trim(), query: clampText(given.query, MAX_QUERY_CHARS) };
    case "run_python":
      // NOT clamped to MAX_QUERY_CHARS: a program is not an outbound argument.
      // It runs in the execution environment bound to this request and no part
      // of it reaches a third party, so the bound here is about the sandbox's
      // stdin, not about privacy.
      return { source: clampText(given.source, MAX_PROGRAM_CHARS, { keepNewlines: true }), stdin: clampText(given.stdin, MAX_STDIN_CHARS, { keepNewlines: true }) };
    case "ancient_samples":
      return {
        near: clampText(given.near, MAX_FILTER_CHARS),
        radius_km: clampNumber(given.radius_km, 1, 20_000, undefined),
        from_year: clampNumber(given.from_year, -1_000_000, 3000, undefined),
        to_year: clampNumber(given.to_year, -1_000_000, 3000, undefined),
        y_haplogroup: clampText(given.y_haplogroup, MAX_FILTER_CHARS),
        mt_haplogroup: clampText(given.mt_haplogroup, MAX_FILTER_CHARS),
        group: clampText(given.group, MAX_FILTER_CHARS),
        sex: given.sex === "M" || given.sex === "F" ? given.sex : "",
        min_coverage: clampNumber(given.min_coverage, 0, 1000, undefined),
        include_ignored: given.include_ignored === true,
        limit: clampNumber(given.limit, 1, MAX_SAMPLE_ROWS, 30),
      };
    default: {
      // The literature and extension families own their own argument parsing
      // (src/literature-tools.js, src/shodan-tools.js, src/maps-tools.js), so
      // the only thing to add here is the outbound clamp their parsers do not
      // make: every string that could carry a conversation is cut to a query's
      // length before it leaves.
      /** @type {any} */
      const out = {};
      for (const [k, v] of Object.entries(given)) {
        if (typeof v === "string") out[k] = clampText(v, MAX_QUERY_CHARS);
        else if (Array.isArray(v)) out[k] = v.slice(0, 20).map((e) => (typeof e === "string" ? clampText(e, MAX_QUERY_CHARS) : e));
        else out[k] = v;
      }
      return out;
    }
  }
}

/**
 * One outbound string: newlines collapsed to spaces, trimmed, cut to `max`.
 *
 * The cut is by CODE POINT, not by UTF-16 unit — `String.prototype.slice` on a
 * surrogate pair leaves half a character, and a query ending in half an emoji
 * or half a CJK character is a query no index matches. Swedish å/ä/ö are single
 * units and survive either way; this is the general case behind them.
 * @param {unknown} value
 * @param {number} max
 * @param {{ keepNewlines?: boolean }} [opts]
 * @returns {string}
 */
export function clampText(value, max, opts = {}) {
  if (typeof value !== "string") return "";
  const flat = opts.keepNewlines ? value : value.replace(/\s+/g, " ");
  const trimmed = flat.trim();
  const points = [...trimmed];
  return points.length <= max ? trimmed : points.slice(0, max).join("").trim();
}

/**
 * The web queries a call may carry: non-empty, scrubbed, deduped
 * case-insensitively within the call, and capped by the tool's own fan-out
 * bound ANDed with any agent-declared `maxQueries`.
 *
 * Case folding is `toLowerCase()`, which is Unicode-aware — "Vad är
 * kvantdatorer" and "vad är kvantdatorer" are one query here, exactly as they
 * are in `takeSearchBatch`. (The trap this avoids is the other one: a `\b`-
 * anchored regex, whose word boundary is ASCII-only and silently fails on
 * every Swedish word — invariant 6.)
 * @param {unknown} value
 * @param {number|null} [maxQueries]
 * @returns {string[]}
 */
export function scrubQueries(value, maxQueries = null) {
  const list = Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
  const cap = Math.max(1, Math.min(MAX_WEB_QUERIES, typeof maxQueries === "number" && maxQueries > 0 ? maxQueries : MAX_WEB_QUERIES));
  /** @type {string[]} */
  const out = [];
  const seen = new Set();
  for (const raw of list) {
    const q = clampText(raw, MAX_QUERY_CHARS);
    if (!q) continue;
    const key = q.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(q);
    if (out.length >= cap) break;
  }
  return out;
}

/**
 * The URLs a read_pages call may carry: absolute http(s) only, deduped, capped.
 * A relative or non-http URL is dropped rather than refused — the call still
 * reads the pages that were usable, which is what the tool promises.
 * @param {unknown} value
 * @returns {string[]}
 */
export function scrubUrls(value) {
  const list = Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
  /** @type {string[]} */
  const out = [];
  const seen = new Set();
  for (const raw of list) {
    const u = String(raw || "").trim();
    if (!/^https?:\/\//i.test(u)) continue;
    if (seen.has(u)) continue;
    seen.add(u);
    out.push(u);
    if (out.length >= MAX_URLS_PER_CALL) break;
  }
  return out;
}

/**
 * @param {unknown} value
 * @param {number} min
 * @param {number} max
 * @param {number|undefined} fallback
 * @returns {number|undefined}
 */
function clampNumber(value, min, max, fallback) {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/**
 * Is there time left for another lookup? Prefers the plan's own deadline where
 * one is set, falls back to the request's start plus its budget, and — when
 * neither is known — says yes. Fail-soft: an unknown deadline must not stop a
 * run that was going to finish (invariant 2).
 * @param {any} state
 * @param {any} plan
 * @param {number} [now]
 * @returns {boolean}
 */
function withinDeadline(state, plan, now = Date.now()) {
  const upcoming = plan?.estimates?.search || ASSUMED_TOOL_MS;
  if (typeof plan?.deadlineAt === "number") return now + upcoming <= plan.deadlineAt;
  if (typeof state?.startedAt === "number" && typeof plan?.budgetMs === "number") {
    return fitsDeadline(state.startedAt, plan.budgetMs, upcoming);
  }
  return true;
}

/**
 * The names in a run's resolved toolbox. Anything that is not an array — an
 * omitted list included — is the EMPTY set, which is what makes check 1 fail
 * closed rather than open.
 * @param {Array<{ name: string }> | string[] | null | undefined} tools
 * @returns {Set<string>}
 */
function resolvedNames(tools) {
  return new Set((Array.isArray(tools) ? tools : []).map((t) => (typeof t === "string" ? t : t?.name)).filter(Boolean));
}

/** @param {string} message @returns {Admission} */
function refuse(message) {
  return { ok: false, message };
}
