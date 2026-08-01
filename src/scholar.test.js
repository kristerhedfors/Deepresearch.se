// Unit tests for the peer-reviewed literature source (src/scholar.js).
//
// The half that matters here is the REJECTIONS. A source that returns journal
// articles when everything goes right is easy; the agent's promise is that a
// preprint, a thesis, a retraction and an unverifiable Google Scholar hit all
// fail to reach an answer, and those are the cases asserted hardest below.

import assert from "node:assert/strict";
import test from "node:test";

import {
  bareDoi,
  crossrefRecord,
  filterPeerReviewed,
  invertedAbstract,
  mergeRecords,
  parseScholarResult,
  peerReviewed,
  rankRecords,
  scholarDiversityKey,
  scholarIntent,
  scholarLadder,
  scholarLeadIntent,
  scholarPickQuery,
  scholarTermKey,
  scholarTerms,
  titleKey,
  toItem,
} from "./scholar.js";

/** A ScholarRecord with sensible defaults, overridden per test. */
const rec = (over = {}) => ({
  title: "A paper",
  doi: "10.1000/x",
  url: "https://doi.org/10.1000/x",
  year: 2020,
  venue: "Journal of Things",
  publisher: "",
  issn: "1234-5678",
  authors: ["A Author"],
  citedBy: 10,
  abstract: "",
  retracted: false,
  kind: "journal",
  backend: "openalex",
  rank: 0,
  peerReviewed: false,
  why: "",
  ...over,
});

// ---- intent -----------------------------------------------------------------

test("scholarIntent fires on the peer-reviewed record, in English and Swedish", () => {
  for (const s of [
    "What does the research say about vitamin D?",
    "Find peer-reviewed studies on intermittent fasting",
    "search google scholar for CRISPR off-target",
    "is there any evidence that screen time affects sleep",
    "show me the meta-analysis on salt intake",
    // Swedish, with the definite and plural forms Swedish actually uses. Each
    // of these is dead on arrival under a `\b(…)\b` gate (src/europepmc.js).
    "Vad säger forskningen om intermittent fasta?",
    "Finns det belägg för att skärmtid påverkar sömnen?",
    "Hitta sakkunniggranskade artiklar om antibiotikaresistens",
    "Vilka studier finns om rött kött och hjärt-kärlsjukdom?",
    "Vad är forskningsläget kring mikroplaster?",
    "Sök i den vetenskapliga litteraturen efter belägg",
    "Visa publicerade studier om kolupptag i våtmarker",
  ]) {
    assert.equal(scholarIntent(s), true, `should fire: ${s}`);
  }
});

// Feedback #54 (2026-07-30): a question asking whether something is PROVEN is
// asking for the peer-reviewed record, and no gate in the repo fired on the
// word. The reported question is the first case here, verbatim.
test("scholarIntent fires on the proven family, minus the commercial idiom", () => {
  for (const s of [
    "Spirulina proven health benefits",
    "is creatine scientifically proven",
    "what proof is there that cold plunges help recovery",
    "unproven claims about collagen supplements",
    "clinically tested treatments for tinnitus",
    "evidence-based approaches to insomnia",
    "Bevisade hälsoeffekter av spirulina",
    "Är kreatin vetenskapligt bevisat?",
    "Vilka påvisade effekter har kalla bad?",
    "Finns det evidensbaserad behandling för migrän?",
    "Är nyttan styrkt?",
  ]) {
    assert.equal(scholarIntent(s), true, `should fire: ${s}`);
  }
  // The one research word with a heavy commercial idiom — that sentence is
  // not an ask for the literature, in either language.
  for (const s of [
    "our team has a proven track record in logistics",
    "a tried and tested deployment process",
    "we use proven technology only",
    "en beprövad metod för att baka bröd",
  ]) {
    assert.equal(scholarIntent(s), false, `should not fire: ${s}`);
  }
});

test("scholarIntent stays out of questions with nothing scholarly in them", () => {
  for (const s of [
    "",
    "what's the weather in Gothenburg tomorrow",
    "book me a table at 7",
    "hur mycket kostar en bussbiljett till Malmö",
    "fix the typo on line 40",
  ]) {
    assert.equal(scholarIntent(s), false, `should not fire: ${s}`);
  }
});

