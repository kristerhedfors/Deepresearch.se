import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// The gold NEEDLE sets, made durable.
//
// These are the paired EN/SV queries that every hosted-retrieval measurement in
// docs/RAG-EVAL-LEDGER.md is decided on. They used to live only under `data/`,
// which is gitignored, so they died with the container that produced them —
// recorded as open item 4 in that ledger.
//
// That is not merely inconvenient. The ledger's whole method is to re-use the
// SAME needles across a corpus change so that only the distractor count varies;
// a regenerated set silently changes the thing being measured, and a paired
// test across two different needle sets is not a paired test. Keeping them in
// the tree is what makes "same needles, only distractors vary" true between
// sessions rather than only within one.
//
// They are hand-written and expensive: each query paraphrases a paper's
// CONTRIBUTION while avoiding the title's distinctive noun phrases, so it
// cannot be answered by lexical overlap. The Swedish half is idiomatic rather
// than translated. This file guards the properties a silent edit would break.

const DIR = join(dirname(fileURLToPath(import.meta.url)), "needles");

/** @returns {{ file: string, corpus: string, needles: any[] }[]} */
function loadSets() {
  return readdirSync(DIR)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((file) => {
      const raw = JSON.parse(readFileSync(join(DIR, file), "utf8"));
      return { file, corpus: raw.corpus || file.split("-")[1]?.replace(".json", "") || "", needles: raw.needle || raw.needles || [] };
    });
}

test("every needle set loads and is non-empty", () => {
  const sets = loadSets();
  assert.ok(sets.length >= 6, `expected the six committed sets, found ${sets.length}`);
  for (const { file, needles } of sets) {
    assert.ok(needles.length > 0, `${file} has no needles`);
  }
});

// TWO SHAPES ARE IN CIRCULATION, and conflating them is a live hazard.
//
//   PAIRED   {gold, en, sv}          — one entry per paper, both languages
//   PER-ROW  {gold, id, en} / {gold, id, sv}
//                                    — one entry per QUERY, so a paper appears
//                                      twice and each row carries its own id
//
// Under the per-row shape a repeated `gold` is correct, not a duplicate, and a
// row with no `en` is a Swedish query rather than a broken one. Reading a
// per-row set with paired assumptions reports both as defects; reading a paired
// set with per-row assumptions loses the sv arm. So the shape is derived once,
// from whether rows carry their own `id`, and every later check follows it.
const shapeOf = (needles) => (needles.some((n) => n.id) ? "per-row" : "paired");

/** The languages a single entry actually carries a query in. */
const langsOf = (n) => ["en", "sv"].filter((k) => String(n[k] || "").trim());

test("each needle set is one recognisable shape, not a mix of both", () => {
  for (const { file, needles } of loadSets()) {
    if (shapeOf(needles) !== "per-row") continue;
    // A per-row set that has lost its ids degrades into an ambiguous paired
    // set, and the sv rows start looking like en rows with a missing query.
    for (const n of needles) assert.ok(n.id, `${file}: per-row set has a row without an id (gold ${n.gold})`);
  }
});

// Sets that ask more than one question about the same paper, and the effective
// number of PAPERS behind their needle count. A paper targeted three times
// counts three times in a recall rate, so `n=33` overstates the independent
// evidence: the real n is 27.
//
// These are declared rather than deduped because the sets as they stand are
// what docs/RAG-EVAL-LEDGER.md's runs were measured on, and silently editing
// one would break the pairing that makes those runs comparable. The next
// generation of aicon-arxiv should drop the near-paraphrases — 2411.00986 is
// asked three times, twice in nearly the same words — but that is a new set
// with a new baseline, not an edit to this one.
const KNOWN_MULTI_QUERY = {
  "aicon-arxiv.json": { needles: 33, papers: 27 },
  "aicon-pubmed.json": { needles: 94, papers: 89 },
  "aisec-arxiv.json": { needles: 111, papers: 109 },
};

