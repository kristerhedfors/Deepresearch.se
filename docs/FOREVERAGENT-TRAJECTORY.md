# Se/cure → Forever Agent — Trajectory & Foundational Plan

> The multi-phase path for evolving **DeepResearch.Se/cure** (`/cure`, code-name
> DRC) into a spec-compliant **Forever Agent** (<https://foreveragents.dev>),
> and the **integration points** each phase hooks into.
>
> Companion to `docs/FOREVERAGENT-GAP-ANALYSIS.md` (the *where we stand*).
> This doc is the *where we're going and how it wires in*. It is planning, not
> a behaviour change. Scope: **Se/cure only** — Se/rver stays server-centric by
> design.

---

## 1. The trajectory at a glance

Five milestones. Each has a **definition of done** tied to specific spec
requirements (R1–R14 from the gap analysis), and each is shippable on its own —
the site is never left half-migrated.

| Milestone | Theme | Clears | DoD (observable) |
|---|---|---|---|
| **M0** | *Baseline* (today) | R3, R4, R8, R13 | Sovereign storage, verifiable privacy, encrypted state, in-browser exec already hold |
| **M1** | **Own the model** | **R1**, → R5 | User can point Se/cure at a local/custom OpenAI-compatible endpoint; network tab shows `localhost` only |
| **M2** | **Run offline** | **R6**, R9 | App shell + core research work with no internet when a local model is reachable |
| **M3** | **Carry it anywhere** | **R10** | Sealed project exports/imports as file → URL-fragment → QR, on any browser |
| **M4** | **Zero-server option** | R11, R12 | Optional WebLLM + transformers.js: research runs with *no* provider account at all |
| **M5** | **Full sovereignty** | R7 (fully), R14 | Every runtime asset same-origin/vendored; sandbox disk optionally fully local; edge-servable |

Plus a **continuous Track-A** running alongside from day one: the **disclosures**
(identity + data-flow, R5) and **decision records** (accepted exceptions). These
are cheap and are themselves the R5 MUST — they don't wait for a milestone.

```
M0 ─ baseline (done)
      │
      ├── Track A (disclosures / decision records) ──────────────► continuous
      │
      ▼
M1 own-the-model ──► M2 offline ──► M3 portable ──► M4 zero-server ──► M5 sovereign
        (R1)           (R6,R9)        (R10)          (R11,R12)         (R7,R14)
```

Dependency notes: **M2 depends on M1** (offline core needs a local model). **M4
subsumes part of M1/M2** (WebLLM is a second way to get a local model) but is
heavier, so it comes after the local-server path proves the seams. **M3, M5 are
independent** of the inference work and can interleave.

---

## 2. Invariants to preserve (do not regress these while migrating)

Every phase must hold these — they are the load-bearing constraints of the
codebase and the privacy model (see `CLAUDE.md` → Load-bearing invariants):

1. **Server is in NO DRC data path.** New capability layers (web-search grant is the *only* sanctioned exception) must keep model/keys/conversation browser↔provider only. A local-inference endpoint is `localhost` — still not this server.
2. **No function calling in the deterministic pipeline** — except developer-mode's tool loop (`runDrcSourceTools`). Local/WebLLM providers must serve the same JSON-mode + streamed-completion phases.
3. **Split model routing.** JSON planning phases run on the provider's fixed `jsonModel`; only synthesis runs on the user's chosen model. A local provider must supply both.
4. **Fail-soft helpers.** RAG, web search, sandbox, embeddings all degrade to a lesser result, never an error. New paths (local-server probe, WebLLM load, export/import) follow suit.
5. **The `/cure` module-graph 401 rule.** Nothing in the `/cure` graph may statically import a non-public module — a single 401 kills the whole tier (the 2026-07-11 `vault.js`→DRS-stack incident). New modules import `vault-core.js`/pure cores only, and must be added to `isPublicAsset` in `src/assets.js`.
6. **Frozen crypto/derivation constants.** `drc-core.js`'s HKDF info strings and `DRC_STATE_KIND` are frozen — changing them silently breaks every existing secret and sealed state. New state fields are additive (bump `DRC_STATE_V`, extend `migrateDrcState`), never a re-key.
7. **Vendoring discipline (R7).** Any new runtime lib (QR, WebLLM, transformers.js) is vendored into `/vendor`, pinned, hash-recorded — never a runtime CDN fetch.
8. **EN+SV parity** for any new deterministic intent gate (invariant 6). Unlikely to bite here, but applies if a new knob adds phrase routing.

---

## 3. Integration points (the seams, by subsystem)

The good news the code review surfaced: **most of the plumbing already exists.**
The pipeline is provider-agnostic and already threads a `baseUrl` override; the
storage layer is an injectable blob store; the settings toggles have a clean
pattern. Below, each seam with the exact file/symbol and what each milestone
adds.

### 3.1 Provider registry — `public/js/drc-providers.js`

The central seam for **M1 (local), M4 (WebLLM/transformers.js)**.

- `DRC_PROVIDERS` — one declarative entry per provider (`id`, `label`, `base`, `keyPattern`, `jsonModel`, `fallbackModels`, `modelFilter`, `params`, optional `embed`).
- `drcProvider(id)`, `detectDrcProvider(key)`, `configuredDrcProviders(keys)`, `drcEmbedProvider(keys)`.
- Wire fns: `drcChatStream(provider, key, model, msgs, {baseUrl})`, `drcCompleteJson(…, {baseUrl})`, `listDrcModels(provider, key, {baseUrl})`, `drcEmbed(…)`. **All already accept a `baseUrl` override** — this is why M1 is mostly a registry + UI job, not a plumbing job.

**M1 adds:** a `local` entry, e.g.
```js
{ id: "local", label: "Local (Ollama / llama.cpp / LM Studio)",
  base: "http://localhost:11434/v1", keyPattern: null,
  jsonModel: null /* = use the chosen model for JSON too */,
  fallbackModels: [], modelFilter: () => true,
  params: (n) => ({ max_tokens: n }) }
```
Plus a **user-editable base URL** persisted in state (§3.3).

**Seam nuance — "configured" semantics.** `configuredDrcProviders` decides a
provider is available iff `keys[p.id]` is a non-empty string. A local provider
has *no key*. Either (a) store a sentinel key for `local`, or (b) generalise
"configured" to "has a key **or** is keyless-with-a-base-url". Prefer (b) — it's
the honest model and keeps `refreshModels`/the dropdown working unchanged.

**M4 adds:** WebLLM and transformers.js as provider entries whose wire fns call
the in-browser engine instead of `fetch` — the pipeline downstream never
changes. `drcEmbed` gets a `local`/`webllm` embed entry (R12), removing the
"Groq/Berget → no RAG" limit.

### 3.2 Pipeline injection — `public/js/drc-research.js`

`runDrcResearch({ providerId, apiKey, model, …, baseUrl })` (line 443) resolves
`provider = drcProvider(providerId)` and passes `baseUrl` down to every wire
call. **Provider-agnostic already** — no phase logic changes for M1/M4. The only
edit is upstream: the **send path must pass `baseUrl`** (§3.3).

For **M4**, the injected engine is selected the same way the `webSearch` fn is
injected today (an optional callable), so the pattern is established.

### 3.3 State, crypto & wiring — `public/js/drc-core.js` + `public/cure/drc.js`

- **State shape:** `emptyDrcState()` / `validateDrcState()` / `migrateDrcState()` in `drc-core.js`. New fields are additive: **M1** → `localBaseUrl` (and maybe `inferenceMode`); **M5/P8** → `offlineDisk: bool`. Bump `DRC_STATE_V`, extend `migrate`, keep validation lenient (older blobs must still open — invariant 6).
- **Sealing:** `sealDrcState`/`openDrcState` (AES-GCM) — unchanged; new fields ride inside the same blob for free.
- **Settings toggles (the pattern to copy):** `drc.js` wires `$("bashlite")` / `$("devmode")` as `change` → set `state.X` → seal. **M1** adds a base-URL text input + a local-server "detected ✓" note beside it; **M5** adds the offline-disk toggle — all the same shape (`public/cure/index.html` `#settingsview`).
- **Model dropdown:** `refreshModels()` (line 764) builds `provider::model` option values from `configuredDrcProviders`. Once "configured" includes `local` (§3.1), the local models list appears with no other change. `listDrcModels` probes `GET {base}/models` and falls back to a static list — reuse it as the **local-server detection probe** (M1's "local model found" affordance).
- **Send path:** `runDrcResearch(...)` call (line 1273) — **add `baseUrl: providerId === "local" ? state.localBaseUrl : undefined`**. One line; the rest is inherited.
- **Key panel:** `saveKeys` / `#keyspanel` — for `local`, hide the key field, show the base-URL field instead (provider auto-detect already keys off prefixes; `local` is chosen explicitly).

### 3.4 Portable storage — `public/js/drc-store.js` + `drc-core.js`

The seam for **M3 (R10)**. `drc-store.js` is an injectable blob store:
`putSealedProject` / `getSealedProject` / `deleteSealedProject` /
`listSealedProjects(blobId, bytes, backend)`. The stored value is *already the
sealed AES-GCM blob* — so transport is just moving those bytes.

- **Export:** `getSealedProject(blobId)` → bytes →
  - **file:** `Blob` download (`project-<refHash>.drc`). Lowest effort, also a backup against localStorage eviction.
  - **URL fragment:** `#` + base64(bytes) — never sent to the server (`encryption.md` pattern). Decrypt client-side with the secret.
  - **QR:** encode the link (needs a **vendored** QR lib — invariant 7).
- **Import:** read file/fragment → `openDrcState(bytes, blobKey)` where `blobKey` comes from `deriveDrcProfile(secret)` → `validateDrcState` → `putSealedProject`. Import on another device **requires the secret** — which is the zero-knowledge point, and 1Password/Apple Passwords already hold it.
- **Deep-link handlers** in `drc.js` (`handleProjectLink`/`handlePublicationLink`, the `/my/project-<hash>` + `?continue=` routing) are where a `#`-fragment import handler slots in beside the existing recognizers.

### 3.5 Sandbox assets — `public/js/sandbox.js`

The seam for **M5/P4/P8 (R7 + offline sandbox)**.

- Constants: `XTERM_CDN`, `XTERM_FIT_CDN`, `CHEERPX_CDN`, `DISK_URL`, `IDB_CACHE_ID`.
- Device stack (line 608): `CloudDevice.create(DISK_URL)` (remote, lazy) + `IDBDevice.create(IDB_CACHE_ID)` (local block cache) + `OverlayDevice.create(...)`. **Read blocks already persist locally** — see gap analysis R7/R13.
- **P4:** point `XTERM_CDN`/`XTERM_FIT_CDN` at vendored `/vendor/xterm/…`; self-host `CHEERPX_CDN` (pending Leaning Technology license — an **open decision**, §5).
- **P8:** an opt-in "download full image" action force-reads the whole `CloudDevice` to fill the IDB cache — **desktop-only guidance** (iOS quota/eviction, and the existing iOS `/workspace` IndexedDB stall, `docs/MAINTENANCE-OWNERS.md`).
- COEP note: the sandbox needs cross-origin isolation (server-set COOP/COEP) — so the sandbox path is **not** `file://`-independent; M2/R9 compliance is scoped to the *core research app*, not the sandbox.

### 3.6 Offline shell — **new** service worker (M2/R6/P3)

No service worker exists in the `/cure` graph today. **M2 adds** `public/cure/sw.js`
precaching the app shell (HTML/CSS/JS + `/vendor/*`), registered from `drc.js` boot.

- **Add to `isPublicAsset`** (`src/assets.js`) and mind the **cache/build-stamp discipline** (the `cache-helper` skill: the `d`-stamp on `/cure`, the CSS↔JS handshake) so the SW never pins a stale graph.
- **COEP interaction (critical):** the SW must **preserve the cross-origin-isolation response headers** the Worker sets (`security-headers.js`), or the sandbox loses `SharedArrayBuffer`. Serve cached responses with the same COOP/COEP headers. This is the one genuinely fiddly bit of M2 — validate live.

### 3.7 Disclosures — `public/cure/index.html` + `drc.js` (Track A / R5)

- Empty state (`#chat .empty`) and intro pane (`#intro`) — add the AI self-intro.
- Model picker row (`#model` / `#search-row`) — add the "your words go to {provider}; they can read them, this site can't" line, flipping to "nothing leaves this device" when `providerId === "local"`/WebLLM.
- Decision records land in `SECURITY-RISKS.md` (sandbox CDN exception) and this doc (`file://` scope, license question).

---

## 4. Sequencing & effort (the build order)

| Phase | Do | Seams touched | Effort | Unblocks |
|---|---|---|---|---|
| **Track A** | D1 identity/data-flow copy; D2 sandbox-exception record; D3 `file://` scope note | §3.7, `SECURITY-RISKS.md` | XS | R5 immediately |
| **M1** | `local` provider + base-URL state + send-path `baseUrl` + "configured" generalisation + local-server probe | §3.1, §3.2, §3.3 | S–M | M2 |
| **M2** | service worker app-shell precache (COEP-safe) | §3.6, `src/assets.js` | S | offline core (with M1) |
| **M3** | export/import: file → URL-fragment → QR (vendored lib) | §3.4, deep-link handlers | S→M incremental | portability |
| **M4** | WebLLM provider (Web Worker) + transformers.js embeddings | §3.1, §3.2 | M | zero-server |
| **M5** | vendor xterm; self-host engine (license); opt-in full-disk; edge-serve note | §3.5 | S–M + decision | full R7 |

**Fast path to "meaningfully a Forever Agent":** Track A → M1 → M2. That clears
R5, R1, and R6 (the three MUST gaps) and needs only the provider-registry,
one-line send-path, and service-worker seams — all of which already have their
plumbing in place.

---

## 5. Open decisions (need an owner call before their phase)

1. **CheerpX engine license (M5/P4).** Can `cx.esm.js` be self-hosted same-origin under Leaning Technology's terms? If not, the engine stays a disclosed CDN exception and full R7 is unreachable for the sandbox only. *The disk is Debian — redistributable.*
2. **`http://localhost` from `https://` (M1).** Confirm per-browser that a localhost call from the deployed HTTPS origin isn't mixed-content-blocked (localhost is usually a *potentially-trustworthy* origin). If it is anywhere, the `file://`/local-static deployment (R9) is the escape hatch — which M2/M5 provide anyway.
3. **"Configured provider" semantics (M1).** Generalise to keyless-with-base-url (recommended) vs. store a sentinel key. Affects `configuredDrcProviders` and the dropdown.
4. **State migration (M1/M5).** New fields are additive and lenient — confirm the `DRC_STATE_V` bump + `migrateDrcState` default for `localBaseUrl`/`offlineDisk` before shipping (older blobs must open unchanged).
5. **SW × COEP (M2).** Validate live that cached responses keep cross-origin isolation intact for the sandbox. If it's too fragile, ship the SW for the core shell and *exclude* sandbox assets from it.

---

## 6. Testing strategy per phase

Matches the repo's existing discipline (Node `node:test` for pure logic + live
verification for anything touching a provider/DOM/WASM — the `live-verify` skill):

- **M1:** unit-test the `local` registry entry + generalised `configuredDrcProviders` (extend `drc-providers.test.js`); live-probe against a real Ollama (`ollama serve`) with the network tab showing `localhost` only.
- **M2:** live-verify offline (DevTools "Offline") the shell loads and, with a local model, a research run completes; assert the sandbox still gets `SharedArrayBuffer` (COEP intact).
- **M3:** unit-test the export→import round-trip through `drc-store.js` + `drc-core.js` (bytes-identical, wrong-secret rejects, tamper detected — mirrors the existing `drc-core`/`vault` suites); live-verify a real cross-browser file/QR transfer.
- **M4:** unit-test the WebLLM/transformers.js provider entries over a mock engine (the `drc-providers.test.js` mock-HTTP pattern); live-verify a full zero-key run.
- **M5:** hash-record vendored assets; live-verify sandbox boot from vendored xterm + (if licensed) self-hosted engine; desktop full-disk prefetch.

---

## 7. Bottom line

The trajectory is **five shippable milestones**, but the compliance weight is
front-loaded: **Track A + M1 + M2** clear every MUST gap, and they land on seams
that already exist — a provider-registry entry, a one-line `baseUrl` on the send
path, and a service worker. Everything past that (portability, zero-server,
full vendoring) is genuine Forever Agent *polish* on an architecture that is
already sovereign, verifiable, encrypted, and capable of in-browser execution.
