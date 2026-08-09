#!/usr/bin/env node
// Enumerate an arXiv corpus from a file of named query ARMS, paging each to
// exhaustion and date-sharding until every shard fits.
//
// arXiv's Atom API cannot be paged past 10,000 rows — `start >= 10000` is an
// HTTP 500, not an empty page — so no single query can enumerate a large
// literature. The way through is a union of narrower arms, each recursively
// split by submission date until it is small enough to page. That is the
// shape of `data/aisec/query-arxiv.txt`, and this runs it.
//
//   node scripts/arxiv-enumerate.mjs --arms data/aisec/query-arxiv.txt \
//     --out data/aisec/arxiv-ids.txt --state data/aisec/enum-state.json
//
// Resumable: every completed shard is written to the state file, so a rerun
// skips it. That matters because a full run is hours of paced requests and a
// container does not necessarily outlive it.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const API = "https://export.arxiv.org/api/query";
const PACE_MS = 3100; // arXiv asks for 3s; this is not enforced, which is why we do it
// Two different walls, and the second one is the reason this is a function.
//
// A SHORT query pages fine and is bounded only by arXiv's `start >= 10000`
// HTTP 500, so 9,500 leaves room for drift. A LONG query 500s on the paged
// request itself — measured on a 1,772-char arm, which failed at max_results
// 2000/1000/500/100 alike once `start` was non-zero. Stepping the page size
// down does not rescue it; the request is simply too expensive to offset.
//
// So a complex arm gets a ceiling small enough that every shard fits in ONE
// unpaged request. That costs more requests and buys a run that finishes.
const shardCeiling = (query) => (query.length > 1200 ? 400 : 9500);
const MAX_RETRY = 4;

const arg = (f, d) => {
  const i = process.argv.indexOf(f);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : d;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

/** A submittedDate range clause. arXiv wants `[YYYYMMDDHHMM+TO+YYYYMMDDHHMM]`. */
const dateClause = (from, to) => `submittedDate:[${from}0000+TO+${to}2359]`;

async function apiGet(params, label) {
  const url = `${API}?${params}`;
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url);
      const text = await res.text();
      // A 0-byte 200 is what the http:// endpoint returns through some proxies,
      // and it reads as "no matches" rather than "request failed".
      if (res.ok && /<feed\b/.test(text) && /<opensearch:totalResults/.test(text)) return text;
      if (attempt >= MAX_RETRY) throw new Error(`${label}: HTTP ${res.status}, ${text.length} bytes, no usable feed`);
    } catch (err) {
      if (attempt >= MAX_RETRY) throw err;
    }
    await sleep(PACE_MS * (attempt + 2));
  }
}

const totalOf = (xml) => Number((xml.match(/<opensearch:totalResults[^>]*>(\d+)</) || [])[1] ?? -1);
const idsOf = (xml) =>
  [...xml.matchAll(/<id>https?:\/\/arxiv\.org\/abs\/([^<]+)<\/id>/g)].map((m) => m[1].replace(/v\d+$/, ""));

/** How many rows this query+window holds, at the cost of one cheap request. */
async function countOf(query, window, label) {
  const q = window ? `(${query}) AND ${window}` : `(${query})`;
  const xml = await apiGet(`search_query=${encodeURIComponent(q).replace(/%2B/g, "+")}&max_results=1`, label);
  await sleep(PACE_MS);
  return totalOf(xml);
}

/** Page one shard to exhaustion. `page` is complexity-dependent: a long query
 * 500s on a large page, so it steps down rather than failing the shard. */
async function drainShard(query, window, label, out) {
  const q = window ? `(${query}) AND ${window}` : `(${query})`;
  const enc = encodeURIComponent(q).replace(/%2B/g, "+");
  // A complex arm is date-sharded to fit one unpaged request (see
  // shardCeiling), so its page only has to cover the shard.
  let page = q.length > 1200 ? 500 : 1000;
  let start = 0;
  for (;;) {
    let xml;
    try {
      xml = await apiGet(
        `search_query=${enc}&start=${start}&max_results=${page}&sortBy=submittedDate&sortOrder=ascending`,
        `${label}@${start}`,
      );
    } catch (err) {
      // Stepping down helps a page that is merely too big. It does not help a
      // long query that 500s on any paged request, which is why shardCeiling
      // keeps those to a single page in the first place.
      if (page > 50) {
        page = Math.floor(page / 4);
        continue;
      }
      throw err;
    }
    const ids = idsOf(xml);
    for (const id of ids) out.add(id);
    await sleep(PACE_MS);
    if (ids.length < page) return;
    start += ids.length;
    if (start >= 10000) return; // the paging wall; the caller shards to avoid it
  }
}

/** Split a window until each piece is under the paging wall, then drain it. */
async function harvestWindow(query, from, to, label, out, log) {
  const window = dateClause(from, to);
  const n = await countOf(query, window, label);
  if (n === 0) return;
  if (n <= shardCeiling(query)) {
    log(`    ${label} ${from}-${to}: ${n}`);
    await drainShard(query, window, label, out);
    return;
  }
  // Halve the interval. Dates are YYYYMMDD strings; going through Date keeps
  // month lengths honest without a calendar table.
  const a = new Date(`${from.slice(0, 4)}-${from.slice(4, 6)}-${from.slice(6, 8)}T00:00:00Z`);
  const b = new Date(`${to.slice(0, 4)}-${to.slice(4, 6)}-${to.slice(6, 8)}T00:00:00Z`);
  if (b - a < 86400000) {
    // One day and still over the wall: take what paging allows and say so.
    log(`    ${label} ${from}: ${n} rows in ONE DAY — capped at the 10k paging wall`);
    await drainShard(query, window, label, out);
    return;
  }
  const mid = new Date((a.getTime() + b.getTime()) / 2);
  const midStr = mid.toISOString().slice(0, 10).replace(/-/g, "");
  const dayBefore = new Date(mid.getTime() - 86400000).toISOString().slice(0, 10).replace(/-/g, "");
  await harvestWindow(query, from, dayBefore, label, out, log);
  await harvestWindow(query, midStr, to, label, out, log);
}

async function main() {
  const armsPath = arg("--arms", "data/aisec/query-arxiv.txt");
  const outPath = arg("--out", "data/aisec/arxiv-ids.txt");
  const statePath = arg("--state", outPath.replace(/\.txt$/, "-state.json"));
  const coreOnly = process.argv.includes("--core-only");
  const from = arg("--from", "19910801"); // arXiv's first submissions
  const to = arg("--to", new Date().toISOString().slice(0, 10).replace(/-/g, ""));

  const arms = parseArms(readFileSync(armsPath, "utf8")).filter((a) => !coreOnly || a.core);
  const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : { done: [], ids: [] };
  const out = new Set(state.ids);
  const done = new Set(state.done);
  const log = (m) => console.log(m);

  log(`${arms.length} arms, ${done.size} already done, ${out.size} ids so far`);
  for (const arm of arms) {
    if (done.has(arm.name)) continue;
    const before = out.size;
    log(`  ${arm.name} (${arm.core ? "CORE" : "periphery"}) …`);
    await harvestWindow(arm.query, from, to, arm.name, out, log);
    done.add(arm.name);
    mkdirSync(dirname(statePath), { recursive: true });
    writeFileSync(statePath, JSON.stringify({ done: [...done], ids: [...out] }));
    writeFileSync(outPath, [...out].sort().join("\n") + "\n");
    log(`  ${arm.name}: +${out.size - before} new, ${out.size} total`);
  }
  log(`done — ${out.size} unique ids across ${done.size} arms → ${outPath}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
