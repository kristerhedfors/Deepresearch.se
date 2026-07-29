// Unit tests for the Cloudflare-originating web-search backend
// (src/websearch-cf.js): the pure HTML/SERP parsers and the fail-soft fetch
// pipeline over an injected fetch. No network, no Exa, no Worker runtime —
// the whole module is plain fetch + string work precisely so it tests here.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_SERP_PROVIDERS,
  HIGHLIGHT_MAX_CHARS,
  SERP_PROVIDERS,
  THROTTLE_RETRIES,
  cloudflareSearch,
  decodeEntities,
  fetchExcerpt,
  isChallengePage,
  normalizeSerpProviders,
  pageText,
  parseDdg,
  parseMarginalia,
  parseMarginaliaThrottle,
  parseRssItems,
  parseSerpAnchors,
  queryTerms,
  rankItems,
  relevantExcerpt,
  scoreItem,
  serpSearch,
  stripTags,
  unwrapSerpHref,
} from "./websearch-cf.js";

const noopLog = { debug() {}, info() {}, warn() {}, error() {} };

/** A minimal Response stand-in for the injected fetch. */
function htmlResponse(body, { ok = true, status = 200, type = "text/html; charset=utf-8" } = {}) {
  return {
    ok,
    status,
    headers: { get: (h) => (h.toLowerCase() === "content-type" ? type : null) },
    text: async () => body,
  };
}

/** Builds one classed SERP result block the way the no-JS endpoint does. */
function serpBlock(title, target, snippet) {
  const href = "//duckduckgo.com/l/?uddg=" + encodeURIComponent(target) + "&amp;rut=abc";
  return `<div class="result results_links">
    <h2 class="result__title"><a class="result__a" href="${href}">${title}</a></h2>
    <a class="result__snippet" href="${href}">${snippet}</a>
  </div>`;
}

/** One Marginalia result card. */
function marginaliaBlock(title, target, description) {
  return `<section data-ms-rank="5" class="card search-result">
    <div class="url"><a rel="nofollow external" href="${target}">${target}</a></div>
    <h2> <a tabindex="-1" class="title" rel="nofollow external" href="${target}">${title}</a> </h2>
    <p class="description">${description}</p>
  </section>`;
}

/** Marginalia's rate-limit interstitial: HTTP 200, no results, a retry token. */
function throttleBody(query, countdown = -57) {
  return `<html lang="en-US"><head><title>Error</title></head><body>
    <div class="infobox">
      <h1>Wait For A Moment</h1>
      <p>The search engine is currently barraged by queries from bots</p>
      <p>Please wait for <b id="countdown" data-tr="${countdown}">${countdown}</b> seconds. If your browser supports it,
       it will refresh on its own. Otherwise, you can use
       <a href="/search?query=${encodeURIComponent(query)}&amp;sst=S-abc123">this link</a> to manually proceed.
    </div>
  </body></html>`;
}

/** One RSS <item>, the shape Bing's feed output emits. */
function rssItem(title, target, description) {
  return `<item><title>${title}</title><link>${target}</link>` +
    `<description>${description}</description><pubDate>Fri, 24 Jul 2026 12:36:00 GMT</pubDate></item>`;
}

// ---- pure helpers ------------------------------------------------------------

test("decodeEntities decodes named, decimal and hex forms without double-decoding", () => {
  assert.equal(decodeEntities("caf&eacute;"), "caf&eacute;"); // unknown name left alone
  assert.equal(decodeEntities("A&#66;C"), "ABC");
  assert.equal(decodeEntities("&#x41;&#x42;"), "AB");
  assert.equal(decodeEntities("a &amp; b"), "a & b");
  assert.equal(decodeEntities("&quot;q&quot; &#39;s&#39;"), "\"q\" 's'");
  // &amp; is decoded LAST so an escaped entity stays escaped rather than
  // decoding twice into a tag character.
  assert.equal(decodeEntities("&amp;lt;script&amp;gt;"), "&lt;script&gt;");
});

