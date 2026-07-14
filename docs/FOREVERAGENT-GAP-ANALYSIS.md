# Se/cure vs. Forever Agents — Gap Analysis

> What it would take for **DeepResearch.Se/cure** (the client-side tier, `/cure`,
> code-name DRC) to satisfy the Forever Agent specification at
> <https://foreveragents.dev>.
>
> Analysis date: 2026-07-14. Sources read: `forever-agents.md`,
> `local-inference.md`, `zero-infra.md`, `encryption.md`, `identity.md`,
> `threat-model.md`, `portability.md`, `supply-chain.md`, `zero-dependencies.md`,
> `mcp.md`, `deployment.md` plus the site index (`llms.txt`).
>
> This is an assessment document, not a change to product behaviour. It scopes
> **Se/cure only** — Se/rver (the signed-in hosted tier) is deliberately server-
> centric and is out of scope for the Forever Agent bar.

---

## 1. The specification in one table

The spec defines a Forever Agent as *"software that remains useful as tools,
models, and protocols change — by serving humans through verifiable
architectural properties rather than contractual promises."* Its normative core
is a priority table:

| # | Priority | Requirement | Spec detail |
|---|---|---|---|
| R1 | 🟢 MUST | Local inference | Support local inference servers (Ollama, llama.cpp, LM Studio, or equivalent) |
| R2 | 🟢 MUST | Local execution environment | Provide isolated tool execution if the agent uses tools |
| R3 | 🟢 MUST | Data sovereignty | User controls storage — no mandatory third-party persistence |
| R4 | 🟢 MUST | Verifiable privacy | Privacy claims rely on architecture, not policy |
| R5 | 🟢 MUST | Transparency | Disclose AI nature, data flows, trust boundaries |
| R6 | 🟢 MUST | Offline capability | Core operations work without an internet connection |
| R7 | 🟡 SHOULD | Zero dependencies | Minimise runtime deps; justify each; vendor, no runtime CDN |
| R8 | 🟡 SHOULD | Encrypted state | Authenticated encryption at rest |
| R9 | 🟡 SHOULD | Static-file deployable | Runs as static HTML/CSS/JS, no mandatory backend |
| R10 | 🟡 SHOULD | Portability | Transfers by URL / QR / USB / file without breaking |
| R11 | 🔵 MAY | In-browser inference | WebLLM graceful downgrade |
| R12 | 🔵 MAY | In-browser embeddings | transformers.js for local RAG |
| R13 | 🔵 MAY | In-browser execution | WebAssembly tool sandbox |
| R14 | 🔵 MAY | Edge deployment | Edge/IoT for constrained environments |

Cross-cutting domain rules also referenced below: **identity disclosure**
("say what you are, always"), the **encryption URL-fragment pattern**,
**supply-chain vendoring** ("no runtime CDN fetches"), and the **threat model**
(sanitise all rendered LLM output).

---

## 2. Scorecard

| Req | Status | One-line reason |
|---|---|---|
| R1 Local inference | ❌ **Gap** | Providers hard-wired to OpenAI/Groq/Berget (remote); no localhost/Ollama path or custom base URL |
| R2 Local execution | 🟡 **Met, with caveat** | CheerpX in-browser Linux satisfies it, but loads engine + disk from external CDNs |
| R3 Data sovereignty | ✅ **Met** | Sealed state (chats + keys) in this browser's localStorage; nothing mandatory server-side |
| R4 Verifiable privacy | ✅ **Met** | Server serves static files only; browser→provider is observable in the network tab |
| R5 Transparency | 🟡 **Partial** | Data-flow disclosure is strong; explicit AI-identity + "the provider can read this" disclosure is thin |
| R6 Offline capability | ❌ **Gap** | Whole pipeline needs a reachable remote provider; no local/in-browser model fallback |
| R7 Zero dependencies | 🟡 **Partial** | marked/DOMPurify vendored ✓; xterm + CheerpX + disk fetched from runtime CDNs ✗ |
| R8 Encrypted state | ✅ **Met** | AES-256-GCM (authenticated) + HKDF-SHA-256; keys never at rest in plaintext |
| R9 Static-file deployable | 🟡 **Partial** | `/cure` is static + direct provider calls, but not verified from `file://`; sandbox needs server COEP headers |
| R10 Portability | ❌ **Gap** | Secret + `/my/project-<hash>` exist, but no URL-fragment/QR/file export; sealed blob can't leave its origin |
| R11 In-browser inference | ❌ Absent | No WebLLM (this is optional, but it is the clean fix for R1+R6) |
| R12 In-browser embeddings | ❌ Absent | RAG embeds via remote OpenAI; no transformers.js |
| R13 In-browser execution | ✅ **Met** | CheerpX WASM x86 Linux — the one MAY-level item Se/cure already ships |
| R14 Edge deployment | 🟡 Incidental | Static assets could be edge-served; not a designed path |

