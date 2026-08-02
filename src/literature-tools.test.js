// Unit tests for src/literature-tools.js — the PURE half of the literature MCP
// tool family: schemas, argument parsing, identifier reading, Vectorize match →
// record mapping, post-retrieval filtering, and the merge across angles.
//
// Everything here runs on plain objects, which is the point of the split: the
// mapping and filtering that decide what an agent actually sees are testable
// without a Vectorize binding, an embedder or a network. The env-touching half
// is exercised in src/literature-run.test.js against fakes.

import test from "node:test";
import assert from "node:assert/strict";

import {
  CORPUS_FACTS,
  CORPUS_IDS,
  DEFAULT_LIMIT,
  LITERATURE_TOOLS,
  LITERATURE_TOOL_NAMES,
  MAX_FETCH_IDS,
  MAX_LIMIT,
  MAX_QUERIES,
  MAX_TOTAL_RECORDS,
  RECORD_MAPPERS,
  STORED_ABSTRACT_CHARS,
  applyFilters,
  arxivRecord,
  arxivSubmittedMonth,
  capGroups,
  comparableDate,
  filtersActive,
  formatLiteratureResult,
  mergeRanked,
  normalizeAbstractMode,
  normalizeCorpora,
  normalizeDateBound,
  normalizeLimit,
  normalizeQueries,
  parseFilters,
  parseLiteratureId,
  parseLiteratureIds,
  pubmedRecord,
  shapeAbstracts,
  splitAuthors,
} from "./literature-tools.js";

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

test("the family is four tools with MCP-ready schemas", () => {
  assert.deepEqual(
    LITERATURE_TOOLS.map((t) => t.name),
    ["literature_search", "literature_fetch", "literature_similar", "literature_corpora"],
  );
  for (const tool of LITERATURE_TOOLS) {
    assert.equal(tool.input_schema.type, "object", `${tool.name} schema is an object`);
    assert.ok(Array.isArray(tool.input_schema.required), `${tool.name} declares required`);
    // The description is what the CALLING model reads; an empty or stub one is
    // the single commonest reason a tool is never called.
    assert.ok(tool.description.length > 120, `${tool.name} has a usable description`);
  }
  assert.deepEqual([...LITERATURE_TOOL_NAMES].sort(), LITERATURE_TOOLS.map((t) => t.name).sort());
});

test("literature_search advertises the parallel multi-angle form", () => {
  const schema = LITERATURE_TOOLS[0].input_schema;
  assert.equal(schema.properties.queries.type, "array");
  assert.equal(schema.properties.queries.maxItems, MAX_QUERIES);
  assert.equal(schema.properties.query.type, "string");
  // Neither is required: `query` alone must work, and so must `queries` alone.
  assert.deepEqual(schema.required, []);
  assert.deepEqual(schema.properties.corpus.enum, ["arxiv", "pubmed", "both"]);
  assert.equal(schema.properties.corpus.default, "both");
  assert.equal(schema.properties.limit.default, DEFAULT_LIMIT);
  assert.equal(schema.properties.limit.maximum, MAX_LIMIT);
  assert.deepEqual(schema.properties.abstract.enum, ["full", "short", "none"]);
});

test("fetch and similar require the identifier they cannot work without", () => {
  const fetchSchema = LITERATURE_TOOLS[1].input_schema;
  assert.deepEqual(fetchSchema.required, ["ids"]);
  assert.equal(fetchSchema.properties.ids.maxItems, MAX_FETCH_IDS);
  assert.deepEqual(LITERATURE_TOOLS[2].input_schema.required, ["id"]);
  // literature_corpora takes nothing at all — it is the "what is here" call.
  assert.deepEqual(LITERATURE_TOOLS[3].input_schema.required, []);
  assert.deepEqual(LITERATURE_TOOLS[3].input_schema.properties, {});
});

test("every corpus has the facts an agent needs to read a miss", () => {
  for (const id of CORPUS_IDS) {
    const facts = CORPUS_FACTS[id];
    assert.equal(facts.id, id);
    // The coverage WINDOW is the load-bearing one: without it a miss outside
    // the window reads as "the literature is silent on this".
    assert.ok(facts.window.length > 40, `${id} states its coverage window`);
    assert.ok(facts.covers.length > 20, `${id} states what it covers`);
    assert.ok(facts.vectors_at_fill > 0);
    assert.ok(facts.binding && facts.doc && facts.live_fallback);
    assert.ok(RECORD_MAPPERS[id], `${id} has a record mapper`);
  }
});

// ---------------------------------------------------------------------------
// Argument parsing — degrade, never throw
// ---------------------------------------------------------------------------