test("stripTags removes markup and collapses whitespace", () => {
  assert.equal(stripTags("<b>Hello</b>\n  <i>world</i>"), "Hello world");
  assert.equal(stripTags("<a href='#'>x</a>&amp;y"), "x &y");
});

test("pageText drops script/style/comments and prefers a substantial <main>", () => {
  const filler = "Real article text. ".repeat(20); // > 200 chars
  const html = `<html><head><style>.a{color:red}</style></head>
    <body><nav>Nav junk</nav><script>var x = "<main>fake</main>";</script>
    <!-- a comment --><main><p>${filler}</p></main><footer>Footer junk</footer></body></html>`;
  const text = pageText(html);
  assert.ok(text.startsWith("Real article text."));
  assert.ok(!text.includes("Nav junk"));
  assert.ok(!text.includes("Footer junk"));
  assert.ok(!text.includes("color:red"));
  assert.ok(!text.includes("a comment"));
});

test("pageText keeps the whole document when <main> is too thin to be the article", () => {
  const html = "<body><main>tiny</main><p>The actual body copy lives out here.</p></body>";
  const text = pageText(html);
  assert.ok(text.includes("The actual body copy lives out here."));
});

test("pageText drops the page furniture that used to BE the excerpt", () => {
  // The measured failure: Wikipedia's first 1200 characters were its language
  // sidebar, so synthesis read a list of language names instead of the article.
  const html =
    "<body><header>Site masthead</header>" +
    "<nav>Toggle the table of contents 30 languages Deutsch Español Français 日本語</nav>" +
    "<p>Preliminary evidence indicates that intermittent fasting may be effective. [12] " +
    "It is studied for metabolic health.[edit] " +
    "pad ".repeat(60) +
    "</p><footer>Privacy policy</footer></body>";
  const text = pageText(html);
  assert.ok(text.startsWith("Preliminary evidence indicates"), text.slice(0, 80));
  assert.ok(!text.includes("Toggle the table of contents"));
  assert.ok(!text.includes("Site masthead"));
  assert.ok(!text.includes("Privacy policy"));
  assert.ok(!/\[\s*12\s*\]|\[edit\]/.test(text)); // citation furniture out too
});

test("pageText keeps the text when the whole body sits inside stripped furniture", () => {
  // Stripping must never be able to return an empty excerpt.
  const html = "<body><nav>" + "The entire article is nested in here. ".repeat(20) + "</nav></body>";
  assert.ok(pageText(html).includes("The entire article is nested in here."));
});

test("pageText does not leak stylesheet attributes containing '>' into the text", () => {
  const html =
    '<body><link rel="stylesheet" media="(min-width >= 40rem)" href="/a.css" />' +
    "<p>The article body is the only visible text here. " + "pad ".repeat(60) + "</p></body>";
  const text = pageText(html);
  assert.ok(text.startsWith("The article body is the only visible text here."), text.slice(0, 80));
  assert.ok(!text.includes("40rem"));
});

test("Marginalia has no anchor fallback — its own pages must never become results", () => {
  // Measured: on a query the index cannot answer, the class-free anchor scan
  // returned the engine's About and GitHub links as research sources.
  const marginalia = SERP_PROVIDERS.find((p) => p.id === "marginalia");
  assert.equal(marginalia.fallbackParse, undefined);
  // …and the host filter now covers both of the engine's own domains.
  const noise = parseSerpAnchors(
    '<a href="https://about.marginalia-search.com/">About</a><a href="https://old-search.marginalia.nu/x">X</a>' +
      '<a href="https://example.com/real">Real</a>',
    5,
    /^(?:[a-z0-9-]+\.)*(?:marginalia\.nu|marginalia-search\.com)$/i,
  );
  assert.deepEqual(noise.map((r) => r.url), ["https://example.com/real"]);
});

