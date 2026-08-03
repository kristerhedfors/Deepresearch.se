#!/usr/bin/env node
// Pure statistics and bookkeeping for the hosted-RAG evaluation harness.
//
// Nothing here touches the network, so all of it is unit-tested
// (scripts/rag-eval-core.test.mjs) — which matters because these are the
// functions that silently produce a plausible-but-wrong table. The network
// halves live in scripts/rag-hosted.mjs and scripts/rag-eval.mjs.
//
// ---- why the significance test is CODE and not a paragraph -----------------
//
// docs/ARXIV-RAG.md §11 decides every before/after verdict with a paired
// McNemar exact test, and states plainly why: at n=150 the independent binomial
// 95% CI is about ±6.7 points, which calls almost every real effect noise. That
// test was computed BY HAND for the widening — it appeared in no script, so the
// next person to compare two runs would have had to rediscover both the method
// and the reason. A decision rule that lives only in prose is a decision rule
// that gets skipped under time pressure, and skipping it here means shipping a
// corpus change on a 6-point swing that is not there. So it is `mcnemar` below,
// it is what `compare` prints, and it is unit-tested against worked examples.

/**
 * "2507-2607" → every YYMM in between, inclusive. Also accepts a plain list.
 * Two-digit years wrap at the century, so the range walks months rather than
 * comparing strings (2512 → 2601 must not look like a gap).
 * @param {string} spec
 * @returns {string[]}
 */
export function expandMonths(spec) {
  const text = String(spec || "").trim();
  if (!text) return [];
  if (text.includes(",")) return text.split(",").map((s) => s.trim()).filter(Boolean);
  const m = /^(\d{2})(\d{2})-(\d{2})(\d{2})$/.exec(text);
  if (!m) return [text];
  const [, y1, m1, y2, m2] = m;
  const out = [];
  let year = Number(y1);
  let month = Number(m1);
  for (let guard = 0; guard < 600; guard++) {
    out.push(String(year).padStart(2, "0") + String(month).padStart(2, "0"));
    if (year === Number(y2) && month === Number(m2)) return out;
    month++;
    if (month > 12) {
      month = 1;
      year = (year + 1) % 100;
    }
  }
  return out;
}

/**
 * Rank of the gold id in a ranked id list, 1-based; 0 when absent.
 * @param {string[]} ids
 * @param {string} gold
 */
export function rankOf(ids, gold) {
  const i = ids.indexOf(gold);
  return i < 0 ? 0 : i + 1;
}

// ---- significance -----------------------------------------------------------

/**
 * log of n-choose-k, via lgamma — the exact binomial below sums over up to a
 * few hundred terms and plain factorials overflow long before that.
 * @param {number} n
 * @param {number} k
 */
function logChoose(n, k) {
  return lgamma(n + 1) - lgamma(k + 1) - lgamma(n - k + 1);
}

/**
 * Lanczos approximation. Accurate to ~1e-13 over the range this uses, which is
 * far tighter than any p-value here is reported to.
 * @param {number} z
 */
function lgamma(z) {
  const g = [
    676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059,
    12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
  ];
  if (z < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * z)) - lgamma(1 - z);
  const x = z - 1;
  let a = 0.99999999999980993;
  const t = x + 7.5;
  for (let i = 0; i < g.length; i++) a += g[i] / (x + i + 1);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}

/**
 * Two-sided EXACT binomial test at p=0.5 over the discordant pairs — the
 * McNemar test in the form docs/ARXIV-RAG.md §11 uses.
 *
 * `b` is how many queries the change LOST (hit before, miss after) and `c` how
 * many it GAINED. Concordant pairs carry no information about the direction of
 * a paired change and are deliberately not counted: that is the entire reason
 * this test separates effects an independent binomial CI calls noise.
 *
 * The chi-square approximation is NOT used. With b+c often under 25 — which is
 * the normal case at n=150 — it is unreliable exactly where the answer matters.
 *
 * @param {number} b lost
 * @param {number} c gained
 * @returns {{ b: number, c: number, n: number, p: number }}
 */
