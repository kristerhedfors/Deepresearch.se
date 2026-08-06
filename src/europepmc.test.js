// Unit tests for the Europe PMC search source (src/europepmc.js).
//
// The query semantics pinned here were established by probing the live
// endpoint (2026-07-29) — the measured hit counts are in the module header.
// The one that shapes every test below: Europe PMC's default operator is AND
// and quoted phrases work, which is the OPPOSITE of arXiv on both counts. So
// the ladder must climb by DROPPING terms, and a test that assumed arXiv's
// widening ladder would pass while the source returned nothing in production.
import test from "node:test";
import assert from "node:assert/strict";

import {
  EUROPEPMC_LEAD_MAX_PER_REQUEST,
  EUROPEPMC_MAX_PER_REQUEST,
  europepmcConcepts,
  europepmcDiversityKey,
  europepmcIntent,
  europepmcLadder,
  europepmcLeadIntent,
  europepmcPickQuery,
  europepmcSearch,
  europepmcTermKey,
  europepmcTerms,
  toItem,
} from "./europepmc.js";

const log = { info() {}, warn() {}, error() {}, debug() {} };

test("europepmcIntent", async (t) => {
  await t.test("fires on named archives", () => {
    for (const s of [
      "what does pubmed say about ancient dna",
      "search Europe PMC for mammoth genomes",
      "any biorxiv preprints on sedaDNA?",
      "kolla medRxiv",
    ]) assert.equal(europepmcIntent(s), true, s);
  });

  await t.test("fires on unmistakable subject matter alone", () => {
    for (const s of [
      "how old is the oldest ancient DNA?",
      "what did the Neanderthal genome change about us",
      "woolly mammoth population size before extinction",
      "explain palaeoproteomics",
    ]) assert.equal(europepmcIntent(s), true, s);
  });

  await t.test("Swedish parity — the same breadth, not a token gesture", () => {
    for (const s of [
      "hur gammalt är det äldsta forn-DNA:t?",
      "vad säger forskningen om mammutens arvsmassa",
      "finns det studier på neandertalarnas genetik",
      "berätta om paleogenomik",
      "vilka artiklar finns om kol-14-datering av megafauna",
      "vad vet vi om denisovamänniskan",
    ]) assert.equal(europepmcIntent(s), true, s);
  });

  await t.test("words starting or ending in å/ä/ö match — the \\b trap", () => {
    // JS `\b` is ASCII-only, so /\böversikt/ can NEVER match " översikt" and a
    // gate written that way is silently dead in Swedish while passing every
    // English test. These four exist to fail if anyone reintroduces `\b`.
    for (const s of [
      "finns det en översikt av forskningen om arvsmassa",
      "kan vi återskapa mammuten med genteknik",
      "vilka belägg finns för genetisk inblandning",
      "vad säger rön om utdöda arter",
    ]) assert.equal(europepmcIntent(s), true, s);
  });

  // Feedback #54 (2026-07-30). The verbatim question was "Spirulina proven
  // health benefits" and it reached NO literature leg: "proven" fired no gate
  // in the repo, and health/medicine was not life-science subject matter here,
  // so the answer came from supplement-marketing pages. Both halves are pinned.
  await t.test("health and medicine are life-science subject matter", () => {
    for (const s of [
      "Spirulina proven health benefits",
      "what does the research say about vitamin D supplementation",
      "studies on the side effects of statins",
      "is there evidence for this cancer treatment",
      "peer-reviewed papers on gut microbiome and diet",
      "Bevisade hälsoeffekter av spirulina",
      "finns det evidensbaserad behandling för migrän",
      "vad säger studierna om biverkningar av kosttillskott",
      "forskning om blodtryck och kost",
    ]) assert.equal(europepmcIntent(s), true, s);
  });

  await t.test("the proven family is a research word, in both languages", () => {
    for (const s of [
      "is turmeric proven to reduce inflammation",
      "unproven claims about probiotics",
      "clinically tested supplements for cholesterol",
      "är omega-3 bevisat bra för hjärtat",
      "styrkt effekt av vitamin C på immunförsvaret",
      "påvisade biverkningar av läkemedlet",
    ]) assert.equal(europepmcIntent(s), true, s);
    // Still a COMBINATION gate: a proven word with no life-science subject,
    // and a health word with no research framing, both stay silent.
    assert.equal(europepmcIntent("our team has a proven track record"), false);
    assert.equal(europepmcIntent("book me a doctor's appointment"), false);
    assert.equal(europepmcIntent("boka en tid hos läkaren"), false);
  });

  // Feedback #61 (chat_logs #1656, 2026-08-05). A user attached a LinkedIn
  // screenshot and wrote "Research this founder". Both halves of the
  // combination gate matched text that was never about biology: the bare
  // English imperative "research", and the single word "health" sitting inside
  // a privacy PROHIBITION in an appended methodology block ("never an
  // inference of ethnicity, health, religion, politics, sexuality"). The leg
  // fired and contributed biomedical papers to a founder-background answer.
  await t.test("the imperative verb is not a reference to the literature", () => {
    // The verbatim reported message.
    assert.equal(europepmcIntent("Research this founder"), false);
    // …and the shape it arrived in, methodology block and all.
    assert.equal(
      europepmcIntent(
        "Research this founder.\n\nMethodology: verifiable public facts only, " +
          "never an inference of ethnicity, health, religion, politics, sexuality.",
      ),
      false,
    );
    for (const s of [
      "Please research this person before the meeting",
      "Review these three candidates",
      "Study this profile and summarise it",
      // Swedish parity — the loanword imperative and the native verbs, with
      // Swedish objects (den här / denna / honom / deras).
      "Research den här grundaren",
      "Granska den här personen och hennes bakgrund",
      "Undersök denna grundare inför mötet",
      "Kolla upp honom innan mötet",
      "Analysera dessa kandidater",
    ]) assert.equal(europepmcIntent(s), false, s);
  });

  // The over-correction that followed the fix above. Neutralising the frame
  // ran BEFORE the research-word test, so when "research" was the message's
  // only research word the pairing had nothing left to pair with and a plainly
  // biomedical question routed to no source at all. The frame is only allowed
  // to devalue the VERB; the subject still decides.
  await t.test("the imperative frame vetoes the verb, not the message", () => {
    for (const s of [
      "Research this drug's side effects",
      "Research this disease's known treatments",
      "Research this patient cohort's outcomes",
      "Research my mother's diagnosis",
      "Research his cancer prognosis",
      "Investigate these adverse events",
      // Swedish at the same breadth — the native imperatives, whose verbs are
      // not RESEARCH_WORD members at all, so the subject is the whole case.
      "Undersök den här sjukdomen",
      "Granska dessa symtom",
      "Undersök den här medicinens biverkningar",
    ]) assert.equal(europepmcIntent(s), true, s);
    // The control that proves the verb/noun line is still drawn where feedback
    // #61 put it: the same subject behind the NOUN was never in doubt.
    assert.equal(europepmcIntent("The research on this drug's side effects"), true);
    // …and the veto still lands wherever the subject is not biomedical.
    for (const s of [
      "Research this founder",
      "Undersök den här grundaren",
      "Granska den här personen",
    ]) assert.equal(europepmcIntent(s), false, s);
    // A subject with no framing at all is still the combination gate — the
    // imperative branch does not turn the subject tier into a lone trigger.
    assert.equal(europepmcIntent("what species of tree is this"), false);
  });

  await t.test("the NOUN 'research' still names the published record", () => {
    for (const s of [
      "the latest research on vitamin D",
      "what does the research say about cancer treatment",
      // A relative pronoun is not a task object — `that`/`it` are deliberately
      // absent from the imperative frame's object list.
      "research that shows the health benefits of exercise",
      // Mid-sentence, so the sentence-initial frame does not apply.
      "the research this year on gut microbiome",
      "vad säger forskningen om vitamin D",
      "den senaste forskningen om cancerbehandling",
    ]) assert.equal(europepmcIntent(s), true, s);
  });

  await t.test("a general word in passing is not life-science subject matter", () => {
    for (const s of [
      // "health" only inside the prohibition — the reported false positive.
      "What does the research say about interest rates? " +
        "Never infer ethnicity, health, religion or politics.",
      "Vad säger forskningen om räntor? " +
        "Aldrig en slutsats om etnicitet, hälsa, religion eller politik.",
      // The rest of the ambiguous family, each in its ordinary sense.
      "studies of a sequence of events on the assembly line",
      "research on computer viruses in industrial control systems",
      "our findings show the team has financial muscle",
      "the evidence is at the heart of the argument",
      "papers on mineral rights in northern Sweden",
      "our research shows no startup is immune to a downturn",
      "forskning om behandling av personuppgifter i molnet",
      "vad säger forskningen om hur bolaget lever vidare genom omstrukturering",
      "studier av hjärtat i staden och dess kulturliv",
      "artiklar om hjärnan bakom affären",
      "belägg för att bolaget har ekonomiska muskler",
    ]) assert.equal(europepmcIntent(s), false, s);
  });

  await t.test("an ambiguous word inside a biomedical collocation still fires", () => {
    for (const s of [
      "Spirulina proven health benefits",
      "research on the health effects of microplastics",
      "what does the research say about the immune system",
      "studies on heart rate variability",
      "papers on de novo assembly",
      "evidence on brain function after concussion",
      "reviews of patient outcomes after surgery",
      "studies on muscle mass in older adults",
      // Swedish carries it as compounds — and every one of these starts or
      // ends in å/ä/ö, which is the \b trap the file's boundaries avoid.
      "studier om psykisk hälsa hos unga",
      "forskning om hjärtinfarkt hos kvinnor",
      "vad säger studierna om muskelmassa hos äldre",
      "vetenskapliga rön om virusinfektioner",
      "artiklar om hjärnskador efter smällar",
      "en patient med migrän — vad säger forskningen",
      "forskning om hälsosam kost",
    ]) assert.equal(europepmcIntent(s), true, s);
  });

  // Invariant 6, enforced as PAIRS rather than as two lists. Moving the
  // ambiguous words into the collocation tier covered English well and Swedish
  // poorly — the Swedish arms assumed users write compounds (hälsoeffekt,
  // hjärtsjukdom) while they actually write the separated form (hälsa och …,
  // hjärtat och …). Seven matched pairs fired in English and were silent in
  // Swedish, and none of the English-only tests could see it: a missing
  // counterpart is invisible in a list and impossible to miss in a pair. Every
  // case below therefore walks BOTH languages through the gate against one
  // shared verdict, and adding an English case here forces its Swedish twin.
  await t.test("matched EN/SV pairs get the same verdict", () => {
    /** @param {[string, string]} pair @param {boolean} expected */
    const pair = ([en, sv], expected) => {
      assert.equal(europepmcIntent(en), expected, `EN: ${en}`);
      assert.equal(europepmcIntent(sv), expected, `SV: ${sv}`);
    };

    /** @type {Array<[string, string]>} */
    const fires = [
      ["Studies on health outcomes of shift work", "Studier om hälsa och skiftarbete"],
      ["Studies on heart health and exercise", "Studier om hjärtat och träning"],
      ["Papers on brain function during sleep", "Artiklar om hjärnan under sömn"],
      ["Research on muscle mass in older adults", "Forskning om muskler hos äldre"],
      ["Papers on virus transmission in schools", "Artiklar om virus i skolor"],
      ["Research on dosing of melatonin", "Forskning om dos av melatonin"],
      ["Papers on DNA sequences in ancient bone", "Artiklar om sekvenser i forntida ben"],
      // "hjärt- och kärlsjukdomar" is THE Swedish term for cardiovascular
      // disease and matched nothing in either direction before: `sjukdom`
      // cannot start inside `kärlsjukdomar`, and the hyphen-plus-conjunction
      // splits the compound the hjärt- collocations expect.
      ["Studies on cardiovascular disease", "Studier om hjärt- och kärlsjukdomar"],
      // The imperative frame, both languages, over a biomedical subject.
      ["Research this drug's side effects", "Undersök den här medicinens biverkningar"],
    ];
    for (const p of fires) pair(p, true);

    /** @type {Array<[string, string]>} */
    const silent = [
      // The reported false positive the narrowing exists for.
      ["Research this founder", "Undersök den här grundaren"],
      [
        "What does the research say about interest rates? " +
          "Never infer ethnicity, health, religion or politics.",
        "Vad säger forskningen om räntor? " +
          "Aldrig en slutsats om etnicitet, hälsa, religion eller politik.",
      ],
      // Each ambiguous word in its ordinary, non-biomedical sense — the reason
      // the separated Swedish forms need a frame rather than the bare word.
      [
        "research on computer viruses in industrial control systems",
        "forskning om datavirus i industriella styrsystem",
      ],
      ["the evidence is at the heart of the argument", "beläggen finns i hjärtat av argumentet"],
      ["papers on the brains behind the deal", "artiklar om hjärnan bakom affären"],
      [
        "our findings show the team has financial muscle",
        "belägg för att bolaget har ekonomiska muskler",
      ],
      [
        "studies of a sequence of events on the assembly line",
        "studier av en sekvens av händelser vid löpande bandet",
      ],
      // `hälsa` is also the verb "to greet", which is why its frame excludes
      // the particle: "gå och hälsa PÅ" is a visit, not a health question.
      ["studies of how to greet a customer", "vi ska gå och hälsa på farmor efter studien"],
      ["show me the latest research on interest rates", "visa senaste forskningen om räntor"],
    ];
    for (const p of silent) pair(p, false);
  });

  // The separated Swedish forms in their own right, beyond the reported pairs.
  await t.test("the Swedish separated forms carry the collocation tier", () => {
    for (const s of [
      "forskning om hälsan hos unga",
      "studier om kost och hälsa",
      "artiklar om träning och hjärtat",
      "vad säger forskningen om hjärnan",
      "studier om muskler och leder",
      "forskning om sekvenser av dna",
      "studier om virus hos fladdermöss",
      "forskning om dosen av D-vitamin",
      "studier om kärlsjukdomar",
      "forskning om hjärt-kärlsjukdom",
    ]) assert.equal(europepmcIntent(s), true, s);
  });

  await t.test("needs both halves for the generic combination gate", () => {
    // A life-science word with no research framing, and research framing with
    // no life-science subject, both stay silent.
    assert.equal(europepmcIntent("what species of tree is this"), false);
    assert.equal(europepmcIntent("show me the latest research on interest rates"), false);
    assert.equal(europepmcIntent("visa senaste forskningen om räntor"), false);
    // …together they fire, in either language.
    assert.equal(europepmcIntent("what do the studies say about gene therapy"), true);
    assert.equal(europepmcIntent("vad säger studierna om genetisk sjukdom"), true);
  });

  await t.test("stays silent on the ordinary question", () => {
    for (const s of [
      "what's the weather in Uppsala",
      "refactor this function",
      "vad kostar en biljett till Göteborg",
      "",
    ]) assert.equal(europepmcIntent(s), false, s);
  });
});

