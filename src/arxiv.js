// @ts-check
// arXiv search — a search-phase source for the research pipeline.
//
// When a research question asks about scientific literature — explicitly
// ("what do the papers say", "arxiv"), or implicitly via research vocabulary
// over a technical topic (arxivIntent, see its comment) — each search wave
// ALSO queries the arXiv API alongside Exa, and the hits (preprints, each with
// its abstract, authors, categories and submission date) join the numbered
// source registry as ordinary citable sources. Wired the same deterministic,
// no-function-calling way as every other integration: intent detection is a
// pure regex, the API call is a direct timeout-bounded fetch, and every branch
// fails soft to "no arXiv results" (the Exa wave is untouched).
//
// This is the LIVE-API tier of the arXiv work. The offline RAG database
// (docs/ARXIV-RAG.md — 327k papers, Berget-embedded, dense+rerank) is a
// separate, richer retrieval path that needs its vectors hosted in Vectorize
// before a Worker can reach them; this module is what makes arXiv searchable
// from /api/chat with no hosted index, and the seam the RAG tier slots into
// later (same registry entry, same item shape).
//
// No API key: the arXiv API is public and free. Minimal outbound request, same
// rule as Exa/HF/Shodan/Maps — only the AI-derived search terms cross the
// wire, never the conversation, filenames, or any account identity.
//
// ---- Endpoint behavior, established empirically (2026-07-26, curl+node) -----
// Host `https://export.arxiv.org/api/query`, Atom 1.0 response. The query
// grammar has one trap that silently returns NOTHING, and it is the shape a
// naive integration writes first:
//
// - `all:"multi word phrase"` returns **0 results**, always. Measured:
//   all:"llm swarm reasoning research 2026" → 0, and even the trimmed
//   all:"llm swarm reasoning" → 0. A quoted phrase in the catch-all `all:`
//   field matches nothing. NEVER build a query that way.
// - Unquoted spaces inside one field are **OR, not AND**. Measured:
//   all:llm+swarm+reasoning → 163,854 hits, byte-identical to the explicit
//   all:llm OR all:swarm OR all:reasoning, and the relevance ordering is
//   junk (top hit for that query is a mobile-robot transportation paper with
//   no LLM content). Adding words makes it WORSE, not narrower:
//   …+research+2026 → 511,207 hits.
// - `abs:"term" AND abs:"term" …` is the form that works, and multi-word
//   phrases DO quote correctly in a fielded term (abs:"collective
//   intelligence" → 75 relevant hits). Measured on the live corpus for the
//   reported failing question: 2 terms → 113 hits, 3 → 37, 4 → 26, and the
//   top hits at every width are exactly on topic ("LLM-Powered Swarms",
//   "Model Swarms: Collaborative Search to Adapt LLM Experts via Swarm
//   Intelligence", "Swarm Intelligence Enhanced Reasoning"). Hence
//   arxivTerms (noise stripping) + arxivAttempts (an AND ladder).
// - Over-specifying returns nothing: 6 AND-ed terms → 0 hits. So the ladder
//   starts at MAX_TERMS and drops from the TAIL until an attempt hits.
// - `sortBy=relevance` is the ordering to use, and **date ordering was tried
//   and lost**. sortBy=submittedDate destroys relevance on a broad set (511k
//   hits → unrelated brand-new papers), and re-sorting one AND-narrowed
//   relevance slice by date locally is no better: measured on the reported
//   failing question, it demoted the two most on-point papers ("Swarm
//   Intelligence Enhanced Reasoning", "Benchmarking LLMs' Swarm intelligence")
//   clean out of the top 5 in favour of tangential UAV-swarm papers that
//   happened to be newer. A softer variant — preferring papers from the last
//   18 months, relevance-stable within the bucket — turned out to be a NO-OP,
//   because every hit in a realistic slice is already inside that window (the
//   corpus grows, so relevance is implicitly recent). So there is no local
//   re-ordering at all: one relevance slice, untouched. Recency is not lost —
//   every item's metadata highlight carries the submission date, so the
//   synthesis model weighs freshness itself, from evidence rather than from a
//   sort this module guessed at.
// - **The published limit is ONE REQUEST EVERY THREE SECONDS, single
//   connection at a time** (arXiv API Terms of Use, checked 2026-07-26),
//   covering the query API, OAI-PMH and RSS together. There is NO paid tier to
//   buy past it: bulk access is open, commercial projects need no MOU and are
//   only encouraged to sponsor, and the sole escalation path is to ask support
//   for a higher rate. So the budget is spent deliberately — MAX_ATTEMPTS 2 ×
//   ARXIV_MAX_PER_REQUEST 2 caps one turn at four requests — and the real fix
//   for volume is to stop asking arXiv at all (the hosted RAG index,
//   docs/ARXIV-RAG.md §7).
// - **arXiv DOES rate-limit, with 429.** The prior note here (inherited from
//   the harvester's experience) said overload shows up as 503 + Retry-After
//   rather than a hard limit. Probing this client produced plain
//   `429 Too Many Requests` and then timeouts. Two consequences, both now
//   enforced in arxivSearch: a 429/503 ABORTS the ladder instead of being read
//   as "this rung found nothing" (answering a rate limit by immediately firing
//   the next query is what earns a longer block), and the ladder carries a
//   TOTAL time budget, because three rungs at the per-request timeout is 21 s
//   inside a search wave. arXiv asks for ~3 s between requests; one wave makes
//   at most a few, and never retries through a throttle.