test("queryTerms keeps topic words and drops English AND Swedish stopwords", () => {
  assert.deepEqual(queryTerms("What are the health effects of intermittent fasting?"), [
    "health",
    "effects",
    "intermittent",
    "fasting",
  ]);
  // Swedish parity: a Swedish query must not reduce to nothing and fall back to
  // the head of the page (CLAUDE.md invariant 6).
  assert.deepEqual(queryTerms("Vad är hälsoeffekterna av periodisk fasta?"), [
    "hälsoeffekterna",
    "periodisk",
    "fasta",
  ]);
  assert.deepEqual(queryTerms(""), []);
  assert.equal(queryTerms("a b c d e f g h i j k l m n o p q r s t u v").length <= 12, true);
});

test("relevantExcerpt selects the passages about the query, not the page's prefix", () => {
  const text =
    "Navigation and boilerplate lead the page. " +
    "Subscribe to our newsletter for updates. " +
    "Preliminary evidence indicates that intermittent fasting may reduce insulin resistance. " +
    "Unrelated filler about the weather. ".repeat(10) +
    "Researchers continue to study fasting and metabolic health.";
  const out = relevantExcerpt(text, ["intermittent", "fasting", "insulin"], 200);
  assert.ok(out.includes("Preliminary evidence indicates"), out);
  assert.ok(!out.startsWith("Navigation and boilerplate"), out);
  assert.ok(out.length <= 200);
});

test("relevantExcerpt joins non-adjacent passages with Exa's ellipsis", () => {
  const filler = "Filler sentence with nothing to say. ".repeat(10);
  const text = `Fasting improves markers. ${filler} Fasting also affects sleep.`;
  const out = relevantExcerpt(text, ["fasting"], 120);
  assert.ok(out.includes(" … "), out);
  assert.ok(out.includes("Fasting improves markers.") && out.includes("Fasting also affects sleep."), out);
});

test("relevantExcerpt degrades to the head when nothing matches, and never expands", () => {
  const text = "A page about something else entirely. ".repeat(50);
  assert.ok(relevantExcerpt(text, ["quantum", "chromodynamics"], 100).startsWith("A page about"));
  assert.equal(relevantExcerpt("short text", ["absent"], 500), "short text");
  assert.equal(relevantExcerpt("", ["x"], 500), "");
  assert.equal(relevantExcerpt(null, ["x"], 500), "");
});

test("isChallengePage flags a bot-check body but not a long article that mentions one", () => {
  assert.equal(isChallengePage("Just a moment..."), true);
  assert.equal(isChallengePage("Enable JavaScript and cookies to continue"), true);
  assert.equal(isChallengePage("Checking your browser before accessing the site"), true);
  assert.equal(isChallengePage(""), false);
  assert.equal(isChallengePage("An essay on access denied errors. " + "pad ".repeat(200)), false);
});

test("scoreItem weights title and URL matches above snippet matches", () => {
  const terms = ["fasting"];
  assert.equal(scoreItem({ title: "Fasting", url: "https://x.test/a", highlights: [] }, terms), 2);
  assert.equal(scoreItem({ title: "Diet", url: "https://x.test/fasting", highlights: [] }, terms), 2);
  assert.equal(scoreItem({ title: "Diet", url: "https://x.test/a", highlights: ["about fasting"] }, terms), 1);
  assert.equal(scoreItem({ title: "Diet", url: "https://x.test/a", highlights: [] }, terms), 0);
  assert.equal(scoreItem({ title: "Fasting", url: "https://x.test/a", highlights: [] }, []), 0);
});

