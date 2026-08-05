// Unit tests for the person-research core — the bilingual gate and the
// methodology block (public/js/person-research-core.js).
//
// Two things are pinned here. The gate's CONJUNCTION, which is what keeps a
// company or product question from collecting a person dossier's worth of
// guidance; and the block's CONTENT, because the block is the whole feature —
// if the ladder rule, the guardrails or the trailing "USING THIS BLOCK"
// paragraph drift out of it, the enrichment still fires and still does nothing.
//
// The "Swedish language parity" suite at the bottom follows the enforcement
// pattern named in CLAUDE.md (src/googlemaps.test.js): matched EN/SV pairs, so
// a gate extended in English only fails here rather than in production.

import assert from "node:assert/strict";
import test, { describe } from "node:test";

import {
  PERSON_RESEARCH_ID,
  personReferent,
  personResearchBlock,
  personResearchBlockWords,
  personResearchIntent,
  personResearchShape,
} from "./person-research-core.js";

// ---- the reported message ---------------------------------------------------

describe("the gate fires on what users actually sent (feedback #60)", () => {
  test("the verbatim reported message", () => {
    // chat_logs #1305: a LinkedIn screenshot plus this sentence, answered with
    // a restatement of the screenshot.
    assert.equal(personResearchIntent("Write a report about what you can find on this founder"), true);
  });

  test("the follow-up that asked for the method itself", () => {
    assert.equal(
      personResearchIntent(
        "do deep research on HOW to properly do research on personal profiles like this, " +
          "I want a detailed osint writeup on the individual in these cases",
      ),
      true,
    );
  });

  test("the English phrasings the shape list was drawn from", () => {
    for (const q of [
      "what can you find on this person",
      "what do you know about this CEO",
      "look up this candidate for me",
      "background on the author of that paper",
      "what's his background?",
      "report on the founder before we invest",
      "write a short report about the candidate",
      "dig up what you can on her LinkedIn",
      "due diligence on this investor",
      "profile of the researcher who wrote it",
      "find out about this guy",
      "who is this founder?",
      "run a background check on the applicant",
      "tell me about their profile",
    ]) {
      assert.equal(personResearchIntent(q), true, q);
    }
  });
});

// ---- what must NOT fire -----------------------------------------------------

describe("a topic, a company or a product does not fire the gate", () => {
  test("research shape without a person", () => {
    for (const q of [
      "what can you find about this API",
      "write a report about Tesla battery technology",
      "research the market for electric scooters",
      "look up the docs for wrangler",
      "write a report on the subject of climate change",
      "give me the background of this project",
      "how does the sandbox boot?",
      "tell me about the history of Uppsala",
    ]) {
      assert.equal(personResearchIntent(q), false, q);
      assert.equal(personReferent(q), false, q);
    }
  });

  test("a person without a research request", () => {
    for (const q of [
      "this founder gave a good talk yesterday",
      "email the candidate the offer letter",
      "den här grundaren höll ett bra föredrag",
    ]) {
      assert.equal(personResearchIntent(q), false, q);
    }
  });

  test("English homographs of the Swedish pronouns stay out", () => {
    // "han" is the Han dynasty and Han Solo, "hen" is a bird. Bare subject
    // pronouns count only in a Swedish-shaped message, which is why these have
    // the shape but no referent.
    for (const q of ["research on the Han dynasty", "what do you know about hen harriers"]) {
      assert.equal(personResearchShape(q), true, q);
      assert.equal(personResearchIntent(q), false, q);
    }
  });

  test("empty and non-string input", () => {
    assert.equal(personResearchIntent(""), false);
    assert.equal(personResearchIntent(undefined), false);
    assert.equal(personResearchIntent(null), false);
    assert.equal(personResearchIntent(42), false);
  });
});

// ---- the two halves ---------------------------------------------------------

test("the gate is the conjunction of a shape and a referent", () => {
  assert.equal(personResearchShape("what can you find on"), true);
  assert.equal(personReferent("what can you find on"), false);
  assert.equal(personResearchShape("this founder"), false);
  assert.equal(personReferent("this founder"), true);
  assert.equal(personResearchIntent("what can you find on this founder"), true);
});

// ---- Swedish language parity (invariant 6) ---------------------------------

