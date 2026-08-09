#!/usr/bin/env node
// Measures what the hosted arXiv index ACTUALLY holds, by submission month, so
// the `window` sentence in src/literature-tools.js CORPUS_FACTS can be derived
// rather than asserted.
//
//   node scripts/arxiv-window.mjs                       # histogram + the sentence
//   node scripts/arxiv-window.mjs --json out.json       # also dump the raw counts
//
// ---- why this exists -------------------------------------------------------
//
// CORPUS_FACTS.arxiv.window is quoted to an agent on every retrieval miss, so a
// wrong one does active harm in BOTH directions:
//
//   - too NARROW, and an agent is told a paper is out of window while it sits
//     in the index, and stops looking;
//   - too WIDE, and a real window boundary is reported as a retrieval failure.
//
// The field carried a comment telling the next person to keep it in step with
// the index. That comment was not enough. It described a contiguous month band
// (2310-2608) because for a long time that is exactly what the index was: one
// datestamp-window fill, one upper bound to bump per delta.
//
// Named-list fills broke that shape. `arxiv-harvest.mjs --ids` covers no month
// at all — it reaches wherever the list reaches, which for a topic corpus is
// thirty years back. So the index stopped being a band and became a band PLUS
// topic-shaped tails, while the sentence still said "anything submitted before
// October 2023 is NOT in this index". That claim was false for tens of
// thousands of papers, and no amount of care over the UPPER bound would have
// caught it, because the drift was underneath.
//
// The lesson is the one bulk-corpus-etl already states in another form: a
// channel cannot detect its own gaps. A count of what a fill PUSHED cannot
// describe the index, because other fills pushed too. Only the index describes
// the index — hence paging it.
//
// ---- the transport ---------------------------------------------------------
//
// Vectorize's v2 list endpoint pages ids (not vectors) 1000 at a time behind a
// cursor. The whole index is ~800k ids, ~800 pages, ~135 s measured. That is
// cheap enough to run whenever a fill lands and far cheaper than being wrong.
//
// Ids are the only thing needed: an arXiv id encodes its own submission month
// (2401.12345 -> 2401), which is why no metadata fetch is involved. Pre-2007
// ids (cs/0503001, math.GT/0309136) carry no month in that form and are counted
// separately rather than dropped — they are real papers and a window sentence
// that ignores them is the same bug again, one era further back.

import { writeFile } from "node:fs/promises";

import { idMonth } from "./arxiv-harvest.mjs";
import { DEFAULT_INDEX, requireCloudflare } from "./arxiv-hosted.mjs";

const API = "https://api.cloudflare.com/client/v4";
const PAGE = 1000;
const TIMEOUT_MS = 60_000;

/** @param {string[]} argv */
export function parseArgs(argv) {
  const out = { index: DEFAULT_INDEX, json: "" };
  for (let i = 0; i < argv.length; i++) {
    const [flag, inline] = argv[i].split("=");
    const value = () => (inline !== undefined ? inline : argv[++i]);
    if (flag === "--index") out.index = String(value());
    else if (flag === "--json") out.json = String(value());
    else if (flag === "--help" || flag === "-h") out.help = true;
    else throw new Error(`Unknown flag: ${flag}`);
  }
  return out;
}

/**
 * Split ids into month buckets. Pre-2007 ids have no month of their own and
 * land in `old`, counted rather than discarded.
 * @param {Iterable<string>} ids
 * @returns {{ months: Map<string, number>, old: number, total: number }}
 */
export function bucketByMonth(ids) {
  const months = new Map();
  let old = 0;
  let total = 0;
  for (const id of ids) {
    total++;
    const m = idMonth(id);
    if (!m) old++;
    else months.set(m, (months.get(m) || 0) + 1);
  }
  return { months, old, total };
}

/**
 * A month counts as SWEPT when it holds at least half as many papers as a
 * typical fully-swept month — the median of the twelve fattest months, which
 * is a robust stand-in for "one month of arXiv" without hard-coding a number
 * that ages.
 * @param {Map<string, number>} months
 */
export function sweptThreshold(months) {
  const top = [...months.values()].sort((a, b) => b - a).slice(0, 12);
  if (!top.length) return 0;
  return (top[Math.floor(top.length / 2)] * 0.5) || 0;
}

/**
 * The longest run of consecutive SWEPT months — the part of the index that
 * genuinely behaves like a window.
 *
 * The first version of this looked for the longest consecutive run of months
 * that held ANY papers at all, and on the real index that returned
 * 0704-2608: every month since April 2007 holds at least one paper, so the
 * run spans almost the whole archive. It would have described an index whose
 * 2007 holds 83 papers and whose 2024 holds 242,630 as one uniform band —
 * replacing a sentence that was too narrow with one far too wide, which is
 * the more dangerous direction, because it tells an agent to keep digging in
 * a decade the index barely covers.
 *
 * Contiguity is not coverage. A scattering of topic-fill papers makes a month
 * non-empty without making it swept, so the density test is what separates
 * the two.
 *
 * @param {Map<string, number>} months
 * @returns {{ from: string, to: string, count: number } | null}
 */