test("europepmcLeadIntent is strictly narrower than europepmcIntent", async (t) => {
  await t.test("leads only when the archive or the literature is named", () => {
    for (const s of [
      "search pubmed for mammoth mitogenomes",
      "what does europe pmc have on aDNA damage",
      "vad säger den vetenskapliga litteraturen om mammutar",
      "give me peer-reviewed papers on de-extinction",
    ]) assert.equal(europepmcLeadIntent(s), true, s);
  });

  await t.test("a question the source merely serves does not lead", () => {
    for (const s of [
      "how old is the oldest ancient DNA?",
      "hur gammalt är det äldsta forn-DNA:t?",
      "what did the Neanderthal genome change about us",
    ]) {
      assert.equal(europepmcIntent(s), true, s);
      assert.equal(europepmcLeadIntent(s), false, s);
    }
  });

  await t.test("every leading message also passes the wider gate", () => {
    for (const s of [
      "search pubmed for mammoth mitogenomes",
      "vad säger den vetenskapliga litteraturen om mammutar",
    ]) assert.equal(europepmcIntent(s), true, s);
  });

  await t.test("leading raises the per-request cap", () => {
    assert.ok(EUROPEPMC_LEAD_MAX_PER_REQUEST > EUROPEPMC_MAX_PER_REQUEST);
  });
});

