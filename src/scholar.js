// @ts-check
// SCHOLAR — the peer-reviewed literature search source, and the search half of
// the Deep Science agent.
//
// The agent it serves has one promise: every source in the answer is a
// peer-reviewed publication, and nothing else is consulted — no web search, no
// preprint server, no blog, no press release. This module is where that promise
// is kept or broken, so most of what follows is about the two hard parts:
// reaching Google Scholar's index at all, and deciding what "peer-reviewed"
// means in a way a machine can check.
//
// ============================================================================
// PART 1 — how you integrate with Google Scholar (established 2026-07-31, curl)
// ============================================================================
//
// Google Scholar has NO API. It has never had one, there is no key to buy from
// Google, and it is not part of Google Cloud — the Maps and OAuth credentials
// this deployment already holds buy exactly nothing here. What it has is a
// robots.txt, and reading it is what decides the design:
//
//     User-agent: *
//     Disallow: /scholar            ← the SEARCH results
//     Disallow: /citations?
//     Allow:    /citations?user=            ← author profiles
//     Allow:    /citations?view_op=top_venues   ← publication metrics
//     Allow:    /citations?view_op=list_classic_articles
//
// So Scholar splits cleanly in two, and this project treats the halves
// differently:
//
//   **The search index is off limits.** `/scholar` is robots-disallowed, and
//   probing confirms Google enforces it: a plain datacenter GET returns
//   `403 Forbidden` (the robot page), and the only thing that gets past it is
//   forging a browser User-Agent — which is the definition of the thing
//   robots.txt asked us not to do. Cloudflare's egress addresses are shared and
//   heavily rate-limited by Google besides, so a scraper here would also be a
//   scraper that stops working. We do not scrape it. If you are reading this
//   because you are about to add "just a small parser" for `/scholar`: that is
//   the change this comment exists to prevent.
//
//   **The metrics and profile pages are explicitly allowed**, and this project
//   uses both — author profiles live in src/scholar-metrics.js, the venue
//   h5-index table in src/scholar-venues.js. That is a real, deep, permitted
//   Google Scholar integration: an answer here can tell you a venue's Scholar
//   h5-index and an author's Scholar h-index, from Google's own numbers.
//
// Which leaves the search leg, and three honest ways to serve it:
//
//   (a) **A licensed Google Scholar search API.** SerpApi and its equivalents
//       run the Scholar query under their own contract and sell the JSON. That
//       is the only supported route to Scholar's actual ranking, so it is
//       wired here behind `SERPAPI_KEY` and is off unless someone sets it.
//       Probed: the endpoint answers `HTTP 200` with `{"error": "Invalid API
//       key…"}` for an unkeyed request — a body check, not a status check, is
//       what detects failure.
//   (b) **The open corpus Scholar indexes.** OpenAlex (the Microsoft Academic
//       Graph successor) and Europe PMC cover substantially the same
//       literature, with something Scholar does not publish: machine-readable
//       venue type, work type and retraction status — the fields peer-review
//       filtering actually needs. These need no key and are the default.
//   (c) **Crossref**, which is authoritative for "is this DOI a journal
//       article" and useless for discovery — see the ranking note below.
//
// The result is a backend LADDER rather than one provider: whatever is
// configured runs, the results merge, and the agent works with no keys at all.
//
// ============================================================================
// PART 2 — the query grammar and ranking, measured
// ============================================================================
//
// OpenAlex `search=` (hit counts for the peer-reviewed filter below):
//
//   ancient DNA mammoth                                    →  2,256
//   "ancient DNA" mammoth                                  →  1,393
//   ancient DNA mammoth genome permafrost preservation     →    271
//   does vitamin D supplementation reduce respiratory …    → 35,424
//
// Three findings, each one a decision here:
//
//  1. **Adding terms narrows**, as with Europe PMC and unlike arXiv — so the
//     ladder climbs by DROPPING terms, never by adding them.
//  2. **Do NOT quote phrases.** Quoting costs 38% of the recall AND made the
//     top hit worse (the specific mammoth paper was replaced by a generic
//     "Genetic Analyses from Ancient DNA"). This is the opposite of Europe
//     PMC, where quoting buys precision. Two sibling APIs, opposite advice —
//     which is why neither is guessed at.
//  3. **Natural-language questions work.** A full sentence returned the
//     definitive paper at rank 1. A light stop-word strip still helps, so the
//     terms below are cleaned, but there is no need for the aggressive
//     concept extraction arXiv requires.
//
// Crossref, same query, `filter=type:journal-article`:
//
//   relevance (default / `sort=score`) → rank 1 is a 2025 paper with ZERO
//   citations in a journal nobody has heard of; the seminal papers are nowhere.
//   `sort=is-referenced-by-count`      → rank 1 is *lme4*, a statistics
//   package, because "effects" matched "Linear Mixed-Effects".
//
// So Crossref is a REGISTRY, not a search engine, and it is used here only to
// verify a DOI or title someone else found. Its `query.bibliographic` has one
// more trap worth recording: asked for the exact title of the Doench 2016
// paper it returns a *Faculty Opinions recommendation of* that paper — a
// `dataset` record with a near-identical title. Title verification therefore
// requires a normalized-title match AND a type check, or the "verification"
// step confidently swaps the paper for a review OF the paper.
//
// ============================================================================
// PART 3 — what counts as peer-reviewed
// ============================================================================
//
// The filter is POSITIVE-EVIDENCE-ONLY: a record is admitted when a backend
// says something that entails peer review, and dropped otherwise. It is never
// admitted for lack of evidence to the contrary. Concretely (`peerReviewed`):
//
//   OpenAlex        type ∈ {article, review} AND the primary location's source
//                   is a `journal` AND not retracted AND it has an ISSN.
//   Europe PMC      source ∈ {MED, PMC, AGR, CBA} — never PPR, which is
//                   bioRxiv/medRxiv — AND a journal title is present.
//   Semantic S.     publicationTypes names JournalArticle or Review AND a
//                   journal name is present AND it has a DOI.
//   Crossref        type = `journal-article` AND it has an ISSN.
//   Google Scholar  NOTHING. A Scholar hit carries no peer-review signal at
//                   all — Scholar indexes preprints, theses, slide decks,
//                   working papers and predatory journals beside Nature, and
//                   its result JSON does not distinguish them. So a Scholar hit
//                   is never admitted on its own: it must be MATCHED to a
//                   record from one of the four above, by DOI or by normalized
//                   title, or it is dropped.
//
// That last rule is the one that makes the agent's promise true rather than
// rhetorical, and it is worth being blunt about the consequence: "answered
// exclusively from Google Scholar" and "answered exclusively from peer-reviewed
// research" are DIFFERENT REQUESTS, and where they conflict this module obeys
// the second. Scholar contributes its ranking and its citation counts; the
// peer-review verdict always comes from a source that publishes one.
//
// ============================================================================
// Invariants
// ============================================================================
//
// Deterministic (invariant 1): the intent gate is a pure regex, every backend
// call is a direct timeout-bounded fetch, no model chooses anything. Fail-soft
// (invariant 2): every backend returns [] on any failure and the source returns
// zero items rather than erroring a chat. Minimal outbound (invariant 4): only
// the AI-derived query crosses the wire — never the conversation, a filename,
// or any account identity. Bilingual (invariant 6): the gates take Swedish with
// the same breadth as English.

