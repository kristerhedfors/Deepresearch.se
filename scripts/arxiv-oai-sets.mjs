#!/usr/bin/env node
// Bulk-harvests a whole arXiv CATEGORY — all years, abstracts included — into
// the same local JSONL corpus scripts/arxiv-harvest.mjs writes, by scoping
// OAI-PMH ListRecords to a LEAF category set instead of a datestamp window.
//
//   node scripts/arxiv-oai-sets.mjs --sets cs:cs:CR,cs:cs:AI --out data/arxiv-sets
//   node scripts/arxiv-oai-sets.mjs --sets cs:cs:CR --from 2026-07-25     # a delta
//   node scripts/arxiv-oai-sets.mjs --list-sets                           # what exists
//
// ---- why this file exists --------------------------------------------------
//
// The repo's recorded verdict was that OAI-PMH "kept failing" and that
// enumeration therefore belonged to the Atom query API. That verdict was too
// broad, and it did not survive contact on 2026-08-09. The failures on record
// were all DATESTAMP-WINDOW harvests (`from=`/`until=` over the whole archive).
// A `set=`-scoped harvest is a different query against a different index and
// behaves completely differently.
//
// Everything below was MEASURED from a session container on 2026-08-09
// (egress through the agent proxy, NODE_USE_ENV_PROXY=1). None of it is quoted
// from arXiv's documentation, and the probe scripts are in data/aisec/probe/.
//
//   * `ListSets` answers in ~500 ms with **183 entries / 174 distinct specs**,
//     and they go down to the LEAF category: cs:cs:CR, cs:cs:AI, cs:cs:LG,
//     stat:stat:ML, and so on — 155 of them harvestable leaves. So OAI *can*
//     narrow to one topic-relevant slice, which is the fact the old verdict was
//     missing. The nine repeated specs
//     are exactly the physics sub-archives with no subcategories (gr-qc,
//     hep-ex/lat/ph/th, math-ph, nucl-ex/th, quant-ph), listed once as a
//     sub-archive and once as their own leaf; dedupe before counting.
//   * Full `set=cs:cs:CR`, all years, paged to exhaustion:
//         41 pages · 50,798 records · 369 s · 138 rec/s · 0 × HTTP 503
//     across 41 consecutive requests **with no sleep at all**. ~1,300 records
//     and 3.0-3.9 MB per page; first page 650-740 ms, steady state 10-14 s.
//   * Abstracts on EVERY record — 1,300 <abstract> per 1,300 <record> — plus
//     categories, authors, doi, journal-ref, created, updated. Same
//     metadataPrefix=arXiv payload the datestamp harvester parses, so the rows
//     are produced by parseRecord itself (imported below, not reimplemented).
//   * `set=<leaf>&from=<date>` is cheap: `set=cs:cs:CR&from=2026-07-25` →
//     656 records, 1 page, 11 s, 0 failures.
//
// ---- THE TWO SHAPES THAT HANG, and why they are a guard and not a comment --
//
//   | request                        | result                              |
//   |--------------------------------|-------------------------------------|
//   | set=cs:cs:CR         (leaf)    | 1,300 rows, first page in 650 ms    |
//   | set=cs:cs:CR&from=…  (leaf)    | 656 rows, 1 page, 11 s              |
//   | set=cs               (archive) | NO RESPONSE IN 120 s, twice         |
//   | from=…, no set                 | NO RESPONSE IN 100 s                |
//
// The channel is cheap only when it is scoped to a leaf. Anything that makes
// the server range over a whole archive or over the bare datestamp index
// stalls, and a stall is indistinguishable from a slow page until the timeout
// fires — which is very likely the real shape of the incident recorded in
// scripts/arxiv-harvest.mjs's header. So both shapes are REFUSED here by name,
// before a request is sent: an operator who types `--sets cs` gets the
// measurement, not a two-minute wait and a guess.
//
// The refusal has two layers, because shape alone cannot decide the question.
// Offline, an archive-wide spec (`cs`, or the `cs:cs` / `math:math` form the
// hierarchy repeats) is rejected outright — that is the measured `set=cs`
// request. Online, one ListSets call decides the rest: a set is harvestable
// only if no other setSpec extends it. That admits `physics:gr-qc`, a terminal
// two-part set with no children, whose cost is NOT measured here — the run
// says so out loud rather than implying the cs:cs:CR numbers carry over.
//
// ---- pacing ----------------------------------------------------------------
//
// The 138 rec/s above was measured with NO pause between pages, and no flow
// control was encountered. That is a fact about the server, not a licence:
// arXiv's Terms of Use ask for one request every three seconds on a single
// connection, counted across OAI-PMH and the query API together, so the
// default here is --pause 3000 and the sets run SEQUENTIALLY. At that rate the
// same cs.CR harvest is ~490 s (~104 rec/s), and the six AI-relevant leaves
// (cs.CR + cs.LG + cs.AI + cs.CL + cs.CV + stat.ML, ~917k records before
// dedupe) project to ~2.5 h.
//
// 503/429 is flow control, not failure — none was observed on this channel, and
// the retry policy is shared with the datestamp harvester anyway (fetchOai,
// which honours Retry-After and backs off progressively) precisely so that a
// channel nobody has seen throttled yet cannot regress into impatience.
//
// ---- what this run does and does not claim ---------------------------------
//
// It covers the named CATEGORIES, for all years or from `--from` onward. It
// covers no submission-month band, so a set harvest must NOT move the delta
// marker in docs/ARXIV-RAG.md §1 — that marker tracks the datestamp window and
// only that. Cross-listed papers arrive once per set they are listed in, so
// "kept" is a record count, not a document count; scripts/arxiv-corpus.mjs
// dedupes by id, as it already must for the month shards.
//
// Shards are named after the set (`cs-cs-CR.jsonl`), which keeps them out of
// the datestamp path's `YYYY-MM.jsonl` namespace while still being read by
// every `*.jsonl` consumer. The consequence is that arxiv-corpus.mjs's
// `--months` filter matches none of them — it filters on those file names.
//
// Each set checkpoints its resumption token to <out>/state/<set>.json after
// every page, because the corpus is gitignored and the container is ephemeral:
// an interrupted harvest resumes instead of restarting. A checkpoint records
// the `--from` it was taken under and is discarded when the window changes,
// since arXiv embeds the window inside the resumption token and appending a
// different one to the same shard would silently produce a file whose coverage
// nobody can state.

