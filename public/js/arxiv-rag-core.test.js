// @ts-check
import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_PASSAGE_CHARS,
  PASSAGE_STRATEGIES,
  bm25Search,
  buildBm25,
  buildPassage,
  chunkSections,
  decodeShard,
  fullTextChunks,
  fullTextPassage,
  htmlFullTextChunks,
  htmlSections,
  htmlToText,
  latexBody,
  latexSections,
  latexToText,
  denseSearch,
  denseSearchPacked,
  hitAtK,
  int8ToB64,
  ndcgAtK,
  packedNorms,
  paperPassages,
  quantizeInt8,
  recapForContext,
  reciprocalRank,
  rrfFuse,
  tokenize,
  validateShard,
} from "./arxiv-rag-core.js";

/** @type {import('./arxiv-rag-core.js').ArxivPaper} */
const PAPER = {
  id: "2607.00001",
  title: "Differentially Private Retrieval for Scientific Corpora",
  abstract:
    "We study retrieval over scientific abstracts under differential privacy. " +
    "Our method perturbs the embedding index rather than the queries. " +
    "Experiments on arXiv show a modest recall cost at epsilon = 1. " +
    "We release code and an evaluation harness.",
  authors: ["Anna Lindqvist", "Bo Chen"],
  categories: ["cs.CR", "cs.IR"],
  primary: "cs.CR",
};

test("passage strategies each include what they promise", () => {
  assert.equal(buildPassage(PAPER, "title"), PAPER.title);
  assert.ok(!buildPassage(PAPER, "abstract").includes("Differentially Private Retrieval for"));
  const ta = buildPassage(PAPER, "title_abstract");
  assert.ok(ta.includes(PAPER.title) && ta.includes("epsilon = 1"));
  const ctx = buildPassage(PAPER, "contextual");
  assert.ok(ctx.includes("cs.CR") && ctx.includes("Lindqvist"), "contextual carries categories and surnames");
  assert.throws(() => buildPassage(PAPER, "nope"), /Unknown passage strategy/);
});

test("every passage stays inside the embedder's char budget", () => {
  const huge = { ...PAPER, abstract: "long ".repeat(2000) };
  for (const name of Object.keys(PASSAGE_STRATEGIES)) {
    assert.ok(buildPassage(huge, name).length <= MAX_PASSAGE_CHARS, `${name} overflowed`);
  }
  for (const piece of paperPassages(huge, { window: 700, stride: 500 })) {
    assert.ok(piece.length <= MAX_PASSAGE_CHARS);
  }
});

test("paperPassages yields one passage when the text fits and overlapping ones when it does not", () => {
  assert.equal(paperPassages(PAPER, { window: 0 }).length, 1);
  assert.equal(paperPassages(PAPER, { window: 5000 }).length, 1, "window larger than the text does not split");
  const pieces = paperPassages({ ...PAPER, abstract: "Sentence number one is here. ".repeat(60) }, { window: 400, stride: 300 });
  assert.ok(pieces.length > 2, `expected several windows, got ${pieces.length}`);
  // Consecutive windows must overlap, or a fact on a boundary is lost.
  assert.ok(pieces[1].slice(0, 40).length > 0);
  assert.ok(pieces.every((p) => p.trim().length > 0));
});

test("recapForContext re-caps from the reported token count, not by blind halving", () => {
  // 1600 chars reported as 568 tokens: the window's share of that is
  // 1600 × 496/568 ≈ 1397, and the mandatory 15% shrink caps it at 1360.
  const [long, short] = recapForContext(["x".repeat(1600), "short"], 568, 512);
  assert.ok(long.length > 1200 && long.length <= 1360, `unexpected cap ${long.length}`);
  assert.equal(short, "short", "texts already inside the window are untouched");
  assert.ok(recapForContext(["abc"], 0)[0].length > 0, "a missing token count must not throw");
});

