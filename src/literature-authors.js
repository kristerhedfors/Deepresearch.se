// @ts-check
// AUTHOR LOOKUP for the literature MCP family — "everything by this
// researcher", which the hosted corpora structurally cannot answer.
//
// ---- why this exists (the reported failure) --------------------------------
//
// A user connected the MCP server to Claude and asked for a named
// palaeogeneticist's body of work. Every tool on the surface came back useless:
// `search` returned `{"results":[]}` with nothing to explain it, and
// `literature_search` returned ancient-DNA papers by other people. The client
// model read that as "the corpus has nothing" and stopped searching. The user's
// report was that it never searched at all — which is what silence looks like
// from the outside.
//
// It was not silence. THE PAPERS WERE THERE. The dense tier returned several of
// that researcher's own group's papers; his name simply was not in any of them.
// Three separate causes stack, and each one alone is enough to lose an author:
//
//   1. THE STORED AUTHOR LIST IS TRUNCATED TO THE FIRST FEW NAMES. Both
//      indexers cut the author string when they build vector metadata. In the
//      life sciences the senior author — the one whose "body of work" a corpus
//      question is usually about — is LAST, so on any paper with a long author
//      list the lab head is precisely the name that gets dropped. A 40-author
//      genomics paper stores the eight people least likely to be asked about.
//   2. DENSE RETRIEVAL CANNOT SEARCH BY AUTHORSHIP. The embedding of a personal
//      name carries no authorship signal — it retrieves papers that TALK about
//      the topics that name co-occurs with. Asking multilingual-e5-large for
//      "Love Dalén's papers" is asking it for ancient-DNA papers, and that is
//      exactly and only what it returns.
//   3. NEITHER INDEX CARRIES A VECTORIZE METADATA INDEX. So even with complete
//      author strings there is no server-side `authors CONTAINS` filter to push
//      into the query — see src/literature-tools.js's FILTER_NOTE.
//
// (1) is being fixed at the source (the indexers now keep the first names AND
// the last two, so the senior author survives), but that only reaches vectors
// written after a re-upsert of ~2.4M records. (2) and (3) are not fixable at
// all inside the hosted indexes.
//
// ---- so the author leg goes LIVE -------------------------------------------
//
// Europe PMC and arXiv both expose real author-field search, which is the one
// thing dense retrieval cannot imitate:
//
//     AUTH:"Dalén L"                       → 243 papers, sortable by citations
//     AUTH:"Dalén L" AND (mammoth OR "ancient DNA")  → 115, disambiguated
//
// Measured against the live API on 2026-08-05. Sorting by citation count is
// what makes this answer "life works" rather than "recent works": the top of a
// CITED desc list IS the body of work someone is known for. Both sorts are
// fetched and interleaved, the same popular+fresh shape src/europepmc.js's own
// ladder uses, because either one alone is stale or untested.
//
// AUTHOR NAMES ARE NOT UNIQUE and this module does not pretend otherwise. The
// probe above surfaced a paediatric-nutrition trial by a different "Dalen L"
// inside the palaeogeneticist's results. Europe PMC's ORCID field is populated
// too thinly to disambiguate on (checked on the same records: absent), so the
// honest tool is one that says so and offers the lever that works — a `topic`
// that ANDs subject terms onto the author query, which took that same search
// from 243 mixed records to 115 clean ones. The response says which lever was
// used and that a shared surname may still be in the list.
//
// THIS MODULE IS PURE. Its one import is src/literature-tools.js, the family's
// other pure half, for the bound the tool schema publishes — so the file-layout
// rule at the top of src/mcp.js still holds: nothing here reaches the pipeline,
// and src/mcp.test.js still loads the protocol module without src/berget.js.
// Query building, the bilingual intent gate and record mapping live here; the
// two live fetches live in src/europepmc.js and src/arxiv.js beside the wire
// formats they parse, and src/literature-run.js joins them.

import { MAX_AUTHORS } from "./literature-tools.js";

/** Author queries fetched per corpus, per sort. */
export const AUTHOR_PAGE_SIZE = 25;
/** Records returned per corpus after merging the two sorts. */
export const AUTHOR_LIMIT = 20;