export function mcnemar(b, c) {
  const n = b + c;
  if (n === 0) return { b, c, n: 0, p: 1 };
  const k = Math.min(b, c);
  // P(X <= k) for X ~ Binomial(n, 0.5), doubled for the two-sided test.
  let tail = 0;
  for (let i = 0; i <= k; i++) tail += Math.exp(logChoose(n, i) - n * Math.LN2);
  return { b, c, n, p: Math.min(1, 2 * tail) };
}

/**
 * Pair two runs' needle rows on (gold, lang) and McNemar the hit@k flags.
 *
 * Pairing on the QUERY rather than comparing two aggregate rates is the whole
 * point — the runs share their gold set, so treating them as independent
 * samples throws away the pairing that makes a 4-point effect detectable.
 * A gold paper present in only one run is dropped rather than counted as a
 * miss: it was never asked of both pipelines.
 *
 * @param {any[]} rowsA before
 * @param {any[]} rowsB after
 * @param {number} k
 * @param {string} [lang]
 * @returns {{ b: number, c: number, n: number, p: number, nPaired: number }}
 */
export function pairedNeedle(rowsA, rowsB, k, lang) {
  // NUL as the field separator, written as the ESCAPE \0 rather than as a raw
  // byte. It was a literal NUL until 2026-08-01, which made git classify this
  // whole 15 KB module as BINARY: no diff, no blame, no review in the GitHub
  // UI, and an invisible character a later edit could silently eat. The
  // separator itself is right -- NUL cannot occur in a gold id or a language
  // tag, so the composite key is unambiguous -- only its spelling was.
  const key = (/** @type {any} */ r) => `${r.gold}\0${r.lang}`;
  const pick = (/** @type {any[]} */ rows) =>
    new Map(
      rows
        .filter((r) => r.kind === "needle" && !r.error && (!lang || r.lang === lang))
        .map((r) => [key(r), r]),
    );
  const a = pick(rowsA);
  const bMap = pick(rowsB);
  let lost = 0;
  let gained = 0;
  let nPaired = 0;
  for (const [id, ra] of a) {
    const rb = bMap.get(id);
    if (!rb) continue;
    nPaired++;
    const hitA = ra.finalRank > 0 && ra.finalRank <= k;
    const hitB = rb.finalRank > 0 && rb.finalRank <= k;
    if (hitA && !hitB) lost++;
    else if (!hitA && hitB) gained++;
  }
  return { ...mcnemar(lost, gained), nPaired };
}

/**
 * Pair the two LANGUAGES of one run against each other on the same gold
 * document — the invariant-6 measurement.
 *
 * This is not the same question as "is Swedish good"; it is "does Swedish cost
 * a document that English finds", and only a paired test can answer it, because
 * the two languages ask about the SAME 150 documents. `stage` picks where to
 * look: "final" is what the user gets, "dense" is the retrieval stage alone.
 * Reading both is what separates a translation problem from a reranking one —
 * if the dense loss equals the final loss, the cross-encoder is not the
 * culprit and no amount of reranking work will close the gap.
 *
 * @param {any[]} rows
 * @param {{ k?: number, stage?: "final" | "dense", a?: string, b?: string }} [opts]
 */
export function langParity(rows, { k = 10, stage = "final", a = "en", b = "sv" } = {}) {
  /** @type {Record<string, Map<string, any>>} */
  const by = { [a]: new Map(), [b]: new Map() };
  for (const r of rows) {
    if (r.kind !== "needle" || r.error || !by[r.lang]) continue;
    by[r.lang].set(r.gold, r);
  }
  const hit = (/** @type {any} */ r) =>
    stage === "dense" ? r.denseRank > 0 : r.finalRank > 0 && r.finalRank <= k;
  let lost = 0;
  let gained = 0;
  let n = 0;
  for (const [gold, ra] of by[a]) {
    const rb = by[b].get(gold);
    if (!rb) continue;
    n++;
    if (hit(ra) && !hit(rb)) lost++;
    else if (!hit(ra) && hit(rb)) gained++;
  }
  // The language names are returned as langA/langB, NOT as a/b: mcnemar's own
  // result carries `b` and `c` as the discordant COUNTS, and spreading a field
  // called `b` over it silently replaced the count with the string "sv" — the
  // table then compared strings and printed "Swedish ahead" for a deficit.
  return { ...mcnemar(lost, gained), nPaired: n, langA: a, langB: b, k, stage };
}

