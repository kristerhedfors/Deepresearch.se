import { test } from "node:test";
import assert from "node:assert/strict";
import { citedArxiv, citedPmids, validateItems } from "./evalset-build.mjs";

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
  assert.ok(validateItems([ok({ goldUrls: [] })]).some((e) => e.includes("no resolvable PubMed or arXiv goldUrl")));
  assert.ok(
    validateItems([ok({ goldUrls: ["https://www.nature.com/articles/nature09710"] })]).some((e) =>
      e.includes("no resolvable PubMed or arXiv goldUrl"),
    ),
  );
});

test("citedArxiv reads both id eras and strips the version", () => {
  // The index keys on the version-less id, so `v2` must not survive into a lookup.
  assert.deepEqual(citedArxiv({ goldUrls: ["https://arxiv.org/abs/2307.15043"] }), ["2307.15043"]);
  assert.deepEqual(citedArxiv({ goldUrls: ["https://arxiv.org/abs/2307.15043v2"] }), ["2307.15043"]);
  assert.deepEqual(citedArxiv({ goldUrls: ["https://arxiv.org/pdf/1412.6572v4"] }), ["1412.6572"]);
  // Pre-2007 ids, which the older half of these literatures still uses.
  assert.deepEqual(citedArxiv({ goldUrls: ["https://arxiv.org/abs/cs/0501001"] }), ["cs/0501001"]);
  assert.deepEqual(citedArxiv({ goldUrls: ["https://arxiv.org/abs/math.GT/0309136"] }), ["math.GT/0309136"]);
  // Five-digit ids arrived in 2015 when arXiv passed 9,999 submissions a month.
  assert.deepEqual(citedArxiv({ goldUrls: ["https://arxiv.org/abs/2501.12345"] }), ["2501.12345"]);
  assert.deepEqual(citedArxiv({ goldUrls: ["https://pubmed.ncbi.nlm.nih.gov/20448178/"] }), []);
});

test("an arXiv-only item is valid — which corpus holds a paper is a property of the domain", () => {
  const arxivItem = ok({
    question: "What did the FGSM paper show about the cause of adversarial examples?",
    answer: "That they arise from the linear behaviour of models in high-dimensional spaces.",
    goldUrls: ["https://arxiv.org/abs/1412.6572"],
    tags: ["model-security", "single-fact"],
  });
  assert.deepEqual(validateItems([arxivItem]), []);
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

test("an English question citing a foreign name is NOT mistaken for Swedish", () => {
  // Diacritics alone cannot decide this: plenty of researchers in these fields
  // are called Frässle, Müller, Schrödinger or Dalén. This exact case fired as
  // a false positive on a real item before the check moved to function words.
  const foreignNames = [
    "Frässle and colleagues used optokinetic nystagmus to track binocular rivalry. What changed?",
    "What did Müller and Schrödinger conclude about the measurement problem in this setting?",
    "Which of Dalén's collaborators sequenced the specimen, and in what year did they publish?",
  ];
  for (const question of foreignNames) {
    assert.deepEqual(validateItems([ok({ question })]), [], `false positive on: ${question}`);
  }
});

test("one stray Swedish-looking token is not enough to call a question Swedish", () => {
  // "att" also appears inside quoted foreign titles; a single hit must not trip it.
  const q = ok({ question: 'The paper titled "Ett steg" was cited here — what did the authors measure?' });
  assert.deepEqual(validateItems([q]), []);
});

test("a confusable character pasted into a question is rejected — it is invisible and matches nothing", () => {
  // A Cyrillic 'е' inside an otherwise Latin word.
  const errs = validateItems([ok({ question: "What did the first draft Nеanderthal genome show about it?" })]);
  assert.ok(errs.some((e) => e.includes("confusable")), errs.join("; "));
});

test("Greek mathematical notation is allowed — an epsilon is correct, not corrupt", () => {
  // This fired as a false positive on a real certified-robustness question.
  const math = ok({
    question: "Which bound did the two early provable defences promise on MNIST at ε = 0.1 in the ∞-norm?",
    answer: "They gave differing certified bounds under the same perturbation budget.",
  });
  assert.deepEqual(validateItems([math]), []);
  const swedishMath = ok({
    id: "aisec-a017",
    question: "Vilka gränser lovade de två tidiga bevisbara försvaren på MNIST vid störningsbudgeten ε = 0,1?",
    answer: "De gav olika garanterade gränser under samma störningsbudget.",
    tags: ["model-security", "multihop", "sv"],
  });
  assert.deepEqual(validateItems([swedishMath]), []);
});

test("English words that are also Swedish function words do not make a question Swedish", () => {
  // "de" falls out of "de-identified"; `under`, `till`, `men`, `man` and `en`
  // are all ordinary English. This exact sentence fired as a false positive.
  const q = ok({
    question: '"De-identified health data is safe to release" - what does the work establish, and under what conditions?',
  });
  assert.deepEqual(validateItems([q]), []);
});
