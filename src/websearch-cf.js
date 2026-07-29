// @ts-check
// The CLOUDFLARE-ORIGINATING web-search backend — "our own search", run by the
// Worker itself.
//
// Every other backend this project speaks to is somewhere ELSE: Exa (a hosted
// third party that retains queries), or a service the operator runs (SearXNG /
// an Exa-compatible endpoint — the local-web-search skill). This one has no
// elsewhere. The Worker fetches a results page, unwraps the result links, and
// (by default) fetches the top result pages to pull real text excerpts, all
// from Cloudflare's own edge. No search API key, no service to deploy, no new
// dependency — the search originates from the same isolate already running the
// pipeline.
//
// WHY THIS SHAPE (the "most suitable implementation" question). Four candidates
// were on the table for a Cloudflare-native search:
//   1. Browser Rendering (@cloudflare/puppeteer) — real Chromium at the edge.
//      Rejected: a paid binding, a heavyweight runtime dependency, and a
//      per-session concurrency ceiling far below what a search WAVE needs
//      (pipeline.js fires a whole batch of queries concurrently).
//   2. Workers AI / AutoRAG — an index we would have to build and keep fresh.
//      Rejected for live web research: it answers over a corpus, not the web.
//   3. A separate Worker service + service binding. Rejected: a second
//      deployable for a few hundred stateless lines.
//   4. Plain `fetch` + pure string parsing, INSIDE the existing Worker.
//      Chosen. It is the only option with no binding, no key, no dependency
//      and no extra deploy, and — the deciding factor — the parsers stay
//      PURE, so they unit-test under `node --test` like the rest of src/.
//      (HTMLRewriter would be the idiomatic Workers parser, but it exists only
//      in workerd: it would move this module's whole parse step out of reach
//      of the test suite for no gain on documents this small.)
//
// WHY A CASCADE, NOT ONE SERP (measured 2026-07-25, not assumed). The obvious
// move was to lift the shipped local browsing agent's `browse` engine
// (public/cure/local-search/agent.mjs) straight into the Worker — same
// technique, other side of the trust boundary. It does not transfer. From a
// datacenter IP, DuckDuckGo's no-JS endpoint answers HTTP 202 with an empty
// anti-bot shell: verified from a session container against html. and lite.,
// GET and POST, bot UA and browser UA — every combination, zero results. That
// agent runs on a person's own machine, where the same endpoint behaves. So
// the SERP is not one host but an ORDERED LIST tried until one yields results,
// and adding a source is a table entry.
//
// WHY A THROTTLE INTERSTITIAL IS ITS OWN CASE (measured 2026-07-29, and the
// cause of the reported "quality issues" on this backend). Marginalia answers
// a request it is rate-limiting with HTTP **200** and a 1 KB page reading
// "Wait For A Moment / The search engine is currently barraged by queries from
// bots" — not a 429, not an error. `resp.ok` is true, the card parse finds
// nothing, the anchor fallback finds nothing outbound, and the cascade
// concluded "empty" and gave up. Sampled from a session container that was
// 7 responses in 10 for an ordinary query, and 6 in 6 under the concurrency a
// search WAVE actually creates — so with DuckDuckGo already dead from a
// datacenter IP, MOST queries in a wave returned no sources at all while
// looking like a legitimately empty index.
//
// The interstitial carries its own remedy: a retry link bearing an `sst`
// session token and a countdown. Following it (bounded, twice at most) took
// the same sampled battery from 3/10 to 9/10. So a throttle is detected,
// logged as a throttle, and RETRIED — never silently counted as "no results".
//
// FAIL-SOFT, like every helper phase (CLAUDE.md invariant 2): a blocked SERP,
// an anti-bot shell, a throttle that will not clear, a timeout, or a page that
// will not load all degrade — the next provider, empty highlights, null from
// the backend — never an error out of the search wave. src/exa.js falls back
// to Exa from there when a key exists and `fallback_exa` is on.
//
// WHAT LEAVES CLOUDFLARE: the query string, to the SERP host, and one plain GET
// per result page — the same minimum the Exa path sends (CLAUDE.md invariant 4).
// Never the conversation, never an identity. No cookies are sent or kept.

/** @typedef {import('../public/js/websearch-backends-core.js').SearchItem} SearchItem */
/** @typedef {import('./types.js').Logger} Logger */

