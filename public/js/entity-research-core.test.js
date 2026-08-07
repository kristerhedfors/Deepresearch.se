// Unit tests for the entity-research core (public/js/entity-research-core.js):
// the OSINT-class intent gate, the subject-resolution rule, and the report
// scaffold that scales with the research-time tier.
//
// Written against feedback #64 the way person-research-core.test.js is written
// against #60 and #62 — the reported message is a test, the reported failure is
// a test, and every deliberate exclusion is pinned as a negative assertion so a
// later widening has to argue with a named case rather than a silence.

import assert from "node:assert/strict";
import test, { describe } from "node:test";

import {
  ENTITY_RESEARCH_ID,
  entityResearchBlock,
  entityResearchBlockWords,
  entityResearchIntent,
} from "./entity-research-core.js";

// ---- the gate ---------------------------------------------------------------

describe("the gate fires on what the user actually sent (feedback #64)", () => {
  test("the verbatim reported message", () => {
    assert.equal(entityResearchIntent("Osint on revsec"), true);
  });

  // The whole point of this gate: "revsec" is a bare token. It carries no role
  // word, no company suffix, no pronoun and no honorific, so person-research's
  // referent test cannot classify it — and it turned out to name four unrelated
  // organisations. A gate that required a classifiable subject would be silent
  // on exactly the request that needs the rule.
  test("an unclassifiable bare name is enough — no referent is required", () => {
    for (const q of ["Osint on revsec", "osint revsec", "OSINT on acme", "due diligence on revsec"]) {
      assert.equal(entityResearchIntent(q), true, q);
    }
  });

  test("the English dossier phrasings", () => {
    const queries = [
      "osint on Acme Inc",
      "OSYNT on revsec", // the observed keyboard slip person-research also carries
      "open source intelligence on Palantir",
      "open-source intelligence about this supplier",
      "run due diligence on Nordea before we sign",
      "KYC on this counterparty",
      "background check on the vendor",
      "background-check this company",
      "vetting our new supplier",
      "give me a dossier on Palantir",
      "threat intelligence on our payment provider",
      "threat intel report on Acme",
      "cyber threat intelligence for the bank",
      "a TIBER-style intelligence report on our bank",
      "intelligence assessment of this contractor",
      "an intelligence profile on the group",
      "map the attack surface of example.com",
      "what is their external footprint",
      "digital footprint of Acme AB",
      "adversary profile for this sector",
    ];
    for (const q of queries) assert.equal(entityResearchIntent(q), true, q);
  });
});

describe("what the gate deliberately keeps out", () => {
  // The gate stands ALONE — it is not ANDed with a referent the way
  // person-research's is — so its phrase list has to be narrow enough that
  // standing alone is safe. The ordinary research vocabulary of every other
  // turn this pipeline serves is the thing it must never claim.
  test("ordinary research requests are not dossiers", () => {
    const queries = [
      "report on climate change",
      "write me a report about Tesla battery technology",
      "research the history of Rome",
      "look up the population of Malmö",
      "what can you find on this API",
      "who is Ada Lovelace",
      "tell me about the founder of Spotify",
      "profile of a typical customer",
      "summarize this pdf",
      "list files in /workspace",
    ];
    for (const q of queries) assert.equal(entityResearchIntent(q), false, q);
  });

  test("Swedish topic questions are not dossiers either", () => {
    const queries = [
      "skriv en rapport om klimatet",
      "vad säger forskningen om diabetes",
      "undersök Roms historia",
      "vem är Ada Lovelace",
      "bakgrunden till andra världskriget",
    ];
    for (const q of queries) assert.equal(entityResearchIntent(q), false, q);
  });

  test("empty and non-string input", () => {
    for (const v of ["", "   ", null, undefined, 0, {}, []]) {
      assert.equal(entityResearchIntent(/** @type {any} */ (v)), false, String(v));
    }
  });
});

// ---- invariant 6 ------------------------------------------------------------