test("rankItems orders by relevance and drops what matches nothing", () => {
  const items = [
    { title: "Unrelated blog", url: "https://x.test/weather", highlights: ["nothing to do with it"] },
    { title: "Notes", url: "https://x.test/n", highlights: ["a page mentioning fasting once"] },
    { title: "Intermittent fasting", url: "https://en.wikipedia.org/wiki/Intermittent_fasting", highlights: [] },
  ];
  const ranked = rankItems(items, ["intermittent", "fasting"]);
  assert.deepEqual(ranked.map((r) => r.title), ["Intermittent fasting", "Notes"]);
});

test("rankItems never empties the list — no sources is worse than weak ones", () => {
  const items = [
    { title: "A", url: "https://x.test/a", highlights: [] },
    { title: "B", url: "https://x.test/b", highlights: [] },
  ];
  assert.equal(rankItems(items, ["absent"]).length, 2);
  assert.equal(rankItems([items[0]], ["absent"]).length, 1);
  assert.deepEqual(rankItems(items, []), items); // no terms: provider order stands
});

test("parseMarginaliaThrottle reads the interstitial's retry link and countdown", () => {
  const t = parseMarginaliaThrottle(throttleBody("eu ai act", 3));
  assert.equal(t.path, "/search?query=eu%20ai%20act&sst=S-abc123"); // &amp; decoded
  assert.equal(t.waitMs, 3000);
  // A negative countdown means "go now", not "wait forever".
  assert.equal(parseMarginaliaThrottle(throttleBody("q", -57)).waitMs, 0);
  // A normal results page is not a throttle.
  assert.equal(parseMarginaliaThrottle(marginaliaBlock("A", "https://x.test/a", "s")), null);
  assert.equal(parseMarginaliaThrottle(""), null);
});

test("unwrapSerpHref unwraps the redirector, passes direct links, rejects the rest", () => {
  assert.equal(
    unwrapSerpHref("//duckduckgo.com/l/?uddg=" + encodeURIComponent("https://example.com/a?b=1") + "&rut=x"),
    "https://example.com/a?b=1",
  );
  assert.equal(unwrapSerpHref("https://example.com/direct"), "https://example.com/direct");
  assert.equal(unwrapSerpHref("/settings"), "");
  assert.equal(unwrapSerpHref("javascript:alert(1)"), "");
  // A redirector wrapping a non-http target is not a result either.
  assert.equal(unwrapSerpHref("//duckduckgo.com/l/?uddg=" + encodeURIComponent("javascript:alert(1)")), "");
  // Malformed percent-encoding degrades to "" rather than throwing.
  assert.equal(unwrapSerpHref("//duckduckgo.com/l/?uddg=%E0%A4%A"), "");
});

test("parseDdg reads title/url/snippet, dedupes, skips ads, and honors the limit", () => {
  const html = [
    serpBlock("First &amp; best", "https://example.com/1", "A <b>snippet</b> with markup"),
    serpBlock("Dup", "https://example.com/1", "same url again"),
    // An ad row: the redirector goes through y.js, never a real target.
    '<div class="result result--ad"><a class="result__a" href="//duckduckgo.com/y.js?ad_provider=x">Ad</a></div>',
    serpBlock("Second", "https://example.org/2", "Another snippet"),
    serpBlock("Third", "https://example.net/3", "Third snippet"),
  ].join("\n");

  const all = parseDdg(html, 10);
  assert.deepEqual(all.map((r) => r.url), [
    "https://example.com/1",
    "https://example.org/2",
    "https://example.net/3",
  ]);
  assert.equal(all[0].title, "First & best");
  assert.deepEqual(all[0].highlights, ["A snippet with markup"]);

  assert.equal(parseDdg(html, 2).length, 2);
  assert.deepEqual(parseDdg("<html><body>nothing here</body></html>", 5), []);
});

