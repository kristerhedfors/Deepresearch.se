#!/usr/bin/env node
// Enumerate an arXiv corpus from a file of named query ARMS, paging each to
// exhaustion and advancing a date cursor whenever a query is deeper than the
// API's paging wall.
//
//   node scripts/arxiv-enumerate.mjs --arms data/aisec/query-arxiv.txt \
//     --out data/aisec/arxiv-ids.txt --state data/aisec/enum-state.json
//   node scripts/arxiv-enumerate.mjs --plan          # no network: the request plan
//
// Other flags: --core-only, --only A,B (named arms), --from/--to (YYYYMMDD),
// --max-phrases N (chunk width), --yield-floor N (see the cap below).
//
// Resumable: every completed sub-query is written to the state file, so a
// rerun skips it. A full run is hours of paced requests and the container does
// not necessarily outlive it. State keys are `<arm>#<index>`, so REORDERING OR
// REWORDING an arm's terms in the query file invalidates that arm's keys —
// drop them from `done` (or the whole arm) rather than trusting the resume.
//
// ---------------------------------------------------------------------------
// WHAT THE API ACTUALLY COSTS  (measured 2026-08-09 against export.arxiv.org)
//
// The HTTP 500 that kills a run is a SERVER-SIDE TIMEOUT, not a length limit:
// the body is arXiv's own error feed and Fastly reports VE30812 — the origin
// gave up at ~30.8 s. Every failing request in the first two runs sat at
// 31.0-31.9 s. So the question is never "is this query too long", it is
// "will this request finish inside 30 s".
//
// What drives the time is ENTRIES RETURNED x PHRASE CLAUSES, near enough:
//
//   phrase clauses   max_results   entries   wall time   per entry
//   --------------   -----------   -------   ---------   ---------
//        0 (cat:)        2000        2000       3.1 s      1.5 ms
//        1               2000        2000       8.1 s      4.1 ms
//        2               2000        2000       8.9 s      4.5 ms
//        4               2000        1523      13.9 s      9.1 ms
//        4                500         500       4.4 s      8.9 ms
//        8                500         500      10.0 s     20.0 ms
//        8                100         100       2.3 s     23.3 ms
//        8               1000           —      TIMEOUT          —
//       16                250         250       9.1 s     36.3 ms
//       51                 80          80      23.9 s    298.8 ms
//       51                100           —      TIMEOUT          —
//
// Two things follow, and they are the whole redesign:
//
//   1. The page size has to be a function of the query's phrase count. A
//      51-phrase arm cannot serve 100 rows in 30 s, so no row ceiling on the
//      old code could have made C1 finish: it would have needed ~80-row
//      shards, i.e. ~350 shards, i.e. ~700 requests with the count probes.
//
//   2. Far better, DON'T ASK A 51-PHRASE QUERY IN THE FIRST PLACE. An arm of
//      OR-ed phrases is a UNION, so `A OR B OR C` can be asked as chunks and
//      unioned client-side with the identical result set. Per-entry cost is
//      roughly linear in the phrase count while the row count is sublinear in
//      it, so chunking trades a few duplicate rows for an order of magnitude
//      in throughput: 3.3 rows/s at 51 phrases vs ~230 rows/s at 2.
//
// Three further measured facts the code depends on:
//
//   * `start >= 10000` is an HTTP 500. That wall is per QUERY, so the way past
//     it is to narrow the query's date window — and because results come back
//     sorted ascending by submittedDate, the last <published> in a page is a
//     CURSOR. Advancing the window to it costs one request, where the old
//     recursive halving cost a count probe at every node of the tree.
//   * `max_results=1` is cheap at any complexity, but it is a whole request
//     for a number the first real page reports anyway in
//     <opensearch:totalResults>. Merging the two roughly halves the request
//     count on complex arms.
//   * Sustained failures earn an HTTP 429. It is transient; back off long
//     (60 s+), don't just re-pace.
// ---------------------------------------------------------------------------

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const API = "https://export.arxiv.org/api/query";
/** arXiv asks for ~3 s between requests on one connection. Measured from the
 *  START of each request, so a slow response does not also pay the sleep — the
 *  aggregate rate is still one request per PACE_MS. */