test("scholarLeadIntent is strictly narrower than scholarIntent", () => {
  // The registry rule (search-sources.js): naming the source is a different act
  // from asking a question the source happens to serve. Leading stands the
  // whole web leg down, so anything that leads must also merely-fire.
  const leads = [
    "search google scholar for transformer scaling laws",
    "use only peer-reviewed sources for this",
    "kolla den vetenskapliga litteraturen om D-vitamin",
    "sök i forskningslitteraturen efter belägg",
    "look in openalex for this",
  ];
  for (const s of leads) {
    assert.equal(scholarLeadIntent(s), true, `should lead: ${s}`);
    assert.equal(scholarIntent(s), true, `a lead must also fire the wider gate: ${s}`);
  }
  for (const s of [
    "what does the research say about sleep",
    "vad säger forskningen om sömn",
    "find studies on exercise and depression",
  ]) {
    assert.equal(scholarLeadIntent(s), false, `should not lead: ${s}`);
  }
});

// ---- query building ---------------------------------------------------------

test("scholarTerms strips the words every candidate paper contains", () => {
  // "peer-reviewed", "studies" and "research" come from the pipeline's own
  // prompt rules as much as from the user; left in, each one spends a slot of
  // an AND-narrowing query on a word that discriminates nothing.
  const t = scholarTerms("What do peer-reviewed studies say about vitamin D and respiratory infection?");
  assert.deepEqual(t, ["vitamin", "d", "respiratory", "infection"]);
  assert.deepEqual(
    scholarTerms("Vad säger forskningen om intermittent fasta och insulinkänslighet?"),
    ["intermittent", "fasta", "insulinkänslighet"],
  );
  assert.deepEqual(scholarTerms(""), []);
  assert.deepEqual(scholarTerms("the and of in"), []);
});

test("scholarTermKey collapses two phrasings of one angle", () => {
  assert.equal(
    scholarTermKey("vitamin D and respiratory infection"),
    scholarTermKey("respiratory infection, vitamin D"),
  );
  assert.notEqual(scholarTermKey("vitamin D"), scholarTermKey("vitamin K"));
});

test("the ladder climbs by DROPPING terms, because terms narrow", () => {
  // Measured 2026-07-31: 5 terms → 271 hits, 3 terms → over 2,000. Adding a
  // term is how a query reaches zero, which is the opposite of arXiv.
  const rungs = scholarLadder("ancient dna mammoth genome permafrost preservation");
  assert.equal(rungs.length, 3);
  assert.ok(rungs[0].terms.length > rungs[1].terms.length);
  assert.ok(rungs[1].terms.length > rungs[2].terms.length);
  // Every rung's key is stable under reordering, so cross-wave dedup works.
  assert.equal(rungs[0].key, rungs[0].terms.slice().sort().join(" "));
  assert.deepEqual(scholarLadder(""), []);
});

test("scholarPickQuery prefers the angle the user actually asked", () => {
  const batch = [
    "machine learning optimization convergence proofs stochastic gradient variance reduction",
    "vitamin D supplementation respiratory infection",
  ];
  assert.equal(
    scholarPickQuery(batch, "Does vitamin D supplementation reduce respiratory infections?"),
    "vitamin D supplementation respiratory infection",
  );
});

// ---- the peer-review verdict ------------------------------------------------

test("peerReviewed admits only records carrying positive evidence", () => {
  assert.equal(peerReviewed(rec()).ok, true);
  assert.equal(peerReviewed(rec({ backend: "europepmc", kind: "MED" })).ok, true);
  assert.equal(peerReviewed(rec({ backend: "crossref", kind: "journal-article" })).ok, true);
  assert.equal(
    peerReviewed(rec({ backend: "semanticscholar", kind: "JournalArticle,Review" })).ok,
    true,
  );
});

test("peerReviewed rejects preprints, repositories, retractions and the unknown", () => {
  const cases = [
    [rec({ backend: "europepmc", kind: "PPR" }), /preprint/],
    [rec({ backend: "openalex", kind: "repository" }), /venue type/],
    [rec({ backend: "openalex", issn: "" }), /ISSN/],
    [rec({ retracted: true }), /retracted/],
    [rec({ backend: "semanticscholar", kind: "Dataset" }), /type/],
    [rec({ backend: "crossref", kind: "posted-content" }), /Crossref type/],
    [rec({ backend: "crossref", kind: "dataset" }), /Crossref type/],
    // The one that matters most: a Google Scholar hit on its own. Scholar
    // indexes theses, slide decks and predatory journals beside Nature and
    // publishes no signal telling them apart, so a hit that merged with
    // nothing must not reach an answer.
    [rec({ backend: "gscholar", kind: "scholar-result" }), /no peer-review metadata/],
  ];
  for (const [r, why] of cases) {
    const v = peerReviewed(/** @type {any} */ (r));
    assert.equal(v.ok, false, `${/** @type {any} */ (r).backend}/${/** @type {any} */ (r).kind} must be rejected`);
    assert.match(v.why, /** @type {RegExp} */ (why));
  }
});

