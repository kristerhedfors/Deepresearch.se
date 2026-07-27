// Unit tests for the GCS enumerator (scripts/arxiv-gcs.mjs).
//
// The live numbers behind these tests (2026-07-26): 339,388 unique papers
// across 13 shards in 39 seconds, which independently corroborates the
// 339,670 the OAI harvest reported for the same window (docs/ARXIV-RAG.md §1)
// to within 0.08%. Two enumeration paths agreeing that closely is the reason
// to trust either.
import test from "node:test";
import assert from "node:assert/strict";

import { idFromObjectName, mergeListingPage, parseArgs, shardMonths } from "./arxiv-gcs.mjs";

test("shardMonths walks back from today, newest first", () => {
  assert.deepEqual(shardMonths("2026-07-26", 3), ["2607", "2606", "2605"]);
  // Year boundary: the YY component has to roll too.
  assert.deepEqual(shardMonths("2026-02-15", 4), ["2602", "2601", "2512", "2511"]);
  assert.deepEqual(shardMonths("2026-01-01", 2), ["2601", "2512"]);
  // The window the index is built over.
  const year = shardMonths("2026-07-26", 13);
  assert.equal(year.length, 13);
  assert.equal(year[0], "2607");
  assert.equal(year[12], "2507");
});

test("idFromObjectName reads the id and version off a PDF object", () => {
  assert.deepEqual(idFromObjectName("arxiv/arxiv/pdf/2607/2607.00001v1.pdf"), { id: "2607.00001", version: 1 });
  assert.deepEqual(idFromObjectName("arxiv/arxiv/pdf/2510/2510.10047v3.pdf"), { id: "2510.10047", version: 3 });
  // 5-digit sequence numbers exist in busy months.
  assert.deepEqual(idFromObjectName("arxiv/arxiv/pdf/2606/2606.12345v2.pdf"), { id: "2606.12345", version: 2 });

  // Anything that is not a versioned modern-id PDF is not a paper we can use.
  assert.equal(idFromObjectName("arxiv/arxiv/pdf/2607/"), null);
  assert.equal(idFromObjectName("metadata-v5/arxiv-metadata-oai.json"), null);
  // Old-style ids live under per-archive prefixes and are pre-2007.
  assert.equal(idFromObjectName("arxiv/cs/pdf/0503/cs0503001v1.pdf"), null);
  assert.equal(idFromObjectName("2607.00001.pdf"), null); // no version
  assert.equal(idFromObjectName(""), null);
  assert.equal(idFromObjectName(null), null);
});

test("mergeListingPage", async (t) => {
  await t.test("keeps the NEWEST version per id, not one entry per revision", () => {
    const into = new Map();
    mergeListingPage(
      {
        items: [
          { name: "arxiv/arxiv/pdf/2607/2607.00001v1.pdf" },
          { name: "arxiv/arxiv/pdf/2607/2607.00001v3.pdf" },
          { name: "arxiv/arxiv/pdf/2607/2607.00001v2.pdf" },
          { name: "arxiv/arxiv/pdf/2607/2607.00002v1.pdf" },
        ],
      },
      into,
    );
    assert.equal(into.size, 2);
    assert.equal(into.get("2607.00001"), 3);
    assert.equal(into.get("2607.00002"), 1);
  });

  await t.test("merges across pages, since a paper's revisions can straddle one", () => {
    const into = new Map();
    mergeListingPage({ items: [{ name: "arxiv/arxiv/pdf/2607/2607.00001v1.pdf" }] }, into);
    mergeListingPage({ items: [{ name: "arxiv/arxiv/pdf/2607/2607.00001v4.pdf" }] }, into);
    assert.equal(into.get("2607.00001"), 4);
  });

  await t.test("returns the page token so the caller can paginate, or '' at the end", () => {
    assert.equal(mergeListingPage({ items: [], nextPageToken: "abc123" }, new Map()), "abc123");
    assert.equal(mergeListingPage({ items: [] }, new Map()), "");
    assert.equal(mergeListingPage({}, new Map()), "");
    assert.equal(mergeListingPage(null, new Map()), "");
  });

  await t.test("skips non-paper objects rather than throwing", () => {
    const into = new Map();
    mergeListingPage({ items: [{ name: "test/test_file.txt" }, { name: "" }, {}, null] }, into);
    assert.equal(into.size, 0);
  });
});

test("parseArgs validates rather than silently accepting nonsense", () => {
  assert.equal(parseArgs([]).months, 12);
  assert.equal(parseArgs(["--months", "3"]).months, 3);
  assert.equal(parseArgs(["--months=3"]).months, 3);
  assert.equal(parseArgs(["--dry-run"]).dryRun, true);
  assert.equal(parseArgs(["--out", "x.txt"]).out, "x.txt");
  assert.throws(() => parseArgs(["--months", "0"]), /1\.\.240/);
  assert.throws(() => parseArgs(["--months", "nope"]), /1\.\.240/);
  assert.throws(() => parseArgs(["--nonsense"]), /Unknown flag/);
});
