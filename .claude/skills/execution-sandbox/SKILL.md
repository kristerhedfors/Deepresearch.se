---
name: execution-sandbox
description: >-
  Load when working on the experimental in-browser Linux execution sandbox and
  the bash-lite agent — the `bash_lite_mcp` knob (DRS) / `bashLite` (DRC) — or
  anything touching src/bash-agent.js, src/bash-api.js, public/js/sandbox.js,
  public/js/bash-agent.js, the /api/bash/step endpoint, the shell transcript
  in the pipeline/synthesis, the cross-origin-isolation (COEP) headers, or the
  CheerpX WASM Linux VM. Covers the client-orchestrated agentic loop, the
  fenced-block (no-function-calling) convention, the fail-soft contract, EN+SV
  intent parity, and what still needs live browser verification.
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
(EN+SV, mirrored both sides) is kept only as a non-authoritative heuristic —
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
| Pure core (intent, parse, transcript, caps) | `src/bash-agent.js` (+ `.test.js`, Swedish-parity suite) |
| Settings knob `bash_lite_mcp` | `src/settings.js` (`bashLiteEnabled`, availability = user row only, no secret) |
| Step prompt + synthesis clause | `src/prompts.js` (`bashAgentPrompt`, `synthPrompt({hasShell})`) |
| Step endpoint `/api/bash/step` | `src/bash-api.js` (one model turn on `DEFAULT_MODEL`, quota-gated, usage-recorded) |
| Pipeline consumption | `src/pipeline.js` (`ctx.shellBlock` → synthesis + direct/search-off), `src/chat.js` (`shell_transcript` request field → `state.shellTranscript`) |
| COEP / cross-origin isolation | `src/index.js` (`serveAsset(..,{coep})`: DRC page always, DRS shell when the knob is on) |
| DRS client mirror + loop driver | `public/js/bash-agent.js` (`bashIntent`, `runShellLoop`, `parseShellRequest`/`buildShellTranscript`) |
| The CheerpX VM + terminal + exec bridge | `public/js/sandbox.js` (NOT `@ts-check` — browser/WASM glue) |
| DRS send integration | `public/js/stream.js` (`maybeRunShellLoop` before `/api/chat`, attaches `shell_transcript`) |
| DRS settings UI (Experimental knob) | `public/js/account-settings.js` (+ `public/js/settings.js` accessors) |
| DRC loop + prompt + knob | `public/js/drc-research.js` (`runDrcShellPass`, `drcBashAgentPrompt`), `public/cure/drc.js`, `public/cure/index.html`, `public/js/drc-core.js` (`bashLite` state) |

## The flow

**DRS:** `stream.js` → if `bashLiteOn()` && `sandboxSupported()` && `bashIntent(msg)`
→ boot `sandbox.js` VM → `runShellLoop` (each round POSTs `/api/bash/step`,
runs the returned commands via `execInSandbox`, feeds results back) → attach
the transcript as `shell_transcript` on `/api/chat` → the pipeline injects it
into synthesis/direct as ground truth (`ctx.shellBlock`).

**DRC:** identical shape but fully client-side — `runDrcShellPass` calls the
user's own provider directly for the step (parsed client-side with
`parseShellRequest`), executes in the same `sandbox.js` VM, and folds the
transcript into synthesis/direct.

## Cross-origin isolation (the tricky part)

CheerpX needs `SharedArrayBuffer` → cross-origin isolation → COOP + COEP on the
**document**. COOP `same-origin` is already site-wide (`SECURITY_HEADERS`).
COEP is added as **`credentialless`** (not `require-corp`) so cross-origin
subresources (Maps/Street View, CDN loads, CORS API calls) keep working — only
a rare cross-origin iframe that sends no COEP (the keyless Street View Embed
fallback) is affected, which is why the DRS shell only gets COEP when the knob
is ON. The DRC page is always isolated (self-contained; no cross-origin iframe
to break). `sandboxSupported()` = `window.crossOriginIsolated` is the
definitive "can it run here" check. Flipping the DRS knob reloads the page so
the shell comes back isolated.

## Conventions & caps

- `bashIntent` is a non-authoritative heuristic (EN+SV parity, mirrored in
  `src/` and `public/js/`, both with parity tests) — NOT the execution gate.
  The model decides. Keep the two SHELL_PATTERNS arrays in lock-step if you
  touch them, but do NOT reintroduce it as a precondition for running the loop.
- `MAX_SHELL_ROUNDS=6`, `MAX_COMMANDS_PER_ROUND=6`, output clamped to
  `MAX_OUTPUT_CHARS=4000`. The sandbox is treated as OFFLINE (no network) in
  the prompts.
- Exec marker protocol in `sandbox.js` (base64 between unique markers, a
  serialized queue) is ported verbatim from aisecurityliteracy.dev — it
  survives the shared xterm console; don't "simplify" it.

## Live verification still owed (can't be done in Node/CI)

The pure logic is unit-tested (`src/bash-agent.test.js`,
`public/js/bash-agent.test.js`) and typecheck/`npm test` are green, but the
BROWSER path only reproduces live (see the **live-verify** skill):

1. With the knob ON, confirm `/rver` serves `cross-origin-embedder-policy:
   credentialless` and `crossOriginIsolated === true` in the console.
2. Ask "run `uname -a` in the sandbox" — the terminal panel should boot Debian
   (first boot streams the disk image; slow), run the command, and the answer
   should quote the real output.
3. Confirm the Street View keyless-iframe fallback still behaves acceptably
   with the knob on (SDK path unaffected; only the keyless iframe may not load
   under isolation).
4. DRC: on `/cure`, enable the sandbox knob, ask a compute question, confirm
   the loop runs on the user's own provider key with no server call for the
   shell decision.
