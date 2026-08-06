// @ts-check
// Europe PMC search — a search-phase source for the research pipeline, and the
// life-science literature leg the platform did not have.
//
// arXiv (src/arxiv.js) covers physics, maths, CS and q-bio preprints. Almost no
// genetics lands there: an ancient-DNA study appears in Nature, Cell, Current
// Biology, PNAS or on bioRxiv, and NONE of those are on arXiv. So a question
// about mammoth genomes, haplogroups, radiocarbon dating or palaeoproteomics
// had exactly one leg — the generic web — and answered from news write-ups
// rather than from the literature. This module is the other leg.
//
// Europe PMC indexes PubMed/MEDLINE, PubMed Central, bioRxiv/medRxiv preprints,
// patents and theses behind ONE free REST API with no key and no account. That
// breadth is the reason to prefer it over the NCBI E-utilities: one request
// reaches both the peer-reviewed record and the preprint frontier, where
// E-utilities needs a separate esearch/efetch round-trip per database and
// publishes a 3 requests/second ceiling.
//
// Wired the same deterministic, no-function-calling way as every other source
// (invariant 1): intent detection is a pure regex over the latest user message,
// the API call is a direct timeout-bounded fetch, and every branch fails soft
// to "no Europe PMC results" (invariant 2 — the Exa wave is untouched).
//
// MINIMAL OUTBOUND REQUEST, the same rule Exa/arXiv/HF/Shodan/Maps follow: only
// the AI-derived search terms cross the wire. Never the conversation, never a
// filename, never any account identity. Europe PMC learns a query and nothing
// about who asked.
//
// ---- the query grammar, established empirically (2026-07-29, curl) ----------
//
// Endpoint `https://www.ebi.ac.uk/europepmc/webservices/rest/search`, JSON with
// `format=json`. Measured hit counts for the same three concepts, which is what
// the ladder below is built on:
//
//   ancient DNA mammoth                            → 719   bare terms
//   "ancient DNA" mammoth                          → 490   quoted phrase
//   "ancient DNA" AND "mammoth"                    → 490   ← identical
//   "ancient DNA" OR "mammoth"                     → 13793
//   ABSTRACT:"ancient DNA" AND ABSTRACT:"mammoth"  → 57
//
// Three facts follow, and each one shapes a decision here:
//
// 1. **The default operator is AND**, not OR — the quoted form and the explicit
//    AND form return byte-identical counts. This is the OPPOSITE of arXiv,
//    where unquoted spaces inside a field mean OR and adding words widens the
//    result set (see arxiv.js). So here, adding a term NARROWS, and the ladder
//    below climbs by DROPPING terms rather than by adding them.
// 2. **Quoted phrases work** in the catch-all field — again the opposite of
//    arXiv, where `all:"multi word phrase"` returns 0 results, always. Quoting
//    costs 32% of the recall (719 → 490) and buys phrase precision, which is
//    the right trade for a two-or-three-concept research query.
// 3. **Field-restricting to ABSTRACT is too narrow to lead with**: 490 → 57, an
//    88% cut, because a paper whose ABSTRACT never spells out one of the
//    concepts is still the paper you wanted. It is kept as the FIRST rung only
//    for queries with enough concepts to survive it, and the ladder falls
//    through to the unrestricted form.
//
// Other measured behaviour used below: `SRC:PPR` selects preprints
// (bioRxiv/medRxiv — 646 hits for ancient DNA alone, a real frontier leg);
// `sort=CITED desc` and `sort=P_PDATE_D desc` both work and return the same hit
// count with different heads; `OPEN_ACCESS:Y` and `FIRST_PDATE:[a TO b]` filter
// as documented. `resultType=core` is what carries abstractText, doi,
// citedByCount and journalInfo — the lite default carries none of them.
//
// ---- rate limits -----------------------------------------------------------
//
// Europe PMC publishes no hard per-second ceiling but asks for considerate use
// and rate-limits abusive clients. Two fetches per search and a per-request cap
// of 2 searches (EUROPEPMC_MAX_PER_REQUEST) keeps a research turn at ≤4
// requests, which is in the same range as the arXiv leg it sits beside.

import { pubmedRagAvailable, pubmedRagSearch } from "./pubmed-rag.js";
// The tally the hosted tier folds its provider tokens into, so this leg's
// spend reaches the request's accounting (src/billing.js denseSpend).
import { newRetrievalSpend } from "./dense-rag.js";

const API = "https://www.ebi.ac.uk/europepmc/webservices/rest/search";
const TIMEOUT_MS = 7000;
const PAGE_SIZE = 8;

/** Per-request wave cap. Below the registry default of 3: each search is TWO
 * fetches (the cited slice and the recent slice), so 2 here is already 4
 * requests per turn. */
export const EUROPEPMC_MAX_PER_REQUEST = 2;

/** The cap while LEADING — the web leg has stood down, so the wave's breadth
 * has to come from somewhere. Same reasoning as arXiv's lead cap. */
export const EUROPEPMC_LEAD_MAX_PER_REQUEST = 4;

/** Merged item cap per search. */
const MAX_ITEMS = 6;

/** How many distinct records a rung must have produced (cumulatively) before
 * the ladder stops climbing. See the fall-through reasoning in europepmcSearch. */
const MIN_RUNG_HITS = 3;

// ---- intent ---------------------------------------------------------------
//
// EN and SV alike, at the same breadth (invariant 6). Two tiers, because the
// two mistakes cost differently: firing on a question the literature cannot
// answer wastes a wave, while missing one answers a genetics question from
// press coverage.

// ---- a trap that makes Swedish gates silently dead -------------------------
//
// JavaScript's `\b` is defined over [A-Za-z0-9_] ONLY. `ä`, `ö`, `å` are not
// word characters to it, so `/\böversikt/` can never match " översikt": the
// boundary needs a word character on one side and finds two non-word ones.
// Every Swedish alternative that begins or ends with an accented letter — and
// `\w*` as a Swedish suffix wildcard, which stops at the first `ä` — is dead on
// arrival inside a `\b(…)\b` group, and it fails SILENTLY: the English half
// keeps matching, the tests pass if they only try English, and the gate simply
// never fires in Swedish. Invariant 6 is not satisfiable with `\b`.
//
// So the bilingual gates below use Unicode-aware lookaround boundaries with the
// `u` flag instead. LETTER is the suffix wildcard for the same reason.
const B = "(?<![\\p{L}\\p{N}_])";
const E = "(?![\\p{L}\\p{N}_])";
const LETTER = "[\\p{L}]*";