// ---------------------------------------------------------------------------
// The bilingual intent gate (invariant 6).
//
// `\b` is unusable here: JavaScript defines it over [A-Za-z0-9_], so any
// Swedish alternative touching å/ä/ö is dead on arrival and fails silently with
// the English half still matching. src/swedish-boundary.test.js guards the whole
// repo against it; the convention is Unicode lookaround with the `u` flag, and
// these are the same B/E/LETTER pieces src/europepmc.js names.
// ---------------------------------------------------------------------------

const B = "(?<![\\p{L}\\p{N}_])";
const E = "(?![\\p{L}\\p{N}_])";

/** A personal name as it appears after "by" / "av": one to four capitalised
 * words, allowing the particles Swedish and continental names actually carry
 * ("van", "von", "de", "af", "af Bjerkén"). Unicode-aware so "Dalén",
 * "Öberg" and "Ångström" are names rather than three-letter fragments. */
const NAME = "(?:\\p{Lu}[\\p{L}'’-]+|van|von|de|del|af|der|den)(?:\\s+(?:\\p{Lu}[\\p{L}'’-]+|van|von|de|del|af|der|den)){0,3}";

/**
 * "Papers BY <name>" — the possessive-free forms, in both languages.
 *
 * Swedish takes the same breadth as English per invariant 6, and that means the
 * forms Swedish actually uses rather than transliterated English: "av" for the
 * agent, the definite plurals ("artiklarna", "publikationerna"), the
 * "vad har X publicerat" question shape, and "forskning av".
 */
const BY_PATTERNS = [
  // EN: papers/publications/works/research/articles/studies/preprints by X
  `${B}(?:papers?|publications?|works?|research|articles?|studies|preprints?|bibliograph(?:y|ies)|output)\\s+(?:published\\s+)?(?:by|from|of)\\s+(?<name>${NAME})`,
  // EN: everything/all that X has published / written / authored
  `${B}(?:everything|all|anything)\\s+(?:\\p{L}+\\s+){0,3}?(?<name>${NAME})\\s+(?:has\\s+)?(?:published|written|authored|co-authored)`,
  // EN: what has X published / written
  `${B}what\\s+(?:has|did)\\s+(?<name>${NAME})\\s+(?:published?|written|write|authored?)`,
  // SV: artiklar/publikationer/verk/arbeten/forskning/studier av X
  `${B}(?:artiklar(?:na)?|publikationer(?:na)?|verk(?:en)?|arbeten(?:a)?|forskning(?:en)?|studier(?:na)?|avhandlingar(?:na)?|bibliografi(?:n)?|f(?:ö|o)rfattarskap(?:et)?)\\s+(?:publicerade?\\s+)?(?:av|från|fran)\\s+(?<name>${NAME})`,
  // SV: vad har X publicerat/skrivit/forskat om
  `${B}vad\\s+har\\s+(?<name>${NAME})\\s+(?:publicerat|skrivit|forskat|gjort|kommit\\s+fram\\s+till)`,
  // SV: allt (som) X har publicerat/skrivit
  `${B}allt(?:\\s+som)?\\s+(?<name>${NAME})\\s+(?:har\\s+)?(?:publicerat|skrivit|forskat)`,
];

/**
 * The nouns that name a body of work, in both languages. One list, because the
 * possessive forms MIX: the reported failure was literally "love daléns life
 * works" — a Swedish genitive on the name with an English noun after it, which
 * is how a Swedish speaker writing to an English-language assistant actually
 * types. Splitting the noun sets by language would have refused exactly the
 * question that started this.
 */
const WORK_NOUNS =
  "(?:life['’]?s?\\s+)?works?|papers?|publications?|research|articles?|studies|" +
  "body\\s+of\\s+work|oeuvre|output|bibliograph(?:y|ies)|" +
  "artiklar(?:na)?|publikationer(?:na)?|verk(?:en)?|arbeten(?:a)?|forskning(?:en)?|" +
  "studier(?:na)?|livsverk(?:et)?|avhandlingar(?:na)?|bibliografi(?:n|er)?|" +
  "f(?:ö|o)rfattarskap(?:et)?";

/**
 * The subset of WORK_NOUNS that can only follow a PERSON.
 *
 * This split exists because the bare-`s` genitive is ambiguous in English: an
 * unmarked "s" before a plural noun is far more often an ordinary plural than a
 * possessive. Accepting the whole noun list after it read "mammoth genomics
 * studies" as a researcher named "mammoth genomic". The Swedish work nouns have
 * no such collision (an English sentence does not end in "artiklar"), and
 * neither does "life works" or "bibliography" — nothing but a person has those.
 */