const PACE_MS = 3100;
/** The origin gives up at ~30.8 s. Aim a page at a third of that: the same
 *  query answers in 9 s one minute and times out the next, so the margin is
 *  for arXiv's load, not for the model's error. */
const BUDGET_MS = 10000;
const MIN_PAGE = 25;
const MAX_PAGE = 2000;
/** `start >= 10000` is an HTTP 500; leave room for drift. */
export const PAGING_WALL = 9500;
/** Phrase clauses per sub-query after chunking.
 *
 *  Per-entry cost is roughly 2.3 ms per phrase clause above a ~1.5 ms floor,
 *  so total work is (rows fetched) x (phrases). Chunking finer multiplies the
 *  rows (the chunks overlap) but divides the per-entry cost, and the second
 *  effect is the stronger one until the 2,000-row page cap binds: at 2 phrases
 *  a page of 2,000 comes back in ~9 s (222 rows/s), at 8 phrases a page of 538
 *  takes ~11 s (49 rows/s). 4 is the balance — small enough to sit near the
 *  page cap, large enough that arms are not shredded into hundreds of
 *  sub-queries each paying its own tail request. */
const MAX_PHRASES = 4;
const MAX_RETRY = 5;

const arg = (f, d) => {
  const i = process.argv.indexOf(f);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : d;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested in scripts/arxiv-enumerate.test.mjs)
// ---------------------------------------------------------------------------

/** Arms are `## name [TIER]` followed by the query on the next non-comment line. */
export function parseArms(text) {
  const arms = [];
  const lines = String(text).split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^##\s+(\S+)/);
    if (!m) continue;
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j].trim();
      if (!line || line.startsWith("#")) continue;
      arms.push({ name: m[1], query: line, core: /\[CORE\]/.test(lines[i]) });
      break;
    }
  }
  return arms;
}

/** Quoted phrases are what the API charges for; count them. */
export const phraseCount = (query) => (String(query).match(/"/g) || []).length >> 1;

/** Split on a separator that appears at paren depth 0 and outside quotes. */
export function splitTop(query, sep) {
  const s = String(query);
  const parts = [];
  let depth = 0;
  let quoted = false;
  let last = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '"') quoted = !quoted;
    else if (!quoted && c === "(") depth++;
    else if (!quoted && c === ")") depth--;
    else if (!quoted && depth === 0 && s.startsWith(sep, i)) {
      parts.push(s.slice(last, i));
      i += sep.length - 1;
      last = i + 1;
    }
  }
  parts.push(s.slice(last));
  return parts.map((p) => p.trim()).filter(Boolean);
}

const unwrap = (part) => (part.startsWith("(") && part.endsWith(")") ? part.slice(1, -1).trim() : part);

/**
 * Rewrite one arm as a set of union-equivalent sub-queries.
 *
 * `(X) AND (a OR b OR c OR d)` becomes `(X) AND (a OR b)`, `(X) AND (c OR d)`.
 * OR distributes over the union, so the union of the sub-queries' result sets
 * is exactly the arm's result set — no coverage is traded away, only duplicate
 * rows are bought, and duplicates cost far less than the per-entry penalty a
 * wide OR carries.
 *
 * Only the WIDEST phrase group is chunked; the other AND-ed groups ride along
 * in every sub-query, so their phrases are a fixed floor on the chunk budget.
 */