**Headline:** Se/cure is architecturally *aligned* with the Forever Agent
philosophy — it already nails data sovereignty, verifiable privacy, encrypted
state, and in-browser execution, which are the hard, structural ones. It
**fails three MUST requirements (R1, R6, and partially R5)** for one shared
root cause: **inference is remote-only.** Fixing that one thing (via a local
server option and/or WebLLM) clears the biggest gaps at once. The remaining
work is portability (R10) and finishing the supply-chain/static-file story
(R7, R9).

---

## 3. MUST-level gaps (the ones that actually block the label)

### R1 — Local inference — ❌ Gap (highest priority)

**Current.** `public/js/drc-providers.js` declares exactly three providers, each
with a hard-coded remote base URL:

- OpenAI — `https://api.openai.com/v1`
- Groq — `https://api.groq.com/openai/v1`
- Berget — `https://api.berget.ai/v1`

They were chosen specifically because they serve browser CORS. There is **no
localhost entry, no Ollama/llama.cpp/LM Studio option, and no custom-base-URL
field** in the settings drawer (`public/cure/index.html` → `#keyspanel`). The
spec makes a local OpenAI-compatible server the *baseline* MUST — the exact API
shape (`POST /v1/chat/completions`) Se/cure already speaks.

**Gap.** Se/cure cannot run against inference the user controls. Every answer
requires shipping the conversation to a third-party API.

**Adaptation.**
1. Add a fourth provider entry `{ id: "local", label: "Local (Ollama/llama.cpp/LM Studio)", base: "http://localhost:11434/v1", … }` plus a **user-editable base-URL field** so any OpenAI-compatible endpoint works (LM Studio `:1234`, llama.cpp `:8080`). No key required for the baseline (`keyPattern` optional).
2. Ship a live "detect a local server first" probe on the settings panel (`GET {base}/models`) so the UI can say *"local model found — running fully on your device."*
3. Document the two real browser constraints, because they bite here:
   - **Mixed content:** an `https://deepresearch.se` page calling `http://localhost` is generally allowed (localhost is a *potentially-trustworthy* origin) but is worth verifying per-browser; the `file://` and local-static-server deployment modes (R9) sidestep it entirely.
   - **CORS:** Ollama needs `OLLAMA_ORIGINS` set to allow the page's origin; llama.cpp/LM Studio expose permissive CORS. Surface this as a one-line setup hint on the panel.
4. Keep the split-model-routing invariant: the local server can serve *both* the JSON planning phases and synthesis, so `jsonModel` should fall back to the same local model.

This is the single most valuable change — it converts Se/cure from "private
transport to someone else's model" into "your model, your device."

### R6 — Offline capability — ❌ Gap

**Current.** The pipeline (`drc-research.js`) is fully client-side, but every
phase calls a remote provider. RAG embeds via remote OpenAI. The sandbox
(R13) streams its Debian image over `wss://disks.webvm.io` and pulls the
CheerpX engine from a CDN. Nothing works air-gapped.

**Gap.** Fails the "core operations functional without internet" MUST outright.

**Adaptation.** R6 is a *consequence* of R1/R11, not a separate build:
- With **R1 (local server)** the chat/research core works offline the moment a local model is reachable — the only network traffic is `localhost`.
- **R11 (WebLLM)** would make it work with *no server at all* after first model download.
- Add a **service worker** for `/cure` that precaches the app shell (HTML/CSS/JS/vendored libs) so the UI itself loads offline. There is none today (confirmed: no `serviceWorker`/manifest registration in the `/cure` graph).
- For the sandbox to be offline-capable, the engine and a minimal disk image would need to be self-hosted (see R7) — a larger, separable effort.

