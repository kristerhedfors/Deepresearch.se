// Keeping planned search queries pointed at the SUBJECT rather than at the
// report the user asked for — the deterministic half of feedback #65.
//
// The prompt half (SUBJECT_VS_FORMAT_RULE in src/prompts.js) says it in words:
// a named report format is the shape of the answer, never the topic to search
// for. Measured against the fixed JSON planner the three planning phases run on
// (invariant 3 — Mistral Small, not the user's chosen model), the words are not
// enough. On the reported conversation — "Osint revsec", then the follow-up
// "Tiber style threat intel" — the planner still wrote two of its three angles
// about TIBER-EU itself:
//
//   Tiber-EU threat intelligence framework      ← the standard, not the company
//   Tiber-EU threat intelligence examples       ← the standard, not the company
//   RevSec cyber threat intelligence            ← the subject
//
// Raising the model is not available (invariant 3 pins the phase), and function
// calling is not available (invariant 1), so what is left is deterministic code
// over the planner's OUTPUT. That is this module.
//
// It is deliberately timid, because the failure it must not cause is worse than
// the one it fixes: a question genuinely ABOUT a framework must still search
// that framework. Two conditions gate it, and both have to hold.
//
//   1. A method block applied on this turn — so the request is dossier-shaped
//      and a format name in it is a request for a SHAPE.
//   2. The conversation carries a resolvable SUBJECT — at least one content
//      word that is not itself format vocabulary.
//
// "What is TIBER-EU?" satisfies (1), since the entity-research gate fires on the
// word alone, and fails (2), because once the format words are removed nothing
// is left. So the filter disengages and the question searches TIBER-EU, which is
// correct. "Osint revsec" → "Tiber style threat intel" satisfies both: `revsec`
// survives as the subject, and the two framework angles are dropped.

// Words that name a report, a framework, or the act of producing one. Both
// languages at equal breadth (invariant 6) — a Swedish dossier request reaches
// this code by the same path its English twin does, and a list that only knew
// English would disengage on every Swedish turn and silently do nothing.
const FORMAT_WORDS = [
  // the named standards and deliverables
  "tiber", "tibereu", "gtir", "cbest", "swot", "pestel", "pestle", "stride",
  "osint", "kyc", "dossier", "dossiers", "memo", "briefing", "brief",
  // report/format nouns, EN
  "report", "reports", "reporting", "profile", "assessment", "analysis",
  "intelligence", "intel", "threat", "threats", "diligence", "vetting",
  "framework", "frameworks", "methodology", "methodologies", "method",
  "template", "templates", "standard", "standards", "structure", "structured",
  "guidance", "guideline", "guidelines", "example", "examples", "sample",
  "format", "outline", "checklist", "implementation", "compliance",
  // report/format nouns, SV
  "rapport", "rapporten", "rapporter", "hotbild", "hotbilden", "hotanalys",
  "hotanalysen", "hotbedömning", "bakgrundskoll", "bakgrundskontroll",
  "personkontroll", "underrättelse", "underrättelser", "underrättelserapport",
  "ramverk", "ramverket", "metodik", "metod", "mall", "mallen", "struktur",
  "riktlinje", "riktlinjer", "exempel", "profil", "analys", "analysen",
  "bedömning", "granskning", "kartläggning", "genomförande", "efterlevnad",
];

// Words that carry no subject on their own. Not a full stopword list — only
// what actually turns up in these requests, in both languages.
const STOP_WORDS = [
  "a", "an", "the", "of", "on", "in", "for", "to", "and", "or", "with", "about",
  "as", "at", "by", "from", "is", "are", "was", "were", "be", "do", "does",
  "what", "which", "who", "how", "why", "when", "where", "this", "that", "these",
  "those", "it", "its", "make", "makes", "made", "write", "produce", "give",
  "style", "styled", "like", "such", "please", "can", "you", "me", "my", "our",
  "en", "ett", "den", "det", "de", "som", "och", "eller", "med", "om", "på",
  "i", "av", "för", "till", "är", "var", "vad", "vem", "vilken", "vilka", "hur",
  "varför", "när", "här", "denna", "detta", "dessa", "skriv", "gör", "göra",
  "ge", "kan", "du", "jag", "min", "vår", "stil", "liknande", "sådan",
];

const FORMAT = new Set(FORMAT_WORDS);
const STOP = new Set(STOP_WORDS);