test("europepmcTerms", async (t) => {
  await t.test("drops stopwords and framing in both languages", () => {
    assert.deepEqual(
      europepmcTerms("what do the studies say about the woolly mammoth genome"),
      ["woolly", "mammoth", "genome"],
    );
    assert.deepEqual(
      europepmcTerms("vad säger studierna om mammutens arvsmassa"),
      ["mammutens", "arvsmassa"],
    );
  });

  await t.test("drops bare years — a date is not a concept under AND", () => {
    assert.equal(europepmcTerms("mammoth genome 2021").includes("2021"), false);
  });

  await t.test("keeps hyphens inside a token", () => {
    assert.ok(europepmcTerms("kol-14 datering").includes("kol-14"));
  });

  await t.test("dedups, preserving order", () => {
    assert.deepEqual(europepmcTerms("dna dna mammoth dna"), ["dna", "mammoth"]);
  });
});

test("europepmcTermKey collapses two phrasings of one angle", () => {
  assert.equal(
    europepmcTermKey("what do the studies say about the mammoth genome"),
    europepmcTermKey("studies about mammoth genome"),
  );
});

test("europepmcConcepts quotes terms of art and nothing else", async (t) => {
  await t.test("recognises a term of art as one phrase", () => {
    const c = europepmcConcepts("ancient DNA from woolly mammoth remains");
    assert.ok(c.includes("ancient dna"), JSON.stringify(c));
    assert.ok(c.includes("woolly mammoth"), JSON.stringify(c));
  });

  await t.test("does not swallow the phrase's words as separate terms too", () => {
    const c = europepmcConcepts("ancient DNA mammoth");
    assert.equal(c.filter((x) => x === "dna").length, 0);
    assert.equal(c.filter((x) => x === "ancient").length, 0);
  });

  await t.test("leaves ordinary words as single tokens", () => {
    assert.deepEqual(europepmcConcepts("permafrost preservation"), ["permafrost", "preservation"]);
  });
});

