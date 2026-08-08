import assert from "node:assert/strict";
import test from "node:test";

import {
  ARTICLE_TAG,
  BOOK_TAG,
  MIN_ABSTRACT_CHARS,
  RECORDS_PER_FILE,
  abstractText,
  authorNames,
  buildPassage,
  decodeEntities,
  deletedPmids,
  keepRecord,
  parseArticle,
  parseListing,
  planHarvest,
  pmidOf,
  pubDate,
  pubYear,
  pubmedUrl,
  stripTags,
  takeBlocks,
  vectorMetadata,
  windowNote,
} from "./pubmed-core.js";

// A trimmed but structurally faithful record: the shapes below (the second
// <PMID> inside CommentsCorrections, the labelled AbstractText sections, the
// inline <i> markup, the ArticleDate alongside a PubDate) are all copied from
// real rows in pubmed26n1334.xml.
const ARTICLE = `<PubmedArticle><MedlineCitation Status="Publisher" Owner="NLM">
<PMID Version="1">41610285</PMID>
<Article PubModel="Print-Electronic">
<Journal><ISSN>1476-4687</ISSN><Title>Nature communications</Title></Journal>
<ArticleTitle>Ancient <i>DNA</i> from a Neolithic site &amp; its lessons.</ArticleTitle>
<Abstract>
<AbstractText Label="BACKGROUND">Sequencing of ancient genomes is limited by damage.</AbstractText>
<AbstractText Label="METHODS">We randomised 40 samples across two protocols.</AbstractText>
</Abstract>
<AuthorList><Author><LastName>Svensson</LastName><ForeName>Anna K</ForeName></Author>
<Author><LastName>Wu</LastName><ForeName>Lei</ForeName></Author>
<Author><CollectiveName>The Pathogen Consortium</CollectiveName></Author></AuthorList>
<PubDate><Year>2026</Year><Month>Jan</Month></PubDate>
<ArticleDate DateType="Electronic"><Year>2026</Year><Month>02</Month><Day>07</Day></ArticleDate>
<Language>eng</Language>
<PublicationTypeList><PublicationType UI="D016428">Journal Article</PublicationType></PublicationTypeList>
</Article>
<MeshHeadingList><MeshHeading><DescriptorName UI="D000073">DNA, Ancient</DescriptorName></MeshHeading></MeshHeadingList>
<CommentsCorrectionsList><CommentsCorrections RefType="Cites"><PMID Version="1">11001674</PMID></CommentsCorrections></CommentsCorrectionsList>
</MedlineCitation>
<PubmedData><ArticleIdList><ArticleId IdType="doi">10.1038/s41467-026-00000-1</ArticleId>
<ArticleId IdType="pubmed">41610285</ArticleId></ArticleIdList></PubmedData></PubmedArticle>`;

test("stripTags removes inline markup and decodes entities", () => {
  assert.equal(stripTags("Ancient <i>DNA</i> &amp; its  lessons"), "Ancient DNA & its lessons");
  // Greek mu (U+03BC), not the micro sign (U+00B5) — decimal and hex forms of
  // the same code point are both common in PubMed's dosage text.
  const mu = String.fromCodePoint(0x3bc);
  assert.equal(decodeEntities("&#956;g &#x3bc;g &unknown;"), `${mu}g ${mu}g &unknown;`);
});

test("parseArticle takes the record's OWN pmid, not a cited one", () => {
  const rec = parseArticle(ARTICLE);
  assert.ok(rec);
  // 11001674 appears in CommentsCorrections; picking it would silently
  // mis-key the vector and break every id-based cross-check.
  assert.equal(rec.pmid, "41610285");
  assert.equal(rec.id, "pmid:41610285");
  assert.equal(pmidOf(rec.id), "41610285");
});

test("parseArticle pulls the fields the index and the answer both need", () => {
  const rec = parseArticle(ARTICLE);
  assert.equal(rec.title, "Ancient DNA from a Neolithic site & its lessons.");
  assert.equal(rec.journal, "Nature communications");
  assert.equal(rec.doi, "10.1038/s41467-026-00000-1");
  assert.deepEqual(rec.languages, ["eng"]);
  assert.deepEqual(rec.mesh, ["DNA, Ancient"]);
  assert.deepEqual(rec.types, ["Journal Article"]);
});