import { createWriteStream } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// The row builders come from the datestamp harvester rather than being written
// again here. That is what makes the two channels' JSONL interchangeable for
// arxiv-corpus.mjs / arxiv-index.mjs / arxiv-vectorize.mjs: not a convention
// two files are asked to keep, but the same function. arxiv-oai-sets.test.mjs
// pins it the way arxiv-harvest.test.mjs pins parseAtomEntry against
// parseRecord.
import { decodeEntities, fetchOai, parsePage, parseRecord } from "./arxiv-harvest.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OAI = "https://oaipmh.arxiv.org/oai";

const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));

// ---- CLI --------------------------------------------------------------------

/** @param {string[]} argv */
export function parseArgs(argv) {
  const out = { sets: "", from: "", out: "data/arxiv-sets", pauseMs: 3000, maxPages: 0, listSets: false, checkSets: true, help: false };
  for (let i = 0; i < argv.length; i++) {
    const [flag, inline] = argv[i].split("=");
    const value = () => (inline !== undefined ? inline : argv[++i]);
    if (flag === "--sets") out.sets = String(value() || "");
    else if (flag === "--from") out.from = String(value() || "");
    else if (flag === "--out") out.out = String(value());
    else if (flag === "--pause") out.pauseMs = Number(value());
    else if (flag === "--max-pages") out.maxPages = Number(value());
    else if (flag === "--list-sets") out.listSets = true;
    else if (flag === "--no-check-sets") out.checkSets = false;
    else if (flag === "--help" || flag === "-h") out.help = true;
    else throw new Error(`Unknown flag: ${flag}`);
  }
  if (out.from && !/^\d{4}-\d{2}-\d{2}$/.test(out.from)) {
    throw new Error(`--from takes an ISO day (YYYY-MM-DD), got ${JSON.stringify(out.from)}`);
  }
  if (!Number.isFinite(out.pauseMs) || out.pauseMs < 0) throw new Error("--pause must be >= 0 ms");
  if (!Number.isFinite(out.maxPages) || out.maxPages < 0) throw new Error("--max-pages must be >= 0 (0 = no limit)");
  if (out.help || out.listSets) return { ...out, setList: [] };
  const setList = parseSetList(out.sets);
  assertHarvestableSets(setList, out.from);
  return { ...out, setList };
}