/** @typedef {import('./types.js').Env} Env */
/** @typedef {import('./types.js').Logger} Logger */

import { loadVenues, venueNote } from "./scholar-venues.js";

const TIMEOUT_MS = 8000;
const PAGE_SIZE = 8;

/** Per-request wave cap. Each search fans out across every configured backend,
 * so one "search" is already several upstream calls. */
export const SCHOLAR_MAX_PER_REQUEST = 2;

/** The cap while LEADING — the web leg has stood down, so the wave's breadth
 * has to be spent here instead. */
export const SCHOLAR_LEAD_MAX_PER_REQUEST = 4;

/** Merged item cap per search. */
const MAX_ITEMS = 8;

/** Enough distinct records for a rung to have answered the wave; below this the
 * ladder drops a term and tries again. */
const MIN_RUNG_HITS = 4;

// ---- intent ----------------------------------------------------------------
//
// The Unicode-aware boundaries, not `\b`. JavaScript's `\b` is defined over
// [A-Za-z0-9_] only, so `/\bövers/` can never match " översikt" and every
// Swedish alternative beginning or ending in å/ä/ö dies silently inside a
// `\b(…)\b` group — the English half keeps working and the gate simply never
// fires in Swedish. See src/europepmc.js for the full write-up of the trap and
// src/swedish-boundary.test.js for the repo-wide guard.
const B = "(?<![\\p{L}\\p{N}_])";
const E = "(?![\\p{L}\\p{N}_])";
const LETTER = "[\\p{L}]*";

/** Naming Google Scholar or one of the scholarly indexes outright. */
const NAMED = new RegExp(
  B +
    "(?:google\\s*scholar|g\\.?\\s?scholar|scholar\\.google(?:\\.com)?|openalex" +
    "|semantic\\s*scholar|crossref|cross\\s?ref|web\\s+of\\s+science|scopus" +
    "|pubmed|europe\\s*pmc|doi\\.org" +
    "|google\\s*scholar[ns]|scholar[ns]?)" +
    E,
  "iu",
);

/** Words that name the peer-reviewed record as a body of work, either language.
 * Swedish definite and plural forms included, which is how Swedish asks. */
const RESEARCH_WORD = new RegExp(
  B +
    "(?:peer[-\\s]?review(?:ed|s)?|per[-\\s]?review(?:ed)?|refereed" +
    "|stud(?:y|ies)|papers?|publications?|literature|journals?|articles?" +
    "|research|evidence|meta[-\\s]?anal(?:ysis|yses)|systematic reviews?" +
    "|randomi[sz]ed (?:controlled )?trials?|rct|citations?|cited" +
    "|scientific(?:ally)?|science|academic|scholarly|findings?|replicat(?:ed|ion)" +
    "|sakkunniggransk" + LETTER + "|referentgransk" + LETTER + "|kollegialt gransk" + LETTER +
    "|studie|studien|studier|studierna|artikel|artikeln|artiklar|artiklarna" +
    "|publikation(?:er|en)?|publicerad[et]?|litteratur(?:en)?|tidskrift(?:er|en)?" +
    "|forskning(?:en)?|forskningsläget|forskningsresultat|vetenskap(?:lig|liga|en)?" +
    "|bevis|belägg|rön|översikt(?:er|en)?|metaanalys(?:er|en)?" +
    "|systematisk[a]? översikt" + LETTER + "|randomiserad[e]? (?:kontrollerad[e]? )?stud" + LETTER + ")" +
    E,
  "iu",
);

/** "Proven" and its family — asking whether a claim is established. Kept OUT
 * of RESEARCH_WORD and given its own clause because it is the one research
 * word with a heavily commercial idiom ("a proven track record", "tried and
 * proven"), excluded below. Reported by feedback #54 (2026-07-30): "Spirulina
 * proven health benefits" fired no literature gate anywhere in the repo and
 * was answered from supplement-marketing pages. Swedish carries the same
 * breadth (invariant 6); "beprövad" is deliberately absent — in Swedish it is
 * the idiom half ("vetenskap och beprövad erfarenhet"), not the ask. */
const PROVEN_WORD = new RegExp(
  B +
    "(?:proven|proved|proves|unproven|disproven|proofs?|evidence[-\\s]?based" +
    "|clinically|empirical(?:ly)?" +
    "|bevisad[et]?|bevisade|bevisat|bevisar|påvisad[et]?|påvisade|påvisat" +
    "|evidensbaserad[et]?|styrkt[a]?|belagd[at]?|dokumenterad[et]?)" +
    E,
  "iu",
);

/** The commercial idiom the word above is borrowed by. Matched over the whole
 * message: if someone writes "proven track record", the sentence is not an
 * ask for the peer-reviewed record. */
const PROVEN_IDIOM =
  /(?:proven track record|tried[-\s]and[-\s](?:proven|tested)|proven technolog|proven leader|proven winner|proven performer|beprövad)/iu;

/** Asking a question AT the literature: "what does the research say", "finns
 * det belägg för". Fires on its own — it names no field but leaves no doubt. */
const ASKS_THE_LITERATURE = new RegExp(
  "(?:what (?:does|do) the (?:research|literature|evidence|studies|science) (?:say|show|tell)" +
    "|is there (?:any )?(?:evidence|research|studies)" +
    "|according to (?:the )?(?:research|literature|studies|evidence)" +
    "|state of the (?:research|evidence|art|literature)" +
    "|vad säger (?:forskningen|studierna|litteraturen|vetenskapen)" +
    "|finns det (?:några |något )?(?:belägg|bevis|studier|forskning)" +
    "|enligt (?:forskningen|studierna|litteraturen)" +
    "|forskningsläget)",
  "iu",
);

/**
 * Does this message want the peer-reviewed record?
 *
 * Deliberately WIDER than the other sources' gates, and the reason is
 * structural rather than a judgement call: this source is the only one its
 * agent has. Europe PMC can afford to be conservative because a miss falls
 * through to the web leg; here `search.web` is false, so a miss falls through
 * to nothing. The agent forces the source on regardless (`state.forceAux`), so
 * in practice this gate governs whether the source ALSO fires in the ordinary
 * research agent — where a false positive costs one free API call and produces
 * citable journal articles, which is not a bad failure.
 * @param {string} text the latest user message
 * @returns {boolean}
 */