// Bounded like every other outbound call here — a hung SERP must degrade, not
// hold the search wave (which runs a whole batch of queries concurrently).
// This is the budget PER PROVIDER, so a cascade of three cannot spend more
// than the Exa path's own 15 s ceiling by much.
export const SERP_TIMEOUT_MS = 8_000;
// Result pages get a tighter bound: they are enrichment, and one slow page
// must not decide the search's latency.
export const PAGE_TIMEOUT_MS = 8_000;
// Same clamp websearch-backends-core.js applies to every other backend's
// highlights, so synthesis sees one consistent excerpt budget.
export const HIGHLIGHT_MAX_CHARS = 1200;
// How many result pages get fetched for real text, at most. The rest keep
// their SERP snippet — still a usable highlight, just a shorter one.
export const MAX_PAGE_FETCHES = 5;
// Result pages fetched at once. Small on purpose: a search WAVE multiplies
// this by the number of concurrent queries against the subrequest budget.
export const PAGE_CONCURRENCY = 3;
// How many times a THROTTLE interstitial gets followed before giving up on a
// provider. Two, because the sampled recovery curve is steep and then flat:
// one retry carried 3/10 → 9/10, a second mops up the token-acquisition miss,
// and the wait is clamped below, so the whole thing stays inside the caller's
// patience.
export const THROTTLE_RETRIES = 2;
// Ceiling on the wait a throttle interstitial can ask for. Its countdown is
// advisory (and is routinely NEGATIVE, meaning "go now"); a source must not be
// able to park a search wave for a minute by naming a big number.
export const THROTTLE_MAX_WAIT_MS = 2_500;
// How much extracted page text the excerpt scorer will scan. Selecting a
// relevant passage means looking at the whole page rather than clamping to the
// first 1200 characters as this module used to, and a result page can be
// hundreds of kilobytes — times five pages, times every query in a concurrent
// wave. The answer to a research query is not in the 200,000th character.
export const EXCERPT_SCAN_MAX_CHARS = 200_000;
// A provider is asked for more rows than the caller wants, because ranking
// below discards off-topic ones and the surplus is what keeps the result count
// whole after the relevance floor.
export const SERP_OVERFETCH = 2;
// Identify honestly rather than impersonating a browser. (Impersonating one
// does not help anyway — measured above: the anti-bot shell is IP-driven.)
const UA = "Mozilla/5.0 (compatible; DeepResearchBot/1.0; +https://deepresearch.se/)";

// ---- pure HTML/XML helpers ---------------------------------------------------

/**
 * Decodes the entity forms that actually appear in SERP markup and article
 * text. Pure.
 * @param {string} s
 * @returns {string}
 */
export function decodeEntities(s) {
  return String(s)
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&"); // last: an &amp;lt; must not decode twice
}

/**
 * Tags out, entities decoded, whitespace collapsed. Pure.
 * @param {string} s
 * @returns {string}
 */
