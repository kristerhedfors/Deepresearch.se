#!/usr/bin/env node
// Bulk-harvests arXiv metadata for a date window into a local JSONL corpus,
// the raw material for the arXiv RAG index (scripts/arxiv-index.mjs).
//
//   node scripts/arxiv-harvest.mjs --months 12 --set cs --out data/arxiv
//
// Transport is OAI-PMH (https://oaipmh.arxiv.org/oai), NOT the Atom query API:
// the query API caps a result set at ~30k rows and pages 100 at a time, while
// ListRecords streams 1000 records per page with a resumption token and no
// total cap. metadataPrefix=arXiv carries the abstract, which is the only
// field the index really needs.
//
// Two facts about the feed that shape this script (both measured 2026-07-26,
// not read off the docs):
//
//   * OAI `from`/`until` filter on the DATESTAMP — when the record was last
//     touched — so a one-year window also returns decade-old papers that got
//     a v2 last week. The submission month is recoverable only from the
//     arXiv ID's YYMM prefix, so that is what `--months` filters on.
//   * <created> in the arXiv metadata prefix is NOT the v1 submission date on
//     this feed. Sampled records show <created> tracking the harvest window
//     (1503.00694 reported created=2026-07-17). Do not trust it; the ID wins.
//
// Old-style ids (`cs/0503001`) are pre-2007 and always fall outside a
// last-year window, so they are dropped by the same rule.
//
// The window is sharded by month. arXiv answers overload with 503 +
// Retry-After (and the query API with 429), so each shard honours Retry-After
// and backs off. Throughput is deliberately NOT maximised: the API Terms of
// Use ask for one request every three seconds on a single connection, counted
// across OAI-PMH and the query API together, so the defaults are
// --concurrency 1 --pause 3000 (they were 3 and 1000, about 9x the published
// rate, until this was checked on 2026-07-26). A full year takes roughly half
// an hour at that rate. Each shard checkpoints its resumption token to
// <out>/state/<shard>.json, so an interrupted harvest resumes instead of
// restarting.

import { createWriteStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OAI = "https://oaipmh.arxiv.org/oai";
const UA = "deepresearch.se-arxiv-harvest/1.0 (+https://deepresearch.se)";

// ---- CLI -------------------------------------------------------------------

/** @param {string[]} argv */
export function parseArgs(argv) {
  // Defaults are TERMS-COMPLIANT, not maximum-throughput (corrected
  // 2026-07-26). arXiv's API Terms of Use ask for "no more than one request
  // every three seconds, and limit requests to a single connection at a time",
  // counted across the query API, OAI-PMH and RSS together — so the previous
  // concurrency 3 + 1 s pause ran about 9x the published rate. One connection
  // with a 3 s pause is the documented limit; raise --concurrency/--pause only
  // if arXiv support has granted this project a higher rate.
  const out = { months: 12, set: "", out: "data/arxiv", concurrency: 1, pauseMs: 3000, until: "", maxPages: 0 };
  for (let i = 0; i < argv.length; i++) {
    const [flag, inline] = argv[i].split("=");
    const value = () => (inline !== undefined ? inline : argv[++i]);
    if (flag === "--months") out.months = Number(value());
    else if (flag === "--set") out.set = String(value() || "");
    else if (flag === "--out") out.out = String(value());
    else if (flag === "--concurrency") out.concurrency = Number(value());
    else if (flag === "--pause") out.pauseMs = Number(value());
    else if (flag === "--until") out.until = String(value());
    else if (flag === "--max-pages") out.maxPages = Number(value());
    else if (flag === "--help" || flag === "-h") out.help = true;
    else throw new Error(`Unknown flag: ${flag}`);
  }
  if (!Number.isFinite(out.months) || out.months < 1 || out.months > 120) {
    throw new Error("--months must be 1..120");
  }
  return out;
}

// ---- window arithmetic (pure, unit-tested) ---------------------------------

/**
 * The list of month shards to harvest, newest first: `{from, until}` ISO days
 * plus the `YYMM` id prefixes that count as in-window.
 * @param {string} todayISO e.g. "2026-07-26"
 * @param {number} months
 */
export function planWindow(todayISO, months) {
  const today = new Date(todayISO + "T00:00:00Z");
  const start = new Date(today);
  start.setUTCFullYear(start.getUTCFullYear() - Math.floor(months / 12));
  start.setUTCMonth(start.getUTCMonth() - (months % 12));
  const iso = (/** @type {Date} */ d) => d.toISOString().slice(0, 10);
  /** @type {Array<{ id: string, from: string, until: string }>} */
  const shards = [];
  let cursor = new Date(start);
  while (cursor < today) {
    const next = new Date(cursor);
    next.setUTCMonth(next.getUTCMonth() + 1);
    next.setUTCDate(1);
    const end = next < today ? next : today;
    shards.push({ id: iso(cursor).slice(0, 7), from: iso(cursor), until: iso(end) });
    cursor = end;
    if (shards.length > 200) break;
  }
  shards.reverse();
  // Submission months that count as in-window: the start month through today's.
  /** @type {string[]} */
  const idMonths = [];
  const m = new Date(start);
  while (m <= today) {
    idMonths.push(String(m.getUTCFullYear() % 100).padStart(2, "0") + String(m.getUTCMonth() + 1).padStart(2, "0"));
    m.setUTCMonth(m.getUTCMonth() + 1);
  }
  return { start: iso(start), end: iso(today), shards, idMonths: new Set(idMonths) };
}

/**
 * Submission month of an arXiv id, or "" for pre-2007 ids that carry none.
 * @param {string} id
 */
export function idMonth(id) {
  const m = /^(\d{2})(\d{2})\.\d{4,5}$/.exec(String(id || "").trim());
  return m ? m[1] + m[2] : "";
}

// ---- OAI record parsing (pure, unit-tested) --------------------------------

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", "#39": "'", "#34": '"' };
/** @param {string} s */
export function decodeEntities(s) {
  return String(s || "").replace(/&(#x?[0-9a-fA-F]+|[a-z]+);/g, (whole, ent) => {
    if (ENTITIES[ent]) return ENTITIES[ent];
    if (ent[0] === "#") {
      const code = ent[1] === "x" || ent[1] === "X" ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : whole;
    }
    return whole;
  });
}

/** @param {string} xml @param {string} tag */
const tagText = (xml, tag) => {
  const m = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`).exec(xml);
  return m ? decodeEntities(m[1]).replace(/\s+/g, " ").trim() : "";
};

/**
 * One `<record>` element → the corpus row, or null when the record is deleted
 * or carries no abstract (a handful of records are metadata-only stubs).
 * @param {string} xml
 * @returns {{ id: string, title: string, abstract: string, authors: string[], categories: string[], primary: string, updated: string, doi: string } | null}
 */
export function parseRecord(xml) {
  if (/<header[^>]*status="deleted"/.test(xml)) return null;
  const id = tagText(xml, "id");
  const abstract = tagText(xml, "abstract");
  const title = tagText(xml, "title");
  if (!id || !abstract || !title) return null;
  const authors = [];
  for (const a of xml.match(/<author>[\s\S]*?<\/author>/g) || []) {
    const key = tagText(a, "keyname");
    const fore = tagText(a, "forenames");
    const name = [fore, key].filter(Boolean).join(" ").trim();
    if (name) authors.push(name);
  }
  const categories = tagText(xml, "categories").split(/\s+/).filter(Boolean);
  return {
    id,
    title,
    abstract,
    authors: authors.slice(0, 40),
    categories,
    primary: categories[0] || "",
    updated: tagText(xml, "updated") || tagText(xml, "datestamp"),
    doi: tagText(xml, "doi"),
  };
}

/** @param {string} xml @returns {{ records: string[], token: string, complete: number }} */
export function parsePage(xml) {
  const records = xml.match(/<record>[\s\S]*?<\/record>/g) || [];
  const tok = /<resumptionToken[^>]*>([\s\S]*?)<\/resumptionToken>/.exec(xml);
  const size = /<resumptionToken[^>]*completeListSize="(\d+)"/.exec(xml);
  return { records, token: tok ? decodeEntities(tok[1]).trim() : "", complete: size ? Number(size[1]) : 0 };
}

// ---- HTTP with arXiv's flow control ----------------------------------------

const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));

/** @param {URL} url @param {(m: string) => void} log */
async function fetchOai(url, log) {
  for (let attempt = 0; attempt < 8; attempt++) {
    let res;
    try {
      res = await fetch(url, { headers: { "user-agent": UA } });
    } catch (err) {
      const wait = Math.min(60, 2 ** attempt) * 1000;
      log(`network error (${err?.message || err}) — retrying in ${wait / 1000}s`);
      await sleep(wait);
      continue;
    }
    if (res.status === 503) {
      const wait = Math.min(300, Number(res.headers.get("retry-after")) || 20) * 1000;
      log(`503 flow control — waiting ${wait / 1000}s`);
      await sleep(wait);
      continue;
    }
    if (res.status === 429) {
      const wait = Math.min(300, Number(res.headers.get("retry-after")) || 30) * 1000;
      log(`429 — waiting ${wait / 1000}s`);
      await sleep(wait);
      continue;
    }
    if (!res.ok) {
      const body = (await res.text()).slice(0, 300);
      if (res.status >= 500) {
        const wait = Math.min(120, 5 * 2 ** attempt) * 1000;
        log(`HTTP ${res.status} — retrying in ${wait / 1000}s`);
        await sleep(wait);
        continue;
      }
      throw new Error(`OAI ${res.status}: ${body}`);
    }
    return await res.text();
  }
  throw new Error("OAI: retries exhausted");
}

// ---- one month shard --------------------------------------------------------

/**
 * @param {{ id: string, from: string, until: string }} shard
 * @param {{ set: string, outDir: string, idMonths: Set<string>, maxPages: number }} opts
 */
async function harvestShard(shard, opts) {
  const stateFile = join(opts.outDir, "state", `${shard.id}.json`);
  const outFile = join(opts.outDir, "raw", `${shard.id}.jsonl`);
  /** @type {{ token?: string, done?: boolean, kept?: number, seen?: number, pages?: number }} */
  let state = {};
  try {
    state = JSON.parse(await readFile(stateFile, "utf8"));
  } catch {
    /* fresh shard */
  }
  const log = (/** @type {string} */ m) => console.log(`[${shard.id}] ${m}`);
  if (state.done) {
    log(`already complete (${state.kept} kept)`);
    return { kept: state.kept || 0, seen: state.seen || 0 };
  }

  // Resuming appends; a fresh shard truncates so a restart can't duplicate.
  const sink = createWriteStream(outFile, { flags: state.token ? "a" : "w" });
  let kept = state.token ? state.kept || 0 : 0;
  let seen = state.token ? state.seen || 0 : 0;
  let pages = state.token ? state.pages || 0 : 0;
  let token = state.token || "";

  for (;;) {
    const url = new URL(OAI);
    if (token) {
      url.searchParams.set("verb", "ListRecords");
      url.searchParams.set("resumptionToken", token);
    } else {
      url.searchParams.set("verb", "ListRecords");
      url.searchParams.set("metadataPrefix", "arXiv");
      url.searchParams.set("from", shard.from);
      url.searchParams.set("until", shard.until);
      if (opts.set) url.searchParams.set("set", opts.set);
    }
    const xml = await fetchOai(url, log);
    if (/<error code="noRecordsMatch"/.test(xml)) {
      log("no records match");
      break;
    }
    const errMatch = /<error code="([^"]+)">([^<]*)</.exec(xml);
    if (errMatch && errMatch[1] !== "noRecordsMatch") {
      // A stale resumption token (badResumptionToken) is recoverable: drop it
      // and restart this shard from the top rather than losing the whole run.
      if (errMatch[1] === "badResumptionToken" && token) {
        log("stale resumption token — restarting shard");
        token = "";
        kept = 0;
        seen = 0;
        pages = 0;
        sink.end();
        return harvestShard(shard, opts);
      }
      throw new Error(`OAI error ${errMatch[1]}: ${errMatch[2]}`);
    }
    const page = parsePage(xml);
    let lines = "";
    for (const raw of page.records) {
      seen++;
      const rec = parseRecord(raw);
      if (!rec) continue;
      if (!opts.idMonths.has(idMonth(rec.id))) continue; // updated older paper
      kept++;
      lines += JSON.stringify(rec) + "\n";
    }
    if (lines) sink.write(lines);
    pages++;
    token = page.token;
    await writeFile(stateFile, JSON.stringify({ token, kept, seen, pages, done: !token }));
    log(`page ${pages}: +${page.records.length} seen, ${kept} kept${page.complete ? ` / ~${page.complete} total` : ""}`);
    if (!token) break;
    if (opts.maxPages && pages >= opts.maxPages) {
      log(`stopping at --max-pages ${opts.maxPages} (resumable)`);
      break;
    }
    await sleep(opts.pauseMs ?? 3000); // the published rate: 1 request / 3 s
  }
  await new Promise((r) => sink.end(r));
  return { kept, seen };
}

// ---- main -------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log("usage: node scripts/arxiv-harvest.mjs [--months 12] [--set cs] [--out data/arxiv] [--concurrency 1] [--pause 3000] [--until YYYY-MM-DD] [--max-pages N]");
    return;
  }
  const today = args.until || new Date().toISOString().slice(0, 10);
  const plan = planWindow(today, args.months);
  const outDir = join(ROOT, args.out);
  await mkdir(join(outDir, "raw"), { recursive: true });
  await mkdir(join(outDir, "state"), { recursive: true });
  console.log(
    `arXiv harvest: datestamps ${plan.start}..${plan.end}, ${plan.shards.length} month shards, ` +
      `submission months ${[...plan.idMonths].join(",")}, set=${args.set || "(all)"}`,
  );

  const queue = [...plan.shards];
  let kept = 0;
  let seen = 0;
  const worker = async () => {
    for (;;) {
      const shard = queue.shift();
      if (!shard) return;
      const r = await harvestShard(shard, { set: args.set, outDir, idMonths: plan.idMonths, maxPages: args.maxPages });
      kept += r.kept;
      seen += r.seen;
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(6, args.concurrency)) }, worker));
  await writeFile(
    join(outDir, "manifest.json"),
    JSON.stringify({ harvestedAt: new Date().toISOString(), today, months: args.months, set: args.set, from: plan.start, to: plan.end, kept, seen }, null, 2) + "\n",
  );
  console.log(`\nDone: ${kept} in-window papers kept out of ${seen} records seen → ${args.out}/raw/*.jsonl`);
}

if (process.argv[1] && process.argv[1].endsWith("arxiv-harvest.mjs")) {
  main().catch((err) => {
    console.error("arxiv-harvest failed:", err.message);
    process.exit(1);
  });
}