test("parseSerpAnchors is the class-free fallback: outbound links only, no SERP furniture", () => {
  const html = `<a href="/settings">Settings</a>
    <a href="https://duckduckgo.com/about">About DDG</a>
    <a href="//duckduckgo.com/l/?uddg=${encodeURIComponent("https://example.com/a")}">Example A</a>
    <a href="https://example.org/b"><img src="i.png"></a>
    <a href="https://example.org/b">Example B</a>
    <a href="https://example.net/c">Example C</a>`;
  const rows = parseSerpAnchors(html, 10);
  assert.deepEqual(rows.map((r) => r.url), [
    "https://example.com/a",
    "https://example.org/b",
    "https://example.net/c",
  ]);
  assert.deepEqual(rows.map((r) => r.title), ["Example A", "Example B", "Example C"]);
  assert.deepEqual(rows[0].highlights, []); // no snippets on the fallback path
});

// ---- the fetching side -------------------------------------------------------

test("serpSearch retries an empty 200 once, then parses", async () => {
  let calls = 0;
  const doFetch = async () => {
    calls++;
    return htmlResponse(calls === 1 ? "<html><body></body></html>" : serpBlock("Hit", "https://example.com/hit", "s"));
  };
  const r = await serpSearch(noopLog, "q", 5, doFetch, ["ddg"]);
  assert.equal(calls, 2);
  assert.equal(r.provider, "ddg");
  assert.deepEqual(r.items.map((x) => x.url), ["https://example.com/hit"]);
});

test("serpSearch does NOT spend the retry on DuckDuckGo's terminal 202 shell", async () => {
  // Measured: every retry of the datacenter anti-bot shell returns the same
  // shell, so the beat plus the second round trip taxed every query in every
  // wave for nothing. A 202 is terminal; only a plain empty 200 is retried.
  let calls = 0;
  const doFetch = async () => {
    calls++;
    return htmlResponse("<html><body></body></html>", { status: 202 });
  };
  const r = await serpSearch(noopLog, "q", 5, doFetch, ["ddg"]);
  assert.equal(calls, 1);
  assert.deepEqual(r.items, []);
});

test("serpSearch follows a throttle interstitial's retry link instead of calling it empty", async () => {
  // The reported quality bug: Marginalia answers a rate-limited request with
  // HTTP 200 and "Wait For A Moment", which parsed as zero results and ended
  // the cascade — so most queries in a wave returned no sources at all.
  const seen = [];
  const doFetch = async (url) => {
    seen.push(String(url));
    if (!String(url).includes("sst=")) return htmlResponse(throttleBody("q"));
    return htmlResponse(marginaliaBlock("M", "https://example.org/m", "the result behind the throttle"));
  };
  const r = await serpSearch(noopLog, "q", 5, doFetch, ["marginalia"]);
  assert.deepEqual(r.items.map((x) => x.url), ["https://example.org/m"]);
  assert.equal(seen.length, 2);
  // The retry is the interstitial's OWN link, resolved against the provider.
  assert.ok(seen[1].startsWith("https://old-search.marginalia.nu/search?query=q&sst=S-abc123"));
});

test("serpSearch gives up on a throttle that never clears, without throwing", async () => {
  let calls = 0;
  const doFetch = async () => {
    calls++;
    return htmlResponse(throttleBody("q"));
  };
  const r = await serpSearch(noopLog, "q", 5, doFetch, ["marginalia"]);
  assert.deepEqual(r.items, []);
  assert.equal(calls, THROTTLE_RETRIES + 1); // the original plus its bounded follows
});

test("serpSearch falls back to the anchor scan when the classed markup changes", async () => {
  const doFetch = async () => htmlResponse('<table><tr><td><a href="https://example.com/x">X</a></td></tr></table>');
  const r = await serpSearch(noopLog, "q", 5, doFetch, ["ddg"]);
  assert.deepEqual(r.items.map((x) => x.url), ["https://example.com/x"]);
});