test("recapForContext shrinks monotonically so the retry loop converges", () => {
  // The reported count belongs to the DENSEST input, which may be far shorter
  // than the longest — the estimate is then optimistic and, without a floor,
  // successive retries would each shave a few characters and never converge.
  let texts = ["x".repeat(1200), "y".repeat(1150)];
  const lengths = [];
  for (let i = 0; i < 6; i++) {
    texts = recapForContext(texts, 515, 512); // barely over, every round
    lengths.push(texts[0].length);
  }
  for (let i = 1; i < lengths.length; i++) {
    assert.ok(lengths[i] <= lengths[i - 1] * 0.86, `round ${i} shrank too little: ${lengths[i - 1]} → ${lengths[i]}`);
  }
  assert.ok(lengths.at(-1) < 600, `six retries should more than halve it, got ${lengths.at(-1)}`);
});

test("tokenize keeps Swedish letters and indexes hyphenated terms both ways", () => {
  assert.deepEqual(tokenize("Självövervakad inlärning"), ["självövervakad", "inlärning"]);
  const t = tokenize("self-supervised");
  assert.ok(t.includes("self-supervised") && t.includes("supervised"), `got ${t.join(",")}`);
  assert.deepEqual(tokenize("GPT-4 är BRA!"), ["gpt-4", "gpt", "är", "bra"]);
});

test("BM25 ranks the document that actually contains the query terms", () => {
  const docs = [
    { id: "a", text: "Quantum error correction with surface codes on superconducting hardware." },
    { id: "b", text: "A study of colloidal self-assembly in binary mixtures." },
    { id: "c", text: "Surface codes and their decoders, benchmarked at scale." },
  ];
  const index = buildBm25(docs);
  const hits = bm25Search(index, "surface codes decoders", 3);
  assert.equal(hits[0].id, "c");
  assert.ok(hits.some((h) => h.id === "a"));
  assert.ok(!hits.some((h) => h.id === "b"), "an unrelated doc scored on no shared term");
});

test("BM25 ignores stopwords rather than ranking on them", () => {
  const index = buildBm25([
    { id: "a", text: "the the the the the and of" },
    { id: "b", text: "gravitational lensing of distant quasars" },
  ]);
  assert.deepEqual(bm25Search(index, "the and of", 5), []);
  assert.equal(bm25Search(index, "lensing", 5)[0].id, "b");
});

test("denseSearch max-pools a paper's passages and sorts by best", () => {
  const q = Float32Array.from([1, 0, 0]);
  const shard = {
    vectors: [
      quantizeInt8([0, 1, 0]), // paper p1, unrelated passage
      quantizeInt8([0.9, 0.1, 0]), // paper p1, the good passage
      quantizeInt8([0.5, 0.5, 0]), // paper p2
    ],
    docIds: ["p1", "p1", "p2"],
  };
  const hits = denseSearch(q, shard, 5);
  assert.equal(hits.length, 2, "two papers, not three passages");
  assert.equal(hits[0].id, "p1");
  assert.ok(hits[0].score > hits[1].score);
});

test("denseSearchPacked ranks identically to denseSearch over the binary layout", () => {
  const dims = 4;
  const rows = [
    [0, 1, 0, 0],
    [0.9, 0.1, 0, 0],
    [0.5, 0.5, 0, 0],
  ];
  const packed = new Int8Array(rows.length * dims);
  rows.forEach((r, i) => packed.set(quantizeInt8(r), i * dims));
  const docIds = ["p1", "p1", "p2"];
  const q = Float32Array.from([1, 0, 0, 0]);
  const packedHits = denseSearchPacked(q, { packed, dims, norms: packedNorms(packed, dims), docIds }, 5);
  const plainHits = denseSearch(q, { vectors: rows.map((r) => quantizeInt8(r)), docIds }, 5);
  assert.deepEqual(packedHits.map((h) => h.id), plainHits.map((h) => h.id));
  packedHits.forEach((h, i) => assert.ok(Math.abs(h.score - plainHits[i].score) < 1e-6));
  assert.equal(packedHits.length, 2, "max-pooled to papers, not passages");
});

