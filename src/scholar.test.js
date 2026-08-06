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

// Feedback #61 (chat_logs #1656). A user attached a LinkedIn screenshot and
// wrote "Research this founder". The gate read the English imperative VERB as
// the noun that names the scholarly record, this source LED, the web leg stood
// down, and the answer's first thirteen numbered sources were lipid-nanoparticle
// papers, MXene aerogels and a cancer-conference abstract book — nothing about
// the founder until [14]. The reported message is the first case here, verbatim.
test("scholarIntent reads \"research\" as an imperative verb, not as the literature", () => {
  for (const s of [
    "Research this founder",
    "Research this founder for me",
    "research this company",
    "Please research the company behind this screenshot",
    "Can you research him?",
    "I need you to research their CTO",
    "help me research this person",
    "do some research on this founder",
    "Research on this founder",
    "and research the people in this photo",
    // Swedish gives the instruction with different words entirely (invariant 6):
    // the loan verb, the light verb, and the three native imperatives.
    "Researcha den här grundaren",
    "kan du researcha den här personen",
    "gör research på den här grundaren",
    "gör lite research om det här bolaget",
    "Undersök den här grundaren",
    "kolla upp den här grundaren",
    "ta reda på vem den här grundaren är",
    // …and the ASCII-typed forms a keyboard without å/ä/ö produces.
    "undersok den har grundaren",
    "ta reda pa vem grundaren ar",
  ]) {
    assert.equal(scholarIntent(s), false, `should not fire: ${s}`);
    assert.equal(scholarLeadIntent(s), false, `must certainly not lead: ${s}`);
  }
});

// The other half of the same line: the word as a NOUN still fires, and it has
// to, or the fix above trades one silent failure for another.
test("scholarIntent still reads \"research\" as the noun naming the record", () => {
  for (const s of [
    "research on gut microbiome and depression",
    "research into microplastics in drinking water",
    "the research shows that sleep debt is not repayable",
    "the research that showed this was retracted later",
    "peer-reviewed research on statins and muscle pain",
    "academic research about teacher-student ratios",
    "what does the latest research say about GLP-1 drugs",
    "there is a body of research supporting this",
    "how much research exists on cold exposure",
    "the state of research on room-temperature superconductors",
    "recent research findings on ocean acidification",
    // "want" takes both — "I want you TO research this" is the instruction,
    // "I want research on X" is the noun. The infinitive marker is the whole
    // difference, and an early draft of the veto ate the second one.
    "I want research on the efficacy of mindfulness apps",
    // Swedish names the record with its own nouns — no verb collision to
    // resolve, so the breadth lives in the words themselves.
    "Vad säger forskningen om intermittent fasta?",
    "finns det forskning om kalla bad",
    "vilka studier finns om rött kött och hjärt-kärlsjukdom",
    "den vetenskapliga litteraturen om mikroplaster",
    "vad är forskningsläget kring D-vitamin",
    "visa publicerade studier om kolupptag",
  ]) {
    assert.equal(scholarIntent(s), true, `should fire: ${s}`);
  }
});

