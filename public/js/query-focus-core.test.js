// Unit tests for the query-focus core (public/js/query-focus-core.js): the
// deterministic half of the subject-vs-format split reported as feedback #65.
//
// The reported turn is the spine of this file. A user asked "Osint revsec", then
// followed up with "Tiber style threat intel", and the planner came back with
// three angles of which two were about TIBER-EU — the report format — rather
// than about revsec, the company. The prompt rule alone did not hold on the
// fixed JSON planner the phase runs on (invariant 3 pins triage to Mistral
// Small), so the observed planner output is pinned here verbatim, both the
// queries and the sub-questions.
//
// The far more important half of the file is what the filter must NOT do. A
// question genuinely about a standard has to keep searching that standard, and
// an ordinary widening angle that simply does not repeat the subject has to
// survive untouched. Those cases are asserted first-class, not as afterthoughts:
// a later widening of the format vocabulary has to argue with a named case.

import assert from "node:assert/strict";
import test, { describe } from "node:test";

import {
  contentWords,
  focusQueriesOnSubject,
  isFormatChasingQuery,
  isFormatWord,
  subjectTokens,
} from "./query-focus-core.js";

// The reported conversation, cleaned of the method block the enrichment appends
// (which is what src/pipeline.js passes as `cleanText`).
const REPORTED_CONV = "Osint revsec\nTiber style threat intel";
const ON = { cleanText: REPORTED_CONV, methodApplied: true };

// ---- the reported turn ------------------------------------------------------

describe("the conversation resolves the company, not the report (feedback #65)", () => {
  test("the subject is the one word that is not format vocabulary", () => {
    assert.deepEqual([...subjectTokens(REPORTED_CONV)], ["revsec"]);
  });

  // "Osint", "Tiber", "threat" and "intel" all name the shape of the answer the
  // user asked for. Only "revsec" says what the answer is about.
  test("every format word in the conversation is excluded from the subject", () => {
    const subject = subjectTokens(REPORTED_CONV);
    for (const w of ["osint", "tiber", "threat", "intel", "style"]) {
      assert.equal(subject.has(w), false, `${w} must not be treated as the subject`);
    }
  });
});

describe("the planner's observed angles are cut down to the subject (feedback #65)", () => {
  // Verbatim from the reported turn. Two of the three chase the standard.
  test("the two framework angles are dropped and the company angle is kept", () => {
    const result = focusQueriesOnSubject(
      [
        "Tiber-EU threat intelligence framework",
        "Tiber-EU threat intelligence examples",
        "RevSec cyber threat intelligence",
      ],
      ON,
    );
    assert.deepEqual(result.queries, ["RevSec cyber threat intelligence"]);
    assert.deepEqual(result.dropped, [
      "Tiber-EU threat intelligence framework",
      "Tiber-EU threat intelligence examples",
    ]);
  });

  // The sub-questions steer every later round, so leaving them unfiltered
  // re-seeds the same angles through the gap check (src/pipeline.js).
  test("the sub-questions are cut the same way", () => {
    const result = focusQueriesOnSubject(
      [
        "What is the Tiber-EU framework for threat intelligence?",
        "How has the Tiber-EU framework been applied in practice?",
        "What are the current cyber threats relevant to RevSec?",
      ],
      ON,
    );
    assert.deepEqual(result.queries, ["What are the current cyber threats relevant to RevSec?"]);
    assert.equal(result.dropped.length, 2);
  });

  // The module's own header calls this the case that killed the weaker rule: an
  // "is every word format vocabulary?" test lets this one through, because
  // "applied" and "practice" are ordinary words. It is still a question about
  // the standard.
  test("a framework question dressed in ordinary words is still format-chasing", () => {
    const subject = subjectTokens(REPORTED_CONV);
    assert.equal(
      isFormatChasingQuery("How has the Tiber-EU framework been applied in practice?", subject),
      true,
    );
  });

  test("filtering an already-focused list changes nothing", () => {
    const once = focusQueriesOnSubject(["RevSec cyber threat intelligence"], ON);
    const twice = focusQueriesOnSubject(once.queries, ON);
    assert.deepEqual(twice.queries, once.queries);
    assert.deepEqual(twice.dropped, []);
  });
});

