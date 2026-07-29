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
// FAIL-SOFT, like every helper phase (CLAUDE.md invariant 2): a blocked SERP,
// an anti-bot shell, a timeout, or a page that will not load all degrade —
// the next provider, empty highlights, null from the backend — never an error
// out of the search wave. src/exa.js falls back to Exa from there when a key
// exists and `fallback_exa` is on.
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

/**
 * Visible text from a full HTML document, preferring the main content region
 * when one carries enough text to be the article. Pure.
 * @param {string} html
 * @returns {string}
 */
export function pageText(html) {
  let h = String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");
  for (const tag of ["main", "article"]) {
    const m = h.match(new RegExp("<" + tag + "[^>]*>([\\s\\S]*?)</" + tag + ">", "i"));
    if (m && stripTags(m[1]).length > 200) {
      h = m[1];
      break;
    }
  }
  return stripTags(h);
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
// Marginalia is served from BOTH of its operator's domains: the search
// endpoint on marginalia.nu, the about/donate pages the SERP chrome links to
// on marginalia-search.com. Matching only the first let the second through the
// own-host filter as if it were a result (feedback #48).
const MARGINALIA_HOSTS = /^(?:[a-z0-9-]+\.)*(?:marginalia\.nu|marginalia-search\.com)$/i;
const BING_HOSTS = /^(?:[a-z0-9-]+\.)*(?:bing\.com|microsoft\.com|msn\.com)$/i;

// The page regions that are the SERP's furniture rather than its results.
// Stripped before the class-free anchor scan below: a link in the masthead or
// the footer is navigation, funding, a social profile or a license notice, and
// is never something the query found.
const CHROME_REGION = /<(header|footer|nav|aside)\b[^>]*>[\s\S]*?<\/\1>/gi;

/**
 * Drops the chrome regions from a SERP document, leaving the part of the page
 * that can carry results. Pure.
 * @param {string} html
 * @returns {string}
 */
export function stripChromeRegions(html) {
  return String(html).replace(CHROME_REGION, " ");
}

// The floor the class-free parse must clear to be believed. It exists to tell
// the two cases it otherwise cannot distinguish apart: a SERP whose markup
// changed (many results, many hosts — still worth keeping) versus a SERP with
// NO results, whose few surviving links are stray chrome (feedback #48, where
// six such links reached synthesis as "sources"). A real result page clears
// this comfortably; a no-results page does not.
export const MIN_FALLBACK_ITEMS = 3;
export const MIN_FALLBACK_HOSTS = 2;

/**
 * Whether a class-free anchor parse looks like an actual result set rather
 * than the leftovers of a page that found nothing. Pure.
 * @param {SearchItem[]} items
 * @returns {boolean}
 */
export function looksLikeResultSet(items) {
  if (!Array.isArray(items) || items.length < MIN_FALLBACK_ITEMS) return false;
  const hosts = new Set();
  for (const item of items) {
    try {
      hosts.add(new URL(item.url).hostname.toLowerCase());
    } catch {
      /* an unparseable URL simply contributes no host */
    }
  }
  return hosts.size >= MIN_FALLBACK_HOSTS;
}

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
 * The class-free fallback parse: scan every anchor OUTSIDE the page's chrome,
 * keep the outbound ones. Markup classes are the brittle part of SERP
 * scraping, so when the classed parse comes back empty (a layout change, a
 * different endpoint's table markup) this still yields usable results —
 * titles and URLs, no snippets.
 *
 * The chrome strip is what keeps it honest. Every SERP carries outbound links
 * that are not results — the engine's about and donate pages, its social
 * profile, the license of the data it credits — and on a page that found
 * NOTHING those are the only links left to scrape. Six of them were once
 * handed to synthesis as the sources for a watch question (feedback #48). They
 * live in the masthead and the footer; results do not. Pure.
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
  const body = stripChromeRegions(html);
  while ((m = re.exec(body))) {
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

// ---- the provider table ------------------------------------------------------

/**
 * The SERP providers, in canonical order. `restricted` marks a source whose
 * terms do not obviously cover this use — it is offered but never on by
 * default, and the admin panel states why before an operator enables it.
 * @type {{ id: string, label: string, url: (q: string, n: number) => string, parse: (body: string, limit: number) => SearchItem[], fallbackParse?: (body: string, limit: number) => SearchItem[], retryEmpty?: boolean, restricted?: string }[]}
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
    fallbackParse: (body, limit) => parseSerpAnchors(body, limit, MARGINALIA_HOSTS),
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
  const url = provider.url(query, limit);
  const attempts = provider.retryEmpty ? 2 : 1;
  for (let attempt = 0; attempt < attempts; attempt++) {
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
    const rows = provider.parse(body, limit);
    if (rows.length) return rows;
    if (provider.fallbackParse) {
      const anchors = provider.fallbackParse(body, limit);
      // Believed only when it looks like a result set. A handful of stray
      // links on a page that found nothing is not an unrecognised layout —
      // it is a no-results page, and passing it on invents sources.
      if (looksLikeResultSet(anchors)) {
        safeLog(log).warn("search.cf_serp_fallback_parse", { provider: provider.id, results: anchors.length });
        return anchors;
      }
      if (anchors.length) {
        safeLog(log).warn("search.cf_serp_fallback_rejected", { provider: provider.id, anchors: anchors.length });
      }
    }
    if (attempt + 1 < attempts) await new Promise((r) => setTimeout(r, 800));
  }
  // Reached from a 2xx that carried no results: an anti-bot shell, a
  // challenge page, or a genuinely empty query. Indistinguishable from here,
  // and the answer is the same either way — try the next provider.
  safeLog(log).warn("search.cf_serp_empty", { provider: provider.id });
  return [];
}

/**
 * The cascade: try each configured provider in order, stop at the first that
 * returns results. Never throws.
 * @param {Logger} log
 * @param {string} query
 * @param {number} limit
 * @param {typeof fetch} [doFetch] injectable for tests
 * @param {string[]} [providers] configured provider ids, in order
 * @returns {Promise<{ items: SearchItem[], provider: string }>}
 */
export async function serpSearch(log, query, limit, doFetch = fetch, providers = DEFAULT_SERP_PROVIDERS) {
  for (const id of normalizeSerpProviders(providers)) {
    const provider = SERP_PROVIDERS.find((p) => p.id === id);
    if (!provider) continue;
    const items = await runProvider(log, provider, query, limit, doFetch).catch(() => []);
    if (items.length) return { items, provider: id };
  }
  return { items: [], provider: "" };
}

/**
 * Fetches one result page and extracts a text excerpt. Fail-soft to "" — the
 * SERP snippet already on the item stays as the highlight.
 * @param {string} url
 * @param {typeof fetch} [doFetch]
 * @returns {Promise<string>}
 */
export async function fetchExcerpt(url, doFetch = fetch) {
  try {
    const resp = await doFetch(url, {
      redirect: "follow",
      headers: { "user-agent": UA, accept: "text/html,application/xhtml+xml" },
      signal: AbortSignal.timeout(PAGE_TIMEOUT_MS),
    });
    if (!resp.ok) return "";
    const type = resp.headers.get("content-type") || "";
    if (!/html|text\//i.test(type)) return ""; // a PDF/binary: the snippet stands
    return pageText(await resp.text()).slice(0, HIGHLIGHT_MAX_CHARS);
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
  const { items, provider } = await serpSearch(log, q, n, doFetch, opts.providers || DEFAULT_SERP_PROVIDERS);
  if (!items.length) return null;
  safeLog(log).debug("search.cf_serp", { provider, results: items.length });
  if (opts.pages === false) return items;

  // Enrich the top results with page text. Everything below MAX_PAGE_FETCHES
  // keeps its SERP snippet — a shorter highlight, not a missing result.
  const top = items.slice(0, MAX_PAGE_FETCHES);
  const excerpts = await mapPool(top, PAGE_CONCURRENCY, (item) => fetchExcerpt(item.url, doFetch));
  let enriched = 0;
  for (let i = 0; i < top.length; i++) {
    const text = excerpts[i];
    if (text && text.length > (top[i].highlights[0]?.length || 0)) {
      top[i].highlights = [text];
      enriched++;
    }
  }
  safeLog(log).debug("search.cf_pages", { fetched: top.length, enriched });
  return items;
}