test("filterPeerReviewed reports what it dropped and why", () => {
  const { kept, rejected } = filterPeerReviewed([
    rec({ title: "Good" }),
    rec({ title: "Preprint", backend: "europepmc", kind: "PPR" }),
    rec({ title: "Scholar only", backend: "gscholar" }),
  ]);
  assert.deepEqual(kept.map((r) => r.title), ["Good"]);
  assert.equal(kept[0].peerReviewed, true);
  assert.ok(kept[0].why.includes("ISSN"));
  assert.deepEqual(rejected.map((r) => r.title), ["Preprint", "Scholar only"]);
});

// ---- merging ----------------------------------------------------------------

test("a Google Scholar hit is admitted only by merging onto a record that has evidence", () => {
  const scholarHit = rec({
    title: "Optimized sgRNA design to maximize activity",
    doi: "",
    backend: "gscholar",
    kind: "scholar-result",
    issn: "",
    venue: "Nature Biotechnology",
    citedBy: 5067,
    url: "https://www.nature.com/articles/nbt.3437",
  });
  const openalexHit = rec({
    title: "Optimized sgRNA Design to Maximize Activity",
    doi: "10.1038/nbt.3437",
    backend: "openalex",
    kind: "journal",
    issn: "0733-222X",
    citedBy: 4900,
  });

  const merged = mergeRecords([[openalexHit], [scholarHit]]);
  assert.equal(merged.length, 1, "the same paper from two backends is one record");
  assert.equal(merged[0].backend, "openalex", "the evidence-bearing backend keeps the identity");
  // Scholar's citation count is the higher of the two and is what survives —
  // that is the half of Scholar worth having.
  assert.equal(merged[0].citedBy, 5067);
  assert.equal(filterPeerReviewed(merged).kept.length, 1);

  // …and alone it does not survive.
  const alone = filterPeerReviewed(mergeRecords([[scholarHit]]));
  assert.equal(alone.kept.length, 0);
  assert.equal(alone.rejected.length, 1);
});

test("titleKey matches the same paper across four house styles", () => {
  const variants = [
    "High-frequency off-target mutagenesis induced by CRISPR-Cas nucleases",
    "High-Frequency Off-Target Mutagenesis Induced by CRISPR-Cas Nucleases.",
    "High frequency off target mutagenesis induced by CRISPR Cas nucleases",
    "<i>High-frequency</i> off-target mutagenesis induced by CRISPR-Cas nucleases",
  ];
  const keys = new Set(variants.map(titleKey));
  assert.equal(keys.size, 1, [...keys].join(" | "));
});

test("bareDoi finds a DOI in whatever shape it arrives", () => {
  assert.equal(bareDoi("https://doi.org/10.1038/nbt.3437"), "10.1038/nbt.3437");
  assert.equal(bareDoi("doi:10.1038/NBT.3437"), "10.1038/nbt.3437");
  assert.equal(bareDoi("see 10.1016/j.cell.2020.01.001."), "10.1016/j.cell.2020.01.001");
  assert.equal(bareDoi("https://arxiv.org/abs/2401.00001"), "");
  assert.equal(bareDoi(""), "");
});

// ---- backend parsing --------------------------------------------------------

test("parseScholarResult reads SerpApi's publication_info summary", () => {
  const r = parseScholarResult({
    title: "Imagenet classification with deep convolutional neural networks",
    link: "https://papers.nips.cc/paper/4824",
    publication_info: { summary: "A Krizhevsky, I Sutskever, GE Hinton - Advances in neural…, 2012 - papers.nips.cc" },
    inline_links: { cited_by: { total: 198566 } },
    snippet: "We trained a large, deep convolutional neural network…",
  }, 3);
  assert.ok(r);
  const g = /** @type {any} */ (r);
  assert.equal(g.year, 2012);
  assert.deepEqual(g.authors, ["A Krizhevsky", "I Sutskever", "GE Hinton"]);
  assert.equal(g.citedBy, 198566);
  assert.equal(g.backend, "gscholar");
  assert.equal(g.rank, 3, "Scholar's own position is carried into the ranking");
  // The crux: nothing Scholar returned is peer-review evidence.
  assert.equal(peerReviewed(g).ok, false);
  assert.equal(parseScholarResult({ title: "" }), null);
});

test("crossrefRecord keeps the type, so the Faculty-Opinions trap is visible", () => {
  // Probed 2026-07-31: asked for the exact title of a Nature Biotechnology
  // paper, Crossref's query.bibliographic returns a `dataset` record called
  // "Faculty Opinions recommendation of <that title>". Keeping the type is
  // what lets the verdict reject it; the title check in crossrefVerify is what
  // stops it being merged onto the real paper in the first place.
  const r = crossrefRecord({
    title: ["Faculty Opinions recommendation of Optimized sgRNA design…"],
    DOI: "10.3410/f.726081204.793558122",
    type: "dataset",
    "container-title": ["Faculty Opinions – Post-Publication Peer Review"],
    "is-referenced-by-count": 0,
    issued: { "date-parts": [[2019, 3, 22]] },
  });
  assert.ok(r);
  assert.equal(/** @type {any} */ (r).kind, "dataset");
  assert.equal(peerReviewed(/** @type {any} */ (r)).ok, false);
  assert.equal(crossrefRecord({ title: ["x"] }), null, "no DOI → no record");
});