// One import, deliberately: `edge-cache.js` is the shared fail-soft Workers
// Cache mechanics exa.js and googlemaps.js already use. The registry's
// "no imports from other src/ modules" rule (see search-sources.js) exists so
// two source sessions can't collide in shared ORCHESTRATOR files; a stable
// leaf utility is not that, and duplicating the mechanics here would be worse.
// Caching matters more for this source than for most: a turn can make 3
// searches × up to 3 ladder rungs, all from Cloudflare's shared egress IPs,
// and arXiv answers too much traffic with 429 (observed — see the header).
import { cacheGet, cachePut } from "./edge-cache.js";
// The hosted dense tier, when this deployment has the index bound. It is
// PREFERRED over the live API (better retrieval, and arXiv leaves the request
// path entirely, so the rate limit above stops applying); the live API stays
// as the fallback for every deployment and every failure.
import { arxivRagAvailable, arxivRagSearch } from "./arxiv-rag.js";

/**
 * One source-registry item (same shape Exa results carry).
 * @typedef {{ url: string, title: string, highlights: string[] }} ArxivItem
 */
/**
 * One parsed Atom entry, before it becomes a registry item.
 * @typedef {{ id: string, title: string, summary: string, authors: string[], categories: string[], published: string, updated: string }} ArxivEntry
 */

const ARXIV_ENDPOINT = "https://export.arxiv.org/api/query";
const ARXIV_TIMEOUT_MS = 6000; // per request
const ARXIV_LADDER_BUDGET_MS = 9000; // across the whole ladder
const MAX_TERMS = 4; // first ladder rung; 6 AND-ed terms measured 0 hits
const MIN_TERMS = 2; // below this the AND query is too broad to be useful
// 2, not 3 — arXiv's API Terms of Use ask for "no more than one request every
// three seconds, and limit requests to a single connection at a time", across
// the query API, OAI-PMH and RSS alike. The registry also caps this source at
// ARXIV_MAX_PER_REQUEST searches per turn, so the worst case a single turn can
// put on arXiv is 2 × 2 = 4 requests rather than 3 × 3 = 9. The measured hit
// counts say the third rung rarely earns its keep anyway: the widest rung
// already returned 26 hits on the reported question, so the ladder usually
// stops at the first.
const MAX_ATTEMPTS = 2;
const SLICE = 8; // fetched per attempt; MAX_ITEMS survive the cut
const MAX_ITEMS = 5; // registry items contributed per search
const MAX_ABSTRACT_CHARS = 420; // abstract excerpt carried as a highlight
// 1 h: arXiv metadata is stable (the archive publishes about once a day), so a
// far longer TTL than exa.js's 10 min is safe, and the point is to cut
// outbound calls hard — repeated rungs, gap-round follow-ups that reduce to the
// same terms, and concurrent users on a trending topic all collapse to one
// request. Only a SUCCESSFUL, parsed response is cached, so a throttle or a
// timeout can never pin an empty answer; a genuinely empty feed is
// deterministic for that query and worth remembering.
const CACHE_TTL_S = 3600;
// The registry entry's maxPerRequest, declared here so the rate-limit budget
// (see MAX_ATTEMPTS) lives in one place rather than being split across files.
export const ARXIV_MAX_PER_REQUEST = 2;
// The ceiling when arXiv LEADS the turn (the user named it — arxivLeadIntent).
// Higher because the web leg is standing down: the wave's whole breadth is
// this source's job, and a turn that covers one angle of an explicitly-arXiv
// question is the failure being fixed, not a saving. Worst case on arXiv
// itself is still bounded — the dense tier keeps arXiv out of the request path
// entirely, and on the live-API fallback the ladder aborts on the first
// 429/503 rather than walking through a throttle (see the header).
export const ARXIV_LEAD_MAX_PER_REQUEST = 4;

// ---- intent ----------------------------------------------------------------
// An arXiv id anywhere in the message, or the site/word itself. "Preprint"
// and its Swedish forms belong here too — nothing else means that.
const ARXIV_EXPLICIT =
  /\barxivs?\b|arxiv\.org|\barxiv:\s*\d{4}\.\d{4,5}|\bpre[-\s]?prints?\b|\be[-\s]?prints?\b|\bförtryck(?:et|en)?\b/i;

// Scientific-literature words: a message using one is asking about published
// research, whatever the topic. Swedish carries the same breadth as English
// (invariant 6), parity-tested in arxiv.test.js.
// NB: no \b before "över-"/"rön" style vowels — JS \b is ASCII-word-based and
// never matches before "ö"/"å"/"ä", so a leading boundary there is dead code.
const ARXIV_LITERATURE =
  /\bpapers?\b|\bpublications?\b|\bpublished\b|\bstud(?:y|ies)\b|\bliterature\b|\bpeer[-\s]?review(?:ed)?\b|\bcitations?\b|\bcited\b|\bbibliograph|\bjournals?\b|\bthes[ie]s\b|\bdissertations?\b|\bresearch(?:ers?)?\b|\bacademic\b|\bscientific\b/i;
// NB definite forms are load-bearing: "artiklarna" (definite plural) is the
// most natural way to ask this in Swedish and an `\bartiklar?\b` alternation
// silently misses it — the parity test caught exactly that.
const ARXIV_LITERATURE_SV =
  /\bforskning(?:en|s)?\b|\bforskare\b|\bartik(?:el|eln|lar|larna)\b|\bstudi(?:e|er|en|erna)\b|\bpublikation(?:er|en|erna)?\b|\bpublicerad(?:e|es)?\b|\bvetenskaplig(?:a|t|e)?\b|\breferentgranskad(?:e|t)?\b|\bsakkunniggranskad(?:e|t)?\b|\blitteratur(?:en)?\b|\bavhandling(?:ar|en|arna)?\b|\bcitat(?:et|en)?\b|\bciterad(?:e|es)?\b|rön\b/i;