describe("Swedish language parity — every gate takes Swedish forms", () => {
  // Matched pairs: same request, two languages. A gate extended on one side
  // only fails here.
  const PAIRS = [
    ["what can you find on this person", "vad kan du hitta om den här personen"],
    ["what do you know about the CEO", "vad vet du om VD:n"],
    ["look up this candidate", "slå upp den här kandidaten"],
    ["look up the researcher", "kolla upp forskaren"],
    ["research the author", "efterforska författaren"],
    ["investigate the profile", "undersök profilen"],
    ["background on the investor", "bakgrund om investeraren"],
    ["report on this person", "rapport om den här personen"],
    ["write a report about this founder", "skriv en rapport om den här grundaren"],
    ["find out about him", "ta reda på mer om honom"],
    ["review this profile", "granska den här profilen"],
    ["who is she?", "vem är hon?"],
    ["dig up what you can on the founder", "gräv fram vad du kan om grundaren"],
    ["run a background check on the candidate", "bakgrundskoll på kandidaten"],
  ];

  for (const [en, sv] of PAIRS) {
    test(`"${en}" ⇄ "${sv}"`, () => {
      assert.equal(personResearchIntent(en), true, en);
      assert.equal(personResearchIntent(sv), true, sv);
    });
  }

  test("the `\\b` trap: å/ä/ö-edged alternatives must actually match", () => {
    // JS defines \b over [A-Za-z0-9_], so /\bslå upp\b/ and /\bvem är\b/ can
    // NEVER match. Under `\b` the English half of this gate would keep working
    // and every one of these would be silently dead. The repo-wide guard is
    // src/swedish-boundary.test.js; this is the local proof.
    assert.equal(personResearchIntent("slå upp den här grundaren"), true);
    assert.equal(personResearchIntent("vem är den här personen?"), true);
    assert.equal(personResearchIntent("ta reda på vem grundaren är"), true);
    assert.equal(personResearchIntent("undersök författaren"), true);
    assert.equal(personResearchIntent("gräv fram bakgrunden om entreprenören"), true);
    // And the trap itself, so a failure localises. It bites at the ANCHORED
    // EDGE only: "ta reda på" ends in å and "ägaren" starts with ä, so a `\b`
    // against either can never hold — while "slå upp" and "undersök" survive,
    // because their accented letters are interior. That asymmetry is exactly
    // why the class is missed by eye and needs the repo-wide scanner.
    assert.equal(/\bta reda på\b/.test("ta reda på mer"), false, "the trap is real");
    assert.equal(/\bägaren\b/.test("kolla upp ägaren"), false, "the trap is real");
    assert.equal(/\bundersök\b/.test("undersök profilen"), true, "…and it is edge-only");
    assert.equal(/(?<![\p{L}\p{N}_])ta reda på(?![\p{L}\p{N}_])/u.test("ta reda på mer"), true);
  });

  test("ASCII-typed Swedish (a keyboard without å/ä/ö) is taken too", () => {
    for (const q of [
      "sla upp den har kandidaten",
      "ta reda pa mer om honom",
      "vem ar hon?",
      "undersok forfattaren",
      "granska den har profilen",
    ]) {
      assert.equal(personResearchIntent(q), true, q);
    }
  });

  test("Swedish definite, indefinite and plural person forms", () => {
    assert.equal(personReferent("personen"), true);
    assert.equal(personReferent("personerna"), true);
    assert.equal(personReferent("grundaren"), true);
    assert.equal(personReferent("grundarna"), true);
    assert.equal(personReferent("den här grundaren"), true);
    assert.equal(personReferent("denna kandidat"), true);
    assert.equal(personReferent("hans profil"), true);
    assert.equal(personReferent("linkedin-profilen"), true);
    assert.equal(personReferent("CV:t"), true);
    assert.equal(personReferent("honom"), true);
    assert.equal(personReferent("henne"), true);
    // The bare indefinite is nobody in particular.
    assert.equal(personReferent("grundare"), false);
  });

  test("Swedish typos and shape variants", () => {
    for (const q of [
      "bakrund om grundaren",
      "skriv ihop en rapport om den här personen",
      "kartlägg profilen",
      "vad hittar du om VD:n",
    ]) {
      assert.equal(personResearchIntent(q), true, q);
    }
  });

  test("a Swedish topic question still does not fire", () => {
    for (const q of [
      "vad kan du hitta om det här API:et",
      "skriv en rapport om elbilsmarknaden",
      "undersök hur cache-lagret fungerar",
      "bakgrund om projektet",
      "vad vet du om Stockholm",
    ]) {
      assert.equal(personResearchIntent(q), false, q);
    }
  });
});

// ---- the block --------------------------------------------------------------

