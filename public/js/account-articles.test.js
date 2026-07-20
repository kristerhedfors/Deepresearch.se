// Node tests for the admin article-collection view (account-articles.js):
// the data contract the panel renders from, and the pure HTML builder.
// loadArticlesView (DOM wiring) is exercised live like the other panel
// views — only the pure parts are tested here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ARTICLES, renderArticles } from "./account-articles.js";

test("the collection holds the article series, numbered in order", () => {
  assert.equal(ARTICLES.length, 10);
  ARTICLES.forEach((a, i) => assert.equal(a.n, i + 1, `article ${i + 1} is numbered ${a.n}`));
});

test("every article has a non-empty title and a multi-paragraph body (the intent)", () => {
  for (const a of ARTICLES) {
    assert.ok(a.title.trim().length > 10, `article ${a.n} title`);
    // Each abstract was written as several <p> paragraphs — a body collapsing
    // to one paragraph means content was lost in an edit.
    const paragraphs = (a.body.match(/<p>/g) || []).length;
    assert.ok(paragraphs >= 2, `article ${a.n} has ${paragraphs} paragraph(s)`);
    assert.equal(paragraphs, (a.body.match(/<\/p>/g) || []).length, `article ${a.n} balanced <p> tags`);
  }
});

test("the written full articles are attached and substantial", () => {
  // The three drafts written so far (docs/linkedin/) attach their full text as
  // `article`; the rest are intent-only until written.
  const withArticle = ARTICLES.filter((a) => a.article);
  assert.deepEqual(
    withArticle.map((a) => a.n).sort((x, y) => x - y),
    [1, 6, 10],
    "intro (n:1), zero-deps (n:6) and workspaces (n:10) carry full articles",
  );
  for (const a of withArticle) {
    // A full article is longer than its abstract and multi-section.
    assert.ok(a.article.length > a.body.length, `article ${a.n} full text longer than abstract`);
    const opens = (a.article.match(/<p[ >]/g) || []).length;
    const closes = (a.article.match(/<\/p>/g) || []).length;
    assert.equal(opens, closes, `article ${a.n} full text balanced <p> tags`);
    assert.ok((a.article.match(/<h4>/g) || []).length >= 3, `article ${a.n} full text has section headings`);
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
  // The full-text block appears exactly for the articles that have one.
  assert.equal((html.match(/class="article-full"/g) || []).length, ARTICLES.filter((a) => a.article).length);
  assert.match(html, /article-pending/); // intent-only entries show the pending note
});

test("branding: the tier short names keep the slashed-tail bold form", () => {
  // The branding rule (docs/BRANDING.md): when the pair is written out in
  // running copy the wordplay tail is bold — DeepResearch.<b>Se/cure</b>.
  // Check across BOTH the abstracts and the full articles.
  const all = ARTICLES.map((a) => `${a.body}${a.article || ""}`).join("");
  assert.ok(all.includes("DeepResearch.<b>Se/cure</b>"));
  assert.ok(all.includes("DeepResearch.<b>Se/rver</b>"));
  // The internal acronyms must never appear in user-facing copy.
  assert.ok(!/\bDRC\b|\bDRS\b/.test(all), "no internal DRC/DRS acronyms in copy");
});