test("europepmcLadder", async (t) => {
  await t.test("climbs by DROPPING constraints (AND semantics), never adding", () => {
    const rungs = europepmcLadder("ancient DNA woolly mammoth permafrost");
    const notes = rungs.map((r) => r.note);
    assert.deepEqual(notes, ["abstract", "phrase", "phrase-2", "bare"]);
    // Each rung is no narrower than the one before it: abstract-restricted →
    // whole record → fewer concepts → unquoted.
    assert.ok(rungs[0].q.includes("ABSTRACT:"));
    assert.equal(rungs[1].q.includes("ABSTRACT:"), false);
    assert.ok(rungs[1].q.split(" AND ").length > rungs[2].q.split(" AND ").length);
    assert.equal(rungs[3].q.includes('"'), false);
  });

  await t.test("skips the abstract rung when one concept is all there is", () => {
    const rungs = europepmcLadder("mammoth");
    assert.equal(rungs.some((r) => r.note === "abstract"), false);
    assert.ok(rungs.length >= 1);
  });

  await t.test("ANDs quoted phrases — the measured working form", () => {
    const phrase = europepmcLadder("ancient DNA mammoth").find((r) => r.note === "phrase");
    assert.equal(phrase.q, '"ancient dna" AND "mammoth"');
  });

  await t.test("returns nothing to try for an empty query", () => {
    assert.deepEqual(europepmcLadder(""), []);
    assert.deepEqual(europepmcLadder("the and of"), []);
  });

  await t.test("rung keys are stable, so a later wave can skip them", () => {
    const a = europepmcLadder("ancient DNA mammoth").map((r) => r.key);
    const b = europepmcLadder("ancient dna  mammoth").map((r) => r.key);
    assert.deepEqual(a, b);
  });
});

