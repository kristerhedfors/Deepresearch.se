// @ts-check
// SHAPING AN ANSWER FOR SOMEONE WHO WILL HEAR IT, NOT READ IT.
//
// The research pipeline writes for a screen: headings, bullet lists, bold runs,
// inline `[1]` citation markers, and a numbered Sources list of URLs at the end.
// All of that is right in the app and wrong in a voice session, where a speech
// engine reads "hash hash Findings" and "bracket one" out loud, and a listener
// gets a minute of URLs they cannot write down.
//
// So `deep_research` takes a `style`, and `voice` runs the answer through this
// module. Two halves, and the split is deliberate:
//
//   VOICE_NOTE goes to the MODEL, appended to the question, and asks for prose
//   in the first place — short sentences, no lists, sources named by outlet
//   rather than numbered. That is the half that improves the ANSWER.
//
//   spokenAnswer() runs over the finished TEXT and removes what survived
//   anyway. That is the half that is guaranteed: a prompt is a request, and a
//   model under a long research context will still occasionally emit a table.
//
// Neither half invents anything or drops a claim. Citation MARKERS go, because
// "bracket four" is noise in the ear; the citation itself does not — the closing
// sentence names the outlets the answer was actually built from, which is what a
// listener can act on ("that came from Nature and Reuters" is checkable, "[4]"
// is not). PURE: imports nothing, so every rule below is unit-testable.

/** How many outlets the closing sentence names before it starts counting. Three
 * is what a person can hold from one spoken clause. */
export const SPOKEN_SOURCE_NAMES = 3;

/**
 * The instruction appended to the caller's question when `style: "voice"`.
 * Deliberately short: it rides on every voice call, and a long preamble competes
 * with the question for the model's attention.
 */
export const VOICE_NOTE =
  "\n\nAnswer this out loud, for someone listening rather than reading. Use plain connected " +
  "prose in short sentences — no markdown, no headings, no bullet lists, no tables, and no " +
  "bracketed citation numbers. Name a source in the sentence when it matters (\"according to " +
  "Nature\"). Lead with the answer, keep it under about two hundred words, and stop when it is " +
  "answered.";

/**
 * Turn one finished answer into speakable text.
 *
 * Every rule here is a removal, and each is safe in the same way: it takes away
 * something a screen reader would pronounce as itself. Nothing paraphrases,
 * nothing summarizes, nothing reorders — a spoken answer that quietly said
 * something different from the written one would be the worst possible bug on
 * this surface, because nobody can see the original to catch it.
 *
 * @param {string} raw the pipeline's answer text
 * @returns {string}
 */
