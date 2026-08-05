// Unit tests for src/literature-authors.js — the author lookup's pure half:
// the bilingual intent gate, the two query grammars, the record mappers and
// the interleave.
//
// The gate is deterministic intent routing, so invariant 6 binds: every English
// form has a Swedish counterpart with the same breadth, and the parity suite at
// the bottom is the enforcement pattern src/googlemaps.test.js established.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  AUTHOR_LIMIT,
  arxivAuthorQuery,
  arxivAuthorRecord,
  authorIntent,
  europepmcAuthorQuery,
  europepmcAuthorRecord,
  interleaveAuthorRecords,
  looksLikeName,
  resolveAuthors,
  topicTerms,
  trimNameEdges,
} from "./literature-authors.js";
import { MAX_AUTHORS } from "./literature-tools.js";

describe("authorIntent — English forms", () => {
  const cases = [
    ["papers by Love Dalén", "Love Dalén"],
    ["Papers published by Love Dalén", "Love Dalén"],
    ["publications by Marianne Dehasque", "Marianne Dehasque"],
    ["research from Tom van der Valk", "Tom van der Valk"],
    ["show me the works of Svante Pääbo", "Svante Pääbo"],
    ["what has Love Dalén published", "Love Dalén"],
    ["what did Beth Shapiro write", "Beth Shapiro"],
    ["everything Love Dalén has published", "Love Dalén"],
    ["Love Dalén's papers", "Love Dalén"],
    ["Love Dalén's life work", "Love Dalén"],
    ["Beth Shapiro's body of work", "Beth Shapiro"],
    ["Pääbo's bibliography", "Pääbo"],
  ];
  for (const [text, name] of cases) {
    test(`"${text}" → ${name}`, () => {
      assert.equal(authorIntent(text)?.name, name);
    });
  }
});

describe("authorIntent — Swedish forms (invariant 6)", () => {
  const cases = [
    ["artiklar av Love Dalén", "Love Dalén"],
    ["artiklarna av Love Dalén", "Love Dalén"],
    ["publikationer av Marianne Dehasque", "Marianne Dehasque"],
    ["publikationerna av Love Dalén", "Love Dalén"],
    ["verk av Svante Pääbo", "Svante Pääbo"],
    ["arbeten av Love Dalén", "Love Dalén"],
    ["forskning av Love Dalén", "Love Dalén"],
    ["forskningen av Love Dalén", "Love Dalén"],
    ["studier av Beth Shapiro", "Beth Shapiro"],
    ["studierna av Beth Shapiro", "Beth Shapiro"],
    ["avhandlingar av Love Dalén", "Love Dalén"],
    ["författarskap av Love Dalén", "Love Dalén"],
    ["artiklar från Love Dalén", "Love Dalén"],
    ["vad har Love Dalén publicerat", "Love Dalén"],
    ["vad har Love Dalén skrivit", "Love Dalén"],
    ["vad har Love Dalén forskat om", "Love Dalén"],
    ["allt som Love Dalén har publicerat", "Love Dalén"],
    ["allt Love Dalén skrivit", "Love Dalén"],
    ["Daléns artiklar", "Dalén"],
    ["Daléns livsverk", "Dalén"],
    ["Love Daléns publikationer", "Love Dalén"],
    ["Nilsson:s arbeten", "Nilsson"],
  ];
  for (const [text, name] of cases) {
    test(`"${text}" → ${name}`, () => {
      assert.equal(authorIntent(text)?.name, name);
    });
  }
});

describe("authorIntent — what it must NOT fire on", () => {
  for (const text of [
    "ancient DNA papers",
    "mammoth genomics since 2023",
    "papers by the authors of that study",
    "what has changed in ancient DNA",
    "vad har hänt inom ancient DNA",
    "artiklar om mammutar",
    "papers by Nature",
    "",
    null,
  ]) {
    test(`"${text}" → null`, () => {
      assert.equal(authorIntent(text), null);
    });
  }
});

describe("authorIntent — the reported failure, verbatim", () => {
  // The question that produced the bug report, in the shapes a user actually
  // types it: a Swedish genitive with an English noun, with and without
  // capitals, with and without a conversational lead-in. Every one of these
  // reached NO author search before this module existed.
  for (const text of [
    "love daléns life works",
    "Love Daléns life works",
    "love dalén life works",
    "tell me about love daléns life works",
    "Tell me about Love Daléns life works",
    "Love Dalén's life work",
    "Love Daléns livsverk",
  ]) {
    test(`"${text}" resolves to Dalén`, () => {
      assert.match(authorIntent(text)?.name || "", /dal[ée]n$/i);
    });
  }
});

