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
  cloudflareSearch,
  decodeEntities,
  fetchExcerpt,
  looksLikeResultSet,
  normalizeSerpProviders,
  pageText,
  parseDdg,
  parseMarginalia,
  parseRssItems,
  parseSerpAnchors,
  serpSearch,
  stripChromeRegions,
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

// ---- the no-results SERP (feedback #48) --------------------------------------
//
// Marginalia answers a query it has nothing for with a full page of chrome and
// an empty results section. The classed parse finds nothing, and the class-free
// fallback used to scrape the masthead and footer: the engine's own about and
// donate pages (on marginalia-search.com, which the marginalia.nu own-host
// filter did not cover), its GitHub issues, its Twitter profile, the IP
// database it credits, and the CC licence. All six reached synthesis as the
// sources for a watch question. The markup below is that page's shape.
const NO_RESULTS_SERP = `<html><body>
  <header>
    <a href="https://about.marginalia-search.com/">About</a>
    <nav>
      <a href="https://about.marginalia-search.com/article/supporting/">Donate</a>
      <a href="https://old-search.marginalia.nu/explore/random">Random</a>
    </nav>
  </header>
  <section id="results"><p>Nothing found. Consider
    <a href="https://github.com/MarginaliaSearch/MarginaliaSearch/issues">submitting an issue on GitHub</a>.</p>
  </section>
  <footer>
    <section id="legal">
      <a href="https://twitter.com/MarginaliaNu">@MarginaliaNu</a>
      <a href="https://lite.ip2location.com/">Free IP Geolocation Database</a>
      <a href="https://creativecommons.org/licenses/by-sa/4.0/">CC-BY-SA 4.0</a>
    </section>
  </footer>
</body></html>`;

test("stripChromeRegions drops the masthead and footer, keeps the results region", () => {
  const body = stripChromeRegions(NO_RESULTS_SERP);
  assert.ok(body.includes('id="results"'));
  for (const gone of ["about.marginalia-search.com", "twitter.com", "creativecommons.org", "ip2location"]) {
    assert.ok(!body.includes(gone), `${gone} should not survive the chrome strip`);
  }
});

test("looksLikeResultSet: a real result set clears the floor, page leftovers do not", () => {
  const item = (url) => ({ title: url, url, highlights: [] });
  assert.equal(looksLikeResultSet([]), false);
  assert.equal(looksLikeResultSet([item("https://a.com/1"), item("https://b.com/2")]), false); // too few
  // Enough links, but all from one host — a site's own navigation, not results.
  assert.equal(
    looksLikeResultSet([item("https://a.com/1"), item("https://a.com/2"), item("https://a.com/3")]),
    false,
  );
  assert.equal(
    looksLikeResultSet([item("https://a.com/1"), item("https://b.com/2"), item("https://c.com/3")]),
    true,
  );
});

test("a no-results SERP yields no sources rather than its own chrome (feedback #48)", async () => {
  const warned = [];
  const log = { ...noopLog, warn: (event) => warned.push(event) };
  const out = await cloudflareSearch(log, "wd1863 dial swap reddit", 6, {
    pages: false,
    providers: ["marginalia"],
    doFetch: async () => htmlResponse(NO_RESULTS_SERP),
  });
  // null, not a list of the engine's about/donate/licence links: the caller
  // (src/exa.js) falls back to Exa from here instead of synthesising over
  // sources that have nothing to do with the question.
  assert.equal(out, null);
  assert.ok(warned.includes("search.cf_serp_fallback_rejected"));
  assert.ok(warned.includes("search.cf_serp_empty"));
});