// ---- the failure the filter must never cause --------------------------------

describe("a question genuinely about the standard still searches the standard", () => {
  // The single most important test in this file. "What is TIBER-EU?" satisfies
  // the method gate — the dossier enrichment fires on the word alone — so the
  // ONLY thing standing between this user and a filter that deletes their whole
  // search plan is the subject gate. Once the format words are removed, nothing
  // is left, and the filter has to disengage.
  test("a conversation that resolves no subject leaves every angle untouched", () => {
    const queries = ["TIBER-EU framework", "TIBER-EU red teaming"];
    const result = focusQueriesOnSubject(queries, { cleanText: "what is TIBER-EU?", methodApplied: true });
    assert.deepEqual(result.queries, queries);
    assert.deepEqual(result.dropped, []);
  });

  test("the format-only question resolves no subject at all", () => {
    assert.equal(subjectTokens("what is TIBER-EU?").size, 0);
    assert.equal(subjectTokens("TIBER-EU report template examples").size, 0);
  });

  // Requiring a format WORD (rather than merely the absence of the subject) is
  // what keeps normal research angles out of the filter's way. This query names
  // no format and does not repeat "revsec", and it is exactly the kind of angle
  // that finds the acquisition history the user wanted.
  test("an ordinary widening angle that names no format survives", () => {
    const queries = ["Accenture acquisition Revolutionary Security 2020", "revsec leadership"];
    const result = focusQueriesOnSubject(queries, ON);
    assert.deepEqual(result.queries, queries);
    assert.deepEqual(result.dropped, []);
  });

  test("a query is only format-chasing when it reaches for format words AND drops the subject", () => {
    const subject = subjectTokens(REPORTED_CONV);
    // names a format, but is on the subject
    assert.equal(isFormatChasingQuery("RevSec cyber threat intelligence", subject), false);
    // misses the subject, but names no format
    assert.equal(isFormatChasingQuery("Accenture acquisition Revolutionary Security 2020", subject), false);
    // both halves
    assert.equal(isFormatChasingQuery("Tiber-EU threat intelligence framework", subject), true);
  });
});

// ---- the two gates ----------------------------------------------------------

describe("both gates must hold or the filter disengages", () => {
  test("no method block on the turn means no filtering", () => {
    const queries = ["Tiber-EU threat intelligence framework", "RevSec cyber threat intelligence"];
    const result = focusQueriesOnSubject(queries, { cleanText: REPORTED_CONV, methodApplied: false });
    assert.deepEqual(result.queries, queries);
    assert.deepEqual(result.dropped, []);
  });

  test("a missing or falsy methodApplied is treated as no method block", () => {
    const queries = ["Tiber-EU threat intelligence framework"];
    for (const ctx of [{ cleanText: REPORTED_CONV }, { cleanText: REPORTED_CONV, methodApplied: undefined }]) {
      assert.deepEqual(focusQueriesOnSubject(queries, ctx).queries, queries);
    }
  });

  test("an empty conversation resolves no subject and nothing is dropped", () => {
    const queries = ["Tiber-EU threat intelligence framework"];
    for (const cleanText of ["", "   ", "what is the standard?"]) {
      const result = focusQueriesOnSubject(queries, { cleanText, methodApplied: true });
      assert.deepEqual(result.queries, queries, cleanText);
      assert.deepEqual(result.dropped, [], cleanText);
    }
  });
});

// ---- never search nothing ---------------------------------------------------

