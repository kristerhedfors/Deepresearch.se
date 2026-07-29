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
// The window is sharded by month. Throughput is deliberately NOT maximised:
// the API Terms of Use ask for one request every three seconds on a single
// connection, counted across OAI-PMH and the query API together, so the
// defaults are --concurrency 1 --pause 3000 (they were 3 and 1000, about 9x
// the published rate, until this was checked on 2026-07-26).
//
// TIMING, measured rather than assumed: a page of ~1300 records takes about
// 2.6 minutes end to end at that rate, so a full year is roughly **15 hours**,
// not the "~25 min" the old 9x-over-limit defaults produced. Run it as an
// unattended job. Shards run newest-first and each checkpoints its resumption
// token to <out>/state/<shard>.json, so an interrupted harvest resumes instead
// of restarting — and an interrupted run still leaves the most recent months
// complete, which is what most "latest research" questions want.
//
// FLOW CONTROL IS NORMAL ON A BULK SWEEP, and being impatient with it is what
// breaks a harvest. Observed 2026-07-26: 29 pages into a shard arXiv began
// answering 503 continuously; the then-policy waited a flat 20 s, gave up
// after 8 identical attempts, and failed a job that was otherwise working. A
// 503/429 here is not an error — it is arXiv telling a bulk sweep to slow
// down, and it can persist for many minutes. So flow control now has its own
// generous attempt ceiling and a progressive backoff (honouring Retry-After
// when sent), while genuine errors keep a short one.

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
  const out = { months: 12, set: "", out: "data/arxiv", concurrency: 1, pauseMs: 3000, until: "", maxPages: 0, keepMonths: "" };
  for (let i = 0; i < argv.length; i++) {
    const [flag, inline] = argv[i].split("=");
    const value = () => (inline !== undefined ? inline : argv[++i]);
    if (flag === "--months") out.months = Number(value());
    else if (flag === "--set") out.set = String(value() || "");
    else if (flag === "--out") out.out = String(value());
    else if (flag === "--concurrency") out.concurrency = Number(value());
    else if (flag === "--pause") out.pauseMs = Number(value());
    else if (flag === "--keep-months") out.keepMonths = String(value());
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
  // Snap to the FIRST of the start month. The id-month filter below admits a
  // whole `YYMM`, so a datestamp window beginning mid-month silently
  // under-covers its own oldest month: papers submitted before that day are
  // in-window by id but are never fetched, and nothing errors.
  //
  // Measured 2026-07-26/27 — this is not theoretical. A 12-month harvest from
  // 2026-07-27 started at 2025-07-27 and returned 3,495 papers for id-month
  // 2507, where the GCS enumeration (scripts/arxiv-gcs.mjs) lists 23,780:
  // **48.1% of the oldest month was missing**, against ~0.1% for every other
  // month. The harvest reported "339,263 in-window papers kept" and looked
  // like a success. Cross-checking the two independent enumerations is what
  // found it.
  start.setUTCDate(1);
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
 * "2310-2506" -> every YYMM in between, inclusive; also accepts a comma list.
 * Walks months rather than comparing strings, so 2312 -> 2401 is not a gap.
 * @param {string} spec
 * @returns {string[]}
 */
export function expandIdMonths(spec) {
  const text = String(spec || "").trim();
  if (!text) return [];
  if (text.includes(",")) return text.split(",").map((s) => s.trim()).filter(Boolean);
  const m = /^(\d{2})(\d{2})-(\d{2})(\d{2})$/.exec(text);
  if (!m) return [text];
  const out = [];
  let year = Number(m[1]);
  let month = Number(m[2]);
  for (let guard = 0; guard < 600; guard++) {
    out.push(String(year).padStart(2, "0") + String(month).padStart(2, "0"));
    if (year === Number(m[3]) && month === Number(m[4])) return out;
    month++;
    if (month > 12) {
      month = 1;
      year = (year + 1) % 100;
    }
  }
  return out;
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

// Attempt ceilings, split by what the status actually MEANS (corrected
// 2026-07-26 after a real failure). A flat 8 attempts killed a harvest 29
// pages into a shard: arXiv answered 503 flow control eight times in a row,
// the script waited a flat 20 s each time, exhausted its retries after ~160
// seconds and threw away a resumable job that was working fine.
//
// 503/429 from OAI-PMH is not an error — it is arXiv telling a bulk sweep to
// slow down, and on a big ListRecords run it can persist for many minutes. A
// job whose total runtime is measured in HOURS should answer that with
// patience, not by giving up in under three. So flow control gets its own
// generous ceiling and a progressive backoff, while genuine errors keep a
// short one.
const FLOW_CONTROL_ATTEMPTS = 40; // ~40 min of waiting at the 60s+ steps
const ERROR_ATTEMPTS = 8;

/** @param {URL} url @param {(m: string) => void} log */
async function fetchOai(url, log) {
  let flowControl = 0;
  let errors = 0;
  for (let attempt = 0; attempt < ERROR_ATTEMPTS + FLOW_CONTROL_ATTEMPTS; attempt++) {
    let res;
    try {
      res = await fetch(url, { headers: { "user-agent": UA } });
    } catch (err) {
      if (++errors > ERROR_ATTEMPTS) throw err;
      const wait = Math.min(60, 2 ** errors) * 1000;
      log(`network error (${err?.message || err}) — retrying in ${wait / 1000}s`);
      await sleep(wait);
      continue;
    }
    if (res.status === 503 || res.status === 429) {
      if (++flowControl > FLOW_CONTROL_ATTEMPTS) {
        throw new Error(`OAI: ${res.status} flow control persisted across ${FLOW_CONTROL_ATTEMPTS} attempts`);
      }
      // Honour Retry-After when arXiv sends one; otherwise back off
      // PROGRESSIVELY rather than hammering the same flat wait. The flat 20 s
      // is what made the earlier failure look like a wall: eight identical
      // retries tell you nothing and give arXiv no room to recover.
      const stated = Number(res.headers.get("retry-after"));
      const backoff = Math.min(300, 20 * 2 ** Math.min(flowControl - 1, 4));
      const wait = (Number.isFinite(stated) && stated > 0 ? Math.min(300, stated) : backoff) * 1000;
      log(`${res.status} flow control (${flowControl}/${FLOW_CONTROL_ATTEMPTS}) — waiting ${wait / 1000}s`);
      await sleep(wait);
      continue;
    }
    if (!res.ok) {
      const body = (await res.text()).slice(0, 300);
      // A genuine server error keeps the SHORT ceiling — the generous one
      // above is for flow control only, and a real 500 should not hold a
      // harvest open for forty minutes.
      if (res.status >= 500 && ++errors <= ERROR_ATTEMPTS) {
        const wait = Math.min(120, 5 * 2 ** errors) * 1000;
        log(`HTTP ${res.status} (${errors}/${ERROR_ATTEMPTS}) — retrying in ${wait / 1000}s`);
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
 * @param {{ set: string, outDir: string, idMonths: Set<string>, maxPages: number, pauseMs?: number }} opts
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
    console.log("usage: node scripts/arxiv-harvest.mjs [--months 12] [--set cs] [--out data/arxiv] [--concurrency 1] [--pause 3000] [--until YYYY-MM-DD] [--keep-months 2310-2506] [--max-pages N]");
    return;
  }
  const today = args.until || new Date().toISOString().slice(0, 10);
  const plan = planWindow(today, args.months);
  // --keep-months DECOUPLES the id-month filter from the datestamp window.
  //
  // planWindow ties them together, which is right when `until` is today: every
  // paper submitted in the window necessarily has its datestamp in the window
  // too. It is WRONG for carving a historical band. Harvesting datestamps
  // 2023-10-01..2025-07-01 and keeping id-months 2310..2507 silently drops
  // every paper submitted in the band but REVISED after it — and the loss is
  // graded, worst in the band's most recent months, because those have had the
  // least time to stop being revised. Measured 2026-07-29: 2506 came back
  // 59.1% complete and 2402 92.1%, and every harvested 2506 paper had
  // `updated <= 2025-07-01` exactly, with none past it.
  //
  // The fix is a second pass over the datestamps AFTER the band, keeping only
  // the band's id-months:
  //   --months 13 --keep-months 2310-2506        (datestamps 2025-07 -> today)
  if (args.keepMonths) plan.idMonths = new Set(expandIdMonths(args.keepMonths));
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
      // pauseMs MUST be forwarded: it was parsed and validated but never
      // reached harvestShard, which silently fell back to its own 3000 default.
      // Harmless at the default, but it meant raising --pause to be politer
      // (or during a throttle) did nothing at all.
      const r = await harvestShard(shard, { set: args.set, outDir, idMonths: plan.idMonths, maxPages: args.maxPages, pauseMs: args.pauseMs });
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