// Research-intent phrasing: "what's the latest", "does X outperform Y",
// "evidence for", "state of the art". On its own this is not enough (a
// question about the latest iPhone is not a literature question) — it fires
// only together with a technical/scientific topic word below.
const ARXIV_RESEARCH_INTENT =
  /\blatest\b|\brecent(?:ly)?\b|\bnewest\b|\bnew\b|\badvances?\b|\bbreakthroughs?\b|\bstate[-\s]of[-\s]the[-\s]art\b|\bsota\b|\bevidence\b|\bfindings?\b|\bresults?\b|\bbenchmarks?\b|\bablations?\b|\boutperform(?:s|ed|ing)?\b|\bcompar(?:e|es|ed|ison)\b|\bsmarter\b|\bbetter than\b|\bhow many\b|\bwork together\b|\bemerg(?:e|es|ing|ent)\b/i;
const ARXIV_RESEARCH_INTENT_SV =
  /\bsenaste\b|\bnyaste\b|\bnya\b|\bframsteg(?:et|en)?\b|\bgenombrott(?:et|en)?\b|\bforskningsläget\b|\bbevis(?:et|en)?\b|\bresultat(?:et|en)?\b|\bmätningar?\b|\bjämför(?:a|else|elser|t)?\b|\bpresterar\b|\böverträffar\b|\bbättre än\b|\bsmartare\b|\bhur många\b|\bsamarbeta(?:r|de)?\b|\btillsammans\b|\bframväxande\b/i;

// Technical/scientific topic vocabulary — the co-occurrence partner for
// ARXIV_RESEARCH_INTENT. Deliberately the vocabulary of arXiv's own archives
// (cs/stat/physics/math/q-bio/econ) rather than an open-ended word list, so
// "latest news about the election" cannot reach it. Swedish forms included.
const ARXIV_TOPIC =
  /\bllms?\b|\bslms?\b|\blarge language models?\b|\bspråkmodell(?:er(?:na)?|en)?\b|\btransformers?\b|\bneural\b|\bneurala?\b|\bnätverk(?:et|en)?\b|\bmachine learning\b|\bmaskininlärning(?:en)?\b|\bdeep learning\b|\bdjupinlärning(?:en)?\b|\breinforcement learning\b|\bförstärkningsinlärning\b|\bfine[-\s]?tun(?:e|ed|ing)\b|\bfinjuster(?:a|ing(?:en)?)\b|\bembeddings?\b|\bdiffusion models?\b|\btoken(?:s|isation|ization)?\b|\bquantis|\bquantiz|\bkvantiser|\bagents?\b|\bagent(?:er(?:na)?|en)\b|\bmulti[-\s]?agent\b|\bswarms?\b|\bsvärm(?:ar|en)?\b|\breasoning\b|\bresonemang(?:et)?\b|\binference\b|\bslutledning(?:en)?\b|\bhallucinat|\bprompt(?:s|ing)?\b|\brag\b|\bretrieval\b|\bquantum\b|\bkvant(?:mekanik|dator(?:er|n)?)\b|\bcryptograph|\bkryptografi\b|\bpost[-\s]?quantum\b|\balgorithms?\b|\balgoritm(?:er(?:na)?|en)?\b|\bgenom(?:e|ic|ics)\b|\bprotein(?:er)?\b|\bcrispr\b|\bepidemiolog|\bneuroscien|\bneurovetenskap\b|\bcosmolog|\bkosmologi\b|\bastrophys|\bastrofysik\b|\bexoplanets?\b|\bexoplanet(?:er(?:na)?|en)\b|\bsuperconduct|\bsupraled|\bgraphene\b|\bgrafen\b|\bcatalys(?:t|is)\b|\bkatalys(?:ator(?:er)?)?\b|\bsemiconduct|\bhalvledar|\bbattery chemistr|\bbatterikemi\b|\bclimate model|\bklimatmodell(?:er(?:na)?|en)?\b|\bfluid dynamic|\bströmningsmekanik\b|\btopolog|\bmanifolds?\b|\bmångfald(?:er)?\b|\bconjectures?\b|\bförmodan\b|\btheorems?\b|\bsats(?:en|er)?\b|\bproofs?\b|\bbevisföring(?:en)?\b/i;

/**
 * Does this message want scientific literature?
 *
 * Two tiers, mirroring hfIntent's shape:
 *  1. Explicit arXiv / preprint / literature vocabulary fires ALONE — the
 *     message is asking about published research whatever its subject.
 *  2. Research phrasing ("latest", "outperforms", "how many … work together")
 *     fires only WITH a scientific topic word, so "the latest iPhone" stays
 *     out while "latest on LLM swarm reasoning" gets in.
 *
 * Accepted tradeoff, same rationale as hfIntent's HF-radio case: a spurious
 * fire costs one free, fail-soft, keyless arXiv search whose irrelevant hits
 * go uncited (the synthesis cites from the digest, and the diversity cap
 * bounds how much of the registry they can hold). A MISS is the expensive
 * outcome — the reported failure this module exists to fix ran five web
 * searches and never asked arXiv, although every primary source Exa surfaced
 * was itself an arxiv.org page.
 *
 * @param {unknown} text
 */
export function arxivIntent(text) {
  const s = String(text || "");
  if (!s) return false;
  if (ARXIV_EXPLICIT.test(s)) return true;
  if (ARXIV_LITERATURE.test(s) || ARXIV_LITERATURE_SV.test(s)) return true;
  const research = ARXIV_RESEARCH_INTENT.test(s) || ARXIV_RESEARCH_INTENT_SV.test(s);
  return research && ARXIV_TOPIC.test(s);
}

// Words that name some OTHER place to look. When the message asks for arXiv
// *and* the web (or the hub, or the news), it is not asking for arXiv only —
// that is the "unless called for otherwise" half of the reported rule, and it
// is what keeps "compare the arxiv paper with what the blogs say" from losing
// its blogs. Swedish carries the same breadth (invariant 6).
const ARXIV_ALSO_ELSEWHERE =
  /\bweb\b|\bwebsites?\b|\bwebbe?n?\b|\bwebbsökning(?:ar|en|arna)?\b|\bwebbplats(?:er|en|erna)?\b|\bsajt(?:er|en)?\b|\binternet(?:et)?\b|\bnyheter(?:na)?\b|\bnews\b|\bblogg?(?:s|ar|en|arna)?\b|\bonline\b|\belsewhere\b|\bother sources\b|\bandra källor\b|\bgithub\b|\bhugging ?face\b|\bhf\b/i;