describe("the search plan is never emptied", () => {
  // Dropping every angle would leave the round with no searches at all, which is
  // a worse answer than the format-chasing one it replaced.
  test("when every angle chased the format, the subject's own words become the query", () => {
    const result = focusQueriesOnSubject(
      ["Tiber-EU threat intelligence framework", "TIBER-EU report examples"],
      ON,
    );
    assert.deepEqual(result.queries, ["revsec"]);
    assert.equal(result.dropped.length, 2);
  });

  // The fallback is the user's own vocabulary in the order they used it, with
  // the report name taken out — nothing is invented here, and a subject word
  // repeated across turns appears once.
  test("the fallback keeps conversation order and says each subject word once", () => {
    const result = focusQueriesOnSubject(["TIBER-EU framework", "threat intelligence report examples"], {
      cleanText: "Osint revsec ab\nrevsec Tiber style threat intel",
      methodApplied: true,
    });
    assert.deepEqual(result.queries, ["revsec ab"]);
  });
});

// ---- invariant 6 ------------------------------------------------------------

describe("Swedish language parity — the format vocabulary has equal breadth", () => {
  // Matched pairs, the enforcement shape CLAUDE.md names (the "Swedish language
  // parity" suite in src/googlemaps.test.js, mirrored in
  // entity-research-core.test.js). The subject is a company name, so it is the
  // same in both arms; what has to be symmetric is the FORMAT vocabulary. A
  // format word added to the English arm without its Swedish counterpart means
  // the filter silently does nothing on every Swedish dossier turn — the exact
  // asymmetry this table exists to catch.
  const SUBJECT = subjectTokens(REPORTED_CONV);

  const CHASING_PAIRS = [
    ["TIBER-EU threat intelligence framework", "TIBER-EU ramverk för hotbild"],
    ["threat intelligence report examples", "exempel på underrättelserapport"],
    ["OSINT methodology", "OSINT metodik"],
    ["background check template", "mall för bakgrundskoll"],
    ["due diligence checklist", "checklista för granskning"],
    ["threat assessment framework", "ramverk för hotbedömning"],
    ["how the TIBER-EU framework is applied in practice", "hur ramverket tillämpas i praktiken"],
    ["intelligence report structure", "struktur för underrättelserapport"],
    ["KYC guidelines", "riktlinjer för personkontroll"],
    ["threat profile format", "format för hotbild"],
  ];
  for (const [en, sv] of CHASING_PAIRS) {
    test(`chases the report in both languages: "${en}" ⇄ "${sv}"`, () => {
      assert.equal(isFormatChasingQuery(en, SUBJECT), true, `EN arm silent: ${en}`);
      assert.equal(isFormatChasingQuery(sv, SUBJECT), true, `SV arm silent: ${sv}`);
    });
  }

  const ON_SUBJECT_PAIRS = [
    ["RevSec cyber threat intelligence", "RevSec cyberhot och hotbild"],
    ["revsec leadership team", "revsec ledningsgrupp"],
    ["revsec breach history", "revsec incidenthistorik"],
    ["Accenture acquisition Revolutionary Security 2020", "Accenture förvärv av Revolutionary Security 2020"],
  ];
  for (const [en, sv] of ON_SUBJECT_PAIRS) {
    test(`stays on the subject in both languages: "${en}" ⇄ "${sv}"`, () => {
      assert.equal(isFormatChasingQuery(en, SUBJECT), false, `EN arm over-filtered: ${en}`);
      assert.equal(isFormatChasingQuery(sv, SUBJECT), false, `SV arm over-filtered: ${sv}`);
    });
  }

  // The reported turn as a Swedish user would have written it. The drop here is
  // carried by "hotbild" — see the note on hyphenated compounds below.
  test("a Swedish dossier turn drops the framework angle and keeps the company", () => {
    const result = focusQueriesOnSubject(["TIBER-ramverket hotbild", "revsec företaget"], {
      cleanText: "Osint på revsec\nhotbild i TIBER-stil",
      methodApplied: true,
    });
    assert.deepEqual(result.queries, ["revsec företaget"]);
    assert.deepEqual(result.dropped, ["TIBER-ramverket hotbild"]);
  });

  test("a Swedish question about the framework itself is left alone", () => {
    const queries = ["TIBER-EU ramverk", "TIBER-EU exempel"];
    const result = focusQueriesOnSubject(queries, { cleanText: "vad är TIBER-EU?", methodApplied: true });
    assert.deepEqual(result.queries, queries);
    assert.deepEqual(result.dropped, []);
  });

  // Asserted as a property rather than as an exact string: the fallback must be
  // non-empty and must carry the subject. (It also carries "tiberstil" today,
  // because "TIBER-stil" tokenises as one compound the format list does not
  // know — a real gap, deliberately not pinned here.)
  test("a Swedish turn whose angles all chase the format still searches the company", () => {
    const result = focusQueriesOnSubject(["ramverk för hotbild", "exempel på underrättelserapport"], {
      cleanText: "Osint på revsec\nhotbild i TIBER-stil",
      methodApplied: true,
    });
    assert.equal(result.queries.length, 1);
    assert.match(result.queries[0], /revsec/);
    assert.equal(result.dropped.length, 2);
  });
});