test("toItem", async (t) => {
  const record = {
    id: "42135334",
    source: "MED",
    doi: "10.1038/s41598-026-46761-x",
    title: "Ancient DNA from the Upper Paleolithic mammoth ivory of Hohle Fels, Germany.",
    authorString: "Moreland KN, Wolf S, Posth C.",
    pubYear: "2026",
    isOpenAccess: "Y",
    citedByCount: 3,
    abstractText: "Hohle Fels, a cave in southwestern Germany, hosts <i>one</i> of the richest assemblages.",
    journalInfo: { journal: { title: "Scientific Reports" } },
  };

  await t.test("prefers the DOI — what a reader actually cites", () => {
    assert.equal(toItem(record).url, "https://doi.org/10.1038/s41598-026-46761-x");
  });

  await t.test("falls back to the Europe PMC article page without a DOI", () => {
    assert.equal(
      toItem({ ...record, doi: "" }).url,
      "https://europepmc.org/article/MED/42135334",
    );
  });

  await t.test("carries the provenance a reader judges a hit by", () => {
    const [prov] = toItem(record).highlights;
    assert.ok(prov.includes("Scientific Reports"));
    assert.ok(prov.includes("2026"));
    assert.ok(prov.includes("open access"));
    assert.ok(prov.includes("cited 3×"));
  });

  await t.test("marks a preprint as not peer-reviewed", () => {
    const [prov] = toItem({ ...record, source: "PPR", journalInfo: null }).highlights;
    assert.ok(prov.includes("preprint, not peer-reviewed"), prov);
  });

  await t.test("strips markup out of the abstract", () => {
    const abstract = toItem(record).highlights.at(-1);
    assert.equal(abstract.includes("<i>"), false);
    assert.ok(abstract.includes("one of the richest"));
  });

  await t.test("drops a record with no title or no resolvable URL", () => {
    assert.equal(toItem({ ...record, title: "" }), null);
    assert.equal(toItem({ doi: "", source: "", id: "", title: "x" }), null);
  });
});