/** The IMPERATIVE frame — a verb addressed to the assistant with a task object,
 * not a reference to the scholarly record.
 *
 * Feedback #61 (chat_logs #1656, 2026-08-05): a user attached a LinkedIn
 * screenshot and wrote "Research this founder". The bare English imperative
 * "research" satisfied RESEARCH_WORD, a stray "health" satisfied the
 * life-science half, and a founder-background question was answered partly out
 * of the biomedical literature. The distinction that matters is verb vs noun:
 * "research this X" is an instruction, while "research on X", "the research
 * shows" and "studies say" name the published record. The frame is NEUTRALISED
 * before the research-word gate rather than deleted from it, so "the latest
 * research on statins" — the noun — keeps firing.
 *
 * What the frame is NOT is a veto over the whole message. Neutralising it first
 * also cost "Research this drug's side effects" its only research word, and a
 * plainly biomedical question then reached no source at all. So the frame
 * decides only what the VERB is worth: an imperative "research" is not evidence
 * that the user wants the LITERATURE, while a life-science SUBJECT is
 * independent evidence that Europe PMC is a useful leg. The veto then lands
 * exactly where the reported failure was — an imperative over a subject that is
 * not biomedical at all ("Research this founder"). See europepmcIntent for the
 * order that follows from this.
 *
 * Deliberately narrow: only a sentence-initial verb whose next word is a
 * demonstrative or a personal/possessive pronoun counts. "the research this
 * year showed" is mid-sentence and survives, and `that`/`it` are NOT in the
 * object list because "research that shows X" is a relative pronoun.
 *
 * Swedish carries the same breadth (invariant 6): the loanword imperative
 * ("research den här grundaren"), the native verbs granska / studera /
 * undersök / kolla upp / analysera, and the Swedish objects den här, denna,
 * dessa, honom, deras … Two of those native verbs are not RESEARCH_WORD
 * members today; stripping them anyway keeps the frame one rule rather than
 * two, and keeps the parity from rotting the next time a verb is added. */
const IMPERATIVE_TASK = new RegExp(
  "(?:^|[.!?;:\\n]\\s*)(?:(?:please|kindly|kan du|snälla|var vänlig(?:\\s+och)?)\\s+)?" +
    "(?:research|review|study|survey|investigate|look\\s+into|dig\\s+into|check\\s+out" +
    "|granska|studera|undersök|kolla\\s+upp|kolla|analysera)" +
    "(?=\\s+(?:this|these|those|him|her|them|his|their|my|our|its" +
    "|den\\s+här|det\\s+här|de\\s+här|den\\s+där|det\\s+där|de\\s+där" +
    "|denna|detta|dessa|honom|henne|dem|hans|hennes|deras|min|mitt|mina|vår|vårt|våra)" +
    "(?![\\p{L}\\p{N}_]))",
  "giu",
);

/** Terms that name the life-science literature as a body of work, in either
 * language. Definite and plural Swedish forms included ("studien", "studierna",
 * "forskningen"), which is how Swedish actually asks.
 *
 * The PROVEN family is here for a reported miss (feedback #54, 2026-07-30):
 * "Spirulina proven health benefits" reached no literature leg at all and was
 * answered from supplement-marketing pages. "proven"/"proof"/"evidence-based"
 * is how a lay question asks for the published record, and nothing in this
 * repo's gates fired on it \u2014 `evidence` did, `proven` did not. Note
 * "scientific" needs its `-ally` suffix spelled out: the E boundary makes
 * "scientifically" a non-match for a bare "scientific". */
const RESEARCH_WORD = new RegExp(
  B +
    "(?:stud(?:y|ies)|papers?|publications?|literature|research|evidence|reviews?|preprints?" +
    "|peer[-\\s]?review(?:ed)?|findings?|trials?|scientific(?:ally)?|clinically" +
    "|proven|proved|proves|unproven|disproven|proofs?|evidence[-\\s]?based|empirical(?:ly)?" +
    "|studie|studien|studier|studierna|artikel|artikeln|artiklar|artiklarna" +
    "|publikation|publikationer|publicerad[et]?|litteratur|litteraturen" +
    "|forskning|forskningen|forskningsl\u00e4get|bevis|bel\u00e4gg|\u00f6versikt|granskning" +
    "|vetenskaplig[at]?|vetenskapligt|bevisad[et]?|bevisade|bevisat|p\u00e5visad[et]?|p\u00e5visade" +
    "|evidensbaserad[et]?|styrkt[a]?|belagd[at]?|dokumenterad[et]?" +
    "|sakkunniggransk" + LETTER + "|f\u00f6rhandstryck|r\u00f6n)" +
    E,
  "iu",
);

