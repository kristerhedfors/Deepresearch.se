import assert from "node:assert/strict";
import test from "node:test";

import { decodeEntities, idMonth, parsePage, parseRecord, parseArgs, planWindow } from "./arxiv-harvest.mjs";
import { hash01 } from "./arxiv-corpus.mjs";
import { titleOverlap } from "./arxiv-goldset.mjs";

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