describe("Swedish language parity — the gate takes Swedish forms at equal breadth", () => {
  // Matched pairs, the enforcement shape CLAUDE.md names (the "Swedish language
  // parity" suite in src/googlemaps.test.js). Each row must fire in BOTH
  // languages: a phrasing added to one arm without its counterpart is the
  // regression this table exists to catch.
  const PAIRS = [
    ["background check on Acme", "bakgrundskoll på Acme"],
    ["background check on the supplier", "bakgrundskontroll av leverantören"],
    ["vetting this company", "bakgrundsundersökning av det här företaget"],
    ["open source intelligence on Acme", "underrättelser från öppna källor om Acme"],
    ["intelligence report on Acme", "underrättelserapport om Acme"],
    ["what is in open sources about them", "vad finns i öppna källor om dem"],
    ["threat intelligence for our supplier", "hotbild för vår leverantör"],
    ["threat analysis for the sector", "hotanalys för sektorn"],
    ["threat assessment of the supplier", "hotbedömning av leverantören"],
    ["map the company Acme", "kartläggning av företaget Acme"],
    ["attack surface of example.com", "angreppsyta för example.com"],
    ["attack surface of the domain", "attackyta för domänen"],
    ["digital footprint of Acme", "digitalt fotavtryck för Acme"],
    ["external footprint of Acme", "fotavtryck på internet för Acme"],
    ["background check on the supplier", "personkontroll av leverantören"],
    ["company check on Acme", "företagskontroll av Acme"],
  ];
  for (const [en, sv] of PAIRS) {
    test(`"${en}" ⇄ "${sv}"`, () => {
      assert.equal(entityResearchIntent(en), true, `EN arm silent: ${en}`);
      assert.equal(entityResearchIntent(sv), true, `SV arm silent: ${sv}`);
    });
  }

  // The `\b` trap, demonstrated live. JavaScript defines \b over [A-Za-z0-9_],
  // so an alternative edged by å/ä/ö can NEVER match with \b — the Swedish half
  // of a gate dies silently while the English half keeps working. Every
  // alternative here is å/ä/ö-edged or å/ä/ö-adjacent on purpose.
  test("the `\\b` trap: å/ä/ö-edged alternatives must actually match", () => {
    for (const q of [
      "underrättelser om Acme",
      "öppna källor om Acme",
      "hotbedömning av Acme",
      "kartläggning av organisationen Acme",
      "bakgrundsundersökning av Acme",
    ]) {
      assert.equal(entityResearchIntent(q), true, q);
    }
    // The trap made concrete: this is what the same pattern would do with \b.
    assert.equal(/\bunderrättelse\b/iu.test("underrättelser om Acme"), false);
  });

  // A phone keyboard without Swedish letters is a common way this gate is
  // addressed in practice, so every accented alternative carries its ASCII twin.
  test("ASCII-typed Swedish is taken too", () => {
    for (const q of [
      "underrattelser om Acme",
      "oppna kallor om Acme",
      "kartlaggning av foretaget Acme",
      "angreppsyta for example.com",
    ]) {
      assert.equal(entityResearchIntent(q), true, q);
    }
  });
});

// ---- the subject-resolution rule -------------------------------------------