export function stripTags(s) {
  return decodeEntities(String(s).replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}

// The page furniture that surrounds an article and is never the answer to a
// research query: site navigation, the masthead, the footer, sidebars, search
// forms. Dropping these is what stops an excerpt opening with a menu.
// Non-greedy and self-closing on the same tag name — a stray unbalanced tag
// leaves residue rather than eating the document, which is the safe failure.
const BOILERPLATE_TAGS = /<(nav|header|footer|aside|form)\b[^>]*>[\s\S]*?<\/\1>/gi;
// Reference furniture inside encyclopaedic prose: "[12]" citation markers and
// "[edit]" section links. They survive tag-stripping and, left in, dominate the
// first line of a Wikipedia excerpt.
const CITATION_MARKERS = /\[\s*(?:\d{1,3}|edit|citation needed|källa behövs|redigera)\s*\]/gi;

/**
 * Visible text from a full HTML document: script/style/comments out, page
 * furniture out, the main content region preferred when one carries enough
 * text to be the article. Pure.
 *
 * The furniture strip is not cosmetic. Before it, the first 1200 characters of
 * Wikipedia's "Intermittent fasting" were its language sidebar ("Toggle the
 * table of contents … 30 languages العربية Asturianu …") and WebMD's opened
 * with 230 characters of category menu — and that, not the article, is what
 * synthesis read.
 * @param {string} html
 * @returns {string}
 */
export function pageText(html) {
  let h = String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    // Void tags whose ATTRIBUTES contain ">" — a media query like
    // `media="(min-width >= 40rem)"` defeats the naive `<[^>]*>` strip below,
    // which stops at the ">" INSIDE the quotes and leaks the remainder
    // (`= 40rem)" rel="stylesheet" …`) into the excerpt as if it were prose.
    // Measured on a Discourse forum page. Matching quoted runs explicitly skips
    // over those; the alternatives are disjoint, so there is no backtracking
    // blowup. None of these tags carries visible text, so dropping them whole
    // costs nothing.
    .replace(/<(?:link|meta|base)\b(?:"[^"]*"|'[^']*'|[^"'>])*>/gi, " ");
  for (const tag of ["main", "article"]) {
    const m = h.match(new RegExp("<" + tag + "[^>]*>([\\s\\S]*?)</" + tag + ">", "i"));
    if (m && stripTags(m[1]).length > 200) {
      h = m[1];
      break;
    }
  }
  const full = stripTags(h).replace(CITATION_MARKERS, " ").replace(/\s+/g, " ").trim();
  const trimmed = stripTags(h.replace(BOILERPLATE_TAGS, " "))
    .replace(CITATION_MARKERS, " ")
    .replace(/\s+/g, " ")
    .trim();
  // A page whose whole body sits inside one of those containers would strip to
  // nothing; keep the unstripped text rather than returning an empty excerpt.
  return trimmed.length > 200 || trimmed.length >= full.length ? trimmed : full;
}

// Words that carry no topic and would match every passage. English and Swedish
// together, because queries arrive in both (CLAUDE.md invariant 6) and a
// Swedish query whose every term is a stopword would otherwise score nothing
// and silently fall back to the head of the page.
const STOPWORDS = new Set(
  ("the a an and or of to in for on with is are was were be been being by from as at it its this that these those " +
    "what which who whom how why when where do does did done not no nor if then than so such can could should would " +
    "will shall may might must about over under between into out up down off again further once here there both each " +
    "few more most other some any all i you he she they we us them his her their our your my me " +
    "och att det som en ett för med är av på den till de inte har vi jag om men var kan ska vid där när hur vad vem " +
    "vilka vilken vilket denna dessa deras vår våra er min mitt sin sitt eller också än från under över mellan " +
    "efter före mot utan samt vara blir blev finns göra gör kring"
  ).split(/\s+/),
);

/**
 * The topic-bearing terms of a query, lowercased, de-duplicated and bounded.
 * Everything downstream — passage scoring and result ranking — is "how many of
 * THESE appear". Pure.
 * @param {string} query
 * @returns {string[]}
 */
export function queryTerms(query) {
  /** @type {string[]} */
  const out = [];
  for (const raw of String(query || "").toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    const t = raw.trim();
    if (t.length < 2 || STOPWORDS.has(t) || out.includes(t)) continue;
    out.push(t);
    if (out.length >= 12) break;
  }
  return out;
}

// A bot-check interstitial served as a normal 200 page. Its text is never an
// answer, and letting it through means synthesis cites "Just a moment…" as a
// source.
const CHALLENGE_PATTERNS = [
  /^just a moment/i,
  /enable javascript and cookies to continue/i,
  /checking your browser before accessing/i,
  /verify (?:you are|yourself as) a? ?human/i,
  /please (?:enable|turn on) javascript/i,
  /access denied|attention required/i,
];

/**
 * True when extracted page text is a bot-check / challenge page rather than
 * content. Only applied to SHORT bodies — a real article that happens to
 * mention "access denied" is far longer than any interstitial. Pure.
 * @param {string} text
 * @returns {boolean}
 */
export function isChallengePage(text) {
  const s = String(text || "").trim();
  if (!s || s.length > 600) return false;
  return CHALLENGE_PATTERNS.some((re) => re.test(s));
}

/**
 * Picks the passages of `text` that actually answer `terms`, joined with the
 * same " … " Exa uses between highlights, clamped to `maxChars`.
 *
 * This is the difference between an excerpt and a prefix. Exa returns
 * highlights SELECTED for the query; this backend used to hand synthesis the
 * first 1200 characters of the page, which on a real article is the part
 * before the article. Scoring is distinct-term coverage per sentence — cheap,
 * pure, and enough to move Wikipedia's intermittent-fasting excerpt from its
 * language sidebar to "Preliminary evidence indicates that intermittent
 * fasting may be effective for weight loss…".
 *
 * Degrades to the head of the text when nothing matches, so a query whose
 * terms are absent still yields the SOMETHING that fail-soft requires.
 * @param {string} text
 * @param {string[]} terms
 * @param {number} [maxChars]
 * @returns {string}
 */
export function relevantExcerpt(text, terms, maxChars = HIGHLIGHT_MAX_CHARS) {
  const s = String(text || "").trim().slice(0, EXCERPT_SCAN_MAX_CHARS);
  const cap = Math.max(1, Math.round(maxChars) || HIGHLIGHT_MAX_CHARS);
  if (!s || !terms?.length || s.length <= cap) return s.slice(0, cap);
  const sentences = s.match(/[^.!?]+[.!?]*/g) || [s];
  const scored = sentences.map((body, i) => {
    const lower = body.toLowerCase();
    let hits = 0;
    for (const t of terms) if (lower.includes(t)) hits++;
    return { body, i, hits };
  });
  // Best-first, original order for ties, and each pick pulls in its follower so
  // a matched sentence keeps the clause that continues it.
  const picked = new Set();
  let used = 0;
  for (const cand of [...scored].sort((a, b) => b.hits - a.hits || a.i - b.i)) {
    if (!cand.hits) break;
    for (const i of [cand.i, cand.i + 1]) {
      const sent = scored[i];
      if (!sent || picked.has(i) || used + sent.body.length > cap) continue;
      picked.add(i);
      used += sent.body.length;
    }
    if (used >= cap * 0.9) break;
  }
  if (!picked.size) return s.slice(0, cap);
  // Contiguous picks read as one passage; gaps become Exa's ellipsis.
  const order = [...picked].sort((a, b) => a - b);
  /** @type {string[]} */
  const passages = [];
  /** @type {string[]} */
  let run = [];
  for (let k = 0; k < order.length; k++) {
    run.push(scored[order[k]].body.trim());
    if (k + 1 >= order.length || order[k + 1] !== order[k] + 1) {
      passages.push(run.join(" "));
      run = [];
    }
  }
  return passages.join(" … ").replace(/\s+/g, " ").trim().slice(0, cap);
}

/**
 * How well one result matches the query, from its title, URL and snippet.
 * Title and URL matches count double: a term in the title is a far stronger
 * signal of aboutness than the same term buried in a snippet. Pure.
 * @param {SearchItem} item
 * @param {string[]} terms
 * @returns {number}
 */
export function scoreItem(item, terms) {
  if (!terms?.length) return 0;
  const title = String(item?.title || "").toLowerCase();
  const url = String(item?.url || "").toLowerCase();
  const body = (item?.highlights || []).join(" ").toLowerCase();
  let score = 0;
  for (const t of terms) {
    if (title.includes(t) || url.includes(t)) score += 2;
    else if (body.includes(t)) score += 1;
  }
  return score;
}

/**
 * Orders results by query relevance and applies a RELEVANCE FLOOR: a result
 * matching nothing at all is dropped, but only while at least two matching
 * ones remain. That is the whole bargain — a small independent index answering
 * an unfamiliar query returns near-misses, and passing those to synthesis
 * un-flagged is how a research answer becomes confident nonsense; passing NO
 * sources is worse still, so the floor never empties the list. Stable: equal
 * scores keep the provider's own ranking. Pure.
 * @param {SearchItem[]} items
 * @param {string[]} terms
 * @returns {SearchItem[]}
 */
export function rankItems(items, terms) {
  const list = (items || []).filter((r) => r && r.url);
  if (!terms?.length || list.length < 2) return list;
  const scored = list.map((item, i) => ({ item, i, score: scoreItem(item, terms) }));
  scored.sort((a, b) => b.score - a.score || a.i - b.i);
  const matching = scored.filter((s) => s.score > 0);
  return (matching.length >= 2 ? matching : scored).map((s) => s.item);
}

/**
 * Unwraps a SERP link. DuckDuckGo routes organic results through
 * `//duckduckgo.com/l/?uddg=<encoded real url>`; other providers link straight
 * out. Returns "" for anything that is not an http(s) target. Pure.
 * @param {string} href
 * @returns {string}
 */
export function unwrapSerpHref(href) {
  const m = String(href).match(/[?&]uddg=([^&]+)/);
  if (m) {
    try {
      const decoded = decodeURIComponent(m[1]);
      return /^https?:\/\//i.test(decoded) ? decoded : "";
    } catch {
      return "";
    }
  }
  return /^https?:\/\//i.test(String(href)) ? String(href) : "";
}

/**
 * True for a link that is the SERP's own furniture (its navigation, its
 * redirector, an ad) rather than a result. Each provider passes the host
 * pattern that is "itself". Pure.
 * @param {string} url
 * @param {RegExp} ownHosts
 * @returns {boolean}
 */
function isSerpNoise(url, ownHosts) {
  if (/duckduckgo\.com\/y\.js|ad_provider|ad_domain|\/aclick\?/.test(url)) return true;
  try {
    return ownHosts.test(new URL(url).hostname);
  } catch {
    return true;
  }
}

/**
 * Appends an item if its URL is new and usable. Shared by every parser so
 * dedupe, noise-filtering and the limit behave identically across providers.
 * @param {SearchItem[]} out
 * @param {Set<string>} seen
 * @param {RegExp} ownHosts
 * @param {number} limit
 * @param {string} rawHref
 * @param {string} rawTitle
 * @param {string} rawSnippet
 * @returns {boolean} true once the limit is reached
 */
function pushItem(out, seen, ownHosts, limit, rawHref, rawTitle, rawSnippet) {
  const url = unwrapSerpHref(decodeEntities(rawHref));
  if (!url || seen.has(url) || isSerpNoise(url, ownHosts)) return out.length >= limit;
  const title = stripTags(rawTitle) || url;
  seen.add(url);
  const snippet = stripTags(rawSnippet).slice(0, HIGHLIGHT_MAX_CHARS);
  out.push({ title, url, highlights: snippet ? [snippet] : [] });
  return out.length >= limit;
}

const DDG_HOSTS = /^(?:[a-z0-9-]+\.)*(?:duckduckgo\.com|duck\.co)$/i;
// Both of the engine's own domains: the legacy .nu the search endpoint lives on
// and the marginalia-search.com the About/footer links point at. Missing the
// second let the engine's own pages through as if they were results.
const MARGINALIA_HOSTS = /^(?:[a-z0-9-]+\.)*(?:marginalia\.nu|marginalia-search\.com)$/i;
const BING_HOSTS = /^(?:[a-z0-9-]+\.)*(?:bing\.com|microsoft\.com|msn\.com)$/i;

// ---- one parser per SERP provider --------------------------------------------

/**
 * DuckDuckGo's no-JS HTML: each organic result carries a `result__a` title link
 * and, usually, a `result__snippet`. Pure.
 * @param {string} html
 * @param {number} limit
 * @returns {SearchItem[]}
 */
export function parseDdg(html, limit) {
  /** @type {SearchItem[]} */
  const out = [];
  const seen = new Set();
  for (const block of String(html).split(/class="result\b/).slice(1)) {
    const a =
      block.match(/class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/) ||
      block.match(/href="([^"]+)"[^>]*class="result__a"[^>]*>([\s\S]*?)<\/a>/);
    if (!a) continue;
    const sn =
      block.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/) ||
      block.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/(?:td|div|span)>/);
    if (pushItem(out, seen, DDG_HOSTS, limit, a[1], a[2], sn ? sn[1] : "")) break;
  }
  return out;
}