/**
 * Does this message ask for arXiv AS THE PLACE TO LOOK — so that arXiv should
 * LEAD the turn and the generic web leg should stand down?
 *
 * Reported (feedback #44, 2026-07-27): "I explicitly asked for an arxiv search
 * but a lot of web search was done first for unknown reason — if asked for
 * arXiv explicitly, start there and do only arxiv unless called for
 * otherwise." The run behind it (chat_logs #694) spent nine Exa queries and
 * 32 sources on "find arXiv research mentioning linux", several of them
 * arXiv's own help pages and third-party arXiv mirrors, while the archive
 * itself was searched as an afterthought.
 *
 * This is deliberately NARROWER than arxivIntent: naming the archive is a
 * different act from asking a research question that arXiv happens to serve.
 * Only the explicit tier leads, and only when no other place is named too.
 *
 * @param {unknown} text
 */
export function arxivLeadIntent(text) {
  const s = String(text || "");
  if (!s) return false;
  if (!ARXIV_EXPLICIT.test(s)) return false;
  return !ARXIV_ALSO_ELSEWHERE.test(s);
}

// ---- query building --------------------------------------------------------
// Noise stripped before the AND query is built. Three classes, each of which
// produced junk or a zero-hit query in a live probe:
//  - literature/platform words (arxiv, paper, preprint, study, research) —
//    they are the INTENT, not the topic, and AND-ing "paper" into an arXiv
//    query matches almost everything;
//  - question/stop words;
//  - search-intent qualifiers the pipeline's own prompt rules inject
//    ("independent reviews", "latest", "2026") — the same class hfTerms
//    strips, and a bare year is the single worst offender here: it AND-ed
//    "2026" into the failing query and pushed it to 511k junk hits.
const NOISE = new Set([
  // literature / platform
  "arxiv", "arxivs", "preprint", "preprints", "eprint", "eprints", "paper",
  "papers", "publication", "publications", "published", "study", "studies",
  "literature", "journal", "journals", "thesis", "theses", "dissertation",
  "citation", "citations", "cited", "research", "researchers", "researcher",
  "academic", "scientific", "science", "peer", "reviewed", "review", "reviews",
  // Hyphenated literature forms are ONE token, so the split words above do not
  // catch them (found running the predicate over tests/bench-questions.mjs).
  "peer-reviewed", "peer-review", "pre-print", "pre-prints", "e-print",
  "e-prints", "referentgranskade", "referentgranskat", "sakkunniggranskade",
  "independent", "survey", "abstract", "abstracts", "article", "articles",
  // question / stop words
  "what", "which", "who", "whom", "whose", "how", "why", "when", "where",
  "the", "a", "an", "and", "or", "of", "on", "in", "for", "to", "with", "by",
  "from", "at", "as", "is", "are", "was", "were", "be", "been", "being", "do",
  "does", "did", "can", "could", "will", "would", "should", "may", "might",
  "have", "has", "had", "that", "this", "these", "those", "there", "their",
  "them", "they", "it", "its", "about", "into", "than", "then", "so", "just",
  "only", "also", "any", "all", "some", "more", "much", "many", "one", "two",
  "get", "gets", "make", "makes", "made", "using", "used", "use", "work",
  "works", "working", "together", "become", "becomes", "becoming", "same",
  "tell", "me", "us", "you", "your", "my", "our", "i", "we", "give",
  // reporting verbs — "what do the papers SAY about X" left "say" AND-ed into
  // the query, which the term-key test caught as two prose spellings of the
  // same question producing two different searches
  "say", "says", "said", "saying", "show", "shows", "showing", "shown",
  "know", "think", "regarding", "concerning", "according",
  // "find arXiv research MENTIONING linux" (feedback #44) AND-ed abs:"mentioning"
  // into the query — a word about the asking, in the exact position where the
  // topic word should have been.
  "mention", "mentions", "mentioned", "mentioning", "featuring", "involving",
  "covering", "discussing", "describing", "relating", "related", "concerns",
  // Generic research nouns/verbs that appear in a majority of arXiv abstracts
  // and so add no discrimination to an AND query — but WOULD consume one of
  // the ladder's 4 term slots, crowding out a real topic word.
  "model", "models", "method", "methods", "approach", "approaches",
  "framework", "frameworks", "technique", "techniques", "system", "systems",
  "outperform", "outperforms", "outperformed", "outperforming",
  // Discourse/meta vocabulary — words about the ASKING rather than the topic.
  // Found by running the intent predicate over tests/bench-questions.mjs: for
  // "Do recent large studies still support the idea that moderate alcohol
  // consumption has a protective cardiovascular effect", these words are what
  // was crowding "cardiovascular" and "consumption" out of the query.
  "still", "support", "supports", "idea", "view", "views", "changed", "change",
  "whether", "reach", "reaches", "different", "differ", "differs", "genuinely",
  "disagree", "disagrees", "agree", "conclusions", "conclusion", "effect",
  "effects", "effectiveness", "assess", "assesses", "increases", "decreases",
  "increase", "decrease", "large", "small", "each", "prefer", "really",
  "actually", "mostly", "generally", "typically", "significant", "significantly",
  // Swedish counterparts of the same class
  "fortfarande", "stöder", "stödjer", "stöd", "idén", "idé", "uppfattning",
  "ändrats", "ändrat", "förändrats", "huruvida", "olika", "skiljer",
  "slutsatser", "slutsats", "effekt", "effekten", "effekter", "ökar",
  "minskar", "stor", "stora", "liten", "verkligen", "faktiskt", "oftast",
  "vanligtvis", "betydande", "väsentligt",
  // search-intent qualifiers
  "latest", "recent", "recently", "newest", "new", "current", "currently",
  "state", "art", "sota", "advances", "advance", "breakthrough",
  "breakthroughs", "overview", "introduction", "guide", "explain", "explained",
  "compare", "compared", "comparison", "versus", "vs", "best", "top", "good",
  "better", "smarter", "list", "find", "search", "searching", "look",
  "evidence", "findings", "results", "result", "developments", "development",
  // Swedish equivalents of every class above
  "arkiv", "förtryck", "artikeln", "artiklar", "studie", "studier", "studien",
  "forskning", "forskningen", "forskare", "publikation", "publikationer",
  "publicerad", "publicerade", "vetenskaplig", "vetenskapliga", "litteratur",
  "litteraturen", "avhandling", "avhandlingar", "referentgranskad", "rön",
  "vad", "vilka", "vilken", "vilket", "vem", "hur", "varför", "när", "var",
  "den", "det", "de", "dem", "en", "ett", "och", "eller", "av", "på", "i",
  "för", "till", "med", "från", "som", "är", "var", "vara", "blir", "bli",
  "kan", "kunde", "ska", "skall", "skulle", "har", "hade", "att", "om",
  "denna", "detta", "dessa", "där", "deras", "sig", "man", "jag", "vi", "du",
  "din", "min", "berätta", "ge", "mig", "oss", "bara", "också", "alla",
  "några", "mer", "mycket", "många", "en", "två", "använda", "använder",
  "arbeta", "arbetar", "tillsammans", "samma", "senaste", "nyaste", "nya",
  "ny", "nuvarande", "framsteg", "genombrott", "översikt", "introduktion",
  "förklara", "jämför", "jämföra", "jämförelse", "mot", "bäst", "bästa",
  "topp", "bra", "bättre", "smartare", "lista", "hitta", "söka", "sök",
  "bevis", "resultat", "resultaten", "utveckling", "utvecklingen",
  // Swedish reporting verbs + function words, matching the English class above
  "säger", "säg", "sa", "sade", "visar", "visade", "vet", "tycker", "tror",
  "angående", "kring", "gällande", "enligt", "finns", "blir", "fler", "flera",
  "hos", "inom", "mellan", "under", "över", "genom", "utan", "genom",
  "artiklarna", "publikationerna", "framstegen", "studierna",
  "nämner", "nämns", "nämnde", "nämnda", "nämnt", "omnämner", "omnämnda",
  "handlar", "berör", "rörande", "beskriver", "diskuterar", "relaterad",
  "relaterade",
  "modell", "modeller", "modellen", "modellerna", "metod", "metoder",
  "metoden", "ansats", "ramverk", "ramverket", "teknik", "tekniker",
  "system", "systemet", "systemen", "överträffar", "presterar",
]);