test("normalizeQueries merges query and queries, de-dupes, and caps", () => {
  assert.deepEqual(normalizeQueries({ query: "how do transformers scale?" }), ["how do transformers scale?"]);
  assert.deepEqual(normalizeQueries({ queries: ["a", "b"], query: "c" }), ["a", "b", "c"]);
  // Case-insensitive de-dup, whitespace collapsed, blanks dropped.
  assert.deepEqual(normalizeQueries({ queries: ["Same  thing", "same thing", "  ", null] }), ["Same thing"]);
  assert.equal(normalizeQueries({ queries: Array.from({ length: 20 }, (_, i) => `q${i}`) }).length, MAX_QUERIES);
  // Nothing usable is an empty list, not a throw — the runner turns that into
  // an instructive tool-level error.
  assert.deepEqual(normalizeQueries({}), []);
  assert.deepEqual(normalizeQueries(null), []);
});

test("normalizeCorpora defaults to both for anything unrecognized", () => {
  assert.deepEqual(normalizeCorpora("arxiv"), ["arxiv"]);
  assert.deepEqual(normalizeCorpora("PubMed"), ["pubmed"]);
  assert.deepEqual(normalizeCorpora("both"), ["arxiv", "pubmed"]);
  // A model that invents a corpus name gets the wide answer, not an error.
  assert.deepEqual(normalizeCorpora("biorxiv"), ["arxiv", "pubmed"]);
  assert.deepEqual(normalizeCorpora(undefined), ["arxiv", "pubmed"]);
});

test("normalizeLimit clamps and normalizeAbstractMode falls back to full", () => {
  assert.equal(normalizeLimit(undefined), DEFAULT_LIMIT);
  assert.equal(normalizeLimit("nonsense"), DEFAULT_LIMIT);
  assert.equal(normalizeLimit(0), 1);
  assert.equal(normalizeLimit(-5), 1);
  assert.equal(normalizeLimit(1000), MAX_LIMIT);
  assert.equal(normalizeLimit("12"), 12);
  assert.equal(normalizeAbstractMode("short"), "short");
  assert.equal(normalizeAbstractMode("NONE"), "none");
  assert.equal(normalizeAbstractMode("verbose"), "full");
  assert.equal(normalizeAbstractMode(undefined), "full");
});

test("a date bound pads toward the edge it names", () => {
  // since 2024 means from the start of 2024; until 2024 means through the end.
  assert.equal(normalizeDateBound("2024", "since"), "2024-01-01");
  assert.equal(normalizeDateBound("2024", "until"), "2024-12-31");
  assert.equal(normalizeDateBound("2024-03", "since"), "2024-03-01");
  assert.equal(normalizeDateBound("2024-03", "until"), "2024-03-31");
  assert.equal(normalizeDateBound("2024-3-7", "since"), "2024-03-07");
  // Unparseable bounds are DROPPED rather than enforced — a filter nobody can
  // read must not silently empty a result set.
  assert.equal(normalizeDateBound("last spring", "since"), "");
  assert.equal(normalizeDateBound("", "until"), "");
});

test("comparableDate pads a record's own date the same way", () => {
  // arXiv records carry YYYY-MM; a raw string compare would sort "2024-03"
  // before "2024-03-01" and drop a whole month at a since boundary.
  assert.equal(comparableDate("2024-03"), "2024-03-01");
  assert.equal(comparableDate("2024-03-15"), "2024-03-15");
  assert.equal(comparableDate("2024"), "2024-01-01");
  assert.equal(comparableDate(""), "");
});

test("parseFilters reads what it can and reports whether anything binds", () => {
  const none = parseFilters({});
  assert.equal(filtersActive(none), false);
  const filters = parseFilters({
    since: "2024-01",
    until: "2025",
    categories: ["CS.CL", "stat"],
    journals: "Nature",
    min_score: "0.3",
  });
  assert.equal(filters.since, "2024-01-01");
  assert.equal(filters.until, "2025-12-31");
  assert.deepEqual(filters.categories, ["cs.cl", "stat"]);
  assert.deepEqual(filters.journals, ["nature"]);
  assert.equal(filters.minScore, 0.3);
  assert.equal(filtersActive(filters), true);
  // A min_score of zero is a real bound, not an absent one.
  assert.equal(parseFilters({ min_score: 0 }).minScore, 0);
  assert.equal(filtersActive(parseFilters({ min_score: 0 })), true);
});

// ---------------------------------------------------------------------------
// Identifiers
// ---------------------------------------------------------------------------