test("parseArticle returns null rather than a half-record when there is no pmid", () => {
  assert.equal(parseArticle("<PubmedArticle><MedlineCitation></MedlineCitation></PubmedArticle>"), null);
  assert.equal(parseArticle(""), null);
});

test("structured abstracts keep their section labels", () => {
  const rec = parseArticle(ARTICLE);
  assert.equal(
    rec.abstract,
    "BACKGROUND: Sequencing of ancient genomes is limited by damage. METHODS: We randomised 40 samples across two protocols.",
  );
});

test("an UNLABELLED section contributes its text without the pseudo-label", () => {
  const xml = `<Abstract><AbstractText Label="UNLABELLED">Plain body.</AbstractText></Abstract>`;
  assert.equal(abstractText(xml), "Plain body.");
  assert.equal(abstractText(`<AbstractText>Bare body.</AbstractText>`), "Bare body.");
  assert.equal(abstractText("<Abstract></Abstract>"), "");
});

test("authors include collective names and are capped", () => {
  assert.deepEqual(authorNames(ARTICLE), ["Anna K Svensson", "Lei Wu", "The Pathogen Consortium"]);
  const many = Array.from({ length: 30 }, (_, i) => `<Author><LastName>A${i}</LastName></Author>`).join("");
  assert.equal(authorNames(many).length, 12);
});

test("pubYear prefers the electronic ArticleDate and survives a MedlineDate", () => {
  assert.equal(pubYear(ARTICLE), "2026");
  assert.equal(pubYear("<PubDate><Year>2019</Year></PubDate>"), "2019");
  // Free-text dates carry no <Year> at all — about a twentieth of the archive.
  assert.equal(pubYear("<PubDate><MedlineDate>2025 Nov-Dec</MedlineDate></PubDate>"), "2025");
  assert.equal(pubYear("<PubDate></PubDate>"), "");
});

test("pubDate degrades from day to month to year rather than inventing precision", () => {
  assert.equal(pubDate(ARTICLE), "2026-02-07");
  assert.equal(pubDate("<PubDate><Year>2024</Year><Month>Mar</Month></PubDate>"), "2024-03");
  assert.equal(pubDate("<PubDate><Year>2024</Year><Month>11</Month><Day>3</Day></PubDate>"), "2024-11-03");
  assert.equal(pubDate("<PubDate><Year>2024</Year></PubDate>"), "2024");
  assert.equal(pubDate("<PubDate><MedlineDate>2025 Nov-Dec</MedlineDate></PubDate>"), "2025");
  assert.equal(pubDate("<x/>"), "");
});

test("takeBlocks returns whole records and keeps the torn tail", () => {
  const doc = `<PubmedArticleSet>${ARTICLE}${ARTICLE}<PubmedArticle><MedlineCitation`;
  const { blocks, rest } = takeBlocks(doc);
  assert.equal(blocks.length, 2);
  assert.ok(rest.startsWith(`<${ARTICLE_TAG}>`));
  // Feeding the tail back with the remainder of the stream completes it.
  const next = takeBlocks(rest + `><PMID Version="1">1</PMID></MedlineCitation></PubmedArticle>`);
  assert.equal(next.blocks.length, 1);
});

// An `efetch.fcgi?db=pubmed&retmode=xml` response, which is the other channel
// this core parses (scripts/pubmed-harvest.mjs --pmids). Same DTD as the
// archive files — the DOCTYPE and the <PubmedBookArticle> shape are copied from
// a live response for 41610285,33301246,20301295 (2026-08-08) — which is the
// whole reason an explicit PMID list needs no second parser.
const BOOK = `<PubmedBookArticle><BookDocument><PMID Version="1">20301295</PMID>
<ArticleIdList><ArticleId IdType="bookaccession">NBK1116</ArticleId></ArticleIdList>
<Book><Publisher><PublisherName>University of Washington, Seattle</PublisherName></Publisher>
<BookTitle book="gene">GeneReviews</BookTitle></Book></BookDocument></PubmedBookArticle>`;

const EFETCH_RESPONSE = `<?xml version="1.0" ?>
<!DOCTYPE PubmedArticleSet PUBLIC "-//NLM//DTD PubMedArticle, 1st January 2025//EN" "https://dtd.nlm.nih.gov/ncbi/pubmed/out/pubmed_250101.dtd">
<PubmedArticleSet>
${ARTICLE}
${BOOK}
</PubmedArticleSet>`;

