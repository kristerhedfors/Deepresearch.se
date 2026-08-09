import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ID_LIST_BUDGET,
  INDEX_ABSTRACT_FLOOR,
  batchIds,
  canonicalId,
  decodeEntities,
  expandIdMonths,
  harvestIds,
  idMonth,
  parseArgs,
  parseAtomEntry,
  parseAtomFeed,
  parseIdList,
  parsePage,
  parseRecord,
  planWindow,
} from "./arxiv-harvest.mjs";
import { hash01 } from "./arxiv-corpus.mjs";
import { titleOverlap } from "./arxiv-goldset.mjs";
import { vectorMetadata } from "./arxiv-vectorize.mjs";

test("planWindow shards the window by month, newest first", () => {
  const p = planWindow("2026-07-26", 12);
  assert.equal(p.start, "2025-07-01");
  assert.equal(p.end, "2026-07-26");
  assert.equal(p.shards[0].id, "2026-07");
  assert.equal(p.shards[0].until, "2026-07-26", "the newest shard stops at today, not month end");
  assert.equal(p.shards.at(-1).from, "2025-07-01", "the oldest shard starts at the FIRST of its month");
  // Shards must tile the window without a gap.
  for (let i = 0; i < p.shards.length - 1; i++) {
    assert.equal(p.shards[i].from, p.shards[i + 1].until, `gap between ${p.shards[i + 1].id} and ${p.shards[i].id}`);
  }
});

test("planWindow's id-month set spans the window and wraps the year", () => {
  const p = planWindow("2026-07-26", 12);
  assert.ok(p.idMonths.has("2507") && p.idMonths.has("2512") && p.idMonths.has("2601") && p.idMonths.has("2607"));
  assert.ok(!p.idMonths.has("2506"), "a month before the window is out");
  assert.ok(!p.idMonths.has("2608"), "a month after today is out");
  assert.equal(planWindow("2026-03-15", 3).shards.length, 4);
});

test("idMonth reads the submission month off the id and rejects pre-2007 ids", () => {
  assert.equal(idMonth("2507.00600"), "2507");
  assert.equal(idMonth("2607.12345"), "2607");
  assert.equal(idMonth(" 2601.09999 "), "2601");
  assert.equal(idMonth("cs/0503001"), "", "old-style ids carry no YYMM and are always out of window");
  assert.equal(idMonth(""), "");
  assert.equal(idMonth("garbage"), "");
});

test("parseArgs validates rather than silently accepting nonsense", () => {
  assert.equal(parseArgs(["--months", "6"]).months, 6);
  assert.equal(parseArgs(["--months=6"]).months, 6);
  assert.equal(parseArgs(["--set", "cs"]).set, "cs");
  assert.equal(parseArgs([]).months, 12);
  assert.throws(() => parseArgs(["--months", "0"]), /1\.\.120/);
  assert.throws(() => parseArgs(["--nope"]), /Unknown flag/);
});

test("decodeEntities handles the escapes arXiv abstracts actually carry", () => {
  assert.equal(decodeEntities("Fishburn&#39;s function"), "Fishburn's function");
  assert.equal(decodeEntities("a &lt; b &amp; c &gt; d"), "a < b & c > d");
  assert.equal(decodeEntities("&#x41;&#66;"), "AB");
  assert.equal(decodeEntities("&unknownent;"), "&unknownent;", "an unknown entity is left alone, not dropped");
});

const RECORD = `<record>
  <header><identifier>oai:arXiv.org:2607.00042</identifier><datestamp>2026-07-20</datestamp></header>
  <metadata><arXiv xmlns="http://arxiv.org/OAI/arXiv/">
    <id>2607.00042</id>
    <created>2026-07-17</created>
    <updated>2026-07-20</updated>
    <authors>
      <author><keyname>Lindqvist</keyname><forenames>Anna</forenames></author>
      <author><keyname>Chen</keyname><forenames>Bo</forenames></author>
    </authors>
    <title>Private Retrieval over Scientific
    Corpora</title>
    <categories>cs.CR cs.IR</categories>
    <abstract>We study retrieval under differential privacy &amp; report an
    epsilon &lt; 1 result.</abstract>
  </arXiv></metadata>
</record>`;