// Unicode-aware, because `\w` and `\b` both mangle å/ä/ö — the trap that has
// silently killed bilingual gates in this repo before (see the palaeogenomics
// skill, and src/swedish-boundary.test.js).
const WORD = /[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu;

/**
 * Content words of a text, lowercased, with stopwords removed.
 * @param {string} text
 * @returns {string[]}
 */
export function contentWords(text) {
  if (typeof text !== "string" || !text) return [];
  const out = [];
  for (const m of text.toLowerCase().matchAll(WORD)) {
    // Apostrophes are noise; hyphens are NOT, and an earlier draft that threw
    // them away had a bug the Swedish arm paid for. "TIBER-EU" survived it only
    // because `tibereu` had been added to the list by hand, while
    // "TIBER-ramverket" and "TIBER-stil" collapsed into words the list has
    // never heard of — so the format went unrecognised, and worse, "TIBER-stil"
    // was admitted as part of the SUBJECT, which put the report's own name back
    // into the very search this module had just cleaned it out of. Keeping the
    // hyphen lets bareWord() below check the parts.
    const w = m[0].replace(/['’]/g, "");
    if (bare(w).length < 2 || STOP.has(w) || STOP.has(bare(w))) continue;
    out.push(w);
  }
  return out;
}

/** The word with its hyphens closed up — the form subjects are compared on. */
const bare = (/** @type {string} */ w) => w.replace(/-/g, "");

/**
 * Whether a word names a format, as itself, as its closed-up form, or in any
 * hyphenated part of it ("tiber-ramverket" is the framework twice over).
 * @param {string} word
 * @returns {boolean}
 */
export function isFormatWord(word) {
  if (typeof word !== "string" || !word) return false;
  const w = word.toLowerCase();
  if (FORMAT.has(w) || FORMAT.has(bare(w))) return true;
  return w.split("-").some((p) => p && FORMAT.has(p));
}

/**
 * The SUBJECT vocabulary a conversation establishes: its content words minus
 * everything that only names a format. Empty means there is no subject to
 * protect — the request IS about the format — and every caller disengages.
 * @param {string} text
 * @returns {Set<string>}
 */
export function subjectTokens(text) {
  return new Set(contentWords(text).filter((w) => !isFormatWord(w)).map(bare));
}

/**
 * True when a query chases the report rather than the subject: it reaches for
 * format vocabulary and for none of the subject's own words.
 *
 * Both halves are load-bearing. Requiring a format word is what keeps an
 * ordinary widening angle ("Accenture acquisition 2020") — which names no
 * format and simply does not repeat the subject — out of the filter's way.
 * Requiring the absence of every subject word is what lets a query be mostly
 * format vocabulary and still be on topic ("RevSec cyber threat intelligence").
 *
 * An earlier draft asked instead whether EVERY word was format vocabulary, and
 * it was too weak by exactly one observed case: "How has the Tiber-EU framework
 * been applied in practice?" survived it, because `applied` and `practice` are
 * ordinary words. That question is about the standard, and this rule drops it.
 *
 * @param {string} query
 * @param {Set<string>} subject
 * @returns {boolean}
 */
export function isFormatChasingQuery(query, subject) {
  const words = contentWords(query);
  if (!words.length) return false;
  if (words.some((w) => subject?.has(bare(w)))) return false;
  return words.some(isFormatWord);
}

/**
 * Drops the planner's format-only angles, given the clean (pre-enrichment)
 * conversation text the subject is read from.
 *
 * Disengages — returning the list untouched — when there is no method block on
 * the turn, when the conversation resolves no subject, or when the input is not
 * a list of strings. Never returns empty while it had something to work with:
 * if every angle was about the format, the subject's own words become the one
 * query, which is the user's text rather than anything invented here.
 *
 * @param {string[]} queries
 * @param {{ cleanText: string, methodApplied: boolean }} ctx
 * @returns {{ queries: string[], dropped: string[] }}
 */
export function focusQueriesOnSubject(queries, ctx) {
  const list = Array.isArray(queries) ? queries.filter((q) => typeof q === "string" && q.trim()) : [];
  const unchanged = { queries: Array.isArray(queries) ? queries : [], dropped: [] };
  if (!list.length || !ctx?.methodApplied) return unchanged;
  const subject = subjectTokens(ctx.cleanText || "");
  if (!subject.size) return unchanged; // the request IS about the format
  const kept = [];
  const dropped = [];
  for (const q of list) (isFormatChasingQuery(q, subject) ? dropped : kept).push(q);
  if (!dropped.length) return unchanged;
  // Everything was about the format: search the subject itself rather than
  // nothing. Word order follows the conversation, so this reads as the user's
  // own phrasing with the report name taken out.
  if (!kept.length) {
    const seen = new Set();
    const subjectQuery = contentWords(ctx.cleanText || "")
      .map(bare)
      .filter((w) => subject.has(w) && !seen.has(w) && seen.add(w))
      .join(" ");
    return subjectQuery ? { queries: [subjectQuery], dropped } : unchanged;
  }
  return { queries: kept, dropped };
}