export function scholarIntent(text) {
  const s = String(text || "");
  if (!s) return false;
  if (NAMED.test(s)) return true;
  if (ASKS_THE_LITERATURE.test(s)) return true;
  if (PROVEN_WORD.test(s) && !PROVEN_IDIOM.test(s)) return true;
  return RESEARCH_WORD.test(s);
}

/** Naming Scholar or the peer-reviewed record as THE place to look. Strictly
 * narrower than `scholarIntent` (pinned by search-sources.test.js): leading
 * stands the whole web leg down, so it takes an explicit naming. */
const LEAD_PHRASE = new RegExp(
  // "only peer-reviewed", "use only peer-reviewed sources", "peer-reviewed
  // sources only", "bara sakkunniggranskade artiklar" — the restriction can sit
  // on either side of the noun, in both languages, so it is matched as two
  // alternatives rather than as an optional prefix chain (which got the word
  // order wrong for "use only peer-reviewed sources").
  "(?:(?:only|exclusively|just|solely|bara|enbart|endast|uteslutande)[\\s\\p{L}]{0,16}?(?:peer[-\\s]?reviewed|sakkunniggranskad|referentgranskad|vetenskapliga|publicerade)" +
    "|(?:peer[-\\s]?reviewed|sakkunniggranskade|vetenskapliga)\\s+(?:papers|articles|studies|sources|literature|research|artiklar|studier|källor|publikationer)\\s+(?:only|alone|bara|enbart|endast)" +
    "|the peer[-\\s]?reviewed (?:literature|record|research|sources)" +
    "|the (?:scientific|published|academic|scholarly) literature" +
    "|den vetenskapliga litteraturen|forskningslitteraturen" +
    "|(?:sök|leta|kolla|titta)[\\s\\p{L}]{0,16}?(?:vetenskapliga|forskningslitteraturen|litteraturen))",
  "iu",
);

/**
 * @param {string} text
 * @returns {boolean}
 */
export function scholarLeadIntent(text) {
  const s = String(text || "");
  if (!s) return false;
  return NAMED.test(s) || LEAD_PHRASE.test(s);
}

/** The planner-vocabulary sentence spliced into the triage and gap prompts.
 *
 * The English instruction is the same evidence-backed rule Europe PMC records:
 * the indexed titles and abstracts are English, so a Swedish question must
 * still be SEARCHED in English. The bilingual gates above exist to make sure a
 * Swedish question REACHES this source; translating the query is what makes
 * that worth anything. */
export const scholarPromptNote =
  " Peer-reviewed literature (Google Scholar's venue and author metrics, OpenAlex, Europe PMC, Crossref) is searched for scholarly questions, so phrase at least one query as the scientific concepts themselves (\"vitamin D supplementation acute respiratory infection\", not \"is vitamin D good for colds\") and ALWAYS in English even when the conversation is in Swedish — the indexed titles and abstracts are English.";

// ---- query building --------------------------------------------------------

/** Words carrying no retrieval value. EN + SV, plus the question-shape and
 * search-intent words the pipeline's own prompt rules inject ("peer-reviewed",
 * "studies", "according to") — each of which, left in, spends a slot of an
 * AND-narrowing query on a word every candidate paper contains. */
const STOP = new Set([
  "the", "a", "an", "and", "or", "of", "in", "on", "for", "to", "with", "from", "by", "at",
  "is", "are", "was", "were", "be", "been", "do", "does", "did", "has", "have", "had",
  "what", "which", "who", "whom", "how", "why", "when", "where", "that", "this", "these",
  "those", "there", "any", "some", "can", "could", "should", "would", "will", "may", "might",
  "about", "into", "over", "under", "more", "most", "much", "many", "than", "then", "also",
  "i", "it", "its", "as", "not", "no", "us", "our",
  "peer", "reviewed", "peer-reviewed", "peerreviewed", "refereed", "study", "studies", "paper", "papers",
  "publication", "publications", "literature", "research", "evidence", "journal", "journals",
  "article", "articles", "scholar", "google", "scholarly", "academic", "scientific", "science",
  "according", "say", "says", "show", "shows", "tell", "find", "findings", "state", "latest",
  "recent", "new", "current", "best", "good", "effect", "effects",
  // Swedish
  "och", "eller", "att", "det", "den", "de", "som", "för", "med", "har", "hade", "kan",
  "ska", "skall", "vill", "behöver", "finns", "vad", "hur", "varför", "när", "var", "vem",
  "till", "från", "på", "av", "en", "ett", "är", "var", "vara", "blir", "inte", "om",
  "studie", "studien", "studier", "studierna", "artikel", "artikeln", "artiklar", "artiklarna",
  "forskning", "forskningen", "litteratur", "litteraturen", "vetenskaplig", "vetenskapliga",
  "publikation", "publikationer", "bevis", "belägg", "rön", "säger", "visar", "enligt",
  "sakkunniggranskad", "sakkunniggranskade", "senaste", "nya", "bästa",
]);

/**
 * The retrieval terms of a query: lowercased, stripped of stop words and
 * punctuation, deduped, order preserved, capped at 8.
 * @param {string} query
 * @returns {string[]}
 */
export function scholarTerms(query) {
  const seen = new Set();
  const out = [];
  for (const raw of String(query || "").split(/[^\p{L}\p{N}\-]+/u)) {
    const w = raw.toLowerCase().replace(/^-+|-+$/g, "");
    // Single characters are KEPT. They are rare once the stop list has run and
    // in this literature they are the discriminating term: "vitamin D" and
    // "vitamin K" are different questions, and dropping the letter collapses
    // them onto one dedup key and one query.
    if (!w || STOP.has(w)) continue;
    if (seen.has(w)) continue;
    seen.add(w);
    out.push(w);
    if (out.length >= 8) break;
  }
  return out;
}

/** Cross-wave dedup key: the SORTED term set, so two phrasings of one angle
 * count as the same search and a gap round doesn't re-fetch it.
 * @param {string} query
 * @returns {string}
 */
export function scholarTermKey(query) {
  return scholarTerms(query).slice().sort().join(" ");
}

/**
 * The fallback ladder. Terms narrow (measured above), so each rung DROPS the
 * last term. Bounded at three rungs — the measured spread from 5 terms (271
 * hits) to 3 (over 2,000) is already the whole useful range.
 * @param {string} query
 * @returns {Array<{ terms: string[], key: string, note: string }>}
 */
export function scholarLadder(query) {
  const terms = scholarTerms(query);
  if (!terms.length) return [];
  /** @type {Array<{ terms: string[], key: string, note: string }>} */
  const rungs = [];
  for (let n = terms.length; n >= 2 && rungs.length < 3; n--) {
    const t = terms.slice(0, n);
    rungs.push({ terms: t, key: t.slice().sort().join(" "), note: `${n} terms` });
  }
  if (!rungs.length) rungs.push({ terms, key: terms.slice().sort().join(" "), note: "1 term" });
  return rungs;
}