### R5 — Transparency — 🟡 Partial

**Current.** *Data-flow* transparency is genuinely strong and better than most:
the intro pane, ghost bubble, and settings copy all state plainly that keys and
chats stay in this browser and the server is never in the path. DOMPurify
sanitisation is in place (threat-model compliance).

**Gaps against `identity.md`.**
1. **No explicit AI-identity disclosure** at conversation start. The spec wants *"I'm an AI agent built to help with [purpose]"* and an immediate honest answer to "are you AI?". Se/cure's empty state describes the *tool* but the assistant never introduces itself as an AI with bounded memory.
2. **The irreducible boundary is underplayed.** The threat model calls the LLM-provider boundary "irreducible for remote inference." Se/cure says the *site's* server can't read your chat — true — but a first-time user may not register that **OpenAI/Groq/Berget do receive the full conversation**. That should be said as plainly as the "our server can't see it" claim.

**Adaptation.**
- Add a one-line AI identity + capability disclosure to the empty/first-turn state (and answer "are you AI?" honestly — already true of an LLM, just make it explicit).
- Add a short, honest "where your words go" line near the model picker: *"Your messages go to the provider you chose ({provider}); they can read them. This site cannot."* Pairs with the R1 win: with a local model that line becomes *"nothing leaves this device."*
- Optional but on-spec: the `[Generated by AI agent]` provenance marker on exported/published research (the `/cure/<slug>` replays).

---

## 4. SHOULD-level gaps

### R10 — Portability — ❌ Gap (biggest SHOULD miss)

**Current.** A project is sealed under a `DR1-…` secret and reachable at
`/my/project-<hash>`; the form is wired for password-manager capture. But the
sealed blob lives in **one browser's localStorage** and the derivation is only
a *reference*, not a *carrier* — there is **no export/import, no QR, no
file, and no URL-fragment** carrying the state. Cross-device is explicitly
punted to Se/rver.

**Gap.** The spec's central portability pattern — *"a shareable link can carry
encrypted config state"*, QR export/import, file/USB transfer, *"assume the
recipient has only a browser"* — is absent. Today, moving a Se/cure project to
another device is impossible without re-typing everything.

**Adaptation.**
1. **Encrypted file export/import** of the sealed state (it is already one AES-GCM blob — write it to a `.drc` file and re-import). Lowest effort, biggest win; also gives users a backup against localStorage eviction.
2. **URL-fragment carry** (the `encryption.md` pattern): put the encrypted blob after `#` so it never hits the server; the page decrypts client-side with the secret. This is exactly the architecture the spec describes and Se/cure already has the crypto for it (`vault-core.js`).
3. **QR export/import** for the link or a compact config, per `portability.md`. Needs a small vendored QR lib (keep it in `/vendor`, R7).

### R7 — Zero dependencies / supply chain — 🟡 Partial

**Current.** Renderer libs are vendored and served locally: `/vendor/marked.min.js`,
`/vendor/purify.min.js`, plus `pdf.js`, `jsPDF`. Good — matches the vendoring rule.
**But the sandbox violates it:** `public/js/sandbox.js` loads at runtime from
external CDNs —
- `https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0` (+ fit addon)
- `https://cxrtnc.leaningtech.com/1.2.6/cx.esm.js` (CheerpX engine)
- `wss://disks.webvm.io/…ext2` (the Linux disk)

The spec is explicit: *"no runtime CDN fetches"*, vendor everything, pin +
hash-verify, zero drift.

