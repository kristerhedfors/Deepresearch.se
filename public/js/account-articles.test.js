// Node tests for the admin article-collection view (account-articles.js):
// the data contract the panel renders from, and the pure HTML builder.
// loadArticlesView (DOM wiring) is exercised live like the other panel
// views — only the pure parts are tested here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ARTICLES, renderArticles } from "./account-articles.js";

test("the collection holds the full nine-article series, in order", () => {
  assert.equal(ARTICLES.length, 9);
  ARTICLES.forEach((a, i) => assert.equal(a.n, i + 1, `article ${i + 1} is numbered ${a.n}`));
});

test("every article has a non-empty title and a multi-paragraph body", () => {
  for (const a of ARTICLES) {
    assert.ok(a.title.trim().length > 10, `article ${a.n} title`);
    // Each abstract was written as several <p> paragraphs — a body collapsing
    // to one paragraph means content was lost in an edit.
    const paragraphs = (a.body.match(/<p>/g) || []).length;
    assert.ok(paragraphs >= 2, `article ${a.n} has ${paragraphs} paragraph(s)`);
    assert.equal(paragraphs, (a.body.match(/<\/p>/g) || []).length, `article ${a.n} balanced <p> tags`);
  }
});

test("titles are unique", () => {
  assert.equal(new Set(ARTICLES.map((a) => a.title)).size, ARTICLES.length);
});

test("renderArticles builds the full view: back button, heading, one details block per article", () => {
  const html = renderArticles();
  assert.match(html, /id="articlesbackbtn"/);
  assert.match(html, /Article collection/);
  assert.equal((html.match(/<details class="article-item">/g) || []).length, ARTICLES.length);
  for (const a of ARTICLES) assert.ok(html.includes(a.title), `rendered view includes article ${a.n}`);
});

test("branding: the tier short names keep the slashed-tail bold form", () => {
  // The branding rule (docs/BRANDING.md): when the pair is written out in
  // running copy the wordplay tail is bold — DeepResearch.<b>Se/cure</b>.
  const all = ARTICLES.map((a) => a.body).join("");
  assert.ok(all.includes("DeepResearch.<b>Se/cure</b>"));
  assert.ok(all.includes("DeepResearch.<b>Se/rver</b>"));
  // The internal acronyms must never appear in user-facing copy.
  assert.ok(!/\bDRC\b|\bDRS\b/.test(all), "no internal DRC/DRS acronyms in copy");
});