export function splitArm(query, maxPhrases = MAX_PHRASES) {
  const total = phraseCount(query);
  if (total <= maxPhrases) return [String(query).trim()];

  const parts = splitTop(query, " AND ");
  const groups = parts.map((p) => splitTop(unwrap(p), " OR "));
  // Widest phrase-bearing group. Ties go to the first, which keeps the output
  // stable across runs (the state file keys off the sub-query index).
  let k = -1;
  for (let i = 0; i < groups.length; i++) {
    if (groups[i].length < 2 || phraseCount(parts[i]) === 0) continue;
    if (k < 0 || groups[i].length > groups[k].length) k = i;
  }
  if (k < 0) return [String(query).trim()];

  const fixed = total - phraseCount(parts[k]);
  const budget = Math.max(1, maxPhrases - fixed);
  const chunks = [];
  let cur = [];
  let curPhrases = 0;
  for (const term of groups[k]) {
    const cost = Math.max(1, phraseCount(term));
    if (cur.length && curPhrases + cost > budget) {
      chunks.push(cur);
      cur = [];
      curPhrases = 0;
    }
    cur.push(term);
    curPhrases += cost;
  }
  if (cur.length) chunks.push(cur);

  return chunks.map((chunk) => {
    const rebuilt = parts.slice();
    rebuilt[k] = `(${chunk.join(" OR ")})`;
    return rebuilt.join(" AND ");
  });
}

/**
 * Per-entry cost in ms as a function of phrase count, fitted to the table at
 * the top of this file. Linear dominates up to ~16 phrases; the quadratic term
 * is what stops the formula handing a 51-phrase query a page it cannot serve.
 */
export const perEntryMs = (phrases) => 1.5 + 2.2 * phrases + 0.05 * phrases * phrases;

/** Largest page this query can serve inside the time budget. */
export function pageFor(phrases, budgetMs = BUDGET_MS) {
  const n = Math.round(budgetMs / perEntryMs(Math.max(0, phrases)));
  return Math.max(MIN_PAGE, Math.min(MAX_PAGE, n));
}

/**
 * Should an arm stop early because its marginal yield has collapsed?
 *
 * Arms overlap heavily — X1 alone supplied 19,565 ids, and C1's first
 * sub-query added only 3,015 on top of it — so a late arm can spend hundreds
 * of requests for a handful of new papers. But yield is NOISY within an arm
 * (C1 measured 151, 121, 181, 33, 44, 21, 53, 127 new ids per request), so a
 * single lean sub-query is not a collapse: only a RUN of them is. Off by
 * default; when it does fire, the caller logs it and records what was skipped.
 */
export function shouldCapArm(yields, floor, streak = 3) {
  if (!floor || yields.length < streak) return false;
  return yields.slice(-streak).every((y) => y < floor);
}

/** Grow or shrink the page from the latency the server just showed us. */
export function retunePage(page, latencyMs, budgetMs = BUDGET_MS) {
  if (latencyMs > budgetMs * 1.5) return Math.max(MIN_PAGE, Math.floor(page / 2));
  if (latencyMs < budgetMs * 0.5) return Math.min(MAX_PAGE, Math.ceil(page * 1.5));
  return page;
}

/**
 * What to do after a page comes back. This is the merged decision the old code
 * spent a separate `max_results=1` probe on: the drained page's own
 * <opensearch:totalResults> says whether the window is over the ceiling.
 *
 *   "page"    — more rows in this window, keep paging
 *   "advance" — the paging wall is closer than the end of the window; move the
 *               date cursor to the last row seen and start a fresh window
 *   "stall"   — a single day is deeper than the wall; the cursor cannot move
 *   "done"    — the window is exhausted
 */
export function shardDecision({ total, start, got, cursorDate, lastDate, wall = PAGING_WALL }) {
  if (got === 0) return start >= total ? "done" : "stall";
  const next = start + got;
  if (next >= total) return "done";
  if (next + 1 > wall) return lastDate && lastDate > cursorDate ? "advance" : "stall";
  return "page";
}

/** Dates are YYYYMMDD strings throughout; go through Date so months stay honest. */
export const toDate = (s) => new Date(`${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T00:00:00Z`);
export const toStamp = (d) => d.toISOString().slice(0, 10).replace(/-/g, "");
export const addDays = (s, n) => toStamp(new Date(toDate(s).getTime() + n * 86400000));

/** Halve a date range. Used only as the last-resort retry when a window will
 *  not drain even at the minimum page size. */
export function halveRange(from, to) {
  const a = toDate(from).getTime();
  const b = toDate(to).getTime();
  if (b - a < 86400000) return null;
  const mid = toStamp(new Date(a + Math.floor((b - a) / 2 / 86400000) * 86400000));
  if (mid <= from || mid > to) return null;
  return [
    [from, addDays(mid, -1)],
    [mid, to],
  ];
}

