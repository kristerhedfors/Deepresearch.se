import { test } from "node:test";
import assert from "node:assert/strict";
import { citedPmids, validateItems } from "./adna-evalset.mjs";

/** A minimal valid item; each test breaks exactly one thing. */
const ok = (over = {}) => ({
  id: "adna-h001",
  question: "What did the first draft Neanderthal genome show about interbreeding?",
  answer: "That Neanderthals contributed 1-4% of the genomes of present-day non-Africans.",
  goldUrls: ["https://pubmed.ncbi.nlm.nih.gov/20448178/"],
  tags: ["hominin", "single-fact"],
  ...over,
});

test("citedPmids pulls the PMID out of a gold URL and ignores anything else", () => {
  assert.deepEqual(citedPmids(ok()), ["20448178"]);
  assert.deepEqual(citedPmids({ goldUrls: ["https://doi.org/10.1038/nature12886"] }), []);
  assert.deepEqual(citedPmids({}), []);
  assert.deepEqual(
    citedPmids({ goldUrls: ["https://pubmed.ncbi.nlm.nih.gov/1/", "https://pubmed.ncbi.nlm.nih.gov/22/"] }),
    ["1", "22"],
  );
});

test("a well-formed item passes", () => {
  assert.deepEqual(validateItems([ok()]), []);
});

test("duplicate ids are caught — the failure mode of authoring batches in parallel", () => {
  const errs = validateItems([ok(), ok({ question: "Something else entirely, at length?" })]);
  assert.ok(errs.some((e) => e.includes("duplicate id")), errs.join("; "));
});

test("the same question asked twice under different ids is caught", () => {
  const errs = validateItems([ok(), ok({ id: "adna-m001" })]);
  assert.ok(errs.some((e) => e.includes("same question")), errs.join("; "));
});

test("an item citing the excluded author is rejected", () => {
  const errs = validateItems([ok()], new Set(["20448178"]));
  assert.ok(errs.some((e) => e.includes("excluded author")), errs.join("; "));
});

test("a missing or unusable goldUrl is a missing citation", () => {
  assert.ok(validateItems([ok({ goldUrls: [] })]).some((e) => e.includes("no resolvable PubMed goldUrl")));
  assert.ok(
    validateItems([ok({ goldUrls: ["https://www.nature.com/articles/nature09710"] })]).some((e) =>
      e.includes("no resolvable PubMed goldUrl"),
    ),
  );
});

test("a difficulty tag is required, so the set's mix can be reported honestly", () => {
  assert.ok(validateItems([ok({ tags: ["hominin"] })]).some((e) => e.includes("no difficulty tag")));
});

test("empty question or answer is rejected", () => {
  assert.ok(validateItems([ok({ question: "   " })]).some((e) => e.includes("empty question")));
  assert.ok(validateItems([ok({ answer: "" })]).some((e) => e.includes("empty answer")));
});

// The two ways a Swedish item arrives damaged. Both look fine on screen.
test("a Swedish item that lost its diacritics is rejected", () => {
  const stripped = ok({
    id: "adna-h002",
    question: "Vad visade det forsta utkastet till neandertalarnas arvsmassa?",
    answer: "Att neandertalare bidrog med 1-4 procent av arvsmassan hos dagens icke-afrikaner.",
    tags: ["hominin", "single-fact", "sv"],
  });
  assert.ok(validateItems([stripped]).some((e) => e.includes("diacritics")), "stripped Swedish must fail");

  const intact = ok({
    id: "adna-h003",
    question: "Vad visade det första utkastet till neandertalarnas arvsmassa?",
    answer: "Att neandertalare bidrog med 1-4 procent av arvsmassan hos dagens icke-afrikaner.",
    tags: ["hominin", "single-fact", "sv"],
  });
  assert.deepEqual(validateItems([intact]), []);
});

test("a Swedish question left untagged is caught, so the sv count cannot silently undercount", () => {
  const untagged = ok({ question: "Vad visade det första utkastet till neandertalarnas arvsmassa?" });
  assert.ok(validateItems([untagged]).some((e) => e.includes("not tagged sv")));
});

test("non-Latin script pasted into a question is rejected — it is invisible and matches nothing", () => {
  // A Cyrillic 'е' inside an otherwise Latin word.
  const errs = validateItems([ok({ question: "What did the first draft Nеanderthal genome show about it?" })]);
  assert.ok(errs.some((e) => e.includes("non-Latin script")), errs.join("; "));
});
