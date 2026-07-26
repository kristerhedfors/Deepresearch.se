# Dependencies

Every dependency this project has, of every kind: the JavaScript libraries the
browser loads, the network services the Worker calls, the Cloudflare resources
it binds to, the dev-only tooling, and the large data blobs some features
stream at runtime.

The short version:

- **Zero runtime npm dependencies.** `package.json` has no `dependencies`
  block. `src/` imports nothing but `node:*` builtins and its own files. There
  is no build step and no bundler, so there is no transitive tree to audit
  (invariant 5 in `CLAUDE.md`).
- **Seven third-party JavaScript libraries**, all hand-vendored into
  `public/vendor/` and served same-origin. 41.25 MiB on disk, of which 34.82
  MiB is the two on-device-inference WASM blobs that only load when a user
  explicitly opts into phone-local inference. A normal page load pays 69.7 KiB
  (23.3 KiB gzipped) for two of them.
- **Five external things still load at runtime, and two of them execute
  JavaScript in our origin.** They are listed in §2 and flagged there. The
  intent is that nothing third-party executes from a host we do not control;
  we are not there yet.

Sizes and hashes below were measured against the working tree on 2026-07-26.
Re-measure with the commands in §7.

---

## 1. JavaScript libraries (vendored, same-origin)

All seven live in `public/vendor/` and are served from our own origin by
`src/assets.js`. None is installed by npm; each was downloaded once from its
upstream dist and committed. Every one of them is also on the unauthenticated
allowlist, because the Se/cure tier (`/cure`) renders answers and runs the
sandbox without a login.

