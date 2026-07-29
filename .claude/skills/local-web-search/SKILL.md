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

**Start with Recipe −1 (2026-07-25): there is now a backend that needs no
service at all** — `"cloudflare"`, where this Worker does the searching
itself. It is the zero-setup answer to "get our searches off a third party",
and it is the one alternative a USER can pick per request rather than an
operator configuring it site-wide. Everything below it still applies when you
want a real index, your own ranking, or JS-rendered pages.

**Why self-host.** Exa is not zero-data-retention on the standard plan (see the
integrations skill / `/help` "Sensitive topics"). The project's mission is
pushing a real research assistant toward *provable* privacy; a self-hosted
search backend is the code side of that — the short AI-derived query never
reaches a third party's retention. Only the query string ever leaves the
Worker either way (never the conversation), but a self-hosted backend removes
the third party entirely.

## How the backend seam works

- **`src/websearch-backends.js`** — the dispatch + resolution. Three non-Exa
  backends:
  - `"cloudflare"` — this Worker searches for itself (`src/websearch-cf.js`;
    Recipe −1). Server-only, no configuration.
  - `"searxng"` — a SearXNG instance's JSON API (`GET {base}/search?q=…&format=json`).
  - `"exa_compatible"` — anything speaking Exa's own wire
    (`POST {base}/search`, `x-api-key`, `{results:[{title,url,highlights}]}`).
  All are **fail-soft**: a misconfigured/unreachable backend returns `null`.
  The last two are adapters in the shared core; the first is server-only.
- **`src/config.js`** — the `search` block: `{ backend, base_url, results,
  fallback_exa, cf_pages, allow_user_choice }`. Default `backend:"exa"`, so an
  unconfigured site is unchanged. Edited via `PUT /api/admin/config` from the
  admin panel.
- **`src/exa.js`** `webSearch(env, log, query, depth, { source })` — resolves
  the backend (the caller's user-picked `source` first, then the site config,
  then Exa), runs it, and on any failure falls back to Exa when `fallback_exa`
  is on AND `EXA_API_KEY` exists.
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
  - **Providers must be CORS-capable anyway** in DRC (OpenAI, Anthropic, Groq,
    Hugging Face,
    Berget, and any custom endpoint the user adds), so a
    CORS-enabled search service fits the tier's existing constraint.

---

## Recipe −1 — the CLOUDFLARE-ORIGINATING backend (2026-07-25, no setup)

`src/websearch-cf.js`. No service, no key, no deploy, no dependency: the
Worker fetches a results page, unwraps the result links, and (by default)
fetches the top result pages to extract real text excerpts — all from
Cloudflare's edge. Turn it on site-wide at `/admin` → **Web search service** →
*Cloudflare-originating*, or leave the site on Exa and let people pick it per
request by switching **Exa web search** off in their settings.

**Why this shape.** Four Cloudflare-native options were weighed; the module
header records the full reasoning. Short version: Browser Rendering
(`@cloudflare/puppeteer`) is a paid binding whose per-session concurrency
ceiling is below what a search WAVE needs; Workers AI / AutoRAG answers over
a corpus you maintain, not the live web; a separate Worker + service binding
is a second deployable for a few hundred stateless lines. Plain `fetch` + pure
string parsing inside the existing Worker avoids all of that and keeps the
parsers unit-testable under `node --test` — which HTMLRewriter, the idiomatic
Workers parser, would not (workerd-only).

**The SERP is a CASCADE, and that is a measured decision (2026-07-25).** The
first cut lifted the local agent's `browse` engine straight into the Worker —
same technique, other side of the trust boundary. It does not transfer. From a
datacenter IP, DuckDuckGo's no-JS endpoint answers **HTTP 202 with an empty
anti-bot shell**: verified from a session container against `html.` and
`lite.`, GET and POST, bot UA and browser UA — every combination, zero
results. The agent works because it runs on a person's own machine. So the
backend tries an ORDERED LIST of sources, MERGING their results until the
caller's limit is met (`SERP_PROVIDERS` + `search.cf_serp`). It stopped at the
first source that returned *anything* until 2026-07-29; two results from one
small index is a worse foundation for research than two plus the next source's,
and the extra request is only paid when the first source came up short.

| id | source | measured from a datacenter IP | default |
|---|---|---|---|
| `ddg` | DuckDuckGo no-JS HTML | 202 anti-bot shell, 0 results | on (works where egress is accepted) |
| `marginalia` | Marginalia, an independent index | 200 card markup with real results — **or a 200 throttle interstitial**, see below | on |
| `bing_rss` | Bing's `&format=rss` output | 200, well-formed feed, good results | **off — see below** |

Also probed and rejected: Mojeek (403), Qwant's API (403), Startpage (an
Anubis proof-of-work challenge), Bing's HTML SERP (200 but no parseable
organic anchors), DuckDuckGo's Instant Answer API (no organic results).

**`bing_rss` ships OFF on purpose.** Every RSS response carries a Microsoft
copyright notice restricting the results to "rendering Bing results within an
RSS aggregator for your personal, non-commercial use" — which a research
assistant is not. The parser and the option exist; whether a given deployment
may use them is the operator's call, and the admin panel quotes the restriction
next to the checkbox. Do not quietly promote it to a default.