test("parseLiteratureId reads every form an id arrives in", () => {
  const arxiv = { corpus: "arxiv", id: "2401.12345", vectorId: "2401.12345" };
  assert.deepEqual(parseLiteratureId("2401.12345"), arxiv);
  assert.deepEqual(parseLiteratureId("arXiv:2401.12345"), arxiv);
  assert.deepEqual(parseLiteratureId("arxiv: 2401.12345"), arxiv);
  // Versions are stripped: the vector is keyed on the bare id.
  assert.deepEqual(parseLiteratureId("2401.12345v3"), arxiv);
  assert.deepEqual(parseLiteratureId("https://arxiv.org/abs/2401.12345v2"), arxiv);
  assert.deepEqual(parseLiteratureId("https://arxiv.org/pdf/2401.12345"), arxiv);

  const pubmed = { corpus: "pubmed", id: "41610285", vectorId: "pmid:41610285" };
  assert.deepEqual(parseLiteratureId("41610285"), pubmed);
  assert.deepEqual(parseLiteratureId("PMID:41610285"), pubmed);
  assert.deepEqual(parseLiteratureId("pmid: 41610285"), pubmed);
  assert.deepEqual(parseLiteratureId("https://pubmed.ncbi.nlm.nih.gov/41610285/"), pubmed);

  // Old-style arXiv ids are outside this corpus's window, but reading them as
  // arXiv gives an honest miss rather than a nonsense PMID lookup.
  assert.equal(parseLiteratureId("math/0211159")?.corpus, "arxiv");

  for (const bad of ["", null, undefined, "not an id", "doi:10.1000/xyz"]) {
    assert.equal(parseLiteratureId(bad), null, `rejects ${JSON.stringify(bad)}`);
  }
});

test("parseLiteratureIds keeps the unreadable entries instead of dropping them", () => {
  const { refs, unreadable } = parseLiteratureIds(["2401.12345", "41610285", "who knows", "2401.12345"]);
  // De-duplicated by vector id, corpora mixed freely in one call.
  assert.deepEqual(
    refs.map((r) => `${r.corpus}:${r.id}`),
    ["arxiv:2401.12345", "pubmed:41610285"],
  );
  // Silence about an id the caller asked for is what makes an agent re-ask.
  assert.deepEqual(unreadable, ["who knows"]);
  assert.equal(parseLiteratureIds(Array.from({ length: 50 }, (_, i) => `240${i}.1234${i}`)).refs.length <= MAX_FETCH_IDS, true);
  assert.deepEqual(parseLiteratureIds(undefined), { refs: [], unreadable: [] });
  // A bare string is accepted where an array was documented.
  assert.equal(parseLiteratureIds("2401.12345").refs.length, 1);
});

// ---------------------------------------------------------------------------
// Vectorize match → record
// ---------------------------------------------------------------------------

const ARXIV_MATCH = {
  id: "2401.12345",
  rerankScore: 0.87654321,
  metadata: {
    t: "  Scaling laws  for  neural retrieval ",
    a: "We study how retrieval quality scales with corpus size.",
    au: "Ada Lovelace; Alan Turing; Grace Hopper; Barbara Liskov",
    c: "cs.IR",
    d: "2026-05-02",
  },
};

const PUBMED_MATCH = {
  id: "pmid:41610285",
  rerankScore: 0.42,
  metadata: {
    t: "A randomised trial of something",
    a: "BACKGROUND: it was unclear. METHODS: we looked.",
    au: "Rosalind Franklin; Jane Doe",
    j: "The Lancet",
    d: "2026-03-14",
  },
};

test("arxivRecord keeps the fields the presentation tier flattens away", () => {
  const rec = arxivRecord(ARXIV_MATCH);
  assert.equal(rec.corpus, "arxiv");
  assert.equal(rec.id, "2401.12345");
  assert.equal(rec.url, "https://arxiv.org/abs/2401.12345");
  assert.equal(rec.title, "Scaling laws for neural retrieval");
  // Authors stay a LIST — the source-list mapper joins them into one string.
  assert.deepEqual(rec.authors, ["Ada Lovelace", "Alan Turing", "Grace Hopper", "Barbara Liskov"]);
  assert.equal(rec.primary_category, "cs.IR");
  // `date` is the SUBMISSION month from the id; `d` is the last REVISION, and
  // conflating them is the trap src/arxiv-rag.js records.
  assert.equal(rec.date, "2024-01");
  assert.equal(rec.revised, "2026-05-02");
  assert.equal(rec.score, 0.8765);
  assert.equal(rec.abstract_cut, false);
});