const PERSONAL_WORK_NOUNS =
  "life['’]?s?\\s+works?|livsverk(?:et)?|bibliograph(?:y|ies)|bibliografi(?:n|er)?|body\\s+of\\s+work|oeuvre|" +
  "artiklar(?:na)?|publikationer(?:na)?|verk(?:en)?|arbeten(?:a)?|forskning(?:en)?|" +
  "studier(?:na)?|avhandlingar(?:na)?|f(?:ö|o)rfattarskap(?:et)?";

/**
 * "<name>'S works" — the possessive forms. English writes "'s", Swedish writes
 * a bare "s" on the name ("Daléns arbeten") and a colon-s on a name already
 * ending in a sibilant ("Nilsson:s").
 */
const POSSESSIVE_PATTERNS = [
  // An APOSTROPHE or colon-s is an unambiguous possessive marker, so the whole
  // noun list is safe after it.
  `${B}(?<name>${NAME})(?:['’]s|:s)\\s+(?:${WORK_NOUNS})${E}`,
  // A bare `s` is not — see PERSONAL_WORK_NOUNS.
  `${B}(?<name>${NAME})s\\s+(?:${PERSONAL_WORK_NOUNS})${E}`,
  // No genitive at all — "Love Dalén life works", "Dalén bibliography". Tighter
  // again: with no possessive marker, only the nouns that are meaningless
  // except after a person survive. "mammoth forskning" must not read as a
  // researcher called Mammoth.
  `${B}(?<name>${NAME})\\s+(?:life['’]?s?\\s+works?|livsverk(?:et)?|bibliograph(?:y|ies)|bibliografi(?:n|er)?|body\\s+of\\s+work|oeuvre|f(?:ö|o)rfattarskap(?:et)?)${E}`,
];

const AUTHOR_RES = [...BY_PATTERNS, ...POSSESSIVE_PATTERNS].map((p) => new RegExp(p, "iu"));

/**
 * Words a capitalised run may not consist of. Without this "Ancient DNA" reads
 * as a surname in "papers by Ancient DNA researchers" — and a name that is
 * really a topic sends a live author query that can only return nothing.
 */
const NOT_A_NAME =
  /^(?:the|a|an|this|that|these|those|his|her|their|our|my|den|det|de|denna|detta|dessa|hans|hennes|deras|v[åa]r|min|ancient|dna|rna|ai|ml|arxiv|pubmed|medline|nature|science|cell|sweden|sverige|university|universitetet|institute|institutet|lab|labbet|team|teamet|group|gruppen|professor|dr|doktor|forskare|researchers?|scientists?|authors?|f(?:ö|o)rfattare)$/iu;

/**
 * Words that can sit at either END of a captured run without being part of the
 * name. The gates match case-INSENSITIVELY (a user typing "love daléns life
 * works" — the exact phrasing that produced the reported failure — has no
 * capitals to match on), which means `\p{Lu}` in NAME stops discriminating and
 * an auxiliary can be swallowed: "everything Love Dalén has published" captured
 * "Love Dalén has". Trimming these off both ends is what keeps the capture a
 * name.
 */
const EDGE_STOPWORDS = new RegExp(
  "^(?:" +
    // auxiliaries, articles and prepositions, EN + SV
    "the|a|an|of|that|this|these|those|has|have|had|is|was|were|are|and|by|from|for|to|in|on|" +
    "som|har|hade|är|ar|och|av|den|det|de|till|med|om|en|ett|" +
    // conversational lead-ins, EN + SV
    "tell|show|find|list|give|want|know|need|please|me|us|my|about|all|everything|search|look|" +
    "berätta|visa|hitta|leta|lista|ge|vill|veta|s(?:ö|o)k|snälla|mig|oss|allt|alla" +
    ")$",
  "iu",
);

/**
 * Trim the words that can bracket a captured run without belonging to the name.
 *
 * Two passes, because two different things put junk in the capture. Auxiliaries
 * and articles ride along on either end ("Love Dalén has" from "everything Love
 * Dalén has published"). And a conversational lead-in gets swallowed whenever
 * the text is all lowercase — "tell me about love daléns life works" captured
 * "me about love dalén", because with nothing capitalised there is no signal
 * separating a lead-in from a name.
 *
 * When the text DOES carry capitals, that signal exists and is used: leading
 * parts with no capital are dropped, which is why the Title-case form of the
 * same sentence needs no stopword list at all.
 *
 * @param {string} name
 * @param {boolean} [caseSignificant]
 */
