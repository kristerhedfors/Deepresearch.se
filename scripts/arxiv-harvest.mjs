#!/usr/bin/env node
// Bulk-harvests arXiv metadata for a date window into a local JSONL corpus,
// the raw material for the arXiv RAG index (scripts/arxiv-index.mjs).
//
//   node scripts/arxiv-harvest.mjs --months 12 --set cs --out data/arxiv
//   node scripts/arxiv-harvest.mjs --ids ids.txt                # exactly these papers
//
// Transport is OAI-PMH (https://oaipmh.arxiv.org/oai), NOT the Atom query API:
// the query API caps a result set at ~30k rows and pages 100 at a time, while
// ListRecords streams 1000 records per page with a resumption token and no
// total cap. metadataPrefix=arXiv carries the abstract, which is the only
// field the index really needs.
//
// ---- --ids: the one case the datestamp window cannot serve -----------------
//
// A NAMED list — "index exactly these papers", a reading list, the references
// of one survey, a curated corpus reaching back to the 1990s — is the opposite
// problem. Those ids are scattered across thirty years of submission months, so
// serving 500 of them from ListRecords means sweeping every month they fall in
// and throwing away everything else: hours of paced requests to keep a few
// hundred kilobytes.
//
// OAI-PMH's answer for a named record is `GetRecord`, which takes ONE
// identifier per call. At arXiv's published rate of one request every three
// seconds that is 3 s per paper — 83 hours for 100k ids — so it is not the
// channel for a list of any size. The Atom query API's `id_list` is: it takes
// a whole batch per request and the batch is bounded by the REQUEST LINE, not
// by a row count (see ID_LIST_LINE_LIMIT below). ~360 modern ids per call at
// 3 s a call is ~90 min for 100k, against 83 hours.
//
// The cost of that choice is the one thing the PubMed sibling
// (scripts/pubmed-harvest.mjs --pmids) did not have to pay: `efetch` hands back
// the same DTD as the archive files there, so the named-list path reuses the
// archive parser verbatim. Here the two channels speak DIFFERENT schemas — OAI
// `<arXiv>` metadata vs Atom `<entry>` — so a second parser is unavoidable.
// What is NOT negotiable is the record it produces: parseAtomEntry emits the
// same keys in the same order as parseRecord, and a test pins the two against
// each other so the JSONL stays interchangeable for scripts/arxiv-corpus.mjs,
// arxiv-index.mjs and arxiv-vectorize.mjs.
//
// The run has no window: no month shards, no id-month filter, no resumption
// token. The window IS the list, and it prints that rather than a coverage
// claim it cannot make. A named-list run is therefore NOT a delta and must not
// move the delta marker in docs/ARXIV-RAG.md §1 — it says nothing about which
// submission months are complete.
//
// FIVE ways an id can vanish on this channel, every one of them silent, all
// reproduced against the live API on 2026-08-09 and all covered by the
// reconciliation in harvestIds:
//
//   * an id arXiv does not hold (2401.99999) is simply ABSENT — HTTP 200,
//     totalResults 0, no error element;
//   * an old-style id written WITH its subject class (math.GT/0309136, which
//     is a perfectly good arxiv.org/abs URL) matches nothing. The canonical
//     lookup form is archive-only, math/0309136 — which is also exactly what
//     OAI's <id> carries, so canonicalId() normalises to it;
//   * `arXiv:2301.07041` — the prefixed form every citation style writes —
//     matches nothing either, and neither does an upper-cased archive
//     (CS/0501001);
//   * omitting `max_results` silently truncates the answer to TEN entries,
//     whatever the batch size, so it is always sent;
//   * requesting the `http://` host arXiv's own docs give returns a 0-BYTE BODY
//     through this environment's egress proxy — no error, no non-200 — so the
//     endpoint is https and parseAtomFeed refuses anything that is not a feed
//     rather than reporting an empty transport as a list of absent ids;
//   * one unparseable id fails the WHOLE batch with HTTP 400
//     (`incorrect_id_format_for_foo/0501001`), taking ~360 good ids with it —
//     so a rejected id is peeled off by name and the batch retried, rather
//     than losing the run to one bad line in a bibliography.
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
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OAI = "https://oaipmh.arxiv.org/oai";
// HTTPS, and it is NOT interchangeable with the `http://` form arXiv's own API
// documentation gives — do not "fix" this back to match the docs. Measured
// 2026-08-09 from a session container: `http://export.arxiv.org/api/query?…`
// comes back through the egress proxy as a **0-byte body with no error and no
// non-200 status**, while the identical https request returns the full feed.
// A harvester on the http form would report every id as "not returned" and
// write nothing, which is indistinguishable from a correct run against a list
// of ids arXiv does not hold. parseAtomFeed's `isFeed` check is the guard that
// turns that into a hard failure instead.
const API = "https://export.arxiv.org/api/query";
const UA = "deepresearch.se-arxiv-harvest/1.0 (+https://deepresearch.se)";

