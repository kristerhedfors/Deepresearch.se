// Unit tests for the documentation reader's comment-mode core
// (public/js/docs-comments-core.js): the stored body grammar, quote
// anchoring, and reading the feedback queue back as one document's comments.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DOC_COMMENT_PREFIX,
  QUOTE_MAX,
  QUOTE_TRUNCATION,
  buildDocCommentBody,
  clipQuote,
  docCommentsFor,
  isCommentableSelection,
  locateQuote,
  normalizeQuote,
  parseDocCommentBody,
  railVisible,
} from "./docs-comments-core.js";

test("normalizeQuote collapses the whitespace a rendered selection carries", () => {
  assert.equal(normalizeQuote("  the   key\n  hierarchy\t is  "), "the key hierarchy is");
  assert.equal(normalizeQuote(null), "");
  assert.equal(normalizeQuote(42), "");
});

test("clipQuote marks the cut so a truncated quote never reads as the whole passage", () => {
  assert.equal(clipQuote("short passage"), "short passage");
  const long = "x".repeat(QUOTE_MAX + 200);
  const clipped = clipQuote(long);
  assert.equal(clipped.length, QUOTE_MAX);
  assert.ok(clipped.endsWith(QUOTE_TRUNCATION));
});

test("isCommentableSelection rejects the stray-click selection", () => {
  assert.equal(isCommentableSelection(""), false);
  assert.equal(isCommentableSelection("  \n "), false);
  assert.equal(isCommentableSelection("ab"), false);
  assert.equal(isCommentableSelection("the"), true);
});

test("buildDocCommentBody: the type is the first thing anyone reads", () => {
  const body = buildDocCommentBody({
    path: "docs/ENCRYPTION.md",
    section: "The key hierarchy",
    quote: "the history key is derived per user",
    note: "This is wrong — it is derived per device now. Fix the doc and the code.",
  });
  assert.ok(body.startsWith(`${DOC_COMMENT_PREFIX} — docs/ENCRYPTION.md\n`));
  assert.match(body, /^SECTION: The key hierarchy$/m);
  assert.match(body, /^> the history key is derived per user$/m);
  assert.ok(body.endsWith("Fix the doc and the code."));
});

test("buildDocCommentBody → parseDocCommentBody round-trips", () => {
  const c = {
    path: "docs/ARCHITECTURE.md",
    section: "15 · Feature surfaces",
    quote: "Orchestrator is a bespoke subsystem",
    note: "Should be an SDK module.\n\nSecond paragraph of the instruction.",
  };
  assert.deepEqual(parseDocCommentBody(buildDocCommentBody(c)), c);
});

test("parseDocCommentBody: a multi-line note survives, whitespace normalized around it", () => {
  const parsed = parseDocCommentBody(
    `${DOC_COMMENT_PREFIX} — README.md\nSECTION: Tests\nQUOTED:\n> npm test\n\nline one\nline two\n`,
  );
  assert.equal(parsed?.path, "README.md");
  assert.equal(parsed?.note, "line one\nline two");
});

test("parseDocCommentBody: a section-less, quote-less comment still parses", () => {
  const body = buildDocCommentBody({ path: "docs/TESTING.md", note: "whole-document remark" });
  const parsed = parseDocCommentBody(body);
  assert.deepEqual(parsed, { path: "docs/TESTING.md", section: "", quote: "", note: "whole-document remark" });
});

test("parseDocCommentBody: an ordinary feedback entry is not a doc comment", () => {
  assert.equal(parseDocCommentBody("feedback: the map view was cut off"), null);
  assert.equal(parseDocCommentBody(""), null);
  assert.equal(parseDocCommentBody(null), null);
});

// ---- anchoring -------------------------------------------------------------

const DOC = `# Encryption

## The key hierarchy

The history key is derived per user from the account secret,
then wrapped by the device key before it ever rests.

## The vault

The vault key never leaves the browser.`;

test("locateQuote: an unchanged passage matches exactly, across the source's line wrap", () => {
  const hit = locateQuote(DOC, "derived per user from the account secret, then wrapped");
  assert.equal(hit.match, "exact");
  assert.ok(hit.index > 0);
});

test("locateQuote: an edited tail still places the comment, as a partial match", () => {
  const hit = locateQuote(DOC, "The history key is derived per user from the account secret, then hashed twice");
  assert.equal(hit.match, "partial");
  assert.ok(hit.length >= 24);
});

test("locateQuote: replaced text is stale — the signal, not a failure", () => {
  assert.deepEqual(locateQuote(DOC, "the history key is stored on the server in plaintext"), {
    match: "stale",
    index: -1,
    length: 0,
  });
});