| Library | Version | Files | On disk | Gzipped | License | Loads when | Why it is here |
|---|---|---|---|---|---|---|---|
| **marked** | 18.0.5 | `marked.min.js` | 41.9 KiB | 13.0 KiB | MIT | **Every page load** (classic `<script>` in `index.html`, `cure/index.html`, `story/`, `docs/`) | Answers arrive as Markdown and have to render as prose, tables, and code blocks. Writing a Markdown parser that handles what a model emits is not a weekend job, and getting it subtly wrong is an XSS surface. |
| **DOMPurify** | 3.4.11 | `purify.min.js` | 27.8 KiB | 10.3 KiB | Apache-2.0 / MPL-2.0 | **Every page load**, alongside marked | The one that is not optional. Rendered answers contain untrusted model output and untrusted web-search content. DOMPurify sanitizes the HTML marked produces. With the CSP off (§2.4), it is the sole XSS defence — `SECURITY-RISKS.md` R-10 calls it out for exactly that reason. |
| **mermaid** | 11.16.0 | `mermaid.min.js` | 3.40 MiB | 959 KiB | MIT | Lazily, only when a rendered answer contains a ` ```mermaid ` fence (`public/js/markdown.js:281`) | Diagrams-as-text is something models are good at, and a rendered flow diagram answers architecture questions better than a paragraph. It is the largest non-WASM library here, which is why it is behind a fence check rather than in the base load. |
| **jsPDF** | 2.5.2 | `jspdf.umd.min.js` | 357 KiB | 114 KiB | MIT | Lazily, on the first "export as PDF" click (`public/js/report.js:18`) | Exports a finished answer as a branded PDF report. Generating a real PDF from scratch is not worth writing; injecting it on first use only means the normal page load never pays for it. |
| **pdf.js** | 3.39.0 | `pdfjs/pdf.min.mjs`, `pdfjs/pdf.worker.min.mjs` | 1.73 MiB | 519 KiB | Apache-2.0 | Lazily, on the first PDF attachment (`public/js/docs.js:82`) | Users attach PDFs and expect the text to reach the pipeline. Extraction has to happen client-side to keep the file out of the server on the Se/cure tier. The worker file is 1.35 MiB of that total and is fetched by pdf.js itself, not by us. |
| **xterm.js** | 5.5.0 (+ `addon-fit` 0.10.0) | `xterm/xterm.js`, `xterm/xterm.css`, `xterm/addon-fit.js` | 290 KiB | 69.0 KiB | MIT | When the execution sandbox opens (`public/js/sandbox.js:70`) | The terminal the in-browser Linux VM renders into. Vendored on 2026-07-15 specifically because it used to load from `cdn.jsdelivr.net`, which put the most regression-prone feature in the product at the mercy of a CDN outage. |
| **transformers.js** (`@huggingface/transformers`) | 4.2.0, bundling **onnxruntime-web** 1.26.0-dev.20260416-b7804b056c | `transformers/transformers.min.js`, plus four `ort-wasm-simd-threaded*` files | 35.42 MiB | 8.85 MiB | Apache-2.0 (transformers.js), MIT (onnxruntime-web) | Only inside the on-device inference Web Worker, after the user consents to a model download (`public/js/ondevice-worker.js:358`) | Runs 1-bit Bonsai models on WebGPU entirely inside the browser — the strongest privacy position the project has, since no prompt leaves the device at all. The 35.42 MiB is 615 KiB of JavaScript plus two onnxruntime WASM blobs, 12.34 MiB and 22.48 MiB; nothing imports it until the settings drawer's explicit download flow runs. |

**Totals.** 41.25 MiB raw / 10.49 MiB gzipped for the whole tree. Excluding the
two WASM blobs: 6.43 MiB. What a first-time visitor to either tier actually
downloads: **69.7 KiB raw, 23.3 KiB gzipped** (marked + DOMPurify). Everything
else is gated behind a feature the user has to reach for.

Two of the seven carry SHA-256 pins in the source comment above their loader
(`sandbox.js:62` for xterm, `ondevice-engine.js:20` for transformers.js). The
other five did not, which is the gap `SECURITY-RISKS.md` L-12 tracks. §7 below
records all fourteen hashes so the whole tree is now covered.

### 1.1 Why vendoring at all

Three reasons, in the order they matter here:

1. **Availability.** A CDN outage cannot break a shipped feature. This is not
   hypothetical — it is why xterm was vendored.
2. **Privacy.** A third-party CDN sees the IP address and referrer of every
   visitor who loads a page. On a site whose mission is provable privacy, that
   is a leak we control by not having it.
3. **Auditability.** A committed byte-identical file has a hash. A CDN URL has
   whatever the CDN serves today.

The cost is that updates are manual and there is no `npm audit`. §7 covers the
integrity manifest that substitutes for it.

---

## 2. External runtime loads — ⚠️ FLAGGED

The stated goal is that no third-party code executes on our pages from a host
we do not control. **Five external loads remain, and two of them execute
JavaScript in our origin.** None is accidental; each is recorded below with its
current status.

### 2.1 ⚠️ CheerpX engine — third-party JS executing in our origin

```
https://cxrtnc.leaningtech.com/1.2.6/cx.esm.js
```

`public/js/sandbox.js:73`, loaded via `await import(CHEERPX_CDN)` at
`sandbox.js:707`. This is the x86 emulator behind the in-browser Linux
sandbox, and it is a live ES-module import from Leaning Technology's CDN.

**Severity: of everything on this page, look at this one first.** Whoever controls
that URL can run arbitrary JavaScript in the `deepresearch.se` origin for any
visitor who opens the sandbox, on both tiers, including the unauthenticated
Se/cure tier. There is no subresource-integrity hash on a dynamic `import()`,
so a changed file is not detectable client-side.

**Why it is still there:** self-hosting `cx.esm.js` same-origin is blocked on
whether Leaning Technology's license permits redistribution. That is an owner
decision, recorded as an open question in `docs/FOREVERAGENT-TRAJECTORY.md` §5
and as a milestone in §3.5 (M5/P4) of the same document. Until it is answered,
the exception stands and is disclosed rather than hidden.

**If the answer is no,** the engine stays a disclosed CDN dependency and the
sandbox cannot reach the same self-contained posture as the rest of the site.

### 2.2 ⚠️ Google Maps JS SDK — third-party JS executing in our origin

```
https://maps.googleapis.com/maps/api/js?key=…&v=weekly&loading=async
```

`public/js/activity.js:143`, injected as a `<script>` tag. Same class of
exposure as CheerpX — Google's JavaScript runs in our origin — but with three
mitigations that CheerpX does not have:

- It is an **extension** (invariant 7), off unless the operator has set
  `GOOGLE_MAPS_API_KEY` *and* the user has turned the `google_maps` knob on.
- It loads only when a `streetview_embed` event actually arrives in a turn,
  not on page load.
- A failed load already degrades to a keyless `google.com/maps/embed` iframe
  (`public/js/imagedeck.js:98`), which is a cross-origin frame rather than
  in-origin script.

It cannot be vendored: the Maps SDK is a versioned, key-authenticated,
server-rendered bundle, and Google's terms require loading it from their host.
The honest framing is that using Street View at all means accepting Google's
script; the knob is the consent.

### 2.3 Data-only external fetches

These pull bytes, not executable code in our origin. Lower severity, still
worth knowing about:

| What | URL | When | Note |
|---|---|---|---|
| WebVM Debian disk image | `wss://disks.webvm.io/debian_large_20230522_5044875331_2.ext2` | Sandbox boot, unless an operator has uploaded a self-hosted image | Streamed over WebSocket, cached in IndexedDB. Debian is redistributable, so this one *can* be self-hosted — `docs/SANDBOX-LOCAL-IMAGE.md` documents the path, and `sandbox.js` already prefers a same-origin image when one is selected. |
| Bonsai model weights | `https://huggingface.co/<repo>/resolve/main/…` | Only from the explicit consent flow in the on-device settings drawer | 300 MB – 4.2 GB per model. The user sees the size and agrees before anything downloads (`docs/BONSAI-27B-PHONE-INFERENCE.md` §6). |
| OpenStreetMap raster tiles | `https://tile.openstreetmap.org/{z}/{x}/{y}.png` | The Tokemon game's map view only | Images. `public/games/tokemon/js/map.js:96`, attributed in the game UI. |