describe("the subject-resolution rule", () => {
  test("it is present at every tier", () => {
    for (const tier of ["brief", "standard", "extended", "full"]) {
      assert.match(entityResearchBlock(tier), /SUBJECT RESOLUTION/, tier);
    }
  });

  // The reported failure, stated as a prohibition: "Osint on revsec" produced
  // one report covering four unrelated organisations.
  test("a merged report is forbidden, and the reason is given", () => {
    const b = entityResearchBlock();
    assert.match(b, /do NOT write a merged report/);
    assert.match(b, /do NOT silently pick one/i);
    assert.match(b, /confidently wrong about every one of them/);
    // Why it matters beyond tidiness: the conflicting figures the reported
    // answer spent a section reconciling were an artefact of the merge.
    assert.match(b, /artefact of the merge/);
  });

  // The reporter's actual ask: "you must ask WHICH of the identified entities
  // to produce an osint report for".
  test("the ask is a question turn, with the candidates and their sources", () => {
    const b = entityResearchBlock();
    assert.match(b, /one line per candidate/);
    assert.match(b, /bracketed source number/);
    assert.match(b, /ONE closing question/);
    assert.match(b, /numbered options/);
    // It is a question, not a report with a question stapled to it.
    assert.match(b, /It is a question, not the report/);
    assert.match(b, /Do not append a partial profile/);
  });

  // Over-clarifying is this project's most reported failure mode (feedback #47:
  // three clarifying turns in a row with web search on and not one query run;
  // feedback #58: a clarifying question asked over an already-playing demo).
  // Both brakes are pinned here, because a rule that says "ask" without them is
  // how this fix becomes the next complaint.
  test("the brakes: an anchor already given resolves it, and it never asks twice", () => {
    const b = entityResearchBlock();
    assert.match(b, /UNLESS the request already resolves it/);
    assert.match(b, /Asking for something already supplied is the worst outcome/);
    assert.match(b, /Never ask twice/);
    assert.match(b, /profile the best-supported candidate/);
  });

  // The ask is POST-search and evidence-bound: it happens over sources that
  // came back, never as a guess made before looking. That is what separates it
  // from the triage-time clarify the pipeline already has.
  test("the count is made over retrieved sources, not guessed up front", () => {
    const b = entityResearchBlock();
    assert.match(b, /numbered sources you actually retrieved/);
    assert.match(b, /ONE subject carries the name/);
  });

  test("a resolved subject still reports the collision", () => {
    assert.match(entityResearchBlock(), /the collision itself is a finding/);
  });
});

// ---- the depth scaffold -----------------------------------------------------

describe("the report scales with the research-time tier (feedback #64)", () => {
  test("each tier states its own depth and no other", () => {
    const headers = {
      brief: /REPORT DEPTH — BRIEF/,
      standard: /REPORT DEPTH — PROFILE/,
      extended: /REPORT DEPTH — INTELLIGENCE PROFILE/,
      full: /REPORT DEPTH — TARGETED THREAT INTELLIGENCE REPORT/,
    };
    for (const [tier, own] of Object.entries(headers)) {
      const b = entityResearchBlock(tier);
      assert.match(b, own, tier);
      for (const [other, re] of Object.entries(headers)) {
        if (other !== tier) assert.doesNotMatch(b, re, `${tier} must not carry ${other}'s header`);
      }
    }
  });

  test("comprehensiveness actually increases with the tier", () => {
    const w = (/** @type {string} */ t) => entityResearchBlockWords(t);
    assert.ok(w("brief") < w("extended"), "brief must ask for less than extended");
    assert.ok(w("extended") < w("full"), "extended must ask for less than full");
  });

  // The shallow end is a REDUCED version of the same report, not a different
  // document — "if more shallow, a reduced scaled down version". So the deepest
  // tier's apparatus must be absent from the shallowest, and the subject
  // question must be answered at both.
  test("the brief tier drops the apparatus but keeps the subject", () => {
    const b = entityResearchBlock("brief");
    assert.match(b, /compact brief, not a report/);
    assert.match(b, /No headings, no tables, no threat-scenario work/);
    assert.doesNotMatch(b, /MITRE/);
    assert.doesNotMatch(b, /Executive summary/);
  });

  test("an unknown or missing tier falls back to standard (fail-soft)", () => {
    assert.equal(entityResearchBlock("bogus"), entityResearchBlock("standard"));
    assert.equal(entityResearchBlock(), entityResearchBlock("standard"));
    assert.equal(entityResearchBlock(/** @type {any} */ (null)), entityResearchBlock("standard"));
  });

  test("every tier drops sections the sources cannot support", () => {
    for (const tier of ["extended", "full"]) {
      assert.match(entityResearchBlock(tier), /drop any (?:section )?the sources cannot support/, tier);
    }
  });
});