/** Life-science subject matter, in either language. Deliberately wide on the
 * genetics/palaeogenomics side — that is the domain this leg was added for —
 * and narrow everywhere else, so it does not claim general science.
 *
 * HEALTH AND MEDICINE (added 2026-08-01, feedback #54) is the second wide
 * strand, and it is not a widening of scope: PubMed *is* the biomedical
 * literature, and the reported failure was a health question ("Spirulina
 * proven health benefits") that could not reach this source because nothing
 * short of genetics counted as life science. Health words still only fire in
 * combination with a RESEARCH_WORD, so "healthy office chairs" alone stays
 * out — it is the pairing that means "ask the literature".
 *
 * ---- what this tier deliberately does NOT contain (feedback #61) -----------
 *
 * A word that is ordinary general English or general Swedish is not subject
 * matter, however biomedical its other sense. The pairing gate only asks that
 * SOME research word appear somewhere in the same message, and a research
 * assistant's own methodology text supplies one for free. The reported failure
 * was exactly that: "health" reached this gate from inside a privacy
 * PROHIBITION ("never an inference of ethnicity, health, religion …") and
 * pulled a founder-background question into the biomedical literature.
 *
 * So the ambiguous words moved OUT of this tier and into LIFE_SCIENCE_PHRASE
 * below, where they count only inside a collocation no other domain writes:
 *
 *   health / healthy   "company health", "a healthy margin"
 *   heart, brain(s)    "at the heart of", "the brains behind it"
 *   immune / immunity  "no startup is immune to a downturn"
 *   sequence(s)        "a sequence of events"
 *   assembly           "assembly line", "assembly language"
 *   patient (sing.)    "be patient", "patient capital" — `patients` stays here
 *   muscle(s)          "financial muscle"
 *   minerals           "mineral rights", mining
 *   virus(es)          "computer virus"
 *   SV hjärta/hjärna   "i hjärtat av staden", "hjärnan bakom"
 *   SV lever           the verb "lives" — `levern`, the organ, stays here
 *   SV hälsa/hälsan    also the verb "to greet" ("hälsa på")
 *   SV bare genom      the preposition "through" — `genomet`/`genome` stay here
 *   SV bare dos, bare sekvenser, bare patient
 *
 * Swedish keeps parity through COMPOUNDING where it compounds: hälsoeffekt,
 * hälsorisk, hjärtsjukdom, muskelmassa are single unambiguous words, so they
 * live here while bare `hälsa` and `hjärta` do not. That is only half of how
 * Swedish is actually written, though — "hälsa och skiftarbete", "muskler hos
 * äldre", "hjärnan under sömn" are the separated forms users type, and reading
 * the compound as the whole of the Swedish side is what left this gate firing
 * in English and silent in Swedish on seven matched pairs (invariant 6). The
 * separated forms are LIFE_SCIENCE_SV_SEPARATED, below LIFE_SCIENCE_PHRASE.
 *
 * Judged ambiguous but KEPT, because the non-biomedical sense is too rare to
 * lose the recall over: species, symptom(s), drug(s), gene(s), diagnostic,
 * taxa, treatment(s) — whose one common non-medical sense, the GDPR-style
 * "treatment of personal data" / "behandling av personuppgifter", is excluded
 * by lookahead instead. */
const LIFE_SCIENCE_WORD = new RegExp(
  B +
    "(?:healthcare|medical|medicine|medicinal|clinical|clinic|patients" +
    "|disease|diseases|illness(?:es)?|symptoms?|diagnos(?:is|es|tic)|syndrome" +
    "|treatments?(?!\\s+of\\s+(?:personal\\s+)?(?:data|information))" +
    "|therap(?:y|ies|eutic)|drugs?|pharmaceutical|dosages?|dosing|doses" +
    "|side[-\\s]?effects?|adverse (?:effects?|events?|reactions?)|contraindicat" + LETTER +
    "|toxicity|efficacy|supplements?|supplementation|vitamins?|nutrients?" +
    "|nutrition(?:al)?|diet(?:ary)?|probiotics?|antioxidants?|inflammation" +
    "|cancers?|tumou?rs?|diabetes|obesity|cholesterol|blood pressure|cardiovascular" +
    "|cardiac|livers?|kidneys?|lungs?|omega[-\\s]?3|fatty acids?" +
    "|njur(?:e|ar|arna|en)|lung(?:a|or|orna|an)|levern" +
    "|tarmflora|fettsyr(?:a|or|orna)" +
    "|hälsoeffekt(?:er|erna|en)?|hälsofördel(?:ar|arna|en)?|hälsorisk(?:er|erna|en)?" +
    "|hälsotillstånd(?:et)?|hälsoproblem(?:et|en)?|folkhälsa(?:n)?" +
    "|medicinsk[at]?|medicin(?:en|er)?|klinisk[at]?|patient(?:er|en|erna)" +
    "|sjukdom(?:ar|en|arna)?|symtom(?:et|en)?|symptom(?:et|en)?|diagnos(?:er|en)?" +
    "|behandling(?:ar|en|arna)?(?!\\s+av\\s+(?:person)?(?:uppgifter|data|ärenden|ansökningar))" +
    "|terapi(?:er|n)?|läkemedel|läkemedlet|dos(?:en|er|ering(?:en)?)" +
    "|biverkning(?:ar|arna|en)?|kosttillskott(?:et)?|tillskott(?:et)?|vitamin(?:er|et|erna)?" +
    "|näringsämne(?:n|t|na)?|näringsvärde(?:t|n)?|kost(?:en)?|kostråd" +
    "|antioxidant(?:er|en)?|inflammation(?:en)?|immunförsvar(?:et)?|toxicitet" +
    // Swedish COMPOUNDS the two-word English forms, so "cancer treatment" and
    // "cancerbehandling" have to be the same breadth (invariant 6): the suffix
    // wildcard is what makes cancerbehandling / cancerforskning / cancerceller
    // match, and every cancer-prefixed compound is biomedical anyway.
    "|cancer" + LETTER + "|tumör(?:er|en)?|diabetes|fetma|kolesterol|blodtryck(?:et)?" +
    // "hjärt- och kärlsjukdomar" is THE Swedish term for cardiovascular
    // disease, and the hyphen-plus-conjunction is how it is always written.
    // Nothing matched it before: `sjukdom` cannot start inside `kärlsjukdomar`
    // (the B boundary sees the `l`), and the hjärt- collocations below expect a
    // suffix immediately after `hjärt`. `kärlsjukdom` is unambiguous on its own,
    // so it belongs here rather than in the collocation tier.
    "|(?:hjärt[-–\\s]*(?:och\\s+)?)?kärlsjukdom" + LETTER +
    "|dna|rna|genom(?:e|es|ic|ics|et)|genes?|genetic(?:s|ally)?|alleles?|snps?|haplogroups?" +
    "|haplotypes?|mitochondrial|mitogenomes?|chromosom(?:e|es|al)|sequencing" +
    "|proteins?|proteom(?:e|ics)|enzyme|antibod(?:y|ies)|microbiom(?:e|es)" +
    "|pathogens?|bacteri(?:a|um|al)|species|taxon|taxa|phylogen(?:y|etic|omics)" +
    "|fossils?|isotopes?|radiocarbon|osteolog" + LETTER + "|dental calculus|sediment(?:ary)? dna" +
    "|population genetics|admixture|introgression|de[-\\s]?extinction|extinct(?:ion)?" +
    "|gener|genen|arvsmassa(?:n)?|arvsanlag|genetisk[at]?|genetiken|kromosom(?:er|en)?" +
    "|sekvenser(?:ing|ad)|protein(?:er|et)?|mikrobiom(?:et)?|patogen(?:er)?|bakteri(?:e|er|en)" +
    "|art(?:er|en|erna)|fylogen" + LETTER + "|fossil(?:a|en|er)?|isotop(?:er|en)?" +
    "|kol-?14|kol 14|radiokol|inavel|inkorsning|befolkningsgenetik|utd\u00f6d(?:a|e|d)?" +
    "|utd\u00f6ende|\u00e5terskapa" + LETTER + ")" +
    E,
  "iu",
);

