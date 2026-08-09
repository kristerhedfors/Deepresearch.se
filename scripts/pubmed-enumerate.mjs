#!/usr/bin/env node
// The SECOND, INDEPENDENT enumeration of PubMed — the cross-check that
// scripts/pubmed-harvest.mjs cannot perform on itself.
//
//   node scripts/pubmed-enumerate.mjs --months 12        # expected counts
//   node scripts/pubmed-enumerate.mjs --verify           # counts vs the harvest
//   node scripts/pubmed-enumerate.mjs --ids --month 2026/06 --sample 2000
//
// ---- why this script exists at all ----------------------------------------
//
// The arXiv harvest reported "339,263 in-window papers kept" and exited 0 with
// totals that agreed with themselves to 0.04%. Half of its oldest month was
// missing. Nothing errored, because the absent records were never requested —
// a single enumeration cannot detect its own holes. Comparing month by month
// against a second, independent listing is what found it.
//
// PubMed's second channel is E-utilities: `esearch` over an Entrez-date window
// returns a count derived from the live index rather than from the file dumps
// the harvester reads, and `--ids` pulls the actual PMIDs for a set-difference
// on a sampled month. Different system, different failure modes, which is the
// only property that makes a cross-check worth running.
//
// ---- rate limits ----------------------------------------------------------
//
// NCBI publishes 3 requests/second unkeyed and 10/second with an API key, asks
// that large jobs run at weekends or 21:00-05:00 US Eastern, and asks every
// registered client to send `tool` and `email`. This script sends both, spaces
// requests to stay inside the UNKEYED rate even when a key is present
// (NCBI_API_KEY is used when set, which only buys headroom), and issues one
// request per month rather than per record — a 12-month verification is about
// 25 requests total.

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const EUTILS = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils";
const TOOL = "deepresearch.se";
const EMAIL = process.env.PUBMED_CONTACT || "info@deepresearch.se";
// 3/s unkeyed is the published ceiling; 400 ms between requests sits under it
// with margin, and the whole job is tens of requests, so there is nothing to
// gain by going faster.
const PAUSE_MS = Number(process.env.NCBI_PAUSE_MS || 400);

/** @param {string[]} argv */
export function parseArgs(argv) {
  const out = { months: 12, corpus: "data/pubmed", verify: false, ids: false, month: "", sample: 0, all: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const [flag, inline] = argv[i].split("=");
    const value = () => (inline !== undefined ? inline : argv[++i]);
    if (flag === "--months") out.months = Number(value());
    else if (flag === "--corpus") out.corpus = String(value());
    else if (flag === "--verify") out.verify = true;
    else if (flag === "--ids") out.ids = true;
    else if (flag === "--month") out.month = String(value());
    else if (flag === "--sample") out.sample = Number(value());
    else if (flag === "--all") out.all = true;
    else if (flag === "--help" || flag === "-h") out.help = true;
    else throw new Error(`Unknown flag: ${flag}`);
  }
  if (!Number.isFinite(out.months) || out.months < 1) throw new Error("--months must be >= 1");
  if (out.ids && !/^\d{4}\/\d{2}$/.test(out.month)) throw new Error("--ids needs --month YYYY/MM");
  return out;
}

/**
 * The last `months` calendar months, newest first, as `YYYY/MM` — the same
 * order the harvester fetches in, so the two tables line up by eye.
 * @param {number} months
 * @param {Date} [now]
 * @returns {string[]}
 */
export function monthWindow(months, now = new Date()) {
  const out = [];
  let y = now.getUTCFullYear();
  let m = now.getUTCMonth() + 1;
  for (let i = 0; i < months; i++) {
    out.push(`${y}/${String(m).padStart(2, "0")}`);
    if (--m === 0) {
      m = 12;
      y--;
    }
  }
  return out;
}

/**
 * The Entrez query for one month of LOAD dates.
 *
 * EDAT — the date the citation entered PubMed — is deliberately the axis, not
 * the publication date: the harvester's file order is load order, so this is
 * the only comparison where the two channels are describing the same set. A
 * count taken on the publication axis would disagree with a correct harvest
 * and send the next person hunting a bug that is not there.
 *
 * @param {string} month `YYYY/MM`
 * @param {{ hasAbstract?: boolean }} [opts]
 * @returns {string}
 */
