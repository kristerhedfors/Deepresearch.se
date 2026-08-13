// (no @ts-check: node:test / node:assert have no type declarations in this
// repo, and the junk-input rows below deliberately feed non-strings into the
// gates — the same reason src/search-sources.test.js omits it.)
//
// THE AUXILIARY SEARCH-SOURCE REGISTRY, ON THE TRIGGER PATH.
//
// Why this file exists, beside the four per-source suites and
// search-sources.test.js: production evidence (chat_logs #1670, 2026-08-06)
// that an integration can be fully wired, fully configured, and still produce
// NOTHING, silently, because the trigger path itself has no coverage. The
// per-source files test each gate's own vocabulary very well. What nothing
// tested is the layer BETWEEN them and the pipeline:
//
//   1. MEMBERSHIP. Deleting an entry from SEARCH_SOURCES, renaming an id, or
//      dropping a diversityHost leaves the whole suite green — while the
//      Models agent's `state.forceAux = ["hf"]` and the Deep Science agent's
//      `state.auxOnly = ["scholar"]` quietly address a source that no longer
//      exists, and the per-origin cap starves a platform leg. §1 pins the
//      exact ordered registry and every routing-relevant field of each entry,
//      and cross-checks the ids the two agents name against it.
//   2. THE TRIGGER MATRIX as ONE table over all four sources (§2), so a
//      widening of one gate that starts swallowing another source's questions
//      is visible in one place — including the CROSS-SOURCE negatives (an
//      arXiv phrasing must not reach Europe PMC and back), the EN⇄SV pairs
//      invariant 6 requires, and one å/ä/ö row per source that would catch the
//      `\b` trap (JS word boundaries are ASCII-only, so a Swedish alternative
//      written with `\b` dies silently while the English half keeps working).
//   3. `leadIntent ⊆ intent` (§3) over a real corpus rather than the six
//      probes search-sources.test.js walks. Leading stands the whole web leg
//      down, so a source that LEADS a request its own intent gate rejects is
//      feedback #61's exact failure shape. Two live violations are recorded
//      in KNOWN_LEAD_WITHOUT_INTENT below — read that table, it is a bug list.
//   4. FORCED / RESTRICTED ROUTING (§4): forceAux, auxOnly and
//      auxMaxPerRequest. pipeline.js does not export planAuxSource, so the
//      three rules are transcribed here and GUARDED against the real source
//      text, and then driven behaviourally over the real registry entries.
//   5. FAIL-SOFT PER SOURCE (§5, invariant 2) driven through the REGISTRY's
//      own `search` reference rather than the module export — which is what
//      the orchestrator actually calls, and what a mis-wired entry would
//      break. Four failure modes × four sources.
//   6. src/scholar.js's five sub-backends and their KEY GATES (§6), which had
//      no coverage of any kind: an unconfigured backend must be SKIPPED (no
//      request to its host), a dead one must not take the others down with
//      it, and a Crossref verification that fails must leave a Google Scholar
//      candidate unadmitted rather than throwing.
//
// Deliberately NOT duplicated here (checked before writing):
//   - each gate's own vocabulary, ladders, term extraction and item mapping —
//     src/hf.test.js, src/arxiv.test.js, src/europepmc.test.js,
//     src/scholar.test.js;
//   - the entry-shape contract, sourcePromptNotes and platformDiversityKey —
//     src/search-sources.test.js;
//   - arxivSearch's "fail-soft in every branch" and europepmcSearch's
//     bad-status / throwing-fetch / malformed-JSON cases — their own files.
//     §5 re-drives all four sources anyway, but through the registry entry,
//     because "the registry points at the right function and that function
//     fails soft" is a different claim from "the exported function fails
//     soft";
//   - that the pipeline's gates read `ctx.gateLastUser` rather than the
//     enrichment-augmented message (feedback #61) — src/pipeline.test.js
//     already pins every call site by name. §2's last test pins the
//     REGISTRY-side premise instead, which nothing covered: that an appended
//     enrichment block really can flip the whole registry's verdict.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { SEARCH_SOURCES, capabilityAllowsSource, leadSourceIds } from "./search-sources.js";
import { fakeLog } from "./test-helpers/env.js";
import { withFakeFetch } from "./test-helpers/fetch.js";
import { SCHOLAR_SEARCHES_PER_REQUEST, SCHOLAR_SOURCE_ID } from "./scholar-metrics.js";
import { HUB_SEARCHES_PER_REQUEST } from "./models-agent.js";

/** @param {string} id */
const entry = (id) => {
  const s = SEARCH_SOURCES.find((x) => x.id === id);
  assert.ok(s, `registry has no source "${id}"`);
  return s;
};

// ============================================================================
// §1 — REGISTRY MEMBERSHIP
// ============================================================================

// One row per registered source. Every field here is consumed by a DIFFERENT
// module — the id by pipeline.js's state buckets and the two agents' forceAux /
// auxOnly lists, the service by the client's search cards, diversityHost by
// sources.js's per-origin cap, the two caps by planAuxSource — so a change to
// any of them is a change to behaviour somewhere else, and belongs in a diff
// that says so.
const REGISTRY = [
  {
    id: "hf",
    service: "Hugging Face Hub",
    diversityHost: "huggingface.co",
    maxPerRequest: 3,
    // The one source no agent owns: the hub is not a literature corpus, so it
    // runs for whoever engages it, exactly as every source did before the
    // 2026-08-13 roster split.
    requiresContext: undefined,
    // The one source that never leads: a hub question is a question the hub
    // can help with, not an instruction to stand the web leg down.
    leads: false,
    leadMaxPerRequest: undefined,
  },
  {
    id: "arxiv",
    service: "arXiv",
    diversityHost: "arxiv.org",
    // Lower than hf's 3 on purpose: arXiv publishes 1 req / 3 s and sells no
    // way past it (ARXIV_MAX_PER_REQUEST).
    maxPerRequest: 2,
    // Owned outright by Deep Science (owner directive, 2026-08-13). The
    // exclusivity itself — which AGENTS hold these blocks — is pinned in
    // src/literature-exclusivity.test.js; this row pins the registry half, so
    // dropping the field (which would silently hand preprints back to every
    // agent) fails here rather than in production.
    requiresContext: "literature-arxiv",
    leads: true,
    leadMaxPerRequest: 4,
  },
  {
    id: "europepmc",
    service: "Europe PMC",
    // DOI URLs: without a platform key every publisher on earth shares the
    // single origin `doi.org` and the per-origin cap starves the leg.
    diversityHost: "doi.org",
    maxPerRequest: 2,
    leads: true,
    leadMaxPerRequest: 4,
    // The one SHARED corpus: Deep Science owns it and the palaeogenomics agent
    // declares it too, because ancient-DNA questions are answered out of the
    // life-science literature (tests/evalsets/palaeogenomics.json,
    // tests/needles/*-pubmed.json). arXiv deliberately is not shared with it —
    // that agent's own spec says arXiv does not cover the field.
    requiresContext: "literature-pubmed",
  },
  {
    id: "scholar",
    service: "Peer-reviewed literature",
    diversityHost: "doi.org",
    maxPerRequest: 2,
    leads: true,
    leadMaxPerRequest: 4,
    requiresContext: "literature-peer-reviewed",
  },
];