describe("å/ä/ö survive tokenisation — the trap that kills bilingual gates", () => {
  // JavaScript's `\w` is [A-Za-z0-9_] and `\b` is defined over it, so a word
  // list built on either splits Swedish words down the middle and the Swedish
  // half of a gate dies silently while the English half keeps working
  // (src/swedish-boundary.test.js, and the palaeogenomics skill's grep). This
  // module uses /[\p{L}\p{N}]…/gu instead, which is why the format list can
  // contain "hotbedömning" and "kartläggning" at all.
  test("Swedish words are tokenised whole", () => {
    assert.deepEqual(contentWords("hotbedömning av kartläggning på företaget Åkes Ångbåt"), [
      "hotbedömning",
      "kartläggning",
      "företaget",
      "åkes",
      "ångbåt",
    ]);
  });

  // The trap made concrete: this is what the same tokenisation would produce
  // with the ASCII word class, and every accented format word would be unmatchable.
  test("the ASCII word class would have split them into unmatchable fragments", () => {
    assert.deepEqual("hotbedömning av kartläggning".match(/\w+/g), [
      "hotbed",
      "mning",
      "av",
      "kartl",
      "ggning",
    ]);
    // And the boundary half of the same trap: a word EDGED in å/ä/ö can never
    // match against an ASCII `\b`, so the Swedish arm of a word list is inert
    // while its English arm keeps working.
    assert.equal(/\bångbåt\b/i.test("en ångbåt här"), false);
    assert.equal(/(?<![\p{L}\p{N}_])ångbåt(?![\p{L}\p{N}_])/iu.test("en ångbåt här"), true);
  });

  test("accented format words are recognised as format vocabulary", () => {
    const subject = new Set(["revsec"]);
    for (const q of ["hotbedömning av leverantören", "kartläggning enligt ramverket", "bedömning och granskning"]) {
      assert.equal(isFormatChasingQuery(q, subject), true, q);
    }
  });

  test("accented subject words are matched as the subject, not re-searched", () => {
    const subject = subjectTokens("Osint på Ångpanneföreningen\nhotbild i TIBER-stil");
    assert.equal(subject.has("ångpanneföreningen"), true);
    assert.equal(isFormatChasingQuery("Ångpanneföreningen hotbild", subject), false);
  });
});

// ---- the tokeniser ----------------------------------------------------------