export function monthQuery(month, opts = {}) {
  const [y, m] = month.split("/");
  const last = new Date(Date.UTC(Number(y), Number(m), 0)).getUTCDate();
  const term = `"${y}/${m}/01"[EDAT] : "${y}/${m}/${last}"[EDAT]`;
  return opts.hasAbstract ? `${term} AND hasabstract` : term;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * One paced, retried E-utilities call, returned UNREAD so the caller decides
 * how to decode it.
 *
 * This module owns the whole E-utilities channel for the project — the `tool`
 * and `email` identification NCBI asks registered clients for, the optional
 * api_key, the 3/s pacing and the 429/5xx backoff. `esearch` wants JSON and
 * `efetch` (scripts/pubmed-harvest.mjs --pmids) wants XML, and the ONE thing
 * that must not happen is a second fetcher growing next to this one with its
 * own idea of the rate limit: two clients pacing themselves independently are
 * two clients exceeding the limit together. So the transport is split out here
 * and `eutils()` below is the JSON convenience over it.
 *
 * @param {string} path
 * @param {Record<string, string>} params `retmode` defaults to json and may be overridden
 * @returns {Promise<Response>}
 */
export async function eutilsFetch(path, params) {
  const qs = new URLSearchParams({ db: "pubmed", retmode: "json", tool: TOOL, email: EMAIL, ...params });
  if (process.env.NCBI_API_KEY) qs.set("api_key", process.env.NCBI_API_KEY);
  const accept = qs.get("retmode") === "json" ? "application/json" : "*/*";
  for (let attempt = 1; ; attempt++) {
    await sleep(PAUSE_MS);
    const res = await fetch(`${EUTILS}/${path}?${qs}`, { headers: { accept } });
    if (res.ok) return res;
    // 429 here means the 3/s ceiling was crossed; back off rather than
    // immediately trying a different query, which is what earns a longer block.
    if ((res.status === 429 || res.status >= 500) && attempt < 6) {
      await sleep(Math.min(60_000, 2000 * 2 ** (attempt - 1)));
      continue;
    }
    throw new Error(`${path}: HTTP ${res.status}`);
  }
}

/**
 * @param {string} path
 * @param {Record<string, string>} params
 */
async function eutils(path, params) {
  return (await eutilsFetch(path, params)).json();
}

/**
 * @param {string} term
 * @returns {Promise<number>}
 */
export async function count(term) {
  const json = await eutils("esearch.fcgi", { term, retmax: "0" });
  return Number(json?.esearchresult?.count ?? NaN);
}

/**
 * PMIDs loaded in one month, capped. Used for the set-difference check, which
 * is the one that catches a hole a count cannot: two channels can agree on a
 * total while disagreeing on WHICH records they hold.
 *
 * `hasabstract` is on by DEFAULT, and that is the difference between a
 * meaningful diff and a misleading one. The corpus holds only records that
 * cleared the abstract floor, so sampling ALL PMIDs compares two different
 * populations and reports the harvester's own filter as a coverage hole. Run
 * unfiltered the first time and this said 4.6% missing for 2026/06 — a number
 * that is neither the filter's drop rate nor a gap, just an artefact of the
 * question. The residual is that PubMed's `hasabstract` means "any abstract"
 * while the corpus floor is 200 characters, so a small deficit is still
 * expected and is stated rather than explained away.
 *
 * @param {string} month
 * @param {number} limit
 * @param {{ hasAbstract?: boolean }} [opts]
 * @returns {Promise<string[]>}
 */
export async function monthIds(month, limit, opts = {}) {
  /** @type {string[]} */
  const ids = [];
  for (let start = 0; start < limit; start += 9999) {
    const json = await eutils("esearch.fcgi", {
      term: monthQuery(month, { hasAbstract: opts.hasAbstract !== false }),
      retmax: String(Math.min(9999, limit - start)),
      retstart: String(start),
      sort: "pub_date",
    });
    const page = json?.esearchresult?.idlist || [];
    ids.push(...page);
    // esearch caps retstart near 10k without the history server; the sample is
    // sized to stay inside one page for exactly that reason.
    if (page.length < 9999) break;
  }
  return ids;
}

/**
 * Read the harvested corpus into per-month PMID sets. Months come from the
 * record's own load position, which the corpus does not carry — so this groups
 * by PUBLICATION year-month and the verifier compares only what is comparable:
 * totals and PMID membership, never a per-month count across the two axes.
 * @param {string} dir
 */
async function readCorpusIds(dir) {
  const { readdir, open } = await import("node:fs/promises");
  /** @type {Set<string>} */
  const pmids = new Set();
  let files = [];
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith(".jsonl"));
  } catch {
    throw new Error(`no corpus at ${dir} — run scripts/pubmed-harvest.mjs first`);
  }
  if (!files.length) throw new Error(`no .jsonl shards in ${dir} — did you mean ${dir}/raw ?`);
  for (const name of files) {
    const fh = await open(join(dir, name));
    for await (const line of fh.readLines()) {
      const m = line.match(/"pmid":"(\d+)"/);
      if (m) pmids.add(m[1]);
    }
    await fh.close();
  }
  return pmids;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(
      "usage: node scripts/pubmed-enumerate.mjs [--months N] [--verify] [--corpus DIR]\n" +
        "       node scripts/pubmed-enumerate.mjs --ids --month YYYY/MM [--sample N] [--all]\n\n" +
        "Counts come from E-utilities (esearch over EDAT), independently of the\n" +
        "FTP archive the harvester reads. --verify diffs the two.",
    );
    return;
  }

  if (args.ids) {
    const limit = args.sample || 9999;
    const ids = await monthIds(args.month, limit, { hasAbstract: !args.all });
    const corpus = await readCorpusIds(join(ROOT, args.corpus, "raw"));
    const missing = ids.filter((id) => !corpus.has(id));
    const population = args.all ? "ALL citations" : "citations WITH an abstract";
    console.log(`${args.month}: sampled ${ids.length} PMIDs from E-utilities (${population}), ${ids.length - missing.length} present in the corpus`);
    console.log(`missing ${missing.length} (${((100 * missing.length) / Math.max(1, ids.length)).toFixed(1)}%)`);
    if (missing.length) console.log(`  e.g. ${missing.slice(0, 10).join(", ")}`);
    // A sampled diff is evidence about the sample, and it is only a defect if
    // the harvest was supposed to cover this month at all — say so rather than
    // letting the number read as a hole. With --all it is not even that: it
    // measures the abstract filter, not coverage.
    console.log(
      args.all
        ? "note: --all compares against a population the corpus never holds — this number is mostly the abstract filter, not a gap."
        : "note: a percentage here is only a defect if the harvest was supposed to cover this month; a small deficit is expected because the corpus floor is 200 chars while PubMed's hasabstract means any abstract.",
    );
    return;
  }

  const months = monthWindow(args.months);
  const corpus = args.verify ? await readCorpusIds(join(ROOT, args.corpus, "raw")) : null;
  console.log(`month     loaded      with-abstract   ${corpus ? "in-corpus" : ""}`);
  let total = 0;
  let totalAbs = 0;
  for (const month of months) {
    const all = await count(monthQuery(month));
    const abs = await count(monthQuery(month, { hasAbstract: true }));
    total += all;
    totalAbs += abs;
    console.log(`${month}  ${String(all).padStart(9)}  ${String(abs).padStart(9)}  (${((100 * abs) / Math.max(1, all)).toFixed(1)}%)`);
  }
  console.log(`total     ${String(total).padStart(9)}  ${String(totalAbs).padStart(9)}  over ${months.length} months`);
  if (corpus) {
    console.log(`corpus holds ${corpus.size.toLocaleString()} unique PMIDs`);
    console.log(
      `coverage vs with-abstract total: ${((100 * corpus.size) / Math.max(1, totalAbs)).toFixed(1)}% ` +
        `— compare against the window the harvest actually fetched, not the whole table.`,
    );
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err?.message || err);
    process.exit(1);
  });
}
