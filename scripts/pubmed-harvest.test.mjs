import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EFETCH_BATCH, harvestPmids, parseArgs, parsePmidList } from "./pubmed-harvest.mjs";

// ---- fixtures ---------------------------------------------------------------
//
// Shaped like a real `efetch.fcgi?db=pubmed&retmode=xml` response, because that
// is the whole claim this path rests on: efetch hands back the same DTD as the
// archive files, so the same parser produces the same rows. The wrapper, the
// DOCTYPE and the <PubmedBookArticle> sibling are copied from a live response
// for 41610285,33301246,20301295 (2026-08-08).

const ABSTRACT = "We randomised 40 samples across two protocols and measured recovery at each step. ".repeat(3);

/** @param {string} pmid @param {string} [abstract] */
const article = (pmid, abstract = ABSTRACT) => `<PubmedArticle><MedlineCitation Status="Publisher" Owner="NLM">
<PMID Version="1">${pmid}</PMID>
<Article PubModel="Print-Electronic">
<Journal><ISSN>1476-4687</ISSN><Title>Nature communications</Title></Journal>
<ArticleTitle>Record ${pmid}</ArticleTitle>
<Abstract><AbstractText>${abstract}</AbstractText></Abstract>
<AuthorList><Author><LastName>Svensson</LastName><ForeName>Anna K</ForeName></Author></AuthorList>
<PubDate><Year>2026</Year><Month>Jan</Month></PubDate>
<Language>eng</Language>
<PublicationTypeList><PublicationType UI="D016428">Journal Article</PublicationType></PublicationTypeList>
</Article></MedlineCitation>
<PubmedData><ArticleIdList><ArticleId IdType="doi">10.1000/x${pmid}</ArticleId></ArticleIdList></PubmedData></PubmedArticle>`;

/** A GeneReviews-style book chapter: a real PMID, no MedlineCitation at all. */
const book = (pmid) => `<PubmedBookArticle><BookDocument><PMID Version="1">${pmid}</PMID>
<ArticleIdList><ArticleId IdType="bookaccession">NBK1116</ArticleId></ArticleIdList>
<Book><Publisher><PublisherName>University of Washington, Seattle</PublisherName></Publisher>
<BookTitle book="gene">GeneReviews</BookTitle></Book>
<AbstractText>${ABSTRACT}</AbstractText></BookDocument></PubmedBookArticle>`;

/** @param {string[]} parts */
const set = (parts) =>
  `<?xml version="1.0" ?>\n<!DOCTYPE PubmedArticleSet PUBLIC "-//NLM//DTD PubMedArticle, 1st January 2025//EN" ` +
  `"https://dtd.nlm.nih.gov/ncbi/pubmed/out/pubmed_250101.dtd">\n<PubmedArticleSet>\n${parts.join("\n")}\n</PubmedArticleSet>`;

async function scratch() {
  return mkdtemp(join(tmpdir(), "pubmed-pmids-"));
}

// ---- flags ------------------------------------------------------------------

test("parseArgs takes --pmids in both spellings and leaves the record filters usable", () => {
  assert.equal(parseArgs(["--pmids", "data/ids.txt"]).pmids, "data/ids.txt");
  assert.equal(parseArgs(["--pmids=data/ids.txt"]).pmids, "data/ids.txt");
  assert.equal(parseArgs([]).pmids, "", "the archive path is still the default");
  // The record-level filters describe what earns a vector, not a window, so
  // they stay available to a named list — --min-abstract 0 above all, which is
  // how a curated list keeps citations with a short abstract.
  const args = parseArgs(["--pmids", "ids.txt", "--min-abstract", "0", "--min-year", "2000", "--languages", "eng,swe"]);
  assert.equal(args.minAbstract, 0);
  assert.equal(args.minYear, 2000);
  assert.deepEqual(args.languages, ["eng", "swe"]);
});

