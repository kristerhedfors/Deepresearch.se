---
name: execution-sandbox
description: >-
  Load when working on the experimental in-browser Linux execution sandbox and
  the bash-lite agent — the `bash_lite_mcp` knob (DRS) / `bashLite` (DRC) — or
  anything touching public/js/bash-core.js (the shared pure core),
  src/bash-agent.js (its server façade), src/bash-api.js,
  public/js/sandbox.js, public/js/bash-agent.js (the DRS driver), the
  /api/bash/step endpoint, the shell transcript in the pipeline/synthesis, the
  cross-origin-isolation (COEP) headers, or the CheerpX WASM Linux VM. Covers
  the client-orchestrated agentic loop, the fenced-block (no-function-calling)
  convention, the fail-soft contract, EN+SV intent parity, and the live
  browser verification. ALSO the go-to when the
  sandbox "refuses to run code" on a real device: the COEP must be
  `require-corp` (iOS Safari ignores `credentialless`), the `client_diag`
  browser probe + `wrangler tail` debugging playbook, the edge/PWA
  stale-code caching traps, and the 2026-07-11 incident log of failed attempts
  and the working fix.
---

# Execution sandbox (bash-lite)

An EXPERIMENTAL, opt-in, default-OFF capability: when a message "wants a
shell", a real x86 Linux boots **in the browser** (CheerpX WASM), an agentic
loop runs commands in it, and the real output feeds the answer. Present on
**both** tiers — DRS (`deepresearch.se/rver`) and DRC (`deepresearch.se/cure`).

## The load-bearing idea

The sandbox executes **client-side** (the server never runs a shell), so the
loop is **client-orchestrated**. It respects invariant 1 (NO function calling):
the model proposes commands in a plain fenced ```bash block (a text
convention), parsed by `parseShellRequest` — never a tool call. It is fully
**fail-soft**: no cross-origin isolation, a boot failure, or a loop error all
degrade to a normal answer.

**The MODEL decides whether a shell is needed — not a regex.** When the knob is
on, the loop asks the model cold on the first turn; it returns `SHELL_DONE`
immediately for anything that doesn't need a shell. So "list files", "run la
-la", and any phrasing a keyword gate would miss all work. `bashIntent`
(EN+SV, one shared implementation in `bash-core.js`) is kept only as a
non-authoritative heuristic —
it does NOT gate execution (that was the 2026-07-10 production defect:
chat_logs #200/#201 answered "I can't run code" because the regex missed the
ask and never engaged the model). The VM boots **lazily** — only once the
model actually proposes a command — so ordinary chat with the knob on pays one
cheap model call and never boots the (expensive) VM.

The answer prompts are sandbox-aware: `directPrompt`/`searchOffPrompt`/
`synthPrompt` take `hasShell`, which flips the capabilities line from "does NOT
run code" to "you DID run commands — use the output". Without this the model
denies the capability even with a transcript in front of it.

## Where each piece lives

| Concern | File |
|---|---|
| SHARED pure core (intent, parse, exec-result clamping, transcript, the per-round step user-message `buildStepUserMessage`, the generic injected-step `runShellLoop` driver, caps) | `public/js/bash-core.js` (+ `.test.js`, Swedish-parity suite) — the ONE implementation. Lives under `public/` because the browser can only import served modules while the Worker bundler (wrangler/esbuild) imports from any repo path; it is BOTH served to the browser AND bundled into the Worker. In `index.js`'s `isPublicAsset` allowlist (the /cure module graph imports it) |
| Server façade over the core | `src/bash-agent.js` (re-export ONLY — since 2026-07-11 this replaced the old hand-mirrored copy; `.test.js` pins the re-export contract so a re-implementation fails the suite) |
| Settings knob `bash_lite_mcp` | `src/settings.js` (`bashLiteEnabled`, availability = user row only, no secret) |
| Step prompt + synthesis clause | `src/prompts.js` (`bashAgentPrompt`, `synthPrompt({hasShell})`) |
| Step endpoint `/api/bash/step` | `src/bash-api.js` (one model turn on `DEFAULT_MODEL`, quota-gated, usage-recorded) |
| Pipeline consumption | `src/pipeline.js` (`ctx.shellBlock` → synthesis + direct/search-off), `src/chat.js` (`shell_transcript` request field → `state.shellTranscript`) |
| COEP / cross-origin isolation | `src/index.js` (`serveAsset(..,{coep})` sets COEP **`require-corp`** + `no-store`, strips conditional headers: DRC page always, DRS shell when the knob is on) |
| DRS client driver | `public/js/bash-agent.js` (`fetchShellStep` + the DRS-shaped `runShellLoop` — the core driver with the step wired to `/api/bash/step`; re-exports the core's pure API) |
| The CheerpX VM + terminal + exec bridge | `public/js/sandbox.js` (NOT `@ts-check` — browser/WASM glue) |
| DRS send integration | `public/js/stream.js` (`maybeRunShellLoop` before `/api/chat`, attaches `shell_transcript` + the `client_diag` probe) |
| Isolation self-heal | `public/js/app.js` (knob-on + `!crossOriginIsolated` → **navigate to a fresh `?_coep=<ts>` URL**, NOT `location.reload()`; plus a `pageshow(persisted)` bfcache handler) |
| Live diagnostic | `client_diag` `{coi,sab,sb,bl,ran,css,ua}` — `stream.js` attaches it to every `/api/chat`; `chat.js` `sanitizeClientDiag` records it in the `chat_logs` meta and logs `chat.client_diag`. The one window into the real browser (see the playbook below) |
| Stale-client rescue | `src/chat.js`: a knob-on request with **no `client_diag`** = a pre-fix cached bundle → responds `Clear-Site-Data: "cache"` (self-limiting) |
| DRS settings UI (Experimental knob) | in the Settings view (`public/js/account-settings.js` renders it via account-views.js's `renderConfigKnobs`/`wireSandboxKnob`), next to Feedback mode — since 2026-07-11 ALL configuration lives under Settings, opened from the summary's Settings button or the header's gear icon; `public/js/settings.js` accessors |
| DRC loop + prompt + knob | `public/js/drc-research.js` (`runDrcShellPass`, `drcBashAgentPrompt`), `public/js/drc-core.js` (`bashLite` state). The knob lives in the DRC **settings view** (`#settingsview` in `public/cure/index.html`, opened by the header's gear `gearbtn` → `openSettings` in `drc.js`) alongside the API keys (since 2026-07-11; the account view keeps only the no-accounts explainer) — the left drawer is chats+projects only. Plain `.toggle-track` styling (no spiderweb) in `drc.css` |