test("parseRecord flattens one OAI record into a corpus row", () => {
  const r = parseRecord(RECORD);
  assert.equal(r.id, "2607.00042");
  assert.equal(r.title, "Private Retrieval over Scientific Corpora", "wrapped titles are collapsed to one line");
  assert.deepEqual(r.authors, ["Anna Lindqvist", "Bo Chen"]);
  assert.deepEqual(r.categories, ["cs.CR", "cs.IR"]);
  assert.equal(r.primary, "cs.CR");
  assert.ok(r.abstract.includes("privacy & report"), "entities decoded");
  assert.ok(!r.abstract.includes("\n"));
});

test("parseRecord drops records the index cannot use", () => {
  assert.equal(parseRecord('<record><header status="deleted"><identifier>x</identifier></header></record>'), null);
  assert.equal(parseRecord(RECORD.replace(/<abstract>[\s\S]*?<\/abstract>/, "")), null, "no abstract, nothing to embed");
  assert.equal(parseRecord("<record></record>"), null);
});

test("parsePage finds every record and the resumption token", () => {
  const xml = `<ListRecords>${RECORD}${RECORD}<resumptionToken completeListSize="4210" cursor="0">tok&amp;123</resumptionToken></ListRecords>`;
  const p = parsePage(xml);
  assert.equal(p.records.length, 2);
  assert.equal(p.token, "tok&123", "the token is entity-decoded before it goes back on the wire");
  assert.equal(p.complete, 4210);
  // The final page carries an EMPTY token, which must read as "stop", not "resume".
  assert.equal(parsePage(`<ListRecords>${RECORD}<resumptionToken/></ListRecords>`).token, "");
});

test("hash01 is deterministic and spread over 0..1 — the sampler depends on both", () => {
  assert.equal(hash01("2607.00042"), hash01("2607.00042"));
  assert.notEqual(hash01("2607.00042"), hash01("2607.00043"));
  const values = Array.from({ length: 400 }, (_, i) => hash01("arxiv-rag-v1:2607." + i));
  assert.ok(values.every((v) => v >= 0 && v < 1));
  const inFirstHalf = values.filter((v) => v < 0.5).length;
  assert.ok(inFirstHalf > 150 && inFirstHalf < 250, `sampler is skewed: ${inFirstHalf}/400 below 0.5`);
});

test("titleOverlap is the gold set's leak guard", () => {
  const title = "Differentially Private Retrieval for Scientific Corpora";
  assert.equal(titleOverlap("Differentially private retrieval for scientific corpora", title), 1);
  assert.ok(titleOverlap("How can literature search protect user privacy guarantees?", title) < 0.5);
  assert.equal(titleOverlap("", title), 0);
});

test("the datestamp window fully covers every id-month it admits", () => {
  // THE REGRESSION. The id filter accepts a whole YYMM, so a datestamp window
  // starting mid-month leaves that month half-unfetched with no error at all.
  // Measured 2026-07-27: a 12-month harvest from 2026-07-27 began at
  // 2025-07-27 and returned 3,495 papers for id-month 2507, where the GCS
  // enumeration lists 23,780 — 48.1% missing, against ~0.1% for every other
  // month, while the run reported "339,263 in-window papers kept".
  for (const today of ["2026-07-27", "2026-07-26", "2026-01-15", "2026-03-31", "2025-12-01"]) {
    const p = planWindow(today, 12);
    const oldestShard = p.shards.at(-1);
    // Every id-month admitted must be one the shards actually cover from its
    // first day, so the oldest shard has to start on a month boundary.
    assert.ok(oldestShard.from.endsWith("-01"), `${today}: oldest shard starts mid-month (${oldestShard.from})`);
    const oldestIdMonth = oldestShard.from.slice(2, 4) + oldestShard.from.slice(5, 7);
    assert.ok(
      p.idMonths.has(oldestIdMonth),
      `${today}: oldest shard ${oldestShard.from} has no matching id-month`,
    );
    // And no admitted id-month may fall before the window starts.
    for (const m of p.idMonths) {
      const asDate = `20${m.slice(0, 2)}-${m.slice(2)}-01`;
      assert.ok(asDate >= p.start, `${today}: id-month ${m} predates the window start ${p.start}`);
    }
  }
});