export function sweptBand(months) {
  const floor = sweptThreshold(months);
  const keys = [...months.keys()].sort().filter((k) => (months.get(k) || 0) >= floor);
  if (!keys.length) return null;
  const next = (/** @type {string} */ m) => {
    const y = Number(m.slice(0, 2));
    const mo = Number(m.slice(2));
    return mo === 12 ? String(y + 1).padStart(2, "0") + "01" : m.slice(0, 2) + String(mo + 1).padStart(2, "0");
  };
  let best = null;
  let startIdx = 0;
  for (let i = 0; i <= keys.length; i++) {
    const broken = i === keys.length || (i > startIdx && keys[i] !== next(keys[i - 1]));
    if (!broken) continue;
    const run = keys.slice(startIdx, i);
    const count = run.reduce((a, k) => a + (months.get(k) || 0), 0);
    if (!best || count > best.count) best = { from: run[0], to: run[run.length - 1], count };
    startIdx = i;
  }
  return best;
}

/**
 * The honest window sentence: the band, and then — separately and in the same
 * breath — the tails, so neither is mistaken for the other.
 * @param {{ months: Map<string, number>, old: number, total: number }} hist
 */
export function windowSentence(hist) {
  const band = sweptBand(hist.months);
  if (!band) return "This index is empty.";
  const outside = hist.total - band.count;
  const pct = ((outside / hist.total) * 100).toFixed(1);
  const monthName = (/** @type {string} */ m) =>
    `${["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"][Number(m.slice(2)) - 1]} 20${m.slice(0, 2)}`;
  return (
    `Submission months ${band.from}-${band.to} (${monthName(band.from)} to ${monthName(band.to)}) are swept in bulk — ` +
    `${band.count.toLocaleString("en-US")} papers across every subject arXiv carries. ` +
    `A further ${outside.toLocaleString("en-US")} papers (${pct}%) sit OUTSIDE that band, reaching back to 1991. ` +
    `Those arrived through topic-targeted fills, so pre-${band.from} coverage is dense for some subjects ` +
    `(AI security, AI consciousness, ancient DNA) and near-absent for others. ` +
    `A pre-${band.from} miss is therefore NOT proof the paper is out of window — retry with different terms before concluding it is absent.`
  );
}

/**
 * Page every id out of the index. Ids only: an arXiv id carries its own month.
 * @param {string} index
 * @param {(n: number) => void} [onPage]
 */
export async function* listIds(index, onPage) {
  const { account, token } = requireCloudflare();
  let cursor = "";
  let pages = 0;
  for (;;) {
    const url = new URL(`${API}/accounts/${account}/vectorize/v2/indexes/${index}/list`);
    url.searchParams.set("count", String(PAGE));
    if (cursor) url.searchParams.set("cursor", cursor);
    const res = await fetch(url, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const json = await res.json().catch(() => null);
    if (!res.ok || !json?.success) throw new Error(`vectorize list: HTTP ${res.status}`);
    const vectors = json.result?.vectors || json.result?.ids || [];
    for (const v of vectors) yield typeof v === "string" ? v : v.id;
    onPage?.(++pages, json.result?.totalCount ?? 0);
    // The paging contract is `isTruncated` + `nextCursor`, NOT the `cursor`
    // most Cloudflare list endpoints use. Reading the wrong field does not
    // error — it returns page one and stops, which looks like a complete
    // 1,000-vector index rather than like a bug. Trust isTruncated, and let
    // main() cross-check the total against `totalCount`.
    cursor = json.result?.nextCursor || "";
    if (!json.result?.isTruncated || !cursor || !vectors.length) return;
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log("usage: node scripts/arxiv-window.mjs [--index NAME] [--json FILE]");
    return;
  }
  const started = Date.now();
  const ids = [];
  let reportedTotal = 0;
  for await (const id of listIds(opts.index, (n, total) => {
    reportedTotal = total || reportedTotal;
    if (n % 100 === 0) process.stderr.write(`  ${n} pages…\n`);
  })) {
    ids.push(id);
  }
  // A short read is the failure mode that does not announce itself: paging on
  // the wrong cursor field returns page one and looks like a small index. The
  // endpoint reports its own totalCount, so refuse to describe a window from a
  // listing that does not match it.
  if (reportedTotal && ids.length !== reportedTotal) {
    throw new Error(`listed ${ids.length} ids but the index reports ${reportedTotal} — refusing to describe a window from a partial listing`);
  }
  const hist = bucketByMonth(ids);
  const band = sweptBand(hist.months);
  const sorted = [...hist.months.entries()].sort();

  console.log(`index ${opts.index}: ${hist.total.toLocaleString("en-US")} ids in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  console.log(`pre-2007 style ids (no month in the id): ${hist.old.toLocaleString("en-US")}`);
  if (band) {
    console.log(`swept band: ${band.from}-${band.to}, ${band.count.toLocaleString("en-US")} papers`);
    console.log(`outside that band: ${(hist.total - band.count).toLocaleString("en-US")}`);
  }
  console.log("\nby year:");
  const years = new Map();
  for (const [m, n] of sorted) years.set(m.slice(0, 2), (years.get(m.slice(0, 2)) || 0) + n);
  for (const [y, n] of [...years.entries()].sort()) {
    console.log(`  20${y}  ${String(n).padStart(7)}  ${"#".repeat(Math.min(60, Math.round(n / 2000)))}`);
  }
  console.log("\nthe sentence for CORPUS_FACTS.arxiv.window:\n");
  console.log(windowSentence(hist));

  if (opts.json) {
    await writeFile(opts.json, JSON.stringify({ total: hist.total, old: hist.old, band, months: Object.fromEntries(sorted) }, null, 2));
    console.log(`\nwrote ${opts.json}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