/** Subject matter so specific to this literature that it fires on its own. A
 * question containing any of these is asking about published life science
 * whether or not it says the word "study". Swedish forms carry the same
 * breadth: forn-DNA / fornDNA / forntida DNA are all in live use. */
const LIFE_SCIENCE_STRONG =
  /(?<![\p{L}\p{N}_])(?:ancient dna|adna|sedadna|palaeogenom[\p{L}\p{N}]*|paleogenom[\p{L}\p{N}]*|archaeogenetic[\p{L}\p{N}]*|palaeoproteom[\p{L}\p{N}]*|paleoproteom[\p{L}\p{N}]*|palaeogenetic[\p{L}\p{N}]*|paleogenetic[\p{L}\p{N}]*|aurignacian|pleistocene|holocene|neanderthal[\p{L}\p{N}]*|denisovan[\p{L}\p{N}]*|mammoth[\p{L}\p{N}]*|megafauna[\p{L}\p{N}]*|mitogenome[\p{L}\p{N}]*|metagenom[\p{L}\p{N}]*|deamination|radiocarbon dat[\p{L}\p{N}]*|aadr|poseidon package|genome[-\s]wide|whole[-\s]genome)|(?:forn[-\s]?dna|forntida dna|urgammalt dna|arkeogenetik[\p{L}\p{N}]*|paleogenetik[\p{L}\p{N}]*|paleogenomik[\p{L}\p{N}]*|paleoproteomik[\p{L}\p{N}]*|mitogenom[\p{L}\p{N}]*|metagenom[\p{L}\p{N}]*|neandertal[\p{L}\p{N}]*|denisova[\p{L}\p{N}]*|mammut[\p{L}\p{N}]*|megafauna[\p{L}\p{N}]*|pleistocen[\p{L}\p{N}]*|holocen[\p{L}\p{N}]*|kolfjortondatering|helgenom[\p{L}]*)(?![\p{L}\p{N}_])/iu;

/** The collocations that make an AMBIGUOUS word unmistakably biomedical — the
 * rescue tier for everything LIFE_SCIENCE_WORD deliberately dropped, so
 * narrowing that list costs no genuine life-science routing.
 *
 * "health benefits" is the pair this exists for. The reported miss it must keep
 * serving ("Spirulina proven health benefits", feedback #54) and the reported
 * false positive it must not ("never an inference of ethnicity, health,
 * religion …", feedback #61) differ only in what sits next to the word.
 *
 * The Swedish arms here are the COMPOUNDS — hjärtsjukdom, hjärnskada,
 * muskelmassa, virusinfektion — plus the handful of fixed two-word forms
 * ("psykisk hälsa", "patient med"). The separated forms Swedish also uses need
 * a different disambiguator and live in LIFE_SCIENCE_SV_SEPARATED below; both
 * tiers together are what makes this half match the English one (invariant 6). */
const LIFE_SCIENCE_PHRASE = new RegExp(
  B +
    "(?:health[-\\s](?:benefits?|effects?|risks?|outcomes?|impacts?|implications?|claims?" +
    "|conditions?|problems?|issues?|markers?|status|data|span)" +
    "|(?:mental|public|physical|gut|metabolic|cardiovascular|bone|oral|reproductive" +
    "|cognitive|maternal|infant|child|global|human) health" +
    "|healthy (?:diet|eating|ageing|aging|weight|gut|fats?|lifestyle|volunteers?|controls?" +
    "|adults?|subjects?|participants?)" +
    "|heart (?:disease|health|attacks?|failure|rates?|rhythm|muscle|conditions?)" +
    "|brain (?:health|function|activity|imaging|damage|cells?|development|tissue|scans?" +
    "|tumou?rs?|injur(?:y|ies)|chemistry)" +
    "|immune (?:system|response|cells?|function|status)|immunity to (?:infection|disease)" +
    "|(?:dna|rna|gene|genome|genomic|protein|amino[-\\s]acid|reference|target) sequences?" +
    "|(?:genome|de novo|transcriptome|metagenome) assembl(?:y|ies)" +
    "|patient (?:with|outcomes?|care|safety|data|population|group|cohort|records?|reported)" +
    "|muscle (?:mass|growth|strength|tissue|soreness|protein|fib(?:er|re)s?|damage|recovery)" +
    "|vitamins? and minerals|trace minerals" +
    "|mineral (?:supplements?|deficienc" + LETTER + "|absorption)" +
    "|(?:influenza|corona|herpes|papilloma|rota|noro|zika|ebola|hepatitis|respiratory|rna|dna)" +
    "[-\\s]?virus(?:es)?|virus(?:es)? (?:infections?|transmission|variants?|strains?)" +
    "|viral (?:infections?|load|replication)" +
    "|(?:psykisk|fysisk|allmän|god|dålig|mental) hälsa" +
    "|hälsosam[mt]? (?:kost|livsstil|mat|åldrande|vikt)|hälsosamma (?:vanor|fetter|kostvanor)" +
    "|hjärt[-\\s]?(?:sjukdom|infarkt|hälsa|kärl|frekvens|muskel|svikt|klapp)" + LETTER +
    "|hjärn(?:skad|cell|funktion|hälsa|tumör|blödning|aktivitet|utveckling)" + LETTER +
    "|hjärnans (?:funktion|utveckling|kemi)" +
    "|lever(?:sjukdom|funktion|skada|fett|cirros|inflammation)" + LETTER + "|leverns" +
    "|muskel(?:massa|styrka|tillväxt|cell|fibr|värk|protein|skada|uppbyggnad)" + LETTER +
    "|dna[-\\s]?sekvenser|gensekvenser" +
    "|patient(?:en)? med|virus(?:infektion|stam|variant|sjukdom)" + LETTER +
    "|mineral(?:er|erna)? och vitaminer|vitaminer och mineral(?:er|erna)?)" +
    E,
  "iu",
);