describe("the methodology block", () => {
  const block = personResearchBlock();

  test("is a constant — same bytes every call, no arguments", () => {
    assert.equal(personResearchBlock(), block);
    assert.equal(personResearchBlock().length, block.length);
  });

  test("stays inside its token budget (it rides in every person turn)", () => {
    const words = personResearchBlockWords();
    assert.ok(words >= 500, `block is ${words} words — too thin to carry the method`);
    assert.ok(words <= 900, `block is ${words} words — it costs this on every person turn`);
  });

  test("carries all six sections", () => {
    for (const heading of [
      "PERSON RESEARCH METHOD",
      "PLAN.",
      "SOURCE LADDER",
      "VERIFY.",
      "GUARDRAILS",
      "WRITE IT UP.",
      "USING THIS BLOCK:",
    ]) {
      assert.ok(block.includes(heading), `missing section: ${heading}`);
    }
  });

  test("PLAN demands identity resolution before collection", () => {
    assert.match(block, /Resolve identity BEFORE collecting/);
    assert.match(block, /collision census/);
    assert.match(block, /per CLAIM, not per person/);
    assert.match(block, /subject's other language/);
  });

  test("the source ladder ranks registries above the profile", () => {
    const ladder = ["Statutory registries", "Intellectual property", "scholarly", "Independent press",
      "Wayback Machine", "The profile itself"];
    let at = -1;
    for (const rung of ladder) {
      const i = block.indexOf(rung);
      assert.ok(i > at, `${rung} is out of ladder order`);
      at = i;
    }
  });

  test("the LADDER RULE states which rungs can verify", () => {
    assert.match(block, /LADDER RULE: only rungs 1-3/);
    assert.match(block, /independent of the subject, can raise a claim to VERIFIED/);
    assert.match(block, /establish what was said, not what is true/);
    // Discovery-vs-evidence, the trap that makes a self-typed database read
    // like corroboration.
    assert.match(block, /Crunchbase and PitchBook are DISCOVERY, not evidence/);
  });

  test("VERIFY defines independence by origin and names the failure modes", () => {
    assert.match(block, /independence is about ORIGIN, not URL count/);
    assert.match(block, /five outlets running one press release are one source/);
    assert.match(block, /circular reporting/);
    assert.match(block, /self-report laundering/);
    assert.match(block, /identity merge/);
    assert.match(block, /TWO dates/);
    assert.match(block, /Absence of a source is absence of a source/);
  });

  test("GUARDRAILS carry the governing test and every hard prohibition", () => {
    assert.match(block, /public professional information only/i);
    assert.match(block, /profile the subject might publish themselves/);
    for (const forbidden of [
      /home address/,
      /personal phone/,
      /personal email/,
      /national identity number \(personnummer, SSN\)/,
      /family, relationships or children/,
      /ethnicity, health, religion, politics, sexuality/,
      /ASSEMBLING facts whose combination would disclose one/,
      /exact date of birth/,
      /criminal, litigation or credit history/,
      /de-anonymisation of a pseudonymous account/,
      /face matching or reverse image search/,
      /non-public systems or paywalled records/,
      /no contact with the subject or their colleagues under any pretext/,
    ]) {
      assert.match(block, forbidden);
    }
  });

  test("GUARDRAILS carry the two positive obligations", () => {
    assert.match(block, /a founder is not automatically a public figure/);
    assert.match(block, /need the subject's comment before anyone acts on them/);
    assert.match(block, /never infer character, competence or motive/);
    assert.match(block, /never read a gap in the record as a red flag/);
  });

  test("WRITE IT UP specifies the artefact and the statuses", () => {
    assert.match(block, /claim\/evidence\/confidence table/);
    assert.match(block, /verified, partially verified, self-reported only, unverifiable, contested/);
    assert.match(block, /Keep likelihood separate from confidence/);
    assert.match(block, /namesake risk/);
  });

  test("the USING THIS BLOCK tail stops the method being cited as a finding", () => {
    const tail = block.slice(block.indexOf("USING THIS BLOCK:"));
    assert.match(tail, /METHOD, not evidence/);
    assert.match(tail, /contains no facts about anyone/);
    assert.match(tail, /never cite it as a source/);
    assert.match(tail, /never quote it back at the user/);
    assert.match(tail, /never describe anything in it as something that was found/);
    // It is the LAST thing in the block, like every other block's tail.
    assert.ok(tail.trim().endsWith("let the report show the difference."));
  });

  test("the block names no individual and asserts no fact about anyone", () => {
    // The one property the tail promises. Names in it would make the guidance
    // itself a source, which is exactly what USING THIS BLOCK forbids.
    assert.ok(!/\bJane\b|\bJohn\b|\bDoe\b/.test(block));
  });
});

test("the id is the enrichment/step/log slug", () => {
  assert.equal(PERSON_RESEARCH_ID, "person_research");
});