test("pubmedRecord strips the pmid: prefix and keeps the journal", () => {
  const rec = pubmedRecord(PUBMED_MATCH);
  assert.equal(rec.corpus, "pubmed");
  assert.equal(rec.id, "41610285");
  assert.equal(rec.url, "https://pubmed.ncbi.nlm.nih.gov/41610285/");
  assert.equal(rec.journal, "The Lancet");
  assert.equal(rec.date, "2026-03-14");
  assert.deepEqual(rec.authors, ["Rosalind Franklin", "Jane Doe"]);
  assert.equal(rec.score, 0.42);
});

test("a record with no usable metadata is dropped, not half-built", () => {
  assert.equal(arxivRecord(null), null);
  assert.equal(arxivRecord({ id: "2401.12345" }), null);
  assert.equal(arxivRecord({ id: "", metadata: { t: "x" } }), null);
  assert.equal(arxivRecord({ id: "2401.12345", metadata: { t: "  " } }), null);
  assert.equal(pubmedRecord({ id: "41610285", metadata: { t: "x" } }), null, "an unprefixed id is not a pubmed vector");
  assert.equal(pubmedRecord({ id: "pmid:41610285", metadata: { t: "" } }), null);
});

test("abstract_cut reports the indexer's 900-char truncation", () => {
  const long = "x".repeat(STORED_ABSTRACT_CHARS);
  assert.equal(arxivRecord({ ...ARXIV_MATCH, metadata: { ...ARXIV_MATCH.metadata, a: long } }).abstract_cut, true);
  assert.equal(
    arxivRecord({ ...ARXIV_MATCH, metadata: { ...ARXIV_MATCH.metadata, a: "x".repeat(100) } }).abstract_cut,
    false,
  );
});

test("a match with no rerank score omits it rather than reporting zero", () => {
  const rec = arxivRecord({ id: "2401.12345", metadata: { t: "T" } });
  // A fallback dense order carries no comparable numbers; a fabricated 0 would
  // sort as "least relevant" and be indistinguishable from a real low score.
  assert.equal("score" in rec, false);
});

test("arxivSubmittedMonth and splitAuthors handle the empty cases", () => {
  assert.equal(arxivSubmittedMonth("2310.01234"), "2023-10");
  assert.equal(arxivSubmittedMonth("math/0211159"), "");
  assert.equal(arxivSubmittedMonth(""), "");
  assert.deepEqual(splitAuthors("A; B ;; C"), ["A", "B", "C"]);
  assert.deepEqual(splitAuthors(""), []);
  assert.deepEqual(splitAuthors(undefined), []);
});

// ---------------------------------------------------------------------------
// Filtering
// ---------------------------------------------------------------------------

const RECORDS = [
  { corpus: "arxiv", id: "2401.1", title: "a", date: "2024-01", primary_category: "cs.CL", score: 0.9, authors: [], url: "", abstract: "", abstract_cut: false },
  { corpus: "arxiv", id: "2506.2", title: "b", date: "2025-06", primary_category: "stat.ML", score: 0.5, authors: [], url: "", abstract: "", abstract_cut: false },
  { corpus: "pubmed", id: "111", title: "c", date: "2026-03-14", journal: "The Lancet", score: 0.4, authors: [], url: "", abstract: "", abstract_cut: false },
  { corpus: "pubmed", id: "222", title: "d", date: "", journal: "Nature Medicine", score: 0.2, authors: [], url: "", abstract: "", abstract_cut: false },
];

test("date bounds are inclusive at both edges", () => {
  const kept = applyFilters(RECORDS, parseFilters({ since: "2024-01", until: "2025-06" }));
  assert.deepEqual(kept.map((r) => r.id), ["2401.1", "2506.2", "222"]);
  // "2024" as a since bound must not exclude January.
  assert.equal(applyFilters(RECORDS, parseFilters({ since: "2024" })).some((r) => r.id === "2401.1"), true);
});

test("a record with no usable date survives a date bound", () => {
  // Dropping on absent data would quietly bias a result set toward whatever
  // happens to be well-dated.
  const kept = applyFilters(RECORDS, parseFilters({ since: "2030" }));
  assert.deepEqual(kept.map((r) => r.id), ["222"]);
});

test("a corpus-specific filter cannot empty the other corpus", () => {
  // `categories` is an arXiv notion; applying it to PubMed rows would silently
  // delete the entire biomedical half of a 'both' search.
  const byCategory = applyFilters(RECORDS, parseFilters({ categories: ["cs"] }));
  assert.deepEqual(byCategory.map((r) => r.id), ["2401.1", "111", "222"]);
  const byJournal = applyFilters(RECORDS, parseFilters({ journals: ["lancet"] }));
  assert.deepEqual(byJournal.map((r) => r.id), ["2401.1", "2506.2", "111"]);
});