test("expandIdMonths walks a YYMM range inclusively", () => {
  assert.deepEqual(expandIdMonths("2310-2401"), ["2310", "2311", "2312", "2401"]);
  assert.equal(expandIdMonths("2310-2506").length, 21);
  assert.deepEqual(expandIdMonths("2401,2402"), ["2401", "2402"]);
  assert.deepEqual(expandIdMonths(""), []);
});

test("--keep-months decouples the id filter from the datestamp window", () => {
  // The trap this exists for: planWindow ties the keep-filter to the fetch
  // window, which is right when `until` is today (a paper submitted in the
  // window always has its datestamp in it) and wrong for a historical band.
  // Harvesting datestamps 2023-10..2025-07 while keeping id-months 2310..2507
  // never REQUESTS a 2506 paper revised in 2026, so it is silently absent —
  // measured at 59.1% coverage for 2506 against 92.1% for 2402.
  const args = parseArgs(["--months", "13", "--keep-months", "2310-2506"]);
  assert.equal(args.keepMonths, "2310-2506");
  const months = new Set(expandIdMonths(args.keepMonths));
  // The second pass sweeps datestamps AFTER the band, keeping only the band.
  assert.ok(months.has("2506"));
  assert.ok(months.has("2310"));
  assert.ok(!months.has("2507"), "2507 is already indexed and must not be re-kept");
  assert.ok(!months.has("2607"));
});

// ============================================================================
// --ids: the explicit-id channel (Atom query API)
//
// Everything below is offline. The fixtures are shaped like a real
// `export.arxiv.org/api/query?id_list=…` response — the namespaces, the
// `<opensearch:totalResults>` element and the `<entry>` layout are copied from
// a live answer for math/0309136,2301.07041v2,1706.03762 (2026-08-09) — because
// the claim this path rests on is that the Atom channel produces the same
// corpus row as the OAI channel, and a fixture that drifts from the wire stops
// testing that.
// ============================================================================

const ATOM_ABSTRACT =
  "We study retrieval under differential privacy and report an epsilon &lt; 1 result on a corpus of scientific abstracts. ".repeat(3);

/** @param {string} id @param {{ abstract?: string, cats?: string[], primary?: string, doi?: string, title?: string }} [o] */
const entry = (id, o = {}) => `  <entry>
    <id>http://arxiv.org/abs/${id}</id>
    <title>${o.title ?? `Paper ${id}`}</title>
    <updated>2026-07-20T17:31:04Z</updated>
    <link href="https://arxiv.org/abs/${id}" rel="alternate" type="text/html"/>
    ${o.abstract === "" ? "" : `<summary>${o.abstract ?? ATOM_ABSTRACT}</summary>`}
    ${(o.cats ?? ["cs.CR", "cs.IR"]).map((c) => `<category term="${c}" scheme="http://arxiv.org/schemas/atom"/>`).join("\n    ")}
    <published>2026-07-17T17:50:26Z</published>
    <arxiv:primary_category term="${o.primary ?? (o.cats ?? ["cs.CR"])[0]}"/>
    ${o.doi ? `<arxiv:doi>${o.doi}</arxiv:doi>` : ""}
    <author>
      <name>Anna Lindqvist</name>
    </author>
    <author>
      <name>Bo Chen</name>
    </author>
  </entry>`;

/** The error entry arXiv answers a malformed id with — HTTP 400, and it takes
 * every other id in the request down with it. @param {string} id */
