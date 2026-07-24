#!/usr/bin/env node
// DeepResearch.Se/cure — LOCAL BROWSING AGENT (single file, no dependencies).
//
// A tiny web-search service that runs on YOUR machine. The Se/cure tier calls
// it straight from the browser (Settings → Web search service → Exa-compatible
// → http://localhost:8099), so research queries go browser → this process →
// the open web. No query ever touches deepresearch.se or a hosted search
// provider's retention.
//
// Get it + run it (Node 18+; Mac, Linux or Windows):
//   curl -fsSL https://deepresearch.se/cure/local-search/agent.mjs -o agent.mjs && node agent.mjs
//
// Wire shape (Exa-compatible — public/js/websearch-backends-core.js):
//   POST /search   {query, numResults}  →  {results:[{title,url,highlights}]}
//   GET  /search?q=…                       (same JSON — handy for eyeballing)
//   GET  /healthz                          {ok, engine, version}
//
// Engines (ENGINE env):
//   serp        DuckDuckGo result titles + snippets only. Fastest, no page loads.
//   browse      (default) serp + fetches the top pages and extracts real text
//               excerpts, so synthesis quotes the page, not just the snippet.
//   playwright  like browse but renders pages in headless Chromium (JS-heavy
//               sites). Needs: npm i playwright && npx playwright install chromium
//   searxng     proxies a SearXNG instance you run (SEARXNG_URL env), adding
//               the CORS headers + Exa wire the browser-direct call needs.
//
// Env: PORT=8099  API_KEY= (optional; require x-api-key)  ALLOW_ORIGIN=*
//      ENGINE=browse  SEARXNG_URL=  PAGE_FETCH_CONCURRENCY=3
//
// Privacy posture: binds 127.0.0.1 by default (HOST env to change). Only the
// query string reaches the search engine; nothing is logged to disk.

import http from "node:http";

const VERSION = "1";
const PORT = Number(process.env.PORT || 8099);
const HOST = process.env.HOST || "127.0.0.1";
const API_KEY = process.env.API_KEY || "";
const ALLOW_ORIGIN = process.env.ALLOW_ORIGIN || "*";
const SEARXNG_URL = (process.env.SEARXNG_URL || "").replace(/\/+$/, "");
const ENGINE = (process.env.ENGINE || (SEARXNG_URL ? "searxng" : "browse")).toLowerCase();
const PAGE_CONCURRENCY = Math.max(1, Number(process.env.PAGE_FETCH_CONCURRENCY) || 3);
const SERP_TIMEOUT_MS = 12_000;
const PAGE_TIMEOUT_MS = 8_000;
const HIGHLIGHT_MAX_CHARS = 1200; // websearch-backends-core.js clamps here too
const UA = "Mozilla/5.0 (compatible; DeepResearchLocalAgent/" + VERSION + ")";

// ---- tiny HTML helpers (good enough for SERP + article text, no deps) -------

const decodeEntities = (s) =>
  s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ");

const stripTags = (s) => decodeEntities(s.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();

// Visible text from a full HTML document, preferring the main content region.
function pageText(html) {
  let h = html
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

async function fetchWithTimeout(url, ms, opts = {}) {
  return fetch(url, {
    redirect: "follow",
    ...opts,
    headers: { "user-agent": UA, accept: "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8", ...(opts.headers || {}) },
    signal: AbortSignal.timeout(ms),
  });
}

// ---- SERP: DuckDuckGo's no-JS HTML endpoint ---------------------------------

// DDG wraps result links as //duckduckgo.com/l/?uddg=<encoded real url>&…
function ddgHref(href) {
  const m = href.match(/[?&]uddg=([^&]+)/);
  if (m) {
    try {
      return decodeURIComponent(m[1]);
    } catch {
      return "";
    }
  }
  return /^https?:\/\//.test(href) ? href : "";
}

function parseDdgSerp(html, limit) {
  const out = [];
  const seen = new Set();
  // Each organic result: <a … class="result__a" href="…">Title</a> … and a
  // sibling <a class="result__snippet" …>snippet</a> within the same block.
  const blocks = html.split(/class="result\b/).slice(1);
  for (const block of blocks) {
    const a = block.match(/class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/) || block.match(/href="([^"]+)"[^>]*class="result__a"[^>]*>([\s\S]*?)<\/a>/);
    if (!a) continue;
    const url = ddgHref(decodeEntities(a[1]));
    if (!url || seen.has(url)) continue;
    // DDG keeps ad rows under y.js / ad_provider redirects — skip them.
    if (/duckduckgo\.com\/y\.js|ad_provider/.test(a[1])) continue;
    seen.add(url);
    const sn = block.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/) || block.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/(?:td|div|span)>/);
    out.push({ title: stripTags(a[2]) || url, url, snippet: sn ? stripTags(sn[1]) : "" });
    if (out.length >= limit) break;
  }
  return out;
}