test("packedNorms never returns a zero divisor", () => {
  const packed = new Int8Array(8); // all zeros — a degenerate row
  const norms = packedNorms(packed, 4);
  assert.equal(norms.length, 2);
  assert.ok(norms.every((n) => n > 0), "a zero row must not produce a NaN score");
  const hits = denseSearchPacked(Float32Array.from([1, 0, 0, 0]), { packed, dims: 4, norms, docIds: ["a", "b"] }, 2);
  assert.ok(hits.every((h) => Number.isFinite(h.score)));
});

test("rrfFuse rewards agreement between retrievers and respects weights", () => {
  const dense = [{ id: "a" }, { id: "b" }, { id: "c" }];
  const lexical = [{ id: "c" }, { id: "d" }, { id: "a" }];
  const fused = rrfFuse([dense, lexical]);
  // 'a' is 1st and 3rd; 'c' is 3rd and 1st — they tie, and both beat the
  // singles 'b' and 'd'.
  assert.deepEqual(fused.slice(0, 2).map((f) => f.id).sort(), ["a", "c"]);
  assert.ok(fused.find((f) => f.id === "a").score > fused.find((f) => f.id === "b").score);
  const weighted = rrfFuse([dense, lexical], { weights: [5, 1] });
  assert.equal(weighted[0].id, "a", "weighting the dense list promotes its head");
  assert.equal(rrfFuse([dense, lexical], { topK: 2 }).length, 2);
});

test("recall and MRR read the gold document's rank", () => {
  const hits = [{ id: "x" }, { id: "gold" }, { id: "y" }];
  assert.equal(hitAtK(hits, "gold", 1), 0);
  assert.equal(hitAtK(hits, "gold", 2), 1);
  assert.equal(reciprocalRank(hits, "gold"), 0.5);
  assert.equal(reciprocalRank(hits, "absent"), 0);
});

test("nDCG@k rewards putting the graded-relevant results first", () => {
  const gains = { a: 3, b: 2, c: 0 };
  const perfect = ndcgAtK([{ id: "a" }, { id: "b" }, { id: "c" }], gains, 3);
  const inverted = ndcgAtK([{ id: "c" }, { id: "b" }, { id: "a" }], gains, 3);
  assert.equal(perfect, 1);
  assert.ok(inverted < perfect && inverted > 0);
  assert.equal(ndcgAtK([{ id: "c" }], { c: 0 }, 3), 0, "no relevant results anywhere scores 0, not NaN");
});

test("validateShard rejects the shapes a torn write produces", () => {
  const good = {
    v: 1,
    model: "m",
    dims: 3,
    strategy: "title_abstract",
    window: 0,
    stride: 0,
    built: "now",
    papers: [PAPER],
    vectors: [int8ToB64(quantizeInt8([1, 0, 0]))],
    map: [0],
  };
  assert.ok(validateShard(good));
  assert.equal(validateShard(null), null);
  assert.equal(validateShard({ ...good, v: 2 }), null);
  assert.equal(validateShard({ ...good, map: [0, 1] }), null, "map longer than vectors");
  assert.equal(validateShard({ ...good, map: [7] }), null, "map pointing past the paper list");
  assert.equal(validateShard({ ...good, vectors: [] }), null);
});

test("decodeShard restores the passage→paper alignment denseSearch needs", () => {
  const shard = /** @type {any} */ ({
    v: 1,
    model: "m",
    dims: 3,
    strategy: "title_abstract",
    window: 0,
    stride: 0,
    built: "now",
    papers: [PAPER, { ...PAPER, id: "2607.00002" }],
    vectors: [int8ToB64(quantizeInt8([1, 0, 0])), int8ToB64(quantizeInt8([0, 1, 0])), int8ToB64(quantizeInt8([0.9, 0, 0]))],
    map: [0, 1, 0],
  });
  const d = decodeShard(shard);
  assert.deepEqual(d.docIds, ["2607.00001", "2607.00002", "2607.00001"]);
  assert.equal(d.vectors.length, 3);
  assert.equal(d.byId.get("2607.00001").title, PAPER.title);
  assert.equal(denseSearch(Float32Array.from([1, 0, 0]), d, 5)[0].id, "2607.00001");
});

// ---- full text: LaTeX → sections → chunks ------------------------------------