const errorEntry = (id) => `  <entry>
    <id>https://arxiv.org/api/errors#incorrect_id_format_for_${id}</id>
    <title>Error</title>
    <summary>incorrect id format for ${id}</summary>
  </entry>`;

/** @param {string[]} parts @param {number} [total] */
const feed = (parts, total = parts.length) => `<?xml version='1.0' encoding='UTF-8'?>
<feed xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/" xmlns:arxiv="http://arxiv.org/schemas/atom" xmlns="http://www.w3.org/2005/Atom">
  <id>https://arxiv.org/api/HqHWuZByps04ziY4fhVbPNHBZ9Y</id>
  <title>arXiv Query</title>
  <opensearch:itemsPerPage>${parts.length}</opensearch:itemsPerPage>
  <opensearch:totalResults>${total}</opensearch:totalResults>
  <opensearch:startIndex>0</opensearch:startIndex>
${parts.join("\n")}
</feed>`;

async function scratch() {
  return mkdtemp(join(tmpdir(), "arxiv-ids-"));
}

// ---- canonical ids ----------------------------------------------------------

test("canonicalId normalises every form an id arrives in", () => {
  assert.equal(canonicalId("2401.12345"), "2401.12345");
  assert.equal(canonicalId(" 2401.1234 "), "2401.1234", "4-digit ids predate the 5-digit switch and are still valid");
  // The version goes: the corpus holds one row per paper under the version-less
  // id (CORPORA.arxiv.vectorId in scripts/rag-corpora.mjs strips exactly this),
  // and asking arXiv for v2 returns v2's metadata, not the current version's.
  assert.equal(canonicalId("2301.07041v2"), "2301.07041");
  assert.equal(canonicalId("2301.07041V12"), "2301.07041");
  // Every one of these matched NOTHING against the live API — HTTP 200,
  // totalResults 0, no error element (measured 2026-08-09).
  assert.equal(canonicalId("arXiv:2301.07041"), "2301.07041");
  assert.equal(canonicalId("arxiv: 2301.07041"), "2301.07041");
  assert.equal(canonicalId("CS/0501001"), "cs/0501001");
  assert.equal(canonicalId("math.GT/0309136"), "math/0309136", "the subject class is not part of the lookup id");
  assert.equal(canonicalId("cond-mat.stat-mech/0603313"), "cond-mat/0603313");
  // A citation just as often arrives as a link.
  assert.equal(canonicalId("https://arxiv.org/abs/math/0309136v1"), "math/0309136");
  assert.equal(canonicalId("http://arxiv.org/abs/2301.07041v2"), "2301.07041");
  assert.equal(canonicalId("https://arxiv.org/pdf/2401.12345v2.pdf"), "2401.12345");
});

test("canonicalId keeps the 1990s archives, including the defunct ones", () => {
  // The corpus reaches back to the 1990s, so these are not an edge case. The
  // archive name is deliberately NOT checked against a list: the archives a
  // hand-written allow-list would omit are exactly the retired ones below, and
  // arXiv rejects a bad name by name anyway (see the harvestIds peel-off test).
  for (const id of ["hep-th/9711200", "astro-ph/9901001", "q-alg/9705011", "cond-mat/0603313", "math-ph/0203001", "adap-org/9905001"]) {
    assert.equal(canonicalId(id), id, id);
  }
});

test("canonicalId returns '' for things that are not arXiv ids", () => {
  // "" rather than a throw: parseIdList turns it into a named error, and
  // parseAtomEntry uses the same call to recognise the API's own error entries
  // (their <id> is an arxiv.org/api/errors# URL).
  for (const bad of ["", "garbage", "9901001", "10.1000/xyz", "2401.123", "2401.123456", "cs/05010012", "cs/0501", "https://arxiv.org/api/errors#incorrect_id_format_for_foo"]) {
    assert.equal(canonicalId(bad), "", JSON.stringify(bad));
  }
});