describe("content words", () => {
  test("are lowercased, stopword-free, and keep numbers", () => {
    assert.deepEqual(contentWords("The company report of 2020"), ["company", "report", "2020"]);
  });

  // An apostrophe is noise and closes up. A HYPHEN is kept, because the parts
  // either side of it are what say whether the word names a format: dropping it
  // turned "TIBER-ramverket" into a word no list has heard of, and let
  // "TIBER-stil" pass as part of the subject — putting the report's own name
  // back into the search this module exists to clean it out of.
  test("a hyphen survives tokenising; an apostrophe does not", () => {
    assert.deepEqual(contentWords("TIBER-EU"), ["tiber-eu"]);
    assert.deepEqual(contentWords("the company's profile"), ["companys", "profile"]);
  });

  test("a hyphenated compound is format vocabulary if any part of it is", () => {
    for (const w of ["tiber-eu", "TIBER-ramverket", "TIBER-stil", "hot-analys"]) {
      assert.equal(isFormatWord(w), true, w);
    }
    // …and an ordinary hyphenated name is not.
    for (const w of ["revsec-labs", "blue-bell"]) assert.equal(isFormatWord(w), false, w);
  });

  test("the subject is compared on the closed-up form, so a hyphen cannot smuggle a format word in", () => {
    const subject = subjectTokens("Osint på revsec\nhotbild i TIBER-stil");
    assert.deepEqual([...subject], ["revsec"], "TIBER-stil is the format, not the subject");
    assert.equal(isFormatChasingQuery("TIBER-ramverket", subject), true);
    assert.equal(isFormatChasingQuery("revsec företaget", subject), false);
  });

  test("single characters and punctuation carry no subject", () => {
    assert.deepEqual(contentWords("a x — 1 !!! ***"), []);
  });

  test("non-string and empty input give an empty list", () => {
    for (const v of ["", null, undefined, 42, {}, []]) {
      assert.deepEqual(contentWords(/** @type {any} */ (v)), [], String(v));
    }
    assert.equal(subjectTokens(/** @type {any} */ (undefined)).size, 0);
  });
});

// ---- fail-soft --------------------------------------------------------------

describe("bad input degrades instead of breaking the request (invariant 2)", () => {
  test("a non-array query list yields an empty plan rather than a throw", () => {
    for (const v of [null, undefined, "not a list", 42, {}]) {
      assert.deepEqual(focusQueriesOnSubject(/** @type {any} */ (v), ON), { queries: [], dropped: [] }, String(v));
    }
  });

  test("an empty list stays empty", () => {
    assert.deepEqual(focusQueriesOnSubject([], ON), { queries: [], dropped: [] });
  });

  test("a missing context disengages instead of throwing", () => {
    const queries = ["Tiber-EU threat intelligence framework"];
    for (const ctx of [undefined, null, {}]) {
      assert.deepEqual(focusQueriesOnSubject(queries, /** @type {any} */ (ctx)).queries, queries, String(ctx));
    }
  });

  test("a context with no clean text disengages instead of throwing", () => {
    const queries = ["Tiber-EU threat intelligence framework"];
    for (const cleanText of [undefined, null, 42]) {
      const result = focusQueriesOnSubject(queries, /** @type {any} */ ({ cleanText, methodApplied: true }));
      assert.deepEqual(result.queries, queries, String(cleanText));
    }
  });

  test("non-string and blank members are ignored, and blanks alone disengage", () => {
    const result = focusQueriesOnSubject(
      ["Tiber-EU threat intelligence framework", null, 42, "   ", "revsec leadership"],
      ON,
    );
    assert.deepEqual(result.queries, ["revsec leadership"]);
    assert.deepEqual(result.dropped, ["Tiber-EU threat intelligence framework"]);
    // Nothing usable to work with: the input comes back exactly as it was.
    const blanks = ["", "   "];
    assert.deepEqual(focusQueriesOnSubject(blanks, ON), { queries: blanks, dropped: [] });
  });

  test("an empty or unparseable query is never called format-chasing", () => {
    for (const q of ["", "   ", "!!! ---", null, undefined, 42]) {
      assert.equal(isFormatChasingQuery(/** @type {any} */ (q), new Set(["revsec"])), false, String(q));
    }
  });
});