/** A submittedDate range clause. arXiv wants `[YYYYMMDDHHMM+TO+YYYYMMDDHHMM]`. */
export const dateClause = (from, to) => `submittedDate:[${from}0000+TO+${to}2359]`;

export const totalOf = (xml) => Number((xml.match(/<opensearch:totalResults[^>]*>(\d+)</) || [])[1] ?? -1);
export const idsOf = (xml) =>
  [...xml.matchAll(/<id>https?:\/\/arxiv\.org\/abs\/([^<]+)<\/id>/g)].map((m) => m[1].replace(/v\d+$/, ""));
/** The cursor: the last v1 submission date in a page, as YYYYMMDD. */
export const lastPublished = (xml) => {
  const all = [...xml.matchAll(/<published>(\d{4})-(\d{2})-(\d{2})T/g)];
  return all.length ? all[all.length - 1].slice(1).join("") : null;
};
/** arXiv answers a failed query with a 200-shaped feed carrying one error entry. */
export const isErrorFeed = (xml) => /<id>https?:\/\/arxiv\.org\/api\/errors<\/id>/.test(xml);
export const isFeed = (xml) => /<feed\b/.test(xml) && /<opensearch:totalResults/.test(xml) && !isErrorFeed(xml);

// ---------------------------------------------------------------------------
// Network
// ---------------------------------------------------------------------------

/** One paced request. Returns {xml, ms} or throws after MAX_RETRY. */
async function apiGet(params, label, clock) {
  const url = `${API}?${params}`;
  for (let attempt = 0; ; attempt++) {
    const t0 = Date.now();
    let status = 0;
    let text = "";
    try {
      const res = await fetch(url);
      status = res.status;
      text = await res.text();
    } catch (err) {
      status = -1;
      text = String(err && err.message);
    }
    const ms = Date.now() - t0;
    clock.requests++;
    // Pace from the request START: the aggregate stays one request per PACE_MS
    // whether the server answered in 300 ms or 12 s.
    await sleep(Math.max(0, PACE_MS - ms));
    if (status === 200 && isFeed(text)) return { xml: text, ms };
    // A 500 that took ~30 s is the origin giving up. Sometimes that is arXiv
    // being briefly busy — one retry at the same size is worth it — but a
    // second one means the page is genuinely too big for this query, and four
    // more 30 s waits buy nothing. Hand it back so the caller halves the page.
    if (status === 500 && ms >= 25000 && attempt >= 1) throw new Error(`${label}: origin timeout at ${ms}ms`);
    if (attempt >= MAX_RETRY) {
      throw new Error(`${label}: HTTP ${status} after ${attempt + 1} tries, ${text.length} bytes, no usable feed`);
    }
    // 429 is a cooling-off, not a "try again in 6 s". Everything else is the
    // 30 s origin timeout, which a shorter wait does not fix either.
    const backoff = status === 429 ? 60000 * (attempt + 1) : PACE_MS * (attempt + 2);
    process.stdout.write(`      retry ${attempt + 1}/${MAX_RETRY} after HTTP ${status} (${ms}ms) — waiting ${Math.round(backoff / 1000)}s\n`);
    await sleep(backoff);
  }
}

/**
 * Drain one sub-query over [from, to] into `out`.
 *
 * Drain FIRST, decide after: the page we just paid for carries the total, so
 * there is no probe request, and nothing retrieved is ever thrown away. When
 * the window turns out to run past the paging wall, the cursor moves to the
 * last submission date seen and a fresh window opens there — no recursive
 * split, no re-counting.
 */
