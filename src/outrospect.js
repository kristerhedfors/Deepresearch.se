// @ts-check
// OUTROSPECTION — the Worker façade over the ONE shared core
// public/js/outrospect-core.js (the lens registry, the item shape, the delta,
// the merge), plus the three endpoints the domain owns.
//
// Introspection answers "what am I made of" from a committed snapshot of this
// repo. Outrospection answers the opposite question — "what is everyone else
// building, and does it change what I should be" — from the live web, through
// seven fixed lenses (see the core's header for why each one exists).
//
//   GET  /api/outrospect/feed      the live stream: every item a scan or a
//                                  visitor refresh has ever added, newest
//                                  first. ?lens= ?since= ?limit= ?format=text
//   POST /api/outrospect/refresh   run the searches for ONE lens on behalf of
//                                  the visiting user, store the delta, return
//                                  the genuinely new items. This is the
//                                  "while you are here, go look" call the view
//                                  fires on load.
//   GET  /api/admin/outrospect     the operator read surface (admin-gated in
//                                  admin-api.js): the feed plus the run log,
//                                  chatlogs-style, with ?format=text for the
//                                  agent loop.
//
// The feed the user READS is the merge of two streams (core mergeFeed):
// the committed artifact public/outrospect/feed.json — written by
// scripts/outrospect-scan.mjs, so the feed is never empty and works with no
// D1 at all — and the D1 `outrospect_items` rows added since. The client does
// that merge (it already has the artifact as a static asset), which keeps the
// Worker out of the asset-reading business and puts the merge in the pure,
// unit-tested core.
//
// Privacy posture (invariant 4): a refresh sends a QUERY to the search
// provider and nothing else — no identity, no conversation, no note the user
// wrote. The queries are the literal strings committed in the lens registry,
// so what leaves the site is auditable in git. The stored row carries the
// article, never the reader: `outrospect_items` has NO user column at all, and
// neither does `outrospect_texts` (the fetched article BODIES — see the
// indexing section below). The run log records who spent a search only because
// the rate limit needs it, and carries no query text beyond the lens id.
// Choosing which stored passage answers a question is a local lexical scan, so
// the reader's question never leaves the isolate either.
//
// Fail posture (invariant 2): every search is fail-soft — a dead provider
// yields zero new items and an ok response, never a 500. No D1 → 503 on the
// two D1-backed endpoints and the VIEW keeps working off the committed
// artifact; only the live half degrades.

import { getDb } from "./db.js";
import { jsonResponse, textResponse } from "./http.js";
import { fetchContents, webSearch } from "./exa.js";
import { streamCompletion } from "./answer-stream.js";
import {
  FRESH_WINDOW_MS,
  LENS_IDS,
  OUTROSPECT_CAPS,
  OUTROSPECT_LENSES,
  OUTROSPECT_QUOTE_CAPS,
  deltaItems,
  feedItemFromSearch,
  formatFeedText,
  lensById,
  lensMatch,
  lensTally,
  mergeFeed,
  normalizeItemUrl,
  normalizeLens,
  outrospectionAnswerPrompt,
  outrospectionBlock,
  outrospectionLensCatalog,
  outrospectionQuoteBlock,
  quoteTerms,
  refreshQueries,
  scorePassage,
  selectQuotes,
  splitPassages,
  stalestLens,
  validateFeedItem,
} from "../public/js/outrospect-core.js";
import { phasePrompt } from "./prompt-sets.js";

export {
  FRESH_WINDOW_MS,
  LENS_IDS,
  OUTROSPECT_CAPS,
  OUTROSPECT_LENSES,
  OUTROSPECT_QUOTE_CAPS,
  deltaItems,
  feedItemFromSearch,
  formatFeedText,
  lensById,
  lensMatch,
  lensTally,
  mergeFeed,
  normalizeItemUrl,
  normalizeLens,
  outrospectionAnswerPrompt,
  outrospectionBlock,
  outrospectionLensCatalog,
  outrospectionQuoteBlock,
  quoteTerms,
  refreshQueries,
  scorePassage,
  selectQuotes,
  splitPassages,
  stalestLens,
  validateFeedItem,
};

/** @typedef {import('./types.js').Env} Env */
/** @typedef {import('./types.js').Logger} Logger */
/** @typedef {import('./settings.js').Identity} Identity */
/** @typedef {import('../public/js/outrospect-core.js').FeedItem} FeedItem */
/** @typedef {import('../public/js/outrospect-core.js').Lens} Lens */
/**
 * A D1 `outrospect_items` row. Deliberately identity-free.
 * @typedef {{ id: number, key: string, lens: string, title: string, url: string, teaser?: string | null, source?: string | null, first_seen: number, query?: string | null }} ItemRow
 */