test("europepmcDiversityKey keys on the publisher, not the whole of doi.org", async (t) => {
  await t.test("splits publishers apart", () => {
    assert.equal(europepmcDiversityKey("https://doi.org/10.1038/s41586-021-03224-9"), "doi.org/10.1038");
    assert.equal(europepmcDiversityKey("https://doi.org/10.1016/j.cub.2015.04.007"), "doi.org/10.1016");
    assert.notEqual(
      europepmcDiversityKey("https://doi.org/10.1038/a"),
      europepmcDiversityKey("https://doi.org/10.1101/b"),
    );
  });

  await t.test("groups one publisher's hits together, which is the point", () => {
    assert.equal(
      europepmcDiversityKey("https://doi.org/10.1038/a"),
      europepmcDiversityKey("https://doi.org/10.1038/b"),
    );
  });

  await t.test("degrades to the bare host on anything unparseable", () => {
    assert.equal(europepmcDiversityKey("not a url"), "doi.org");
    assert.equal(europepmcDiversityKey("https://doi.org/"), "doi.org");
  });
});

test("europepmcPickQuery prefers the angle the corpus can actually match", async (t) => {
  await t.test("picks domain vocabulary over generic phrasing", () => {
    const picked = europepmcPickQuery(
      ["mammoth facts for kids", "woolly mammoth mitochondrial genome"],
      "tell me about mammoth genetics",
    );
    assert.equal(picked, "woolly mammoth mitochondrial genome");
  });

  await t.test("penalises an over-long angle — every AND term costs recall", () => {
    const picked = europepmcPickQuery(
      [
        "ancient DNA mammoth permafrost Siberia radiocarbon sediment stratigraphy museum",
        "ancient DNA mammoth permafrost",
      ],
      "ancient DNA mammoth permafrost",
    );
    assert.equal(picked, "ancient DNA mammoth permafrost");
  });

  await t.test("falls back to the first angle when none scores", () => {
    assert.equal(europepmcPickQuery(["the of and"], ""), "the of and");
  });
});

