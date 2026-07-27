// Unit tests for the LaTeXML DOM extractor (scripts/arxiv-html.mjs).
//
// The fixtures below are trimmed but structurally faithful to arXiv's HTML
// rendering: real class names, real nesting, real `<math alttext>`. What is
// pinned is what the measurement over 9 live papers (2026-07-26) identified as
// the reasons to use a DOM at all — mathematics surviving, the bibliography
// being dropped, and the nesting handled structurally.
import test from "node:test";
import assert from "node:assert/strict";

import { htmlSectionsDom, htmlTitleAbstract, isLatexmlHtml } from "./arxiv-html.mjs";

const PAPER = `<!DOCTYPE html><html><body><article class="ltx_document">
  <div class="ltx_abstract"><h6 class="ltx_title">Abstract</h6>
    <p class="ltx_p">We study whether more agents reason better than one, and find the gains saturate.</p></div>
  <section class="ltx_section" id="S1"><h2 class="ltx_title ltx_title_section">1 Introduction</h2>
    <div class="ltx_para"><p class="ltx_p">Multi-agent systems are widely assumed to improve reasoning quality overall.</p></div>
    <section class="ltx_subsection" id="S1.SS1"><h3 class="ltx_title">1.1 Setup</h3>
      <div class="ltx_para"><p class="ltx_p">We train with a batch size of 256 and a cosine schedule throughout.</p></div>
    </section>
  </section>
  <section class="ltx_section" id="S2"><h2 class="ltx_title ltx_title_section">2 Method</h2>
    <div class="ltx_para"><p class="ltx_p">The loss is
      <math alttext="\\mathcal{L} = -\\sum_i y_i \\log p_i" display="inline"><semantics><mrow/></semantics></math>
      over all tokens in the sequence.</p></div>
  </section>
  <section class="ltx_appendix" id="A1"><h2 class="ltx_title">Appendix A Extra results</h2>
    <div class="ltx_para"><p class="ltx_p">Additional ablations appear here, with per-seed variance reported.</p></div>
  </section>
  <section class="ltx_bibliography"><h2 class="ltx_title">References</h2>
    <ul class="ltx_biblist"><li class="ltx_bibitem">Shehata, D. and Li, M. The Bystander Effect in Multi-Agent Reasoning. 2026.</li>
    <li class="ltx_bibitem">Zhu, Y. et al. Swarm Intelligence Enhanced Reasoning. 2025.</li></ul>
  </section>
</article></body></html>`;

test("isLatexmlHtml recognises LaTeXML output", () => {
  assert.equal(isLatexmlHtml(PAPER), true);
  assert.equal(isLatexmlHtml("<html><body><p>a stub page</p></body></html>"), false);
  assert.equal(isLatexmlHtml(""), false);
  assert.equal(isLatexmlHtml(null), false);
});