// The veto is scoped to the "research"-the-noun clause alone. A message that
// both instructs AND asks about the literature still fires on its second half —
// otherwise the fix would silence real literature questions that happen to open
// with an instruction.
test("the imperative veto never suppresses the other clauses", () => {
  for (const s of [
    "Research this founder — what does the literature say about his patents?",
    "Please research the company and find peer-reviewed studies on their drug",
    "Researcha den här grundaren och hitta sakkunniggranskade artiklar",
    "Undersök den här personen. Vad säger forskningen om metoden?",
  ]) {
    assert.equal(scholarIntent(s), true, `should fire on its literature half: ${s}`);
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

// Leading stands the whole web leg down, so every word that leads has to be a
// SOURCE NAME and nothing else. Bare "scholar"/"scholars" was in the named list
// and is a person far more often than it is Google Scholar — the same failure
// shape as feedback #61, one gate over.
test("a bare \"scholar\" leads only when it names the source, not the person", () => {
  for (const s of [
    "he was a Rhodes scholar before founding the company",
    "a scholar of Byzantine history",
    "scholars disagree about the date",
    "she is the leading scholar on this period",
  ]) {
    assert.equal(scholarLeadIntent(s), false, `a person is not a source: ${s}`);
    assert.equal(scholarIntent(s), false, `…and does not fire the wider gate either: ${s}`);
  }
  // Addressed AS a place to look it still counts, in both languages.
  for (const s of [
    "search scholar for transformer scaling laws",
    "look it up in scholar",
    "check scholar for this",
    "sök i scholar efter D-vitamin",
    "kolla på scholar",
    "leta i scholar efter studien",
    "sok i scholar efter D-vitamin",
    // and the full product name, however it is written
    "Google Scholar",
    "kolla scholarn",
  ]) {
    assert.equal(scholarLeadIntent(s), true, `should lead: ${s}`);
    assert.equal(scholarIntent(s), true, `a lead must also fire the wider gate: ${s}`);
  }
});

// The destination gate, walked as MATCHED PAIRS (invariant 6). The first cut of
// this gate accepted a bare preposition in English with no Swedish counterpart,
// so "I found it in scholar" led and "Jag hittade den i scholar" did not — a
// hole no side-by-side reading of the two lists exposed, because each list
// looked reasonable on its own. Every row here therefore asserts ONE verdict
// across both languages; adding a phrasing to one arm without its counterpart
// fails here rather than in production.
test("scholar-as-a-destination: matched EN/SV pairs agree", () => {
  /** @type {Array<[string, string, boolean]>} */
  const pairs = [
    // the four measured holes, verbatim
    ["I found it in scholar", "Jag hittade den i scholar", true],
    ["I found it on scholar", "Jag hittade den på scholar", true],
    ["get it from scholar", "hämta den från scholar", true],
    ["look it up in scholar", "slå upp det i scholar", true],
    // …and the same four typed without å/ä/ö
    ["I found it on scholar", "Jag hittade den pa scholar", true],
    ["get it from scholar", "hamta den fran scholar", true],
    ["look it up in scholar", "sla upp det i scholar", true],
    // the rest of the verb set, one row per sense
    ["search scholar for transformer scaling laws", "sök i scholar efter skalningslagar", true],
    ["search scholar for transformer scaling laws", "sok i scholar efter skalningslagar", true],
    ["check scholar for this", "kolla på scholar efter det här", true],
    ["look in scholar for the study", "leta i scholar efter studien", true],
    ["use scholar for this", "använd scholar för det här", true],
    ["use scholar for this", "anvand scholar for det har", true],
    ["query scholar for citations", "sök i scholar efter citeringar", true],
    ["fetch the paper from scholar", "hämta artikeln från scholar", true],
    ["look up the study in scholar", "slå upp studien i scholar", true],
    ["find the article on scholar", "hitta artikeln på scholar", true],
    ["browse scholar", "bläddra i scholar", true],
    ["go to scholar", "gå in på scholar", true],
    ["go to scholar", "ga in pa scholar", true],
    ["I used scholar for this", "jag använde scholar för det här", true],
    // the person, in both languages, must stay silent on both sides
    ["a Rhodes scholar from Oxford", "en Rhodes-scholar från Oxford", false],
    ["he went to Oxford as a Rhodes scholar", "han gick på Oxford som Rhodes scholar", false],
    ["I used to be a scholar", "jag brukade vara scholar", false],
    ["I found the Rhodes scholar's profile", "Jag hittade den där scholar-profilen", false],
    ["look at this scholar", "titta på den där scholar-typen", false],
    // "scholar" heading a compound noun is not the site, verb in front or not
    [
      "What is the retention rate on scholar programs in the US?",
      "Vad är kvarhållningsgraden på scholar-program i USA?",
      false,
    ],
    ["find the retention rate on scholar programs", "hitta kvarhållningsgraden för scholar-program", false],
    ["she is going to scholar events this year", "hon går på scholar-event i år", false],
    ["look up scholar award winners", "slå upp scholar-pristagare", false],
  ];
  for (const [en, sv, expected] of pairs) {
    assert.equal(scholarLeadIntent(en), expected, `EN: ${en}`);
    assert.equal(scholarLeadIntent(sv), expected, `SV must agree with its EN pair: ${sv}`);
    // …and a lead is always also a fire, so the pairs pin both gates at once.
    if (expected) {
      assert.equal(scholarIntent(en), true, `a lead must also fire the wider gate: ${en}`);
      assert.equal(scholarIntent(sv), true, `a lead must also fire the wider gate: ${sv}`);
    }
  }
});

// The naming of the FULL product still leads whatever sits around it — the
// tightening above is about the bare word only.
test("the full product name leads regardless of the surrounding words", () => {
  for (const s of [
    "search google scholar for citations of this paper",
    "sök i google scholar efter citeringar av den här artikeln",
    "scholar.google.com",
    "kolla scholarn",
  ]) {
    assert.equal(scholarLeadIntent(s), true, `should lead: ${s}`);
  }
});

// Invariant 6, mechanically. Every Swedish alternative added or changed above
// begins or ends near å/ä/ö at least once; JavaScript's `\b` is defined over
// [A-Za-z0-9_], so a `\b(…)\b` gate would silently drop exactly these while the
// English half kept working. Matched EN/SV pairs are what catches it — reading
// the two lists side by side does not.
test("Swedish language parity: matched EN/SV pairs agree", () => {
  /** @type {Array<[string, string, boolean]>} */
  const pairs = [
    ["Research this founder", "Researcha den här grundaren", false],
    ["please research the company", "gör research på det här bolaget", false],
    ["look this person up", "kolla upp den här personen", false],
    ["find out who this founder is", "ta reda på vem den här grundaren är", false],
    ["investigate this founder", "undersök den här grundaren", false],
    ["what does the research say about vitamin D", "vad säger forskningen om D-vitamin", true],
    ["peer-reviewed research on statins", "sakkunniggranskad forskning om statiner", true],
    ["is there any evidence for this", "finns det några belägg för det här", true],
    ["the scientific literature on microplastics", "den vetenskapliga litteraturen om mikroplaster", true],
    ["search scholar for this", "sök i scholar efter det här", true],
  ];
  for (const [en, sv, expected] of pairs) {
    assert.equal(scholarIntent(en), expected, `EN: ${en}`);
    assert.equal(scholarIntent(sv), expected, `SV must agree with its EN pair: ${sv}`);
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