/**
 * The class-free fallback parse: scan every anchor, keep the outbound ones.
 * Markup classes are the brittle part of SERP scraping, so when the classed
 * parse comes back empty (a layout change, a different endpoint's table
 * markup) this still yields usable results — titles and URLs, no snippets.
 * Pure.
 * @param {string} html
 * @param {number} limit
 * @param {RegExp} [ownHosts]
 * @returns {SearchItem[]}
 */
export function parseSerpAnchors(html, limit, ownHosts = DDG_HOSTS) {
  /** @type {SearchItem[]} */
  const out = [];
  const seen = new Set();
  const re = /<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(String(html)))) {
    if (!stripTags(m[2])) continue; // an icon/image link, not a result
    if (pushItem(out, seen, ownHosts, limit, m[1], m[2], "")) break;
  }
  return out;
}

/**
 * Marginalia's HTML: one `card search-result` section per result, with a
 * `class="title"` link and a `class="description"` paragraph. Pure.
 * @param {string} html
 * @param {number} limit
 * @returns {SearchItem[]}
 */
export function parseMarginalia(html, limit) {
  /** @type {SearchItem[]} */
  const out = [];
  const seen = new Set();
  for (const block of String(html).split(/class="card search-result"/).slice(1)) {
    const a = block.match(/class="title"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    if (!a) continue;
    const sn = block.match(/class="description"[^>]*>([\s\S]*?)<\/p>/);
    if (pushItem(out, seen, MARGINALIA_HOSTS, limit, a[1], a[2], sn ? sn[1] : "")) break;
  }
  return out;
}

/**
 * Bing's RSS output: a well-formed feed of `<item><title/><link/>
 * <description/></item>` — the one source here that is structured data rather
 * than scraped markup. Pure.
 * @param {string} xml
 * @param {number} limit
 * @returns {SearchItem[]}
 */
export function parseRssItems(xml, limit) {
  /** @type {SearchItem[]} */
  const out = [];
  const seen = new Set();
  const re = /<item\b[^>]*>([\s\S]*?)<\/item>/gi;
  let m;
  while ((m = re.exec(String(xml)))) {
    const block = m[1];
    const link = block.match(/<link>([\s\S]*?)<\/link>/i);
    if (!link) continue;
    const title = block.match(/<title>([\s\S]*?)<\/title>/i);
    const desc = block.match(/<description>([\s\S]*?)<\/description>/i);
    if (pushItem(out, seen, BING_HOSTS, limit, link[1].trim(), title ? title[1] : "", desc ? desc[1] : "")) break;
  }
  return out;
}

/**
 * Reads Marginalia's rate-limit interstitial — the HTTP **200** page saying the
 * engine "is currently barraged by queries from bots" — and returns the retry
 * it hands out: a path carrying an `sst` session token, plus its countdown.
 * Returns null for a normal results page. Pure.
 *
 * The countdown is advisory and frequently negative ("go now"); it is clamped
 * by the caller, never trusted. Pure.
 * @param {string} html
 * @returns {{ path: string, waitMs: number } | null}
 */
export function parseMarginaliaThrottle(html) {
  const body = String(html || "");
  if (!/Wait For A Moment|barraged by queries from bots/i.test(body)) return null;
  const link = body.match(/href="(\/search\?[^"]*\bsst=[^"]*)"/i);
  if (!link) return null;
  const countdown = Number((body.match(/data-tr="(-?\d+)"/) || [])[1]);
  return {
    path: decodeEntities(link[1]),
    waitMs: Number.isFinite(countdown) && countdown > 0 ? countdown * 1000 : 0,
  };
}

// ---- the provider table ------------------------------------------------------

/**
 * The SERP providers, in canonical order. `restricted` marks a source whose
 * terms do not obviously cover this use — it is offered but never on by
 * default, and the admin panel states why before an operator enables it.
 * `throttle` reads a source's rate-limit interstitial and returns the retry it
 * offers; `origin` is what such a relative retry path resolves against.
 * @type {{ id: string, label: string, url: (q: string, n: number) => string, parse: (body: string, limit: number) => SearchItem[], fallbackParse?: (body: string, limit: number) => SearchItem[], retryEmpty?: boolean, restricted?: string, origin?: string, throttle?: (body: string) => { path: string, waitMs: number } | null }[]}
 */
export const SERP_PROVIDERS = [
  {
    id: "ddg",
    label: "DuckDuckGo (no-JS HTML)",
    url: (q) => "https://html.duckduckgo.com/html/?q=" + encodeURIComponent(q),
    parse: parseDdg,
    fallbackParse: (body, limit) => parseSerpAnchors(body, limit, DDG_HOSTS),
    // The endpoint intermittently answers with an empty anti-bot shell; one
    // retry after a beat clears it when the caller's IP is welcome at all.
    retryEmpty: true,
  },
  {
    id: "marginalia",
    label: "Marginalia (independent index)",
    url: (q) => "https://old-search.marginalia.nu/search?query=" + encodeURIComponent(q),
    parse: parseMarginalia,
    // Deliberately NO fallbackParse. The class-free anchor scan is insurance
    // against DuckDuckGo's shifting table markup; here the card markup is
    // stable, so the scan only ever ran on a page that HAD no results — and
    // then returned the engine's own About/GitHub/footer links as if they were
    // research sources (measured on a Swedish query the index cannot answer).
    // No results is the honest answer: the cascade moves on, and src/exa.js
    // falls back to Exa from there.
    // Answers a throttled request with 200 + an interstitial rather than a 429
    // (module header). Detected and followed instead of counted as empty.
    origin: "https://old-search.marginalia.nu",
    throttle: parseMarginaliaThrottle,
  },
  {
    id: "bing_rss",
    label: "Bing (RSS output)",
    url: (q) => "https://www.bing.com/search?format=rss&q=" + encodeURIComponent(q),
    parse: parseRssItems,
    restricted:
      "Microsoft's copyright notice on every RSS response restricts these results to rendering in an RSS aggregator for personal, non-commercial use — which a research assistant is not. Enable only if you have permission for your deployment.",
  },
];

// What a site searches with unless an operator says otherwise: the two sources
// whose terms do not stand in the way. Ordered — the cascade stops at the first
// one that returns anything.
export const DEFAULT_SERP_PROVIDERS = ["ddg", "marginalia"];

/**
 * Coerces a configured provider list to known ids, preserving the caller's
 * order, dropping unknowns and duplicates, and falling back to the default
 * list when nothing usable is left. Pure.
 * @param {unknown} value
 * @returns {string[]}
 */
export function normalizeSerpProviders(value) {
  const list = Array.isArray(value) ? value : [];
  /** @type {string[]} */
  const out = [];
  for (const raw of list) {
    const id = typeof raw === "string" ? raw.trim().toLowerCase() : "";
    if (SERP_PROVIDERS.some((p) => p.id === id) && !out.includes(id)) out.push(id);
  }
  return out.length ? out : [...DEFAULT_SERP_PROVIDERS];
}

// ---- the fetching side -------------------------------------------------------

/** @param {Logger} [log] @returns {Required<Logger>} a log that never throws */
function safeLog(log) {
  const noop = () => {};
  return {
    debug: log?.debug || noop,
    info: log?.info || noop,
    warn: log?.warn || noop,
    error: log?.error || noop,
  };
}

/**
 * Runs one provider: fetch, parse, fall back to the class-free parse, and (for
 * a provider that says so) retry an empty body once. Returns [] rather than
 * throwing, which is what makes the cascade above it trivial.
 * @param {Logger} log
 * @param {typeof SERP_PROVIDERS[number]} provider
 * @param {string} query
 * @param {number} limit
 * @param {typeof fetch} doFetch
 * @returns {Promise<SearchItem[]>}
 */
async function runProvider(log, provider, query, limit, doFetch) {
  let url = provider.url(query, limit);
  // Budget: the empty-body retry the provider asks for, plus the throttle
  // follows. Both are bounded, and a throttle follow does not consume the
  // empty-body retry — they are different failures.
  let emptyRetries = provider.retryEmpty ? 1 : 0;
  let throttleRetries = provider.throttle ? THROTTLE_RETRIES : 0;
  let throttled = 0;
  for (;;) {
    let resp;
    try {
      resp = await doFetch(url, {
        headers: { "user-agent": UA, accept: "text/html,application/xhtml+xml,application/rss+xml,application/xml" },
        signal: AbortSignal.timeout(SERP_TIMEOUT_MS),
      });
    } catch (err) {
      safeLog(log).warn("search.cf_serp_failed", {
        provider: provider.id,
        error: String(/** @type {any} */ (err)?.message || err),
      });
      return [];
    }
    if (!resp.ok) {
      safeLog(log).warn("search.cf_serp_error", { provider: provider.id, status: resp.status });
      return [];
    }
    const body = await resp.text().catch(() => "");

    // A throttle interstitial is a 200 with no results and a way back in.
    // Follow it before concluding anything about the index.
    const throttle = provider.throttle?.(body) || null;
    if (throttle) {
      if (throttleRetries <= 0) {
        safeLog(log).warn("search.cf_serp_throttled", { provider: provider.id, gave_up: true, attempts: throttled });
        return [];
      }
      throttleRetries--;
      throttled++;
      safeLog(log).debug("search.cf_serp_throttled", { provider: provider.id, attempt: throttled });
      const wait = Math.max(0, Math.min(THROTTLE_MAX_WAIT_MS, throttle.waitMs));
      if (wait) await new Promise((r) => setTimeout(r, wait));
      try {
        url = new URL(throttle.path, provider.origin || url).toString();
      } catch {
        return [];
      }
      continue;
    }

    const rows = provider.parse(body, limit);
    if (rows.length) {
      if (throttled) safeLog(log).debug("search.cf_serp_throttle_recovered", { provider: provider.id, attempts: throttled });
      return rows;
    }
    if (provider.fallbackParse) {
      const anchors = provider.fallbackParse(body, limit);
      if (anchors.length) {
        safeLog(log).warn("search.cf_serp_fallback_parse", { provider: provider.id, results: anchors.length });
        return anchors;
      }
    }
    // DuckDuckGo's datacenter anti-bot shell is a 202 and is TERMINAL — every
    // measured retry returned the same shell. Spending the beat plus a second
    // round trip on it taxes every query in every wave for nothing, so the
    // retry is reserved for a 200 that merely came back empty.
    if (emptyRetries > 0 && resp.status !== 202) {
      emptyRetries--;
      await new Promise((r) => setTimeout(r, 800));
      continue;
    }
    break;
  }
  // Reached from a 2xx that carried no results: an anti-bot shell, a
  // challenge page, or a genuinely empty query. Indistinguishable from here,
  // and the answer is the same either way — try the next provider.
  safeLog(log).warn("search.cf_serp_empty", { provider: provider.id });
  return [];
}

/**
 * The cascade: try each configured provider in order, MERGING results until the
 * limit is met. A provider that answers no longer ends the cascade if it
 * answered thinly — two results from one small index is a worse foundation for
 * research than two plus four from the next source, and the extra request is
 * only ever paid when the first source came up short. Deduped by URL, and the
 * providers that contributed are reported in order. Never throws.
 * @param {Logger} log
 * @param {string} query
 * @param {number} limit
 * @param {typeof fetch} [doFetch] injectable for tests
 * @param {string[]} [providers] configured provider ids, in order
 * @returns {Promise<{ items: SearchItem[], provider: string }>}
 */
export async function serpSearch(log, query, limit, doFetch = fetch, providers = DEFAULT_SERP_PROVIDERS) {
  /** @type {SearchItem[]} */
  const merged = [];
  const seen = new Set();
  /** @type {string[]} */
  const used = [];
  for (const id of normalizeSerpProviders(providers)) {
    const provider = SERP_PROVIDERS.find((p) => p.id === id);
    if (!provider) continue;
    const items = await runProvider(log, provider, query, limit, doFetch).catch(() => []);
    if (!items.length) continue;
    let added = 0;
    for (const item of items) {
      if (seen.has(item.url)) continue;
      seen.add(item.url);
      merged.push(item);
      added++;
    }
    if (added) used.push(id);
    if (merged.length >= limit) break;
  }
  return { items: merged.slice(0, limit), provider: used.join(",") };
}

/**
 * Fetches one result page and extracts the excerpt that answers `terms`.
 * Fail-soft to "" — a page that will not load, is not text, or turns out to be
 * a bot-check interstitial leaves the SERP snippet standing as the highlight.
 * @param {string} url
 * @param {typeof fetch} [doFetch]
 * @param {string[]} [terms] query terms the excerpt should be about
 * @returns {Promise<string>}
 */
export async function fetchExcerpt(url, doFetch = fetch, terms = []) {
  try {
    const resp = await doFetch(url, {
      redirect: "follow",
      headers: { "user-agent": UA, accept: "text/html,application/xhtml+xml" },
      signal: AbortSignal.timeout(PAGE_TIMEOUT_MS),
    });
    if (!resp.ok) return "";
    const type = resp.headers.get("content-type") || "";
    if (!/html|text\//i.test(type)) return ""; // a PDF/binary: the snippet stands
    const text = pageText(await resp.text());
    // A challenge page answers 200 with real-looking text. Citing it as a
    // source is worse than having no excerpt at all.
    if (isChallengePage(text)) return "";
    return relevantExcerpt(text, terms, HIGHLIGHT_MAX_CHARS);
  } catch {
    return "";
  }
}

/**
 * Runs `fn` over `items` with at most `limit` in flight. Small local pool —
 * Promise.all over every result page at once is what blows a subrequest budget.
 * @template T, R
 * @param {T[]} items
 * @param {number} limit
 * @param {(item: T, index: number) => Promise<R>} fn
 * @returns {Promise<R[]>}
 */
async function mapPool(items, limit, fn) {
  /** @type {R[]} */
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i], i);
      }
    }),
  );
  return out;
}