test("no needle is duplicated, and any multi-query set declares its true n", () => {
  for (const { file, needles } of loadSets()) {
    const perRow = shapeOf(needles) === "per-row";
    const seen = new Set();
    for (const n of needles) {
      assert.ok(n.gold, `${file}: a needle has no gold id`);
      // Per-row: the unique thing is the QUERY (its id). Paired: the paper.
      const key = perRow ? n.id : n.gold;
      if (!perRow && KNOWN_MULTI_QUERY[file]) continue;
      assert.ok(!seen.has(key), `${file}: duplicate ${perRow ? "needle id" : "gold"} ${key}`);
      seen.add(key);
    }
  }
});

test("a declared multi-query set still matches its declared n — so the overstatement cannot grow", () => {
  for (const { file, needles } of loadSets()) {
    const declared = KNOWN_MULTI_QUERY[file];
    if (!declared) continue;
    const papers = new Set(needles.map((n) => n.gold)).size;
    assert.equal(needles.length, declared.needles, `${file}: needle count moved; re-check the ledger's n`);
    assert.equal(papers, declared.papers, `${file}: unique-paper count moved; re-check the ledger's n`);
  }
});

test("gold ids carry the id form their corpus is keyed on", () => {
  // A PubMed needle keys on `pmid:NNNN`; an arXiv needle on a bare arXiv id,
  // version stripped. Mixing the two produces a needle that can never be found
  // and scores as a permanent miss — which is indistinguishable, in a run
  // summary, from a genuine retrieval failure.
  for (const { file, corpus, needles } of loadSets()) {
    for (const n of needles) {
      if (corpus === "pubmed") {
        assert.match(n.gold, /^pmid:\d+$/, `${file}: ${n.gold} is not a pmid: id`);
      } else if (corpus === "arxiv") {
        assert.match(n.gold, /^(\d{4}\.\d{4,5}|[a-z-]+(\.[A-Z]{2})?\/\d{7})$/, `${file}: ${n.gold} is not an arXiv id`);
        assert.doesNotMatch(n.gold, /v\d+$/, `${file}: ${n.gold} keeps a version suffix; the index keys version-less`);
      }
    }
  }
});

test("every needle carries at least one usable query", () => {
  // A needle with no query at all cannot be measured, and in a run summary an
  // empty query scores as a permanent miss — indistinguishable from a genuine
  // retrieval failure, which is the confusion this whole file guards against.
  for (const { file, needles } of loadSets()) {
    for (const n of needles) {
      const langs = langsOf(n);
      assert.ok(langs.length > 0, `${file}: ${n.id || n.gold} carries no query in any language`);
      for (const k of langs) {
        assert.ok(String(n[k]).trim().length > 20, `${file}: ${n.id || n.gold} has a ${k} query too short to be a paraphrase`);
      }
    }
  }
});

test("every set has both language arms, so a Swedish deficit stays measurable", () => {
  // The ledger reports EN and SV separately and several of its open questions
  // are about the Swedish gap. A set that quietly became English-only would
  // not fail anything — it would just stop reporting the arm.
  for (const { file, needles } of loadSets()) {
    const langs = new Set(needles.flatMap(langsOf));
    assert.ok(langs.has("en"), `${file}: no English queries`);
    assert.ok(langs.has("sv"), `${file}: no Swedish queries — the sv arm cannot be measured`);
  }
});

test("Swedish queries keep their diacritics — stripped Swedish measures a different question", () => {
  // A set that lost its diacritics in transit still looks fine on screen and
  // still runs, but it is no longer the Swedish arm anybody measured. At least
  // one needle per set carrying an å/ä/ö is a cheap canary for that.
  for (const { file, needles } of loadSets()) {
    const swedish = needles.filter((n) => n.sv);
    if (!swedish.length) continue;
    assert.ok(
      swedish.some((n) => /[åäöÅÄÖ]/.test(n.sv)),
      `${file}: ${swedish.length} Swedish queries and not one diacritic — the set looks transliterated`,
    );
  }
});

test("a Swedish query is not a copy of its English one", () => {
  for (const { file, needles } of loadSets()) {
    for (const n of needles) {
      if (!n.sv) continue;
      assert.notEqual(String(n.sv).trim(), String(n.en).trim(), `${file}: ${n.gold} has sv identical to en`);
    }
  }
});