async function drainQuery(query, from, to, label, out, log, clock) {
  const phrases = phraseCount(query);
  let page = pageFor(phrases);
  // Once the origin has timed out on a page size, never grow back past the
  // size that survived — otherwise retunePage oscillates across the cliff.
  let pageCap = MAX_PAGE;
  let cursor = from;
  let windows = 0;
  const startIds = out.size;

  for (;;) {
    windows++;
    const q = `(${query}) AND ${dateClause(cursor, to)}`;
    const enc = encodeURIComponent(q).replace(/%2B/g, "+");
    let start = 0;
    let total = -1;

    for (;;) {
      const used = page;
      let xml, ms;
      try {
        ({ xml, ms } = await apiGet(
          `search_query=${enc}&start=${start}&max_results=${used}&sortBy=submittedDate&sortOrder=ascending`,
          `${label} ${cursor}-${to}@${start}`,
          clock,
        ));
      } catch (err) {
        if (page > MIN_PAGE) {
          page = Math.max(MIN_PAGE, Math.floor(page / 2));
          pageCap = page;
          log(`      ${label}: stepping page down to ${page} after ${err.message}`);
          continue;
        }
        // Minimum page and still failing. Halving the window is the last card
        // — it shrinks the match set even though the per-entry cost is what
        // usually bites — and if that is impossible the shard is a GAP.
        const halves = halveRange(cursor, to);
        if (!halves) {
          clock.gaps.push({ label, from: cursor, to, reason: err.message });
          log(`  !! GAP ${label} ${cursor}-${to}: undrainable at page ${MIN_PAGE} — ${err.message}`);
          return out.size - startIds;
        }
        log(`  !! ${label} ${cursor}-${to}: undrainable at page ${MIN_PAGE}, halving the window`);
        for (const [a, b] of halves) await drainQuery(query, a, b, label, out, log, clock);
        return out.size - startIds;
      }

      total = totalOf(xml);
      const ids = idsOf(xml);
      for (const id of ids) out.add(id);
      const lastDate = lastPublished(xml);
      const verdict = shardDecision({ total, start, got: ids.length, cursorDate: cursor, lastDate });

      if (start === 0) log(`    ${label} ${cursor}-${to}: ${total} rows, page ${used} (${phrases} phrases, ${ms}ms)`);
      page = Math.min(pageCap, retunePage(page, ms));

      if (verdict === "done") return out.size - startIds;
      if (verdict === "advance") {
        log(`    ${label}: paging wall at ${start + ids.length}/${total} — cursor to ${lastDate}`);
        cursor = lastDate;
        break;
      }
      if (verdict === "stall") {
        // Either an empty page short of the total, or >9,500 rows sharing one
        // submission date. Both are loud; neither is silently swallowed.
        clock.gaps.push({ label, from: cursor, to, reason: `stalled at ${start}/${total}` });
        log(`  !! GAP ${label} ${cursor}-${to}: stalled at ${start}/${total} rows — cursor cannot advance`);
        return out.size - startIds;
      }
      start += ids.length;
    }
    if (windows > 200) {
      clock.gaps.push({ label, from: cursor, to, reason: "cursor did not converge in 200 windows" });
      log(`  !! GAP ${label}: cursor did not converge in 200 windows`);
      return out.size - startIds;
    }
  }
}

// ---------------------------------------------------------------------------

function planOf(arms, maxPhrases) {
  return arms.map((arm) => {
    const subs = splitArm(arm.query, maxPhrases);
    return {
      name: arm.name,
      core: arm.core,
      phrases: phraseCount(arm.query),
      subs: subs.map((q) => ({ query: q, phrases: phraseCount(q), page: pageFor(phraseCount(q)) })),
    };
  });
}

