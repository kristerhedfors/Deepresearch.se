// @ts-check
// PERSON RESEARCH — the shared pure core: a bilingual intent gate and one
// static methodology block. The Worker façade is src/person-research.js.
//
// ---- what this is, and what it deliberately is not --------------------------
//
// It is METHOD, not data. There is no lookup here, no corpus, no model call and
// no outbound request of any kind — the whole module is a regex pair and a
// constant. When a message asks for research on a NAMED PERSON's public
// professional record, the block is appended to the conversation before triage
// runs, so the planner, the search waves and synthesis all see the same
// protocol: how to resolve identity before collecting, which sources outrank
// which, what raises a claim to "verified", what is off-limits, and how the
// writeup is structured.
//
// ---- why it exists ----------------------------------------------------------
//
// Live feedback #60 (chat_logs #1305). A user attached a LinkedIn screenshot of
// a founder and asked "Write a report about what you can find on this founder",
// and got back a restatement of the screenshot. Two things were missing. The
// first was the picture's text, which is src/image-read.js's job. The second is
// this one: even with the name in hand, a general-purpose research pipeline has
// no idea that a person question is a different KIND of question — that a
// company register outranks a press profile, that five outlets running one press
// release are one source, that a same-named stranger silently merges into the
// biography, and that most of what could be collected about a private individual
// must not be.
//
// ---- why a constant block rather than a phase -------------------------------
//
// Guidance costs one paste and no latency. A phase that "researches how to
// research" would spend a model call and a slice of the budget on advice that
// does not change between requests, and would be one more thing to fail soft
// around (invariant 2). The cost is real but bounded and paid only on person
// turns: the block is deliberately held near 700 words, and the long form —
// the nine-phase protocol, each rung's traps, the legal grounding — lives in
// docs/PERSON-RESEARCH.md where it costs nothing per turn.
//
// ---- the gate is conjunctive on purpose -------------------------------------
//
// Firing needs BOTH a research-shape phrase AND a person referent. Either half
// alone is a different question: "what can you find on this API" is a shape
// without a subject, and "the founder's talk was good" is a subject without a
// request. A false fire spends ~900 tokens on a company question and pushes
// person-shaped caveats into an answer nobody asked about, so the gate stays
// conservative and a miss simply costs a less careful report.
//
// ---- invariant 6, and the `\b` trap ----------------------------------------
//
// Every pattern below is built through `re()`, which uses lookaround boundaries
// with the `u` flag. JavaScript defines `\b` over [A-Za-z0-9_], so "å ä ö" are
// not word characters to it and `/\bvem är\b/` can NEVER match — the Swedish
// half of a gate dies silently while the English half keeps working. The
// repo-wide guard is src/swedish-boundary.test.js; the account is in the
// **palaeogenomics** skill. The Swedish alternatives also carry their
// ASCII-typed forms ("sla upp", "ta reda pa", "vem ar", "undersok"), because a
// phone keyboard without Swedish letters is the commonest way this gate is
// addressed in practice.

// ---- Unicode-safe word boundaries ------------------------------------------

const B = "(?<![\\p{L}\\p{N}_])";
const E = "(?![\\p{L}\\p{N}_])";
/** Swedish suffix wildcard. `\w*` stops dead at the first accented letter. */
const L = "[\\p{L}]*";
/** @param {string} body @param {string} [flags] */
const re = (body, flags = "iu") => new RegExp(B + "(?:" + body + ")" + E, flags);

// ---- the research shape ----------------------------------------------------

/**
 * Asking for research, background, a lookup or a written report. Not yet about
 * a person — that is the second half of the gate.
 */
const RESEARCH_SHAPE_EN = re(
  [
    "what can (?:you|u) (?:find|dig up|tell me|say)(?: out)?(?: (?:on|about|regarding))?",
    "what (?:do|would|can) (?:you|u) know about",
    "what (?:did|do) (?:you|u) find (?:on|about)",
    "look(?:ed|ing)? up",
    "look(?:ed|ing)? (?:him|her|them|this person|the person|this guy|the founder) up",
    "research(?:ed|ing)?",
    "reserach|resarch|researhc|reasearch", // observed keyboard slips
    "os[iy]nt|open[- ]source intelligence",
    // The connective is INSIDE the optional group, space and all: written as
    // "background (?:on)?" the pattern needs a trailing space that
    // "what's his background?" does not have, and the alternative is dead.
    "background(?: (?:on|about|check|research|info" + "rmation?))?",
    "backround|backgrond|bakground",
    "report (?:on|about|regarding)",
    "write (?:me |up )?(?:an?|the) (?:\\p{L}+ ){0,2}report",
    "dig(?:ging)? up",
    "due dilig" + L,
    "profile (?:of|on)",
    "find out (?:about|more about)",
    "find (?:anything|everything|whatever|info" + "rmation?) (?:about|on)",
    "investigat" + L,
    "review(?:ed|ing)?", // the parity partner of "granska"
    "map(?:ping)? out",  // …and of "kartlägga"
    "vetting|background-?check",
    "who(?:'s| is| was| are)",
    "tell me (?:about|everything about|what you know about)",
  ].join("|"),
);