// A refresh body is a lens id and a list of keys the client already holds;
// anything larger is not a refresh body.
const BODY_MAX = 200_000;

// How often ONE lens may be searched, across all visitors. A lens whose
// newest item is minutes old has nothing to gain from searching again, and
// every refresh is real money at the search provider — so a visit rides the
// last visitor's results when it arrives inside the window. This is what
// makes "refresh on every visit" affordable rather than reckless.
export const LENS_COOLDOWN_MS = 30 * 60 * 1000;

// How many refreshes one user may trigger per hour. The view fires ONE on
// load, so this only bites on someone holding the manual button down.
export const USER_RUNS_PER_HOUR = 8;

// The search depth a refresh runs at. Deliberately shallow: a feed wants
// headlines across many queries, not a deep read of any one of them (that is
// what the research pipeline is for — an item's URL is a normal chat away).
export const REFRESH_DEPTH = { numResults: 6, type: "auto" };

// ---------------------------------------------------------------------------
// INDEXING — the article bodies behind the headlines (owner feedback #28)
//
// "AND all the contents shown with headlines - Web fetch those and RAG index!
//  … to allow search and quotations plus links to the source in this
//  outrospection agent."
//
// So a refresh does one more bounded thing after storing the delta: it fetches
// the page text of a FEW of the lens's un-indexed articles through the Exa
// /contents client this repo already has (src/exa.js `fetchContents` — cached,
// time-bounded, fail-soft, no new dependency and no new HTTP client) and stores
// it in `outrospect_texts`. The answer path then quotes from those bodies with
// the source link attached, selecting passages with the pure lexical scorer in
// the core — no embeddings, no model, nothing new on the wire.
//
// Everything about it is bounded, because it runs inside somebody's page load:
//   * INDEX_MAX_ITEMS articles per refresh, never the whole feed;
//   * INDEX_TEXT_CAP chars stored per article (exa.js caps the fetch itself);
//   * INDEX_BUDGET_MS as the outer ceiling, on top of exa.js's own timeout;
//   * a page that yields nothing usable is stored as an EMPTY body, so the
//     same dead URL is not re-fetched on every visit forever.
// And all of it is fail-soft (invariant 2): no key, a dead backend, a throwing
// query — the refresh still returns 200 with zero indexed texts.
// ---------------------------------------------------------------------------

/** How many un-indexed articles one refresh may fetch bodies for. */
export const INDEX_MAX_ITEMS = 4;

/** Max stored body per article (exa.js's /contents cap is the same order). */
export const INDEX_TEXT_CAP = OUTROSPECT_QUOTE_CAPS.text;

/** Outer ceiling on the indexing pass, on top of exa.js's own fetch timeout. */
export const INDEX_BUDGET_MS = 10_000;

/** How many indexed bodies the answer path reads for one question. */
export const QUOTE_SOURCE_LIMIT = 12;

// How long an outrospection-mode turn will wait for its look outward before
// answering from whatever the feed already holds. The searches run
// concurrently and each is bounded at 15 s inside exa.js, so this is the only
// extra ceiling that matters — sized to be worth waiting for on a cold feed
// without stalling a streamed answer.
export const MODE_REFRESH_BUDGET_MS = 12_000;

/**
 * Resolve when `promise` settles or the budget expires, whichever is first.
 * The promise is NOT cancelled on timeout — it keeps running and may still
 * write its rows, which is exactly what we want: a slow refresh still fills
 * the feed for the next question, it just doesn't hold this answer up.
 * @template T
 * @param {Promise<T>} promise
 * @param {number} ms
 * @returns {Promise<T | null>}
 */
export function withDeadline(promise, ms) {
  /** @type {any} */
  let timer;
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
  });
  // The timer is CLEARED when the work wins the race. Leaving it pending kept
  // the isolate (and the unit-test process) alive for the full budget after
  // the answer had already moved on — with two of these per refresh that is
  // tens of seconds of nothing.
  return Promise.race([promise, deadline]).catch(() => null).finally(() => clearTimeout(timer));
}

// ---------------------------------------------------------------------------
// Pure helpers — unit-tested in src/outrospect.test.js
// ---------------------------------------------------------------------------

/**
 * Validate a refresh body: an optional lens (clamped to the registry, or
 * "auto" to let the server pick the stalest) and the client's known keys.
 * @param {unknown} body
 * @returns {{ error: string } | { error?: undefined, lens: string | null, known: string[] }}
 */