/**
 * "cs:cs:CR, cs:cs:AI" → ["cs:cs:CR", "cs:cs:AI"], unique, order preserved.
 * A token that is not shaped like a setSpec THROWS rather than being skipped:
 * a dropped set is a whole category silently absent from the corpus, and
 * nothing downstream can tell that from a category arXiv has no papers in.
 * @param {string} spec
 * @returns {string[]}
 */
export function parseSetList(spec) {
  /** @type {string[]} */
  const out = [];
  const seen = new Set();
  for (const token of String(spec || "").split(/[\s,]+/)) {
    if (!token) continue;
    if (!/^[a-z][a-z0-9-]*(:[a-zA-Z0-9-]+){0,3}$/.test(token)) {
      throw new Error(`not an arXiv setSpec: ${JSON.stringify(token)} (they look like cs:cs:CR — run --list-sets)`);
    }
    if (seen.has(token)) continue;
    seen.add(token);
    out.push(token);
  }
  return out;
}

/**
 * True for a spec that asks the server for a WHOLE ARCHIVE: the bare archive
 * group (`cs`) and the doubled form the hierarchy repeats it under (`cs:cs`,
 * `math:math`, `stat:stat`). `set=cs` is the request measured to return
 * nothing in 120 s, twice.
 * @param {string} spec
 */
export function isArchiveWideSet(spec) {
  const parts = String(spec || "").split(":");
  return parts.length === 1 || (parts.length === 2 && parts[0] === parts[1]);
}

/**
 * The OFFLINE half of the guard: refuse the two request shapes that were
 * measured to hang, before any request is sent. The online half is
 * assertLeafSets, which needs ListSets to answer.
 * @param {string[]} sets
 * @param {string} [from]
 */
export function assertHarvestableSets(sets, from = "") {
  if (!sets.length) {
    if (from) {
      throw new Error(
        `--from ${from} with no --sets is the bare datestamp sweep, and it does not answer: measured 2026-08-09, ` +
          `from=2026-07-25 with no set returned NOTHING in 100 s. Scope it to leaf sets, e.g. --sets cs:cs:CR,cs:cs:AI`,
      );
    }
    throw new Error("--sets is required: name one or more LEAF category sets, e.g. --sets cs:cs:CR,cs:cs:AI (--list-sets prints them)");
  }
  const wide = sets.filter(isArchiveWideSet);
  if (wide.length) {
    throw new Error(
      `${wide.join(", ")} names a whole archive, and that request does not answer: measured 2026-08-09, ` +
        `set=cs returned NOTHING in 120 s, twice, while set=cs:cs:CR served its first 1,300 records in 650 ms. ` +
        `Name the leaf categories instead (--list-sets prints them)`,
    );
  }
}

// ---- ListSets ----------------------------------------------------------------

/** Every `<setSpec>` in a ListSets response. @param {string} xml @returns {string[]} */
export function parseSetSpecs(xml) {
  return [...String(xml || "").matchAll(/<setSpec>([\s\S]*?)<\/setSpec>/g)].map((m) => decodeEntities(m[1]).trim()).filter(Boolean);
}

/**
 * The sets nothing else extends — the only ones this channel is measured to
 * serve cheaply. Derived from the hierarchy rather than from a shape rule,
 * because both exist: `cs:cs:CR` is a leaf with three parts and
 * `physics:gr-qc` is a leaf with two.
 * @param {string[]} specs
 * @returns {string[]}
 */
export function leafSets(specs) {
  const all = [...new Set(specs)];
  return all.filter((s) => !all.some((other) => other !== s && other.startsWith(s + ":")));
}

/**
 * The ONLINE half of the guard. Throws when a requested set is not in the
 * ListSets hierarchy at all, or is one the hierarchy extends — the latter
 * being the `set=cs` shape in general form.
 * @param {string[]} sets
 * @param {string[]} specs every setSpec ListSets returned
 * @returns {string[]} the sets whose cost is NOT covered by the cs:cs:CR
 *   measurement (terminal, but not the three-part leaf shape) — a warning, not
 *   an error
 */