async function ddgSerp(query, limit) {
  const u = "https://html.duckduckgo.com/html/?q=" + encodeURIComponent(query);
  // DDG intermittently answers with an empty anti-bot shell page; one retry
  // after a beat usually passes (observed while building this).
  for (let attempt = 0; ; attempt++) {
    const resp = await fetchWithTimeout(u, SERP_TIMEOUT_MS);
    if (!resp.ok) throw new Error("SERP fetch failed: HTTP " + resp.status);
    const rows = parseDdgSerp(await resp.text(), limit);
    if (rows.length || attempt >= 1) return rows;
    await new Promise((r) => setTimeout(r, 800));
  }
}

// ---- highlight extraction: plain fetch or a real (Playwright) browser -------

async function fetchHighlight(url) {
  try {
    const resp = await fetchWithTimeout(url, PAGE_TIMEOUT_MS);
    const type = resp.headers.get("content-type") || "";
    if (!resp.ok || !/html|text/.test(type)) return "";
    return pageText(await resp.text()).slice(0, HIGHLIGHT_MAX_CHARS);
  } catch {
    return ""; // fail-soft: the snippet still carries the result
  }
}

let browserPromise = null; // one shared Chromium across requests (ENGINE=playwright)
async function getBrowser() {
  if (!browserPromise) {
    browserPromise = (async () => {
      const { chromium } = await import("playwright");
      return chromium.launch({ headless: true, args: ["--no-sandbox"] });
    })();
  }
  return browserPromise;
}

async function renderHighlight(url) {
  let page;
  try {
    const browser = await getBrowser();
    page = await browser.newPage({ userAgent: UA });
    await page.route("**/*", (r) =>
      ["image", "media", "font"].includes(r.request().resourceType()) ? r.abort() : r.continue(),
    );
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: PAGE_TIMEOUT_MS });
    const text = await page.evaluate(() => {
      for (const sel of ["main", "article", "body"]) {
        const el = document.querySelector(sel);
        if (el && el.innerText && el.innerText.trim().length > 200) return el.innerText;
      }
      return document.body ? document.body.innerText : "";
    });
    return String(text || "").replace(/\s+/g, " ").trim().slice(0, HIGHLIGHT_MAX_CHARS);
  } catch {
    return "";
  } finally {
    if (page) await page.close().catch(() => {});
  }
}

// Small worker pool so N result pages don't all load at once.
async function mapPool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

// ---- the engines ------------------------------------------------------------

async function searchSerpOnly(query, limit) {
  const rows = await ddgSerp(query, limit);
  return rows.map((r) => ({ title: r.title, url: r.url, highlights: r.snippet ? [r.snippet] : [] }));
}

async function searchBrowse(query, limit, render) {
  const rows = await ddgSerp(query, limit);
  const texts = await mapPool(rows, PAGE_CONCURRENCY, (r) => (render ? renderHighlight(r.url) : fetchHighlight(r.url)));
  return rows.map((r, i) => {
    const highlights = [];
    if (texts[i]) highlights.push(texts[i]);
    // Keep the snippet too when it adds context the page text may bury.
    if (r.snippet && !texts[i]) highlights.push(r.snippet);
    return { title: r.title, url: r.url, highlights };
  });
}