**Adaptation.**
- **Vendor xterm + the fit addon** into `/vendor` and pin with a recorded SHA-256 (small, straightforward).
- **CheerpX + the disk** are the hard exception: large, and the disk is a streamed remote image. Document it as an *accepted, disclosed exception* in `SECURITY-RISKS.md` (it's already noted there as a vendored-vs-CDN item) and, where feasible, self-host the engine build behind the same origin. The disk-streaming model is inherent to WebVM; treat it as an explicit capability-layer choice, not a silent dependency.
- Everything else already complies — keep the "dependency count is a security metric" discipline when adding the QR lib (R10) and any WebLLM/transformers.js (R11/R12).

### R9 — Static-file deployable — 🟡 Partial

**Current.** `/cure` is served as static assets and all model calls go direct
from the browser, so the *shape* is right. But: module `src`/`href` paths are
absolute (`/cure/drc.js`, `/vendor/…`), it has never been verified from
`file://`, and the sandbox needs the cross-origin-isolation **COEP/COOP headers
the Worker injects** — so at least the sandbox path is not backend-independent.

**Adaptation.**
- Test the core chat flow from a clean `file://` and a bare `python3 -m http.server`; switch to relative asset paths where needed so the app boots with no origin services (spec's explicit test: *"Test from `file://` and local static server to verify baseline independence"*).
- Accept that the **sandbox (R13) requires COEP headers** and therefore a header-capable static host — scope R9 compliance to the *core research app*, and document the sandbox as a header-dependent enhancement.

---

## 5. MAY-level items (optional, but two of them are the clean fix)

- **R11 In-browser inference (WebLLM)** — *Absent.* Not required, but adding it is the tidiest way to satisfy **R1 and R6 with zero server**: detect local server → WebLLM → remote, exactly the `local-inference.md` fallback ladder. Run it in a Web Worker (spec guidance) and disclose first-load model size.
- **R12 In-browser embeddings (transformers.js)** — *Absent.* RAG currently embeds via remote OpenAI (`drc-providers.js` `embed`). A `transformers.js` `all-MiniLM-L6-v2` path would keep sensitive document retrieval fully local and remove the "Groq/Berget have no embeddings → no RAG" limitation.
- **R13 In-browser execution (WASM)** — ✅ **Already shipped.** CheerpX x86 Linux with a guarded, client-orchestrated bash loop. This is the standout — most agents never get here. (Its only debts are R7 vendoring and R6 offline.)
- **R14 Edge deployment** — *Incidental.* Static assets are edge-servable; nothing to build, worth a note in deployment docs.

---

## 6. What Se/cure already does right (don't regress these)

- **R3 Data sovereignty / R4 verifiable privacy** — the server-is-not-in-the-path architecture is the real thing, observable in the network tab, not a policy promise. This *is* the Forever Agent thesis.
- **R8 Encrypted state** — AES-256-GCM authenticated encryption, HKDF-SHA-256 key hierarchy from a 160-bit CSPRNG secret, keys sealed inside the blob, never plaintext at rest. Exceeds the SHOULD. (Spec suggests XSalsa20-Poly1305/TweetNaCl but explicitly accepts correct AES-GCM — Se/cure qualifies.)
- **Threat-model hygiene** — DOMPurify sanitisation of rendered LLM output; no server sessions/logs to leak; the web-search grant is a bounded, opt-in, disclosed capability layer (consistent with "remote services are optional enhancements").
- **R13 in-browser execution** — as above.

---

## 7. Prioritised adaptation roadmap

Ordered by (MUST-first) × (effort). One change (local inference) clears the
most ground.

1. **Add local + custom-base-URL inference** (R1, and thereby R6 partial, R5 partial). *Small–medium.* One provider entry + a base-URL field + a local-server probe + CORS/setup hints. **Do this first.**
2. **Encrypted export/import of sealed state — file, then URL-fragment, then QR** (R10). *Small→medium, incremental.* Reuses existing crypto.
3. **AI-identity + provider-visibility disclosure** (R5). *Small.* Copy changes to the empty state and model picker.
4. **Service worker app-shell precache for `/cure`** (R6). *Small.* Makes the UI load offline; pairs with R1 for a truly offline core.
5. **Vendor xterm/fit; document CheerpX+disk as a disclosed exception** (R7). *Small for xterm; policy note for the rest.*
6. **Verify + fix `file://` / bare-static-server boot for the core app** (R9). *Small–medium.* Relative paths; scope the sandbox out as header-dependent.
7. **(Optional) WebLLM fallback** (R11 → completes R1/R6 with zero server). *Medium.* The most "Forever Agent" enhancement available.
8. **(Optional) transformers.js local embeddings** (R12). *Medium.* Local RAG for all providers.

**Bottom line:** Se/cure is roughly two MUST-level features away from meeting
the Forever Agent bar — **local inference (R1)** and the **offline capability
(R6)** it unlocks — plus **portability (R10)** to satisfy the SHOULD tier. The
structural hard parts (sovereignty, verifiable privacy, encrypted state,
in-browser execution) are already done.