/** The SEPARATED Swedish forms of the same ambiguous words — the half of
 * Swedish usage the compound assumption missed.
 *
 * English disambiguates an ambiguous word with the noun after it ("heart
 * disease", "brain function", "muscle mass"). The compound tier above assumed
 * Swedish always answers that with one word — hjärtsjukdom, hjärnfunktion,
 * muskelmassa — and it does, when the concept HAS a compound. It does not when
 * the ambiguous word is the topic and the rest of the phrase is the context:
 * "hälsa och skiftarbete", "hjärtat och träning", "hjärnan under sömn",
 * "muskler hos äldre", "virus i skolor", "dos av melatonin", "sekvenser i
 * forntida ben". Every one of those has an English counterpart that fires, and
 * every one was silent — seven matched pairs, which is the invariant-6 failure
 * this tier closes.
 *
 * The disambiguator here is therefore the FRAME rather than a following noun:
 * the linking word that makes the ambiguous term the subject of a question, or
 * — where the figurative sense has a frame of its own — the absence of that
 * frame. Each arm names the non-biomedical sense it has to exclude, because
 * that sense is the only reason the word is not simply in LIFE_SCIENCE_WORD:
 *
 *   hälsa      the verb "to greet" ("hälsa på"), and the privacy prohibition's
 *              comma list ("etnicitet, hälsa, religion"), where the word stands
 *              between commas and never in a linking frame
 *   hjärta     "i hjärtat av staden", "hjärtat i staden"
 *   hjärna     "hjärnan bakom affären" — the mastermind, and the only common
 *              figurative frame, so this arm excludes it rather than listing
 *              every literal one
 *   muskler    "ekonomiska/finansiella muskler"
 *   virus      the computer sense
 *   dos        "en dos av humor"
 *   sekvenser  "en sekvens av händelser", film sequences
 *
 * The arms stop at the linking word so the shared E boundary still applies —
 * an alternative ending in `\s` can never satisfy a non-word lookahead. */
const LIFE_SCIENCE_SV_SEPARATED = new RegExp(
  B +
    "(?:hälsa(?:n)?\\s+(?:och|hos|bland|i|under|vid|efter|över)" +
    "|och\\s+hälsa(?:n)?(?!\\s+på)" +
    "|(?<!i\\s)hjärta(?:t|ts)?\\s+(?:och|hos|efter|under|vid|samt)" +
    "|och\\s+hjärtat" +
    "|hjärn(?:a|an|or|orna)(?!\\s+bakom)" +
    "|(?<!(?:ekonomisk|finansiell|politisk|militär|kulturell)[at]?\\s)muskler(?:na)?" +
    "|virus(?:et|en)?\\s+(?:i|hos|bland|på|från)" +
    "(?!\\s+(?:dator|datorn|datorer|system|systemet|nätverket|mobilen|koden|filen|servern))" +
    "|dos(?:en|erna)?\\s+(?:av|med)(?!\\s+(?:humor|verklighet|realism|ironi|självdistans))" +
    "|sekvenser(?:na)?\\s+(?:av|i|från|ur|hos)\\s+(?:dna|rna|gener|generna|arvsmassan" +
    "|forntida|gammalt|gamla|fossila|mänskliga|bakteriella|virala|prover|proverna" +
    "|ben|benen|tänder|skelett|vävnad(?:en)?))" +
    E,
  "iu",
);

/**
 * Is this message ABOUT life science — the core vocabulary, an ambiguous word
 * inside a collocation only biomedicine writes, or the Swedish separated form
 * of one of those collocations?
 * @param {string} s
 * @returns {boolean}
 */
function lifeScienceSubject(s) {
  return (
    LIFE_SCIENCE_WORD.test(s) ||
    LIFE_SCIENCE_PHRASE.test(s) ||
    LIFE_SCIENCE_SV_SEPARATED.test(s)
  );
}

/** Naming the archive itself — Europe PMC, PubMed, PMC, bioRxiv, medRxiv. */
const NAMED =
  /\b(europe\s*pmc|europepmc|pubmed|pub\s?med|pmc\b|medline|bio\s?r[xX]iv|biorxiv|med\s?r[xX]iv|medrxiv)\b/i;

/** Swedish and English ways of saying "look in the literature", used only for
 * the LEAD tier — asking for a source by name is a different act from asking a
 * question that source happens to serve (the rule in search-sources.js). */
const NAMED_PHRASE =
  /(?<![\p{L}\p{N}_])(?:the (?:scientific |research |published )?literature|peer[-\s]?reviewed (?:papers|articles|sources|literature)|published (?:papers|studies|articles))|(?:den vetenskapliga litteraturen|forskningslitteraturen|vetenskapliga (?:artiklar|studier|publikationer)|publicerade (?:studier|artiklar))(?![\p{L}\p{N}_])/iu;

/**
 * Does this message want the life-science literature at all? Conservative by
 * construction, and asked in a fixed order because the two halves are not worth
 * the same:
 *
 * 1. an unmistakable subject (a named archive, LIFE_SCIENCE_STRONG) needs
 *    nothing else;
 * 2. NO life-science subject anywhere → no, whatever else the message says;
 * 3. a research word that SURVIVES the imperative neutralisation names the
 *    published record ("the latest research on statins", "vad säger studierna")
 *    → yes;
 * 4. otherwise the only research framing was the imperative verb itself. That
 *    verb is worth nothing on its own — but the subject already established in
 *    step 2 is worth something, so "Research this drug's side effects" and
 *    "Undersök den här sjukdomen" are served while "Research this founder" and
 *    "Undersök den här grundaren" fall out at step 2, which is what feedback
 *    #61 asked for.
 *
 * Step 4 is deliberately restricted to a message that WAS framed as a task: a
 * bare subject with no framing at all ("what species of tree is this") stays
 * the combination gate it has always been.
 * @param {string} text the latest user message
 * @returns {boolean}
 */