test("an efetch response parses through the SAME path as an archive file", () => {
  const { blocks, rest } = takeBlocks(EFETCH_RESPONSE);
  assert.equal(blocks.length, 1, "only <PubmedArticle> matches — the book is not an article");
  assert.equal(parseArticle(blocks[0]).id, "pmid:41610285");
  assert.ok(!rest.includes(BOOK_TAG), "the tail is a fragment, not a dropped record");
});

test("a book record is COUNTABLE rather than silently absent", () => {
  // Three ids requested, two records returned, one of them a book: an id that
  // names a book chapter (GeneReviews, PMID 20301295) comes back as
  // <PubmedBookArticle> with no MedlineCitation at all, so the article parser
  // sees nothing and reports nothing. A caller reconciling requested against
  // returned has to be able to tell that apart from an id PubMed does not
  // hold, so the container tag is exported and the same buffer walker reads it.
  const books = takeBlocks(EFETCH_RESPONSE, BOOK_TAG).blocks;
  assert.equal(books.length, 1);
  assert.match(books[0], /<BookDocument>\s*<PMID[^>]*>20301295<\/PMID>/);
  assert.equal(parseArticle(books[0]), null, "there is no MedlineCitation PMID to take");
  assert.deepEqual(takeBlocks(ARTICLE, BOOK_TAG).blocks, [], "an article is not a book");
});

test("takeBlocks does not grow the buffer without bound when there is no record", () => {
  const { blocks, rest } = takeBlocks("x".repeat(5_000_000));
  assert.equal(blocks.length, 0);
  assert.ok(rest.length <= `<${ARTICLE_TAG}>`.length);
});

test("deletedPmids finds withdrawn citations in an update file", () => {
  const xml = `<PubmedArticleSet>${ARTICLE}<DeleteCitation><PMID Version="1">33333333</PMID><PMID Version="1">44444444</PMID></DeleteCitation></PubmedArticleSet>`;
  assert.deepEqual(deletedPmids(xml), ["33333333", "44444444"]);
  assert.deepEqual(deletedPmids(ARTICLE), []);
});

test("keepRecord states WHY it dropped a record", () => {
  const rec = parseArticle(ARTICLE);
  // The fixture's abstract is deliberately under the production floor, so the
  // default filter must reject it and say so.
  assert.ok(rec.abstract.length < MIN_ABSTRACT_CHARS);
  assert.deepEqual(keepRecord(rec), { keep: false, reason: "short_abstract" });
  assert.deepEqual(keepRecord(rec, { minAbstract: 10 }), { keep: true, reason: "" });
  assert.equal(keepRecord(null).reason, "no_pmid");
  assert.equal(keepRecord({ ...rec, title: "" }, { minAbstract: 10 }).reason, "no_title");
  assert.equal(keepRecord(rec, { minAbstract: 10, minYear: 2027 }).reason, "before_min_year");
  assert.equal(keepRecord(rec, { minAbstract: 10, languages: ["swe"] }).reason, "language");
  assert.equal(keepRecord(rec, { minAbstract: 10, languages: ["eng"] }).keep, true);
});

test("the passage seam is shared with the arXiv corpus", () => {
  const rec = parseArticle(ARTICLE);
  const passage = buildPassage(rec, "title_abstract");
  assert.ok(passage.startsWith("Ancient DNA from a Neolithic site"));
  assert.ok(passage.includes("BACKGROUND: Sequencing"));
  // Both corpora are embedded by the same model into the same index shape, so
  // the 512-token char budget must come from one place, not two.
  assert.ok(buildPassage({ title: "t", abstract: "x".repeat(5000) }, "title_abstract").length <= 1200);
});

test("vectorMetadata cuts to what the reranker and the answer read", () => {
  const meta = vectorMetadata({ title: "T".repeat(500), abstract: "A".repeat(3000), authors: Array.from({ length: 20 }, (_, i) => `Au${i}`), journal: "J", date: "2026-02-07" });
  assert.equal(meta.t.length, 300);
  assert.equal(meta.a.length, 900);
  assert.ok(meta.au.length <= 300);
  assert.equal(meta.d, "2026-02-07");
});