// ---- the id list ------------------------------------------------------------

test("parseIdList reads the shapes a pasted list actually has", () => {
  const text = [
    "# a reading list",
    "2301.07041v2, arXiv:1706.03762",
    "",
    "math.GT/0309136   # old-style, with the subject class",
    "https://arxiv.org/abs/hep-th/9711200",
    "2301.07041   # the same paper again, unversioned",
  ].join("\n");
  assert.deepEqual(parseIdList(text), ["2301.07041", "1706.03762", "math/0309136", "hep-th/9711200"]);
});

test("parseIdList preserves order, because the caller named the records", () => {
  assert.deepEqual(parseIdList("2401.00003\n2401.00001\n2401.00002\n"), ["2401.00003", "2401.00001", "2401.00002"]);
  assert.deepEqual(parseIdList(""), []);
  assert.deepEqual(parseIdList("# nothing but a comment\n"), []);
});

test("parseIdList THROWS on a token that is not an arXiv id", () => {
  // A silently dropped id is indistinguishable from an id arXiv does not hold,
  // and the whole point of this path is that the caller named the records — so
  // "I asked for 150 and got 149" must have exactly one possible cause.
  for (const bad of ["garbage", "9901001", "10.1000/xyz", "PMID: 41610285", "2401.123"]) {
    assert.throws(() => parseIdList(`2401.12345\n${bad}\n`), /not an arXiv id/, bad);
  }
});

// ---- batching by BYTES, not by count ---------------------------------------

test("batchIds never exceeds the byte budget the request line imposes", () => {
  // Measured 2026-08-09: 365 modern ids = a 4,062-byte request line and HTTP
  // 200; 370 = 4,117 and "Request Line is too large (4117 > 4094)". POST is not
  // an escape — it 400s on this API. So the batch is bounded by bytes.
  const modern = Array.from({ length: 800 }, (_, i) => `2401.${String(10000 + i)}`);
  for (const batch of batchIds(modern)) {
    assert.ok(batch.join(",").length <= ID_LIST_BUDGET, `batch of ${batch.length} is ${batch.join(",").length} bytes`);
  }
  assert.deepEqual(batchIds(modern).flat(), modern, "every id asked for exactly once, in order");
});

test("batchIds packs FEWER old-style ids per call, which a fixed count would get wrong", () => {
  // `cond-mat/0603313` is 16 bytes against a modern id's 10, so a count tuned
  // on modern ids 400s the moment a list reaches back past 2007.
  const modern = Array.from({ length: 2000 }, (_, i) => `2401.${String(10000 + i)}`);
  const old = Array.from({ length: 2000 }, (_, i) => `cond-mat/06${String(10000 + i).slice(1)}`);
  const modernFirst = batchIds(modern)[0].length;
  const oldFirst = batchIds(old)[0].length;
  assert.ok(oldFirst < modernFirst, `old-style ids must pack fewer per call (${oldFirst} vs ${modernFirst})`);
  for (const batch of batchIds(old)) assert.ok(batch.join(",").length <= ID_LIST_BUDGET);
});

test("batchIds cannot loop on an id longer than the whole budget", () => {
  const batches = batchIds(["2401.10001", "x".repeat(ID_LIST_BUDGET + 50), "2401.10002"], ID_LIST_BUDGET);
  assert.equal(batches.flat().length, 3, "the oversized id is still sent — arXiv rejects it by name");
  assert.deepEqual(batches[1], ["x".repeat(ID_LIST_BUDGET + 50)], "and it goes in a batch of its own");
});

// ---- flags ------------------------------------------------------------------

test("parseArgs takes --ids in both spellings and leaves the record filter usable", () => {
  assert.equal(parseArgs(["--ids", "data/ids.txt"]).ids, "data/ids.txt");
  assert.equal(parseArgs(["--ids=data/ids.txt"]).ids, "data/ids.txt");
  assert.equal(parseArgs([]).ids, "", "the datestamp-window path is still the default");
  assert.equal(parseArgs(["--ids", "ids.txt", "--min-abstract", "200"]).minAbstract, 200);
  assert.equal(parseArgs(["--ids", "ids.txt", "--pause", "5000"]).pauseMs, 5000, "politeness still applies");
});