test("parseArgs rejects a window flag alongside --pmids rather than ignoring it", () => {
  // Silently ignoring one would mean the command line says one thing and the
  // run does another — the failure this corpus's whole verification discipline
  // is built against.
  for (const window of [["--min-file", "1335"], ["--max-files", "4"], ["--max-records", "1000"]]) {
    assert.throws(() => parseArgs(["--pmids", "ids.txt", ...window]), /cannot be combined/);
  }
  assert.throws(() => parseArgs(["--min-file", "1335", "--pmids", "ids.txt"]), /cannot be combined/, "order does not matter");
  assert.throws(() => parseArgs(["--nope"]), /Unknown flag/);
});

// ---- the list ---------------------------------------------------------------

test("parsePmidList reads the shapes a pasted list actually has", () => {
  const text = [
    "# a reading list",
    "PMID",                                     // a spreadsheet column header
    "33301246",
    "PMID: 41610285   ",                        // PubMed's own export writes the space
    "",
    "pmid:20301295, 33301246   # a repeat and an inline comment",
    "0033301246",                               // the same id, zero-padded
  ].join("\n");
  assert.deepEqual(parsePmidList(text), ["33301246", "41610285", "20301295"]);
});

test("parsePmidList preserves order, because the caller named the records", () => {
  assert.deepEqual(parsePmidList("3\n1\n2\n"), ["3", "1", "2"]);
});

test("parsePmidList THROWS on a token that is not a PMID", () => {
  // A skipped id is indistinguishable from an id PubMed does not hold, and the
  // whole point of this path is that "I asked for 150 and got 149" has exactly
  // one possible cause.
  for (const bad of ["10.1038/s41467", "PMC1234", "abc", "0", "1234567890"]) {
    assert.throws(() => parsePmidList(`33301246\n${bad}\n`), /not a PMID/, bad);
  }
  assert.deepEqual(parsePmidList(""), []);
  assert.deepEqual(parsePmidList("# nothing but a comment\n"), []);
});

// ---- batching ---------------------------------------------------------------