## The flow

**DRS:** `stream.js` `maybeRunShellLoop` → if `bashLiteOn()` &&
`sandboxSupported()` (NB: **no** `bashIntent` gate — the model decides) →
`runShellLoop` (each round POSTs `/api/bash/step`; the FIRST proposed command
lazily boots the `sandbox.js` VM via `execInSandbox`, results feed back) →
attach the transcript as `shell_transcript` on `/api/chat` → the pipeline
injects it into synthesis/direct as ground truth (`ctx.shellBlock`).

**DRC:** identical shape but fully client-side — `runDrcShellPass` drives the
SAME `bash-core.js` loop with a step function that calls the user's own
provider directly (parsed client-side with `parseShellRequest`, the same
shared `buildStepUserMessage`), executes in the same `sandbox.js` VM, and
folds the transcript into synthesis/direct.

## Cross-origin isolation (the tricky part)

CheerpX needs `SharedArrayBuffer` → cross-origin isolation → COOP + COEP on the
**document**. COOP `same-origin` is already site-wide (`SECURITY_HEADERS`).
COEP is added as **`require-corp`** (NOT `credentialless`). This was originally
`credentialless` to keep cross-origin subresources loading without CORP, but
**iOS Safari / WebKit does not implement `credentialless`** — it silently never
isolates, `SharedArrayBuffer` stays undefined, and the VM can't boot (confirmed
live 2026-07-11 on iOS 18.7 Safari 26.5: header served, `crossOriginIsolated
=== false`, `SharedArrayBuffer` absent). `require-corp` is honored by Chrome,
Firefox, AND Safari. Its cost: every cross-origin subresource must carry CORP —
the sandbox's CDN loads (jsdelivr xterm, cxrtnc CheerpX) already send
`Cross-Origin-Resource-Policy: cross-origin`, CORS `fetch` (DRC providers, the
Berget/Exa calls) is unaffected, and the server-fetched Maps imagery is
same-origin; the ONLY casualty is the keyless Street View Embed **iframe** (no
CORP). That's why the DRS shell only gets COEP when the knob is ON. The DRC page
is always isolated (self-contained; no cross-origin iframe to break).
`sandboxSupported()` = `window.crossOriginIsolated` is the definitive "can it
run here" check — and it is false on any browser that ignores the COEP mode, so
verify `SharedArrayBuffer` exists in the target browser. Flipping the DRS knob
reloads the page so the shell comes back isolated.