/**
 * The topic terms an arXiv query is built from: the message/planned query
 * with noise, punctuation and bare years removed, order preserved (the ladder
 * drops from the TAIL, so a query's leading words — the ones a planner puts
 * the subject in — survive longest).
 * @param {unknown} query
 * @returns {string[]}
 */
export function arxivTerms(query) {
  return arxivRankedTerms(query).map((t) => t.term);
}

/**
 * The same terms, each carrying how topic-bearing it looks. Scored from the
 * ORIGINAL casing (before lowercasing), which is the only place the acronym
 * signal survives — "LLM" as the user wrote it is distinctive, "llm" is just
 * a short word.
 * @param {unknown} query
 * @returns {{ term: string, score: number }[]}
 */
export function arxivRankedTerms(query) {
  // String-only: String({}) is "[object Object]", which would otherwise yield
  // a bogus "object" term and AND it into a real query.
  if (typeof query !== "string") return [];
  const raw = query
    // keep intra-word hyphens (multi-agent) and dots in arXiv ids; drop the rest
    .replace(/[^\p{L}\p{N}\s.-]+/gu, " ")
    .split(/\s+/)
    .map((w) => w.replace(/^[.-]+|[.-]+$/g, ""))
    .filter(Boolean);
  /** @type {{ term: string, score: number }[]} */
  const kept = [];
  const seen = new Set();
  for (const original of raw) {
    const w = original.toLowerCase();
    if (NOISE.has(w)) continue;
    if (/^\d+$/.test(w)) continue; // bare numbers, above all years
    if (w.length < 2) continue;
    if (seen.has(w)) continue;
    seen.add(w);
    kept.push({ term: w, score: arxivDistinctiveness(original) });
  }
  return kept;
}

/**
 * How topic-bearing a word looks, used to pick WHICH terms an AND query
 * spends its four slots on (arxivSelectTerms).
 *
 * Position is not a usable proxy. It works for a planner's keyword angle
 * ("llm swarm reasoning research 2026") but fails badly on a natural
 * question: "Do recent large studies still support the idea that moderate
 * alcohol consumption has a protective cardiovascular effect" leaves, in
 * order, [large, still, support, idea, moderate, alcohol, consumption,
 * protective, cardiovascular, …] — so the first four slots go to
 * `large still support idea` and the actual subject never reaches the query.
 *
 * Length is the bulk of the signal (technical vocabulary is longer than
 * discourse vocabulary), with two corrections length alone gets wrong:
 * acronyms are short but maximally distinctive (LLM, RAG, SSE, GAIA), and
 * hyphenated or digit-bearing tokens are compound technical terms
 * (multi-agent, GPT-4, 1-bit).
 *
 * @param {string} original the token with its original casing
 */