async function searchSearxng(query, limit) {
  if (!SEARXNG_URL) throw new Error("SEARXNG_URL is not set");
  const u = SEARXNG_URL + "/search?q=" + encodeURIComponent(query) + "&format=json&safesearch=0";
  const resp = await fetchWithTimeout(u, SERP_TIMEOUT_MS, { headers: { accept: "application/json" } });
  if (!resp.ok) throw new Error("SearXNG HTTP " + resp.status + " (is `json` in search.formats?)");
  const data = await resp.json();
  const rows = Array.isArray(data?.results) ? data.results : [];
  return rows.slice(0, limit).map((r) => ({
    title: String(r?.title || r?.url || "").trim(),
    url: String(r?.url || "").trim(),
    highlights: r?.content ? [String(r.content).slice(0, HIGHLIGHT_MAX_CHARS)] : [],
  })).filter((r) => r.url);
}

async function runSearch(query, limit) {
  if (ENGINE === "searxng") return searchSearxng(query, limit);
  if (ENGINE === "serp") return searchSerpOnly(query, limit);
  if (ENGINE === "playwright") return searchBrowse(query, limit, true);
  return searchBrowse(query, limit, false); // "browse", the default
}

// ---- the HTTP server --------------------------------------------------------

const CORS = {
  "access-control-allow-origin": ALLOW_ORIGIN,
  "access-control-allow-headers": "content-type, x-api-key, authorization",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  // Chrome's Private Network Access preflight: a public HTTPS page calling
  // localhost must be answered with this or the browser refuses the request.
  "access-control-allow-private-network": "true",
};

function send(res, code, obj) {
  res.writeHead(code, { "content-type": "application/json; charset=utf-8", ...CORS });
  res.end(JSON.stringify(obj));
}

async function handleSearch(res, query, numResults) {
  const q = String(query || "").trim().slice(0, 400);
  if (!q) return send(res, 400, { error: "query required" });
  const limit = Math.min(20, Math.max(1, Math.round(Number(numResults) || 6)));
  const t0 = Date.now();
  try {
    const results = (await runSearch(q, limit)).filter((r) => r && r.url);
    console.log(`[search] ${JSON.stringify(q)} → ${results.length} results in ${Date.now() - t0} ms (${ENGINE})`);
    send(res, 200, { results });
  } catch (err) {
    console.error("[search] failed:", err?.message || err);
    send(res, 502, { error: String(err?.message || err) });
  }
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://" + (req.headers.host || "localhost"));
  if (req.method === "OPTIONS") {
    res.writeHead(204, CORS);
    return res.end();
  }
  if (req.method === "GET" && url.pathname === "/healthz") {
    return send(res, 200, { ok: true, engine: ENGINE, version: VERSION });
  }
  if (API_KEY && req.headers["x-api-key"] !== API_KEY && req.headers.authorization !== "Bearer " + API_KEY) {
    return send(res, 403, { error: "bad or missing API key" });
  }
  if (req.method === "GET" && url.pathname === "/search") {
    return handleSearch(res, url.searchParams.get("q") || url.searchParams.get("query"), url.searchParams.get("numResults"));
  }
  if (req.method === "POST" && url.pathname === "/search") {
    let body = "";
    req.on("data", (c) => {
      body += c;
      if (body.length > 65536) req.destroy();
    });
    req.on("end", () => {
      let parsed;
      try {
        parsed = JSON.parse(body || "{}");
      } catch {
        return send(res, 400, { error: "bad json" });
      }
      handleSearch(res, parsed.query, parsed.numResults);
    });
    return;
  }
  send(res, 404, { error: "not found — POST /search, GET /search?q=…, GET /healthz" });
});

server.listen(PORT, HOST, () => {
  console.log(`Local browsing agent listening on http://${HOST === "0.0.0.0" ? "localhost" : HOST}:${PORT}  (engine: ${ENGINE})`);
  console.log("");
  console.log("Point DeepResearch.Se/cure at it:");
  console.log("  Settings → Web search service → backend: Exa-compatible — your service");
  console.log(`  Service URL: http://localhost:${PORT}` + (API_KEY ? "   (plus your API key)" : ""));
  console.log("");
  console.log(`Try it:  curl -s 'http://localhost:${PORT}/search?q=test'`);
});
