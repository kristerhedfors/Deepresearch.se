---
name: local-web-search
description: >-
  Load when standing up your OWN web-search service as an alternative to Exa —
  "run our own search", "replace Exa", "self-hosted search", "SearXNG",
  "Playwright search service", "point web search at my server" — or when
  touching the pluggable search backend (src/websearch-backends.js, the
  `search` block in src/config.js, the exa.js backend routing, the admin
  "Web search service" panel in public/js/admin.js / public/admin/index.html,
  or the SHIPPED local-browsing-agent surface: the one-liner setup page
  public/cure/local-search/ + its hosted dependency-free agent.mjs, reached
  by hovering/long-pressing Se/cure's web knob).
  Ships ready-to-run recipes (the hosted agent.mjs one-liner, SearXNG, a
  Playwright crawler exposing an Exa-compatible API, and other alternatives),
  how to make each drop into the config page, and the privacy rationale
  (self-hosting keeps search queries off a third party's retention — the
  project's mission).
---

# Run your own web-search service (an Exa alternative)

The research pipeline's web search is **pluggable**. It ships defaulting to
**Exa** (`src/exa.js`), but the provider is a configured choice: an admin can
point the site at their OWN self-hosted search service on the **Web search
service** panel (`/admin`). This skill is the playbook for standing that
service up.

**Why self-host.** Exa is not zero-data-retention on the standard plan (see the
integrations skill / `/help` "Sensitive topics"). The project's mission is
pushing a real research assistant toward *provable* privacy; a self-hosted
search backend is the code side of that — the short AI-derived query never
reaches a third party's retention. Only the query string ever leaves the
Worker either way (never the conversation), but a self-hosted backend removes
the third party entirely.

## How the backend seam works

- **`src/websearch-backends.js`** — the adapters. Two self-hosted shapes:
  - `"searxng"` — a SearXNG instance's JSON API (`GET {base}/search?q=…&format=json`).
  - `"exa_compatible"` — anything speaking Exa's own wire
    (`POST {base}/search`, `x-api-key`, `{results:[{title,url,highlights}]}`).
  Both are **fail-soft**: a misconfigured/unreachable backend returns `null`.
- **`src/config.js`** — the `search` block: `{ backend, base_url, results,
  fallback_exa }`. Default `backend:"exa"`, so an unconfigured site is
  unchanged. Edited via `PUT /api/admin/config` from the admin panel.
- **`src/exa.js`** `webSearch()` — resolves the backend, runs it, and on any
  failure falls back to Exa when `fallback_exa` is on AND `EXA_API_KEY` exists.
  The result shape (`content`/`items`/`sources`/`resultCount`) is identical for
  every backend, so the pipeline and synthesis read them the same way.
- **Secrets, not config:** the auth token comes from the `SEARCH_BACKEND_KEY`
  Worker secret; an optional `SEARCH_BACKEND_URL` secret overrides the stored
  base URL. Neither is ever stored in the admin-editable D1 config. Set them
  with `npx wrangler secret put SEARCH_BACKEND_KEY`.
- **Verify it live:** the admin panel's **Test search** button runs one real
  search through the configured backend (`POST /api/admin/search/test`) and
  shows the backend used, result count, timing, and sources. Do this before
  relying on a new service. Also watch Workers Logs for `search.backend_hit` /
  `search.backend_error` / `search.backend_fallback_exa`.

`contents`/full-text fetch (`fetchContents`, budget-gated top tier) stays
Exa-only for now — it degrades to empty (fail-soft) on a self-hosted backend,
so synthesis proceeds on the highlights it already has. If you need full-text
on a self-hosted backend, add a `/contents` route to your service and extend
`fetchContents` the same adapter way.

## Two tiers configure it two different ways

The adapters + parsers + dispatch are ONE shared pure core,
**`public/js/websearch-backends-core.js`** (the `bash-core.js` /
`introspect-core.js` arrangement) — it lives under `public/` so BOTH the Worker
bundler and the browser can import it. Each tier configures a backend its own
way:

- **Se/rver (DRS)** — an **admin, server-wide** setting. `src/websearch-backends.js`
  is a thin façade over the core adding the env-aware `resolveSearchBackend`;
  the admin picks ONE backend for the whole server on the `/admin` **Web search
  service** panel, and `src/exa.js` routes every search through it (Exa
  fallback on failure). The service is called from the WORKER, so no CORS is
  needed.

- **Se/cure (DRC)** — a **per-user, expert** setting, because Se/cure is the
  interface for people who know what they're doing. The **Web search service**
  section in the `/cure` settings drawer (`public/cure/drc.js`
  `renderSearchBackend`) lets each user point web search at their OWN
  self-hosted service. The browser calls it **directly** (`drcDirectWebSearch`
  → the shared core's `runBackendSearch`) — no query touches Deepresearch's
  server at all, which is *stronger* than the server grant (that routes through
  the server's Exa key). The config (URL + optional key + results) is stored
  **inside the sealed project state** (`searchBackend` in `drc-core.js`), like
  the provider keys — the server never sees it.
  - **CORS is required.** A browser-direct call needs the service to send
    `Access-Control-Allow-Origin` (and answer the preflight). The settings
    popover spells this out; it's the expert's responsibility. SearXNG:
    `search.formats` must include `json` and the instance must allow the
    origin. The Playwright service (Recipe 2) needs
    `res.setHeader("Access-Control-Allow-Origin", "*")` + an `OPTIONS`
    handler.
  - **Priority in `send()`:** a configured browser-direct backend wins over the
    server grant, which wins over nothing (offline harvest). All fail-soft.
  - **Providers must be CORS-capable anyway** in DRC (OpenAI/Groq/Berget), so a
    CORS-enabled search service fits the tier's existing constraint.

---

## Recipe 0 — the SHIPPED one-liner agent (2026-07-24)

The lowest-friction path is now IN THE PRODUCT: hovering or long-pressing
Se/cure's web knob (UX-10) opens a card linking **`/cure/local-search/`**
(`public/cure/local-search/index.html`), a khaki setup page of copyable
one-liners around **`agent.mjs`** (`public/cure/local-search/agent.mjs`) —
a single-file, dependency-free Node 18+ service the page serves from the
site itself:

```bash
curl -fsSL https://deepresearch.se/cure/local-search/agent.mjs -o agent.mjs && node agent.mjs
```

It speaks the `exa_compatible` wire (`POST /search` →
`{results:[{title,url,highlights}]}` + `GET /search?q=` + `GET /healthz`),
sends CORS **and Chrome's `Access-Control-Allow-Private-Network`** preflight
answer, binds `127.0.0.1:8099`, and has four engines (`ENGINE` env):
`serp` (DDG titles+snippets), `browse` (default — also fetches the result
pages and extracts real text excerpts), `playwright` (renders pages in
headless Chromium; the only one needing an install), and `searxng`
(`SEARXNG_URL` env — proxies a SearXNG instance, ADDING the CORS + Exa wire
SearXNG doesn't send, which makes the Docker recipe below browser-direct
usable). `API_KEY` env gates with `x-api-key`; `ALLOW_ORIGIN` tightens CORS.

Verified while building (2026-07-24, session container): all four engines
end to end — including `runBackendSearch` from
`public/js/websearch-backends-core.js` calling the agent exactly as DRC
does — plus the `curl … | node --input-type=module` pipe form and the
Windows `iwr` form's syntax. DDG quirk: the HTML endpoint intermittently
answers with an empty anti-bot shell; the agent retries once after 800 ms,
which passed in observation. NOT live-verified: the SearXNG Docker
one-liner itself (no daemon in session containers) — its engine was
verified against a mock.

Routing: `/cure/local-search` is a RESERVED replay slug (`src/pub.js`) and
routed like `/cure/help` in `src/index.js` BEFORE the wordplay map;
`agent.mjs` needs no route (extension ⇒ public asset). Safari caveat on the
page: it blocks HTTPS-page → `http://localhost` as mixed content; Chrome/
Edge/Firefox allow it.

---

## Recipe 1 — SearXNG (fastest path, metasearch, no key)

[SearXNG](https://github.com/searxng/searxng) is a mature privacy metasearch
engine: it aggregates results from Google/Bing/Brave/DuckDuckGo/… without
tracking you, and exposes a **JSON API**. This is the lowest-effort self-host.

`docker-compose.yml`:

```yaml
services:
  searxng:
    image: searxng/searxng:latest
    ports:
      - "8080:8080"
    volumes:
      - ./searxng:/etc/searxng:rw
    environment:
      - SEARXNG_BASE_URL=https://search.example.com/
    restart: unless-stopped
```

**Enable the JSON format** — it is OFF by default. In `searxng/settings.yml`:

```yaml
search:
  formats:
    - html
    - json          # <-- required; the adapter calls ?format=json
server:
  limiter: false    # or keep the limiter + allowlist the Worker's egress IPs
  secret_key: "change-me-to-a-long-random-string"
```

Restart, then confirm:

```bash
curl 'http://localhost:8080/search?q=test&format=json' | jq '.results[0]'
```

**Wire it up:** admin → *Web search service* → backend **SearXNG**, base URL
`https://search.example.com` (no trailing `/search` — the adapter appends it),
results 6–10. No key needed for a private instance. If you put SearXNG behind
an auth proxy, set `SEARCH_BACKEND_KEY` and the adapter sends it as a
`Bearer` token.

**Gotchas (observed in the wild):**
- Public/free SearXNG engines rate-limit hard; run your own instance and,
  ideally, add paid engine keys (Google CSE, Bing) in `settings.yml` for
  reliability under research-pipeline burst load (searches within a round fire
  concurrently — see the integrations skill).
- Keep `limiter` sane: the pipeline can fire several queries per second. Either
  disable it for the Worker's egress or allowlist it.
- SearXNG's `content` snippet is short; it maps to a single highlight. Good
  enough for synthesis, weaker than Exa's multi-highlight excerpts.

---

## Recipe 2 — Playwright crawler exposing an Exa-compatible API

When you want **full control** (your own ranking, real page text, JS-rendered
sites), run a tiny service that: takes a query → hits a SERP or a search API →
opens the top results in a real browser → extracts clean text → returns it in
**Exa's wire shape**. Because it speaks Exa's format, it drops into the
`exa_compatible` backend with zero adapter changes.

`server.mjs` (Node + [Playwright](https://playwright.dev), no framework):

```js
import { chromium } from "playwright";
import http from "node:http";

const API_KEY = process.env.API_KEY || "";           // must match SEARCH_BACKEND_KEY
const PORT = Number(process.env.PORT || 8099);

// Reuse ONE browser across requests (launch is the expensive part).
const browser = await chromium.launch({ args: ["--no-sandbox"] });

// Get candidate URLs for a query. Swap this for any SERP source you trust:
// a Brave/Bing/Google CSE API call, a SearXNG JSON call, your own index, etc.
// DuckDuckGo's HTML endpoint is shown as a keyless default — respect robots
// and rate limits; a paid SERP API is more reliable at scale.
async function serp(query, n) {
  const page = await browser.newPage();
  try {
    await page.goto("https://duckduckgo.com/html/?q=" + encodeURIComponent(query), {
      waitUntil: "domcontentloaded",
      timeout: 15000,
    });
    const urls = await page.$$eval("a.result__a", (as) =>
      as.map((a) => a.href).filter((h) => /^https?:/.test(h)),
    );
    return [...new Set(urls)].slice(0, n);
  } finally {
    await page.close();
  }
}

// Open a page and extract a title + a clean text excerpt (the "highlight").
async function fetchOne(url) {
  const page = await browser.newPage();
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15000 });
    const title = (await page.title()) || url;
    const text = await page.evaluate(() => {
      for (const sel of ["main", "article", "body"]) {
        const el = document.querySelector(sel);
        if (el) return el.innerText.replace(/\s+/g, " ").trim().slice(0, 1200);
      }
      return "";
    });
    return { title, url, highlights: text ? [text] : [] };
  } catch {
    return null;
  } finally {
    await page.close();
  }
}

const server = http.createServer(async (req, res) => {
  // CORS — REQUIRED for the Se/cure (DRC) browser-direct case; harmless for the
  // Se/rver (Worker) case. Lock the origin down to your site in production.
  const cors = {
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "content-type, x-api-key",
    "access-control-allow-methods": "POST, OPTIONS",
  };
  if (req.method === "OPTIONS") {
    res.writeHead(204, cors);
    return res.end();
  }
  const json = (code, obj) => {
    res.writeHead(code, { "content-type": "application/json", ...cors });
    res.end(JSON.stringify(obj));
  };
  if (req.method !== "POST" || !req.url.startsWith("/search")) return json(404, { error: "not found" });
  if (API_KEY && req.headers["x-api-key"] !== API_KEY) return json(403, { error: "bad key" });

  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", async () => {
    let q, n;
    try {
      const parsed = JSON.parse(body || "{}");
      q = String(parsed.query || "").slice(0, 400);
      n = Math.min(10, Math.max(1, Number(parsed.numResults) || 6));
    } catch {
      return json(400, { error: "bad json" });
    }
    if (!q) return json(400, { error: "query required" });
    try {
      const urls = await serp(q, n);
      const results = (await Promise.all(urls.map(fetchOne))).filter(Boolean);
      json(200, { results });                 // <-- Exa's shape
    } catch (e) {
      json(500, { error: String(e?.message || e) });
    }
  });
});
server.listen(PORT, () => console.log("search service on :" + PORT));
```

Run it:

```bash
npm i playwright && npx playwright install chromium
API_KEY=$(openssl rand -hex 24) PORT=8099 node server.mjs
```

`Dockerfile` (the official Playwright image ships the browsers + deps):

```dockerfile
FROM mcr.microsoft.com/playwright:v1.55.0-jammy
WORKDIR /app
COPY package.json server.mjs ./
RUN npm i --omit=dev
ENV PORT=8099
EXPOSE 8099
CMD ["node", "server.mjs"]
```

**Wire it up:** `npx wrangler secret put SEARCH_BACKEND_KEY` (the `API_KEY`
value); admin → *Web search service* → backend **Exa-compatible endpoint**,
base URL `https://your-service.example.com`. Test search to confirm.

**Production hardening (do these before relying on it):**
- **Concurrency cap** the browser (a pool, or `p-limit`) — the pipeline fires
  several queries per round, each opening N tabs. An uncapped browser will OOM.
- **Block heavy assets** for speed: `page.route("**/*", r =>
  ["image","media","font"].includes(r.request().resourceType()) ? r.abort() :
  r.continue())`.
- **Timeouts everywhere** (already 15 s here) — the Worker bounds its own call
  to 15 s and treats a slow service as a failure → Exa fallback.
- **Respect robots.txt / ToS** of whatever SERP source you scrape; prefer a
  paid SERP API (Brave, Bing, Serper, SerpAPI) for the URL list and use the
  browser only for text extraction.
- **Cache** repeated queries in the service (the Worker also edge-caches, but a
  service-side cache saves browser work across users).

---

## Recipe 3 — Other alternatives (creative & hosted)

All of these become an `exa_compatible` backend by wrapping them in a thin
`POST /search → {results:[{title,url,highlights}]}` shim (the ~30 lines of HTTP
plumbing from Recipe 2, minus the browser). Pick by tradeoff:

| Alternative | What it is | When to reach for it |
|---|---|---|
| **Brave Search API** | Independent index, generous free tier, JSON | Best hosted "just works" index; privacy-friendlier than Google/Bing |
| **Serper / SerpAPI** | Google results as JSON | Highest-quality ranking; paid, still a third party |
| **Tavily / You.com** | LLM-oriented search APIs (return snippets) | Drop-in Exa-likes; still hosted retention |
| **Meilisearch / Typesense + a crawler** | Your OWN index over a curated corpus | Domain-specific research (internal docs, a fixed source set); fully offline |
| **Common Crawl / an OpenSearch index** | Batch-built web index | Large offline corpus, no live fetch, full data control |
| **Firecrawl (self-hosted)** | Crawl+extract service (open source) | Like Recipe 2 but a maintained crawler; run it, wrap `/search` |
| **A headless Chrome grid (Browserless)** | Managed Playwright/Puppeteer | Recipe 2 without running browsers yourself |

**Creative combinations that fit the mission:**
- **Fully offline:** Meilisearch/Typesense over a corpus you ingested → zero
  outbound at query time. The strongest privacy posture: not even a query
  leaves your network.
- **Hybrid:** a self-hosted SearXNG for the URL list + a Playwright/Firecrawl
  pass for clean full text → Exa-quality excerpts, no Exa.
- **On-device (DRC/Se·cure tie-in):** the client-side tier already runs the
  research pipeline in the browser on the user's own keys; a self-hosted
  Exa-compatible service (CORS-enabled) is the natural search backend for it
  too — wired since the per-user browser-direct backend shipped (the
  settings drawer's "Web search service" section, and Recipe 0's shipped
  one-liner agent is exactly this).

---

## The validation ladder (same as every integration here)

1. **Unit** — the adapters are pure/mockable: `src/websearch-backends.test.js`
   (`node --test`). Add a case if you add a backend shape.
2. **Service smoke** — `curl` the service directly (the JSON-format check
   above), confirm the wire shape.
3. **Admin test search** — `/admin` → Web search service → *Run test*. This is
   the real `webSearch()` path, including fallback. Confirm `backend`,
   `resultCount`, and sources.
4. **Live pipeline** — turn web search ON in a chat, ask a researchable
   question, watch the activity panel cite your backend's sources; watch
   Workers Logs (`search.backend_hit`).
5. **A/B** — if you care about answer quality vs Exa, run the rubric/HF benches
   (see the model-eval skill) before and after the switch.

## Adding a NEW backend shape (checklist)

1. Add the id to `SEARCH_BACKENDS` in `src/websearch-backends.js`.
2. Write a pure `parse<Name>Results(data, limit) → SearchItem[]` and a
   fail-soft `async <name>Search(cfg, log, query, limit) → SearchItem[]|null`.
3. Branch it in `runBackendSearch`.
4. Add the option to `BACKEND_OPTIONS` in `public/js/admin.js` and any
   backend-specific fields to the panel form.
5. Unit-test the parser + a mocked-fetch dispatch case.
6. Keep it fail-soft: every non-happy path returns `null` so Exa fallback
   still protects the request.