test("htmlSectionsDom", async (t) => {
  const secs = htmlSectionsDom(PAPER);
  const byHeading = (re) => secs.find((s) => re.test(s.heading));

  await t.test("finds the abstract and every structural unit", () => {
    const headings = secs.map((s) => s.heading);
    assert.ok(headings.includes("Abstract"), headings.join(" | "));
    assert.ok(byHeading(/^1 Introduction/), "missing section");
    assert.ok(byHeading(/^1\.1 Setup/), "missing subsection");
    assert.ok(byHeading(/^2 Method/), "missing second section");
    // A first version selected only section/subsection/subsubsection and so
    // silently dropped appendices — it read as a regression on papers that
    // carry them.
    assert.ok(byHeading(/^Appendix A/), "missing appendix");
  });

  await t.test("keeps mathematics as the LaTeX in alttext", () => {
    // The regex core strips <math> entirely: math survived in 3 of 9 real
    // papers there vs 9 of 9 here. This is the main reason for the DOM.
    const method = byHeading(/^2 Method/);
    assert.match(method.text, /\\mathcal\{L\}/);
    assert.match(method.text, /\\log p_i/);
  });

  await t.test("drops the bibliography", () => {
    // A citation list indexed as prose yields chunks that can only match on
    // author surnames — 16% of the regex core's output across the sample.
    assert.equal(byHeading(/^References/), undefined);
    const all = secs.map((s) => s.text).join(" ");
    assert.ok(!all.includes("ltx_bibitem"));
    assert.ok(!/Shehata, D\. and Li, M\./.test(all), "bibliography text leaked into a section");
  });

  await t.test("a parent carries its OWN prose only — the nesting trap, structurally", () => {
    // LaTeXML nests subsections inside the parent <section>. The parent must
    // not swallow the child, and the child must still appear on its own.
    const intro = byHeading(/^1 Introduction/);
    const setup = byHeading(/^1\.1 Setup/);
    assert.match(intro.text, /widely assumed/);
    assert.ok(!/batch size of 256/.test(intro.text), "child prose leaked into the parent");
    assert.match(setup.text, /batch size of 256/);
  });

  await t.test("headings are not repeated inside their own text", () => {
    for (const s of secs) {
      if (s.heading) assert.ok(!s.text.startsWith(s.heading), `heading duplicated in text: ${s.heading}`);
    }
  });

  await t.test("never throws; unusable input yields nothing", () => {
    assert.deepEqual(htmlSectionsDom(""), []);
    assert.deepEqual(htmlSectionsDom("   "), []);
    assert.deepEqual(htmlSectionsDom(null), []);
    assert.deepEqual(htmlSectionsDom(undefined), []);
    assert.deepEqual(htmlSectionsDom(12345), []);
    // Non-LaTeXML markup simply has no units to find, so the caller falls back.
    assert.deepEqual(htmlSectionsDom("<html><body><p>hello</p></body></html>"), []);
  });

  await t.test("drops units too short to be prose", () => {
    const thin = `<article class="ltx_document"><section class="ltx_section">
      <h2 class="ltx_title">1 Tiny</h2><div class="ltx_para"><p class="ltx_p">Too short.</p></div>
    </section></article>`;
    assert.deepEqual(htmlSectionsDom(thin), []);
  });
});

test("htmlTitleAbstract supplies tier 1 from the same fetch as tier 2", async (t) => {
  const TITLED = PAPER.replace(
    '<article class="ltx_document">',
    '<article class="ltx_document"><h1 class="ltx_title ltx_title_document">The Bystander Effect in Multi-Agent Reasoning</h1><div class="ltx_authors"><span class="ltx_personname">Dahlia Shehata</span><span class="ltx_personname">Ming Li</span></div>',
  );

  await t.test("reads the document title and the abstract body", () => {
    // This is what makes the GCS route complete: that mirror enumerates every
    // id in seconds but its metadata dump is frozen at 2020, so recent
    // abstracts have to come from the rendering.
    const { title, abstract, authors } = htmlTitleAbstract(TITLED);
    assert.equal(title, "The Bystander Effect in Multi-Agent Reasoning");
    assert.match(abstract, /^We study whether more agents reason better/);
    // Authors feed the source registry's citable metadata line.
    assert.deepEqual(authors, ["Dahlia Shehata", "Ming Li"]);
  });

  await t.test("drops the literal word 'Abstract' from the abstract text", () => {
    assert.ok(!htmlTitleAbstract(TITLED).abstract.startsWith("Abstract"));
  });

  await t.test("never throws; missing pieces come back empty", () => {
    assert.deepEqual(htmlTitleAbstract(""), { title: "", abstract: "", authors: [] });
    assert.deepEqual(htmlTitleAbstract(null), { title: "", abstract: "", authors: [] });
    assert.deepEqual(htmlTitleAbstract("<html><body><p>stub</p></body></html>"), { title: "", abstract: "", authors: [] });
    // A paper with a title but no abstract section still yields the title.
    const noAbs = '<article class="ltx_document"><h1 class="ltx_title ltx_title_document">Only A Title</h1></article>';
    assert.deepEqual(htmlTitleAbstract(noAbs), { title: "Only A Title", abstract: "", authors: [] });
  });
});