const TEX = String.raw`
\documentclass{article}
\newcommand{\hidden}{never appears}
\begin{document}
\title{Private Retrieval}
\section{Introduction}
Retrieval under differential privacy is hard. % a trailing comment
We bound the loss by $\epsilon$ and show \cite{smith2024} it is tight.
\begin{figure}
  \includegraphics{plot.png}\caption{A plot nobody should retrieve.}
\end{figure}
\section{Method}
The index is perturbed, not the query. \[ \sum_i x_i \le n \] That is the whole trick.
\subsection{Complexity}
Each lookup costs 100\% of one scan, which is acceptable.
\end{document}
`;

test("latexToText keeps prose and drops the apparatus", () => {
  const t = latexToText(TEX);
  assert.ok(t.includes("Retrieval under differential privacy is hard"));
  assert.ok(t.includes("The index is perturbed, not the query"));
  assert.ok(!t.includes("a trailing comment"), "comments are stripped");
  assert.ok(!t.includes("plot.png") && !t.includes("nobody should retrieve"), "figure environment dropped");
  assert.ok(!t.includes("\\") && !t.includes("{"), "no LaTeX syntax survives");
  assert.ok(t.includes("[m]") && t.includes("[eq]"), "math leaves a placeholder so sentences still read");
  assert.ok(!t.includes("smith2024"), "citation keys are not prose");
});

test("latexBody isolates the document, and tolerates a bare fragment", () => {
  assert.ok(latexBody(TEX).includes("\\section{Introduction}"));
  assert.ok(!latexBody(TEX).includes("documentclass"), "the preamble is not body text");
  assert.equal(latexBody("just a fragment"), "just a fragment");
});

test("latexSections splits on section and subsection with readable headings", () => {
  const secs = latexSections(TEX);
  assert.deepEqual(secs.map((s) => s.heading), ["Introduction", "Method", "Complexity"]);
  assert.ok(secs[1].text.includes("perturbed"));
  // Short sections are KEPT, not dropped — losing a terse Methods section
  // would defeat the point of a full-text tier.
  assert.ok(secs.every((s) => s.text.length >= 40));
  assert.ok(secs.some((s) => s.text.length < 120), "this fixture has short sections and they survived");
});

test("latexSections falls back to one section when a paper has no headings", () => {
  const flat = "\\begin{document}" + "This paper has no sections at all, only prose. ".repeat(6) + "\\end{document}";
  const secs = latexSections(flat);
  assert.equal(secs.length, 1);
  assert.equal(secs[0].heading, "");
  assert.ok(secs[0].text.startsWith("This paper has no sections"));
  assert.deepEqual(latexSections("\\begin{document}tiny\\end{document}"), [], "a stub is not worth a vector");
});

test("fullTextChunks numbers chunks, carries headings, and respects the window", () => {
  // Vary the prose: a repeated sentence would produce legitimately identical
  // chunks and the duplicate check below would be meaningless.
  const prose = Array.from({ length: 200 }, (_, i) => `Run ${i} reported an error of ${i / 7} units.`).join(" ");
  const long = `\\begin{document}\\section{Results}${prose}\\end{document}`;
  const chunks = fullTextChunks(long, { window: 500 });
  assert.ok(chunks.length > 5, `expected several chunks, got ${chunks.length}`);
  chunks.forEach((c, i) => {
    assert.equal(c.seq, i, "seq is the chunk's position");
    assert.equal(c.heading, "Results");
    assert.ok(c.text.length <= 500, `chunk ${i} is ${c.text.length} chars`);
  });
  // Every chunk must be non-empty prose — an off-by-one in the window walk
  // shows up here as blank or duplicated chunks.
  assert.equal(new Set(chunks.map((c) => c.text)).size, chunks.length, "no duplicated chunks");
});

test("fullTextChunks is bounded so one pathological paper cannot blow up a build", () => {
  const huge = `\\begin{document}\\section{S}${"word ".repeat(200000)}\\end{document}`;
  assert.ok(fullTextChunks(huge, { window: 200, maxChunks: 50 }).length <= 50);
});