/**
 * Paired two-sided sign test over a CONTINUOUS per-query score (nDCG, latency).
 * Ties carry no direction and are dropped, which is what makes this the same
 * exact-binomial machinery as McNemar rather than a second statistic to trust.
 * @param {number[]} before
 * @param {number[]} after
 * @param {number} [eps] differences under this count as ties
 */
export function pairedSign(before, after, eps = 1e-9) {
  let worse = 0;
  let better = 0;
  for (let i = 0; i < Math.min(before.length, after.length); i++) {
    const d = after[i] - before[i];
    if (d > eps) better++;
    else if (d < -eps) worse++;
  }
  return { ...mcnemar(worse, better), nPaired: Math.min(before.length, after.length) };
}

// ---- needle scoring ---------------------------------------------------------

/**
 * The needle table for one language.
 *
 * `inPool` is the number to read FIRST when a corpus changes size: it is the
 * share of gold documents dense retrieval put in front of the cross-encoder at
 * all, and everything to its right is bounded by it. A drop in r@10 with
 * inPool flat is a reranking problem; a drop in both is a pool problem, and
 * they have different fixes.
 *
 * @param {any[]} rows
 * @param {string} lang
 */
export function needleStats(rows, lang) {
  const rs = rows.filter((r) => r.kind === "needle" && r.lang === lang && !r.error);
  if (!rs.length) return null;
  const pct = (/** @type {number} */ n) => Math.round((n / rs.length) * 1000) / 10;
  const hitAt = (/** @type {number} */ k) => rs.filter((r) => r.finalRank > 0 && r.finalRank <= k).length;
  const mrr = rs.reduce((a, r) => a + (r.finalRank > 0 ? 1 / r.finalRank : 0), 0) / rs.length;
  const latencies = rs.map((r) => r.ms?.total || 0).sort((a, b) => a - b);
  return {
    n: rs.length,
    inPool: pct(rs.filter((r) => r.denseRank > 0).length),
    r1: pct(hitAt(1)),
    r5: pct(hitAt(5)),
    r10: pct(hitAt(10)),
    mrr: Math.round(mrr * 1000) / 10,
    // How often the relevance floor dropped a gold document the reranker kept.
    // A non-zero value here is the floor costing real recall, and is the
    // evidence any change to RERANK_FLOOR has to be argued from.
    floorLoss: pct(rs.filter((r) => r.finalRank === 0 && rankOf(r.ordered || [], r.gold) > 0).length),
    msMedian: latencies[Math.floor(latencies.length / 2)] || 0,
    msP95: latencies[Math.floor(latencies.length * 0.95)] || 0,
  };
}

/**
 * Where in the served pipeline the gold document was lost, summed over a run.
 *
 * The stage breakdown is what turns "recall went down" into a next action.
 * Every needle is in exactly one bucket, so the four columns sum to n.
 * @param {any[]} rows
 * @param {string} [lang]
 */
export function lossBreakdown(rows, lang) {
  const rs = rows.filter((r) => r.kind === "needle" && !r.error && (!lang || r.lang === lang));
  if (!rs.length) return null;
  let notRetrieved = 0; // dense never returned it — the pool is the ceiling
  let rerankDemoted = 0; // in the pool, but the cross-encoder pushed it past 10
  let flooredOut = 0; // ranked, then dropped by the relevance floor
  let top10 = 0;
  for (const r of rs) {
    if (r.denseRank === 0) notRetrieved++;
    else if (r.finalRank > 0 && r.finalRank <= 10) top10++;
    else if (rankOf(r.ordered || [], r.gold) > 0 && r.finalRank === 0) flooredOut++;
    else rerankDemoted++;
  }
  const pct = (/** @type {number} */ n) => Math.round((n / rs.length) * 1000) / 10;
  return {
    n: rs.length,
    top10: pct(top10),
    notRetrieved: pct(notRetrieved),
    rerankDemoted: pct(rerankDemoted),
    flooredOut: pct(flooredOut),
  };
}