// ---- CLI -------------------------------------------------------------------

/** The datestamp-window flags. Meaningless against an explicit id list.
 * `--concurrency` is not among them: arXiv asks for a single connection either
 * way, so the flag is already a no-op above 1 rather than a claim about a
 * window. */
const WINDOW_FLAGS = ["--months", "--set", "--until", "--keep-months", "--max-pages"];

/** @param {string[]} argv */
export function parseArgs(argv) {
  // Defaults are TERMS-COMPLIANT, not maximum-throughput (corrected
  // 2026-07-26). arXiv's API Terms of Use ask for "no more than one request
  // every three seconds, and limit requests to a single connection at a time",
  // counted across the query API, OAI-PMH and RSS together — so the previous
  // concurrency 3 + 1 s pause ran about 9x the published rate. One connection
  // with a 3 s pause is the documented limit; raise --concurrency/--pause only
  // if arXiv support has granted this project a higher rate.
  const out = { months: 12, set: "", out: "data/arxiv", concurrency: 1, pauseMs: 3000, until: "", maxPages: 0, keepMonths: "", ids: "", minAbstract: 0 };
  /** Which flags the command line actually CARRIED. `--months` has a default,
   * so "was it set?" cannot be read off its value — and silently ignoring a
   * window flag is how a run ends up harvesting something other than what its
   * command line says. */
  const given = new Set();
  for (let i = 0; i < argv.length; i++) {
    const [flag, inline] = argv[i].split("=");
    const value = () => (inline !== undefined ? inline : argv[++i]);
    given.add(flag);
    if (flag === "--months") out.months = Number(value());
    else if (flag === "--set") out.set = String(value() || "");
    else if (flag === "--out") out.out = String(value());
    else if (flag === "--concurrency") out.concurrency = Number(value());
    else if (flag === "--pause") out.pauseMs = Number(value());
    else if (flag === "--keep-months") out.keepMonths = String(value());
    else if (flag === "--until") out.until = String(value());
    else if (flag === "--max-pages") out.maxPages = Number(value());
    else if (flag === "--ids") out.ids = String(value());
    else if (flag === "--min-abstract") out.minAbstract = Number(value());
    else if (flag === "--help" || flag === "-h") out.help = true;
    else throw new Error(`Unknown flag: ${flag}`);
  }
  if (!Number.isFinite(out.months) || out.months < 1 || out.months > 120) {
    throw new Error("--months must be 1..120");
  }
  if (!Number.isFinite(out.minAbstract) || out.minAbstract < 0) {
    throw new Error("--min-abstract must be >= 0");
  }
  if (out.ids) {
    // Refused, not ignored. There is no datestamp window on this path, no
    // month shards and no id-month filter, so every one of these describes
    // machinery --ids does not have.
    const clash = WINDOW_FLAGS.filter((f) => given.has(f));
    if (clash.length) {
      throw new Error(`--ids takes an explicit list, not a window: ${clash.join(", ")} cannot be combined with it`);
    }
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

// ---- explicit id lists: canonical ids, batching, Atom parsing --------------
// (pure, unit-tested — see the "--ids" note in the header for the channel)

/**
 * One token from an id list → the CANONICAL arXiv id, or "" when the token is
 * not an arXiv id at all.
 *
 * Canonical means the form OAI-PMH's `<id>` carries, which is also the only
 * form the query API's `id_list` matches, which is also the vector id
 * (`CORPORA.arxiv.vectorId` in scripts/rag-corpora.mjs strips a version and
 * nothing else). Three normalisations, each of which was a silent miss against
 * the live API on 2026-08-09 — HTTP 200, totalResults 0, no error anywhere:
 *
 *   * the VERSION SUFFIX goes. `2301.07041v2` is accepted by the API and comes
 *     back as v2 — the metadata of that version, not the current one — while a
 *     bare id comes back as the latest (`1706.03762` → `1706.03762v7`). The
 *     corpus holds one row per paper under the version-less id, so asking for
 *     the version a bibliography happened to cite would store a stale abstract
 *     under an id that claims to be current. Strip it and let arXiv answer with
 *     the latest, which is what the OAI harvest holds.
 *   * the SUBJECT CLASS goes from an old-style id. `math.GT/0309136` is a valid
 *     arxiv.org/abs URL and matches nothing in `id_list`; `math/0309136` is the
 *     id OAI emits for the same paper (verified via GetRecord). Same for
 *     `cond-mat.stat-mech/0603313` → `cond-mat/0603313`.
 *   * the `arXiv:` prefix goes, and the archive is lower-cased — `CS/0501001`
 *     is as invisible as `arXiv:2301.07041`.
 *
 * The old-style shape is checked but the ARCHIVE NAME is not validated against
 * a list. A wrong allow-list would silently reject real 1990s ids
 * (`q-alg/9705011`, `adap-org/…`, `mtrl-th/…` — the defunct archives are
 * exactly the ones a hand-written list would omit), and arXiv validates the
 * name itself: an unknown archive comes back as `incorrect_id_format_for_…`,
 * which harvestIds peels off by name.
 *
 * @param {string} token
 * @returns {string} the canonical id, or "" if this is not one
 */
export function canonicalId(token) {
  let text = String(token || "").trim();
  if (!text) return "";
  // A citation just as often arrives as a link as as an id.
  const url = /(?:arxiv\.org)\/(?:abs|pdf)\/(.+)$/i.exec(text);
  if (url) text = url[1].replace(/\.pdf$/i, "").replace(/[?#].*$/, "");
  text = text.replace(/^arxiv\s*:\s*/i, "").trim();
  text = text.replace(/v\d+$/i, "");
  // New style: YYMM.NNNN or YYMM.NNNNN, since April 2007.
  if (/^\d{4}\.\d{4,5}$/.test(text)) return text;
  // Old style: archive[.subject_class]/YYMMNNN, up to March 2007.
  const old = /^([a-z][a-z-]*)(?:\.[a-z-]+)?\/(\d{7})$/i.exec(text);
  if (old) return `${old[1].toLowerCase()}/${old[2]}`;
  return "";
}

/**
 * An id list file → unique canonical ids, in the order given.
 *
 * Accepts what a list pasted out of a bibliography, a spreadsheet column or a
 * browser actually looks like: one id per line or comma/space separated, blank
 * lines, `#` comments, `arXiv:` prefixes, version suffixes and abs/pdf URLs.
 *
 * Anything else THROWS rather than being skipped, for the same reason the
 * PubMed sibling does: a silently dropped id is indistinguishable from an id
 * arXiv does not hold, and the whole point of this path is that the caller
 * named the records, so "I asked for 150 and got 149" must have exactly one
 * possible cause — reported at the end.
 *
 * @param {string} text
 * @returns {string[]}
 */
export function parseIdList(text) {
  /** @type {string[]} */
  const out = [];
  const seen = new Set();
  for (const line of String(text || "").split("\n")) {
    // `#` starts a comment, but only outside a URL fragment — and ids never
    // contain one, so stripping from the first `#` is safe here.
    for (const token of line.replace(/#.*$/, "").split(/[\s,;]+/)) {
      if (!token) continue;
      const id = canonicalId(token);
      if (!id) throw new Error(`not an arXiv id: ${JSON.stringify(token)}`);
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

/**
 * The HTTP request line arXiv's front end accepts, in bytes — MEASURED
 * 2026-08-09, not read off a doc. 365 modern ids gave a 4,062-byte request line
 * and HTTP 200; 370 gave 4,117 and
 *
 *   HTTP 400 — Request Line is too large (4117 > 4094)
 *
 * POST is not the way out: the API documents it, but a POST of the same query
 * came back 400 with an error entry on every batch size tried. So the batch is
 * bounded by BYTES, not by a row count — which matters because id length is not
 * constant. A modern id is 10 chars; `cond-mat.stat-mech/0603313` normalises to
 * 16, and a 1990s-heavy list therefore fits far fewer per call. A fixed count
 * tuned on modern ids would 400 the moment the list reached back far enough.
 */
export const ID_LIST_LINE_LIMIT = 4094;

/** Bytes of `id_list=` payload one request may carry. The limit above minus the
 * rest of the request line (`GET /api/query?…&max_results=NNNN HTTP/1.1`) and a
 * margin, so a longer `max_results` or a redirect cannot tip it over. */
export const ID_LIST_BUDGET = 3900;

/**
 * Split ids into request-sized batches by BYTE BUDGET (see ID_LIST_LINE_LIMIT).
 * An id longer than the whole budget would loop forever, so it goes in a batch
 * of its own and lets arXiv reject it by name.
 * @param {string[]} ids
 * @param {number} [budget]
 * @returns {string[][]}
 */
export function batchIds(ids, budget = ID_LIST_BUDGET) {
  /** @type {string[][]} */
  const batches = [];
  /** @type {string[]} */
  let current = [];
  let bytes = 0;
  for (const id of ids) {
    // +1 for the comma this id needs once it is not the first in the batch.
    const cost = Buffer.byteLength(id) + (current.length ? 1 : 0);
    if (current.length && bytes + cost > budget) {
      batches.push(current);
      current = [];
      bytes = 0;
    }
    current.push(id);
    bytes += current.length === 1 ? Buffer.byteLength(id) : cost;
  }
  if (current.length) batches.push(current);
  return batches;
}

/**
 * The canonical arXiv id an Atom `<entry>` is about, or "" when there is none.
 *
 * Separate from parseAtomEntry because the RECONCILIATION needs the id even
 * when the row is unusable. An entry with no `<summary>` still names a paper
 * arXiv did return, and folding it in with the ids that never came back would
 * put it in missing.txt — telling the operator to go re-fetch something they
 * already have.
 *
 * @param {string} xml
 * @returns {string}
 */
export function entryId(xml) {
  // An error entry carries an `arxiv.org/api/errors#…` id, so it fails the
  // canonical-id test rather than needing a separate shape check.
  return canonicalId(tagText(xml, "id"));
}

/**
 * One Atom `<entry>` → the same corpus row parseRecord builds from an OAI
 * record: the same keys, in the same order, so the two channels' JSONL is
 * interchangeable downstream. arxiv-harvest.test.mjs pins that against a real
 * pair; if you add a field to one, add it to the other in the same change.
 *
 * Returns null for an entry the index cannot use — the API's own error entries
 * (`<id>https://arxiv.org/api/errors#…`), and the rare record with no abstract
 * or title. Use entryId to attribute one of those to a requested id.
 *
 * @param {string} xml
 * @returns {{ id: string, title: string, abstract: string, authors: string[], categories: string[], primary: string, updated: string, doi: string } | null}
 */
export function parseAtomEntry(xml) {
  const id = entryId(xml);
  if (!id) return null;
  const title = tagText(xml, "title");
  // Atom calls the abstract `<summary>`; OAI calls it `<abstract>`. This is the
  // one field name that differs between the channels and it is the field the
  // whole index is built on.
  const abstract = tagText(xml, "summary");
  if (!title || !abstract) return null;
  /** @type {string[]} */
  const authors = [];
  for (const a of xml.match(/<author>[\s\S]*?<\/author>/g) || []) {
    // <name> is already "Forenames Keyname" here, which is how the OAI path
    // assembles <forenames> + <keyname>.
    const name = tagText(a, "name");
    if (name) authors.push(name);
  }
  const categories = [...xml.matchAll(/<category\b[^>]*\bterm="([^"]*)"/g)].map((m) => decodeEntities(m[1])).filter(Boolean);
  const primary = decodeEntities((/<arxiv:primary_category\b[^>]*\bterm="([^"]*)"/.exec(xml) || [])[1] || "") || categories[0] || "";
  // OAI's <categories> puts the primary first and parseRecord takes
  // categories[0] as `primary`. Atom states the primary separately, so it is
  // hoisted to keep that invariant true of both channels' rows.
  const ordered = primary ? [primary, ...categories.filter((c) => c !== primary)] : categories;
  return {
    id,
    title,
    abstract,
    authors: authors.slice(0, 40),
    categories: ordered,
    primary,
    // THE ONE FIELD THAT IS NOT THE SAME NUMBER ON BOTH CHANNELS, and it is a
    // semantic difference, not a format one. OAI's <updated> is the last time
    // the METADATA was touched; Atom's is the latest VERSION's submission date.
    // Measured on hep-th/9711200 (Maldacena 1997): OAI says 2014-11-17, Atom
    // says 1998-01-22 for v3. Every other field matches byte for byte.
    //
    // Atom's is kept, and the number is not load-bearing either way: nothing
    // routes on it. The submission month comes from the ID everywhere it
    // matters (§3, and arxivMonth in scripts/rag-corpora.mjs), and `updated`
    // only reaches the index as the display date `d` (arxiv-vectorize.mjs
    // vectorMetadata, which cuts it to 10 chars — so it is cut here too).
    updated: (tagText(xml, "updated") || tagText(xml, "published")).slice(0, 10),
    doi: tagText(xml, "arxiv:doi"),
  };
}

/**
 * One Atom feed → its entries and the ids arXiv REJECTED by name.
 *
 * The rejection list is the load-bearing half. One unparseable id 400s the
 * whole request (`incorrect_id_format_for_foo/0501001`, reproduced 2026-08-09),
 * so without pulling the names out of the error entries a single bad line in a
 * bibliography costs the ~360 good ids batched with it.
 *
 * @param {string} xml
 * @returns {{ entries: string[], rejected: string[], total: number, isFeed: boolean }}
 */
export function parseAtomFeed(xml) {
  const text = String(xml || "");
  const entries = text.match(/<entry>[\s\S]*?<\/entry>/g) || [];
  const total = Number((/<opensearch:totalResults[^>]*>(\d+)</.exec(text) || [])[1] || 0);
  const rejected = [...text.matchAll(/errors#incorrect_id_format_for_([^\s"<]+)/g)].map((m) => decodeEntities(m[1]));
  // "Did arXiv answer at all?" — a block page, a proxy error or a changed
  // schema all produce zero entries, and so does a legitimate batch of ids
  // arXiv does not hold. Only the feed marker separates the two.
  const isFeed = /<feed\b/.test(text) && /<opensearch:totalResults/.test(text);
  return { entries, rejected: [...new Set(rejected)], total, isFeed };
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

/**
 * @param {URL} url
 * @param {(m: string) => void} log
 * @param {{ allow400?: boolean }} [opts] `allow400` returns a 400 body instead
 *   of throwing — the query API answers one malformed id in a batch with a 400
 *   whose body NAMES it, and that name is what lets the caller peel the id off
 *   and keep the other ~360.
 */
async function fetchOai(url, log, opts = {}) {
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
      if (res.status === 400 && opts.allow400) return await res.text();
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

// ---- one explicit id list ---------------------------------------------------

/**
 * One `id_list` call, as Atom XML.
 *
 * Split out from harvestIds so a test can hand it canned responses:
 * everything interesting about this path is the RECONCILIATION, and
 * reconciliation logic that can only be exercised against the live API is
 * logic nobody tests.
 *
 * A 400 is NOT thrown here. The batch-poisoning case comes back as 400 with an
 * `incorrect_id_format_for_…` entry naming the offender, and harvestIds needs
 * to read that name to peel the id off and retry — so the body is returned and
 * the caller decides. Everything else goes through the same flow-control
 * policy as OAI-PMH, since arXiv counts the two channels against one budget.
 *
 * @param {string[]} ids
 * @param {(m: string) => void} [log]
 * @returns {Promise<string>}
 */
export async function fetchIdList(ids, log = () => {}) {
  // The query string is assembled by hand, NOT with URLSearchParams, because
  // URLSearchParams percent-encodes a comma as %2C — three bytes where the
  // separator needs one. The byte budget below is measured against arXiv's
  // 4,094-byte request-line limit, so tripling every separator overshoots it:
  // 373 modern ids are 3,897 bytes raw and 4,689 encoded, and arXiv answers
  // `400 Request Line is too large (4689 > 4094)`. A raw comma is legal in a
  // query string and arXiv accepts it, which is what makes the budget real.
  // Old-style ids carry a `/` for the same reason — encoding it to %2F would
  // cost two extra bytes each on exactly the ids that are already longest.
  const url = `${API}?id_list=${ids.join(",")}&max_results=${ids.length}`;
  // `max_results` is ALWAYS sent. Without it the API answers with TEN entries
  // whatever the batch size — HTTP 200, no warning (measured 2026-08-09: 20
  // ids in, 10 entries out). Nothing downstream could tell that from 10
  // absent papers.
  return fetchOai(new URL(url), log, { allow400: true });
}

/**
 * @typedef {{
 *   requested: number, batches: number, entries: number, kept: number,
 *   unusable: number, unattributed: number, rejected: string[], missing: string[],
 *   unrequested: string[], belowIndexFloor: number, shard: string
 * }} IdHarvestStats
 */

/** The abstract floor the index applies for itself — `corpusRows` in
 * scripts/arxiv-vectorize.mjs and `loadCorpus` in scripts/arxiv-corpus.mjs both
 * skip a paper under 200 characters. The harvest does NOT drop those rows (the
 * OAI path does not either, so the JSONL stays the same corpus), but with a
 * named list "why is my paper not in the index" has to be answerable at harvest
 * time rather than after a paid fill, so they are counted and reported. */
export const INDEX_ABSTRACT_FLOOR = 200;

/**
 * Harvest an EXPLICIT list of arXiv ids through the Atom query API into the
 * same JSONL the OAI path writes.
 *
 * The return value is a full RECONCILIATION of requested against returned, and
 * that is why this is a function rather than a loop in main(). Every way an id
 * can vanish on this channel is silent at the transport level (see the header
 * note), so every requested id ends in exactly one bucket — kept, unusable,
 * rejected by arXiv, or never returned — and the buckets are asserted to add up
 * before the shard is renamed into place.
 *
 * @param {string[]} ids canonical ids (parseIdList output)
 * @param {string} dir the corpus `raw/` directory
 * @param {{ name?: string, budget?: number, pauseMs?: number, minAbstract?: number,
 *           fetchXml?: (ids: string[], log: (m: string) => void) => Promise<string>,
 *           onBatch?: (done: number, total: number) => void,
 *           log?: (m: string) => void }} [opts]
 * @returns {Promise<IdHarvestStats>}
 */
export async function harvestIds(ids, dir, opts = {}) {
  const fetchXml = opts.fetchXml || fetchIdList;
  const log = opts.log || ((/** @type {string} */ m) => console.log(`  ${m}`));
  const minAbstract = opts.minAbstract || 0;
  // Two lists harvested into one --out must not clobber each other's shard, so
  // the name carries the list's identity rather than being a constant. The
  // `ids-` prefix keeps it out of the `YYYY-MM.jsonl` namespace the OAI path
  // owns while still being picked up by every `*.jsonl` reader.
  const shard = `ids-${String(opts.name || "list").replace(/[^a-z0-9._-]+/gi, "-")}.jsonl`;
  const wanted = [...new Set(ids.map((s) => String(s).trim()).filter(Boolean))];

  const partPath = join(dir, `${shard}.part`);
  const sink = createWriteStream(partPath);
  /** How each id the API accounted for was disposed of. */
  const seen = new Map();
  /** @type {IdHarvestStats} */
  const stats = {
    requested: wanted.length,
    batches: 0,
    entries: 0,
    kept: 0,
    unusable: 0,
    unattributed: 0,
    rejected: [],
    missing: [],
    unrequested: [],
    belowIndexFloor: 0,
    shard,
  };

  try {
    return await runIdBatches(wanted, { batches: batchIds(wanted, opts.budget), sink, seen, stats, fetchXml, log, minAbstract, opts, partPath });
  } catch (err) {
    // Close the stream and take the `.part` with us. The rename-on-success
    // discipline already means a `.part` is never mistaken for a finished
    // shard, but leaving a half-written one behind invites a rerun to be
    // diffed against garbage. `writableEnded` because the accounting guards
    // throw AFTER the stream is closed, and end()ing twice raises
    // ERR_STREAM_ALREADY_FINISHED on top of the real error.
    if (!sink.writableEnded) await new Promise((r) => sink.end(r));
    await rm(partPath, { force: true });
    throw err;
  }
}

/** The body of harvestIds, split out only so the failure path above can be one
 * `catch`. Not exported: the reconciliation contract belongs to harvestIds.
 * @param {string[]} wanted
 * @param {any} ctx
 * @returns {Promise<IdHarvestStats>}
 */
async function runIdBatches(wanted, ctx) {
  const { batches, sink, seen, stats, fetchXml, log, minAbstract, opts, partPath } = ctx;
  let done = 0;
  for (const [i, batch] of batches.entries()) {
    // A batch can need more than one request: arXiv rejects the whole call for
    // one bad id, so the offender is dropped and the rest re-asked. Bounded by
    // the batch size — each round removes at least one id or throws.
    let slice = batch;
    for (let round = 0; slice.length; round++) {
      if (round) await sleep(opts.pauseMs ?? 3000);
      const xml = await fetchXml(slice, log);
      stats.batches++;
      const feed = parseAtomFeed(xml);
      if (!feed.isFeed) {
        // Not "0 results" — no Atom feed came back at all. A block page, a
        // proxy error or a changed schema all look like this, and all of them
        // would otherwise write a shard that is quietly missing papers.
        throw new Error(`arXiv did not answer with an Atom feed for batch ${stats.batches} (${slice.length} ids) — refusing to write a shard`);
      }
      if (feed.rejected.length) {
        const drop = new Set(feed.rejected.map((r) => canonicalId(r) || r));
        const next = slice.filter((id) => !drop.has(id));
        if (next.length === slice.length) {
          // The rejection names an id this batch did not send, so dropping it
          // would not shrink the slice and the retry would loop forever.
          throw new Error(`arXiv rejected ids that were not in the batch: ${feed.rejected.join(", ")}`);
        }
        for (const id of slice) if (drop.has(id)) seen.set(id, "rejected");
        stats.rejected.push(...slice.filter((id) => drop.has(id)));
        log(`arXiv rejected ${slice.length - next.length} id(s) as malformed — retrying the other ${next.length}: ${[...drop].slice(0, 5).join(", ")}`);
        slice = next;
        continue;
      }
      let pending = "";
      for (const entry of feed.entries) {
        stats.entries++;
        const rec = parseAtomEntry(entry);
        if (!rec) {
          // Attribute it if the entry names a paper at all: an abstract-less
          // entry is an id arXiv DID return, and calling it "not returned"
          // would put it in missing.txt as work to redo. An entry with no
          // readable id at all is a shape change and is counted on its own.
          const id = entryId(entry);
          if (id) {
            seen.set(id, "unusable");
            stats.unusable++;
          } else {
            stats.unattributed++;
          }
          continue;
        }
        if (rec.abstract.length < minAbstract) {
          seen.set(rec.id, "unusable");
          stats.unusable++;
          continue;
        }
        if (rec.abstract.length < INDEX_ABSTRACT_FLOOR) stats.belowIndexFloor++;
        stats.kept++;
        seen.set(rec.id, "kept");
        pending += `${JSON.stringify(rec)}\n`;
        if (pending.length > 1 << 20) {
          sink.write(pending);
          pending = "";
        }
      }
      if (pending) sink.write(pending);
      slice = [];
    }
    done += batch.length;
    opts.onBatch?.(done, wanted.length);
    if (i < batches.length - 1) await sleep(opts.pauseMs ?? 3000); // the published rate: 1 request / 3 s
  }

  await new Promise((r) => sink.end(r));

  stats.missing = wanted.filter((id) => !seen.has(id));
  const wantedSet = new Set(wanted);
  // Should be empty: `id_list` answers under the id it was asked for, modulo
  // the version suffix canonicalId already strips. It is reported rather than
  // asserted away because it is also the only way an id could be "missing"
  // while nothing went wrong.
  stats.unrequested = [...seen.keys()].filter((id) => !wantedSet.has(id));

  // THE CHECK THIS FUNCTION EXISTS FOR. Summing the buckets, not counting the
  // keys of `seen` — the latter is true by construction (missing is defined as
  // its complement) and would pass while an id was counted in two buckets or a
  // duplicate entry inflated `kept`.
  const accounted = stats.kept + stats.unusable + stats.rejected.length + stats.missing.length;
  if (accounted !== wanted.length) {
    throw new Error(
      `accounting is broken: ${stats.kept} kept + ${stats.unusable} unusable + ${stats.rejected.length} rejected + ` +
        `${stats.missing.length} missing = ${accounted}, for ${wanted.length} requested ids` +
        (stats.unrequested.length ? ` (${stats.unrequested.length} came back under an id nobody asked for: ${stats.unrequested.slice(0, 5).join(", ")})` : ""),
    );
  }
  // Nothing kept means the shard would be an empty file the fill happily
  // reports as "done — 0 vectors". For a list the caller wrote out by hand
  // that is always a mistake.
  if (!stats.kept) {
    throw new Error(
      `kept 0 of ${wanted.length} requested ids (${stats.rejected.length} rejected by arXiv, ` +
        `${stats.missing.length} not returned, ${stats.unusable} unusable) — refusing to write an empty shard`,
    );
  }

  await rename(partPath, partPath.replace(/\.part$/, ""));
  return stats;
}

/**
 * Print the reconciliation. Every requested id lands in exactly one bucket and
 * the line says so out loud, because "150 requested / 150 in the index" is the
 * only claim this path is allowed to make without checking.
 * @param {IdHarvestStats} stats
 * @param {string} missingPath
 */
function reportIdHarvest(stats, missingPath) {
  console.log(
    `done — ${stats.kept} kept of ${stats.requested} requested ` +
      `(${stats.rejected.length} rejected by arXiv, ${stats.missing.length} not returned, ${stats.unusable} unusable entries) ` +
      `in ${stats.batches} id_list call${stats.batches === 1 ? "" : "s"}`,
  );
  if (stats.rejected.length) {
    console.log(`  ${stats.rejected.length} id(s) arXiv would not parse: ${stats.rejected.slice(0, 10).join(", ")}`);
  }
  if (stats.belowIndexFloor) {
    console.log(
      `  ${stats.belowIndexFloor} kept row(s) have an abstract under ${INDEX_ABSTRACT_FLOOR} chars — ` +
        `arxiv-vectorize.mjs skips those, so they will NOT reach the index`,
    );
  }
  if (stats.unrequested.length) {
    console.log(`  ${stats.unrequested.length} entry/entries came back under an id that was not asked for: ${stats.unrequested.slice(0, 10).join(", ")}`);
  }
  if (stats.missing.length) {
    console.log(`  ${stats.missing.length} id(s) NOT returned by arXiv — written to ${missingPath}`);
    console.log(`    e.g. ${stats.missing.slice(0, 10).join(", ")}`);
  }
}

// ---- main -------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(
      "usage: node scripts/arxiv-harvest.mjs [--months 12] [--set cs] [--out data/arxiv] [--concurrency 1]\n" +
        "                                     [--pause 3000] [--until YYYY-MM-DD] [--keep-months 2310-2506] [--max-pages N]\n" +
        "       node scripts/arxiv-harvest.mjs --ids FILE [--out DIR] [--pause 3000] [--min-abstract N]\n\n" +
        "--ids reads an explicit list of arXiv ids (one per line, `#` comments, `arXiv:`\n" +
        "prefixes, version suffixes and abs/pdf URLs all accepted) and fetches exactly\n" +
        "those papers through the Atom query API. It has no datestamp window, so it\n" +
        "cannot be combined with --months / --set / --until / --keep-months / --max-pages,\n" +
        "and a named-list run is NOT a delta: do not move the delta marker in\n" +
        "docs/ARXIV-RAG.md §1 after one.",
    );
    return;
  }

  if (args.ids) {
    const listPath = join(ROOT, args.ids);
    const ids = parseIdList(await readFile(listPath, "utf8"));
    if (!ids.length) throw new Error(`${args.ids}: no arXiv ids in the list`);
    const outDir = join(ROOT, args.out);
    const rawDir = join(outDir, "raw");
    const stateDir = join(outDir, "state");
    await mkdir(rawDir, { recursive: true });
    await mkdir(stateDir, { recursive: true });
    // Not the "datestamps …, N month shards, submission months …" line: there
    // is no window here, and printing one would be a claim about coverage this
    // path cannot make. The window IS the list.
    const batches = batchIds(ids);
    console.log(
      `arXiv harvest: an EXPLICIT list of ${ids.length} ids (no datestamp window, no id-month filter) ` +
        `in ${batches.length} id_list call${batches.length === 1 ? "" : "s"}`,
    );
    const started = Date.now();
    const stats = await harvestIds(ids, rawDir, {
      name: basename(listPath).replace(/\.[^.]*$/, ""),
      pauseMs: args.pauseMs,
      minAbstract: args.minAbstract,
      onBatch: (done, total) => console.log(`  id_list ${done}/${total}`),
    });
    // Written even when empty, so "which ids does arXiv not have" is a file the
    // next run can diff rather than something scrolled off a terminal.
    const missingPath = join(stateDir, `${stats.shard.replace(/\.jsonl$/, "")}-missing.txt`);
    await writeFile(missingPath, stats.missing.join("\n") + (stats.missing.length ? "\n" : ""));
    reportIdHarvest(stats, missingPath);
    console.log(`  shard: ${join(args.out, "raw", stats.shard)} (${((Date.now() - started) / 1000).toFixed(1)}s)`);
    // No manifest.json: that file records a datestamp window and a months
    // count, and this run has neither. Writing one with `months: 12` next to a
    // list of 40 papers would be a false coverage claim, and the next reader of
    // data/<dir> is exactly who it would mislead.
    console.log(`fill it: node scripts/arxiv-vectorize.mjs --index deepresearch-se-arxiv --corpus ${join(args.out, "raw")} --work ${join(args.out, "vectorize")}`);
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