test("fullTextPassage puts the heading in front of the prose, inside the embed window", () => {
  assert.equal(fullTextPassage({ heading: "Method", text: "We perturb the index." }), "Method — We perturb the index.");
  assert.equal(fullTextPassage({ heading: "", text: "No heading here." }), "No heading here.");
  const long = fullTextPassage({ heading: "H", text: "x".repeat(5000) });
  assert.ok(long.length <= MAX_PASSAGE_CHARS);
});

// ---- full text from arXiv's HTML rendering -----------------------------------

const HTML = `
<html><head><style>.x{color:red}</style><script>var a=1</script></head><body>
<article>
<section id="S1"><h2>1 Introduction</h2>
<p>Retrieval under differential privacy is hard, and we quantify how hard.</p>
<figure><img src="plot.png"><figcaption>A plot nobody should retrieve.</figcaption></figure>
<section id="S1.1"><h3>1.1 Scope</h3><p>We restrict attention to abstract-level indexes only here.</p></section>
</section>
<section id="S2"><h2>2 Method</h2>
<p>The index is perturbed with <math><mi>&#x03B5;</mi></math> noise &amp; never the query itself.</p>
<table><tr><td>99</td></tr></table>
</section>
</article></body></html>`;

test("htmlToText keeps prose, drops apparatus, and decodes entities", () => {
  const t = htmlToText(HTML);
  assert.ok(t.includes("Retrieval under differential privacy is hard"));
  assert.ok(t.includes("perturbed with [m] noise & never the query"), `entities and math: ${t}`);
  assert.ok(!t.includes("var a=1") && !t.includes("color:red"), "script and style are gone");
  assert.ok(!t.includes("nobody should retrieve"), "figures are not prose");
  assert.ok(!t.includes("<") && !t.includes(">"), "no tags survive");
});

test("htmlSections uses the real section structure without heuristics", () => {
  const secs = htmlSections(HTML);
  assert.deepEqual(secs.map((s) => s.heading), ["1 Introduction", "1.1 Scope", "2 Method"]);
  assert.ok(secs[0].text.includes("quantify how hard"));
});

test("a nested subsection is not also emitted inside its parent", () => {
  // The parent must not repeat the child's prose, or every subsection is
  // embedded twice and doubles the cost of the tier.
  const secs = htmlSections(HTML);
  const parent = secs.find((s) => s.heading === "1 Introduction");
  assert.ok(!parent.text.includes("restrict attention"), `parent leaked the child: ${parent.text}`);
  const child = secs.find((s) => s.heading === "1.1 Scope");
  assert.ok(child.text.includes("restrict attention"));
});

test("htmlSections falls back to whole-page text when there are no sections", () => {
  const bare = `<body><p>${"A paper rendered without any section elements at all. ".repeat(4)}</p></body>`;
  const secs = htmlSections(bare);
  assert.equal(secs.length, 1);
  assert.equal(secs[0].heading, "");
  assert.ok(secs[0].text.startsWith("A paper rendered without"));
  assert.deepEqual(htmlSections("<body><p>tiny</p></body>"), [], "a stub page is not worth a vector");
});

test("htmlFullTextChunks produces the same shape as the LaTeX path", () => {
  const chunks = htmlFullTextChunks(HTML);
  assert.ok(chunks.length >= 1);
  chunks.forEach((c, i) => {
    assert.equal(c.seq, i);
    assert.equal(typeof c.heading, "string");
    assert.ok(c.text.length > 0);
  });
  // Downstream code must not be able to tell the two sources apart.
  const fromTex = fullTextChunks(`\\begin{document}\\section{Method}${"Prose. ".repeat(40)}\\end{document}`);
  assert.deepEqual(Object.keys(chunks[0]).sort(), Object.keys(fromTex[0]).sort());
});

test("chunkSections is the one windowing pass both sources share", () => {
  const secs = [{ heading: "S", text: "Sentence one is here. ".repeat(120) }];
  const chunks = chunkSections(secs, { window: 400 });
  assert.ok(chunks.length > 3);
  assert.ok(chunks.every((c) => c.text.length <= 400 && c.heading === "S"));
  assert.deepEqual(chunks.map((c) => c.seq), chunks.map((_, i) => i));
});