/** The same shape in Swedish: definite forms, synonyms, and the ASCII-typed
 * variants a phone keyboard without å/ä/ö produces. Kept as its OWN regex, not
 * folded into the English one, because the bare pronouns "han/hon/hen" only
 * count as a person referent when the message is Swedish-shaped — see
 * personReferent. */
const RESEARCH_SHAPE_SV = re(
  [
    "vad kan du (?:hitta|gr[äa]va fram|ber[äa]tta)(?: (?:om|p[åa]|kring))?",
    "vad (?:vet|hittar) du om",
    "vad hittade du (?:om|p[åa])",
    "sl[åa]r? upp|sl[åa] upp|slog upp",
    "kolla(?:r|de)? upp",
    "efterforsk" + L,
    "unders[öo]k" + L,
    "bakgrund(?:en|s)?(?: (?:om|p[åa]|kring))?",
    "bakgrundskoll" + L + "|bakgrundsinfo" + L,
    "bakrund" + L + "|bakgund" + L,
    "rapport(?:en)?(?: (?:om|p[åa]|kring))?",
    "skriv(?:a|er)? (?:ihop |mig |en |ett )*rapport",
    "ta(?:r|g)? reda p[åa]",
    "gransk" + L,
    "gr[äa]v(?:a|er)? fram",
    "kartl[äa]gg" + L,
    "vem (?:[äa]r|var)",
  ].join("|"),
);

// ---- the person referent ---------------------------------------------------

/** Nouns that ARE people. They count behind any determiner, including "the":
 * "this founder" and "the candidate" are both somebody, while "how do founders
 * raise money" is nobody in particular. */
const EN_ROLE =
  "person|people|individual|guy|gal|dude|man|woman|lady|" +
  "founder|co-?founder|cofounder|ceo|cto|coo|cfo|exec(?:utive)?|" +
  "candidate|applicant|author|writer|journalist|researcher|scientist|academic|" +
  "investor|angel|entrepreneur|director|manager|owner|employee|hire|profile";

/** Things a person HAS. These need a possessive or a demonstrative, never a
 * bare "the": "his background" is a person, "the background of the project" is
 * not, and "a report on the subject of X" is not either — which is why
 * "subject" is absent from both lists. "profile" sits in the role list above
 * instead: "the profile" is a person in every context this gate meets. */
const EN_ATTRIBUTE = "background|bio|cv|r[ée]sum[ée]|career|work history|employment history";

/** Swedish roles in the DEFINITE form, which carries its own determiner and so
 * needs none: "grundaren", "profilen", "VD:n". */
const SV_ROLE_DEF =
  "personen|personerna|individen|" +
  "grundaren|grundarna|medgrundaren|" +
  "vd:?n|vd|verkst[äa]llande direkt[öo]r" + L + "|" +
  "kandidaten|kandidaterna|s[öo]kanden|" +
  "f[öo]rfattaren|forskaren|journalisten|investeraren|entrepren[öo]ren|" +
  "chefen|[äa]garen|anst[äa]llde|" +
  "profilen|linkedin-?profilen|cv:?t|meritf[öo]rteckning" + L + "|" +
  "killen|tjejen|mannen|kvinnan|" +
  "honom|henne|hens";

/** Swedish roles in the INDEFINITE form, which need a demonstrative or a
 * possessive to be about somebody in particular. */
const SV_ROLE_INDEF =
  "person|grundare|medgrundare|kandidat|s[öo]kande|f[öo]rfattare|forskare|" +
  "journalist|investerare|entrepren[öo]r|chef|[äa]gare|profil|kille|tjej|" +
  "man|kvinna|bakgrund";