export function assertLeafSets(sets, specs) {
  const known = new Set(specs);
  const leaves = new Set(leafSets(specs));
  for (const set of sets) {
    if (!known.has(set)) {
      const near = specs.filter((s) => s.toLowerCase().endsWith(":" + set.toLowerCase())).slice(0, 4);
      throw new Error(`${set} is not one of the ${specs.length} sets arXiv publishes` + (near.length ? ` — did you mean ${near.join(", ")}?` : " (--list-sets prints them)"));
    }
    if (!leaves.has(set)) {
      const children = specs.filter((s) => s.startsWith(set + ":"));
      throw new Error(
        `${set} is not a leaf set: ${children.length} sets sit under it (${children.slice(0, 6).join(", ")}${children.length > 6 ? ", …" : ""}). ` +
          `A non-leaf set is the shape measured not to answer — name the leaves`,
      );
    }
  }
  return sets.filter((s) => s.split(":").length !== 3);
}

/**
 * Fetch every setSpec arXiv publishes. Cheap (measured 2026-08-09: 183 sets,
 * 23 KB, 495 ms) and paged through a resumption token like any other verb, in
 * case arXiv ever splits it.
 * @param {(m: string) => void} [log]
 * @returns {Promise<string[]>}
 */
export async function fetchSetSpecs(log = () => {}) {
  /** @type {string[]} */
  const specs = [];
  let token = "";
  for (let page = 0; page < 20; page++) {
    const url = new URL(OAI);
    url.searchParams.set("verb", "ListSets");
    if (token) url.searchParams.set("resumptionToken", token);
    const xml = await fetchOai(url, log);
    specs.push(...parseSetSpecs(xml));
    token = parsePage(xml).token;
    if (!token) break;
  }
  return [...new Set(specs)];
}

// ---- one set ----------------------------------------------------------------

/** The shard/checkpoint name for a set: `cs:cs:CR` → `cs-cs-CR`. @param {string} set */
export function shardName(set) {
  return String(set).replace(/[^a-z0-9._-]+/gi, "-");
}

/**
 * The request for one page.
 *
 * The resumption token is an EXCLUSIVE argument in OAI-PMH: a continuation
 * request carries `verb` and `resumptionToken` and nothing else. Repeating
 * `metadataPrefix`/`set`/`from` alongside it is a badArgument, and the window
 * is already inside the token anyway — arXiv's tokens are the literal query,
 * `verb=ListRecords&metadataPrefix=arXiv&from=2026-01-08&set=cs%3Acs%3ACR&…`,
 * observed on every page of the cs.CR run.
 *
 * @param {{ set: string, from?: string, token?: string }} req
 * @returns {URL}
 */
export function buildUrl(req) {
  const url = new URL(OAI);
  url.searchParams.set("verb", "ListRecords");
  if (req.token) {
    url.searchParams.set("resumptionToken", req.token);
    return url;
  }
  url.searchParams.set("metadataPrefix", "arXiv");
  url.searchParams.set("set", req.set);
  if (req.from) url.searchParams.set("from", req.from);
  return url;
}

/** @param {{ set: string, from?: string, token?: string }} req @param {(m: string) => void} log */
const defaultFetchXml = (req, log) => fetchOai(buildUrl(req), log);

/**
 * Harvest one leaf set to exhaustion into <outDir>/raw/<set>.jsonl,
 * checkpointing after every page.
 *
 * `fetchXml` is injectable for the same reason harvestIds' is: everything
 * interesting here is the resumption/checkpoint bookkeeping, and bookkeeping
 * that can only be exercised against the live feed is bookkeeping nobody tests.
 *
 * @param {string} set
 * @param {{ outDir: string, from?: string, pauseMs?: number, maxPages?: number,
 *           fetchXml?: (req: { set: string, from?: string, token?: string }, log: (m: string) => void) => Promise<string>,
 *           log?: (m: string) => void, restarted?: boolean }} opts
 * @returns {Promise<{ set: string, kept: number, seen: number, pages: number, complete: number, done: boolean }>}
 */