// ---- the normalized record -------------------------------------------------

/**
 * One candidate publication, in the shape every backend maps to.
 * @typedef {Object} ScholarRecord
 * @property {string} title
 * @property {string} doi bare DOI (`10.1038/nbt.3437`), "" when unknown
 * @property {string} url canonical link a reader can open
 * @property {number|null} year
 * @property {string} venue journal / conference name, "" when unknown
 * @property {string} publisher
 * @property {string} issn
 * @property {string[]} authors
 * @property {number|null} citedBy
 * @property {string} abstract
 * @property {boolean} retracted
 * @property {string} kind the backend's own type string, for the verdict
 * @property {string} backend which backend produced it
 * @property {number} rank the backend's own retrieval position (0 = its top hit)
 * @property {boolean} peerReviewed the verdict (see `peerReviewed`)
 * @property {string} why one line naming the evidence for the verdict
 */

/** Normalized title for cross-backend matching. Aggressive on purpose: the same
 * paper arrives from four backends with different casing, punctuation, HTML
 * entities and trailing periods.
 * @param {string} t
 * @returns {string}
 */
export function titleKey(t) {
  return String(t || "")
    .replace(/<[^>]*>/g, " ")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** A bare DOI from anything DOI-shaped: a doi.org URL, a `doi:` prefix, or the
 * DOI itself. "" when there isn't one.
 * @param {string} v
 * @returns {string}
 */
export function bareDoi(v) {
  const m = String(v || "").match(/10\.\d{4,9}\/[^\s"'<>]+/);
  return m ? m[0].replace(/[.,;)\]]+$/, "").toLowerCase() : "";
}

/** OpenAlex source types that are a peer-reviewed venue. `repository` (arXiv,
 * bioRxiv, institutional archives), `ebook platform` and `metadata` are not. */
const JOURNAL_SOURCE_TYPES = new Set(["journal", "conference"]);

/** Europe PMC sources that are the peer-reviewed record. `PPR` is
 * bioRxiv/medRxiv and is excluded by name. */
const EPMC_PEER_SOURCES = new Set(["MED", "PMC", "AGR", "CBA"]);

/**
 * The peer-review verdict, and the one line of evidence behind it.
 *
 * Positive evidence only. A record with no venue type, no ISSN and no
 * publication type is UNKNOWN, and unknown is rejected — which is what makes
 * "exclusively peer-reviewed" a filter rather than a hope.
 * @param {ScholarRecord} r
 * @returns {{ ok: boolean, why: string }}
 */
export function peerReviewed(r) {
  if (r.retracted) return { ok: false, why: "retracted" };
  switch (r.backend) {
    case "openalex": {
      if (!JOURNAL_SOURCE_TYPES.has(r.kind)) return { ok: false, why: `venue type "${r.kind || "unknown"}"` };
      if (!r.issn) return { ok: false, why: "venue has no ISSN" };
      return { ok: true, why: `${r.kind} with ISSN ${r.issn} (OpenAlex)` };
    }
    case "europepmc": {
      if (!EPMC_PEER_SOURCES.has(r.kind)) return { ok: false, why: r.kind === "PPR" ? "preprint" : `source ${r.kind}` };
      if (!r.venue) return { ok: false, why: "no journal title" };
      return { ok: true, why: `indexed in ${r.kind} as a journal article (Europe PMC)` };
    }
    case "semanticscholar": {
      if (!/journalarticle|review/i.test(r.kind)) return { ok: false, why: `type "${r.kind || "unknown"}"` };
      if (!r.venue || !r.doi) return { ok: false, why: "no journal name or DOI" };
      return { ok: true, why: "journal article with a DOI (Semantic Scholar)" };
    }
    case "crossref": {
      if (r.kind !== "journal-article") return { ok: false, why: `Crossref type "${r.kind || "unknown"}"` };
      if (!r.issn) return { ok: false, why: "no ISSN registered" };
      return { ok: true, why: `Crossref journal-article, ISSN ${r.issn}` };
    }
    // Google Scholar publishes no peer-review signal — see PART 3 in the
    // header. A Scholar hit is only ever admitted by being MERGED into a
    // record from one of the backends above, which replaces this verdict.
    default:
      return { ok: false, why: "no peer-review metadata from this source" };
  }
}

// ---- backends --------------------------------------------------------------
//
// Each returns ScholarRecord[] and NEVER throws. A backend that isn't
// configured returns [] without a request, so the ladder's shape is "whatever
// this deployment has keys for" with no branching at the call site.

/**
 * @param {string} url
 * @param {Logger} log
 * @param {string} name
 * @param {RequestInit} [init]
 * @returns {Promise<any|null>}
 */
async function getJson(url, log, name, init) {
  try {
    const res = await fetch(url, {
      ...init,
      headers: { accept: "application/json", ...(init?.headers || {}) },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      log?.warn?.(`scholar.${name}_http`, { status: res.status });
      return null;
    }
    return await res.json();
  } catch (/** @type {any} */ err) {
    log?.warn?.(`scholar.${name}_failed`, { error: err?.message || String(err) });
    return null;
  }
}

/** The contact address OpenAlex and Crossref both ask polite clients to send.
 * It identifies the SERVICE, never a user — no account, no request id, nothing
 * that could tie a query to a person (invariant 4). */
const POLITE = "research@deepresearch.se";
const POLITE_UA = `DeepResearch.se/1.0 (https://deepresearch.se; mailto:${POLITE})`;

/**
 * OpenAlex — the widest cross-domain backend and the only one that publishes
 * every field the peer-review verdict needs.
 *
 * Note the rate-limit model, measured 2026-07-31: OpenAlex now meters a small
 * free DAILY BUDGET per caller and answers `429` with
 * `{"error":"Rate limit exceeded","message":"Insufficient budget…"}` once it is
 * spent — this container exhausted it in about 25 requests. On Cloudflare's
 * shared egress that budget is effectively always spent, so `OPENALEX_API_KEY`
 * is what makes this backend real in production. Unkeyed it still works when
 * the budget allows, and its 429 is just another empty result (invariant 2).
 * @param {Env} env
 * @param {Logger} log
 * @param {string[]} terms
 * @returns {Promise<ScholarRecord[]>}
 */
export async function openalexSearch(env, log, terms) {
  if (!terms.length) return [];
  const key = String(/** @type {any} */ (env)?.OPENALEX_API_KEY || "");
  const filter = ["type:article|review", "primary_location.source.type:journal", "is_retracted:false"].join(",");
  const url =
    "https://api.openalex.org/works" +
    `?search=${encodeURIComponent(terms.join(" "))}` +
    `&filter=${encodeURIComponent(filter)}` +
    `&per-page=${PAGE_SIZE}` +
    "&select=id,doi,display_name,publication_year,cited_by_count,type,primary_location,authorships,is_retracted,open_access,abstract_inverted_index" +
    `&mailto=${encodeURIComponent(POLITE)}` +
    (key ? `&api_key=${encodeURIComponent(key)}` : "");
  const body = await getJson(url, log, "openalex");
  const results = Array.isArray(body?.results) ? body.results : [];
  return results.map((/** @type {any} */ w, /** @type {number} */ i) => {
    const src = w?.primary_location?.source || {};
    /** @type {ScholarRecord} */
    const r = {
      title: String(w?.display_name || "").trim(),
      doi: bareDoi(w?.doi || ""),
      url: String(w?.doi || w?.id || ""),
      year: Number.isFinite(w?.publication_year) ? w.publication_year : null,
      venue: String(src?.display_name || ""),
      publisher: String(src?.host_organization_name || ""),
      issn: String(src?.issn_l || (Array.isArray(src?.issn) ? src.issn[0] : "") || ""),
      authors: (Array.isArray(w?.authorships) ? w.authorships : [])
        .map((/** @type {any} */ a) => String(a?.author?.display_name || ""))
        .filter(Boolean),
      citedBy: Number.isFinite(w?.cited_by_count) ? w.cited_by_count : null,
      abstract: invertedAbstract(w?.abstract_inverted_index),
      retracted: w?.is_retracted === true,
      kind: String(src?.type || ""),
      backend: "openalex",
      rank: i,
      peerReviewed: false,
      why: "",
    };
    return r;
  });
}

/** OpenAlex ships abstracts as an inverted index (word → positions) because of
 * publisher redistribution terms. Rebuilding it is a positional sort.
 * @param {any} idx
 * @returns {string}
 */
export function invertedAbstract(idx) {
  if (!idx || typeof idx !== "object") return "";
  /** @type {string[]} */
  const words = [];
  for (const [word, positions] of Object.entries(idx)) {
    if (!Array.isArray(positions)) continue;
    for (const p of positions) if (Number.isInteger(p) && p >= 0 && p < 4000) words[p] = word;
  }
  return words.filter(Boolean).join(" ").slice(0, 1200);
}

/**
 * Europe PMC, restricted to the PEER-REVIEWED slice. The sibling source
 * src/europepmc.js searches the same API and deliberately INCLUDES preprints —
 * that is its whole point as a frontier leg. This one excludes them by name
 * (`NOT SRC:PPR`), because an agent promising peer review cannot ship bioRxiv.
 *
 * Free, no key, no budget — which makes it the backend that keeps this agent
 * working on a deployment with no secrets set at all. Its cross-domain reach is
 * honestly weak: probed with "quantum error correction surface code" it returns
 * biomed-adjacent papers and preprints, and with "minimum wage employment
 * effects" it returns public-health journals. Inside the life sciences it is
 * excellent. That asymmetry is why it is one backend and not the only one.
 * @param {Env} _env
 * @param {Logger} log
 * @param {string[]} terms
 * @returns {Promise<ScholarRecord[]>}
 */
export async function europePmcPeerSearch(_env, log, terms) {
  if (!terms.length) return [];
  const q = `${terms.join(" ")} AND (SRC:MED OR SRC:PMC) NOT SRC:PPR`;
  // NO `sort=` — Europe PMC's default is RELEVANCE, and that is the whole
  // ranking decision here. Probed live 2026-07-31 with `sort=CITED desc`, this
  // leg answered "vitamin D supplementation acute respiratory infection" with
  // the 2015 American Thyroid Association guidelines and the PRISMA statement,
  // and "CRISPR off-target effects" with DESeq2 and limma: sorting a loose
  // match set by citations returns the most-cited papers that share a common
  // word, not the most relevant ones. It is the same failure Crossref's
  // `sort=is-referenced-by-count` produces (header, PART 2), and citation
  // magnets are the shape it always takes. Citations still decide the final
  // order — rankRecords does it AFTER retrieval, over papers that are already
  // on topic, which is "the most-cited among the relevant" rather than "the
  // most-cited, whatever it is about".
  const url =
    "https://www.ebi.ac.uk/europepmc/webservices/rest/search" +
    `?query=${encodeURIComponent(q)}&format=json&resultType=core&pageSize=${PAGE_SIZE}`;
  const body = await getJson(url, log, "europepmc");
  const results = Array.isArray(body?.resultList?.result) ? body.resultList.result : [];
  return results.map((/** @type {any} */ x, /** @type {number} */ i) => {
    const doi = bareDoi(x?.doi || "");
    /** @type {ScholarRecord} */
    const r = {
      title: String(x?.title || "").replace(/\s+/g, " ").replace(/\.$/, "").trim(),
      doi,
      url: doi ? `https://doi.org/${doi}` : `https://europepmc.org/article/${x?.source}/${x?.id}`,
      year: Number(x?.pubYear) || null,
      venue: String(x?.journalInfo?.journal?.title || ""),
      publisher: "",
      issn: String(x?.journalInfo?.journal?.issn || ""),
      authors: String(x?.authorString || "").split(/,\s*/).filter(Boolean),
      citedBy: Number.isFinite(Number(x?.citedByCount)) ? Number(x.citedByCount) : null,
      abstract: String(x?.abstractText || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 1200),
      retracted: /retracted/i.test(String(x?.pubType || "")),
      kind: String(x?.source || ""),
      backend: "europepmc",
      rank: i,
      peerReviewed: false,
      why: "",
    };
    return r;
  });
}

/**
 * Semantic Scholar. Key-gated: probed unkeyed it answers `429 Too Many
 * Requests` immediately from this address, so without
 * `SEMANTIC_SCHOLAR_API_KEY` it is skipped rather than tried and failed.
 * @param {Env} env
 * @param {Logger} log
 * @param {string[]} terms
 * @returns {Promise<ScholarRecord[]>}
 */
export async function semanticScholarSearch(env, log, terms) {
  const key = String(/** @type {any} */ (env)?.SEMANTIC_SCHOLAR_API_KEY || "");
  if (!key || !terms.length) return [];
  const fields = "title,year,venue,citationCount,externalIds,publicationTypes,abstract,authors,journal,isOpenAccess";
  const url =
    "https://api.semanticscholar.org/graph/v1/paper/search" +
    `?query=${encodeURIComponent(terms.join(" "))}&limit=${PAGE_SIZE}&fields=${fields}`;
  const body = await getJson(url, log, "semanticscholar", { headers: { "x-api-key": key } });
  const results = Array.isArray(body?.data) ? body.data : [];
  return results.map((/** @type {any} */ p, /** @type {number} */ i) => {
    const doi = bareDoi(p?.externalIds?.DOI || "");
    /** @type {ScholarRecord} */
    const r = {
      title: String(p?.title || "").trim(),
      doi,
      url: doi ? `https://doi.org/${doi}` : `https://www.semanticscholar.org/paper/${p?.paperId || ""}`,
      year: Number(p?.year) || null,
      venue: String(p?.journal?.name || p?.venue || ""),
      publisher: "",
      issn: "",
      authors: (Array.isArray(p?.authors) ? p.authors : []).map((/** @type {any} */ a) => String(a?.name || "")).filter(Boolean),
      citedBy: Number.isFinite(p?.citationCount) ? p.citationCount : null,
      abstract: String(p?.abstract || "").slice(0, 1200),
      retracted: false,
      kind: (Array.isArray(p?.publicationTypes) ? p.publicationTypes : []).join(","),
      backend: "semanticscholar",
      rank: i,
      peerReviewed: false,
      why: "",
    };
    return r;
  });
}

/**
 * The licensed GOOGLE SCHOLAR search leg (SerpApi's `google_scholar` engine).
 * Off unless `SERPAPI_KEY` is set — there is no free tier and no unkeyed mode.
 *
 * What comes back is Scholar's own ranking, its own "cited by" counts and its
 * `publication_info.summary` line ("A Krizhevsky, I Sutskever… - Advances in
 * neural…, 2012"). What does NOT come back is any peer-review signal, so these
 * records are marked `backend: "gscholar"` and can only reach an answer by
 * being merged onto a record from a backend that publishes one — see
 * `mergeRecords` and PART 3 of the header.
 *
 * Failure detection is a BODY check: the endpoint answers `HTTP 200` with
 * `{"error": "Invalid API key…"}` (probed 2026-07-31), so a status check alone
 * reads an auth failure as an empty result set.
 * @param {Env} env
 * @param {Logger} log
 * @param {string[]} terms
 * @returns {Promise<ScholarRecord[]>}
 */
export async function googleScholarSearch(env, log, terms) {
  const key = String(/** @type {any} */ (env)?.SERPAPI_KEY || "");
  if (!key || !terms.length) return [];
  const url =
    "https://serpapi.com/search.json?engine=google_scholar" +
    `&q=${encodeURIComponent(terms.join(" "))}&num=${PAGE_SIZE}&hl=en` +
    `&api_key=${encodeURIComponent(key)}`;
  const body = await getJson(url, log, "gscholar");
  if (!body || body.error) {
    log?.warn?.("scholar.gscholar_error", { error: String(body?.error || "no body").slice(0, 120) });
    return [];
  }
  const results = Array.isArray(body?.organic_results) ? body.organic_results : [];
  return results.map((/** @type {any} */ x, /** @type {number} */ i) => parseScholarResult(x, i)).filter(Boolean);
}

/**
 * One SerpApi Scholar organic result → a ScholarRecord. Split out and exported
 * so it is unit-testable without a key.
 * @param {any} x
 * @param {number} [rank] the result's position in Scholar's own ranking
 * @returns {ScholarRecord | null}
 */
export function parseScholarResult(x, rank = 0) {
  const title = String(x?.title || "").trim();
  if (!title) return null;
  // "A Krizhevsky, I Sutskever, GE Hinton - Advances in neural …, 2012 - papers.nips.cc"
  const summary = String(x?.publication_info?.summary || "");
  const [authorPart = "", venuePart = ""] = summary.split(" - ");
  const yearMatch = summary.match(/\b(1[6-9]\d{2}|20\d{2})\b/);
  const link = String(x?.link || "");
  const resources = Array.isArray(x?.resources) ? x.resources : [];
  const doi = bareDoi(link) || bareDoi(resources.map((/** @type {any} */ r) => r?.link || "").join(" "));
  return {
    title,
    doi,
    url: doi ? `https://doi.org/${doi}` : link,
    year: yearMatch ? Number(yearMatch[1]) : null,
    venue: venuePart.replace(/,\s*(1[6-9]\d{2}|20\d{2})\s*$/, "").replace(/…$/, "").trim(),
    publisher: "",
    issn: "",
    authors: authorPart.split(/,\s*/).map((s) => s.trim()).filter(Boolean),
    citedBy: Number.isFinite(x?.inline_links?.cited_by?.total) ? x.inline_links.cited_by.total : null,
    abstract: String(x?.snippet || "").trim(),
    retracted: false,
    kind: "scholar-result",
    backend: "gscholar",
    rank,
    peerReviewed: false,
    why: "",
  };
}

/**
 * Crossref, used ONLY to check a candidate someone else found — never to
 * discover (its relevance ranking is measured in the header and it is not a
 * search engine).
 *
 * The title path carries the Faculty-Opinions trap: asked for a paper's exact
 * title it will happily return a `dataset` record called "Faculty Opinions
 * recommendation of <that title>". So a title lookup is accepted only when the
 * normalized titles are EQUAL and the type is `journal-article`.
 * @param {Env} _env
 * @param {Logger} log
 * @param {ScholarRecord} cand
 * @returns {Promise<ScholarRecord | null>}
 */
export async function crossrefVerify(_env, log, cand) {
  const headers = { "user-agent": POLITE_UA };
  const select = "title,DOI,type,container-title,ISSN,is-referenced-by-count,issued,publisher,author,abstract";
  const url = cand.doi
    ? `https://api.crossref.org/works/${encodeURIComponent(cand.doi)}?select=${encodeURIComponent(select)}`
    : "https://api.crossref.org/works" +
      `?query.bibliographic=${encodeURIComponent(cand.title)}&rows=1&select=${encodeURIComponent(select)}` +
      `&mailto=${encodeURIComponent(POLITE)}`;
  const body = await getJson(url, log, "crossref", { headers });
  const item = cand.doi ? body?.message : body?.message?.items?.[0];
  if (!item) return null;
  const rec = crossrefRecord(item);
  if (!rec) return null;
  // A title lookup must actually be the same paper. A DOI lookup is exact by
  // construction and skips the check.
  if (!cand.doi && titleKey(rec.title) !== titleKey(cand.title)) {
    log?.info?.("scholar.crossref_title_mismatch", { got: rec.title.slice(0, 80) });
    return null;
  }
  return rec;
}

/**
 * A Crossref `message` item → a ScholarRecord.
 * @param {any} item
 * @returns {ScholarRecord | null}
 */
export function crossrefRecord(item) {
  const title = String((Array.isArray(item?.title) ? item.title[0] : item?.title) || "").replace(/\s+/g, " ").trim();
  const doi = bareDoi(item?.DOI || "");
  if (!title || !doi) return null;
  return {
    title,
    doi,
    url: `https://doi.org/${doi}`,
    year: Number(item?.issued?.["date-parts"]?.[0]?.[0]) || null,
    venue: String((Array.isArray(item?.["container-title"]) ? item["container-title"][0] : "") || ""),
    publisher: String(item?.publisher || ""),
    issn: String((Array.isArray(item?.ISSN) ? item.ISSN[0] : item?.ISSN) || ""),
    authors: (Array.isArray(item?.author) ? item.author : [])
      .map((/** @type {any} */ a) => [a?.given, a?.family].filter(Boolean).join(" "))
      .filter(Boolean),
    citedBy: Number.isFinite(item?.["is-referenced-by-count"]) ? item["is-referenced-by-count"] : null,
    abstract: String(item?.abstract || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 1200),
    retracted: false,
    kind: String(item?.type || ""),
    backend: "crossref",
    rank: 0,
    peerReviewed: false,
    why: "",
  };
}

// ---- merge, verdict, rank --------------------------------------------------

/**
 * Merge every backend's records into one candidate list keyed by DOI (or by
 * normalized title when a record has no DOI), keeping the richest field from
 * whichever backend supplied it.
 *
 * This is where a Google Scholar hit becomes usable: it arrives with a ranking
 * and a citation count but no peer-review evidence, and merging attaches it to
 * the OpenAlex/Europe PMC/Crossref record of the same paper — which has the
 * evidence. A Scholar hit that merges with nothing keeps `backend: "gscholar"`
 * and is rejected by the verdict below, which is the intended outcome.
 * @param {ScholarRecord[][]} lists in backend-priority order
 * @returns {ScholarRecord[]}
 */
export function mergeRecords(lists) {
  /** @type {Map<string, ScholarRecord>} */
  const byKey = new Map();
  /** @type {Map<string, string>} title key → primary key, so a DOI-less Scholar
   * hit finds the DOI-bearing record of the same paper. */
  const titleIndex = new Map();
  for (const list of lists) {
    for (const rec of list) {
      if (!rec?.title) continue;
      const tk = titleKey(rec.title);
      const key = rec.doi || titleIndex.get(tk) || `t:${tk}`;
      const prev = byKey.get(key) || (rec.doi ? undefined : byKey.get(`t:${tk}`));
      if (prev) {
        // Keep the peer-review-bearing backend as the record's identity; take
        // the better-populated value for everything else.
        if (prev.backend === "gscholar" && rec.backend !== "gscholar") prev.backend = rec.backend;
        prev.doi ||= rec.doi;
        prev.venue ||= rec.venue;
        prev.publisher ||= rec.publisher;
        prev.issn ||= rec.issn;
        prev.year ||= rec.year;
        prev.abstract = prev.abstract.length >= rec.abstract.length ? prev.abstract : rec.abstract;
        prev.authors = prev.authors.length >= rec.authors.length ? prev.authors : rec.authors;
        prev.citedBy = Math.max(prev.citedBy ?? 0, rec.citedBy ?? 0) || prev.citedBy || rec.citedBy;
        prev.retracted = prev.retracted || rec.retracted;
        // The best position any backend gave it: a paper two backends both
        // rank first is more on-topic than one that scraped into eighth.
        prev.rank = Math.min(prev.rank, rec.rank);
        if (rec.backend !== "gscholar" && rec.kind) prev.kind = rec.kind;
        if (rec.doi && prev.url.startsWith("http") && !prev.url.includes("doi.org")) prev.url = `https://doi.org/${rec.doi}`;
        // Re-key under the DOI now that we have one, so later lists match it.
        if (rec.doi && key.startsWith("t:")) {
          byKey.delete(key);
          byKey.set(rec.doi, prev);
          titleIndex.set(tk, rec.doi);
        }
        continue;
      }
      const copy = { ...rec, authors: [...rec.authors] };
      byKey.set(key, copy);
      titleIndex.set(tk, key);
    }
  }
  return [...byKey.values()];
}

/**
 * Apply the verdict and drop everything that fails it. Exported so a test can
 * assert on the rejects, which is the half that matters.
 * @param {ScholarRecord[]} records
 * @returns {{ kept: ScholarRecord[], rejected: Array<{ title: string, why: string }> }}
 */
export function filterPeerReviewed(records) {
  const kept = [];
  const rejected = [];
  for (const r of records) {
    const v = peerReviewed(r);
    if (v.ok) {
      r.peerReviewed = true;
      r.why = v.why;
      kept.push(r);
    } else {
      rejected.push({ title: r.title, why: v.why });
    }
  }
  return { kept, rejected };
}

/**
 * Rank the survivors: RELEVANCE first, then citations, then recency.
 *
 * The order of those three is a correction, not a preference. The first build
 * ranked on citations alone, and a live probe (2026-07-31) showed what that
 * does to a literature question: asked about vitamin D and respiratory
 * infection it led with the PRISMA reporting statement, and asked about CRISPR
 * off-target effects it led with DESeq2 and limma. Every one of those is a
 * genuine, heavily peer-reviewed paper — and none of them is about the
 * question. Citation counts across an entire literature are dominated by
 * methods papers and reporting standards that everybody cites and nobody was
 * asking about, so ranking on them alone reliably answers a different question
 * very confidently.
 *
 * So the backend's own retrieval position leads (`rank`, where 0 is its top
 * hit), and citations only order papers of comparable relevance. The citation
 * term is log-damped so a 40-year-old classic doesn't bury everything, and the
 * mild recency bonus keeps the answer from being purely historical.
 * @param {ScholarRecord[]} records
 * @param {number} [now] current year, injectable for tests
 * @returns {ScholarRecord[]}
 */
export function rankRecords(records, now = new Date().getUTCFullYear()) {
  return records
    .map((r, i) => {
      const cites = Math.max(0, r.citedBy ?? 0);
      const age = r.year ? Math.max(0, now - r.year) : 25;
      // Relevance dominates: the gap between retrieval position 0 and position
      // 7 is 3.5 points, which the citation term (at most ~2.4 for a
      // 100,000-citation paper) cannot close on its own. Two adjacent
      // positions differ by 0.5, which it easily can — so citations decide
      // between comparably relevant papers and nothing more.
      const relevance = -0.5 * (Number.isFinite(r.rank) ? r.rank : i);
      const score = relevance + Math.log10(cites + 1) * 0.5 + Math.max(0, 1 - age / 25) * 0.3;
      return { r, score };
    })
    .sort((a, b) => b.score - a.score)
    .map((x) => x.r);
}

/**
 * A record → the item shape sources.js registers, identical to Exa's.
 *
 * The first highlight is the PROVENANCE LINE, and it carries the whole point of
 * the agent: the venue, the year, the Google Scholar h5-index of that venue
 * when Scholar ranks it, the citation count, and the evidence for the
 * peer-review verdict. That line is what the synthesis model reads and what a
 * reader checks the claim against.
 * @param {ScholarRecord} r
 * @param {import('./scholar-venues.js').VenueTable | null} [venues]
 * @returns {{ url: string, title: string, highlights: string[] } | null}
 */
export function toItem(r, venues = null) {
  if (!r?.url || !r?.title) return null;
  const bits = [];
  if (r.venue) {
    const h5 = venueNote(venues, r.venue);
    bits.push(h5 ? `${r.venue} (${h5})` : r.venue);
  }
  if (r.year) bits.push(String(r.year));
  if (r.publisher && r.publisher !== r.venue) bits.push(r.publisher);
  if (Number.isFinite(r.citedBy) && (r.citedBy ?? 0) > 0) bits.push(`cited ${r.citedBy}×`);
  bits.push(`peer-reviewed: ${r.why}`);
  const highlights = [bits.join(" · ")];
  if (r.authors.length) {
    const authors = r.authors.slice(0, 8).join(", ") + (r.authors.length > 8 ? " et al." : "");
    highlights.push(authors);
  }
  if (r.abstract) highlights.push(r.abstract.length > 900 ? `${r.abstract.slice(0, 897)}…` : r.abstract);
  return { url: r.url, title: r.title, highlights };
}

/**
 * The registry's `search`. Runs every configured backend concurrently over one
 * rung of the ladder, merges, applies the peer-review filter, ranks, and drops
 * to the next rung when too little survived.
 *
 * @param {Env} env
 * @param {Logger} log
 * @param {string} query
 * @param {{ skipKeys?: Set<string> }} [opts]
 * @returns {Promise<{ items: Array<{url: string, title: string, highlights: string[]}>, durationMs: number, usedKeys: string[] }>}
 */
export async function scholarSearch(env, log, query, { skipKeys } = {}) {
  const startedAt = Date.now();
  const rungs = scholarLadder(query).filter((r) => !skipKeys?.has(r.key));
  const usedKeys = [];
  // The venue table is a local artifact read; it costs no upstream call and is
  // cached per isolate, so it is fetched alongside the first rung.
  const venuesP = loadVenues(env);

  /** @type {ScholarRecord[]} */
  let kept = [];
  /** @type {Array<{ title: string, why: string }>} */
  let rejected = [];
  let usedNote = "";
  /** @type {string[]} */
  let backendsUsed = [];

  for (const rung of rungs) {
    usedKeys.push(rung.key);
    // Backend-priority order is also merge order: the peer-review-bearing
    // backends go first so a Google Scholar hit merges ONTO one of them rather
    // than the other way round.
    const [oa, epmc, s2, gs] = await Promise.all([
      openalexSearch(env, log, rung.terms).catch(() => []),
      europePmcPeerSearch(env, log, rung.terms).catch(() => []),
      semanticScholarSearch(env, log, rung.terms).catch(() => []),
      googleScholarSearch(env, log, rung.terms).catch(() => []),
    ]);
    backendsUsed = /** @type {string[]} */ ([
      oa.length && "openalex",
      epmc.length && "europepmc",
      s2.length && "semanticscholar",
      gs.length && "gscholar",
    ].filter(Boolean));

    const merged = mergeRecords([oa, epmc, s2, gs]);

    // The one place Crossref earns its keep: a Google Scholar hit that merged
    // with nothing has a title and no evidence. Ask Crossref about it — bounded
    // to three, concurrently — and a real journal article is admitted with
    // Crossref's own verdict while a thesis, preprint or slide deck is not.
    const unverified = merged.filter((r) => r.backend === "gscholar").slice(0, 3);
    if (unverified.length) {
      const checked = await Promise.all(unverified.map((c) => crossrefVerify(env, log, c).catch(() => null)));
      for (let i = 0; i < unverified.length; i++) {
        const c = checked[i];
        if (!c) continue;
        Object.assign(unverified[i], {
          backend: "crossref",
          kind: c.kind,
          doi: c.doi,
          url: c.url,
          issn: c.issn,
          venue: unverified[i].venue || c.venue,
          publisher: c.publisher,
          year: unverified[i].year || c.year,
        });
      }
    }

    const verdict = filterPeerReviewed(merged);
    kept = verdict.kept;
    rejected = verdict.rejected;
    if (kept.length) usedNote = rung.note;
    // Stop on ENOUGH, not on any — the same rule europepmc.js records: a rung
    // matching one paper has not answered the wave.
    if (kept.length >= MIN_RUNG_HITS) break;
  }

  const venues = await venuesP;
  const items = rankRecords(kept)
    .slice(0, MAX_ITEMS)
    .map((r) => toItem(r, venues))
    .filter(Boolean);
  const durationMs = Date.now() - startedAt;
  log?.info?.("scholar.search", {
    query: String(query || "").slice(0, 120),
    rung: usedNote || "none",
    rungs_tried: usedKeys.length,
    backends: backendsUsed.join("+") || "none",
    results: items.length,
    // The counter that tells "the filter is too strict" from "the literature is
    // thin" — the two failures that look identical in an answer.
    rejected: rejected.length,
    venues_ranked: venues ? venues.n : 0,
    duration_ms: durationMs,
  });
  return { items: /** @type {any} */ (items), durationMs, usedKeys };
}

/**
 * Which of the wave's planned angles this source searches. Terms narrow here,
 * so a 7-concept angle is a thin-result query however precise it looks; and an
 * angle sharing vocabulary with what was actually ASKED beats one the planner
 * drifted into (the correction feedback #44 forced on arXiv).
 * @param {string[]} batch
 * @param {string} topic the latest user message
 * @returns {string}
 */
export function scholarPickQuery(batch, topic) {
  let best = batch[0];
  let bestScore = -Infinity;
  const asked = new Set(scholarTerms(topic || ""));
  for (const q of batch) {
    const terms = scholarTerms(q);
    if (!terms.length) continue;
    let score = 0;
    score -= Math.max(0, terms.length - 5);
    for (const t of terms) if (asked.has(t)) score += 1;
    if (score > bestScore) {
      best = q;
      bestScore = score;
    }
  }
  return best;
}

/**
 * Diversity key for doi.org URLs — the registrant prefix, which IS the
 * publisher (10.1038 Nature Portfolio, 10.1016 Elsevier). Without it every DOI
 * collapses to one origin and sources.js's per-origin cap starves the whole
 * leg; with it, "eight hits, all Elsevier" is still capped.
 * @param {string} url
 * @returns {string}
 */
export function scholarDiversityKey(url) {
  try {
    const segs = new URL(url).pathname.split("/").filter(Boolean);
    const prefix = segs[0] || "";
    return /^10\.\d{4,9}$/.test(prefix) ? `doi.org/${prefix}` : "doi.org";
  } catch {
    return "doi.org";
  }
}