export function arxivDistinctiveness(original) {
  const w = String(original || "");
  // An acronym the user capitalised (LLM, RAG, SSE, GAIA, CRISPR) is the most
  // specific token a query can carry, so it outranks any ordinary word rather
  // than merely getting a nudge — a +6 bonus still lost "LLM" (9) to
  // "consumption" (11), which is backwards.
  if (/^[A-Z0-9]{2,6}$/.test(w)) return 12 + w.length;
  let score = w.length;
  if (/[-\d]/.test(w)) score += 3; // compound / versioned technical token
  return score;
}

/**
 * The terms one AND query spends its slots on: the `limit` most distinctive,
 * returned in the query's own word order so the query reads naturally and its
 * dedup key is stable. Successive limits NEST (top-3 ⊂ top-4), which is what
 * makes the ladder's rungs progressively broader rather than merely different.
 * @param {{ term: string, score: number }[]} ranked
 * @param {number} limit
 * @returns {string[]}
 */
export function arxivSelectTerms(ranked, limit) {
  const list = Array.isArray(ranked) ? ranked : [];
  if (list.length <= limit) return list.map((r) => r.term);
  return list
    .map((r, i) => ({ ...r, i }))
    // Highest score first; ties keep the query's own order.
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .slice(0, limit)
    .sort((a, b) => a.i - b.i)
    .map((r) => r.term);
}

/**
 * An explicit arXiv id in the message ("arxiv:2606.09730", "2606.09730v1") —
 * when present it IS the query, via the API's id_list parameter, and no term
 * ladder is needed.
 * @param {unknown} query
 * @returns {string | null}
 */
export function arxivId(query) {
  const m = /\b(?:arxiv:\s*)?(\d{4}\.\d{4,5})(?:v\d+)?\b/i.exec(String(query || ""));
  return m ? m[1] : null;
}

/**
 * The bounded AND ladder: the most distinctive term set first, then
 * progressively broader ones as slots are given up. Each rung carries a stable
 * `key` for cross-wave dedup, so a later wave whose planned query reduces to a
 * rung an earlier wave already spent skips it instead of re-fetching.
 *
 * Measured widths on the live corpus (see header): 4 terms → 26 hits, 3 → 37,
 * 2 → 113, 6 → 0. Hence MAX_TERMS 4 down to MIN_TERMS 2.
 *
 * @param {unknown} query
 * @returns {{ terms: string[], key: string }[]}
 */
export function arxivAttempts(query) {
  const id = arxivId(query);
  if (id) return [{ terms: [`id:${id}`], key: `id:${id}` }];
  const ranked = arxivRankedTerms(query);
  if (!ranked.length) return [];
  /** @type {{ terms: string[], key: string }[]} */
  const rungs = [];
  const widest = Math.min(ranked.length, MAX_TERMS);
  for (let n = widest; n >= MIN_TERMS && rungs.length < MAX_ATTEMPTS; n--) {
    const slice = arxivSelectTerms(ranked, n);
    rungs.push({ terms: slice, key: slice.join(" ") });
  }
  // A single surviving term still deserves one attempt (a one-word topic like
  // "graphene" is a legitimate arXiv query, just a broad one).
  if (!rungs.length) rungs.push({ terms: [ranked[0].term], key: ranked[0].term });
  return rungs;
}

/**
 * The `search_query` value for one ladder rung. Fielded AND over abs: — the
 * ONE form measured to work for both single words and multi-word phrases
 * (see the header trap notes).
 * @param {string[]} terms
 */
export function arxivSearchQuery(terms) {
  return terms.map((t) => `abs:"${t}"`).join(" AND ");
}

// ---- Atom parsing ----------------------------------------------------------
// Workers have no DOMParser, and the feed is a small, rigidly-shaped Atom
// document, so entries are cut out by regex. Every field is optional in
// practice: a malformed entry yields null from arxivMapEntry rather than
// throwing (fail-soft, junk in → null out).

/** @param {string} s */
function decodeXml(s) {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    // &amp; last, so "&amp;lt;" doesn't become "<"
    .replace(/&amp;/g, "&");
}

/**
 * @param {string} block
 * @param {string} tag
 * @returns {string}
 */
function tagText(block, tag) {
  const m = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`).exec(block);
  return m ? decodeXml(m[1]).replace(/\s+/g, " ").trim() : "";
}

/**
 * Parse an arXiv Atom feed into entries. Never throws.
 * @param {unknown} xml
 * @returns {ArxivEntry[]}
 */
export function arxivParseFeed(xml) {
  const text = String(xml || "");
  /** @type {ArxivEntry[]} */
  const out = [];
  for (const m of text.matchAll(/<entry\b[^>]*>([\s\S]*?)<\/entry>/g)) {
    const block = m[1];
    out.push({
      id: tagText(block, "id"),
      title: tagText(block, "title"),
      summary: tagText(block, "summary"),
      authors: [...block.matchAll(/<author\b[^>]*>[\s\S]*?<name[^>]*>([\s\S]*?)<\/name>/g)].map((a) =>
        decodeXml(a[1]).replace(/\s+/g, " ").trim(),
      ),
      categories: [...block.matchAll(/<category\b[^>]*\bterm="([^"]+)"/g)].map((c) => c[1]),
      published: tagText(block, "published"),
      updated: tagText(block, "updated"),
    });
  }
  return out;
}

/**
 * The bare arXiv id (with version) from an entry's `id` URL.
 * @param {string} idUrl
 */
export function arxivIdOf(idUrl) {
  const m = /arxiv\.org\/abs\/(.+)$/i.exec(String(idUrl || ""));
  return m ? m[1] : "";
}

/**
 * One parsed entry → one registry item, or null when it is unusable.
 * The highlight lines are what the synthesis reads and cites from, so the
 * metadata line carries what a literature answer needs: authors, primary
 * category, submission date and the id.
 * @param {ArxivEntry} e
 * @returns {ArxivItem | null}
 */
export function arxivMapEntry(e) {
  if (!e || typeof e !== "object") return null;
  const id = arxivIdOf(e.id);
  const title = String(e.title || "").trim();
  if (!id || !title) return null;
  const authors = (e.authors || []).filter(Boolean);
  const shown = authors.slice(0, 3).join(", ");
  const meta = [
    authors.length ? `${shown}${authors.length > 3 ? " et al." : ""}` : "",
    (e.categories || [])[0] || "",
    String(e.published || "").slice(0, 10),
    `arXiv:${id}`,
  ]
    .filter(Boolean)
    .join(" · ");
  const abstract = String(e.summary || "").trim();
  /** @type {string[]} */
  const highlights = [meta];
  if (abstract) {
    highlights.push(
      abstract.length > MAX_ABSTRACT_CHARS ? `${abstract.slice(0, MAX_ABSTRACT_CHARS).trimEnd()}…` : abstract,
    );
  }
  return { url: `https://arxiv.org/abs/${id}`, title, highlights };
}