export function europepmcIntent(text) {
  const s = String(text || "");
  if (!s) return false;
  if (NAMED.test(s)) return true;
  if (LIFE_SCIENCE_STRONG.test(s)) return true;
  const asked = s.replace(IMPERATIVE_TASK, " ");
  const framedAsTask = asked !== s;
  if (!lifeScienceSubject(asked)) return false;
  if (RESEARCH_WORD.test(asked)) return true;
  return framedAsTask;
}

/**
 * Does this message name the literature as THE place to look? Strictly
 * narrower than `europepmcIntent` — only an explicit archive name or an
 * explicit "in the literature" phrasing leads, because leading stands the
 * whole web leg down.
 * @param {string} text
 * @returns {boolean}
 */
export function europepmcLeadIntent(text) {
  const s = String(text || "");
  if (!s) return false;
  return NAMED.test(s) || NAMED_PHRASE.test(s);
}

/** The planner-vocabulary sentence spliced into the triage and gap prompts.
 *
 * The English-only instruction is EVIDENCE, not caution: probed live
 * (2026-07-29), "mammutens arvsmassa" returns 0 results down the whole ladder
 * while its English equivalent returns hundreds. Europe PMC indexes titles and
 * abstracts as published, and this literature publishes in English — so a
 * Swedish question must still be SEARCHED in English. The intent gates above
 * are bilingual (invariant 6) precisely so a Swedish question reaches this
 * source; translating the query is what makes reaching it worth anything. */
export const europepmcPromptNote =
  " Europe PMC (PubMed/PMC/bioRxiv) is searched for life-science questions, so phrase at least one query as the biomedical concepts themselves (\"woolly mammoth mitochondrial genome\", not \"mammoth facts\") and ALWAYS in English even when the conversation is in Swedish — the indexed titles and abstracts are English.";

// ---- query building --------------------------------------------------------

/** Words carrying no retrieval value in a phrase-AND query. EN + SV. */
const STOP = new Set([
  "the", "a", "an", "of", "in", "on", "for", "and", "or", "to", "is", "are", "was", "were",
  "what", "which", "who", "how", "why", "when", "where", "do", "does", "did", "can", "could",
  "about", "with", "from", "into", "over", "any", "some", "that", "this", "these", "those",
  "please", "tell", "me", "us", "show", "give", "find", "search", "look", "know", "latest",
  "recent", "new", "study", "studies", "paper", "papers", "research", "literature", "evidence",
  // Framing verbs. "what do the studies SAY about X" is asking for X; carrying
  // `say` into a phrase-AND query makes the corpus match on the word itself.
  "say", "says", "said", "think", "thinks", "suggest", "suggests", "mean", "means", "shows",
  "och", "eller", "en", "ett", "den", "det", "de", "som", "är", "var", "vad", "vilka", "vilken",
  "vilket", "hur", "varför", "när", "var", "om", "på", "för", "till", "från", "med", "av", "i",
  "kan", "ska", "vill", "visa", "hitta", "söka", "berätta", "senaste", "nya", "studie", "studier",
  "artikel", "artiklar", "forskning", "litteratur",
  // The Swedish definite and plural forms of the same framing — the forms
  // Swedish actually uses, and the parity invariant's whole point (invariant 6).
  "studien", "studierna", "artikeln", "artiklarna", "forskningen", "litteraturen",
  "publikation", "publikationer", "säger", "sa", "sade", "säga", "tycker", "tror", "menar",
  "vet", "tyder", "finns",
]);

/**
 * The retrieval terms in a query, lowercased, de-duplicated, order preserved.
 * Hyphens and apostrophes are kept inside a token (Kap-København, 5'-end);
 * everything else splits.
 * @param {string} query
 * @returns {string[]}
 */