Adding a source is one entry in `SERP_PROVIDERS` (`{id, label, url, parse}`,
optional `fallbackParse`/`retryEmpty`/`restricted`/`throttle`+`origin`) plus a
pure parser test.

### A RATE LIMIT DOES NOT ALWAYS ARRIVE AS A STATUS CODE (2026-07-29)

The cause of the reported "web search quality issues" on this backend, and the
first thing to check when a new source looks like an empty index. Marginalia
answers a request it is throttling with **HTTP 200** and a 1 KB page:

> **Wait For A Moment** — The search engine is currently barraged by queries
> from bots. Please wait for `N` seconds…

`resp.ok` is true, the card parse finds nothing, and the cascade concluded
"empty" and gave up. Sampled from a session container that was **7 responses in
10** for an ordinary query, and **6 in 6** under the concurrency a search WAVE
actually creates — so with `ddg` already dead from a datacenter IP, most queries
in a wave returned no sources at all while looking like a legitimately empty
index. Following the `sst` retry link the interstitial itself hands out took the
same battery from **3/10 to 9/10**.

So: `throttle` (a pure parser returning `{path, waitMs}`) + `origin` on the
provider, `THROTTLE_RETRIES` follows, the countdown clamped by
`THROTTLE_MAX_WAIT_MS` (it is advisory and routinely NEGATIVE, meaning "go
now"). When you add a source, **treat a 200 carrying no results as a possible
throttle before believing the index is empty** — check the body, not the status.

Two more things measured in the same pass, both about not fabricating results:

- **`marginalia` deliberately has NO `fallbackParse`.** The class-free anchor
  scan is insurance against DuckDuckGo's shifting table markup; on Marginalia it
  only ever ran on a page that HAD no results, and then returned the engine's own
  About/GitHub/footer links as research sources (reproduced on a Swedish query
  the index cannot answer). No results is the honest answer — the cascade moves
  on and `exa.js` falls back to Exa. `MARGINALIA_HOSTS` covers both
  `marginalia.nu` and `marginalia-search.com` for the same reason.
- **DuckDuckGo's 202 is TERMINAL.** Every measured retry returned the same
  shell, so the empty-body retry (the 800 ms beat plus a second round trip, paid
  on every query in every wave) is now spent only on a plain 200.

### AN EXCERPT IS NOT A PREFIX (2026-07-29)

The other half of the quality gap, and the one that applied to *every* result of
*every* query. `fetchExcerpt` used to hand synthesis `pageText(html).slice(0,
1200)` — the first 1200 characters of the page, which on a real article is the
part before the article. Measured verbatim: Wikipedia's *Intermittent fasting*
excerpt was its language sidebar ("Toggle the table of contents … 30 languages
العربية Asturianu …"), and WebMD's opened with 230 characters of category menu.

Exa returns highlights SELECTED for the query, so this backend now does too:

- `pageText` strips the page furniture (`nav`/`header`/`footer`/`aside`/`form`),
  citation markers (`[12]`, `[edit]`), and `link`/`meta` tags — the last because
  a `media="(min-width >= 40rem)"` attribute defeats a naive `<[^>]*>` strip and
  leaks `= 40rem)" rel="stylesheet"` into the excerpt as if it were prose. It
  keeps the unstripped text if stripping would leave nothing.
- `queryTerms` drops English **and Swedish** stopwords (invariant 6 — a Swedish
  query must not reduce to nothing and silently fall back to the page head).
- `relevantExcerpt` scores sentences by distinct-term coverage and joins the
  winning passages with Exa's own `" … "`, degrading to the head when nothing
  matches.
- `isChallengePage` refuses a bot-check body served as a normal 200 — citing
  "Just a moment…" as a source is worse than having no excerpt.
- `rankItems`/`scoreItem` order results by query relevance (title and URL
  matches count double) behind a **relevance floor** that drops zero-match
  results — but only while at least two matching ones remain, because no sources
  is worse than weak ones. `SERP_OVERFETCH` asks each source for more than the
  caller wants so the floor has something to discard.

**Measured on 8 fixed real pages, same cached HTML both ways:** mean query-term
coverage in the excerpt **52% → 91%**.

It is otherwise the same technique as the local browsing agent's `browse`
engine (Recipe 0). Compare honestly when recommending one:

| | `cloudflare` | local agent (Recipe 0) |
|---|---|---|
| Setup | none | one command on the user's machine |
| Who sees the query | Cloudflare + the SERP host | the SERP host only |
| Se/cure exposure | needs a grant/token (query-only) | none — browser-direct |
| Ranking | a public SERP | same |

**Knobs** (`config.js`'s `search` block): `cf_serp` (the ordered source list
above), `cf_pages` (default true — off serves SERP snippets alone: faster, and
noticeably thinner than Exa highlights) and `allow_user_choice` (default true —
off pins the site-wide backend and takes the user knob away). `fallback_exa` still
applies: an exhausted cascade falls through to Exa when a key exists.

**Reading the logs.** `search.cf_serp_empty {provider}` on `ddg` for every
search is EXPECTED on Cloudflare — that is the cascade doing its job, and
`search.cf_serp {provider}` names whoever actually answered. The real alarm is
`search.cf_serp_empty` for every configured provider plus a rising
`search.backend_fallback_exa`: at that point the cascade is decorative and the
answer is a real backend (Recipe 1/2), not another retry.
`search.cf_serp_fallback_parse` means a source changed its markup and the
class-free anchor scan is carrying it — results without snippets, so fix the
parser before it degrades further.

`search.cf_serp_throttled {provider, attempt}` is a source rate-limiting us and
the retry being followed; paired with `search.cf_serp_throttle_recovered` that
is the machinery working, and a few per wave is normal. `search.cf_serp_throttled
{gave_up:true}` means the follows were exhausted — a burst of those is the
signal that this deployment is asking one small index for more than it will
give, and the answer is another source in `cf_serp` or a real backend
(Recipe 1/2). `search.cf_serp {provider}` is a comma-separated list once more
than one source contributes, and its `dropped` count is what the relevance floor
discarded.

**Verify it without switching the site over:** `/admin` → Web search service →
*Test search* → **Against: Cloudflare-originating**. That runs one real search
through this backend whatever the site is configured to use.

**Verified 2026-07-25** (session container, `node -e` against the real module):
the `ddg → marginalia` cascade end to end — DDG empty, Marginalia answering
with 6 results, 5 of which upgraded from snippet to a full 1200-char page
excerpt, in ~4.4 s cold (≈0.5 s when DDG's dead leg is skipped). `bing_rss`
verified separately as a parse + fetch. NOT verified: behaviour from
Cloudflare's own egress IPs, which differ from this container's — expect the
cascade to matter there too, and check `search.cf_serp` after the first
deploy.

**Re-verified 2026-07-29** against the live sources after the quality fixes: a
12-query concurrent wave returned sources for 11, with 3 throttle interstitials
detected where the old code would have recorded 3 silent empties; excerpt
coverage 52% → 91% on 8 fixed pages. **Read the throttle rate as a moving
target** — it is bursty and load-dependent, so a single wave proves little in
either direction (one paired 30-query run scored 83% both before and after
simply because Marginalia was not throttling at the time). Measure the
MECHANISM — the `search.cf_serp_throttled` / `_throttle_recovered` counters —
not the end-to-end rate, when you want a number that reproduces.

---

## The user-facing choice (the **Exa web search** settings knob)

Since 2026-07-25 the backend is not only an operator decision. The user-facing
control is a single settings knob — **Exa web search**, ON by default; switch
it OFF and searches run from this site's own Worker instead. It lives in the
Settings view on Se/rver (`public/js/account-settings.js`) and the settings
drawer on Se/cure (`#exarow`, wired in `drc.js`), both over the shared
device-local preference `public/js/search-source.js` (localStorage). The
resulting source rides `/api/chat` as `search_source` on Se/rver and the
grant/token calls as `source` on Se/cure, and the server RE-VALIDATES it
against `USER_SEARCH_SOURCES` — so the client is a preference, never a trust
boundary.

For one day (2026-07-25 → 07-26) it sat as a radio picker on the web knob's
long-press card. The owner reversed that: **the composer knob is on/off only**,
and this belongs in settings. See UX-10 in the **ux-conventions** skill. The
card still explains the knob and links the local-agent setup page; it just no
longer decides.

Self-hosted backends are deliberately NOT part of that knob: they name an
operator's own service. On Se/cure that decision already lives further down the
same settings drawer (browser-direct, no query touches this server at all), and
a configured local agent outranks the grant path entirely — which is why the
Se/cure knob's status line says so when one is configured.

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

0. Decide whether it is a self-hosted SHAPE (adapters in the shared core,
   `public/js/websearch-backends-core.js` — both tiers can call it) or a
   SERVER-ONLY backend (its own `src/` module, dispatched in the façade — the
   `cloudflare` one is server-only because a browser cannot fetch a SERP
   cross-origin).
1. Add the id to `SEARCH_BACKENDS` in `src/websearch-backends.js`.
2. Write a pure `parse<Name>Results(data, limit) → SearchItem[]` and a
   fail-soft `async <name>Search(cfg, log, query, limit) → SearchItem[]|null`.
3. Branch it in `runBackendSearch`.
4. Add the option to `BACKEND_OPTIONS` in `public/js/admin.js` and any
   backend-specific fields to the panel form (note the three nesting levels
   there: every non-Exa backend gets results + Exa-fallback,
   `SELF_HOSTED_OPTIONS` additionally get the base URL + key note, and a
   backend with its own knobs gets its own block — `#wssvc-cf` is the example).
   Do NOT add it to `USER_SEARCH_SOURCES` unless it needs no operator setup at
   all; that list is what the web knob's card offers every user.
5. Unit-test the parser + a mocked-fetch dispatch case.
6. Keep it fail-soft: every non-happy path returns `null` so Exa fallback
   still protects the request.