describe("§1 registry membership", () => {
  test("the registry is exactly these four sources, in this order", () => {
    // Order is not cosmetic: pipeline.js plans, emits and ABSORBS aux results
    // in registry order, which is what makes citation numbering deterministic
    // however the fetches resolve (absorbAuxResult). Adding a source is fine;
    // this test is here so that removing or reordering one is a deliberate act
    // with a diff line, not a silent regression that leaves the suite green.
    assert.deepEqual(
      SEARCH_SOURCES.map((s) => s.id),
      REGISTRY.map((r) => r.id),
    );
  });

  test("every entry declares the routing fields the rest of the code reads", () => {
    for (const want of REGISTRY) {
      const s = entry(want.id);
      assert.equal(s.service, want.service, `${want.id}: service (shown on the client's search card)`);
      assert.equal(s.diversityHost, want.diversityHost, `${want.id}: diversityHost (sources.js per-origin cap)`);
      assert.equal(typeof s.diversityKeyOf, "function", `${want.id}: diversityHost without a key function is inert`);
      assert.equal(s.maxPerRequest, want.maxPerRequest, `${want.id}: maxPerRequest`);
      // The standing narrowing (owner directive, 2026-08-13): a source naming a
      // context block runs only for an agent whose capability declares it
      // (pipeline.js sourceAllowed). Silently dropping the field re-opens a
      // corpus to every agent on the roster and leaves every other test green.
      assert.equal(s.requiresContext, want.requiresContext, `${want.id}: requiresContext`);
      assert.equal(typeof s.leadIntent === "function", want.leads, `${want.id}: declares a leadIntent?`);
      assert.equal(s.leadMaxPerRequest, want.leadMaxPerRequest, `${want.id}: leadMaxPerRequest`);
      if (want.leads) {
        // The point of leading is BREADTH: with the web leg down, covering a
        // single angle leaves the turn thinner than not leading at all.
        assert.ok(
          (s.leadMaxPerRequest ?? 0) > (s.maxPerRequest ?? 0),
          `${want.id}: leading must raise the ceiling, not lower it`,
        );
      }
    }
  });

  test("leadSourceIds returns exactly the sources that declare a leadIntent", () => {
    // The set of ids leadSourceIds can EVER return is the set of declarers —
    // proved by sweeping the whole trigger corpus, so a source that quietly
    // stops (or starts) declaring one shows up here.
    const declarers = SEARCH_SOURCES.filter((s) => typeof s.leadIntent === "function").map((s) => s.id);
    assert.deepEqual(declarers, ["arxiv", "europepmc", "scholar"]);

    /** @type {Set<string>} */
    const everLed = new Set();
    for (const text of ALL_CORPUS_TEXTS()) for (const id of leadSourceIds(text)) everLed.add(id);
    for (const id of everLed) assert.ok(declarers.includes(id), `${id} led without declaring a leadIntent`);
    // hf declares none, so it can never lead however the message is phrased.
    assert.ok(!everLed.has("hf"), "hf must never lead — it declares no leadIntent");
    // …and each declarer really is reachable, or its declaration is dead code.
    for (const id of declarers) assert.ok(everLed.has(id), `${id} declares a leadIntent that never fires in the corpus`);
  });

  test("the ids the agents force and narrow to actually exist in the registry", () => {
    // Nothing pinned this. `state.forceAux = ["hf"]` (src/models-agent.js) and
    // `state.auxOnly = [SCHOLAR_SOURCE_ID]` (src/scholar-metrics.js) are plain
    // strings matched against `source.id`; rename an id and both agents keep
    // "working" while searching nothing at all — the Deep Science agent, whose
    // ONLY source is the one it narrows to, would answer from no sources.
    const ids = SEARCH_SOURCES.map((s) => s.id);
    assert.ok(ids.includes("hf"), "the Models agent forces the id \"hf\"");
    assert.ok(ids.includes(SCHOLAR_SOURCE_ID), "the Deep Science agent forces/narrows to SCHOLAR_SOURCE_ID");

    // Both agents also RAISE the source's per-request ceiling; an override that
    // did not exceed the registry default would be a no-op knob.
    assert.ok(
      HUB_SEARCHES_PER_REQUEST > (entry("hf").maxPerRequest ?? 0),
      "the Models agent's hub ceiling must be higher than the registry default",
    );
    assert.ok(
      SCHOLAR_SEARCHES_PER_REQUEST > (entry(SCHOLAR_SOURCE_ID).leadMaxPerRequest ?? 0),
      "the Deep Science ceiling must exceed even the leading ceiling — it is the agent's only source",
    );
  });
});

// ============================================================================
// §2 — THE TRIGGER MATRIX
// ============================================================================