describe("authorIntent — the ambiguous bare-s genitive", () => {
  test("an English plural before a work noun is NOT a possessive", () => {
    // "mammoth genomics studies" once read as a researcher named "mammoth
    // genomic": a bare `s` is far more often a plural than a possessive, so
    // only nouns that cannot follow anything but a person are allowed after it.
    assert.equal(authorIntent("mammoth genomics studies"), null);
    assert.equal(authorIntent("ancient genomics papers"), null);
    assert.equal(authorIntent("mammoth forskning"), null);
    assert.equal(authorIntent("svensk forskning om mammutar"), null);
  });

  test("an apostrophe or colon makes the same shape unambiguous", () => {
    assert.equal(authorIntent("Beth Shapiro's studies")?.name, "Beth Shapiro");
    assert.equal(authorIntent("Nilsson:s studier")?.name, "Nilsson");
  });

  test("a Swedish work noun after a bare s is unambiguous too", () => {
    assert.equal(authorIntent("Daléns artiklar")?.name, "Dalén");
    assert.equal(authorIntent("Tom van der Valks publikationer")?.name, "Tom van der Valk");
  });
});

describe("trimNameEdges", () => {
  test("drops auxiliaries and articles from both ends", () => {
    assert.equal(trimNameEdges("Love Dalén has"), "Love Dalén");
    assert.equal(trimNameEdges("the authors of that"), "authors");
  });

  test("drops a conversational lead-in", () => {
    assert.equal(trimNameEdges("me about love dalén"), "love dalén");
  });

  test("with capitals present, an uncapitalised lead-in goes even if unlisted", () => {
    assert.equal(trimNameEdges("whatever Love Dalén", true), "Love Dalén");
  });

  test("a lowercase name PARTICLE is kept — it is part of the name", () => {
    assert.equal(trimNameEdges("Tom van der Valk", true), "Tom van der Valk");
  });
});

describe("looksLikeName", () => {
  test("accepts one to four capitalised parts", () => {
    assert.equal(looksLikeName("Dalén"), true);
    assert.equal(looksLikeName("Love Dalén"), true);
    assert.equal(looksLikeName("Tom van der Valk"), true);
  });
  test("rejects topic words and stopwords", () => {
    assert.equal(looksLikeName("Nature"), false);
    assert.equal(looksLikeName("the"), false);
    assert.equal(looksLikeName("DNA"), false);
    assert.equal(looksLikeName("professor"), false);
    assert.equal(looksLikeName("forskare"), false);
  });
  test("rejects an empty or over-long run", () => {
    assert.equal(looksLikeName(""), false);
    assert.equal(looksLikeName("A B C D E"), false);
  });
});

describe("resolveAuthors", () => {
  test("explicit names win and are de-duplicated case-insensitively", () => {
    const { names, detected } = resolveAuthors(["Love Dalén", "love dalén"], []);
    assert.deepEqual(names, ["Love Dalén"]);
    assert.equal(detected, false);
  });

  test("a bare string is accepted as one name", () => {
    assert.deepEqual(resolveAuthors("Love Dalén", []).names, ["Love Dalén"]);
  });

  test("falls back to the query text and says it did", () => {
    const { names, detected } = resolveAuthors(undefined, ["papers by Love Dalén"]);
    assert.deepEqual(names, ["Love Dalén"]);
    assert.equal(detected, true);
  });

  test("an explicit list is NOT augmented from the prose", () => {
    // A caller that named someone has been precise; mining its questions for a
    // second name would search for a person it did not ask about.
    const { names } = resolveAuthors(["Beth Shapiro"], ["papers by Love Dalén"]);
    assert.deepEqual(names, ["Beth Shapiro"]);
  });

  test("caps at MAX_AUTHORS", () => {
    const { names } = resolveAuthors(["A Andersson", "B Bengtsson", "C Carlsson", "D Davidsson"], []);
    assert.equal(names.length, MAX_AUTHORS);
  });

  test("nothing to resolve is an empty list, not a throw", () => {
    assert.deepEqual(resolveAuthors(undefined, ["mammoth genomics"]).names, []);
    assert.deepEqual(resolveAuthors(null, []).names, []);
  });
});

describe("topicTerms", () => {
  test("keeps subject words and drops the authorship phrasing", () => {
    const terms = topicTerms(["papers by Love Dalén on mammoth genomics"]);
    assert.ok(terms.includes("mammoth"));
    assert.ok(terms.includes("genomics"));
    assert.ok(!terms.some((t) => /^(papers?|by)$/i.test(t)));
  });
  test("de-duplicates and bounds", () => {
    const terms = topicTerms(["mammoth mammoth genomics", "genomics ancient permafrost sediment tundra steppe"], 4);
    assert.equal(terms.length, 4);
    assert.equal(new Set(terms.map((t) => t.toLowerCase())).size, 4);
  });
  test("no queries is no terms", () => {
    assert.deepEqual(topicTerms([]), []);
  });
});