describe("the full tier is a TIBER-EU report's structure, and says what it is not", () => {
  // Verified against the ECB's Targeted Threat Intelligence Report Guidance
  // (January 2025): Chapter 2's required content, the example headings TIBER-NO
  // publishes (the ECB itself prescribes no template — §4 permits any format),
  // and MITRE ATT&CK, which the 2025 edition names outright.
  test("it carries the report's content contract", () => {
    const b = entityResearchBlock("full");
    for (const section of [
      /Executive summary/,
      /Scope of the research/,
      /Business overview from an intelligence perspective/,
      /Digital presence/,
      /Threat actors/,
      /Threat scenarios/,
      /Assessment and confidence/,
      /Gaps and limitations/,
    ]) {
      assert.match(b, section);
    }
    assert.match(b, /people, processes and technology/);
    assert.match(b, /availability, integrity and confidentiality/);
    assert.match(b, /why the actors you excluded were excluded/);
  });

  test("MITRE ATT&CK is named, and named as the technique reference", () => {
    const b = entityResearchBlock("full");
    assert.match(b, /MITRE ATT&CK tactics and techniques by identifier/);
    assert.match(b, /actor \/ objective \/ tactic \/ technique \/ procedure/);
  });

  // No primary source in the TIBER family carries these — they belong to the
  // CBEST/STAR-FS lineage or to other traditions entirely. Presenting them as
  // TIBER requirements teaches the model to write a confident forgery, so each
  // is pinned OUT by name.
  test("frameworks TIBER does not require are not smuggled in", () => {
    const b = entityResearchBlock("full");
    for (const absent of [/STIX/, /MISP/i, /Admiralty/i, /5x5x5/, /ICD 203/, /kill chain/i, /Diamond Model/i]) {
      assert.doesNotMatch(b, absent, `not a TIBER requirement: ${absent}`);
    }
  });

  // The load-bearing line, and the reason this tier can ship at all. A real
  // TIBER TTI report is written under contract, with the entity's consent, by
  // an engaged provider whose active reconnaissance is a red team's job — the
  // ECB is explicit that the intelligence provider may look up an entity's
  // addresses but may not port-scan them. This pipeline reads public sources
  // for a reader who may have no relationship with the subject at all.
  test("it refuses to imply an engagement that does not exist", () => {
    const b = entityResearchBlock("full");
    assert.match(b, /SCOPE HONESTY, and this one is not optional/);
    assert.match(b, /desk study built from public sources/);
    assert.match(b, /NOT a commissioned TIBER-EU engagement/);
    assert.match(b, /no consent from the subject/);
    assert.match(b, /scanning, probing, logging in, buying data/);
    assert.match(b, /Do not present findings as tested/);
  });
});

// ---- the block as an artefact ----------------------------------------------

describe("the block", () => {
  test("is a pure function of the tier — same tier, same bytes", () => {
    assert.equal(entityResearchBlock("full"), entityResearchBlock("full"));
    assert.notEqual(entityResearchBlock("full"), entityResearchBlock("brief"));
  });

  // It rides in every dossier turn, and at full depth it rides ALONGSIDE
  // person-research's ~875 words on an OSINT question about a named individual.
  // The cap is what forces the next thing added here to displace something.
  test("stays inside its token budget at every tier", () => {
    for (const tier of ["brief", "standard", "extended", "full"]) {
      const words = entityResearchBlockWords(tier);
      assert.ok(words >= 300, `${tier} suspiciously small: ${words}`);
      assert.ok(words <= 1000, `${tier} over budget: ${words}`);
    }
  });

  // person-research learned this the hard way: without the tail, a model cites
  // the method block among its findings or lists it under "Sources:".
  test("the tail stops the method being reported as a finding", () => {
    const b = entityResearchBlock();
    assert.match(b, /it is method, not evidence/);
    assert.match(b, /Never quote it, cite it, list it as a source/);
    assert.match(b, /apply it silently/);
  });

  // The block is appended to the USER's message, so it is read in a position
  // where a model could mistake it for something the user wrote.
  test("it announces itself as context rather than a user message", () => {
    assert.match(entityResearchBlock(), /context for the assistant, not a message from the user/);
  });

  test("it names no subject and asserts no fact about anyone", () => {
    const b = entityResearchBlock("full");
    // The one proper noun that appears is the framework the owner named, plus
    // the illustration of an anchor. Nothing here is a claim about a subject.
    assert.doesNotMatch(b, /revsec/i);
    assert.match(b, /TIBER-EU/);
  });

  test("the id is the enrichment/step/log slug", () => {
    assert.equal(ENTITY_RESEARCH_ID, "entity_research");
  });
});