export function trimNameEdges(name, caseSignificant = false) {
  let parts = String(name || "").trim().split(/\s+/).filter(Boolean);
  while (parts.length && EDGE_STOPWORDS.test(parts[0])) parts.shift();
  while (parts.length && EDGE_STOPWORDS.test(parts[parts.length - 1])) parts.pop();
  if (caseSignificant) {
    // A name particle ("van", "af") is legitimately lowercase, so only drop a
    // leading lowercase word when a capitalised part still follows it.
    while (parts.length > 1 && !/^\p{Lu}/u.test(parts[0]) && parts.slice(1).some((p) => /^\p{Lu}/u.test(p))) {
      parts.shift();
    }
  }
  return parts.join(" ");
}

/**
 * Is this run a person rather than a topic?
 *
 * @param {string} name
 * @param {boolean} [caseSignificant] true when the source text contained ANY
 *   capital letter. Then a name must carry one, which is what separates
 *   "papers by Love Dalén" from "papers by mammoth genomics". In an all-
 *   lowercase question capitalisation carries no signal at all, so the check is
 *   dropped rather than applied to text that cannot satisfy it — the cost of
 *   the resulting false positive is two live queries that return nothing plus a
 *   note saying so, against the cost of ignoring the question a real user
 *   actually typed.
 */