// ---- the client ------------------------------------------------------------
/**
 * The synthetic cache key for one request's parameters. A `.internal` URL that
 * namespaces the entry and never leaves the isolate (the edge-cache.js
 * convention). Keyed on the PARAMS, not the user's prose, so two differently
 * worded questions that reduce to the same rung share one entry.
 * @param {URLSearchParams} params
 */
export function arxivCacheKey(params) {
  return `https://arxiv.cache.internal/query?${params}`;
}


/**
 * Search arXiv for one planned query. Fail-soft in every branch: a dead API,
 * a timeout, a malformed feed or zero hits all resolve to an empty item list
 * with the attempts recorded, never a throw.
 *
 * @param {import('./types.js').Env} env
 * @param {import('./types.js').Logger} log
 * @param {string} query
 * @param {{ skipKeys?: Set<string> }} [opts]
 * @returns {Promise<{ items: ArxivItem[], durationMs: number, usedKeys: string[] }>}
 */
export async function arxivSearch(env, log, query, { skipKeys } = {}) {
  const started = Date.now();
  // Tier 1: the hosted index, when bound. It gets the PROSE query — dense
  // retrieval wants the natural question, and the noise stripping below is a
  // lexical-AND concern that would throw away signal an embedder uses. A null
  // return (unavailable, or any failure) falls through to the live API, so a
  // deployment without the binding behaves exactly as before.
  if (arxivRagAvailable(env)) {
    const dense = await arxivRagSearch(env, log, query, { limit: MAX_ITEMS });
    if (dense && dense.length) {
      const durationMs = Date.now() - started;
      log.info("arxiv.search", { query, tier: "dense", results: dense.length, duration_ms: durationMs });
      return { items: dense, durationMs, usedKeys: [] };
    }
  }
  /** @type {string[]} */
  const usedKeys = [];
  /** @type {ArxivItem[]} */
  let items = [];
  let attempted = 0;
  let throttled = false;

  for (const rung of arxivAttempts(query)) {
    if (skipKeys?.has(rung.key)) continue;
    // Total-time bound across the whole ladder, not just per request: three
    // rungs at the per-request timeout would be 21 s inside a search wave,
    // which is long enough to matter to the deadline the wave is planned
    // against (invariant 2 — a slow backend must not defeat fail-soft).
    if (Date.now() - started > ARXIV_LADDER_BUDGET_MS) {
      log.warn("arxiv.ladder_budget", { spent_ms: Date.now() - started, attempts: attempted });
      break;
    }
    usedKeys.push(rung.key);
    attempted++;
    const params = new URLSearchParams({ start: "0", max_results: String(SLICE) });
    const idOnly = rung.terms.length === 1 && rung.terms[0].startsWith("id:");
    if (idOnly) {
      params.set("id_list", rung.terms[0].slice(3));
    } else {
      params.set("search_query", arxivSearchQuery(rung.terms));
      params.set("sortBy", "relevance");
    }
    // Cross-request result cache (same pattern as exa.js): a hit means no
    // outbound call at all, which is the main defence against the 429 above.
    const cacheKey = arxivCacheKey(params);
    const cached = await cacheGet(log, "arxiv.cache", cacheKey);
    if (Array.isArray(cached)) {
      log.info("arxiv.cache_hit", { terms: rung.terms.length, results: cached.length });
      if (cached.length) {
        items = cached;
        break;
      }
      continue; // a remembered empty rung — broaden without asking arXiv again
    }
    try {
      const res = await fetch(`${ARXIV_ENDPOINT}?${params}`, {
        headers: { accept: "application/atom+xml" },
        signal: AbortSignal.timeout(ARXIV_TIMEOUT_MS),
      });
      if (!res.ok) {
        log.warn("arxiv.http", {
          status: res.status,
          terms: rung.terms.length,
          retry_after: res.headers.get("retry-after") || undefined,
        });
        // Being rate-limited or overloaded is NOT a "this rung found nothing"
        // signal, and the ladder must not answer it by immediately firing the
        // next query — that is what earns a longer block. Observed live
        // (2026-07-26): repeated probing got 429 Too Many Requests, and the
        // ladder walked straight through it wasting the wave's time budget.
        // arXiv also answers overload with 503 + Retry-After. Either way: stop.
        if (res.status === 429 || res.status === 503) {
          throttled = true;
          break;
        }
        continue;
      }
      const entries = arxivParseFeed(await res.text());
      const mapped = entries
        .map(arxivMapEntry)
        .filter(/** @returns {i is ArxivItem} */ (i) => Boolean(i))
        .slice(0, MAX_ITEMS);
      // Only a successful, parsed response is remembered — a throttle or a
      // timeout takes the paths above/below and never writes, so a transient
      // failure can't pin an empty answer for an hour.
      await cachePut(log, "arxiv.cache", cacheKey, mapped, CACHE_TTL_S);
      if (mapped.length) {
        items = mapped;
        break;
      }
    } catch (/** @type {any} */ err) {
      log.warn("arxiv.fetch_failed", { error: err?.message || String(err) });
    }
  }

  const durationMs = Date.now() - started;
  log.info("arxiv.search", {
    query,
    attempts: attempted,
    results: items.length,
    throttled,
    duration_ms: durationMs,
  });
  return { items, durationMs, usedKeys };
}