## Conventions & caps

- `bashIntent` is a non-authoritative heuristic (EN+SV parity, ONE
  implementation in `bash-core.js` since the 2026-07-11 dedup refactor) — NOT
  the execution gate. The model decides. Do NOT reintroduce it as a
  precondition for running the loop, and do NOT reintroduce a mirrored copy of
  any core function — import (or re-export) `bash-core.js`; the façade/driver
  test suites assert the exports are the SAME function objects, so a copy
  fails the tests.
- `MAX_SHELL_ROUNDS=6`, `MAX_COMMANDS_PER_ROUND=6`, output clamped to
  `MAX_OUTPUT_CHARS=4000`. The sandbox is treated as OFFLINE (no network) in
  the prompts.
- Exec marker protocol in `sandbox.js` (base64 between unique markers, a
  serialized queue) is ported verbatim from aisecurityliteracy.dev — it
  survives the shared xterm console; don't "simplify" it.

## Live verification (DONE — 2026-07-11)

Verified end to end on the real target device. On **iOS 18.7 Safari 26.5**,
knob ON, `/rver` serving `require-corp`: the live `client_diag` flipped to
`{coi:true, sab:true, sb:true, ran:1}` and `/api/bash/step` returned
`ls /` → `SHELL_DONE`; the answer listed the real Debian root. Also verified
from a fresh Chromium context (Playwright) and the break-glass admin session.
Two things to still spot-check when you touch this: the keyless Street View
Embed **iframe** (the one casualty of `require-corp`), and DRC `/cure` on the
user's own provider key.

## Debugging playbook — "the sandbox refuses on a real device"

The whole 2026-07-11 saga (see the incident log) came down to **you cannot
debug this from your own browser — you must see the target browser's state**.
The tools that actually work:

1. **`client_diag` is the single most important signal.** It rides on every
   `/api/chat` request and lands in the `chat_logs` meta, readable with
   `scripts/chatlogs --id N --json`. Fields and how to read them:
   - `bl` (knob on) `false` → the account's `bash_lite_mcp` isn't effective
     (settings/availability), fix there — nothing else matters.
   - `sab` (SharedArrayBuffer defined) `false` **and** `coi` (crossOriginIsolated)
     `false` → the page is **not isolated**. Either the browser ignores the COEP
     mode (see `ua`; **iOS Safari ignores `credentialless`** → use `require-corp`)
     or the isolated document never reached the browser (cache — see below).
   - `coi:true, sb:true, ran:0` → isolation is fine; the model returned
     `SHELL_DONE` (didn't think a shell was needed) or the VM boot failed —
     check `bash.step` and the CDN loads.
   - `ua` is the ground truth for which browser/version — never assume.
   - **`client_diag` ABSENT (logs show `null`)** → the browser is running a
     **pre-fix cached bundle** (the field didn't exist yet). This is a caching
     problem, NOT a code problem — do not "fix" the code, fix delivery.
2. **`wrangler tail deepresearch-se --format json`** is live request-level
   truth. MUST run from the repo root or pass the worker name (else "Required
   Worker name missing"). Watch `chat.client_diag`, `bash.step`
   (commands/done), and `google.start` (the exact OAuth `redirect_uri`). If the
   user is actively clicking and **nothing appears in the tail**, the edge is
   serving fully-cached responses without running the worker.
3. **Reproduce a fresh load yourself with Playwright** (`/opt/pw-browsers/chromium`,
   the proxy quirks in `tests/playwright.config.js`): a fresh context mimics a
   private tab and confirms whether the code+delivery are correct *from your
   POP* — isolating "my code is wrong" from "the user's browser/edge is stale."
   Caveat: Chromium honors `credentialless`, so it will NOT reproduce the
   iOS-Safari isolation failure — **always confirm `SharedArrayBuffer` on the
   actual failing browser.**
4. **Verify /cure ANONYMOUSLY, and use the build stamp as the liveness
   check.** An allowlist 401 anywhere in the public module graph kills the
   whole tier's JS, but an AUTHED probe (break-glass headers, a signed-in
   browser) serves every module fine and masks it completely — that is how
   /cure shipped dead on 2026-07-11 (vault.js pulled the DRS storage chain
   into the graph via drc-core.js; fixed by splitting `vault-core.js` out).
   The `#stamp` element is the tell: drc.js rewrites it to `d<N> · browser`
   at boot, so the static HTML value (e.g. `d5`) on a live page means the
   module graph never linked. When touching ANY import in a public module,
   re-run an import-closure walk of `/cure/drc.js` against `isPublicAsset`
   (a ~25-line Node script: regex the `import … from` specifiers, resolve
   recursively, diff against the allowlist) — every module in the closure
   must be public, and modules that mix public-needed pure logic with
   DRS-only imports get SPLIT (`vault-core.js`, `bash-core.js`), never
   allowlisted wholesale.

## Incident log — failed attempts, root causes, fixes (2026-07-11)

The reported symptom was always identical ("List files in / → I can't run
code"), but there were SEVEN distinct causes stacked. In rough order found:

1. **DRC `/cure` fully dark.** `drc-research.js` statically imports
   `bash-agent.js` + `sandbox.js`, which weren't in `index.js`'s
   `isPublicAsset` allowlist → both 401'd → the whole `/cure` module graph
   failed to link. Fix: allowlist both (same class as the earlier `drc-rag.js`
   miss).
2. **Exec exit codes always 0.** The marker wrapper piped stdout into `base64`
   and read `$?` after the pipe (dash → no `PIPESTATUS`), capturing base64's
   exit. Fix: redirect stdout+stderr to temp files, capture `$?` immediately,
   then base64 the files. (`sandbox.js` exec marker.)
3. **`STOP_ICON` TDZ crash.** `if (readPending()) setSendMode(true)` ran at
   module load but referenced `const` icons defined ~30 lines later → any
   reload-with-pending-answer threw "Cannot access 'STOP_ICON' before
   initialization" and killed the whole `app.js` bootstrap. Fix: move the
   consts + `setSendMode` above their first call.
4. **A transient xterm-CSS CDN miss killed the boot.** `loadCSS(xterm.css)` was
   fatal in `Promise.all`; the CSS is purely cosmetic. Fix: make it non-fatal
   (`.catch`), keep the two load-bearing scripts fatal.
5. **Untestable by the operator.** `bashLiteEnabled` required a D1 user row, so
   the break-glass admin (the only automatable identity) couldn't exercise the
   real flow. Fix: grant `isSecretAdmin` the sandbox (`settings.js`) — this is
   what made the Playwright DRS test possible.
6. **THE root cause: `COEP: credentialless` never isolates iOS Safari.** WebKit
   does not implement the `credentialless` mode, so on iPhone the page served
   the header but `crossOriginIsolated===false` and `SharedArrayBuffer` was
   undefined — the VM could never boot. Invisible on Chrome (which honors
   `credentialless`), which is why every one of my tests "passed." Fix: switch
   to **`require-corp`** (honored by Chrome, Firefox, AND Safari); the sandbox
   CDNs already send CORP, only the keyless SV embed iframe is lost.
7. **Stale-code delivery masked everything.** `/rver`, `app.js`, `stream.js`
   returned `cf-cache-status: HIT` while `no-store` — a Cache Rule force-caches
   the app at the edge and survives deploys, and an installed **iOS PWA also
   caches the launch shell on-device**. Mitigations shipped: `Clear-Site-Data`
   for stale clients, and a self-heal that **navigates to a fresh `?_coep=<ts>`
   URL instead of `location.reload()`** (reload re-serves the iOS PWA's cached
   shell). The operator-side clear is **Purge Everything** — NOT Development
   Mode (which doesn't cover Workers-assets / Cache-Rule caching).

**Dead ends that wasted time (don't repeat them):**

- "It's a missing `tools` argument / the model doesn't know it has bash." NO —
  this app has **no function calling** by design; the model learns about bash
  via `bashAgentPrompt` in the SEPARATE `/api/bash/step` call, and the real
  blocker was browser isolation. A tools array changes nothing when there's no
  isolated VM to execute in. `client_diag {coi:false, sab:false}` settled it.
- "Just reload the page." An iOS PWA relaunches a device-cached shell;
  `location.reload()` returns the same non-isolated copy. Use a fresh URL.
- "Enable Development Mode." Dev Mode bypasses the standard zone cache but NOT
  the layer caching these assets. Only **Purge Everything** clears it.
- Trusting a Chrome/Playwright pass as proof it works everywhere. The
  `credentialless`/Safari gap is invisible on Chromium. Verify
  `SharedArrayBuffer` on the actual failing browser.

**Related (not sandbox, surfaced during the same session):** Google OAuth
`redirect_uri_mismatch` — the Worker is routed on both apex and `www`, and
`redirect_uri` is built from the request host, so a `www` sign-in sent Google a
`www` callback that only a (non-matching) wildcard covered. Fixed by
canonicalizing `www → apex` (301) at the top of `route()` before anything else.
See the **access-control** skill.