test("invertedAbstract rebuilds OpenAlex's positional index", () => {
  assert.equal(
    invertedAbstract({ We: [0], trained: [1], a: [2], network: [3] }),
    "We trained a network",
  );
  assert.equal(invertedAbstract(null), "");
  assert.equal(invertedAbstract("nope"), "");
});

// ---- ranking and item shape --------------------------------------------------

test("rankRecords orders by citations among papers of comparable relevance", () => {
  const ranked = rankRecords(
    [
      rec({ title: "obscure new", citedBy: 2, year: 2025, rank: 0 }),
      rec({ title: "seminal old", citedBy: 5000, year: 1998, rank: 0 }),
      rec({ title: "solid recent", citedBy: 300, year: 2023, rank: 0 }),
    ],
    2026,
  );
  assert.deepEqual(ranked.map((r) => r.title), ["seminal old", "solid recent", "obscure new"]);
});

test("a citation magnet cannot outrank the paper the question was about", () => {
  // The regression this ranking exists for. Probed live 2026-07-31, an earlier
  // build that ranked on citations alone answered "vitamin D supplementation
  // acute respiratory infection" with the PRISMA reporting statement (13,196
  // citations) and "CRISPR off-target effects" with limma and DESeq2. All are
  // real peer-reviewed papers; none is about the question. Citation counts
  // across a whole literature are dominated by methods papers everybody cites
  // and nobody asked about, so retrieval position has to lead.
  const ranked = rankRecords(
    [
      rec({ title: "PRISMA statement", citedBy: 13196, year: 2009, rank: 6 }),
      rec({ title: "Vitamin D supplementation to prevent acute respiratory infections", citedBy: 2078, year: 2017, rank: 0 }),
    ],
    2026,
  );
  assert.equal(ranked[0].title, "Vitamin D supplementation to prevent acute respiratory infections");
});

test("mergeRecords keeps the BEST retrieval position any backend gave a paper", () => {
  const merged = mergeRecords([
    [rec({ title: "P", doi: "10.1/a", rank: 5 })],
    [rec({ title: "P", doi: "10.1/a", rank: 1, backend: "europepmc", kind: "MED" })],
  ]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].rank, 1);
});

test("toItem's provenance line carries the venue, the metric and the verdict", () => {
  const table = {
    n: 1,
    harvested: "2026-07-31",
    byName: new Map([["journal of things", { name: "Journal of Things", h5: 218, h5median: 300, cats: [] }]]),
  };
  const r = rec({ why: "journal with ISSN 1234-5678 (OpenAlex)", citedBy: 42, abstract: "Short." });
  const item = /** @type {any} */ (toItem(r, /** @type {any} */ (table)));
  assert.ok(item);
  assert.equal(item.url, "https://doi.org/10.1000/x");
  assert.match(item.highlights[0], /Journal of Things \(Scholar h5-index 218\)/);
  assert.match(item.highlights[0], /2020/);
  assert.match(item.highlights[0], /cited 42×/);
  assert.match(item.highlights[0], /peer-reviewed: journal with ISSN/);
  assert.equal(item.highlights[2], "Short.");

  // An unranked venue is NOT a quality verdict — Scholar publishes only the top
  // hundred per field — so the annotation is simply absent.
  const plain = /** @type {any} */ (toItem(rec({ venue: "Journal of Obscure Things" }), /** @type {any} */ (table)));
  assert.ok(plain && !plain.highlights[0].includes("h5-index"));
  // Junk in, null out — never a throw (invariant 2).
  assert.equal(toItem(/** @type {any} */ ({ title: "no url" })), null);
  assert.equal(toItem(/** @type {any} */ (null)), null);
});

test("scholarDiversityKey keys DOIs by publisher prefix", () => {
  assert.equal(scholarDiversityKey("https://doi.org/10.1038/nbt.3437"), "doi.org/10.1038");
  assert.equal(scholarDiversityKey("https://doi.org/10.1016/j.cell.2020.01.001"), "doi.org/10.1016");
  assert.equal(scholarDiversityKey("https://europepmc.org/article/MED/1"), "doi.org");
  assert.equal(scholarDiversityKey("not a url"), "doi.org");
});