// ---- registry glue ---------------------------------------------------------
/**
 * How well one planned angle serves the user's ACTUAL topic, as a pair
 * compared `covered` first (more is better), then `extra` (less is better).
 *
 * `extra` carries the fallback in its sign: with no user topic to compare
 * against — or with an angle that overlaps it nowhere, which is what a gap
 * round's follow-up on an entity learned from the web looks like — it is
 * `-terms.length`, so "fewest extras" reduces to the ORIGINAL rule, "the most
 * topic-bearing angle wins".
 *
 * @param {string} query
 * @param {Set<string>} wanted the user's own topic terms
 * @returns {{ covered: number, extra: number }}
 */
function arxivAngleScore(query, wanted) {
  const terms = arxivTerms(query);
  if (!wanted.size) return { covered: 0, extra: -terms.length };
  let covered = 0;
  for (const t of terms) if (wanted.has(t)) covered++;
  if (!covered) return { covered: 0, extra: -terms.length };
  return { covered, extra: terms.length - covered };
}

/**
 * Which of the wave's planned queries arXiv searches: the angle that covers
 * the most of the USER'S OWN topic with the fewest terms narrowing away from
 * it. Ties keep the batch's own order (the planner's first angle is its
 * primary one).
 *
 * The `topic` argument is why this exists. "Most topic-bearing angle" alone —
 * the rule this replaces — reads "most terms survive noise-stripping", which
 * on a broad request picks the planner's NARROWEST sub-angle. Reported
 * (feedback #44, 2026-07-27): asked to "find arXiv research mentioning
 * linux", it searched `linux performance optimization` — the user called that
 * "surprisingly narrow", and it is: of the wave's nine angles it is the one
 * that adds two topics the user never asked for. Scoring against the user's
 * own terms picks `arxiv research papers linux` instead, which is the request.
 *
 * A richer question is unaffected: for "latest on LLM swarm reasoning", the
 * angle `llm swarm reasoning agents benchmark` covers all three user terms and
 * still beats the contentless `what are the latest papers`. Coverage comes
 * first precisely so specificity is only ever penalised when it is drifting.
 *
 * @param {string[]} batch
 * @param {string} [topic] the latest user message — the pipeline passes it;
 *   callers that have none get the original rule (see arxivAngleScore).
 */
export function arxivPickQuery(batch, topic = "") {
  const list = Array.isArray(batch) ? batch.filter((q) => typeof q === "string") : [];
  if (!list.length) return "";
  const wanted = new Set(arxivTerms(topic));
  let best = list[0];
  let bestScore = arxivAngleScore(list[0], wanted);
  for (const q of list.slice(1)) {
    const score = arxivAngleScore(q, wanted);
    if (score.covered > bestScore.covered || (score.covered === bestScore.covered && score.extra < bestScore.extra)) {
      best = q;
      bestScore = score;
    }
  }
  return best;
}

/**
 * Cross-wave dedup key: the term set, not the prose. Gap-round follow-ups
 * routinely reduce to the same terms after noise-stripping (the HF trace that
 * showed three identical hub searches in one request), and an identical AND
 * query returns an identical result set.
 * @param {unknown} query
 */
export function arxivTermKey(query) {
  const id = arxivId(query);
  if (id) return `id:${id}`;
  // The widest rung's terms — the same set arxivAttempts starts from, so the
  // key the orchestrator dedups on and the search actually run agree.
  return arxivSelectTerms(arxivRankedTerms(query), MAX_TERMS).join(" ");
}

// Planner vocabulary (spliced into the triage/gap prompts via the
// search-source registry, src/search-sources.js). Two rules, both traced to
// the reported failure this module fixes:
//  - "arxiv" must never be clarified — it is a clear referent on a research
//    site, exactly the trap that killed "Latest on cybersecurity on hf"
//    (hfPromptNote's dated note).
//  - Queries must be written in ENGLISH scientific vocabulary even when the
//    conversation is Swedish: arXiv abstracts are essentially all English, so
//    a Swedish-worded query AND-ed over abstracts matches nothing. This is the
//    prompt-layer half of invariant 6 — Swedish questions are served with the
//    same breadth, by translating the QUERY rather than by dropping the
//    source.
export const arxivPromptNote =
  ' "arXiv"/"arxiv" in a user message means arxiv.org, the scientific preprint archive: treat it as a clear referent — never ask to clarify it — and when a question asks about scientific papers, research findings, benchmarks or the state of the art, write at least one search angle as the plain English technical terms of the topic (arXiv abstracts are English, so Swedish-worded queries find nothing there; keep the user-facing answer in the conversation language).';

// The registry diversity-cap key for arxiv.org URLs (consulted via the
// search-source registry by src/sources.js). arxiv.org is a PLATFORM hosting
// millions of independently-authored preprints by unrelated research groups:
// keying the whole archive as ONE origin would cap a literature question at 3
// arXiv sources total, starving exactly the registry that question needs —
// and it would also make arXiv results compete with the arxiv.org pages Exa
// itself returns for the same three slots. Key by PAPER, so each preprint
// counts as the independent work it is; the per-search MAX_ITEMS cap and
// plan.maxSources are what bound the total.
/** @param {string} url */
export function arxivDiversityKey(url) {
  try {
    const u = new URL(url);
    const m = /\/(?:abs|pdf|html)\/(.+)$/.exec(u.pathname);
    if (!m) return "arxiv.org";
    return `arxiv.org/${m[1].replace(/v\d+$/, "").replace(/\.pdf$/i, "")}`;
  } catch {
    return "arxiv.org";
  }
}