// One table, all four sources. Each `fires` row is a matched EN⇄SV pair that
// MUST fire the row's source in BOTH languages (invariant 6 — equal breadth,
// not an English gate with a Swedish gesture), plus `notFor`: the sources that
// must stay silent on that same pair. The cross-source negatives are the point
// of putting this in one table: arXiv and Europe PMC overlap in vocabulary and
// each widening of one is a chance to swallow the other's questions.
//
// `bTrap` marks the rows whose Swedish half hangs on a token that STARTS or
// ENDS with å/ä/ö. JS `\b` is defined over [A-Za-z0-9_], so `/\böppna\b/` can
// never match and a gate written that way fails in Swedish only, silently,
// while every English test stays green. Each source has at least one.
const TRIGGERS = [
  {
    id: "hf",
    fires: [
      {
        en: "which whisper models are on hugging face",
        sv: "vilka whisper-modeller finns på hugging face",
        notFor: ["arxiv", "europepmc", "scholar"],
      },
      {
        // The hub-implied tier: a standalone ecosystem token fires alone.
        en: "what are the best gguf quantizations of llama 3",
        sv: "vilka gguf-kvantiseringar av llama 3 är bäst",
        notFor: ["arxiv", "europepmc", "scholar"],
      },
      {
        en: "which open weights exist for swedish speech recognition",
        sv: "vilka öppna vikter finns för svensk taligenkänning",
        bTrap: "öppna vikter",
        notFor: ["arxiv", "europepmc", "scholar"],
      },
    ],
  },
  {
    id: "arxiv",
    fires: [
      {
        // feedback #44's verbatim message.
        en: "find arXiv research mentioning linux",
        sv: "sök på arxiv efter artiklar om linux",
        // scholar deliberately co-fires on the Swedish half ("artiklar"), so it
        // is not asserted silent here; the hub and the life-science leg are.
        notFor: ["hf", "europepmc"],
      },
      {
        en: "any preprints on diffusion transformers",
        sv: "finns det några preprints om diffusionstransformatorer",
        notFor: ["hf", "europepmc", "scholar"],
      },
      {
        // Research phrasing + a scientific topic, no archive named.
        en: "do new language models outperform older transformers",
        sv: "överträffar nya språkmodeller äldre transformers",
        bTrap: "överträffar",
        notFor: ["hf", "europepmc", "scholar"],
      },
    ],
  },
  {
    id: "europepmc",
    fires: [
      {
        en: "pubmed studies on CRISPR off-target effects",
        sv: "pubmed-studier om CRISPR:s off-target-effekter",
        notFor: ["hf"],
      },
      {
        en: "how does the gut microbiome affect immunity according to studies",
        sv: "hur påverkar tarmfloran immunförsvaret enligt studier",
        notFor: ["hf"],
      },
      {
        en: "what do studies say about reviving extinct species",
        sv: "vad säger studierna om att återskapa utdöda arter",
        bTrap: "återskapa / utdöda",
        notFor: ["hf"],
      },
    ],
  },
  {
    id: "scholar",
    fires: [
      {
        en: "is there any evidence that mindfulness apps reduce anxiety",
        sv: "finns det några bevis för att mindfulness-appar minskar ångest",
        notFor: ["hf", "arxiv", "europepmc"],
      },
      {
        en: "use only peer-reviewed sources on minimum wage employment effects",
        sv: "använd bara sakkunniggranskade källor om minimilön",
        // arxiv's literature tier fires on "peer-reviewed"/"sakkunniggranskade"
        // by design; europepmc's INTENT stays out (no life-science subject) —
        // though its LEAD gate does not, which is bug (A) in §3.
        notFor: ["hf", "europepmc"],
      },
      {
        // Scholar named as the DESTINATION, which is a different act from the
        // word appearing in prose (the Rhodes-scholar negatives below).
        en: "look it up in scholar",
        sv: "slå upp det i scholar",
        bTrap: "slå upp",
        notFor: ["hf", "arxiv", "europepmc"],
      },
    ],
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// KNOWN SWEDISH GAPS in europepmc's life-science subject test — found while
// building the matrix above, recorded here rather than encoded as failing rows
// so the suite stays green. All four are invariant-6 breadth gaps, not the
// `\b` trap:
//
//   "studies on breast cancer"   fires  /  "studier om bröstcancer"   does NOT
//   "studies on ovarian cancer"  fires  /  "studier om äggstockscancer" no
//                                          (also lungcancer, hudcancer)
//     LIFE_SCIENCE_WORD carries `cancer` + LETTER, which catches the PREFIX
//     compounds ("cancerbehandling" fires) but not the suffix ones — and the
//     suffix form is how Swedish names a cancer.
//   "studier om tarmflora"       fires  /  "studier om tarmfloran"    does NOT
//   "studier om proteiner"       fires  /  "studier om proteinerna"   does NOT
//     The definite forms are missing from alternatives that list the
//     indefinite ones, which CLAUDE.md invariant 6 names explicitly ("definite
//     forms, synonyms, common typos").
//
// The EN⇄SV pairs in the table above were chosen to avoid these, so a fix can
// simply add rows here.
// ─────────────────────────────────────────────────────────────────────────────

// Messages no auxiliary source may claim. EN⇄SV pairs, because a gate that
// over-fires usually over-fires in one language only.
const SILENT_PAIRS = [
  { en: "who won the election in france", sv: "vem vann valet i frankrike" },
  { en: "what is the weather in gothenburg tomorrow", sv: "hur blir vädret i göteborg imorgon" },
  { en: "how do I fix a leaking tap", sv: "hur lagar jag en droppande kran" },
  // feedback #61: the imperative VERB addressed to the assistant. Every
  // research turn already IS "go and look"; it says nothing about journals.
  { en: "research this founder", sv: "researcha den här grundaren" },
];

// English-only negatives: words the gates had to give back because ordinary
// prose owns them ("scholar" the person, "models" the abstraction).
const SILENT_EN = [
  "the retention rate on scholar programs",
  "he is a Rhodes scholar",
  "climate models for 2050",
];

/** Every phrasing this file drives through the gates, for the sweeps. */
function ALL_CORPUS_TEXTS() {
  /** @type {string[]} */
  const out = [];
  for (const src of TRIGGERS) for (const row of src.fires) out.push(row.en, row.sv);
  for (const p of SILENT_PAIRS) out.push(p.en, p.sv);
  out.push(...SILENT_EN, ...LEAD_CORPUS);
  return out;
}

describe("§2 trigger matrix", () => {
  for (const src of TRIGGERS) {
    test(`${src.id}: every EN phrasing fires`, () => {
      const s = entry(src.id);
      for (const row of src.fires) assert.ok(s.intent(row.en), `${src.id} did not fire on EN "${row.en}"`);
    });

    test(`${src.id}: the matched SV phrasing fires identically (invariant 6)`, () => {
      const s = entry(src.id);
      for (const row of src.fires) {
        assert.equal(
          s.intent(row.sv),
          s.intent(row.en),
          `${src.id}: EN⇄SV parity broken — EN "${row.en}" vs SV "${row.sv}"`,
        );
      }
    });

    test(`${src.id}: å/ä/ö rows fire — the \\b trap would kill these`, () => {
      const s = entry(src.id);
      const traps = src.fires.filter((r) => r.bTrap);
      assert.ok(traps.length, `${src.id}: no å/ä/ö row — add one, or a \\b-written gate can rot unnoticed`);
      for (const row of traps) {
        assert.ok(
          s.intent(row.sv),
          `${src.id}: "${row.bTrap}" did not match in "${row.sv}" — JS \\b is ASCII-only, use the Unicode lookarounds`,
        );
      }
    });

    test(`${src.id}: does not reach across into another source's questions`, () => {
      for (const row of src.fires) {
        for (const other of row.notFor) {
          const o = entry(other);
          assert.equal(o.intent(row.en), false, `${other} fired on ${src.id}'s EN row "${row.en}"`);
          assert.equal(o.intent(row.sv), false, `${other} fired on ${src.id}'s SV row "${row.sv}"`);
        }
      }
    });
  }

  test("ordinary questions engage nothing at all, in either language", () => {
    for (const p of SILENT_PAIRS) {
      for (const text of [p.en, p.sv]) {
        const fired = SEARCH_SOURCES.filter((s) => s.intent(text)).map((s) => s.id);
        assert.deepEqual(fired, [], `sources fired on "${text}"`);
        assert.deepEqual(leadSourceIds(text), [], `a source LED on "${text}"`);
      }
    }
    for (const text of SILENT_EN) {
      const fired = SEARCH_SOURCES.filter((s) => s.intent(text)).map((s) => s.id);
      assert.deepEqual(fired, [], `sources fired on "${text}"`);
    }
  });

  test("every gate survives junk without throwing", () => {
    for (const s of SEARCH_SOURCES) {
      for (const junk of [undefined, null, 0, {}, [], "   ", "\n\n"]) {
        assert.equal(typeof s.intent(/** @type {any} */ (junk)), "boolean", `${s.id}.intent on ${String(junk)}`);
        if (s.leadIntent) {
          assert.equal(typeof s.leadIntent(/** @type {any} */ (junk)), "boolean", `${s.id}.leadIntent`);
        }
      }
    }
  });

  test("an appended enrichment block can flip the whole registry's verdict", () => {
    // The REGISTRY-side premise of feedback #61's fix (pipeline.js reads the
    // clean, pre-enrichment message — pinned at every call site by
    // src/pipeline.test.js). The gates are pure predicates over whatever text
    // they are handed, so they cannot defend themselves here: this pins that
    // handing them the AUGMENTED message really does change the answer, which
    // is why the caller must not.
    const clean = "Research this founder";
    const augmented =
      `${clean}\n\n[Person research method]\nRules: report only what is actually visible. ` +
      "Do NOT guess who an unnamed person is, do NOT infer age, ethnicity, health, religion, " +
      "politics, sexuality or any other personal characteristic. Prefer the peer-reviewed " +
      "literature and published sources where they exist.";

    assert.deepEqual(SEARCH_SOURCES.filter((s) => s.intent(clean)).map((s) => s.id), []);
    assert.deepEqual(leadSourceIds(clean), []);

    const firedOnBlock = SEARCH_SOURCES.filter((s) => s.intent(augmented)).map((s) => s.id);
    assert.ok(firedOnBlock.length > 0, "the enrichment block engages sources the user's own words do not");
    assert.ok(leadSourceIds(augmented).length > 0, "…and even LEADS, standing the web leg down");
  });
});

// ============================================================================
// §3 — leadIntent ⊆ intent
// ============================================================================

// A corpus of ways to name a place to look, EN and SV. Leading DISPLACES the
// generic web leg for the whole request, so every one of these has to be
// something the source's own intent gate also accepts — otherwise the request
// is spent on a source the registry itself says does not apply.
const LEAD_CORPUS = [
  "find arXiv research mentioning linux",
  "sök på arxiv efter artiklar om linux",
  "arxiv paper on linux scheduling",
  "läs arxiv om linuxschemaläggning",
  "on europe pmc, what is known about long covid",
  "vad är känt om långtidscovid enligt europe pmc",
  "pubmed studies on CRISPR off-target effects",
  "sök i pubmed efter artiklar om minimilön",
  "search openalex for papers on wage inequality",
  "check crossref for this doi",
  "look in scopus for citations of this paper",
  "google scholar the transformer paper",
  "kolla på semantic scholar",
  "look it up in scholar",
  "slå upp det i scholar",
  "hämta den från scholar",
  "use only peer-reviewed sources on minimum wage employment effects",
  "peer-reviewed articles only on urban heat islands",
  "bara sakkunniggranskade artiklar om minimilön",
  "the peer-reviewed literature on carbon capture costs",
  "the scientific literature on nuclear waste storage",
  "den vetenskapliga litteraturen om kärnavfall",
  "forskningslitteraturen om distansarbete",
  "what does the literature say about concrete carbon footprint",
  "vad säger litteraturen om statiner och muskelvärk",
  "an overview of the peer-reviewed research on the four-day week",
  "check arxiv and the web for this",
  "who won the election in france",
];

// ─────────────────────────────────────────────────────────────────────────────
// KNOWN VIOLATIONS — a bug list, not an exemption policy.
//
// search-sources.js documents leadIntent as "strictly narrower than `intent`",
// and src/search-sources.test.js checks it over six probes that happen to miss
// both of these. Sweeping the corpus above finds them. They are recorded (not
// asserted-as-correct) so that the sweep can run clean and NEW violations
// still fail; each entry names what actually happens in production.
//
//  (A) europepmc — `europepmcLeadIntent` accepts NAMED_PHRASE ("the
//      peer-reviewed literature", "the scientific literature", "den
//      vetenskapliga litteraturen", "what does the literature say"), none of
//      which requires a life-science subject, while `europepmcIntent` does.
//      So "the scientific literature on nuclear waste storage" makes the
//      LIFE-SCIENCE leg lead: pipeline.js's leadingSources returns it,
//      planAuxSource is entered with leading=true and skips the intent test
//      entirely, and up to EUROPEPMC_LEAD_MAX_PER_REQUEST=4 biomedical
//      searches run with the web leg standing down. Feedback #61's shape,
//      reached through the lead gate instead of an enrichment block.
//
//  (B) scholar — `scholarLeadIntent`'s LEAD_PHRASE lists the Swedish
//      "forskningslitteraturen", but `scholarIntent` cannot match it:
//      RESEARCH_WORD has `forskning(?:en)?` (killed by the following "s") and
//      `litteratur(?:en)?` (killed by the preceding "g"). Scholar still RUNS
//      (leading bypasses intent), but runPipeline's web-off short-circuit
//      tests applicability with `s.intent(...)` ALONE — so with web search
//      off, "forskningslitteraturen om distansarbete" falls through to a
//      sourceless answer although the registry says scholar leads it.
// ─────────────────────────────────────────────────────────────────────────────
const KNOWN_LEAD_WITHOUT_INTENT = [
  ["europepmc", "use only peer-reviewed sources on minimum wage employment effects"],
  ["europepmc", "peer-reviewed articles only on urban heat islands"],
  ["europepmc", "the peer-reviewed literature on carbon capture costs"],
  ["europepmc", "the scientific literature on nuclear waste storage"],
  ["europepmc", "den vetenskapliga litteraturen om kärnavfall"],
  ["europepmc", "forskningslitteraturen om distansarbete"],
  ["europepmc", "what does the literature say about concrete carbon footprint"],
  ["scholar", "forskningslitteraturen om distansarbete"],
];

describe("§3 leadIntent ⊆ intent", () => {
  test("no source leads a request its own intent gate rejects", () => {
    const known = new Set(KNOWN_LEAD_WITHOUT_INTENT.map(([id, text]) => `${id} ${text}`));
    for (const text of ALL_CORPUS_TEXTS()) {
      for (const s of SEARCH_SOURCES) {
        if (typeof s.leadIntent !== "function") continue;
        if (!s.leadIntent(text)) continue;
        if (s.intent(text)) continue;
        assert.ok(
          known.has(`${s.id} ${text}`),
          `${s.id} LEADS but does not engage on "${text}" — leading stands the web leg down, so this ` +
            "spends the whole request on a source the registry says does not apply (see " +
            "KNOWN_LEAD_WITHOUT_INTENT above for the two live instances)",
        );
      }
    }
  });

  test("leadSourceIds is registry-ordered and stands down when somewhere else is named too", () => {
    // "unless called for otherwise" (feedback #44): naming a second place to
    // look is not asking for one source only.
    assert.deepEqual(leadSourceIds("pubmed studies on CRISPR off-target effects"), ["europepmc", "scholar"]);
    assert.deepEqual(leadSourceIds("check arxiv and the web for this"), []);
    assert.deepEqual(leadSourceIds("find arXiv research mentioning linux"), ["arxiv"]);
  });
});

// ============================================================================
// §4 — FORCED / RESTRICTED ROUTING
// ============================================================================

// pipeline.js does not export planAuxSource, so its three state rules are
// transcribed here and driven over the real registry entries. The transcription
// is guarded against the real source text below, so it cannot drift silently.
const PIPELINE_SRC = readFileSync(new URL("./pipeline.js", import.meta.url), "utf8");
const MAX_AUX_SEARCHES_DEFAULT = 3;

/**
 * Would this source run for this message? (planAuxSource's entry test.)
 * @param {any} source
 * @param {string} text the CLEAN pre-enrichment message (ctx.gateLastUser)
 * @param {any} state
 * @param {boolean} [leading]
 */
function sourceRuns(source, text, state = {}, leading = false) {
  const only = state.auxOnly;
  if (Array.isArray(only) && only.length && !only.includes(source.id)) return false;
  // The STANDING narrowing beside that per-request one (owner directive,
  // 2026-08-13): a source may require a context block the answering agent has
  // to declare. `state.capability` null — the MCP channel, an unreadable
  // registry — keeps every source, which is why this reads a capability rather
  // than a list of ids.
  if (!capabilityAllowsSource(state.capability ?? null, source)) return false;
  const forced = Array.isArray(state.forceAux) && state.forceAux.includes(source.id);
  return Boolean(forced || leading || source.intent(text));
}

/**
 * How many searches this source gets this request. (planAuxSource's cap.)
 * @param {any} source
 * @param {any} state
 * @param {boolean} [leading]
 */
function capFor(source, state = {}, leading = false) {
  const override = state.auxMaxPerRequest?.[source.id];
  const declared = leading ? source.leadMaxPerRequest ?? source.maxPerRequest : source.maxPerRequest;
  return typeof override === "number" && override > 0 ? override : declared ?? MAX_AUX_SEARCHES_DEFAULT;
}

describe("§4 forced / restricted routing", () => {
  test("the transcription above still matches pipeline.js", () => {
    // If any of these lines moves, the mirror is stale and every behavioural
    // assertion below is testing a fiction. Fix the mirror, don't delete this.
    for (const line of [
      "if (Array.isArray(only) && only.length && !only.includes(source.id)) return [];",
      "if (!sourceAllowed(state, source)) return [];",
      "if (!batch.length || (!forced && !leading && !source.intent(ctx.gateLastUser))) return [];",
      "const override = /** @type {any} */ (state).auxMaxPerRequest?.[source.id];",
      "const declared = (leading ? source.leadMaxPerRequest ?? source.maxPerRequest : source.maxPerRequest);",
      "const cap = typeof override === \"number\" && override > 0 ? override : (declared ?? MAX_AUX_SEARCHES_DEFAULT);",
    ]) {
      assert.ok(PIPELINE_SRC.includes(line), `planAuxSource no longer contains: ${line}`);
    }
    assert.match(PIPELINE_SRC, /const MAX_AUX_SEARCHES_DEFAULT = 3;/);
  });

  test("state.forceAux runs a source the message does not engage", () => {
    // The Models agent's whole identity is the hub, so it must not fall
    // through to a hub-less answer just because the turn didn't name it
    // (feedback #36).
    const hf = entry("hf");
    const text = "what changed in the eu ai act this year";
    assert.equal(hf.intent(text), false, "precondition: the message does not engage the hub");
    assert.equal(sourceRuns(hf, text), false);
    assert.equal(sourceRuns(hf, text, { forceAux: ["hf"] }), true);
    // Forcing one source says nothing about the others.
    assert.equal(sourceRuns(entry("arxiv"), text, { forceAux: ["hf"] }), false);
  });

  test("state.auxOnly narrows to exactly that set, intent and lead notwithstanding", () => {
    // How Deep Science keeps its promise: `search.web: false` only stands the
    // Exa leg down, so without this arXiv would still fire on a physics
    // question and hand a peer-review-only agent preprints.
    const state = { forceAux: [SCHOLAR_SOURCE_ID], auxOnly: [SCHOLAR_SOURCE_ID] };
    const text = "any preprints on diffusion transformers";
    assert.equal(entry("arxiv").intent(text), true, "precondition: arXiv would otherwise fire");

    const ran = SEARCH_SOURCES.filter((s) => sourceRuns(s, text, state)).map((s) => s.id);
    assert.deepEqual(ran, [SCHOLAR_SOURCE_ID]);
    // …including against a LEAD, which is why leadingSources filters by
    // auxOnly before planAuxSource ever sees it.
    assert.equal(sourceRuns(entry("arxiv"), text, state, true), false);
    // And the narrowing is meaningful: three sources are excluded, not zero.
    assert.equal(SEARCH_SOURCES.length - ran.length, 3);
  });

  test("state.auxMaxPerRequest overrides the registry cap, ordinary or leading", () => {
    const hf = entry("hf");
    assert.equal(capFor(hf), 3, "registry default");
    assert.equal(capFor(hf, { auxMaxPerRequest: { hf: HUB_SEARCHES_PER_REQUEST } }), HUB_SEARCHES_PER_REQUEST);
    // An override for another source leaves this one alone.
    assert.equal(capFor(hf, { auxMaxPerRequest: { arxiv: 6 } }), 3);
    // Junk and non-positive overrides fall back to the declared ceiling.
    assert.equal(capFor(hf, { auxMaxPerRequest: { hf: 0 } }), 3);
    assert.equal(capFor(hf, { auxMaxPerRequest: { hf: "many" } }), 3);

    const scholar = entry(SCHOLAR_SOURCE_ID);
    assert.equal(capFor(scholar), 2);
    assert.equal(capFor(scholar, {}, true), 4, "leading raises it");
    assert.equal(
      capFor(scholar, { auxMaxPerRequest: { [SCHOLAR_SOURCE_ID]: SCHOLAR_SEARCHES_PER_REQUEST } }, true),
      SCHOLAR_SEARCHES_PER_REQUEST,
      "…and the agent's override outranks even the leading ceiling",
    );
  });

  test("state.capability narrows on TOP of auxOnly — the roster split, end to end", () => {
    // The two narrowings compose, and they are different in kind: `auxOnly` is
    // what an enrichment wrote for THIS turn, `requiresContext` is what the
    // answering agent's spec declares standing (owner directive, 2026-08-13).
    // Neither can readmit what the other refused.
    const scholarCap = { context: ["scholar-metrics", "literature-peer-reviewed", "literature-arxiv", "literature-pubmed"] };
    const text = "any arxiv preprints on diffusion transformers";

    // Deep Science's DEFAULT turn: it owns arXiv but has not been asked for it.
    const strict = { capability: scholarCap, forceAux: [SCHOLAR_SOURCE_ID], auxOnly: [SCHOLAR_SOURCE_ID] };
    assert.deepEqual(SEARCH_SOURCES.filter((s) => sourceRuns(s, text, strict)).map((s) => s.id), [SCHOLAR_SOURCE_ID]);

    // …and the same turn once the ask NAMED the preprint record, which is what
    // src/scholar-metrics.js's preprintSources adds to auxOnly.
    const widened = { ...strict, auxOnly: [SCHOLAR_SOURCE_ID, "arxiv"] };
    assert.deepEqual(SEARCH_SOURCES.filter((s) => sourceRuns(s, text, widened)).map((s) => s.id), ["arxiv", SCHOLAR_SOURCE_ID]);

    // An agent that does NOT own the corpus cannot reach it however the message
    // is phrased — no auxOnly, no forceAux, intent firing, and still nothing.
    const cyberCap = { context: ["owasp", "host-intel"] };
    assert.equal(entry("arxiv").intent(text), true, "precondition: the message engages arXiv");
    assert.equal(sourceRuns(entry("arxiv"), text, { capability: cyberCap }), false);
    // …not even when a forceAux list names it, because the standing declaration
    // outranks a per-request instruction.
    assert.equal(sourceRuns(entry("arxiv"), text, { capability: cyberCap, forceAux: ["arxiv"] }), false);
    // …and not even leading, which is why leadingSources filters first.
    assert.equal(sourceRuns(entry("arxiv"), text, { capability: cyberCap }, true), false);

    // The palaeogenomics agent keeps its life-science leg and gets no preprint
    // archive — the explicit preservation (src/literature-exclusivity.test.js).
    const adnaCap = { context: ["ancient-samples", "literature-pubmed"] };
    const adna = "pubmed studies on ancient DNA damage patterns";
    assert.deepEqual(
      SEARCH_SOURCES.filter((s) => sourceRuns(s, adna, { capability: adnaCap })).map((s) => s.id),
      ["europepmc"],
    );

    // And a request that resolved NO capability keeps everything: the MCP
    // channel builds its state without a registry (invariant 2).
    assert.equal(sourceRuns(entry("arxiv"), text, {}), true);
    assert.equal(sourceRuns(entry("arxiv"), text, { capability: null }), true);
  });

  test("the Deep Science state, applied whole, yields exactly one source at its raised cap", () => {
    const state = {
      forceAux: [SCHOLAR_SOURCE_ID],
      auxOnly: [SCHOLAR_SOURCE_ID],
      auxMaxPerRequest: { [SCHOLAR_SOURCE_ID]: SCHOLAR_SEARCHES_PER_REQUEST },
    };
    // Even on a message that engages nothing at all.
    const text = "how do I fix a leaking tap";
    const ran = SEARCH_SOURCES.filter((s) => sourceRuns(s, text, state));
    assert.deepEqual(ran.map((s) => s.id), [SCHOLAR_SOURCE_ID]);
    assert.equal(capFor(ran[0], state), SCHOLAR_SEARCHES_PER_REQUEST);
  });
});

// ============================================================================
// §5 — FAIL-SOFT PER SOURCE (invariant 2)
// ============================================================================

// Driven through the REGISTRY's own `search` reference — what the orchestrator
// calls — so a mis-wired entry fails here too. A helper phase degrades to a
// lesser result; it never errors the chat.
const SEARCH_CASES = [
  { id: "hf", query: "whisper swedish speech", empty: [] },
  {
    id: "arxiv",
    query: "quantum error correction surface code",
    empty: '<?xml version="1.0" encoding="UTF-8"?><feed xmlns="http://www.w3.org/2005/Atom"></feed>',
  },
  { id: "europepmc", query: "vitamin D supplementation respiratory infection", empty: { resultList: { result: [] } } },
  {
    id: "scholar",
    query: "vitamin D supplementation acute respiratory infection",
    // One shape covering every backend's "found nothing".
    empty: { results: [], resultList: { result: [] }, data: [], organic_results: [] },
  },
];

const FAIL_MODES = [
  { name: "a non-OK status", responder: () => new Response("upstream is unhappy", { status: 500 }) },
  {
    name: "a throwing / aborted fetch",
    responder: () => {
      throw new Error("network down");
    },
  },
  { name: "a malformed body (HTML where JSON/XML was promised)", responder: () => "<html><body>nope</body></html>" },
];

describe("§5 fail-soft per source", () => {
  for (const c of SEARCH_CASES) {
    for (const mode of FAIL_MODES) {
      test(`${c.id}: ${mode.name} degrades to zero items, never a throw`, async () => {
        const log = fakeLog();
        await withFakeFetch([[() => true, mode.responder]], async (stub) => {
          const res = await entry(c.id).search(/** @type {any} */ ({}), log, c.query, {});
          assert.deepEqual(res.items, [], `${c.id} returned items from a failed upstream`);
          assert.equal(typeof res.durationMs, "number");
          // The query really did drive attempts — otherwise "no items" is
          // vacuous and would pass for a source that never fires at all.
          assert.ok(stub.requests.length > 0, `${c.id} made no request for "${c.query}"`);
        });
      });
    }

    test(`${c.id}: an empty result set is an answer, not an error`, async () => {
      const log = fakeLog();
      await withFakeFetch([[() => true, c.empty]], async (stub) => {
        const res = await entry(c.id).search(/** @type {any} */ ({}), log, c.query, {});
        assert.deepEqual(res.items, []);
        assert.ok(stub.requests.length > 0);
        // A rung that found nothing was still SPENT: the attempt keys come
        // back so a later wave's ladder skips them instead of re-fetching the
        // same empty result (pipeline.js absorbAuxResult records them).
        assert.ok(Array.isArray(res.usedKeys), `${c.id}: no usedKeys reported`);
        assert.ok(res.usedKeys.length > 0, `${c.id}: an empty rung was not recorded as consumed`);
      });
    });
  }

  test("no source leaks the conversation upstream — only the query crosses the wire", () => {
    // Invariant 4, pinned at the registry seam: the orchestrator hands the
    // source a planner-derived query string and nothing else, so a source that
    // started reading the conversation would need a signature change. This is
    // the shape guard for that.
    for (const s of SEARCH_SOURCES) {
      assert.equal(
        s.search.length,
        3,
        `${s.id}.search must be (env, log, query, opts = {}) — three required params and nothing that could ` +
          "carry the conversation, a filename or an identity",
      );
    }
  });
});

// ============================================================================
// §6 — src/scholar.js's SUB-BACKENDS AND THEIR KEY GATES
// ============================================================================

const OA_HOST = "api.openalex.org";
const EPMC_HOST = "www.ebi.ac.uk";
const S2_HOST = "api.semanticscholar.org";
const SERP_HOST = "serpapi.com";
const CROSSREF_HOST = "api.crossref.org";

/** OpenAlex works, in the shape peerReviewed() admits (journal venue + ISSN). */
function oaBody(n = 4) {
  return {
    results: Array.from({ length: n }, (_, i) => ({
      id: `https://openalex.org/W${i}`,
      doi: `https://doi.org/10.1136/bmj.${i}`,
      display_name: `Vitamin D and respiratory infection ${i}`,
      publication_year: 2017,
      cited_by_count: 900 - i,
      type: "article",
      is_retracted: false,
      primary_location: {
        source: { display_name: "BMJ", type: "journal", issn_l: "0959-8138", host_organization_name: "BMJ" },
      },
      authorships: [{ author: { display_name: "A Martineau" } }],
    })),
  };
}

/** Europe PMC's peer-reviewed slice (SRC:MED + a journal title). */
function epmcBody(n = 4) {
  return {
    resultList: {
      result: Array.from({ length: n }, (_, i) => ({
        id: `${i}`,
        source: "MED",
        doi: `10.1016/epmc.${i}`,
        title: `Micronutrients and infection ${i}`,
        authorString: "B Author",
        pubYear: "2019",
        journalInfo: { journal: { title: "Lancet", issn: "0140-6736" } },
        abstractText: "abstract",
        citedByCount: 40,
      })),
    },
  };
}

/** Semantic Scholar (JournalArticle + venue + DOI). */
const s2Body = {
  data: [
    {
      paperId: "s2-1",
      title: "Semantic Scholar only paper",
      year: 2020,
      journal: { name: "Nature Medicine" },
      externalIds: { DOI: "10.1038/s2only.1" },
      publicationTypes: ["JournalArticle"],
      citationCount: 12,
      authors: [{ name: "C Author" }],
      abstract: "abstract",
    },
  ],
};

/** SerpApi's Google Scholar engine — a hit with NO peer-review signal. */
const serpBody = {
  organic_results: [
    {
      title: "A Scholar-only result",
      link: "https://example.org/paper.pdf",
      publication_info: { summary: "A Author, B Author - Some Working Paper Series, 2018" },
      inline_links: { cited_by: { total: 4200 } },
    },
  ],
};

describe("§6 scholar sub-backends", () => {
  const query = "vitamin D supplementation acute respiratory infection";

  test("with no keys at all, only the keyless backends are contacted", async () => {
    const log = fakeLog();
    await withFakeFetch(
      [
        [OA_HOST, oaBody()],
        [EPMC_HOST, epmcBody()],
      ],
      async (stub) => {
        const res = await entry("scholar").search(/** @type {any} */ ({}), log, query, {});
        assert.ok(res.items.length > 0, "the keyless ladder still answers — this agent works with no secrets set");
        // The whole point: an unconfigured backend is SKIPPED, not tried and
        // failed. Nothing reaches its host, so nothing about the question is
        // disclosed to a provider this deployment has no contract with.
        assert.deepEqual(stub.hosts().sort(), [OA_HOST, EPMC_HOST].sort());
        assert.equal(stub.matching(S2_HOST).length, 0, "Semantic Scholar was contacted without a key");
        assert.equal(stub.matching(SERP_HOST).length, 0, "SerpApi was contacted without a key");
        // …and skipping is silent: no error, no warning naming the leg.
        assert.doesNotMatch(log.text(), /semanticscholar|gscholar/);
      },
    );
  });

  test("SEMANTIC_SCHOLAR_API_KEY switches its leg on, and rides as a header only", async () => {
    const log = fakeLog();
    await withFakeFetch(
      [
        [OA_HOST, { results: [] }],
        [EPMC_HOST, { resultList: { result: [] } }],
        [S2_HOST, s2Body],
      ],
      async (stub) => {
        const res = await entry("scholar").search(
          /** @type {any} */ ({ SEMANTIC_SCHOLAR_API_KEY: "s2-secret" }),
          log,
          query,
          {},
        );
        const calls = stub.matching(S2_HOST);
        assert.ok(calls.length > 0, "the keyed leg did not run");
        assert.equal(calls[0].headers["x-api-key"], "s2-secret");
        assert.ok(!calls[0].url.includes("s2-secret"), "the key must not ride in the URL");
        assert.equal(stub.matching(SERP_HOST).length, 0, "SerpApi stays off — different key, different leg");
        // The secret goes to its own host and nowhere else (invariant 4).
        for (const r of stub.requests) {
          if (r.host === S2_HOST) continue;
          assert.ok(!`${r.url}${JSON.stringify(r.headers)}`.includes("s2-secret"), `leaked to ${r.host}`);
        }
        assert.equal(res.items[0].title, "Semantic Scholar only paper");
      },
    );
  });

  test("SERPAPI_KEY is what turns the Google Scholar leg on at all", async () => {
    const routes = [
      [OA_HOST, { results: [] }],
      [EPMC_HOST, { resultList: { result: [] } }],
      [SERP_HOST, serpBody],
      [CROSSREF_HOST, { message: { items: [] } }],
    ];
    // Off without the key: Scholar's index has no free door, so the leg makes
    // no request rather than a failing one.
    await withFakeFetch(/** @type {any} */ (routes), async (stub) => {
      await entry("scholar").search(/** @type {any} */ ({}), fakeLog(), query, {});
      assert.equal(stub.matching(SERP_HOST).length, 0);
    });
    // On with it, and the key rides in serpapi's own query string.
    await withFakeFetch(/** @type {any} */ (routes), async (stub) => {
      await entry("scholar").search(/** @type {any} */ ({ SERPAPI_KEY: "serp-secret" }), fakeLog(), query, {});
      const calls = stub.matching(SERP_HOST);
      assert.ok(calls.length > 0, "the licensed Scholar leg did not run with a key set");
      assert.match(calls[0].url, /engine=google_scholar/);
      assert.match(calls[0].url, /api_key=serp-secret/);
      for (const r of stub.requests) {
        if (r.host === SERP_HOST) continue;
        assert.ok(!r.url.includes("serp-secret"), `serpapi key leaked to ${r.host}`);
      }
    });
  });

  test("a dead OpenAlex still yields Europe PMC results — the fan-out really is per-call", async () => {
    // Each backend is awaited with its own `.catch(() => [])`, so one 500 must
    // cost exactly that backend's results and nothing else.
    const log = fakeLog();
    await withFakeFetch(
      [
        [OA_HOST, () => new Response("openalex is down", { status: 500 })],
        [EPMC_HOST, epmcBody()],
      ],
      async (stub) => {
        const res = await entry("scholar").search(/** @type {any} */ ({}), log, query, {});
        assert.ok(res.items.length > 0, "a dead OpenAlex took the whole source down with it");
        assert.ok(
          res.items.every((i) => i.title.startsWith("Micronutrients")),
          "the surviving items are Europe PMC's peer-reviewed slice",
        );
        assert.ok(stub.matching(OA_HOST).length > 0, "OpenAlex was tried");
        assert.match(log.text(), /openalex/, "the failure is recorded, not swallowed silently");
      },
    );
  });

  test("a Scholar candidate Crossref cannot verify is left unadmitted, not thrown", async () => {
    // A Google Scholar hit carries no peer-review signal, so it is only ever
    // admitted by merging onto a record that has one. With OpenAlex and
    // Europe PMC empty there is nothing to merge onto, and Crossref is the
    // last chance — a dead Crossref must therefore produce zero items and no
    // error, not an unverified paper presented as peer-reviewed.
    const log = fakeLog();
    await withFakeFetch(
      [
        [OA_HOST, { results: [] }],
        [EPMC_HOST, { resultList: { result: [] } }],
        [SERP_HOST, serpBody],
        [CROSSREF_HOST, () => new Response("crossref is down", { status: 500 })],
      ],
      async (stub) => {
        const res = await entry("scholar").search(/** @type {any} */ ({ SERPAPI_KEY: "k" }), log, query, {});
        assert.deepEqual(res.items, []);
        assert.ok(stub.matching(CROSSREF_HOST).length > 0, "Crossref was asked about the candidate");
      },
    );
  });

  test("Crossref's Faculty-Opinions trap does not admit a recommendation OF the paper", async () => {
    // Asked for an exact title, Crossref will happily return a `dataset`
    // record called "Faculty Opinions recommendation of <that title>". The
    // normalized-title check must reject it — otherwise verification quietly
    // swaps the paper for a review of the paper.
    const log = fakeLog();
    await withFakeFetch(
      [
        [OA_HOST, { results: [] }],
        [EPMC_HOST, { resultList: { result: [] } }],
        [SERP_HOST, serpBody],
        [
          CROSSREF_HOST,
          {
            message: {
              items: [
                {
                  title: ["Faculty Opinions recommendation of A Scholar-only result"],
                  DOI: "10.3410/f.1234",
                  type: "dataset",
                  ISSN: ["1234-5678"],
                },
              ],
            },
          },
        ],
      ],
      async (stub) => {
        const res = await entry("scholar").search(/** @type {any} */ ({ SERPAPI_KEY: "k" }), log, query, {});
        assert.deepEqual(res.items, []);
        assert.match(log.text(), /crossref_title_mismatch/, "the mismatch is the reason it was dropped");
        assert.ok(stub.matching(CROSSREF_HOST).length > 0);
      },
    );
  });

  test("every configured backend is contacted, and no unconfigured one is", async () => {
    // The ladder's shape is "whatever this deployment has keys for", with no
    // branching at the call site — so the host list IS the configuration.
    const log = fakeLog();
    await withFakeFetch(
      [
        [OA_HOST, oaBody()],
        [EPMC_HOST, epmcBody()],
        [S2_HOST, s2Body],
        [SERP_HOST, serpBody],
        [CROSSREF_HOST, { message: { items: [] } }],
      ],
      async (stub) => {
        await entry("scholar").search(
          /** @type {any} */ ({ SEMANTIC_SCHOLAR_API_KEY: "a", SERPAPI_KEY: "b", OPENALEX_API_KEY: "c" }),
          log,
          query,
          {},
        );
        for (const host of [OA_HOST, EPMC_HOST, S2_HOST, SERP_HOST]) {
          assert.ok(stub.matching(host).length > 0, `${host} was not contacted although it is configured`);
        }
        // The OpenAlex key rides on OpenAlex's own request and nowhere else.
        assert.match(stub.matching(OA_HOST)[0].url, /api_key=c/);
        for (const r of stub.requests) {
          if (r.host === OA_HOST) continue;
          assert.ok(!r.url.includes("api_key=c"), `OpenAlex key leaked to ${r.host}`);
        }
      },
    );
  });
});