test("serpSearch cascades past a blocked provider to the next one", async () => {
  // The measured reality this cascade exists for: DuckDuckGo answers a
  // datacenter IP with an empty 202 shell, so the second provider is what
  // actually returns results.
  const seen = [];
  const doFetch = async (url) => {
    seen.push(String(url));
    if (String(url).includes("duckduckgo")) return htmlResponse("<html><body></body></html>", { status: 202 });
    return htmlResponse(marginaliaBlock("M", "https://example.org/m", "from the independent index"));
  };
  const r = await serpSearch(noopLog, "q", 5, doFetch, ["ddg", "marginalia"]);
  assert.equal(r.provider, "marginalia");
  assert.deepEqual(r.items.map((x) => x.url), ["https://example.org/m"]);
  assert.equal(seen.filter((u) => u.includes("duckduckgo")).length, 1); // 202 is terminal, moved on
});

test("serpSearch stops as soon as the limit is met", async () => {
  const seen = [];
  const doFetch = async (url) => {
    seen.push(String(url));
    return htmlResponse([
      serpBlock("A", "https://example.com/a", "s"),
      serpBlock("B", "https://example.com/b", "s"),
    ].join("\n"));
  };
  const r = await serpSearch(noopLog, "q", 2, doFetch, ["ddg", "marginalia", "bing_rss"]);
  assert.equal(r.provider, "ddg");
  assert.equal(seen.length, 1); // no needless requests to the rest
});

test("serpSearch MERGES a thin provider with the next instead of settling for it", async () => {
  // Two results from one small index is a worse foundation for research than
  // two plus the next source's — and the extra request is only paid when the
  // first source came up short.
  const doFetch = async (url) => {
    if (String(url).includes("duckduckgo")) return htmlResponse(serpBlock("A", "https://example.com/a", "one"));
    return htmlResponse([
      marginaliaBlock("B", "https://example.org/b", "two"),
      // A URL the first provider already returned must not appear twice.
      marginaliaBlock("A again", "https://example.com/a", "dup"),
      marginaliaBlock("C", "https://example.net/c", "three"),
    ].join("\n"));
  };
  const r = await serpSearch(noopLog, "q", 5, doFetch, ["ddg", "marginalia"]);
  assert.deepEqual(r.items.map((x) => x.url), [
    "https://example.com/a",
    "https://example.org/b",
    "https://example.net/c",
  ]);
  assert.equal(r.provider, "ddg,marginalia"); // both contributed, in order
});

test("serpSearch is fail-soft on a throw, a non-2xx, and a persistently empty cascade", async () => {
  const empty = { items: [], provider: "" };
  assert.deepEqual(
    await serpSearch(noopLog, "q", 5, async () => {
      throw new Error("blocked");
    }),
    empty,
  );
  assert.deepEqual(await serpSearch(noopLog, "q", 5, async () => htmlResponse("", { ok: false, status: 403 })), empty);
  assert.deepEqual(await serpSearch(noopLog, "q", 5, async () => htmlResponse("<html></html>")), empty);
});

test("fetchExcerpt extracts and clamps page text, and degrades to '' otherwise", async () => {
  const long = "word ".repeat(2000);
  const text = await fetchExcerpt("https://example.com/a", async () => htmlResponse(`<body><p>${long}</p></body>`));
  assert.equal(text.length, HIGHLIGHT_MAX_CHARS);

  assert.equal(await fetchExcerpt("https://x/", async () => htmlResponse("x", { ok: false, status: 500 })), "");
  // A PDF (or any non-text body) is not parsed as HTML — the SERP snippet stands.
  assert.equal(await fetchExcerpt("https://x/a.pdf", async () => htmlResponse("%PDF", { type: "application/pdf" })), "");
  assert.equal(
    await fetchExcerpt("https://x/", async () => {
      throw new Error("timeout");
    }),
    "",
  );
});

