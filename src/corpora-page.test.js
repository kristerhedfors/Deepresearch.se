import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { isPublicAsset } from "./assets.js";

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const PAGE = read("public/corpora/index.html");
const HELP = read("public/help/index.html");

// /corpora/ answers one question for a reader: does an empty search result mean
// the paper is absent, or merely that retrieval missed it? Getting that wrong
// in either direction is the failure this page exists to prevent, so the
// properties pinned here are the ones that carry that meaning — not the layout.

test("the page and its dataset are public — the reader has no account yet", () => {
  // A reader deciding whether to trust an empty result is, by construction,
  // often not signed in. An auth wall here makes the page useless exactly when
  // it is needed.
  for (const path of ["/corpora", "/corpora/", "/corpora/data.json"]) {
    assert.equal(isPublicAsset(new URL(`https://deepresearch.se${path}`), "GET"), true, `${path} must be public`);
  }
});

test("the page states the limit that matters most: abstracts only, no full text", () => {
  // Every other caveat is about degree; this one is categorical. A question
  // answered only in a methods section cannot be answered from these corpora
  // at any recall.
  assert.match(PAGE, /abstracts only/i);
});

test("the page does not present the corpora as complete", () => {
  assert.match(PAGE, /shaped, not complete/i);
});

test("PubMed is described by load order, not as a date range", () => {
  // The single most-misread fact about this corpus. "The last N years of
  // PubMed" is wrong in both directions — old revised papers are in, recent
  // papers loaded before the baseline are out.
  assert.match(PAGE, /not "the last N years of PubMed"/i);
  assert.match(PAGE, /revised/i);
});

test("the page tells a reader how to separate absent from not-retrieved", () => {
  // Without this the page is trivia. The id-membership check is the one step
  // that distinguishes the two cases, and it has to be findable.
  assert.match(PAGE, /Check membership by id first/i);
});

test("numbers are rendered from the dataset, never hard-coded into the page", () => {
  // The whole reason this is generated: the equivalent claim inside the code
  // went stale and told agents that tens of thousands of held papers were out
  // of window. A literal count in the markup would drift the same way.
  // Markup only: the stylesheet is stripped first, because an rgba() triple
  // like rgba(42,120,214,.16) reads as a thousands-separated number to any
  // pattern naive enough to look at the whole file.
  const body = PAGE.split("<script")[0].replace(/<style[\s\S]*?<\/style>/g, "");
  assert.doesNotMatch(body, /\b\d{3},\d{3}\b/, "no formatted record count may appear in the static markup");
  assert.match(PAGE, /fetch\("\/corpora\/data\.json"/);
});

test("the page distinguishes a live measurement from a historical one", () => {
  // A figure read off the index today and a figure recorded during a fill age
  // completely differently, and a reader cannot tell them apart unless the
  // page says which is which.
  assert.match(PAGE, /MEASURED/);
  assert.match(PAGE, /RECORDED/);
});

test("it is reachable from the documentation surface", () => {
  // Public but unlinked is not available. The landing's door list is fixed at
  // eight by docs/INTRO-BASELINE.md §2.6, so /help/ is the entry point that
  // does not require an invariant-8 amendment.
  assert.match(HELP, /href="\/corpora\/"/);
});