test("parseArgs rejects a window flag alongside --ids rather than ignoring it", () => {
  // --months has a DEFAULT, so "was it set?" cannot be read off its value.
  // Ignoring a window flag here is how a run ends up doing something other than
  // what its command line says.
  for (const window of [["--months", "6"], ["--set", "cs"], ["--until", "2026-01-01"], ["--keep-months", "2310-2506"], ["--max-pages", "3"]]) {
    assert.throws(() => parseArgs(["--ids", "ids.txt", ...window]), /cannot be combined/, window.join(" "));
  }
  assert.throws(() => parseArgs(["--set", "cs", "--ids", "ids.txt"]), /cannot be combined/, "order does not matter");
  assert.doesNotThrow(() => parseArgs(["--ids", "ids.txt"]), "the default --months must not count as a window flag");
});

// ---- the Atom parser, pinned against the OAI one ---------------------------

test("parseAtomEntry produces the SAME row shape as parseRecord", () => {
  // The load-bearing claim of the whole channel: two schemas, one corpus row.
  // If you add a field to one parser, add it to the other in the same change.
  const atom = parseAtomEntry(entry("2607.00042"));
  const oai = parseRecord(RECORD);
  assert.deepEqual(Object.keys(atom), Object.keys(oai), "same keys, same order — JSON.stringify output must be comparable");
  assert.equal(atom.id, "2607.00042", "the version arXiv echoes back is stripped: the vector id is version-less");
  assert.equal(atom.primary, "cs.CR");
  assert.deepEqual(atom.authors, ["Anna Lindqvist", "Bo Chen"], "Atom's <name> is already 'forenames keyname'");
  assert.ok(atom.abstract.includes("epsilon < 1"), "entities decoded, like the OAI path");
  assert.ok(!atom.abstract.includes("\n"));
  // And the row survives the leg that consumes it.
  const meta = vectorMetadata(atom);
  assert.equal(meta.c, "cs.CR");
  assert.equal(meta.d, "2026-07-20", "vectorMetadata slices `updated` to 10 chars — so parseAtomEntry cuts it there too");
});

test("parseAtomEntry hoists the primary category, keeping parseRecord's invariant", () => {
  // OAI's <categories> is space-separated with the primary first, and
  // parseRecord takes categories[0] as `primary`. Atom states the primary
  // separately and does not promise the order, so a cross-listed paper would
  // otherwise get a different `primary` on the two channels.
  const r = parseAtomEntry(entry("2607.00043", { cats: ["cs.LG", "cs.CL", "stat.ML"], primary: "cs.CL" }));
  assert.equal(r.primary, "cs.CL");
  assert.deepEqual(r.categories, ["cs.CL", "cs.LG", "stat.ML"]);
  assert.equal(r.categories[0], r.primary, "the parseRecord invariant");
});

test("parseAtomEntry drops what the index cannot use", () => {
  assert.equal(parseAtomEntry(entry("2607.00044", { abstract: "" })), null, "no abstract, nothing to embed");
  assert.equal(parseAtomEntry(entry("2607.00045", { title: "" })), null);
  assert.equal(parseAtomEntry(errorEntry("foo/0501001")), null, "an API error entry is not a record");
  assert.equal(parseAtomEntry("<entry></entry>"), null);
});