test("cloudflareSearch upgrades SERP snippets to real page excerpts", async () => {
  const serp = [
    serpBlock("One", "https://example.com/1", "short snippet"),
    serpBlock("Two", "https://example.org/2", "another short snippet"),
  ].join("\n");
  /** @type {string[]} */
  const fetched = [];
  const doFetch = async (url) => {
    if (String(url).includes("duckduckgo.com/html")) return htmlResponse(serp);
    if (String(url).includes("marginalia")) return htmlResponse("<html><body>no results</body></html>");
    fetched.push(String(url));
    return htmlResponse(`<body><main><p>${"Full page text for " + url + ". "}${"pad ".repeat(80)}</p></main></body>`);
  };

  const items = await cloudflareSearch(noopLog, "a question", 2, { doFetch });
  assert.equal(items.length, 2);
  assert.deepEqual(fetched, ["https://example.com/1", "https://example.org/2"]);
  assert.ok(items[0].highlights[0].startsWith("Full page text for https://example.com/1."));
  assert.ok(items[1].highlights[0].startsWith("Full page text for https://example.org/2."));
});

test("fetchExcerpt returns the query-relevant passage, not the page's opening", async () => {
  const body =
    "<body><nav>Menu Home About Contact</nav><p>" +
    "Introductory throat-clearing that answers nothing. ".repeat(20) +
    "The CPU limit for a Worker on the paid plan is five minutes. " +
    "More filler after the fact. ".repeat(20) +
    "</p></body>";
  const text = await fetchExcerpt("https://x.test/a", async () => htmlResponse(body), ["cpu", "limit", "worker"]);
  assert.ok(text.includes("The CPU limit for a Worker on the paid plan is five minutes."), text.slice(0, 120));
  assert.ok(!text.includes("Menu Home About Contact"));
});

test("fetchExcerpt refuses a bot-check page served as a normal 200", async () => {
  // Citing "Just a moment…" as a source is worse than having no excerpt.
  const text = await fetchExcerpt("https://x.test/a", async () => htmlResponse("<body><h1>Just a moment...</h1></body>"), ["cpu"]);
  assert.equal(text, "");
});

test("cloudflareSearch keeps the SERP snippet when a page won't load", async () => {
  const doFetch = async (url) => {
    if (String(url).includes("duckduckgo.com/html")) {
      return htmlResponse(serpBlock("One", "https://example.com/1", "the snippet that must survive"));
    }
    throw new Error("connection reset");
  };
  const items = await cloudflareSearch(noopLog, "q", 5, { doFetch });
  assert.deepEqual(items[0].highlights, ["the snippet that must survive"]);
});

test("cloudflareSearch skips page fetches entirely when pages are off", async () => {
  let pageFetches = 0;
  const doFetch = async (url) => {
    if (String(url).includes("duckduckgo.com/html")) {
      return htmlResponse(serpBlock("One", "https://example.com/1", "snippet only"));
    }
    if (String(url).includes("marginalia")) return htmlResponse("<html><body>no results</body></html>");
    pageFetches++;
    return htmlResponse("<body>never read</body>");
  };
  const items = await cloudflareSearch(noopLog, "q", 1, { doFetch, pages: false });
  assert.equal(pageFetches, 0);
  assert.deepEqual(items[0].highlights, ["snippet only"]);
});

test("cloudflareSearch returns null (never throws) when there is nothing to return", async () => {
  assert.equal(await cloudflareSearch(noopLog, "   ", 5, { doFetch: async () => htmlResponse("") }), null);
  assert.equal(
    await cloudflareSearch(noopLog, "q", 5, {
      doFetch: async () => {
        throw new Error("no network");
      },
    }),
    null,
  );
});