describe("europepmcAuthorQuery", () => {
  test("asks for the full form AND the indexed 'Surname I' form", () => {
    const q = europepmcAuthorQuery("Love Dalén");
    assert.ok(q.includes('AUTH:"Love Dalén"'));
    assert.ok(q.includes('AUTH:"Dalén L"'));
    assert.ok(q.startsWith("("));
  });

  test("a single-word name has only the one form", () => {
    assert.equal(europepmcAuthorQuery("Dalén"), 'AUTH:"Dalén"');
  });

  test("topic terms are ANDed as an OR group — the disambiguating lever", () => {
    const q = europepmcAuthorQuery("Love Dalén", ["mammoth", "ancient DNA"]);
    assert.ok(q.includes(" AND ("));
    assert.ok(q.includes('"mammoth"'));
    assert.ok(q.includes('"ancient DNA"'));
  });

  test("query syntax in a name cannot escape the field", () => {
    const q = europepmcAuthorQuery('Dalén" OR AUTH:"Someone Else');
    assert.equal(q.split('"').length % 2, 1, "quotes stay balanced");
    assert.ok(!q.includes('OR AUTH:"Someone'), "the injected operator was stripped");
  });

  test("an empty name is an empty query, not a wildcard", () => {
    assert.equal(europepmcAuthorQuery(""), "");
    assert.equal(europepmcAuthorQuery(null), "");
  });
});

describe("arxivAuthorQuery", () => {
  test("uses the au: field with explicit operators", () => {
    assert.equal(arxivAuthorQuery("Love Dalén"), 'au:"Love Dalén"');
  });
  test("topic terms are explicit all: alternatives, ANDed", () => {
    const q = arxivAuthorQuery("Love Dalén", ["mammoth", "genomics"]);
    assert.equal(q, 'au:"Love Dalén" AND (all:"mammoth" OR all:"genomics")');
  });
  test("an empty name is an empty query", () => {
    assert.equal(arxivAuthorQuery("  "), "");
  });
});

describe("europepmcAuthorRecord", () => {
  const raw = {
    pmid: "40994021",
    doi: "10.1098/rsbl.2025.0123",
    title: "Long-term mammoth hybridization in British Columbia.",
    authorList: {
      author: [{ fullName: "Dehasque M" }, { fullName: "van der Valk T" }, { fullName: "Dalén L" }],
    },
    firstPublicationDate: "2025-09-24",
    journalInfo: { journal: { title: "Biology Letters" } },
    abstractText: "<p>Mammoth <i>genomes</i> from   British Columbia.</p>",
    citedByCount: 12,
  };

  test("keeps the FULL author list — the whole reason this leg exists", () => {
    const rec = europepmcAuthorRecord(raw);
    assert.deepEqual(rec.authors, ["Dehasque M", "van der Valk T", "Dalén L"]);
  });

  test("prefers the PubMed URL so the id round-trips through literature_fetch", () => {
    assert.equal(europepmcAuthorRecord(raw).url, "https://pubmed.ncbi.nlm.nih.gov/40994021/");
    assert.equal(europepmcAuthorRecord(raw).id, "40994021");
  });

  test("falls back to the DOI, then to the Europe PMC article page", () => {
    assert.equal(
      europepmcAuthorRecord({ ...raw, pmid: "" }).url,
      "https://doi.org/10.1098/rsbl.2025.0123",
    );
    assert.equal(
      europepmcAuthorRecord({ ...raw, pmid: "", doi: "", source: "PPR", id: "PPR123" }).url,
      "https://europepmc.org/article/PPR/PPR123",
    );
  });

  test("strips markup and collapses whitespace in the abstract", () => {
    assert.equal(europepmcAuthorRecord(raw).abstract, "Mammoth genomes from British Columbia.");
  });

  test("reads authorString when there is no structured author list", () => {
    const rec = europepmcAuthorRecord({ ...raw, authorList: null, authorString: "Dehasque M, Dalén L." });
    assert.deepEqual(rec.authors, ["Dehasque M", "Dalén L"]);
  });

  test("carries the citation count and the trailing-period-free title", () => {
    const rec = europepmcAuthorRecord(raw);
    assert.equal(rec.cited_by, 12);
    assert.equal(rec.title, "Long-term mammoth hybridization in British Columbia");
  });

  test("an untitled or unaddressable record is dropped, not half-mapped", () => {
    assert.equal(europepmcAuthorRecord({ ...raw, title: "" }), null);
    assert.equal(europepmcAuthorRecord({ title: "x" }), null);
    assert.equal(europepmcAuthorRecord(null), null);
  });
});