export async function harvestSet(set, opts) {
  const fetchXml = opts.fetchXml || defaultFetchXml;
  const log = opts.log || ((/** @type {string} */ m) => console.log(`[${set}] ${m}`));
  const from = opts.from || "";
  const pauseMs = opts.pauseMs ?? 3000;
  const name = shardName(set);
  const stateFile = join(opts.outDir, "state", `${name}.json`);
  const outFile = join(opts.outDir, "raw", `${name}.jsonl`);

  /** @type {{ set?: string, from?: string, token?: string, done?: boolean, kept?: number, seen?: number, pages?: number, complete?: number }} */
  let state = {};
  try {
    state = JSON.parse(await readFile(stateFile, "utf8"));
  } catch {
    /* fresh set */
  }
  // A checkpoint taken under a DIFFERENT window is not resumable. arXiv puts
  // the window inside the resumption token, so continuing it would harvest the
  // old window while the manifest claimed the new one, and appending to the
  // shard would leave a file whose coverage cannot be stated afterwards.
  if (state.token || state.done) {
    if ((state.from || "") !== from) {
      log(`checkpoint was taken with from=${state.from || "(none)"} and this run is from=${from || "(none)"} — starting the set over`);
      state = {};
    }
  }
  if (state.done) {
    log(`already complete (${state.kept} kept)`);
    return { set, kept: state.kept || 0, seen: state.seen || 0, pages: state.pages || 0, complete: state.complete || 0, done: true };
  }

  // Resuming appends; a fresh set truncates, so a restart cannot duplicate rows.
  const sink = createWriteStream(outFile, { flags: state.token ? "a" : "w" });
  let kept = state.token ? state.kept || 0 : 0;
  let seen = state.token ? state.seen || 0 : 0;
  let pages = state.token ? state.pages || 0 : 0;
  let complete = state.complete || 0;
  let token = state.token || "";
  let done = false;

  for (;;) {
    const xml = await fetchXml({ set, from, token }, log);
    if (/<error code="noRecordsMatch"/.test(xml)) {
      log(from ? `no records since ${from}` : "no records match");
      done = true;
      break;
    }
    const err = /<error code="([^"]+)">([^<]*)</.exec(xml);
    if (err) {
      if (err[1] === "badResumptionToken" && token) {
        // Recoverable: arXiv expires tokens. Drop the checkpoint and sweep the
        // set again rather than losing the run — but only once, so a feed that
        // rejects every token fails loudly instead of looping.
        await new Promise((r) => sink.end(r));
        await rm(stateFile, { force: true });
        if (opts.restarted) throw new Error(`${set}: arXiv rejected the resumption token twice — not retrying`);
        log("stale resumption token — restarting this set from the top");
        return harvestSet(set, { ...opts, restarted: true });
      }
      throw new Error(`OAI error ${err[1]} on set ${set}: ${err[2]}`);
    }

    const page = parsePage(xml);
    if (page.complete) complete = page.complete;
    let lines = "";
    for (const raw of page.records) {
      seen++;
      // parseRecord, imported — the rows are byte-identical to the datestamp
      // harvester's by construction rather than by agreement.
      const rec = parseRecord(raw);
      if (!rec) continue;
      kept++;
      lines += JSON.stringify(rec) + "\n";
    }
    if (lines) sink.write(lines);
    pages++;
    // THE FINAL PAGE'S TOKEN IS WHITESPACE, NOT EMPTY. Measured on the last
    // page of the cs.CR run: `<resumptionToken>\n\n    </resumptionToken>`.
    // parsePage trims it to "", so the loop stops here; the probe that checked
    // truthiness instead spent one extra request to be told 0 records.
    token = page.token;
    done = !token;
    await writeFile(stateFile, JSON.stringify({ set, from, token, kept, seen, pages, complete, done }));
    log(`page ${pages}: +${page.records.length} seen, ${kept} kept${complete ? ` / ~${complete} total` : ""}`);
    if (done) break;
    if (opts.maxPages && pages >= opts.maxPages) {
      log(`stopping at --max-pages ${opts.maxPages} (resumable)`);
      break;
    }
    await sleep(pauseMs); // arXiv's published rate: one request / 3 s
  }

  await new Promise((r) => sink.end(r));
  return { set, kept, seen, pages, complete, done };
}