/**
 * Age profile of what a run actually SHOWED.
 *
 * This exists because no score would have caught the thing it caught: widening
 * the arXiv corpus moved the median result from 2025-12 to 2025-01 and took the
 * share predating the old window from 0% to 64.9%, which invalidated
 * src/arxiv.js's standing assumption that "relevance is implicitly recent"
 * (docs/ARXIV-RAG.md §11). A retrieval change can move WHAT is shown without
 * moving how well it scores.
 *
 * @param {any[]} rows
 * @param {{ monthOf: (id: string, doc?: any) => number, docs?: Record<string, any>, topN?: number, preWindow?: number }} opts
 */
export function ageProfile(rows, { monthOf, docs = {}, topN = 10, preWindow = 0 }) {
  const months = [];
  for (const r of rows) {
    if (r.error) continue;
    for (const id of (r.kept || []).slice(0, topN)) {
      const m = monthOf(id, docs[id]);
      if (m) months.push(m);
    }
  }
  if (!months.length) return null;
  months.sort((a, b) => a - b);
  const fmt = (/** @type {number} */ v) => `${Math.floor(v / 100)}-${String(v % 100).padStart(2, "0")}`;
  const out = {
    n: months.length,
    median: fmt(months[Math.floor(months.length / 2)]),
    oldest: fmt(months[0]),
    newest: fmt(months.at(-1)),
    preWindowPct: 0,
  };
  if (preWindow) {
    out.preWindowPct = Math.round((months.filter((m) => m < preWindow).length / months.length) * 1000) / 10;
  }
  return out;
}

/**
 * The distribution of cross-encoder scores at a given rank, over a run.
 *
 * This is the instrument for arguing about RERANK_FLOOR. The floor is 0.01 on
 * the rerank score and was set once, by hand, against a handful of probes; the
 * only honest way to move it is to see where real on-topic results and a
 * nonsense control actually land. `topScore` is the head of the slate — a
 * control query should sit orders of magnitude below every real one.
 * @param {any[]} rows
 * @param {string} [kind]
 */
export function scoreProfile(rows, kind) {
  const rs = rows.filter((r) => !r.error && r.scored && (!kind || r.kind === kind));
  const tops = rs.map((r) => (r.scores || [])[0] ?? 0).filter((s) => Number.isFinite(s)).sort((a, b) => a - b);
  if (!tops.length) return null;
  const at = (/** @type {number} */ q) => tops[Math.min(tops.length - 1, Math.floor(tops.length * q))];
  return {
    n: tops.length,
    min: round4(tops[0]),
    p05: round4(at(0.05)),
    median: round4(at(0.5)),
    max: round4(tops.at(-1)),
    // How many queries would lose their WHOLE slate at each candidate floor —
    // the cost side of raising it.
    zeroAt: { "0.01": tops.filter((s) => s < 0.01).length, "0.05": tops.filter((s) => s < 0.05).length, "0.1": tops.filter((s) => s < 0.1).length },
  };
}

/** @param {number} v */
function round4(v) {
  return Math.round(v * 10000) / 10000;
}

/**
 * Fraction of the query's content words that also appear in `text`.
 *
 * The leak guard, kept here so both corpora's gold-set builders share one
 * definition. docs/ARXIV-RAG.md §4.3: measuring against the TITLE alone once
 * read as a clean 0.30 while the queries carried 0.68 of the ABSTRACT's
 * vocabulary, which handed BM25 a head start and made it look like the winner.
 * @param {string} query
 * @param {string} text
 * @param {(s: string) => string[]} tokenize
 */