describe("arxivAuthorRecord", () => {
  const entry = {
    id: "https://arxiv.org/abs/2412.06521v2",
    title: "Ancient DNA from Lycoptera Fossils",
    summary: "  Evolutionary   insights. ",
    authors: ["Wan-Qian Zhao", "Zhan-Yong Guo"],
    categories: ["q-bio.GN", "q-bio.PE"],
    published: "2024-12-09T10:00:00Z",
  };

  test("normalizes the id and builds the abs URL", () => {
    const rec = arxivAuthorRecord(entry);
    assert.equal(rec.id, "2412.06521");
    assert.equal(rec.url, "https://arxiv.org/abs/2412.06521");
  });

  test("keeps every author and the primary category", () => {
    const rec = arxivAuthorRecord(entry);
    assert.deepEqual(rec.authors, ["Wan-Qian Zhao", "Zhan-Yong Guo"]);
    assert.equal(rec.primary_category, "q-bio.GN");
    assert.equal(rec.date, "2024-12-09");
  });

  test("an entry with no id or no title is dropped", () => {
    assert.equal(arxivAuthorRecord({ ...entry, id: "" }), null);
    assert.equal(arxivAuthorRecord({ ...entry, title: "  " }), null);
  });
});

describe("interleaveAuthorRecords", () => {
  const rec = (id) => ({ corpus: "pubmed", id, title: `t${id}` });

  test("alternates the two sorts so neither spends the whole cap", () => {
    const out = interleaveAuthorRecords([rec("1"), rec("2")], [rec("9"), rec("8")], 4);
    assert.deepEqual(out.map((r) => r.id), ["1", "9", "2", "8"]);
  });

  test("de-duplicates across the two sorts", () => {
    const out = interleaveAuthorRecords([rec("1"), rec("2")], [rec("1"), rec("3")], 10);
    assert.deepEqual(out.map((r) => r.id), ["1", "2", "3"]);
  });

  test("respects the cap", () => {
    const many = Array.from({ length: 40 }, (_, i) => rec(String(i)));
    assert.equal(interleaveAuthorRecords(many, [], AUTHOR_LIMIT).length, AUTHOR_LIMIT);
  });

  test("one empty side is just the other side", () => {
    assert.deepEqual(interleaveAuthorRecords([], [rec("1")], 5).map((r) => r.id), ["1"]);
    assert.deepEqual(interleaveAuthorRecords([], [], 5), []);
  });
});

// ---------------------------------------------------------------------------
// Invariant 6 parity. The English half of a bilingual gate keeps working when
// the Swedish half is dead, so an English-only suite stays green over a broken
// feature — this asserts the pairing directly.
// ---------------------------------------------------------------------------

describe("Swedish language parity (invariant 6)", () => {
  /** Each row is the same request in both languages. */
  const PAIRS = [
    ["papers by Love Dalén", "artiklar av Love Dalén"],
    ["publications by Love Dalén", "publikationer av Love Dalén"],
    ["works by Love Dalén", "verk av Love Dalén"],
    ["research by Love Dalén", "forskning av Love Dalén"],
    ["studies by Love Dalén", "studier av Love Dalén"],
    ["what has Love Dalén published", "vad har Love Dalén publicerat"],
    ["everything Love Dalén has written", "allt Love Dalén skrivit"],
    ["Love Dalén's papers", "Love Daléns artiklar"],
    ["Love Dalén's life work", "Love Daléns livsverk"],
  ];

  for (const [en, sv] of PAIRS) {
    test(`"${en}" ⇔ "${sv}"`, () => {
      const a = authorIntent(en);
      const b = authorIntent(sv);
      assert.ok(a, `English form did not match: ${en}`);
      assert.ok(b, `Swedish form did not match: ${sv}`);
      assert.equal(a.name, b.name);
    });
  }

  test("definite and plural Swedish forms match too", () => {
    for (const text of ["artiklarna av Love Dalén", "publikationerna av Love Dalén", "studierna av Love Dalén"]) {
      assert.equal(authorIntent(text)?.name, "Love Dalén", text);
    }
  });

  test("a name carrying å/ä/ö survives the gate", () => {
    // The `\b` trap: JavaScript's word boundary is ASCII-only, so an accented
    // name at the edge of an anchored group can never match. These gates use
    // Unicode lookaround instead — src/swedish-boundary.test.js guards the rule
    // repo-wide, and this pins the case that motivated it.
    assert.equal(authorIntent("artiklar av Åsa Öberg")?.name, "Åsa Öberg");
    assert.equal(authorIntent("papers by Svante Pääbo")?.name, "Svante Pääbo");
    assert.equal(authorIntent("Öbergs artiklar")?.name, "Öberg");
  });
});