export function spokenText(raw) {
  let text = String(raw || "");

  // Fenced code blocks: unreadable aloud, and a listener cannot use one. Say
  // that a block was there rather than deleting it silently.
  text = text.replace(/```[\s\S]*?```/g, " (a code block is omitted here) ");
  // Inline code fences: keep the code, drop the backticks.
  text = text.replace(/`([^`]+)`/g, "$1");
  // Images first (they are links with a bang), then links: keep the link TEXT,
  // drop the URL. A spoken URL is a minute of nothing.
  text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1");
  text = text.replace(/\[([^\]]+)\]\((?:[^)]*)\)/g, "$1");
  // Bare URLs left in the prose.
  text = text.replace(/<?https?:\/\/[^\s<>)]+>?/g, "");
  // Inline citation markers — [1], [2,3], [1-4]. Anchored to digits so a real
  // bracketed aside survives.
  text = text.replace(/\s*\[\d+(?:\s*[,–-]\s*\d+)*\]/g, "");
  // Headings become sentences: the text is usually a real clause.
  text = text.replace(/^\s{0,3}#{1,6}\s*(.+?)\s*#*\s*$/gm, "$1.");
  // Bullets and numbered list markers.
  text = text.replace(/^\s*[-*+•]\s+/gm, "");
  text = text.replace(/^\s*\d+[.)]\s+/gm, "");
  // Table rows: keep the cells as a clause, drop the pipes and the ---|--- rule.
  text = text.replace(/^\s*\|?[\s:|-]{6,}\|?\s*$/gm, "");
  text = text.replace(/^\s*\|(.+)\|\s*$/gm, (_m, row) =>
    String(row)
      .split("|")
      .map((c) => c.trim())
      .filter(Boolean)
      .join(", ") + ".",
  );
  // Emphasis and horizontal rules.
  text = text.replace(/(\*\*|__|\*|_)(?=\S)([^*_]*?\S)\1/g, "$2");
  text = text.replace(/^\s*([-*_]\s*){3,}$/gm, "");
  // Block quotes.
  text = text.replace(/^\s*>\s?/gm, "");
  // Whitespace: paragraphs become single breaks, runs of spaces collapse, and
  // the double punctuation the heading rule can leave is tidied.
  text = text.replace(/[ \t]+/g, " ");
  text = text.replace(/\n{2,}/g, "\n");
  text = text.replace(/([.!?])\s*\.(\s|$)/g, "$1$2");
  text = text.replace(/\s+([,.;:!?])/g, "$1");
  return text.trim();
}

/**
 * The closing sentence: which outlets this answer was built from, and how many
 * there were. Replaces the numbered Sources list, which is the single least
 * speakable thing the pipeline produces.
 *
 * Outlets are named by their host, stripped of `www.` and of the country tail
 * only when a recognisable name survives — "nature.com" reads well, "com" does
 * not. Empty when there were no sources, and the caller then appends nothing:
 * a spoken "no sources" is worth saying only when the answer claimed otherwise,
 * which is the pipeline's job and not this function's.
 *
 * @param {Array<{ url?: string, title?: string }>} sources
 * @returns {string}
 */
export function spokenSources(sources) {
  const list = Array.isArray(sources) ? sources : [];
  if (!list.length) return "";
  /** @type {string[]} */
  const names = [];
  for (const source of list) {
    const name = outletName(source);
    if (name && !names.includes(name)) names.push(name);
  }
  if (!names.length) return `Based on ${list.length} source${list.length === 1 ? "" : "s"}.`;
  const shown = names.slice(0, SPOKEN_SOURCE_NAMES);
  const rest = list.length - shown.length;
  const joined =
    shown.length === 1 ? shown[0] : `${shown.slice(0, -1).join(", ")} and ${shown[shown.length - 1]}`;
  if (rest > 0) return `Based on ${joined}, and ${rest} other source${rest === 1 ? "" : "s"}.`;
  return `Based on ${joined}.`;
}

/**
 * One source's outlet name, or "" when nothing sayable can be got from it.
 * @param {{ url?: string, title?: string }} source
 * @returns {string}
 */
export function outletName(source) {
  const url = typeof source?.url === "string" ? source.url : "";
  if (!url) return "";
  let host = "";
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
  host = host.replace(/^www\./, "");
  const parts = host.split(".");
  if (parts.length <= 1) return host;
  // Keep the registrable name plus its tail for the common two-label host
  // (nature.com), and drop only the leading subdomains — "news.bbc.co.uk"
  // should be heard as "bbc.co.uk", never as "co.uk".
  const tail = parts.slice(-2).join(".");
  const isCountryPair = parts.length > 2 && parts[parts.length - 1].length === 2 && parts[parts.length - 2].length <= 3;
  return isCountryPair ? parts.slice(-3).join(".") : tail;
}

/**
 * The whole voice-styled answer: speakable prose plus the closing source
 * sentence. The text/screen path keeps using withSources (src/sources.js) — the
 * two are alternatives, never layered.
 * @param {string} answer
 * @param {Array<{ url?: string, title?: string }>} sources
 * @returns {string}
 */
export function spokenAnswer(answer, sources) {
  const text = spokenText(answer);
  const tail = spokenSources(sources);
  if (!tail) return text;
  return text ? `${text}\n\n${tail}` : tail;
}