test("pubmedUrl builds the canonical citation link", () => {
  assert.equal(pubmedUrl("41610285"), "https://pubmed.ncbi.nlm.nih.gov/41610285/");
  assert.equal(pubmedUrl("pmid:41610285"), "https://pubmed.ncbi.nlm.nih.gov/41610285/");
});

// A cut-down copy of the real https://ftp.ncbi.nlm.nih.gov/pubmed/baseline/
// listing, whose columns are name / date / human-readable size.
const LISTING = `<pre><a href="README.txt">README.txt</a>               2026-01-30 09:54  4.5K
<a href="pubmed26n0001.xml.gz">pubmed26n0001.xml.gz</a>     2026-01-29 14:48   19M
<a href="pubmed26n0001.xml.gz.md5">pubmed26n0001.xml.gz.md5</a> 2026-01-29 14:48   64
<a href="pubmed26n1334.xml.gz">pubmed26n1334.xml.gz</a>     2026-01-29 16:14   13M
</pre>`;

test("parseListing reads the file table and ignores the checksums", () => {
  const files = parseListing(LISTING, "baseline");
  assert.deepEqual(files.map((f) => f.n), [1, 1334]);
  assert.equal(files[0].bytes, 19_000_000);
  assert.equal(files[1].kind, "baseline");
  assert.equal(parseListing("", "updates").length, 0);
});

test("planHarvest runs NEWEST FIRST and honours the caps", () => {
  const files = [
    ...parseListing(LISTING, "baseline"),
    { name: "pubmed26n1500.xml.gz", n: 1500, kind: "updates", bytes: 40e6 },
  ];
  const plan = planHarvest(files, { maxFiles: 2 });
  assert.deepEqual(plan.files.map((f) => f.n), [1500, 1334]);
  assert.equal(plan.estRecords, 2 * RECORDS_PER_FILE);

  // A record cap stops at the first file that reaches it, so the estimate is
  // decidable before a byte is fetched.
  assert.deepEqual(planHarvest(files, { maxRecords: 1 }).files.map((f) => f.n), [1500]);
  assert.deepEqual(planHarvest(files, { minFile: 1400 }).files.map((f) => f.n), [1500]);
});

test("planHarvest skips what a previous run already finished", () => {
  const files = parseListing(LISTING, "baseline");
  const plan = planHarvest(files, { done: new Set(["pubmed26n1334.xml.gz"]) });
  assert.deepEqual(plan.files.map((f) => f.n), [1]);
  assert.equal(plan.skipped, 1);
});

test("windowNote names the fetch axis, and says min-year does not define one", () => {
  const plan = planHarvest(parseListing(LISTING, "baseline"), {});
  assert.match(windowNote(plan), /files n0001…n1334 \(a PMID\/load-order window, newest first\)/);
  // The arXiv build lost 48% and then 26.5% of a window to exactly this
  // confusion, so the harvester says it out loud on every run.
  assert.match(windowNote(plan, { minYear: 2024 }), /TRIMS this window, it does not define one/);
});

test("a passage never ends on a lone surrogate, whatever the abstract holds", () => {
  // Regression, PMID 41993351 (2026-07-31): its abstract puts a mathematical
  // bold character on the 1200-char boundary, so the plain `.slice()` that
  // buildPassage used left a lone high surrogate. Berget's tokenizer rejects
  // that batch with a 400 that is NOT a length error, so no shrink retry can
  // clear it — the loader crash-looped on the same batch at 96% of the fill.
  const astral = "\u{1D465}"; // MATHEMATICAL ITALIC SMALL X, a surrogate pair
  for (let pad = 1190; pad <= 1205; pad++) {
    const passage = buildPassage({ title: "T", abstract: "a".repeat(pad) + astral.repeat(6) }, "title_abstract");
    const last = passage.charCodeAt(passage.length - 1);
    assert.ok(!(last >= 0xd800 && last <= 0xdbff), `pad ${pad} left a lone high surrogate`);
    // And the whole string must be well-formed, not merely well-terminated.
    assert.equal(passage, passage.toWellFormed ? passage.toWellFormed() : passage, `pad ${pad} left an unpaired surrogate`);
  }
});