test("parseMarginalia reads the card markup and dedupes", () => {
  const html = "<section id=results>" + [
    marginaliaBlock("CRISPR", "https://en.wikipedia.org/wiki/CRISPR", "A family of DNA sequences"),
    marginaliaBlock("Dup", "https://en.wikipedia.org/wiki/CRISPR", "same url"),
    // The engine's own navigation is not a result.
    '<section class="card search-result"><h2><a class="title" href="https://old-search.marginalia.nu/about">About</a></h2></section>',
    marginaliaBlock("Second", "https://example.org/2", "Another description"),
  ].join("\n") + "</section>";
  const rows = parseMarginalia(html, 10);
  assert.deepEqual(rows.map((r) => r.url), ["https://en.wikipedia.org/wiki/CRISPR", "https://example.org/2"]);
  assert.equal(rows[0].title, "CRISPR");
  assert.deepEqual(rows[0].highlights, ["A family of DNA sequences"]);
  assert.equal(parseMarginalia(html, 1).length, 1);
});

test("parseRssItems reads a feed's items and decodes their entities", () => {
  const xml = "<rss><channel><title>Bing: q</title><link>https://www.bing.com/search?q=q</link>" +
    rssItem("Cleveland Clinic &amp; CRISPR", "https://health.clevelandclinic.org/crispr-gene-editing", "A &quot;gene editing&quot; strategy") +
    rssItem("Wikipedia", "https://en.m.wikipedia.org/wiki/CRISPR_gene_editing", "An acronym") +
    "</channel></rss>";
  const rows = parseRssItems(xml, 10);
  assert.deepEqual(rows.map((r) => r.url), [
    "https://health.clevelandclinic.org/crispr-gene-editing",
    "https://en.m.wikipedia.org/wiki/CRISPR_gene_editing",
  ]);
  assert.equal(rows[0].title, "Cleveland Clinic & CRISPR");
  assert.deepEqual(rows[0].highlights, ['A "gene editing" strategy']);
  // The channel's own <link> sits outside any <item> and must not become a result.
  assert.ok(!rows.some((r) => r.url.includes("bing.com")));
});

test("the provider table's defaults exclude every terms-restricted source", () => {
  assert.deepEqual(DEFAULT_SERP_PROVIDERS, ["ddg", "marginalia"]);
  for (const id of DEFAULT_SERP_PROVIDERS) {
    const p = SERP_PROVIDERS.find((x) => x.id === id);
    assert.ok(p, `${id} is a real provider`);
    assert.ok(!p.restricted, `${id} must not be restricted to be a default`);
  }
  // A restricted provider still ships — it just has to be chosen knowingly,
  // and must say why in a sentence an operator can act on.
  const bing = SERP_PROVIDERS.find((p) => p.id === "bing_rss");
  assert.ok(bing.restricted && bing.restricted.length > 40);
});

test("normalizeSerpProviders keeps order, drops junk, and never returns nothing", () => {
  assert.deepEqual(normalizeSerpProviders(["marginalia", "ddg"]), ["marginalia", "ddg"]);
  assert.deepEqual(normalizeSerpProviders(["ddg", "ddg", "nope", 7, null]), ["ddg"]);
  // An empty or unusable configuration falls back rather than searching nothing.
  for (const bad of [[], ["nope"], null, undefined, "ddg", {}]) {
    assert.deepEqual(normalizeSerpProviders(bad), DEFAULT_SERP_PROVIDERS);
  }
  // …and the fallback is a copy, so a caller mutating it can't poison the default.
  normalizeSerpProviders([]).push("bing_rss");
  assert.deepEqual(DEFAULT_SERP_PROVIDERS, ["ddg", "marginalia"]);
});

test("cloudflareSearch honors a configured provider list", async () => {
  const seen = [];
  const doFetch = async (url) => {
    seen.push(String(url));
    return htmlResponse("<rss><channel>" + rssItem("R", "https://example.com/r", "d") + "</channel></rss>");
  };
  const items = await cloudflareSearch(noopLog, "q", 3, { doFetch, pages: false, providers: ["bing_rss"] });
  assert.deepEqual(items.map((i) => i.url), ["https://example.com/r"]);
  assert.ok(seen[0].includes("bing.com"));
  assert.ok(!seen.some((u) => u.includes("duckduckgo")));
});