test("parseAtomFeed separates entries, rejected ids and 'arXiv did not answer'", () => {
  const ok = parseAtomFeed(feed([entry("2607.00042"), entry("2607.00043")]));
  assert.equal(ok.entries.length, 2);
  assert.deepEqual(ok.rejected, []);
  assert.equal(ok.total, 2);
  assert.ok(ok.isFeed);

  const bad = parseAtomFeed(feed([errorEntry("foo/0501001")], 1));
  assert.deepEqual(bad.rejected, ["foo/0501001"], "the offender's NAME is what lets the batch be retried without it");

  // A legitimate "arXiv holds none of these" is a feed with zero results, and
  // must NOT read the same as a block page or a changed schema.
  assert.ok(parseAtomFeed(feed([], 0)).isFeed);
  assert.ok(!parseAtomFeed("<html><body>Bad Request</body></html>").isFeed);
  assert.ok(!parseAtomFeed("").isFeed);
});

// ---- the accounting, which is the point -------------------------------------

test("harvestIds reconciles requested against returned: rejected, unusable and absent ids are counted, not lost", async () => {
  const dir = await scratch();
  try {
    // Six requested. arXiv 400s the batch over `foo/0501001`, so the id is
    // peeled off and the other five re-asked; of those, one comes back with no
    // abstract (unusable) and one is simply absent (HTTP 200, no error element
    // — reproduced live on 2401.99999).
    const ids = ["2301.07041", "1706.03762", "math/0309136", "hep-th/9711200", "2401.99999", "foo/0501001"];
    /** @type {string[][]} */
    const calls = [];
    const stats = await harvestIds(ids, dir, {
      pauseMs: 0,
      name: "reading-list",
      fetchXml: async (slice) => {
        calls.push(slice);
        if (slice.includes("foo/0501001")) return feed([errorEntry("foo/0501001")], 1);
        return feed(slice.filter((id) => id !== "2401.99999").map((id) => (id === "hep-th/9711200" ? entry(id, { abstract: "" }) : entry(id))));
      },
    });

    assert.equal(calls.length, 2, "one retry after the rejection, not a failed run");
    assert.ok(!calls[1].includes("foo/0501001"), "the offender is dropped from the retry");
    assert.equal(stats.requested, 6);
    assert.equal(stats.kept, 3);
    assert.deepEqual(stats.rejected, ["foo/0501001"]);
    assert.equal(stats.unusable, 1, "the abstract-less entry");
    assert.deepEqual(stats.missing, ["2401.99999"]);
    assert.deepEqual(stats.unrequested, []);

    // THE ASSERTION THIS PATH EXISTS FOR: every requested id is in exactly one
    // bucket, and the buckets add up. A run reporting "6 kept" while indexing 3
    // is the failure mode the whole corpus verification discipline is against.
    assert.equal(stats.kept + stats.unusable + stats.rejected.length + stats.missing.length, stats.requested);

    const rows = (await readFile(join(dir, "ids-reading-list.jsonl"), "utf8")).trim().split("\n").map((l) => JSON.parse(l));
    assert.deepEqual(rows.map((r) => r.id).sort(), ["1706.03762", "2301.07041", "math/0309136"]);
    assert.deepEqual(await readdir(dir), ["ids-reading-list.jsonl"], "the .part shard is renamed only once the accounting balances");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("harvestIds splits a long list into byte-sized calls, covering every id once", async () => {
  const dir = await scratch();
  try {
    const ids = Array.from({ length: 900 }, (_, i) => `2401.${String(10000 + i)}`);
    /** @type {string[][]} */
    const calls = [];
    const stats = await harvestIds(ids, dir, {
      pauseMs: 0,
      fetchXml: async (slice) => {
        calls.push(slice);
        return feed(slice.map((id) => entry(id)));
      },
    });
    assert.deepEqual(calls.flat(), ids, "every id asked for exactly once, in order");
    assert.equal(calls.length, batchIds(ids).length);
    for (const c of calls) assert.ok(c.join(",").length <= ID_LIST_BUDGET);
    assert.equal(stats.kept, 900);
    assert.equal(stats.batches, calls.length);
    assert.deepEqual(stats.missing, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("harvestIds counts rows the INDEX will drop, so the answer is not owed to a paid fill", async () => {
  const dir = await scratch();
  try {
    // The harvest keeps short abstracts (the OAI path does too, so the JSONL
    // stays the same corpus) but arxiv-vectorize.mjs skips anything under 200
    // chars. With a named list, "why is my paper not in the index" has to be
    // answerable here rather than after the embeddings are paid for.
    const stats = await harvestIds(["2401.10001", "2401.10002"], dir, {
      pauseMs: 0,
      fetchXml: async (slice) => feed(slice.map((id) => entry(id, id === "2401.10001" ? { abstract: "Too short to embed." } : {}))),
    });
    assert.equal(stats.kept, 2, "both rows are written");
    assert.equal(stats.belowIndexFloor, 1);
    assert.ok(INDEX_ABSTRACT_FLOOR === 200);
    // --min-abstract turns the report into a filter when the caller wants one.
    const dropped = await harvestIds(["2401.10001", "2401.10002"], dir, {
      pauseMs: 0,
      name: "filtered",
      minAbstract: 200,
      fetchXml: async (slice) => feed(slice.map((id) => entry(id, id === "2401.10001" ? { abstract: "Too short to embed." } : {}))),
    });
    assert.equal(dropped.kept, 1);
    assert.equal(dropped.unusable, 1);
    assert.equal(dropped.kept + dropped.unusable + dropped.missing.length, dropped.requested);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("harvestIds refuses to write a shard when arXiv did not answer with a feed", async () => {
  const dir = await scratch();
  try {
    // A block page, a proxy error or a changed schema all look like this, and
    // all of them would otherwise leave a shard that is quietly missing papers.
    await assert.rejects(
      () => harvestIds(["2401.10001"], dir, { pauseMs: 0, fetchXml: async () => "<html><body>Bad Request</body></html>" }),
      /did not answer with an Atom feed/,
    );
    // THE 0-BYTE BODY. `http://export.arxiv.org/api/query?…` answers through
    // this environment's egress proxy with an empty body and no error at all
    // (measured 2026-08-09; https is fine, which is why the endpoint is https
    // and says so). Without this guard a whole run would come back as "N
    // requested, 0 returned" with every id in missing.txt — exactly what a
    // correct run against a list of unknown ids looks like.
    await assert.rejects(
      () => harvestIds(["2401.10001"], dir, { pauseMs: 0, fetchXml: async () => "" }),
      /did not answer with an Atom feed/,
    );
    // A feed with zero results is a legitimate answer and must fail differently
    // — as "kept 0", not as "the channel is broken".
    await assert.rejects(
      () => harvestIds(["2401.99999"], dir, { pauseMs: 0, fetchXml: async () => feed([], 0) }),
      /kept 0 of 1 requested/,
    );
    assert.deepEqual(await readdir(dir), [], "no shard, not even a .part left behind as a finished file");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("harvestIds throws rather than looping when a rejection names an id it never sent", async () => {
  const dir = await scratch();
  try {
    await assert.rejects(
      () => harvestIds(["2401.10001"], dir, { pauseMs: 0, fetchXml: async () => feed([errorEntry("2401.99999")], 1) }),
      /rejected ids that were not in the batch/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("harvestIds names the shard after the list, so two lists cannot clobber each other", async () => {
  const dir = await scratch();
  try {
    const fetchXml = async (/** @type {string[]} */ slice) => feed(slice.map((id) => entry(id)));
    const a = await harvestIds(["2401.10001"], dir, { pauseMs: 0, name: "reading list 2026", fetchXml });
    const b = await harvestIds(["2401.10002"], dir, { pauseMs: 0, name: "survey/refs", fetchXml });
    assert.equal(a.shard, "ids-reading-list-2026.jsonl");
    assert.equal(b.shard, "ids-survey-refs.jsonl");
    // The `ids-` prefix keeps these out of the OAI path's YYYY-MM.jsonl
    // namespace while still being picked up by every `*.jsonl` reader.
    assert.deepEqual((await readdir(dir)).sort(), ["ids-reading-list-2026.jsonl", "ids-survey-refs.jsonl"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
