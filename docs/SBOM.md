# Software Bill of Materials (SBOM)

Full inventory of third-party code and third-party data processors this
Worker depends on. There is **no `package.json`** and no build step — the
server (`src/`) is plain JS run directly by the Workers runtime, and the
client (`public/`) is hand-written HTML/CSS/ES modules plus a handful of
libraries **vendored verbatim** (checked into `public/vendor/`, served
same-origin, never fetched from a CDN). That makes this document the
complete dependency list; there is no `node_modules` tree to diff against.

Regenerate/verify the table below at any time — every vendored file embeds
its own version banner:

```bash
head -5 public/vendor/marked.min.js public/vendor/purify.min.js public/vendor/jspdf.umd.min.js
grep -o 'version:"[0-9.]*"' public/vendor/pdfjs/pdf.min.mjs public/vendor/pdfjs/pdf.worker.min.mjs
sha256sum public/vendor/*.js public/vendor/pdfjs/*.mjs
```

## 1. Vendored client-side libraries

| Component | Version | License | Path | Purpose | Loaded |
|---|---|---|---|---|---|
| [marked](https://github.com/markedjs/marked) | 18.0.5 | MIT | `public/vendor/marked.min.js` | Markdown → HTML for assistant answers | Always (`js/markdown.js`) |
| [DOMPurify](https://github.com/cure53/DOMPurify) | 3.4.11 | Apache-2.0 OR MPL-2.0 | `public/vendor/purify.min.js` | Sanitizes the HTML `marked` produces before it hits the DOM (XSS/tracking-pixel defense against hostile quoted web content — `<img>` forbidden) | Always (`js/markdown.js`) |
| [jsPDF](https://github.com/parallax/jsPDF) | 2.5.2 | MIT | `public/vendor/jspdf.umd.min.js` | Client-side generation of the branded PDF report | Lazily, script-injected on first "PDF" click (`js/report.js`) |
| [pdf.js](https://github.com/mozilla/pdf.js) (`pdfjs-dist`) | 3.39.0 | Apache-2.0 | `public/vendor/pdfjs/pdf.min.mjs`, `public/vendor/pdfjs/pdf.worker.min.mjs` | Parses attached PDF documents client-side into text | Lazily, dynamic `import()` on first PDF attachment (`js/docs.js`) |

No other runtime dependencies: DOCX attachments are parsed with a
hand-rolled minimal ZIP reader + the platform's built-in
`DecompressionStream("deflate-raw")` (no library); everything else in
`public/js/` and all of `src/` is original code with zero imports outside
the Cloudflare Workers runtime.

## 2. Runtime platform

| Component | Provider | Purpose |
|---|---|---|
| Workers runtime | Cloudflare | Executes `src/index.js` at the edge (V8 isolates); serves `public/` via the `ASSETS` binding |
| D1 | Cloudflare | SQLite at the edge — accounts, quotas, usage events, admin config (§9 of [`ARCHITECTURE.md`](./ARCHITECTURE.md)) |
| Workers Logs | Cloudflare | Structured JSON log persistence (`[observability]` in `wrangler.toml`) |

No bundler, transpiler, or package manager runs at deploy time —
`npx wrangler deploy` uploads `src/` and `public/` as-is.

## 3. Third-party data processors (external APIs)

These aren't code dependencies, but every request's content passes through
them, which is the more relevant supply-chain fact for a chat product —
see [`ARCHITECTURE.md` §9](./ARCHITECTURE.md#9-data-at-rest) for what this
Worker itself stores (nothing chat-related).

| Service | Purpose | Data sent | Retention policy (their docs) |
|---|---|---|---|
| [Berget.ai](https://berget.ai/en) | LLM inference (triage/search-plan/gap-check/synthesis/validation) | Message text, attached images | **Zero retention** — "your data is never stored or retained," EU-only infrastructure. Declared at <https://berget.ai/en> (homepage claim) and the [Data Processing Agreement](https://berget.ai/dpa) |
| [Exa](https://exa.ai/) | Web search (`/search`) | Search queries planned by the triage/gap-check phases | **Zero Data Retention (ZDR)** available across Exa's search products — query data is not stored by the main service or subprocessors. Declared at <https://docs.exa.ai/reference/security> (Security & Enterprise docs) and <https://exa.ai/blog/zdr-search-engine> (ZDR announcement) |
| Google OAuth | Sign-in identity (`src/google.js`) | OAuth authorization code, ID token claims (email, name, `sub`) | Governed by [Google's own data policies](https://policies.google.com/privacy); Deepresearch.se only stores the resulting email/name/subject id (§9 of `ARCHITECTURE.md`) |

Berget.ai and Exa were deliberately picked as this project's LLM and search
providers over comparable alternatives *because* both commit to zero data
retention for the traffic this pipeline sends — no chat content or search
query is retained by either provider once the request completes, which
matches the site's own "nothing chat-related is stored server-side"
posture end to end.