test("europepmcSearch", async (t) => {
  const realFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = realFetch;
  });

  /** n distinct records, so a rung can satisfy MIN_RUNG_HITS. */
  const hits = (title, doi, n = 3) => ({
    resultList: {
      result: Array.from({ length: n }, (_, i) => ({
        id: `${i}`, source: "MED", doi: `${doi}-${i}`, title: `${title} ${i}`, authorString: "A B",
        pubYear: "2021", journalInfo: { journal: { title: "Nature" } },
        abstractText: "abstract text", citedByCount: 10, isOpenAccess: "Y",
      })),
    },
  });
  const hit = (title, doi) => hits(title, doi, 1);

  await t.test("stops at the first rung that returns enough hits", async () => {
    const urls = [];
    globalThis.fetch = async (url) => {
      urls.push(String(url));
      return new Response(JSON.stringify(hits("Ancient DNA paper", "10.1038/x")), {
        headers: { "content-type": "application/json" },
      });
    };
    const res = await europepmcSearch({}, log, "ancient DNA woolly mammoth permafrost");
    assert.equal(res.items.length, 3);
    // Two fetches (cited + recent) for ONE rung — the abstract rung matched.
    assert.equal(urls.length, 2);
    assert.equal(res.usedKeys.length, 1);
    assert.ok(urls[0].includes("ABSTRACT"));
    assert.ok(urls.some((u) => u.includes("CITED")));
    assert.ok(urls.some((u) => u.includes("P_PDATE_D")));
    assert.ok(urls.every((u) => u.includes("resultType=core")));
  });

  await t.test("falls through the ladder when a rung is empty", async () => {
    let call = 0;
    globalThis.fetch = async () => {
      call++;
      // The abstract rung (calls 1-2) finds nothing; the phrase rung does.
      const body = call <= 2 ? { resultList: { result: [] } } : hits("Found later", "10.1016/y");
      return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
    };
    const res = await europepmcSearch({}, log, "ancient DNA woolly mammoth permafrost");
    assert.equal(res.items[0].title, "Found later 0");
    assert.equal(res.usedKeys.length, 2);
  });

  await t.test("a thin rung does not end the ladder, and its finds are kept", async () => {
    let call = 0;
    globalThis.fetch = async () => {
      call++;
      // The abstract rung matches exactly one paper (both sorts return it);
      // the phrase rung below it matches a literature.
      const body = call <= 2 ? hits("Lone abstract hit", "10.1038/lone", 1) : hits("Wider", "10.1016/w");
      return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
    };
    const res = await europepmcSearch({}, log, "sedimentary ancient DNA Beringia");
    assert.ok(res.usedKeys.length >= 2, "climbed past the thin rung");
    const titles = res.items.map((i) => i.title);
    assert.ok(titles.includes("Lone abstract hit 0"), "kept the thin rung's find");
    assert.ok(titles.some((tt) => tt.startsWith("Wider")), "added the wider rung's");
  });

  await t.test("skips rungs an earlier wave already consumed", async () => {
    const urls = [];
    globalThis.fetch = async (url) => {
      urls.push(String(url));
      return new Response(JSON.stringify(hits("x", "10.1038/x")), {
        headers: { "content-type": "application/json" },
      });
    };
    const skipKeys = new Set(europepmcLadder("ancient DNA mammoth").map((r) => r.key).slice(0, 1));
    const res = await europepmcSearch({}, log, "ancient DNA mammoth", { skipKeys });
    assert.equal(urls.some((u) => u.includes("ABSTRACT")), false);
    assert.ok(res.items.length);
  });

  await t.test("de-duplicates a record returned by both sorts", async () => {
    globalThis.fetch = async () =>
      new Response(JSON.stringify(hit("Same paper", "10.1038/same")), {
        headers: { "content-type": "application/json" },
      });
    const res = await europepmcSearch({}, log, "ancient DNA mammoth");
    assert.equal(res.items.length, 1);
  });

  await t.test("fails soft on a bad status", async () => {
    globalThis.fetch = async () => new Response("nope", { status: 503 });
    const res = await europepmcSearch({}, log, "ancient DNA mammoth");
    assert.deepEqual(res.items, []);
    assert.ok(typeof res.durationMs === "number");
  });

  await t.test("fails soft on a throwing fetch", async () => {
    globalThis.fetch = async () => {
      throw new Error("timeout");
    };
    const res = await europepmcSearch({}, log, "ancient DNA mammoth");
    assert.deepEqual(res.items, []);
  });

  await t.test("fails soft on malformed JSON", async () => {
    globalThis.fetch = async () => new Response("<html>", { headers: { "content-type": "text/html" } });
    const res = await europepmcSearch({}, log, "ancient DNA mammoth");
    assert.deepEqual(res.items, []);
  });

  await t.test("makes no request at all for a query with no concepts", async () => {
    let called = 0;
    globalThis.fetch = async () => {
      called++;
      return new Response("{}");
    };
    const res = await europepmcSearch({}, log, "the and of");
    assert.equal(called, 0);
    assert.deepEqual(res.items, []);
  });
});