export function validateRefreshBody(body) {
  const o = body && typeof body === "object" ? /** @type {Record<string, unknown>} */ (body) : {};
  const rawLens = typeof o.lens === "string" ? o.lens.trim() : "";
  if (rawLens && rawLens !== "auto" && !LENS_IDS.includes(rawLens)) {
    return { error: `Unknown lens "${rawLens}".` };
  }
  const rawKnown = Array.isArray(o.known) ? o.known : [];
  if (rawKnown.length > OUTROSPECT_CAPS.known) {
    return { error: `Too many known keys (max ${OUTROSPECT_CAPS.known}).` };
  }
  const known = [];
  for (const k of rawKnown) {
    const key = normalizeItemUrl(k);
    if (key) known.push(key);
  }
  return { lens: rawLens && rawLens !== "auto" ? rawLens : null, known };
}

/**
 * Project a D1 row to the wire shape the core validates.
 * @param {ItemRow} row
 * @returns {FeedItem | null}
 */
export function projectItem(row) {
  const v = validateFeedItem({
    lens: row.lens,
    title: row.title,
    url: row.url || row.key,
    teaser: row.teaser || "",
    source: row.source || "",
    first_seen: row.first_seen,
    query: row.query || "",
  });
  return v.ok ? v.value : null;
}

/**
 * The lenses currently on cooldown, from the run log.
 * @param {{ lens: string, ts: number }[]} runs
 * @param {number} now
 * @param {number} [cooldownMs]
 * @returns {string[]}
 */