test("a category prefix matches its subcategories but not a longer name", () => {
  assert.equal(applyFilters(RECORDS, parseFilters({ categories: ["cs.CL"] })).some((r) => r.id === "2401.1"), true);
  assert.equal(applyFilters(RECORDS, parseFilters({ categories: ["cs.LG"] })).some((r) => r.id === "2401.1"), false);
  // "stat" must not also match a hypothetical "statphys" — the boundary is the dot.
  assert.equal(applyFilters(RECORDS, parseFilters({ categories: ["stat"] })).some((r) => r.id === "2506.2"), true);
  assert.equal(applyFilters(RECORDS, parseFilters({ categories: ["s"] })).some((r) => r.id === "2506.2"), false);
});

test("min_score drops the weak matches", () => {
  assert.deepEqual(
    applyFilters(RECORDS, parseFilters({ min_score: 0.45 })).map((r) => r.id),
    ["2401.1", "2506.2"],
  );
});

// ---------------------------------------------------------------------------
// Shaping and merging
// ---------------------------------------------------------------------------

test("abstract modes trim without mutating the source records", () => {
  const source = [{ ...RECORDS[0], abstract: "y".repeat(900), abstract_cut: true }];
  const none = shapeAbstracts(source, "none");
  assert.equal("abstract" in none[0], false);
  assert.equal("abstract_cut" in none[0], false);
  const short = shapeAbstracts(source, "short");
  assert.equal(short[0].abstract.length, 301, "300 chars plus the ellipsis");
  assert.equal(short[0].abstract_cut, true);
  // The originals are untouched — the merged view shares records with the
  // per-query groups, so a destructive trim would corrupt one of them.
  assert.equal(source[0].abstract.length, 900);
  assert.equal(shapeAbstracts(source, "full")[0].abstract.length, 900);
});

test("mergeRanked de-dupes across angles and ranks corroboration first", () => {
  const a = { corpus: "arxiv", id: "2401.1", title: "a", score: 0.5 };
  const b = { corpus: "arxiv", id: "2401.2", title: "b", score: 0.9 };
  const merged = mergeRanked([
    { query: "q0", records: [/** @type {any} */ (a), /** @type {any} */ (b)] },
    { query: "q1", records: [/** @type {any} */ ({ ...a, score: 0.7 })] },
  ]);
  assert.equal(merged.length, 2);
  // Two angles agreed on 2401.1, so it outranks the better-scoring paper only
  // one angle saw.
  assert.equal(merged[0].id, "2401.1");
  assert.deepEqual(merged[0].found_by, [0, 1]);
  // The best score across angles is kept, not the first or the last.
  assert.equal(merged[0].score, 0.7);
  assert.equal(merged[1].id, "2401.2");
  assert.deepEqual(merged[1].found_by, [0]);
});

test("mergeRanked keeps the two corpora's id spaces apart", () => {
  // A PMID and an arXiv id could collide as bare strings; the corpus is part
  // of the key.
  const merged = mergeRanked([
    {
      query: "q",
      records: [
        /** @type {any} */ ({ corpus: "arxiv", id: "111", score: 0.5 }),
        /** @type {any} */ ({ corpus: "pubmed", id: "111", score: 0.4 }),
      ],
    },
  ]);
  assert.equal(merged.length, 2);
});

test("capGroups holds the response under the record cap without starving a query", () => {
  const groups = Array.from({ length: 6 }, (_, qi) => ({
    query: `q${qi}`,
    records: Array.from({ length: 25 }, (_, i) => /** @type {any} */ ({ corpus: "arxiv", id: `${qi}-${i}` })),
  }));
  const capped = capGroups(groups, MAX_TOTAL_RECORDS);
  const total = capped.reduce((n, g) => n + g.records.length, 0);
  assert.ok(total <= MAX_TOTAL_RECORDS, `total ${total} within cap`);
  // Every query keeps a share — the last angle is not the one that pays.
  for (const g of capped) assert.ok(g.records.length > 0, `${g.query} kept results`);
  // A response already under the cap is passed through untouched.
  const small = [{ query: "q", records: [/** @type {any} */ ({ corpus: "arxiv", id: "x" })] }];
  assert.equal(capGroups(small, MAX_TOTAL_RECORDS), small);
});

test("results are formatted as parseable JSON", () => {
  // The consumer is a model that will read fields out of the payload; prose
  // would make it guess.
  const text = formatLiteratureResult({ tool: "literature_search", results: [{ id: "2401.1" }] });
  assert.deepEqual(JSON.parse(text).results, [{ id: "2401.1" }]);
});