// ---- main --------------------------------------------------------------------

const USAGE =
  "usage: node scripts/arxiv-oai-sets.mjs --sets cs:cs:CR,cs:cs:AI [--from YYYY-MM-DD]\n" +
  "                                       [--out data/arxiv-sets] [--pause 3000] [--max-pages N] [--no-check-sets]\n" +
  "       node scripts/arxiv-oai-sets.mjs --list-sets\n\n" +
  "Harvests whole arXiv CATEGORIES through OAI-PMH's set= scoping, into the same\n" +
  "JSONL shape scripts/arxiv-harvest.mjs writes. --from makes it a delta for those\n" +
  "categories. Only LEAF sets are accepted: an archive-wide set (cs, cs:cs) and a\n" +
  "bare --from with no set were both measured NOT TO ANSWER, so both are refused.\n" +
  "A set harvest covers categories, not submission months — it must not move the\n" +
  "delta marker in docs/ARXIV-RAG.md §1.";

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(USAGE);
    return;
  }
  if (args.listSets) {
    const specs = await fetchSetSpecs((m) => console.log(m));
    const leaves = new Set(leafSets(specs));
    console.log(`${specs.length} sets, ${leaves.size} of them harvestable leaves:\n`);
    for (const spec of specs) console.log(`${leaves.has(spec) ? "  leaf  " : "  group"} ${spec}`);
    return;
  }

  if (args.checkSets) {
    const specs = await fetchSetSpecs();
    const unmeasured = assertLeafSets(args.setList, specs);
    for (const set of unmeasured) {
      console.log(`note: ${set} is a leaf but not the three-part category shape the 138 rec/s figure was measured on — its cost is unknown`);
    }
  }

  // resolve, not join: `--out /tmp/probe` is an absolute path, and join would
  // paste it onto the repo root and quietly write the corpus inside the
  // checkout.
  const outDir = resolve(ROOT, args.out);
  await mkdir(join(outDir, "raw"), { recursive: true });
  await mkdir(join(outDir, "state"), { recursive: true });
  console.log(`arXiv set harvest: ${args.setList.length} leaf set(s) ${args.setList.join(", ")}${args.from ? `, from ${args.from}` : ", all years"}`);

  const started = Date.now();
  let kept = 0;
  let seen = 0;
  /** @type {Record<string, { kept: number, seen: number, pages: number, complete: number, done: boolean }>} */
  const perSet = {};
  // SEQUENTIAL, deliberately: arXiv asks for a single connection, counted
  // across OAI-PMH and the query API together.
  for (const set of args.setList) {
    const r = await harvestSet(set, { outDir, from: args.from, pauseMs: args.pauseMs, maxPages: args.maxPages });
    perSet[set] = { kept: r.kept, seen: r.seen, pages: r.pages, complete: r.complete, done: r.done };
    kept += r.kept;
    seen += r.seen;
  }

  await writeFile(
    join(outDir, "manifest.json"),
    JSON.stringify(
      {
        harvestedAt: new Date().toISOString(),
        // Named so nobody mistakes this for the datestamp harvester's manifest:
        // there is no month window here, and `kept` counts RECORDS, so a paper
        // cross-listed in two harvested sets is in it twice.
        channel: "oai-sets",
        sets: args.setList,
        from: args.from || null,
        kept,
        seen,
        perSet,
      },
      null,
      2,
    ) + "\n",
  );

  const secs = (Date.now() - started) / 1000;
  console.log(`\nDone: ${kept} records kept of ${seen} seen in ${secs.toFixed(1)}s → ${args.out}/raw/*.jsonl`);
  console.log(`  dedupe/inspect: node scripts/arxiv-corpus.mjs --dir ${args.out}`);
  console.log(`  fill it:        node scripts/arxiv-vectorize.mjs --index deepresearch-se-arxiv --corpus ${join(args.out, "raw")} --work ${join(args.out, "vectorize")}`);
}

if (process.argv[1] && process.argv[1].endsWith("arxiv-oai-sets.mjs")) {
  main().catch((err) => {
    console.error("arxiv-oai-sets failed:", err.message);
    process.exit(1);
  });
}