### 2.4 The CSP would block most of this today

`src/security-headers.js` carries a full Content-Security-Policy that is
**disabled** (`CSP_ENABLED = false`). Flipping it on as written would break
several of the dependencies above, because the policy predates them:

- `script-src` allows `'self'` and the two Maps hosts. It does **not** allow
  `cxrtnc.leaningtech.com` — the sandbox would stop booting.
- `connect-src` allows `'self'`, `*.googleapis.com`, `*.gstatic.com`. It does
  **not** allow `wss://disks.webvm.io`, `huggingface.co`, or the Se/cure tier's
  browser-direct provider calls to `api.berget.ai` / `api.openai.com` /
  `api.groq.com` — Se/cure would stop working entirely.
- `img-src` is broad (`https:`), so OSM tiles are fine.

This is not a live breakage, since the header is off. It is a note for whoever
turns it on: the allowlist needs a pass against this document first. Tracked in
`SECURITY-RISKS.md` under the P-4 CSP checklist.

---

## 3. Network service dependencies

Services the Worker calls at request time. The authoritative table with
endpoints and auth headers is `docs/ARCHITECTURE.md` §1 ("External
dependencies"); this is the dependency-shaped view of the same set.

| Service | Required? | Fails how | Why we depend on it |
|---|---|---|---|
| **Berget.ai** | **Yes** — the only hard LLM dependency | Request fails | Primary provider. All three JSON planning phases run here on a fixed model regardless of the user's answer-model choice (invariant 3), so Berget is load-bearing even when the answer comes from Anthropic or OpenAI. EU-hosted, which is the point. |
| **Exa** | No (`EXA_API_KEY` optional) | Search degrades: fewer or no results, chat continues (invariant 2) | Web search. Returns HTTP 402 without a key. |
| Cloudflare-originating search cascade | No | Returns `null`, falls back to Exa | DuckDuckGo HTML / Marginalia / Bing RSS, scraped by the Worker itself (`src/websearch-cf.js`). The alternative to depending on a search vendor at all. |
| **Anthropic** | No (`ANTHROPIC_API_KEY`) | Those models vanish from the dropdown | Secondary answer models (`claude-*`). |
| **OpenAI** | No (`OPENAI_API_KEY`) | Same | Third answer provider (bare `gpt-*`). |
| **Google OAuth** | No (`DB` binding + client) | Sign-in disabled, break-glass Basic Auth still works | `accounts.google.com` / `oauth2.googleapis.com`. A server-side redirect flow — it loads **no** Google script into the browser. |
| **Hugging Face Hub** | No (`HUGGINGFACE_API_TOKEN`) | HF results silently absent | Models/datasets/papers as citable sources when the question targets HF. |
| **Shodan** | No (`SHODAN_API_KEY`) | Knob hidden entirely | Host-intelligence enrichment. An **extension** (invariant 7) — no core file names it. |
| **Google Maps Platform** | No (`GOOGLE_MAPS_API_KEY`) | Knob hidden entirely | Places / Street View Static / Static Maps / Embed. Also an **extension**. |
| **OSM Nominatim** | No | Photo lands without place context | Reverse-geocoding EXIF GPS from attached photos. No key, generic UA. |

Every one of these except Berget degrades rather than erroring, which is
invariant 2 doing its job. Outbound requests carry the minimum — a query, a
coordinate, a host — never the conversation, filenames, or account identity.

---

## 4. Platform dependencies

Cloudflare, declared in `wrangler.toml`. These are not swappable without real
work; the Worker is written against workerd, not Node.

| Binding | Resource | Required? | Without it |
|---|---|---|---|
| `ASSETS` | Workers static assets (`./public`) | Yes | No UI |
| `DB` | D1 `deepresearch-se` | No | Google sign-in disabled; break-glass admin auth only |
| `STORAGE` | R2 `deepresearch-se-storage` | No | Cloud storage feature reports unavailable, UI hides it |
| `RAG_INDEX` | Vectorize `deepresearch-se-rag` (1024 dims, cosine) | No | Document RAG unavailable |
| — | Workers **Paid** plan | Yes, as configured | `[limits] cpu_ms = 300_000` is rejected outright by the deploy API on the Free plan. Delete the `[limits]` block to deploy free. |
| — | Workers Logs (`[observability]`) | No | No queryable logs |

The R2 and Vectorize bindings must not be declared before the resources exist —
a declared-but-missing binding fails the whole deploy, not just the feature.

---

## 5. Development and test dependencies

None of these ship. The deploy uploads `src/` and `public/` as plain files.

| Package | Where | Version | Used for |
|---|---|---|---|
| `typescript` | root `devDependencies` | latest | `npm run typecheck` — zero-build-step `tsc --noEmit`, opt-in per file via `// @ts-check` |
| `@cloudflare/workers-types` | root `devDependencies` | latest | Worker globals for that typecheck |
| `@playwright/test` | `tests/devDependencies` | ^1.49.0 | End-to-end tests against the live site |
| `wrangler` | invoked via `npx`; pinned in `instances/lite` | ^3.60.0 there | Deploy and local dev |
| Node.js | — | 22 in CI | Test runner only (`node:test`, no framework). The Worker runs on workerd. |
| Python 3 | — | any | `tests/make_fixtures.py`, run once to build e2e fixtures |
| Vale | `.claude/skills/anti-ai-smell/vale/` | optional | Prose linting for the docs de-smell pass |

The root lockfile resolves to **3 packages** total. `instances/lite` is a
distilled instance with its own three dev dependencies and, like the parent,
no runtime ones.

CI (`.github/workflows/ci.yml`) runs `npm ci` + `npm test` + `npm run
typecheck` on Node 22 with no credentials and no network. The e2e and eval
harnesses are deliberately not run there — they spend provider tokens and need
break-glass auth.

---

## 6. What we deliberately do not depend on

Worth stating, because each was a choice:

- **No web fonts.** Every surface uses system font stacks (`system-ui`,
  `ui-monospace`, and friends). No `@font-face`, no `fonts.googleapis.com`, no
  font files in the repo. A font CDN would see every visitor.
- **No analytics, no tag manager, no error-reporting SDK.** The interaction log
  is our own `chat_logs` table, suppressible per-request with
  `incognito: true`.
- **No bundler, no transpiler, no framework.** The client is ES modules the
  browser loads directly. `public/js/*.js` is what ships.
- **No `<script src="https://…">` or `<link href="https://…">` anywhere in
  `public/`.** Verified by grep; the two external script loads in §2 are both
  injected at runtime from JavaScript, which is why they need this document
  rather than being visible in the HTML.

---

## 7. Integrity manifest

SHA-256 of every file in `public/vendor/`, measured 2026-07-26. This is the
manifest half of `SECURITY-RISKS.md` L-12, elevated by R-9 (push-to-main is
push-to-production, so a tampered vendored file deploys itself) and R-10
(known-version CVE matching).

```
2dc4769dfde29f51c7aca1a539c6407c789c8ea644cf8b7d01ded28a9c1d800b  marked.min.js
dbabb5b205a333ec49c8c09e7fca30ef66df0523bb8bc0fa9ea843841f111dbd  purify.min.js
74d7c46dabca328c2294733910a8aa1ed0c37451776e8d5295da38a2b758fb9b  mermaid.min.js
85ba2cc3ff858a20fa49fe6e457bec863ea40b55a9f3725e58a940e62f6f61a4  jspdf.umd.min.js
44ec6f011027ee77791386b66c14876a5fc29e20bf0433c07c6726fff7212b72  pdfjs/pdf.min.mjs
bd88805178a26c729db8c0107a5b630cb900ec070f4d8c7529a3e45530afd41d  pdfjs/pdf.worker.min.mjs
1f991ac3b4b283ebf96e60ae23a00a52765dd3a2e46fa6fdda9f1aab032f7495  xterm/xterm.js
ba8e6985669488981ccf40c0cefe3aba80722cb6c92de7ad628b0bd717faf2b6  xterm/xterm.css
bdaefa370b1bfc42ee88d46fe6072400902a4d4b2d45cd93438dda9b23c97089  xterm/addon-fit.js
e74bd32ed4453369ebb0edcaa27f6bc6204004a949a0233cdb87b62dda8d6978  transformers/transformers.min.js
5f2cd914554830762579c372d0211614c1e3f40ab3f6c0cfcf0900343229071d  transformers/ort-wasm-simd-threaded.mjs
f4f290847a4df02d0b93cdbf39b4b0e71acefbe80573e7e6b9342a7abd7b290a  transformers/ort-wasm-simd-threaded.wasm
5959c6733039619c9af710d8e1bae8d6e84402787990637be987c2b1bd6c5fa9  transformers/ort-wasm-simd-threaded.asyncify.mjs
e0c0c6d3e73d43b8a249972f8358f845b08cc16fec3c80efafdf8bed40366786  transformers/ort-wasm-simd-threaded.asyncify.wasm
```

Verify the tree against it:

```bash
cd public/vendor && sha256sum *.js */* 2>/dev/null | sort
```

Re-measure the sizes in §1:

```bash
find public/vendor -type f -printf '%s\t%p\n' | sort -rn
```

A mismatch on any line means someone changed a vendored library. Per R-9 that
is reviewed byte-for-byte, not waved through.

---

## 8. Adding or updating a dependency

The bar is high by design (invariant 5: minimal dependencies, evidence-driven
exceptions). Before adding anything, the question is whether the feature is
worth the supply-chain surface — several features here are hand-written
precisely because the answer was no.

If a library does earn its place:

1. **Vendor it.** Download the dist file, commit it under `public/vendor/`.
   Never a runtime CDN URL, never an npm runtime dependency.
2. **Allowlist the path** in `src/assets.js` if it needs to serve
   unauthenticated (anything the Se/cure tier or the sandbox touches does).
3. **Load it lazily** unless it is genuinely needed on first paint. Only
   marked and DOMPurify are eager, and that is because rendering an answer
   requires both.
4. **Record the version and SHA-256** in the comment above its loader (the
   `sandbox.js:62` and `ondevice-engine.js:20` blocks are the pattern) and add
   the hashes to §7 here in the same commit.
5. **Update this document and `docs/CODE-LAYOUT.md`'s vendor section** in that
   same commit. The mirror discipline is what keeps this file true.
6. **Check the CSP allowlist** in `src/security-headers.js` if the library
   fetches anything cross-origin, so §2.4 does not grow another entry.

For an update to an existing library, the same steps apply plus a check of the
upstream changelog against `SECURITY-RISKS.md` R-10 — DOMPurify most of all,
since it is the sole XSS defence while the CSP is off.