/**
 * One Cloudflare-originating search: the SERP cascade, then (unless `pages` is
 * off) real text excerpts for the top results. Returns null when nothing was
 * found, so the caller can fall back — never throws.
 * @param {Logger} log
 * @param {string} query
 * @param {number} limit
 * @param {{ pages?: boolean, providers?: string[], doFetch?: typeof fetch }} [opts]
 * @returns {Promise<SearchItem[] | null>}
 */
export async function cloudflareSearch(log, query, limit, opts = {}) {
  const q = String(query || "").trim();
  if (!q) return null;
  const n = Math.min(20, Math.max(1, Math.round(limit) || 6));
  const doFetch = opts.doFetch || fetch;
  const terms = queryTerms(q);
  // Over-fetch so the relevance floor has something to discard: asking for
  // exactly n and then dropping the off-topic ones would return fewer sources
  // than the budget planned for.
  const want = Math.min(20, n + SERP_OVERFETCH);
  const { items, provider } = await serpSearch(log, q, want, doFetch, opts.providers || DEFAULT_SERP_PROVIDERS);
  if (!items.length) return null;
  // Rank BEFORE the slice, so the page-fetch budget below is spent on the
  // results most likely to be worth quoting rather than on whatever the index
  // happened to list first.
  const ranked = rankItems(items, terms).slice(0, n);
  safeLog(log).debug("search.cf_serp", { provider, results: ranked.length, dropped: items.length - ranked.length });
  if (opts.pages === false) return ranked;

  // Enrich the top results with page text. Everything below MAX_PAGE_FETCHES
  // keeps its SERP snippet — a shorter highlight, not a missing result.
  const top = ranked.slice(0, MAX_PAGE_FETCHES);
  const excerpts = await mapPool(top, PAGE_CONCURRENCY, (item) => fetchExcerpt(item.url, doFetch, terms));
  let enriched = 0;
  for (let i = 0; i < top.length; i++) {
    const text = excerpts[i];
    if (text && text.length > (top[i].highlights[0]?.length || 0)) {
      top[i].highlights = [text];
      enriched++;
    }
  }
  safeLog(log).debug("search.cf_pages", { fetched: top.length, enriched });
  return ranked;
}