async function main() {
  const armsPath = arg("--arms", "data/aisec/query-arxiv.txt");
  const outPath = arg("--out", "data/aisec/arxiv-ids.txt");
  const statePath = arg("--state", outPath.replace(/\.txt$/, "-state.json"));
  const coreOnly = process.argv.includes("--core-only");
  const only = arg("--only", "");
  const maxPhrases = Number(arg("--max-phrases", String(MAX_PHRASES)));
  // 0 = off. Coverage is never dropped by default; when a cap IS asked for it
  // is logged loudly and recorded in the state file.
  const yieldFloor = Number(arg("--yield-floor", "0"));
  const from = arg("--from", "19910801"); // arXiv's first submissions
  const to = arg("--to", new Date().toISOString().slice(0, 10).replace(/-/g, ""));

  let arms = parseArms(readFileSync(armsPath, "utf8")).filter((a) => !coreOnly || a.core);
  if (only) {
    const want = new Set(only.split(",").map((s) => s.trim()));
    arms = arms.filter((a) => want.has(a.name));
  }

  if (process.argv.includes("--plan")) {
    const plan = planOf(arms, maxPhrases);
    let subs = 0;
    for (const p of plan) {
      subs += p.subs.length;
      console.log(
        `${p.name.padEnd(34)} ${String(p.phrases).padStart(3)} phrases -> ${String(p.subs.length).padStart(3)} sub-queries, ` +
          `${p.subs[0].phrases} phrases each, page ${p.subs[0].page}`,
      );
    }
    console.log(`\n${arms.length} arms -> ${subs} sub-queries`);
    return;
  }

  const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : { done: [], ids: [] };
  const out = new Set(state.ids || []);
  const done = new Set(state.done || []);
  const capped = new Set(state.capped || []);
  const clock = { requests: 0, gaps: state.gaps || [] };
  const log = (m) => console.log(m);
  const save = () => {
    mkdirSync(dirname(statePath), { recursive: true });
    writeFileSync(
      statePath,
      JSON.stringify({ done: [...done], capped: [...capped], gaps: clock.gaps, ids: [...out] }),
    );
    writeFileSync(outPath, [...out].sort().join("\n") + "\n");
  };

  const plan = planOf(arms, maxPhrases);
  log(`${arms.length} arms -> ${plan.reduce((n, p) => n + p.subs.length, 0)} sub-queries, ${done.size} done, ${out.size} ids so far`);

  for (const p of plan) {
    if (done.has(p.name)) continue; // whole arm already finished (also the pre-split state format)
    const armBefore = out.size;
    const armReqBefore = clock.requests;
    log(`  ${p.name} (${p.core ? "CORE" : "periphery"}) — ${p.subs.length} sub-queries, ${p.phrases} phrases`);
    let armCapped = false;
    const yields = [];
    for (let i = 0; i < p.subs.length; i++) {
      const key = `${p.name}#${i}`;
      if (done.has(key)) continue;
      const before = out.size;
      const reqBefore = clock.requests;
      const gained = await drainQuery(p.subs[i].query, from, to, key, out, log, clock);
      const spent = clock.requests - reqBefore;
      const rate = gained / Math.max(1, spent);
      yields.push(rate);
      log(`    ${key}: +${gained} new (${out.size - before} unique), ${spent} requests, ${rate.toFixed(0)}/req`);
      done.add(key);
      save();
      if (shouldCapArm(yields, yieldFloor)) {
        armCapped = true;
        const remaining = p.subs.length - i - 1;
        log(`  !! CAPPED ${p.name} after sub-query ${i + 1}/${p.subs.length}: the last 3 sub-queries yielded ` +
          `${yields.slice(-3).map((y) => y.toFixed(1)).join(", ")} new ids/request, all under the --yield-floor of ${yieldFloor}.`);
        log(`  !! ${remaining} sub-queries of ${p.name} were NOT run. Coverage of this arm is INCOMPLETE.`);
        capped.add(`${p.name}: skipped ${remaining}/${p.subs.length} sub-queries at yield ${rate.toFixed(1)}/req`);
        break;
      }
    }
    if (!armCapped) done.add(p.name);
    save();
    log(`  ${p.name}: +${out.size - armBefore} new, ${clock.requests - armReqBefore} requests, ${out.size} total`);
  }

  save();
  log(`done — ${out.size} unique ids, ${clock.requests} requests this run -> ${outPath}`);
  if (capped.size) {
    log(`\n!! ${capped.size} arm(s) CAPPED — coverage is incomplete:`);
    for (const c of capped) log(`  !! ${c}`);
  }
  if (clock.gaps.length) {
    log(`\n!! ${clock.gaps.length} GAP(s) — shards that could not be drained:`);
    for (const g of clock.gaps) log(`  !! ${g.label} ${g.from}-${g.to}: ${g.reason}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