test("efetch is called in EFETCH_BATCH-sized slices, covering every id exactly once", async () => {
  const dir = await scratch();
  try {
    const ids = Array.from({ length: 250 }, (_, i) => String(40_000_000 + i));
    /** @type {string[][]} */
    const calls = [];
    const stats = await harvestPmids(ids, dir, {}, {
      fetchXml: async (slice) => {
        calls.push(slice);
        return set(slice.map((p) => article(p)));
      },
    });
    assert.equal(EFETCH_BATCH, 200);
    assert.deepEqual(calls.map((c) => c.length), [200, 50]);
    assert.deepEqual(calls.flat(), ids, "every id asked for once, in order");
    assert.equal(stats.batches, 2);
    assert.equal(stats.kept, 250);
    assert.deepEqual(stats.missing, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("--batch overrides the slice size", async () => {
  const dir = await scratch();
  try {
    const ids = ["1", "2", "3", "4", "5"];
    /** @type {number[]} */
    const sizes = [];
    await harvestPmids(ids, dir, {}, {
      batch: 2,
      fetchXml: async (slice) => {
        sizes.push(slice.length);
        return set(slice.map((p) => article(p)));
      },
    });
    assert.deepEqual(sizes, [2, 2, 1]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---- the accounting, which is the point -------------------------------------

test("harvestPmids reconciles requested against returned: book and absent ids are counted, not lost", async () => {
  const dir = await scratch();
  try {
    // 3 requested, 2 returned: one article, one book chapter, and one PMID
    // efetch simply omits (HTTP 200, no <ERROR> element — reproduced live
    // against 999999999 on 2026-08-08).
    const stats = await harvestPmids(["33301246", "20301295", "999999999"], dir, {}, {
      fetchXml: async () => set([article("33301246"), book("20301295")]),
    });
    assert.equal(stats.requested, 3);
    assert.equal(stats.articles, 1, "takeBlocks matches only <PubmedArticle>");
    assert.equal(stats.books, 1, "the book is COUNTED — that is the difference from losing it");
    assert.deepEqual(stats.bookPmids, ["20301295"]);
    assert.equal(stats.kept, 1);
    assert.equal(stats.dropped, 0);
    assert.deepEqual(stats.missing, ["999999999"]);
    assert.deepEqual(stats.unrequested, []);
    assert.equal(stats.nameless, 0);
    // The four buckets have to add up to what was asked for, or the run has
    // quietly indexed something other than the list.
    assert.equal(stats.kept + stats.dropped + stats.books + stats.missing.length, stats.requested);

    const shard = join(dir, stats.shard);
    const rows = (await readFile(shard, "utf8")).trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(rows.length, 1);
    // Byte-identical in SHAPE to what the archive path writes — same parser,
    // same field set, same `pmid:` id the fill uses as the vector id.
    assert.deepEqual(Object.keys(rows[0]), [
      "id", "pmid", "title", "abstract", "authors", "journal", "year", "date", "doi", "mesh", "languages", "types",
    ]);
    assert.equal(rows[0].id, "pmid:33301246");
    assert.equal(rows[0].journal, "Nature communications");
    assert.deepEqual(await readdir(dir), [stats.shard], "the .part is renamed away once the run reconciles");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a record dropped by a filter is attributed to its id, not reported as missing", async () => {
  const dir = await scratch();
  try {
    const stats = await harvestPmids(["33301246", "41610285"], dir, {}, {
      fetchXml: async () => set([article("33301246"), article("41610285", "Too short to embed.")]),
    });
    assert.equal(stats.kept, 1);
    assert.equal(stats.dropped, 1);
    assert.deepEqual(stats.reasons, { short_abstract: 1 });
    assert.deepEqual(stats.missing, [], "it came back — it just did not clear the abstract floor");
    // …and --min-abstract 0 is what a curated list uses to keep it.
    const kept = await harvestPmids(["41610285"], dir, { minAbstract: 0 }, {
      name: "keep-short",
      fetchXml: async () => set([article("41610285", "Too short to embed.")]),
    });
    assert.equal(kept.kept, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a merged PMID that comes back under another id is named rather than silently swapped", async () => {
  const dir = await scratch();
  try {
    const stats = await harvestPmids(["11111111", "33301246"], dir, {}, {
      fetchXml: async () => set([article("22222222"), article("33301246")]),
    });
    assert.deepEqual(stats.missing, ["11111111"]);
    assert.deepEqual(stats.unrequested, ["22222222"]);
    assert.equal(stats.kept, 2, "the record is still written — it is the right citation under its current id");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a batch that parses to nothing is loud, like the archive path's zero-record guard", async () => {
  const dir = await scratch();
  try {
    await assert.rejects(
      () => harvestPmids(["33301246"], dir, {}, { fetchXml: async () => set([]) }),
      /returned 0 records/,
    );
    // An empty shard would otherwise reach the fill and report "done — 0
    // vectors", which is the same silent success this corpus keeps paying for.
    await assert.rejects(
      () => harvestPmids(["20301295"], dir, {}, { fetchXml: async () => set([book("20301295")]) }),
      /kept 0 of 1 requested PMIDs.*--min-abstract 0/s,
    );
    assert.deepEqual(
      (await readdir(dir)).filter((f) => f.endsWith(".jsonl")),
      [],
      "nothing is renamed into place when the run does not reconcile",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the shard name carries the list's identity, sanitised", async () => {
  const dir = await scratch();
  try {
    const stats = await harvestPmids(["33301246"], dir, {}, {
      name: "reading list/2026",
      fetchXml: async () => set([article("33301246")]),
    });
    assert.equal(stats.shard, "pmids-reading-list-2026.jsonl");
    // Two lists harvested into one --out must not clobber each other, and the
    // fill reads every *.jsonl in the directory.
    assert.ok(stats.shard.endsWith(".jsonl"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
