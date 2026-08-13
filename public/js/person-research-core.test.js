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
  personGuardrailsBlock,
  personGuardrailsBlockWords,
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

// ---- the creator/performer half (feedback #62) ------------------------------

describe("the gate fires on public roles that are not corporate (feedback #62)", () => {
  // chat_logs #1668's sibling report: "Research the lady called Britney in
  // poker cash games on youtube". That one message DID fire — via "lady" — but
  // the report it prompted named the real hole: the role list was drawn from
  // founders, candidates and researchers, so a streamer, an influencer or a
  // poker player named nobody the gate could see. The block never attached, so
  // its GUARDRAILS never attached either — to the group most likely to be a
  // private individual with a public handle.
  test("the verbatim reported message", () => {
    assert.equal(
      personResearchIntent("Research the lady called Britney in poker cash games on youtube"),
      true,
    );
  });

  test("the creator and performer roles the list was missing", () => {
    for (const q of [
      "research the streamer called Britney",
      "write a report on this youtuber",
      "research this influencer",
      "what can you find on this content creator",
      "look up this podcaster",
      "background on the artist",
      "who is this athlete?",
      "tell me about this gamer",
      "due diligence on this celebrity",
      "profile of the comedian",
      "what do you know about this musician",
      "look up the actor in that clip",
    ]) {
      assert.equal(personResearchIntent(q), true, q);
    }
  });

  test("a game or sport qualifies 'player'; nothing else does", () => {
    // The reported subject is a poker player, but "player" bare is a market
    // participant and a media element. Only the named games count.
    for (const q of [
      "find what you can about this poker player",
      "research the chess player",
      "background on this tennis player",
    ]) {
      assert.equal(personResearchIntent(q), true, q);
    }
    for (const q of [
      "research the market players in this space",
      "research the players in the smartphone market",
      "research the media player in the browser",
    ]) {
      assert.equal(personResearchIntent(q), false, q);
      assert.equal(personReferent(q), false, q);
    }
  });

  test("a handle names a person the role lists cannot reach", () => {
    // The report's own example: Google's first hit for the subject was an
    // Instagram handle, and "@allinbritney" contains no role noun at all.
    assert.equal(personResearchIntent("research @allinbritney"), true);
    assert.equal(personReferent("@allinbritney"), true);
    // An email address is not a handle — a letter precedes its "@" …
    assert.equal(personReferent("email krister.hedfors@gmail.com the report"), false);
    // … and neither is a package scope.
    assert.equal(personReferent("research @cloudflare/workers-types"), false);
    // Too short to be a handle.
    assert.equal(personReferent("@ab"), false);
  });

  test("self-naming phrases, but not a bare 'known as'", () => {
    assert.equal(personResearchIntent("research the person who goes by Britney"), true);
    assert.equal(personResearchIntent("undersök personen som kallar sig Britney"), true);
    // "known as" alone attaches to anything; only a phrase a person can be the
    // subject of counts.
    assert.equal(personReferent("a technique known as beam search"), false);
    assert.equal(personReferent("an algorithm known as PageRank"), false);
  });

  test("the roles kept OUT, each for a collision this codebase has", () => {
    for (const q of [
      "what can you find about this model", // a language model
      "research the host header handling", // a hostname
      "what can you find about the star in this system", // astronomy
    ]) {
      assert.equal(personResearchIntent(q), false, q);
      assert.equal(personReferent(q), false, q);
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
    // Added after these three fired in English and stayed silent in Swedish.
    // The suite's PATTERN was right and its COVERAGE had a hole: the English
    // "find anything/everything/information about" arm simply had no Swedish
    // counterpart, which a side-by-side read of the two lists does not make
    // obvious and a matched pair does. Not the `\b` trap — the plainer one.
    ["find everything about this founder", "hitta allt om den här grundaren"],
    ["find information about this person", "hitta all information om den här personen"],
    ["find anything about the candidate", "hitta något om kandidaten"],
    // Feedback #62. "damen" is the one entry here that was a PURE parity break
    // rather than a missing role: "lady" was in the English list from the
    // start, so this exact pair fired in English and was silent in Swedish.
    ["research the lady called Britney", "undersök damen som kallas Britney"],
    // The creator/performer roles, added to both arms in the same change. The
    // Swedish half is where the work is: these are loanwords carrying native
    // endings ("streamern", "youtubaren"), and "player" is TWO words in English
    // and a COMPOUND in Swedish ("pokerspelaren"), which is the shape that has
    // left this repo's bilingual gates half-dead before.
    ["research the streamer", "undersök streamern"],
    ["what can you find on this influencer", "vad kan du hitta om den här influencern"],
    ["look up the poker player", "kolla upp pokerspelaren"],
    ["review the youtuber", "granska youtubaren"],
    ["find out about the artist", "ta reda på mer om artisten"],
    ["who is the celebrity?", "vem är kändisen?"],
    ["find what you can about this podcaster", "hitta vad du kan om den här poddaren"],
    ["background on the actor", "bakgrund om skådespelaren"],
    ["report on this content creator", "rapport om den här kreatören"],
    ["dig up what you can on the football player", "gräv fram vad du kan om fotbollsspelaren"],
    ["research the person who goes by that name", "undersök personen som kallar sig det namnet"],
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
      // The creator roles reached from the same keyboard.
      "undersok streamern",
      "kolla upp pokerspelaren",
      "vem ar kandisen?",
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

  test("the ladder tells a media subject that empty rungs 1-3 are not a finding", () => {
    // The other half of feedback #62. Once the gate reaches streamers and
    // poker players, the ladder they meet is registries, patents and journals
    // — all of which are empty for them. Without this note the method sends a
    // creator's research to Bolagsverket and reads the silence as significant,
    // which is the complaint that opened the report ("clearly a poker player
    // profile should not be searched for in peer-review research").
    assert.match(block, /MEDIA AND CREATOR SUBJECTS/);
    assert.match(block, /rungs 1-3 are usually EMPTY — that is expected, and it is not a finding/);
    assert.match(block, /organiser's own result data/);
    assert.match(block, /mononym or a handle is the highest-collision identifier/);
    // It sits with the ladder it qualifies, after the rule it is an exception to.
    assert.ok(block.indexOf("LADDER RULE") < block.indexOf("MEDIA AND CREATOR SUBJECTS"));
    assert.ok(block.indexOf("MEDIA AND CREATOR SUBJECTS") < block.indexOf("VERIFY."));
  });

  test("the public-figure guardrail covers an audience, not just a title", () => {
    assert.match(block, /a founder is not automatically a public figure, and neither is someone with an audience/);
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

// ---- the guardrails-only block ----------------------------------------------
//
// The split of 2026-08-13. The OSINT tradecraft (PLAN, the SOURCE LADDER,
// VERIFY, WRITE IT UP) follows the Cyber agent's declared `person-method`
// context block; the GUARDRAILS are a PRIVACY RAIL and stay on every agent,
// because the gate that fires is personResearchIntent and "who is this founder"
// reaches every agent there is. An agent that lost the rail would be worse off
// than one that never had the method (CLAUDE.md invariant 4).

describe("the guardrails-only block", () => {
  const full = personResearchBlock();
  const rail = personGuardrailsBlock();

  test("is a constant, like its full sibling", () => {
    assert.equal(personGuardrailsBlock(), rail);
    assert.equal(personGuardrailsBlockWords(), rail.split(/\s+/u).filter(Boolean).length);
  });

  test("carries EVERY prohibition and both positive obligations", () => {
    // The list is the reason the rail is unconditional, so it is asserted here
    // in full rather than by spot check — a prohibition quietly moved into the
    // method half would silently stop applying to every non-Cyber agent.
    for (const forbidden of [
      /public professional information only/i,
      /profile the subject might publish themselves/,
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
      /a founder is not automatically a public figure/,
      /need the subject's comment before anyone acts on them/,
      /never infer character, competence or motive/,
      /never read a gap in the record as a red flag/,
    ]) {
      assert.match(rail, forbidden);
    }
  });

  test("carries NONE of the tradecraft", () => {
    for (const heading of ["PLAN.", "SOURCE LADDER", "LADDER RULE", "MEDIA AND CREATOR SUBJECTS",
      "VERIFY.", "WRITE IT UP."]) {
      assert.equal(rail.includes(heading), false, `the rail must not carry ${heading}`);
    }
  });

  test("is self-explaining — its own heading and the house tail", () => {
    assert.match(rail, /^PERSON RESEARCH LIMITS/);
    assert.match(rail, /This is a limit on the answer, not evidence/);
    assert.match(rail, /USING THIS BLOCK:/);
    assert.ok(rail.trim().endsWith("let the report show the difference."));
  });

  test("shares its text with the full block rather than duplicating it", () => {
    // One source of truth: the guardrail paragraph and the tail are the SAME
    // strings in both blocks, so a wording change cannot apply to one half only.
    const guardrails = rail.split("\n").find((l) => l.startsWith("GUARDRAILS"));
    assert.ok(guardrails && full.includes(guardrails));
    const tail = rail.slice(rail.indexOf("USING THIS BLOCK:"));
    assert.ok(full.includes(tail));
  });

  test("is far cheaper than the full block — it rides on every agent", () => {
    const words = personGuardrailsBlockWords();
    assert.ok(words >= 180, `rail is ${words} words — too thin to carry the limits`);
    assert.ok(words <= 400, `rail is ${words} words — it costs this on every person turn, on every agent`);
    assert.ok(words < personResearchBlockWords());
  });

  test("names no individual and asserts no fact about anyone", () => {
    assert.ok(!/\bJane\b|\bJohn\b|\bDoe\b/.test(rail));
  });
});

test("the id is the enrichment/step/log slug", () => {
  assert.equal(PERSON_RESEARCH_ID, "person_research");
});