const PERSON_REFERENT = re(
  [
    // A determiner or possessive plus a role noun (English)…
    "(?:this|that|these|those|the|his|her|their|whose|our|your)\\s+(?:" + EN_ROLE + ")s?",
    // …and a possessive or demonstrative plus an attribute.
    "(?:this|that|his|her|their|whose)\\s+(?:" + EN_ATTRIBUTE + ")",
    // The platform where a professional profile lives, in any spelling. On a
    // screenshot turn this is what the image transcription puts into the text.
    "linked-? ?in(?:-?profil" + L + ")?",
    "curriculum vitae|r[ée]sum[ée]",
    // Honorifics — a person even without a role noun.
    "mr\\.?|mrs\\.?|ms\\.?|dr\\.?|prof\\.?|herr|fru|fr[öo]ken",
    // English pronouns. Unlike their Swedish counterparts below these are safe
    // bare: "she", "him" and "her" are only ever people in English. "they" and
    // "them" are NOT — they take objects and companies — so they count only
    // behind "about", where the sentence is already about a subject.
    "he|she|him|her|hers|himself|herself",
    "about (?:him|her|them|they)",
    // Swedish: the definite forms stand alone…
    SV_ROLE_DEF,
    // …the indefinite ones need pointing at.
    "(?:den h[äa]r|det h[äa]r|denna|denne|hans|hennes|deras|hens|min|v[åa]r)\\s+(?:" +
      SV_ROLE_INDEF + ")" + L,
  ].join("|"),
);

// The bare subject pronouns, admitted ONLY in a Swedish-shaped message. They
// are unambiguous in Swedish and disastrous in English: "han" is the Han
// dynasty and Han Solo, "hen" is a bird, and either would turn "research on
// the Han dynasty" into a person dossier. The objective forms
// (honom/henne/hens) carry no such collision and sit in SV_ROLE_DEF above,
// where they need no Swedish context at all.
const SV_BARE_PRONOUN = re("hon|han|hen|hens");

/** The enrichment/step/log slug, shared with the Worker façade. */
export const PERSON_RESEARCH_ID = "person_research";

/**
 * Does the message ask for research, background or a written report?
 * @param {string} text
 * @returns {boolean}
 */
export function personResearchShape(text) {
  const s = String(text || "");
  return RESEARCH_SHAPE_EN.test(s) || RESEARCH_SHAPE_SV.test(s);
}

/**
 * Does the message point at an individual human being? Language-neutral for
 * every referent except the bare Swedish subject pronouns, which count only
 * when the message is Swedish-shaped (see SV_BARE_PRONOUN).
 * @param {string} text
 * @returns {boolean}
 */
export function personReferent(text) {
  const s = String(text || "");
  if (PERSON_REFERENT.test(s)) return true;
  return RESEARCH_SHAPE_SV.test(s) && SV_BARE_PRONOUN.test(s);
}

/**
 * The gate: research ON A PERSON. Conjunctive by design — a bare topical
 * question about a company, an API or a product has the shape but no subject
 * and must not fire.
 * @param {string} text the latest user message
 * @returns {boolean}
 */
export function personResearchIntent(text) {
  const s = String(text || "");
  if (!s) return false;
  return personResearchShape(s) && personReferent(s);
}

// ---- the block -------------------------------------------------------------