test("the own-host filter covers both of Marginalia's domains", () => {
  const marginalia = SERP_PROVIDERS.find((p) => p.id === "marginalia");
  const rows = marginalia.fallbackParse(
    `<a href="https://about.marginalia-search.com/">About</a>
     <a href="https://www.marginalia.nu/">Marginalia</a>
     <a href="https://example.com/a">A</a>
     <a href="https://example.org/b">B</a>
     <a href="https://example.net/c">C</a>`,
    10,
  );
  assert.deepEqual(rows.map((r) => r.url), [
    "https://example.com/a",
    "https://example.org/b",
    "https://example.net/c",
  ]);
});

test("the class-free fallback still rescues a real SERP whose markup changed", async () => {
  // The case the fallback exists for: results are there, the classes are not.
  const changed = `<html><body><header><a href="https://about.marginalia-search.com/">About</a></header>
    <section id="results">
      <a href="https://example.com/one">One</a>
      <a href="https://example.org/two">Two</a>
      <a href="https://example.net/three">Three</a>
    </section></body></html>`;
  const out = await cloudflareSearch(noopLog, "q", 6, {
    pages: false,
    providers: ["marginalia"],
    doFetch: async () => htmlResponse(changed),
  });
  assert.deepEqual(out.map((r) => r.url), [
    "https://example.com/one",
    "https://example.org/two",
    "https://example.net/three",
  ]);
});

// ---- the fetching side -------------------------------------------------------

test("serpSearch retries DuckDuckGo's empty anti-bot shell once, then parses", async () => {
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

test("serpSearch falls back to the anchor scan when the classed markup changes", async () => {
  const doFetch = async () =>
    htmlResponse(
      "<table>" +
        ["https://example.com/x", "https://example.org/y", "https://example.net/z"]
          .map((u) => `<tr><td><a href="${u}">${u}</a></td></tr>`)
          .join("") +
        "</table>",
    );
  const r = await serpSearch(noopLog, "q", 5, doFetch, ["ddg"]);
  assert.deepEqual(r.items.map((x) => x.url), [
    "https://example.com/x",
    "https://example.org/y",
    "https://example.net/z",
  ]);
});

test("a single stray anchor is not a rescued layout — it is a page with no results", async () => {
  // The cost the feedback #48 floor accepts, stated as a test so it is a
  // decision rather than a surprise: a genuinely one-result SERP whose classes
  // ALSO changed is dropped, and the cascade moves on to the next provider (or
  // to Exa). Believing it is how six chrome links became sources.
  const doFetch = async () => htmlResponse('<table><tr><td><a href="https://example.com/x">X</a></td></tr></table>');
  const r = await serpSearch(noopLog, "q", 5, doFetch, ["ddg"]);
  assert.deepEqual(r.items, []);
  assert.equal(r.provider, "");
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
  assert.equal(seen.filter((u) => u.includes("duckduckgo")).length, 2); // tried, retried, moved on
});

test("serpSearch stops at the first provider that returns anything", async () => {
  const seen = [];
  const doFetch = async (url) => {
    seen.push(String(url));
    return htmlResponse(serpBlock("Hit", "https://example.com/hit", "s"));
  };
  const r = await serpSearch(noopLog, "q", 5, doFetch, ["ddg", "marginalia", "bing_rss"]);
  assert.equal(r.provider, "ddg");
  assert.equal(seen.length, 1); // no needless requests to the rest
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
    fetched.push(String(url));
    return htmlResponse(`<body><main><p>${"Full page text for " + url + ". "}${"pad ".repeat(80)}</p></main></body>`);
  };

  const items = await cloudflareSearch(noopLog, "a question", 5, { doFetch });
  assert.equal(items.length, 2);
  assert.deepEqual(fetched, ["https://example.com/1", "https://example.org/2"]);
  assert.ok(items[0].highlights[0].startsWith("Full page text for https://example.com/1."));
  assert.ok(items[1].highlights[0].startsWith("Full page text for https://example.org/2."));
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
    pageFetches++;
    return htmlResponse("<body>never read</body>");
  };
  const items = await cloudflareSearch(noopLog, "q", 5, { doFetch, pages: false });
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