export function lexicalOverlap(query, text, tokenize) {
  const q = new Set(tokenize(query).filter((t) => t.length > 3));
  const t = new Set(tokenize(text).filter((t) => t.length > 3));
  if (!q.size || !t.size) return 0;
  let shared = 0;
  for (const w of q) if (t.has(w)) shared++;
  return shared / q.size;
}

// ---- the graded-relevance judge ---------------------------------------------
//
// Every topical query set in this repo is scored by nDCG over LLM-assigned
// gains, and the rubric below is what assigns them. It was written once and
// hand-copied into four places: scripts/arxiv-eval.mjs (twice, in its two
// grading passes), scripts/arxiv-hosted-eval.mjs and scripts/rag-eval.mjs.
//
// Four copies of a JUDGE is a different kind of duplication from four copies
// of a helper. A gain is only meaningful relative to other gains from the same
// rubric, so the local pack's nDCG and the hosted path's nDCG are comparable
// ONLY while the four prompts are identical — and docs/ARXIV-RAG.md compares
// them directly. Reword one ("substantive" → "useful", say, or the 0–3 scale
// to 0–2) and every table stays green, every number stays plausible, and the
// comparisons across them quietly stop meaning anything.
//
// The chatJson CALL stays at each site: this module reaches no network, which
// is what makes all of it testable.

/** The abstract excerpt each candidate is judged on. */
export const GRADE_ABSTRACT_CHARS = 400;

/** The 0–3 rubric. Changing this invalidates comparisons with every run already recorded. */
export const GRADER_SYSTEM =
  "You grade search results for a scientific literature search engine. For each numbered candidate, " +
  "rate how well it answers the research question: 3 = directly on topic and substantive, 2 = clearly " +
  'related, 1 = same broad field only, 0 = irrelevant. Respond as JSON: {"grades": {"0": 3, "1": 0, ...}} ' +
  "with an entry for every candidate.";

/** Temperature 0 because a judge that varies run to run measures itself. */
export const GRADER_OPTS = { temperature: 0, maxTokens: 1500 };

/**
 * The chatJson messages that grade one pooled candidate set.
 *
 * Candidates are presented by POSITION, not by id — the grader never sees an
 * arXiv id or a PMID, so it cannot recognize a paper it "knows" and grade the
 * document rather than the match. `parseGrades` maps the positions back.
 *
 * @param {string} question the research question, in the pool's language
 * @param {string[]} ids the pooled candidate ids, in the order to present them
 * @param {(id: string) => any} docOf id → `{ title, abstract }`, however the
 *   caller happens to hold its documents (a Map, a plain object, a lookup)
 * @returns {{ role: string, content: string }[]}
 */
export function gradeMessages(question, ids, docOf) {
  const listing = ids
    .map((id, i) => `${i}. ${docOf(id)?.title || ""} — ${(docOf(id)?.abstract || "").slice(0, GRADE_ABSTRACT_CHARS)}`)
    .join("\n");
  return [
    { role: "system", content: GRADER_SYSTEM },
    { role: "user", content: `Research question: ${question}\n\nCandidates:\n${listing}` },
  ];
}

/**
 * The judge's reply → a gain per id, clamped to the rubric's 0–3.
 *
 * An unparseable, missing or out-of-range grade becomes 0 rather than being
 * dropped: nDCG needs a gain for every pooled candidate, and a missing key
 * would silently shorten the ideal ranking and inflate the score. A failed
 * grading call (`json` null) therefore reads as "nothing was relevant", which
 * is visible in the table as a zero row rather than as a quiet omission.
 *
 * @param {any} json the parsed `{ grades: { "0": 3, … } }` reply, or null
 * @param {string[]} ids the same ids, in the same order, gradeMessages was given
 * @returns {Record<string, number>}
 */
export function parseGrades(json, ids) {
  /** @type {Record<string, number>} */
  const g = {};
  for (let i = 0; i < ids.length; i++) {
    const raw = Number(json?.grades?.[String(i)]);
    g[ids[i]] = Number.isFinite(raw) ? Math.max(0, Math.min(3, Math.round(raw))) : 0;
  }
  return g;
}