// Written to be read by a model and checkable by a human, and held near 700
// words: it rides in the context of EVERY person-research turn, so every
// sentence has to earn its tokens. The trailing "USING THIS BLOCK" paragraph is
// the house convention (public/js/aadr-core.js sampleBlock) and does real work
// here — without it, models cite the methodology as though it were a finding.
const LINES = [
  "PERSON RESEARCH METHOD — how to research a named individual's public professional record.",
  "This is method, not evidence. It contains no facts about anyone.",
  "",
  "PLAN. Resolve identity BEFORE collecting: the name plus at least one anchor — employer, city, " +
    "alma mater, a stable handle, an ORCID. Run a collision census first: search the bare name and " +
    "see how many distinct people carry it, then carry that namesake risk into the answer. Then " +
    "search per CLAIM, not per person — one angle per employer, per degree, per funding event, per " +
    "award, per patent, per publication. Search in the subject's other language too: a Swedish " +
    "founder's registry footprint and local press never surface from English queries.",
  "",
  "SOURCE LADDER, strongest first.",
  "1. Statutory registries and regulatory filings: SEC EDGAR (Form D names the officers of a raise), " +
    "Companies House (officer appointments, PSC), Bolagsverket and allabolag. OpenCorporates is a " +
    "mirror — follow it back to the registry itself.",
  "2. Intellectual property: patents via Google Patents, USPTO or Espacenet — inventor is not " +
    "assignee, an application is not a grant, and priority dates are timeline anchors. Trademarks can " +
    "date a stealth venture before any press exists.",
  "3. The scholarly and technical record: ORCID and OpenAlex for disambiguation, DOIs, and venue type " +
    "— a preprint is not a peer-reviewed paper. On GitHub, a handle is not a person without an anchor.",
  "4. Independent press and awards: separate originated reporting from rewritten press releases and " +
    "paid or contributed posts. Crunchbase and PitchBook are DISCOVERY, not evidence — their content " +
    "is frequently typed in by the subject.",
  "5. Company-controlled and self-published surfaces, plus the Wayback Machine — the highest-leverage " +
    "tool here, because an archived team page catches title drift, quiet departures and rewritten " +
    "founding stories.",
  "6. The profile itself.",
  "LADDER RULE: only rungs 1-3, which are independent of the subject, can raise a claim to VERIFIED. " +
    "Rungs 4-6 establish what was said, not what is true.",
  "",
  "VERIFY. Two independent sources for any contested or high-consequence claim, and independence is " +
    "about ORIGIN, not URL count: five outlets running one press release are one source, and LinkedIn " +
    "plus Crunchbase is usually one source. Hunt three failure modes — circular reporting, " +
    "self-report laundering, and the silent identity merge that fuses two same-named people into one " +
    "biography. Label every claim's provenance: self-reported, company-controlled, third-party, or " +
    "registry. Cite with TWO dates, the document's and the retrieval's, plus the record identifier " +
    "(accession number, company number, publication number, DOI) — URLs rot. Absence of a source is " +
    "absence of a source, never evidence of anything: most legitimate professional activity leaves no " +
    "public trace, so say WHERE you looked when you found nothing.",
  "",
  "GUARDRAILS — public professional information only. The governing test: report only facts of the " +
    "kind that would appear in a professional profile the subject might publish themselves. Never " +
    "report a home address, personal phone, personal email or any private contact detail, including " +
    "one incidentally present in a filing; never a national identity number (personnummer, SSN); " +
    "never family, relationships or children; never an inference of ethnicity, health, religion, " +
    "politics, sexuality or any other special category — including by ASSEMBLING facts whose " +
    "combination would disclose one; never an exact date of birth; never criminal, litigation or " +
    "credit history unless the purpose specifically requires it; never non-professional online " +
    "activity or the de-anonymisation of a pseudonymous account; no face matching or reverse image " +
    "search on a likeness; no attempt to reach non-public systems or paywalled records; no contact " +
    "with the subject or their colleagues under any pretext. Two positive obligations: the subject " +
    "may be a PRIVATE individual — a founder is not automatically a public figure, so scrutiny scales " +
    "to their actual public role — and adverse or ambiguous findings need the subject's comment " +
    "before anyone acts on them. Report roles, dates and documents; never infer character, competence " +
    "or motive, and never read a gap in the record as a red flag.",
  "",
  "WRITE IT UP. The core artefact is a claim/evidence/confidence table: claim, who asserts it, " +
    "status, provenance class, key evidence with dates. Statuses: verified, partially verified, " +
    "self-reported only, unverifiable, contested. Keep likelihood separate from confidence — never " +
    "put a confidence level and a probability in the same sentence. Then a timeline marking each row " +
    "documented or self-reported; an entity map reconciling registry-side roles against self-reported " +
    "ones; an open-questions list saying what evidence would resolve each; and a numbered source " +
    "list. Close with the limitations: namesake risk, what was searched without result, and what was " +
    "out of scope.",
  "",
  "USING THIS BLOCK: this is METHOD, not evidence. It contains no facts about anyone, so never cite " +
    "it as a source, never quote it back at the user, and never describe anything in it as something " +
    "that was found. Follow it silently and let the report show the difference.",
];

/**
 * The labeled context block. A constant — no query, no state, no arguments —
 * which is what makes it free to build and impossible to fail.
 * @returns {string}
 */
export function personResearchBlock() {
  return LINES.join("\n");
}

/** Words in the block, for the token-cost assertion its test carries.
 * @returns {number} */
export function personResearchBlockWords() {
  return personResearchBlock().split(/\s+/u).filter(Boolean).length;
}