export function looksLikeName(name, caseSignificant = false) {
  const parts = String(name || "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length || parts.length > 4) return false;
  // Every part being a stopword/topic word means this is not a person.
  if (parts.every((p) => NOT_A_NAME.test(p))) return false;
  if (caseSignificant && !parts.some((p) => /^\p{Lu}/u.test(p))) return false;
  // A single bare word is a name only if it is not a topic word — "papers by
  // Dalén" is a name, "papers by Nature" is not.
  if (parts.length === 1) return !NOT_A_NAME.test(parts[0]) && parts[0].length > 2;
  return true;
}

/**
 * Does this text ask for a named person's body of work, and if so, whose?
 *
 * Deterministic and bilingual (invariant 6). Returns null for anything that is
 * not clearly an authorship question — a false positive costs a live API call
 * that returns nothing, so the gate stays narrow and the explicit `authors`
 * argument stays the reliable route.
 *
 * @param {unknown} text
 * @returns {{ name: string, matched: string } | null}
 */
export function authorIntent(text) {
  const s = String(text || "").replace(/\s+/g, " ").trim();
  if (!s) return null;
  const caseSignificant = /\p{Lu}/u.test(s);
  for (const re of AUTHOR_RES) {
    const m = re.exec(s);
    if (!m) continue;
    const name = trimNameEdges(m.groups?.name || "", caseSignificant);
    if (!name || !looksLikeName(name, caseSignificant)) continue;
    return { name, matched: m[0].trim() };
  }
  return null;
}

/**
 * The author names to look up for one call: the explicit `authors` argument
 * first, then whatever the queries themselves asked for.
 *
 * @param {unknown} explicit the `authors` argument
 * @param {string[]} queries
 * @returns {{ names: string[], detected: boolean }}
 */
export function resolveAuthors(explicit, queries = []) {
  /** @type {string[]} */
  const names = [];
  const seen = new Set();
  const add = (/** @type {unknown} */ raw) => {
    const name = String(raw || "").replace(/\s+/g, " ").trim();
    if (!name || name.length > 80) return;
    const key = name.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    names.push(name);
  };

  const list = Array.isArray(explicit) ? explicit : explicit ? [explicit] : [];
  for (const raw of list) add(raw);
  const explicitCount = names.length;

  // Only fall back to detection when nothing was named outright: a caller that
  // passed `authors` has already been precise, and mining its prose for a
  // second name would search for someone it did not ask about.
  if (!explicitCount) for (const q of queries) add(authorIntent(q)?.name);

  return { names: names.slice(0, MAX_AUTHORS), detected: explicitCount === 0 && names.length > 0 };
}

// ---------------------------------------------------------------------------
// Query building. Two grammars, and they are not interchangeable — the
// **integrations** and **palaeogenomics** skills both record that Europe PMC
// ANDs by default while arXiv wants its operators spelled out.
// ---------------------------------------------------------------------------

/** Strip the query characters each API treats as syntax. */
function bare(/** @type {unknown} */ value) {
  return String(value || "").replace(/["():]/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * The topic terms that disambiguate a shared surname, as an OR group. Kept
 * short deliberately: every AND term costs recall, and the point is to separate
 * two different people, not to narrow to one paper.
 * @param {string[]} queries
 * @param {number} max
 */
export function topicTerms(queries, max = 6) {
  /** @type {string[]} */
  const out = [];
  const seen = new Set();
  for (const q of queries) {
    // Drop the authorship phrasing itself — "papers by" is not a subject.
    const stripped = bare(q).replace(
      /\b(?:papers?|publications?|works?|articles?|studies|research|by|from|of|what|has|did|everything|all|the|a|an)\b/giu,
      " ",
    );
    for (const word of stripped.split(/\s+/)) {
      const w = word.trim();
      if (w.length < 4) continue;
      const key = w.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(w);
      if (out.length >= max) return out;
    }
  }
  return out;
}

/**
 * Europe PMC's author query. `AUTH:"Surname I"` is the field it indexes, and it
 * also matches the full form, so the caller's spelling is passed through rather
 * than reformatted into initials — reformatting "Love Dalén" to "Dalén L"
 * guesses at which part is the surname and gets Chinese and Spanish names
 * wrong.
 *
 * @param {string} name
 * @param {string[]} [terms] optional disambiguating topic terms, ORed
 */
export function europepmcAuthorQuery(name, terms = []) {
  const who = bare(name);
  if (!who) return "";
  const parts = who.split(" ");
  /** @type {string[]} */
  const forms = [`AUTH:"${who}"`];
  // "Love Dalén" is indexed as "Dalén L". Add that form so the natural spelling
  // finds the record, without dropping the full form that preprint servers use.
  if (parts.length >= 2) {
    const surname = parts[parts.length - 1];
    const initial = parts[0][0];
    if (surname && initial) forms.push(`AUTH:"${surname} ${initial}"`);
  }
  const who_ = forms.length > 1 ? `(${forms.join(" OR ")})` : forms[0];
  const topic = terms.filter(Boolean).map((t) => `"${bare(t)}"`).filter((t) => t !== '""');
  return topic.length ? `${who_} AND (${topic.join(" OR ")})` : who_;
}

/**
 * arXiv's author query. Its API wants explicit field prefixes and explicit
 * boolean operators — the inverse of Europe PMC's implicit AND.
 *
 * @param {string} name
 * @param {string[]} [terms]
 */
export function arxivAuthorQuery(name, terms = []) {
  const who = bare(name);
  if (!who) return "";
  const topic = terms.filter(Boolean).map((t) => bare(t)).filter(Boolean);
  const head = `au:"${who}"`;
  return topic.length ? `${head} AND (${topic.map((t) => `all:"${t}"`).join(" OR ")})` : head;
}

// ---------------------------------------------------------------------------
// Record mapping. The live APIs return richer records than the index does — a
// full author list and a citation count, neither of which the stored metadata
// has — so the shape is the family's LiteratureRecord plus the two extra
// fields, marked with the source that produced it.
// ---------------------------------------------------------------------------

/** Clean up an abstract that arrived as HTML-ish prose. */
function cleanAbstract(/** @type {unknown} */ value, cap = 900) {
  const text = String(value || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  return text.length > cap ? `${text.slice(0, cap).trimEnd()}…` : text;
}

/**
 * One Europe PMC `resultType=core` record → a literature record.
 * @param {any} r
 * @returns {any | null}
 */
export function europepmcAuthorRecord(r) {
  const title = String(r?.title || "").replace(/\s+/g, " ").trim().replace(/\.$/, "");
  if (!title) return null;
  const pmid = String(r?.pmid || "").trim();
  const doi = String(r?.doi || "").trim();
  const source = String(r?.source || "").trim();
  const rawId = String(r?.id || "").trim();
  const url = pmid
    ? `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`
    : doi
      ? `https://doi.org/${doi}`
      : source && rawId
        ? `https://europepmc.org/article/${source}/${rawId}`
        : "";
  if (!url) return null;

  // The full author list, uncut — the whole reason this leg exists.
  const authors = Array.isArray(r?.authorList?.author)
    ? r.authorList.author.map((/** @type {any} */ a) => String(a?.fullName || "").trim()).filter(Boolean)
    : String(r?.authorString || "")
        .split(/,\s*/)
        .map((/** @type {string} */ a) => a.trim().replace(/\.$/, ""))
        .filter(Boolean);

  const abstract = cleanAbstract(r?.abstractText);
  const cited = Number(r?.citedByCount);
  return {
    corpus: "pubmed",
    source: "europepmc-live",
    ...(pmid ? { id: pmid } : { id: rawId || doi }),
    url,
    title,
    authors,
    date: String(r?.firstPublicationDate || r?.pubYear || "").slice(0, 10),
    ...(r?.journalInfo?.journal?.title ? { journal: String(r.journalInfo.journal.title) } : {}),
    ...(Number.isFinite(cited) ? { cited_by: cited } : {}),
    abstract,
    abstract_cut: abstract.endsWith("…"),
  };
}

/**
 * One arXiv Atom entry (as src/arxiv.js's arxivParseFeed produces) → a
 * literature record.
 * @param {any} e
 * @returns {any | null}
 */
export function arxivAuthorRecord(e) {
  const raw = String(e?.id || "").trim();
  const id = raw.replace(/^https?:\/\/arxiv\.org\/abs\//, "").replace(/v\d+$/, "");
  const title = String(e?.title || "").replace(/\s+/g, " ").trim();
  if (!id || !title) return null;
  const abstract = cleanAbstract(e?.summary);
  return {
    corpus: "arxiv",
    source: "arxiv-live",
    id,
    url: `https://arxiv.org/abs/${id}`,
    title,
    authors: (e?.authors || []).map((/** @type {unknown} */ a) => String(a || "").trim()).filter(Boolean),
    date: String(e?.published || "").slice(0, 10),
    ...((e?.categories || [])[0] ? { primary_category: String(e.categories[0]) } : {}),
    abstract,
    abstract_cut: abstract.endsWith("…"),
  };
}

/**
 * Merge the two sorted slices one live corpus returned, de-duplicated, keeping
 * the interleaved order — most-cited and most-recent alternating, so neither
 * sort can spend the whole cap.
 *
 * @param {any[]} cited
 * @param {any[]} recent
 * @param {number} [cap]
 */
export function interleaveAuthorRecords(cited, recent, cap = AUTHOR_LIMIT) {
  /** @type {Map<string, any>} */
  const out = new Map();
  for (let i = 0; i < Math.max(cited.length, recent.length) && out.size < cap; i++) {
    for (const r of [cited[i], recent[i]]) {
      if (!r || out.size >= cap) continue;
      const key = `${r.corpus}:${r.id}`.toLowerCase();
      if (!out.has(key)) out.set(key, r);
    }
  }
  return [...out.values()];
}

// ---------------------------------------------------------------------------
// The notes an author result must carry.
// ---------------------------------------------------------------------------

export const AUTHOR_LIVE_NOTE =
  "Author results come from the LIVE Europe PMC and arXiv author-field APIs, not from the " +
  "hosted vector indexes. The indexes cannot answer an authorship question at all: dense " +
  "retrieval matches a personal name against topics rather than authorship, neither index " +
  "carries a Vectorize metadata index to filter on, and the stored author string is " +
  "truncated — which drops the LAST authors, where the senior author of a life-science " +
  "paper is. So these records are current to the hour and cover the full archive, not the " +
  "corpus windows literature_corpora describes.";

export const AUTHOR_AMBIGUITY_NOTE =
  "Author names are not unique and this lookup does not resolve identity: a common surname " +
  "will mix two different researchers in one list (Europe PMC's ORCID field is too thinly " +
  "populated to disambiguate on). Check the journal and co-authors before attributing, and " +
  "narrow by passing subject terms in `queries` — they are ANDed onto the author query, " +
  "which is the lever that separates two people with the same name.";

export const AUTHOR_SORT_NOTE =
  "Two orderings are fetched per corpus and interleaved: most-cited (the work the author is " +
  "known for — this is what makes a 'body of work' question answerable) and most-recent " +
  "(what they are doing now). `cited_by` is Europe PMC's count where it has one.";

export const AUTHOR_DETECTED_NOTE =
  "No `authors` argument was passed — the name was read out of the query text, because the " +
  "query asked for a person's body of work and dense retrieval cannot answer that. Pass " +
  "`authors` explicitly to control the spelling.";