export function lensesOnCooldown(runs, now, cooldownMs = LENS_COOLDOWN_MS) {
  const out = new Set();
  for (const r of runs || []) {
    if (now - Number(r.ts) < cooldownMs) out.add(String(r.lens));
  }
  return [...out];
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

/**
 * Every stored item, newest first.
 * @param {D1Database} db
 * @param {{ lens?: string | null, since?: number, limit?: number }} [opts]
 * @returns {Promise<FeedItem[]>}
 */
export async function loadItems(db, { lens = null, since = 0, limit = OUTROSPECT_CAPS.items } = {}) {
  const where = ["first_seen > ?"];
  /** @type {(string | number)[]} */
  const binds = [Number(since) || 0];
  if (lens) {
    where.push("lens = ?");
    binds.push(lens);
  }
  const { results } = await db
    .prepare(
      `SELECT id, key, lens, title, url, teaser, source, first_seen, query FROM outrospect_items
       WHERE ${where.join(" AND ")} ORDER BY first_seen DESC, id DESC LIMIT ?`,
    )
    .bind(...binds, Math.max(1, Math.min(OUTROSPECT_CAPS.items, limit)))
    .all();
  /** @type {FeedItem[]} */
  const items = [];
  for (const row of /** @type {ItemRow[]} */ (results || [])) {
    const item = projectItem(row);
    if (item) items.push(item);
  }
  return items;
}

/**
 * Insert the delta. The `key` column is UNIQUE and the insert is OR IGNORE, so
 * two visitors refreshing the same lens at once cannot double-file an article
 * and the earliest first_seen always wins.
 * @param {D1Database} db
 * @param {FeedItem[]} items
 * @returns {Promise<number>} rows actually written
 */
export async function storeItems(db, items) {
  let written = 0;
  for (const i of items) {
    const res = await db
      .prepare(
        `INSERT OR IGNORE INTO outrospect_items (key, lens, title, url, teaser, source, first_seen, query)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(i.key, i.lens, i.title, i.url, i.teaser || null, i.source || null, i.first_seen, i.query || null)
      .run();
    if (res?.meta?.changes) written += res.meta.changes;
  }
  return written;
}

/**
 * One stored article body.
 * @typedef {{ key: string, lens: string, url: string, title: string, source: string, text: string, chars: number, origin: string, fetched_at: number }} TextRow
 */

/**
 * Which of these keys already have a body row (usable or not). Used to pick
 * what still needs fetching AND to stop a dead page being re-fetched forever.
 * @param {D1Database} db
 * @param {string[]} keys
 * @returns {Promise<Set<string>>}
 */
export async function indexedKeys(db, keys) {
  const list = [...new Set((keys || []).filter(Boolean))].slice(0, OUTROSPECT_CAPS.items);
  if (!list.length) return new Set();
  // `placeholders` is one "?" per key — never a value (the keys themselves are
  // bound). Named rather than inlined so the SQL-injection guard's allowlist
  // recognises it, which is the point of that allowlist.
  const placeholders = list.map(() => "?").join(",");
  const { results } = await db
    .prepare(`SELECT key FROM outrospect_texts WHERE key IN (${placeholders})`)
    .bind(...list)
    .all();
  return new Set((results || []).map((r) => String(/** @type {any} */ (r).key)));
}

/**
 * The stored bodies for a set of item keys, in the order the keys were given
 * (the feed's newest-first order), empty bodies dropped — an unusable page is
 * remembered so it is not re-fetched, never quoted.
 * @param {D1Database} db
 * @param {string[]} keys
 * @returns {Promise<Array<{ key: string, url: string, title: string, source: string, lens: string, text: string, origin: string }>>}
 */
export async function loadTexts(db, keys) {
  const list = [...new Set((keys || []).filter(Boolean))].slice(0, QUOTE_SOURCE_LIMIT);
  if (!list.length) return [];
  const placeholders = list.map(() => "?").join(",");
  const { results } = await db
    .prepare(
      `SELECT key, lens, url, title, source, text, chars, origin FROM outrospect_texts
       WHERE key IN (${placeholders}) AND chars > 0`,
    )
    .bind(...list)
    .all();
  /** @type {Map<string, any>} */
  const byKey = new Map();
  for (const row of /** @type {TextRow[]} */ (results || [])) byKey.set(String(row.key), row);
  /** @type {Array<{ key: string, url: string, title: string, source: string, lens: string, text: string, origin: string }>} */
  const out = [];
  for (const key of list) {
    const row = byKey.get(key);
    if (!row || !row.text) continue;
    out.push({
      key,
      url: row.url || key,
      title: row.title || "",
      source: row.source || "",
      lens: normalizeLens(row.lens),
      text: String(row.text).slice(0, INDEX_TEXT_CAP),
      origin: row.origin || "web",
    });
  }
  return out;
}

/**
 * Store fetched bodies. `INSERT OR IGNORE` on the primary key, so two visitors
 * indexing the same article at once cannot double-file it and the first body
 * stands — the same discipline `storeItems` uses for the headline.
 * @param {D1Database} db
 * @param {Array<{ key: string, lens: string, url: string, title?: string, source?: string, text?: string, origin?: string }>} rows
 * @param {number} [now]
 * @returns {Promise<number>} rows actually written (including empty negatives)
 */
export async function storeTexts(db, rows, now = Date.now()) {
  let written = 0;
  for (const r of rows || []) {
    const text = String(r.text || "").slice(0, INDEX_TEXT_CAP);
    const res = await db
      .prepare(
        `INSERT OR IGNORE INTO outrospect_texts (key, lens, url, title, source, text, chars, origin, fetched_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        r.key,
        normalizeLens(r.lens),
        r.url || r.key,
        r.title || null,
        r.source || null,
        text,
        text.length,
        r.origin || "web",
        now,
      )
      .run();
    if (res?.meta?.changes) written += res.meta.changes;
  }
  return written;
}

/**
 * Fetch and store the page text of a few not-yet-indexed articles.
 *
 * Deliberately NOT a query-generation phase and not a model call: the URLs come
 * from feed rows this site already found through its committed lens queries, so
 * what leaves the site is a list of public article URLs and nothing about the
 * reader (invariant 4). Never throws (invariant 2).
 *
 * @param {Env} env
 * @param {Logger} log
 * @param {D1Database} db
 * @param {FeedItem[]} items candidates, newest/most-relevant first
 * @param {{ now?: number, max?: number, fetchContentsImpl?: typeof fetchContents }} [opts]
 *   `fetchContentsImpl` is a test seam only — production always uses the one
 *   Exa /contents client, exactly as the search half always uses `webSearch`.
 * @returns {Promise<{ requested: number, indexed: number, chars: number }>}
 */
export async function indexFeedTexts(
  env,
  log,
  db,
  items,
  { now = Date.now(), max = INDEX_MAX_ITEMS, fetchContentsImpl = fetchContents } = {},
) {
  const none = { requested: 0, indexed: 0, chars: 0 };
  try {
    const list = (Array.isArray(items) ? items : []).filter((i) => i && i.key && i.url);
    if (!list.length || max <= 0) return none;
    const have = await indexedKeys(db, list.map((i) => i.key));
    const todo = list.filter((i) => !have.has(i.key)).slice(0, Math.max(0, max));
    if (!todo.length) return none;

    const fetched = await fetchContentsImpl(env, todo.map((i) => i.url), log);
    /** @type {Map<string, { title: string, text: string }>} */
    const byKey = new Map();
    for (const r of fetched.results || []) {
      const key = normalizeItemUrl(r.url);
      if (key && r.text) byKey.set(key, { title: r.title || "", text: r.text });
    }
    // Nothing came back at all: the backend is down, missing a key, or timed
    // out. That is a TRANSIENT failure, so record nothing — the next refresh
    // retries. Only a response that carried at least one usable body lets us
    // conclude the misses are the pages' own fault and mark them tried.
    if (!byKey.size) {
      log.info("outrospect.index", { requested: todo.length, indexed: 0, degraded: true });
      return { requested: todo.length, indexed: 0, chars: 0 };
    }

    /** @type {Array<{ key: string, lens: string, url: string, title: string, source: string, text: string }>} */
    const rows = todo.map((i) => {
      const got = byKey.get(i.key);
      return {
        key: i.key,
        lens: i.lens,
        url: i.url,
        title: (got && got.title) || i.title,
        source: i.source,
        text: (got && got.text) || "", // "" is the stored negative: asked, nothing usable
      };
    });
    await storeTexts(db, rows, now);
    const indexed = rows.filter((r) => r.text).length;
    const chars = rows.reduce((n, r) => n + r.text.length, 0);
    log.info("outrospect.index", { requested: todo.length, indexed, chars });
    return { requested: todo.length, indexed, chars };
  } catch (err) {
    // Invariant 2: indexing is an enrichment. It degrades to nothing indexed,
    // never to a failed refresh — the refresh runs inside a page load.
    log.warn?.("outrospect.index_failed", { error: String(err) });
    return none;
  }
}

// ---------------------------------------------------------------------------
// GET /api/outrospect/feed
// ---------------------------------------------------------------------------

/**
 * @param {Env} env
 * @param {URL} url
 * @returns {Promise<Response>}
 */
export async function handleOutrospectFeed(env, url) {
  const db = await getDb(env);
  if (!db) {
    // No D1: the view still renders the committed artifact. Say so plainly
    // instead of erroring, so the client can show "live half unavailable"
    // rather than a broken page.
    return jsonResponse({ items: [], tally: lensTally([]), live: false, lenses: OUTROSPECT_LENSES });
  }
  const lens = url.searchParams.get("lens");
  const items = mergeFeed([
    await loadItems(db, {
      lens: lens && LENS_IDS.includes(lens) ? lens : null,
      since: Number(url.searchParams.get("since")) || 0,
      limit: Number(url.searchParams.get("limit")) || OUTROSPECT_CAPS.items,
    }),
  ]);
  if (url.searchParams.get("format") === "text") {
    return textResponse(formatFeedText(items, { title: "OUTROSPECTION FEED — live items (newest first)" }));
  }
  return jsonResponse({ items, tally: lensTally(items), live: true, lenses: OUTROSPECT_LENSES });
}

// ---------------------------------------------------------------------------
// POST /api/outrospect/refresh — the look-outward-on-your-behalf call
// ---------------------------------------------------------------------------

/**
 * ONE lens refreshed — the actual look outward, shared by every caller.
 *
 * Extracted from the HTTP handler (2026-07-26) because it had only one caller
 * and that was the bug: the chat MODE only ever READ the feed, so a question
 * asked in outrospection mode never went looking. The feed could therefore
 * only be filled by someone opening `/outrospect/` in a browser — and until
 * someone did, the mode answered every question with "the feed holds nothing
 * on this yet" forever (feedback #25). The agent whose whole purpose is
 * looking outward has to be able to look.
 *
 * Returns a plain result rather than a Response so the HTTP handler can map it
 * to status codes and the chat path can ignore it. Never throws.
 *
 * @param {Env} env
 * @param {Logger} log
 * @param {{ userId: string, lens?: string | null, known?: string[], now?: number }} opts
 * @returns {Promise<{ lens: string | null, fresh: FeedItem[], searched: number, indexed?: number, cooled?: boolean, limited?: boolean, degraded?: boolean, unavailable?: boolean }>}
 */
export async function runLensRefresh(env, log, { userId, lens: wanted = null, known = [], now = Date.now() }) {
  const db = await getDb(env);
  if (!db) return { lens: wanted, fresh: [], searched: 0, unavailable: true };

  // Rate limit + cooldown, both read off the run log in one query.
  const { results: runRows } = await db
    .prepare("SELECT lens, ts, user_id FROM outrospect_runs WHERE ts > ? ORDER BY ts DESC LIMIT 500")
    .bind(now - Math.max(LENS_COOLDOWN_MS, 3600_000))
    .all();
  const runs = /** @type {{ lens: string, ts: number, user_id: string }[]} */ (runRows || []);
  const mine = runs.filter((r) => r.user_id === userId && now - Number(r.ts) < 3600_000);
  if (mine.length >= USER_RUNS_PER_HOUR) return { lens: wanted, fresh: [], searched: 0, limited: true };

  const cooling = lensesOnCooldown(runs, now);
  // An explicit pick is honoured unless it is the one thing on cooldown; with
  // no pick the server chooses the lens whose newest item is oldest, so
  // repeat visits heal the feed's thin spots instead of re-searching whatever
  // is already busiest.
  let lens = wanted;
  if (lens && cooling.includes(lens)) return { lens, fresh: [], searched: 0, cooled: true };
  if (!lens) {
    const eligible = LENS_IDS.filter((id) => !cooling.includes(id));
    if (!eligible.length) return { lens: null, fresh: [], searched: 0, cooled: true };
    lens = stalestLens(await loadItems(db, {}), { skip: cooling });
  }

  // Walk the lens's queries across successive runs so every one gets its turn
  // rather than the first N being the only ones ever issued.
  const offset = runs.filter((r) => r.lens === lens).length;
  const queries = refreshQueries(lens, { offset });

  // Run the lens's queries CONCURRENTLY. They are independent, and serially
  // they stacked each query's 15 s ceiling — 45 s worst case, which is far too
  // long to sit in front of a streamed answer now that the chat path calls
  // this too. Fail-soft per query (invariant 2): a dead provider costs that
  // query's results and nothing else.
  const settled = await Promise.all(
    queries.map(async (query) => {
      try {
        const res = await webSearch(env, log, query, REFRESH_DEPTH);
        return { query, items: res.items || [], ok: !!res.resultCount };
      } catch (err) {
        log.warn("outrospect.search_failed", { lens, error: String(err) });
        return { query, items: [], ok: false };
      }
    }),
  );

  /** @type {any[]} */
  const found = [];
  let failures = 0;
  for (const r of settled) {
    if (!r.ok) failures++;
    for (const item of r.items) {
      const fi = feedItemFromSearch(/** @type {string} */ (lens), item, { now, query: r.query });
      if (fi) found.push(fi);
    }
  }

  // The DELTA: what neither the caller nor the store already had. `known`
  // covers the committed artifact (which the server never reads), the store
  // covers everything a previous refresh added.
  const stored = await loadItems(db, { lens });
  const fresh = deltaItems([...known, ...stored.map((i) => i.key)], found);
  const written = fresh.length ? await storeItems(db, fresh) : 0;

  await db
    .prepare("INSERT INTO outrospect_runs (ts, user_id, lens, queries, found) VALUES (?, ?, ?, ?, ?)")
    .bind(now, userId, lens, queries.length, fresh.length)
    .run();

  // INDEX the bodies behind the headlines (feedback #28). Newly-found items go
  // first, then whatever else this lens holds that has never been fetched, so a
  // feed that filled up before indexing existed heals backwards a few articles
  // per visit instead of staying quote-less forever. Bounded twice — a small
  // item count and an outer deadline — and fail-soft: `indexFeedTexts` never
  // throws and `withDeadline` never lets it hold the response.
  const indexResult = await withDeadline(
    indexFeedTexts(env, log, db, [...fresh, ...stored], { now }),
    INDEX_BUDGET_MS,
  );
  const indexed = indexResult ? indexResult.indexed : 0;

  log.info("outrospect.refresh", {
    lens,
    queries: queries.length,
    found: found.length,
    fresh: fresh.length,
    written,
    indexed,
    failures,
  });
  return { lens, fresh, searched: queries.length, indexed, degraded: failures > 0 && !fresh.length };
}

/**
 * @param {Request} request
 * @param {Env} env
 * @param {Logger} log
 * @param {Identity} identity
 * @returns {Promise<Response>}
 */
export async function handleOutrospectRefresh(request, env, log, identity) {
  const db = await getDb(env);
  if (!db) return jsonResponse({ error: "The live feed is not available (no database configured)." }, 503);

  let raw = "";
  try {
    raw = await request.text();
  } catch {
    return jsonResponse({ error: "Unreadable body." }, 400);
  }
  if (raw.length > BODY_MAX) return jsonResponse({ error: "Body too large." }, 413);
  let body = {};
  if (raw.trim()) {
    try {
      body = JSON.parse(raw);
    } catch {
      return jsonResponse({ error: "Invalid JSON body." }, 400);
    }
  }
  const parsed = validateRefreshBody(body);
  if (parsed.error) return jsonResponse({ error: parsed.error }, 400);
  const v = /** @type {{ lens: string | null, known: string[] }} */ (parsed);

  const res = await runLensRefresh(env, log, {
    userId: String(identity?.id || identity?.email || "anon"),
    lens: v.lens,
    known: v.known,
  });

  if (res.limited) {
    return jsonResponse(
      { error: "You have refreshed the outward feed enough times this hour — it will keep updating on its own.", fresh: [], limited: true },
      429,
    );
  }
  if (res.cooled) {
    return jsonResponse({ lens: res.lens, fresh: [], cooled: true, retry_after_ms: LENS_COOLDOWN_MS }, 200);
  }
  return jsonResponse({
    lens: res.lens,
    fresh: res.fresh,
    searched: res.searched,
    indexed: res.indexed || 0,
    degraded: !!res.degraded,
  });
}

// ---------------------------------------------------------------------------
// GET /api/admin/outrospect — the operator/agent-loop view
// ---------------------------------------------------------------------------

/**
 * @param {Env} env
 * @param {URL} url
 * @returns {Promise<Response>}
 */
export async function handleAdminOutrospect(env, url) {
  const db = await getDb(env);
  if (!db) return jsonResponse({ error: "Database is not configured." }, 503);
  const lens = url.searchParams.get("lens");
  const items = mergeFeed([
    await loadItems(db, {
      lens: lens && LENS_IDS.includes(lens) ? lens : null,
      limit: Number(url.searchParams.get("limit")) || OUTROSPECT_CAPS.items,
    }),
  ]);
  const { results: runRows } = await db
    .prepare("SELECT id, ts, user_id, lens, queries, found FROM outrospect_runs ORDER BY id DESC LIMIT 50")
    .all();
  const runs = runRows || [];
  if (url.searchParams.get("format") === "text") {
    const head = formatFeedText(items, { title: "OUTROSPECTION — live feed (newest first)" });
    const lines = ["", "RECENT REFRESH RUNS", ""];
    for (const r of runs) {
      lines.push(
        `#${r.id} ${new Date(Number(r.ts)).toISOString()} ${String(r.lens).padEnd(18)} ` +
          `${r.queries} queries → ${r.found} new`,
      );
    }
    if (!runs.length) lines.push("(no refresh has run yet)");
    return textResponse(head + lines.join("\n") + "\n");
  }
  return jsonResponse({ items, tally: lensTally(items), runs, lenses: OUTROSPECT_LENSES });
}

// ---------------------------------------------------------------------------
// OUTROSPECTION MODE — the answer phase (owner directive, 2026-07-25)
//
// The fifth chat mode. Structurally it is introspection's mirror: retrieve
// deterministically, build ONE context block, stream ONE answer. Introspection
// retrieves from the committed snapshot of our own source; this retrieves from
// the outward feed. Nothing between the question and the answer calls a model
// to decide anything (invariant 1) — `lensMatch` is the same EN+SV gate the
// strategy lane uses, so the routing is auditable and identical in both
// languages.
//
// Fail-soft throughout (invariant 2): no D1, an empty feed, or a lens that
// matched nothing all degrade to an HONEST answer that says the feed holds
// nothing on this yet. They never error the chat, and the prompt forbids
// inventing an item — the same "never fabricate a feed item" rule the scan
// obeys, enforced where a model could otherwise be tempted.
//
// Billing/routing (invariant 3): there is no JSON planning phase here at all,
// so nothing runs on the fixed json model; the single streamed answer runs on
// the user's chosen model like any synthesis.
// ---------------------------------------------------------------------------

/** How many feed items the answer may cite. */
export const OUTRO_ANSWER_ITEMS = 24;

/**
 * Retrieve the feed slice this question should be answered from. Prefers the
 * matched lens; falls back to the whole feed when nothing matched, so a
 * general "what's new out there" still gets the newest items.
 *
 * Also loads the INDEXED BODIES of those items (`outrospect_texts`) — the
 * material the answer can quote from. The passage selection itself is pure and
 * lives in the core (`selectQuotes`); this only fetches the documents, in feed
 * order, so the newest article's passages break score ties. A feed with no
 * bodies indexed yet returns `texts: []` and the answer stays headline-only.
 * @param {Env} env
 * @param {string} question
 * @param {Logger} [log]
 * @returns {Promise<{ lens: Lens | null, items: FeedItem[], texts: Array<{ key: string, url: string, title: string, source: string, lens: string, text: string, origin: string }>, live: boolean }>}
 */
export async function retrieveOutwardFeed(env, question, log) {
  const lensId = lensMatch(question);
  const lens = lensId ? lensById(lensId) : null;
  try {
    const db = await getDb(env);
    if (!db) return { lens, items: [], texts: [], live: false };
    let items = await loadItems(db, { lens: lensId, limit: OUTRO_ANSWER_ITEMS });
    // A lens with nothing filed yet still deserves an answer: fall back to the
    // whole feed rather than pretending the outward world is empty.
    if (!items.length && lensId) items = await loadItems(db, { limit: OUTRO_ANSWER_ITEMS });
    const merged = mergeFeed([items], { limit: OUTRO_ANSWER_ITEMS });
    // Fail-soft on its own: a missing texts table (a database created before
    // this shipped and not yet re-initialized) costs the quotes, not the answer.
    const texts = await loadTexts(db, merged.map((i) => i.key)).catch((err) => {
      log?.warn?.("outrospect.texts_failed", { error: String(err) });
      return [];
    });
    return { lens, items: merged, texts, live: true };
  } catch (err) {
    log?.warn?.("outrospect.retrieve_failed", { error: String(err) });
    return { lens, items: [], texts: [], live: false };
  }
}

/**
 * Outrospection mode's whole answer phase. Called by src/pipeline.js when the
 * request carries `outrospection_mode` and the capability gate passed.
 * @param {import('./pipeline.js').PipelineCtx} ctx
 * @returns {Promise<void>}
 */
export async function runOutrospection(ctx) {
  const { env, log } = ctx;
  const question = ctx.cleanLastUser || ctx.lastUser;

  // GO LOOK FIRST. Until 2026-07-26 this phase only READ the feed, which made
  // the mode parasitic on someone happening to open /outrospect/ in a browser:
  // nothing had ever triggered a refresh in production, so every question was
  // answered "the feed holds nothing on this yet" (feedback #25). Asking the
  // outward-looking agent a question is now itself a reason to look.
  //
  // Bounded and fail-soft (invariant 2): the refresh is raced against a
  // deadline and its result is never awaited for correctness — whatever landed
  // in D1 by the time the read runs is what gets cited. A slow, dead, cooled,
  // or rate-limited search costs nothing but a shorter answer.
  ctx.step("outrospect", "Looking outward…");
  await withDeadline(
    runLensRefresh(env, log, {
      // Same accessor runSdkBuild uses — chat.js puts the signed-in id on the
      // state. It keys the per-user hourly cap only; no identity is stored.
      userId: String(/** @type {any} */ (ctx.state).userId || "anon"),
      lens: lensMatch(question),
    }).catch((err) => {
      log?.warn?.("outrospect.mode_refresh_failed", { error: String(err) });
      return null;
    }),
    MODE_REFRESH_BUDGET_MS,
  );

  ctx.step("outrospect", "Reading the outward feed…");
  const { lens, items, texts, live } = await retrieveOutwardFeed(env, question, log);
  // The passages to quote, chosen DETERMINISTICALLY from text already stored —
  // a lexical scan in the pure core, no model and no embedding call, and the
  // question never leaves the isolate to do it (invariants 1 and 4).
  const quotes = selectQuotes(question, texts);
  const block = outrospectionBlock(items, { limit: OUTRO_ANSWER_ITEMS, quotes });
  const label =
    items.length ?
      `${items.length} item${items.length === 1 ? "" : "s"}${lens ? ` · ${lens.title}` : ""}` +
        (quotes.length ? ` · ${quotes.length} quotable passage${quotes.length === 1 ? "" : "s"}` : "")
    : live ? "The feed is empty so far"
    : "The outward feed is unavailable";
  ctx.stepDone("outrospect", label);
  // `texts` / `quotes` are the same debugging signal `items` already is: grep
  // chat_logs for `quotes: 0` to find questions the feed could list but not
  // quote. The state typedef this widens is declared in src/pipeline.js and
  // src/chat.js (mirrored), so the cast stays here until those two gain the
  // keys rather than being silently narrowed away.
  /** @type {any} */ (ctx.state).outrospection = {
    lens: lens ? lens.id : null,
    items: items.length,
    texts: texts.length,
    quotes: quotes.length,
    live,
  };
  await streamCompletion(ctx, [
    // `hasItems` reads the ITEM COUNT, not whether the block is a non-empty
    // string: the block now always carries the lens catalog, so an empty feed
    // still produces one (that catalog is exactly what the empty-feed prompt
    // tells the model to name). `hasQuotes` is the same discipline one level
    // down — the model may quote verbatim only when passages are actually in
    // context, and is told not to invent one when they are not.
    {
      role: "system",
      content: phasePrompt(ctx.state, "feed", "answer")({
        lens,
        hasItems: items.length > 0,
        hasQuotes: quotes.length > 0,
      }),
    },
    ...(block ? [{ role: "system", content: block }] : []),
    ...ctx.conversation,
  ]);
}