test("locateQuote: a truncated stored quote drops its marker before matching", () => {
  const hit = locateQuote(DOC, "The vault key never leaves" + QUOTE_TRUNCATION);
  assert.equal(hit.match, "exact");
});

test("locateQuote: the section disambiguates a phrase that occurs twice", () => {
  const doc = "## A\nthe same sentence here\n## B\nthe same sentence here";
  const first = locateQuote(doc, "the same sentence here", { section: "A" });
  const second = locateQuote(doc, "the same sentence here", { section: "B" });
  assert.equal(first.match, "exact");
  assert.equal(second.match, "exact");
  assert.ok(second.index > first.index, "the B-section hit should be the later occurrence");
});

test("locateQuote: a section that no longer exists falls back to searching the whole document", () => {
  const hit = locateQuote(DOC, "The vault key never leaves the browser", { section: "A section that was deleted" });
  assert.equal(hit.match, "exact");
});

test("locateQuote: empty inputs are stale, never a crash", () => {
  assert.equal(locateQuote("", "anything").match, "stale");
  assert.equal(locateQuote(DOC, "").match, "stale");
  assert.equal(locateQuote(null, null).match, "stale");
});

// ---- the reader's list -----------------------------------------------------

/** @param {object} over */
const entry = (over) => ({
  id: 1,
  doc: true,
  doc_path: "docs/ENCRYPTION.md",
  status: "new",
  created_at: 1,
  messages: [],
  comment: buildDocCommentBody({ path: "docs/ENCRYPTION.md", note: "n" }),
  ...over,
});

test("docCommentsFor keeps only this document's doc-scope entries", () => {
  const entries = [
    entry({ id: 1 }),
    entry({ id: 2, doc: false, doc_path: null }), // an ordinary feedback entry
    entry({ id: 3, doc_path: "docs/TESTING.md" }), // another document
  ];
  const got = docCommentsFor(entries, { path: "docs/ENCRYPTION.md", text: DOC });
  assert.deepEqual(got.map((c) => c.id), [1]);
});

test("docCommentsFor orders comments the way the document reads, stale ones last", () => {
  const q = (quote, id) => entry({ id, comment: buildDocCommentBody({ path: "docs/ENCRYPTION.md", quote, note: "n" }) });
  const got = docCommentsFor(
    [
      q("The vault key never leaves", 1), // later in the document
      q("a sentence that was deleted", 2), // stale
      q("The history key is derived", 3), // earlier in the document
    ],
    { path: "docs/ENCRYPTION.md", text: DOC },
  );
  assert.deepEqual(got.map((c) => c.id), [3, 1, 2]);
  assert.equal(got[2].hit.match, "stale");
});

test("docCommentsFor: a comment whose passage was replaced is reported stale, not dropped", () => {
  const got = docCommentsFor(
    [entry({ comment: buildDocCommentBody({ path: "docs/ENCRYPTION.md", quote: "gone entirely", note: "fix this" }) })],
    { path: "docs/ENCRYPTION.md", text: DOC },
  );
  assert.equal(got.length, 1);
  assert.equal(got[0].hit.match, "stale");
  assert.equal(got[0].anchor.note, "fix this");
});

test("docCommentsFor: an unparsable body is kept with its raw text as the note", () => {
  const got = docCommentsFor([entry({ comment: "written before this format existed" })], {
    path: "docs/ENCRYPTION.md",
    text: DOC,
  });
  assert.equal(got[0].anchor.note, "written before this format existed");
  assert.equal(got[0].hit.match, "stale");
});

// The rail is an overlay over the prose, so when it is NOT on screen is as much
// a rule as what it holds — feedback #40 (2026-07-26) was a dark pane over the
// documentation on a phone, in read-only mode, with no way to dismiss it.

test("railVisible: read mode never opens the rail on its own, comments or not", () => {
  assert.equal(railVisible({ commenting: false }), false);
  assert.equal(railVisible({ commenting: false, requested: null }), false);
  assert.equal(railVisible({}), false);
  assert.equal(railVisible(), false);
});

test("railVisible: comment mode opens its workspace", () => {
  assert.equal(railVisible({ commenting: true }), true);
});

test("railVisible: an explicit open or close outranks the mode", () => {
  assert.equal(railVisible({ commenting: false, requested: true }), true);
  assert.equal(railVisible({ commenting: true, requested: false }), false);
});

test("railVisible: writing a comment keeps the rail up — the composer is in it", () => {
  assert.equal(railVisible({ commenting: true, composing: true, requested: false }), true);
  assert.equal(railVisible({ commenting: false, composing: true }), true);
});

test("docCommentsFor: junk input yields an empty list", () => {
  assert.deepEqual(docCommentsFor(null, { path: "x" }), []);
  assert.deepEqual(docCommentsFor([null, undefined, 3], { path: "x" }), []);
});
