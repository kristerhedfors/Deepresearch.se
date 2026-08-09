// Unit tests for the arXiv → Vectorize fill's PURE parts.
//
// Everything here is network-free by construction: the embedder and the upsert
// live behind scripts/embed-providers.mjs and scripts/vectorize-upsert.mjs, and
// what is left in this module is argument parsing, the metadata row and the one
// rule that decides whether a harvested paper reaches the index at all.
//
// That last rule is why this file exists. On 2026-08-09 a named list of 1,218
// AI-consciousness arXiv ids was harvested completely (1,218/1,218 rows) and
// 1,210 landed in the index. The 8 that did not were ALL abstract-floor drops —
// nothing had failed, the corpus-wide 200-char floor simply does not fit a list
// somebody wrote out by hand. The floor is now a flag with the same default,
// and the boundary is pinned here so lowering it stays a deliberate act.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

import { INDEX_ABSTRACT_FLOOR, indexableRow, parseArgs, vectorMetadata } from "./arxiv-vectorize.mjs";
import { INDEX_ABSTRACT_FLOOR as CORE_FLOOR } from "../public/js/arxiv-rag-core.js";
import { INDEX_ABSTRACT_FLOOR as HARVEST_FLOOR } from "./arxiv-harvest.mjs";
import { loadCorpus } from "./arxiv-corpus.mjs";