export function europepmcTerms(query) {
  const out = [];
  const seen = new Set();
  for (const raw of String(query || "").toLowerCase().split(/[^a-z0-9åäöéèüñ'’\-.]+/i)) {
    const t = raw.replace(/^[-.']+|[-.']+$/g, "");
    if (t.length < 2 || STOP.has(t)) continue;
    // A bare year is a date filter, not a concept; it makes a phrase-AND query
    // match only papers that print that year in their text.
    if (/^(1[5-9]|20)\d{2}$/.test(t)) continue;
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

/** Cross-wave dedup key: the term set, so two phrasings of one angle count once.
 * @param {string} query
 * @returns {string} */
export function europepmcTermKey(query) {
  return europepmcTerms(query).slice(0, 8).join(" ");
}

/**
 * The multi-word CONCEPTS in a query, longest first — the phrases worth
 * quoting. Only pairs that read as a term of art are joined ("ancient dna",
 * "woolly mammoth"); everything else stays a single token, because AND is the
 * default operator and an over-eager phrase is a zero-result query.
 * @param {string} query
 * @returns {string[]}
 */
export function europepmcConcepts(query) {
  const s = String(query || "").toLowerCase();
  /** @type {string[]} */
  const concepts = [];
  for (const re of CONCEPT_PATTERNS) {
    const m = s.match(re);
    if (m) concepts.push(m[0].replace(/\s+/g, " ").trim());
  }
  const terms = europepmcTerms(query).filter((t) => !concepts.some((c) => c.includes(t)));
  return [...new Set([...concepts, ...terms])];
}

/** The terms of art worth quoting as a phrase. Kept explicit rather than
 * inferred: a wrong guess here costs the whole query (AND semantics). */
const CONCEPT_PATTERNS = [
  /\bancient (?:dna|proteins?|genomes?)\b/,
  /\bsedimentary ancient dna\b/,
  /\bwhole[-\s]genome (?:sequencing|shotgun)\b/,
  /\bgenome[-\s]wide\b/,
  /\bpopulation genetics\b/,
  /\bnatural selection\b/,
  /\bwoolly (?:mammoth|rhino\w*)\b/,
  /\bmitochondrial (?:dna|genomes?)\b/,
  /\bdental calculus\b/,
  /\bradiocarbon dat\w*\b/,
  /\bruns? of homozygosity\b/,
  /\beffective population size\b/,
  /\bde[-\s]?extinction\b/,
];

/**
 * The query ladder for one search: rungs tried in order until one returns hits.
 * Climbs by DROPPING constraints, because AND is the default operator here —
 * the reverse of arXiv's ladder, and the reason this cannot be shared with it.
 * @param {string} query
 * @returns {Array<{ key: string, q: string, note: string }>}
 */
export function europepmcLadder(query) {
  const concepts = europepmcConcepts(query).slice(0, 4);
  if (!concepts.length) return [];
  const quoted = concepts.map((c) => `"${c.replace(/"/g, "")}"`);
  const rungs = [];

  // Rung 1 — abstract-restricted, only when there is enough left to survive an
  // 88% cut. Two concepts in the abstract is a strong match; one is a topic
  // list, not a query.
  if (quoted.length >= 2) {
    rungs.push({
      key: `abs:${concepts.slice(0, 3).join("+")}`,
      q: quoted.slice(0, 3).map((c) => `ABSTRACT:${c}`).join(" AND "),
      note: "abstract",
    });
  }
  // Rung 2 — the balanced default: quoted phrases ANDed over the whole record.
  rungs.push({
    key: `all:${concepts.join("+")}`,
    q: quoted.join(" AND "),
    note: "phrase",
  });
  // Rung 3 — drop the narrowest concept, then unquote. Both are recall moves
  // for a query that was simply too specific to match anything.
  if (quoted.length > 2) {
    rungs.push({
      key: `all:${concepts.slice(0, 2).join("+")}`,
      q: quoted.slice(0, 2).join(" AND "),
      note: "phrase-2",
    });
  }
  rungs.push({
    key: `bare:${concepts.slice(0, 3).join("+")}`,
    q: concepts.slice(0, 3).join(" "),
    note: "bare",
  });
  return rungs;
}

// ---- the API call ----------------------------------------------------------

/**
 * One Europe PMC request. Returns [] on any failure — a bad status, a timeout,
 * malformed JSON — so a caller never has to think about it (invariant 2).
 * @param {string} q the assembled query
 * @param {string} sort the sort clause
 * @param {import('./types.js').Logger} [log]
 * @returns {Promise<any[]>}
 */
async function fetchPage(q, sort, log, pageSize = PAGE_SIZE) {
  const url =
    `${API}?query=${encodeURIComponent(q)}` +
    `&format=json&resultType=core&pageSize=${pageSize}` +
    (sort ? `&sort=${encodeURIComponent(sort)}` : "");
  try {
    const res = await fetch(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      log?.warn?.("europepmc.http", { status: res.status });
      return [];
    }
    const body = /** @type {any} */ (await res.json());
    const list = body?.resultList?.result;
    return Array.isArray(list) ? list : [];
  } catch (/** @type {any} */ err) {
    log?.warn?.("europepmc.fetch_failed", { error: err?.message || String(err) });
    return [];
  }
}

/** A record's canonical URL. The DOI is preferred — it is what a reader cites
 * and what resolves at the publisher — with the Europe PMC article page as the
 * fallback for the (common, for preprints) DOI-less record.
 * @param {any} r */
function itemUrl(r) {
  const doi = String(r?.doi || "").trim();
  if (doi) return `https://doi.org/${doi}`;
  const src = String(r?.source || "").trim();
  const id = String(r?.id || "").trim();
  if (src && id) return `https://europepmc.org/article/${src}/${id}`;
  return "";
}

/** The one-line provenance a reader needs to judge a hit before opening it.
 * @param {any} r */
function provenance(r) {
  const journal = r?.journalInfo?.journal?.title || (r?.source === "PPR" ? "Preprint" : "");
  const bits = [];
  if (journal) bits.push(journal);
  if (r?.pubYear) bits.push(String(r.pubYear));
  if (r?.source === "PPR") bits.push("preprint, not peer-reviewed");
  if (r?.isOpenAccess === "Y") bits.push("open access");
  const cited = Number(r?.citedByCount);
  if (Number.isFinite(cited) && cited > 0) bits.push(`cited ${cited}×`);
  return bits.join(" · ");
}

/**
 * One record → the item shape sources.js registers, identical to Exa's.
 * @param {any} r
 * @returns {{ url: string, title: string, highlights: string[] } | null}
 */
export function toItem(r) {
  const url = itemUrl(r);
  const title = String(r?.title || "").replace(/\s+/g, " ").trim();
  if (!url || !title) return null;
  const highlights = [];
  const prov = provenance(r);
  if (prov) highlights.push(prov);
  const authors = String(r?.authorString || "").trim();
  if (authors) highlights.push(authors.length > 180 ? `${authors.slice(0, 177)}…` : authors);
  const abstract = String(r?.abstractText || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  if (abstract) highlights.push(abstract.length > 900 ? `${abstract.slice(0, 897)}…` : abstract);
  return { url, title: title.replace(/\.$/, ""), highlights };
}

/**
 * The registry's `search`. Two fetches per call — the most-cited slice (the
 * literature that settled the question) and the newest slice (what has changed
 * since) — merged and de-duplicated, which is the same popular+fresh shape the
 * HF leg uses and for the same reason: one sort alone is either stale or
 * untested.
 *
 * @param {import('./types.js').Env} env only for the PUBMED_INDEX binding —
 *   the live Europe PMC API itself needs no key
 * @param {import('./types.js').Logger} log
 * @param {string} query
 * @param {{ skipKeys?: Set<string> }} [opts]
 * @returns {Promise<{ items: Array<{url: string, title: string, highlights: string[]}>, durationMs: number, usedKeys: string[], spend?: import('./dense-rag.js').RetrievalSpend }>}
 */
export async function europepmcSearch(env, log, query, { skipKeys } = {}) {
  const startedAt = Date.now();
  // What the hosted tier cost this call, reported back to the orchestrator so
  // the request bills it (search-sources.js SearchSourceResult `spend`).
  // Returned on BOTH exits: a dense lookup that found nothing above the floor
  // still paid for its embedding and its cross-encoder before falling through
  // to Europe PMC below.
  const spend = newRetrievalSpend();
  // Tier 1: the hosted PubMed index, when bound. It gets the PROSE query —
  // dense retrieval wants the natural question, and the term extraction below
  // is a keyword-AND concern that would throw away signal an embedder uses. A
  // null or empty return falls through to the live API, so a deployment
  // without the binding behaves exactly as it did before this tier existed.
  if (pubmedRagAvailable(env)) {
    const dense = await pubmedRagSearch(env, log, query, { limit: MAX_ITEMS, spend });
    if (dense && dense.length) {
      const durationMs = Date.now() - startedAt;
      log?.info?.("europepmc.search", {
        query: String(query || "").slice(0, 120),
        tier: "dense",
        results: dense.length,
        duration_ms: durationMs,
      });
      return { items: /** @type {any} */ (dense), durationMs, usedKeys: [], spend };
    }
  }
  const rungs = europepmcLadder(query).filter((r) => !skipKeys?.has(r.key));
  const usedKeys = [];

  // Keyed, so a record the next rung repeats costs nothing and the two sorts
  // cannot double-count the same paper.
  /** @type {Map<string, any>} */
  const records = new Map();
  let usedNote = "";
  for (const rung of rungs) {
    usedKeys.push(rung.key);
    const [cited, recent] = await Promise.all([
      fetchPage(rung.q, "CITED desc", log),
      fetchPage(rung.q, "P_PDATE_D desc", log),
    ]);
    // Interleave rather than concatenate: taking the cited slice first would
    // spend the whole item cap on it whenever it is full.
    for (let i = 0; i < Math.max(cited.length, recent.length); i++) {
      for (const r of [cited[i], recent[i]]) {
        if (!r) continue;
        const key = String(r.doi || `${r.source}:${r.id}`);
        if (!records.has(key)) records.set(key, r);
      }
    }
    if (cited.length || recent.length) usedNote = rung.note;
    // A rung that matched ONE paper has not answered the wave — probed live,
    // "sedimentary ancient DNA Beringia" matches a single abstract while the
    // unrestricted rung below it matches a literature. So the ladder stops on
    // ENOUGH results, not on any result, and keeps what the thin rung found.
    if (records.size >= MIN_RUNG_HITS) break;
  }

  const items = [...records.values()].map(toItem).filter(Boolean).slice(0, MAX_ITEMS);
  const durationMs = Date.now() - startedAt;
  log?.info?.("europepmc.search", {
    query: String(query || "").slice(0, 120),
    rung: usedNote || "none",
    rungs_tried: usedKeys.length,
    results: items.length,
    duration_ms: durationMs,
  });
  return { items: /** @type {any} */ (items), durationMs, usedKeys, spend };
}

/**
 * RAW records for one author query, both orderings — the MCP literature
 * family's author leg (src/literature-authors.js explains why the hosted index
 * cannot serve this and the live API must).
 *
 * Unlike europepmcSearch this does NOT consult the hosted dense tier: an
 * authorship question is exactly the question dense retrieval answers wrongly,
 * so there is nothing to fall back FROM. It returns the API's own core records
 * rather than the pipeline's item shape, because the caller wants the full
 * author list and the citation count that `toItem` flattens away.
 *
 * Fails soft to empty slices like every other leg here (invariant 2).
 *
 * @param {import('./types.js').Logger} log
 * @param {string} query an assembled author query — see europepmcAuthorQuery
 * @param {number} [pageSize]
 * @returns {Promise<{ cited: any[], recent: any[] }>}
 */
export async function europepmcAuthorFetch(log, query, pageSize = 25) {
  const q = String(query || "").trim();
  if (!q) return { cited: [], recent: [] };
  const [cited, recent] = await Promise.all([
    fetchPage(q, "CITED desc", log, pageSize),
    fetchPage(q, "P_PDATE_D desc", log, pageSize),
  ]);
  log?.info?.("europepmc.author", { results: cited.length + recent.length });
  return { cited, recent };
}

/**
 * Which of the wave's planned angles this source searches. The planner writes
 * for the open web, where a narrow angle is a virtue; here AND semantics make a
 * narrow angle a zero-result query, so prefer the angle carrying the most
 * DOMAIN vocabulary and the fewest incidental terms.
 * @param {string[]} batch
 * @param {string} topic the latest user message
 * @returns {string}
 */
export function europepmcPickQuery(batch, topic) {
  let best = batch[0];
  let bestScore = -Infinity;
  for (const q of batch) {
    const terms = europepmcTerms(q);
    if (!terms.length) continue;
    let score = 0;
    if (LIFE_SCIENCE_STRONG.test(q)) score += 4;
    if (lifeScienceSubject(q)) score += 2;
    // Every concept costs recall under AND, so a 6-term angle is worse than a
    // 3-term one even though it looks more precise.
    score -= Math.max(0, terms.length - 4);
    // An angle sharing vocabulary with what was actually asked beats one the
    // planner drifted into (the same correction arxivPickQuery makes).
    const asked = new Set(europepmcTerms(topic || ""));
    for (const t of terms) if (asked.has(t)) score += 1;
    if (score > bestScore) {
      best = q;
      bestScore = score;
    }
  }
  return best;
}

/**
 * Diversity key for doi.org URLs. The registrant prefix IS the publisher
 * (10.1038 Nature Portfolio, 10.1016 Elsevier, 10.1101 Cold Spring Harbor /
 * bioRxiv), so keying on it caps "ten hits, all Nature" while leaving a genuine
 * spread of publishers intact. Without this every DOI collapses to one origin
 * and the per-origin cap would starve the whole leg.
 * @param {string} url
 * @returns {string}
 */
export function europepmcDiversityKey(url) {
  try {
    const segs = new URL(url).pathname.split("/").filter(Boolean);
    const prefix = segs[0] || "";
    return /^10\.\d{4,9}$/.test(prefix) ? `doi.org/${prefix}` : "doi.org";
  } catch {
    return "doi.org";
  }
}
