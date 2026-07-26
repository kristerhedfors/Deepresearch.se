import assert from "node:assert/strict";
import test from "node:test";

import { fullTextChunks, fullTextPassage, latexSections } from "../public/js/arxiv-rag-core.js";

// The network and embedding halves of scripts/arxiv-fulltext.mjs are covered by
// the live CLI; what is worth pinning here is the LaTeX ASSEMBLY rule, because
// getting it wrong silently throws away most of a paper — 2606.00096 shipped
// 100 KB of .tex and yielded 89 characters before this was fixed.

/**
 * The assembly rule from fetchLatex, extracted so it can be tested without a
 * network fetch: pick the richest real document body, then append every
 * fragment that has no document of its own.
 * @param {string[]} texts
 */
function assemble(texts) {
  const body = (t) => {
    const m = /\\begin\{document\}([\s\S]*?)\\end\{document\}/.exec(t);
    return m ? m[1] : t;
  };
  const wrapped = texts.filter((t) => /\\begin\{document\}/.test(t));
  let fragments = texts.filter((t) => !/\\begin\{document\}/.test(t));
  const bodies = wrapped.map(body).sort((a, b) => b.length - a.length);
  let main = bodies[0];
  if (!main) {
    fragments = [...fragments].sort((a, b) => b.length - a.length);
    main = fragments.shift() || "";
  }
  return `\\begin{document}\n${main}\n${fragments.join("\n")}\n\\end{document}`;
}

const SECTION = (name, n) => `\\section{${name}}\n${`Sentence ${name} number one carries real content. `.repeat(n)}`;

test("a thin wrapper plus \\input fragments keeps the fragments' prose", () => {
  // The failure mode: the wrapper's own \begin{document} is three lines long,
  // and a naive concatenate-then-match throws the actual paper away.
  const wrapper = `\\documentclass{article}\n\\begin{document}\n\\input{intro}\n\\input{method}\n\\end{document}`;
  const intro = SECTION("Introduction", 6);
  const method = SECTION("Method", 8);
  const secs = latexSections(assemble([wrapper, intro, method]));
  assert.deepEqual(secs.map((s) => s.heading), ["Introduction", "Method"]);
  assert.ok(secs[1].text.includes("Sentence Method"));
});

test("a single self-contained document is passed through unharmed", () => {
  const solo = `\\documentclass{article}\n\\begin{document}\n${SECTION("Results", 10)}\\end{document}`;
  const secs = latexSections(assemble([solo]));
  assert.deepEqual(secs.map((s) => s.heading), ["Results"]);
  assert.ok(secs[0].text.length > 300);
});

test("the richest body wins when several files carry a document", () => {
  // Supplementary material ships its own \begin{document}; the paper is the
  // one with the substance, not whichever file was read first.
  const supplement = `\\begin{document}\n${SECTION("Supplement", 1)}\\end{document}`;
  const paper = `\\begin{document}\n${SECTION("Main Results", 20)}\\end{document}`;
  const secs = latexSections(assemble([supplement, paper]));
  assert.equal(secs[0].heading, "Main Results");
});

test("a bare fragment with no document at all is indexed exactly once", () => {
  // The promoted fragment must leave the fragment list, or the whole paper is
  // emitted twice and every chunk of it is duplicated.
  const secs = latexSections(assemble([SECTION("Discussion", 5)]));
  assert.deepEqual(secs.map((s) => s.heading), ["Discussion"]);
  const two = latexSections(assemble([SECTION("Discussion", 5), SECTION("Appendix", 4)]));
  assert.deepEqual(two.map((s) => s.heading), ["Discussion", "Appendix"]);
});

test("assembled papers chunk into embeddable passages that carry their heading", () => {
  const wrapper = `\\begin{document}\\input{a}\\end{document}`;
  const chunks = fullTextChunks(assemble([wrapper, SECTION("Method", 40)]));
  assert.ok(chunks.length >= 2, `expected several chunks, got ${chunks.length}`);
  assert.ok(chunks.every((c) => c.heading === "Method"));
  assert.ok(fullTextPassage(chunks[0]).startsWith("Method — "));
});