test("the three arXiv scripts read ONE floor, not three copies of a number", async () => {
  // Only this module APPLIES the floor. arxiv-corpus.mjs draws the local pack
  // from the same population so the local and hosted nDCG columns in
  // docs/ARXIV-RAG.md stay comparable, and arxiv-harvest.mjs only PREDICTS the
  // drop so a named list can be answered before a paid fill. All three carried
  // their own 200 until 2026-08-09; a copy that drifted would have reported a
  // confident wrong number and sampled a quietly different corpus, and neither
  // fails a test or a run. So the sharing itself is what is pinned here: this
  // goes red if any site re-declares the constant and lets it move.
  assert.equal(INDEX_ABSTRACT_FLOOR, CORE_FLOOR);
  assert.equal(HARVEST_FLOOR, CORE_FLOOR);
  assert.equal(CORE_FLOOR, 200, "the historical floor every hosted vector was built under");

  // arxiv-corpus.mjs consumes it as a default rather than re-exporting it, so
  // the pin there is behavioural. loadCorpus resolves `dir` under the repo
  // root, so the shard has to live there too.
  const dir = await mkdtemp(join(ROOT, "data-arxiv-floor-"));
  try {
    await mkdir(join(dir, "raw"), { recursive: true });
    await writeFile(
      join(dir, "raw", "2401.jsonl"),
      [
        JSON.stringify({ id: "2401.00001", title: "under", abstract: "x".repeat(CORE_FLOOR - 1) }),
        JSON.stringify({ id: "2401.00002", title: "at", abstract: "x".repeat(CORE_FLOOR) }),
      ].join("\n") + "\n",
    );
    const papers = await loadCorpus({ dir: basename(dir) });
    assert.deepEqual(
      papers.map((p) => p.id),
      ["2401.00002"],
      "the local pack must apply the same floor the index does",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("parseArgs defaults leave every existing pipeline unchanged", () => {
  const args = parseArgs([]);
  assert.equal(args.index, "deepresearch-se-arxiv");
  assert.equal(args.minAbstract, INDEX_ABSTRACT_FLOOR);
  assert.equal(args.minAbstract, 200, "the historical floor every hosted vector was built under");
  assert.equal(args.limit, 0);
  assert.equal(args.dryRun, false);
});

test("parseArgs reads --min-abstract in both spellings", () => {
  assert.equal(parseArgs(["--min-abstract", "60"]).minAbstract, 60);
  assert.equal(parseArgs(["--min-abstract=60"]).minAbstract, 60);
});

test("parseArgs refuses a floor of 0, which would embed empty abstracts", () => {
  // Not a policy choice but a PERMANENT miss: there is nothing to embed, and an
  // empty-abstract row in the index is a document no query can legitimately
  // match. pmid:10970224 is the standing example on the PubMed side.
  assert.throws(() => parseArgs(["--min-abstract", "0"]), /--min-abstract must be >= 1/);
  assert.throws(() => parseArgs(["--min-abstract", "-5"]), /--min-abstract must be >= 1/);
  assert.throws(() => parseArgs(["--min-abstract", "abc"]), /--min-abstract must be >= 1/);
});

test("indexableRow applies the default floor at exactly 200 characters", () => {
  assert.equal(indexableRow({ id: "2401.00001", abstract: "x".repeat(199) }), false);
  assert.equal(indexableRow({ id: "2401.00002", abstract: "x".repeat(200) }), true, "the floor is inclusive");
  assert.equal(indexableRow({ id: "2401.00003", abstract: "x".repeat(201) }), true);
});

test("indexableRow never accepts a row with nothing to embed, whatever the floor", () => {
  for (const floor of [1, 10, 200]) {
    assert.equal(indexableRow({ id: "a", abstract: "" }, floor), false, `empty at floor ${floor}`);
    assert.equal(indexableRow({ id: "a" }, floor), false, `absent at floor ${floor}`);
    assert.equal(indexableRow({ id: "a", abstract: "   \n  " }, floor), false, `whitespace at floor ${floor}`);
  }
  assert.equal(indexableRow(null), false);
});

test("a lowered floor admits the real short abstracts and still drops the stubs", () => {
  // Verbatim from the live API on 2026-08-09 — the whole residue of the 1,218-id
  // AI-consciousness fill plus the shortest rows of the AI-security fills. The
  // operational floor for a NAMED list is 50, and 50 rather than 60 is decided
  // by exactly one paper: 1911.07682's abstract is 59 characters of real claim.
  // Two administrative stubs and two novelty one-word abstracts stay out.
  const real = [
    { id: "1911.07682", abstract: "Deep neural networks are vulnerable to adversarial attacks." },
    { id: "1607.04311", abstract: "x".repeat(146) },
    { id: "1008.0449", abstract: "A modeling procedure for enhancing performance of stochastic systems is proposed." },
    { id: "1311.2912", abstract: "The chinese room problem asks if computers can think; I ask here if most humans can." },
    { id: "0710.2361", abstract: "Nauenberg's extended critique of Quantum Enigma rests on fundamental misunderstandings." },
    { id: "quant-ph/9505023", abstract: "x".repeat(171) },
    { id: "2201.09663", abstract: "x".repeat(177) },
    { id: "1606.00058", abstract: "x".repeat(188) },
  ];
  const stubs = [
    { id: "1311.4906", abstract: "This paper has been withdrawn by the author(s)" },
    { id: "cs/0511015", abstract: "This article is taken out." },
    { id: "1902.02322", abstract: "No." },
    { id: "1602.00251", abstract: "Not really." },
  ];
  for (const row of real) {
    assert.equal(indexableRow(row, 200), false, `${row.id} is below the DEFAULT floor — that is why it was missing`);
    assert.equal(indexableRow(row, 50), true, `${row.id} should be admitted at --min-abstract 50`);
  }
  for (const row of stubs) {
    assert.equal(indexableRow(row, 50), false, `${row.id} carries no research content and stays out`);
  }
});

test("vectorMetadata keeps the short keys src/arxiv-rag.js reads", () => {
  const meta = vectorMetadata({
    id: "2401.00001",
    title: "A  title\nwith   whitespace",
    abstract: "An abstract.",
    authors: ["Ada Lovelace", "Alan Turing"],
    primary: "cs.AI",
    categories: ["cs.LG"],
    updated: "2024-01-15T00:00:00Z",
  });
  assert.deepEqual(Object.keys(meta).sort(), ["a", "au", "c", "d", "t"]);
  assert.equal(meta.t, "A title with whitespace", "whitespace is collapsed before storage");
  assert.equal(meta.a, "An abstract.");
  assert.equal(meta.c, "cs.AI", "the primary category wins over the category list");
  assert.equal(meta.d, "2024-01-15", "the date is stored as a plain day");
  assert.ok(meta.au.includes("Turing"), "the senior author survives the author cut");
});
