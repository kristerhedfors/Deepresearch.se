---
name: execution-sandbox
description: >-
  Load when giving a generated agent pair a REAL shell — an in-browser x86
  Linux VM (WASM) the assistant runs commands in, with the sandbox being the
  user's own browser — or when touching any part of that capability: the
  client-orchestrated fenced-block shell loop, the shared bash pure core and
  its server façade, the one-step decision endpoint, the exec bridge's
  marker+base64 envelope codec, cross-origin isolation (COOP/COEP), file
  mounts into the VM, the outbox deliverables flow, boot observability, or
  the agent-activity backdrop. Also load when a generated pair's sandbox
  "refuses to run code" on a real device — this skill carries the reference
  implementation's full incident history (iOS COEP, boot races, IDBDevice
  wedges, stale-cache masking) so it is diagnosed, not re-discovered.
---

# Execution sandbox — an in-browser Linux VM as the assistant's shell

Give the pair an EXPERIMENTAL, opt-in, default-OFF capability: when a message
wants a shell, a real x86 Linux boots **inside the user's browser** (a WASM
x86 virtualizer such as CheerpX), an agentic loop runs commands in it, and
the real output feeds the answer as ground truth. The privacy story is the
point: the sandbox IS the user's device — code, attached files, and command
output never leave the browser; the server (if any) only ever decides *which
command to try next*, never executes anything and never receives file bytes.

## Capability class & tier story

**Class X — shared substrate.** One pure core under the client tree holds
every piece of logic both tiers need (intent heuristic, shell-request
parsing, result clamping, transcript/step-message builders, the envelope
codec, the generic injected-step loop driver); the server imports it through
a re-export façade (PA-7). The VM itself always runs client-side on BOTH
tiers — what differs is who answers "what command next":

- **The server tier** POSTs the transcript-so-far to a one-step decision
  endpoint that runs ONE model turn on the fixed reliable model
  (quota-gated, usage-recorded, fail-soft: any failure returns `done` so
  the client stops cleanly and answers normally).
- **The client tier** asks the user's own browser-direct provider the same
  step question with the same shared prompt/message builders — the server is
  in no data path at all, holding the tier's structural promise.

Both tiers gate the capability behind a user-visible knob (default OFF,
"experimental" posture) and degrade to a normal answer whenever the sandbox
is unsupported, fails to boot, or errors mid-loop.

## Contracts

- **PA-1** — the loop uses NO function calling: the model proposes commands
  in a plain fenced ```bash block (a text convention parsed by the pure
  core), so any model in any catalog can drive a shell. The one sanctioned
  extension: a tool-capable client-tier dev-mode loop may add a native
  `run_bash` tool (see the introspection-help skill), leaving the fenced
  path intact as the universal fallback.
- **PA-2** — everything fails soft: no isolation → normal answer; boot
  timeout → normal answer; a wedged exec → the VM is discarded, the command
  returns a timeout exit code, synthesis still runs on the transcript so far.
  The sandbox must never break or hang a chat.
- **PA-4** — code and files never leave the device; only the step *question*
  (transcript text) crosses to the server tier's decision endpoint, and only
  structured telemetry (stages, counters — never file contents) reaches logs.
- **PA-6** — the "wants a shell" intent heuristic carries all supported
  languages with equal breadth and a parity unit suite — but see the Build
  plan: it must never be the execution gate.
- **PA-7** — the pure core is written ONCE under the client tree (browsers
  can only import served modules; the worker bundler imports from anywhere);
  the server façade is a pure re-export whose "surface IS the core" contract
  is pinned by a unit test, so a hand-mirrored copy fails the suite.
- **PA-10** — the VM glue is browser/WASM code with no Node unit test;
  every change to boot/exec is verified live on a real device (the reference
  regressed twice in one day from unverified edits).

## Build plan

1. **The shared pure core** (client tree, Node-tested, dependency-free).
   One module exporting: `bashIntent` (the EN+SV-parity heuristic —
   non-authoritative), `parseShellRequest` (extract fenced ```bash blocks +
   the `SHELL_DONE` sentinel), `normalizeExecResult`/`formatShellResult`
   (clamp output to caps — reference: 6 rounds, 6 commands/round, 4000 chars
   output, 2000 chars command), `buildShellTranscript` (the labeled block
   synthesis consumes), `buildStepUserMessage` (the per-round step question
   both tiers send), and `runShellLoop` — a generic driver taking injected
   `step`/`exec`/`ensureReady` functions plus wall-clock and round caps.
2. **The exec bridge codec, in the same core.** The VM's console is shared
   with interactive output, so command results ride a marker protocol:
   `execEnvelope(command, id)` wraps the command so stdout+stderr are
   redirected to temp files, **the exit code is captured immediately —
   BEFORE any pipe** — then the files are base64'd between unique markers;
   `parseExecEnvelope`/`concatChunks`/`base64ToBytes` decode the stream.
   Also here: `isExportablePath` — the policy for which guest paths may ever
   leave the VM (the outbox dir plus explicit user asks, nothing else).
3. **The server façade.** A server module that is a pure re-export of the
   core, plus a unit test asserting the exported names are the SAME function
   objects as the core's (identity check, not behavioral mirror).
4. **The VM glue module** (client tree, deliberately NOT type-checked or
   Node-unit-tested — browser/WASM glue, but keep it import-safe in Node by
   guarding every browser global). Responsibilities: staged boot
   (`bootVM`) with a per-stage status vocabulary, a serialized exec queue
   (`execInSandbox`) driving the envelope codec, a boot timeout (~90 s) and
   an exec timeout (~30 s) that both discard the VM and fail soft, and the
   **honest-readiness guard**: if the VM was torn down between reaching
   "ready" and the end of boot, boot returns false — "boot resolved true"
   must be equivalent to "a live VM exists".
5. **Cross-origin isolation.** The VM needs `SharedArrayBuffer` → the
   document needs COOP `same-origin` + COEP **`require-corp`** (NOT
   `credentialless` — iOS Safari silently ignores it; see Pitfalls). Serve
   COEP on the client tier's page always (it is self-contained) and on the
   server tier's shell only when the knob is on (COEP breaks CORP-less
   cross-origin iframes). `crossOriginIsolated` is the definitive support
   check. Add the **first-paint self-heal**: mirror the knob into
   localStorage so a knob-on page that arrives non-isolated navigates to a
   fresh cache-busting URL synchronously at first paint (never
   `location.reload()` — an installed PWA re-serves its cached shell), with
   a sessionStorage one-shot guard against loops and a bfcache
   (`pageshow(persisted)`) retry.
6. **The step endpoint (server tier).** One POST route: transcript in, one
   model turn on the fixed reliable model with the shell-agent prompt,
   quota-gated before spend, usage recorded, any failure returns `done`.
   The client driver wires `runShellLoop`'s `step` to it; the client tier
   wires `step` to the user's own provider instead — same prompt builders.
7. **Lazy boot + model-decides.** The loop asks the model cold on the first
   turn; the VM boots only when the model actually proposes a command, so
   ordinary chat with the knob on pays one cheap model call and never boots
   the VM. `bashIntent` must NOT gate execution (see Pitfalls #1).
8. **Prompt awareness.** The answer prompts take a `hasShell` flag that
   flips the capabilities line from "does NOT run code" to "you DID run
   commands — use the output". Without it the model denies the capability
   with a transcript in front of it. The transcript rides the chat request
   as one field the server sanitizes and injects into synthesis.
9. **File mounts into the VM.** A pure planning core (sanitize names,
   dedupe, per-file/total byte caps, a manifest file, a seed script builder,
   shell escaping) + device mounts in the glue: host bytes enter via a
   direct-byte host→guest device (flat, files at device root — never depend
   on nested-dir auto-creation), then a boot seed script `cp`s them into
   plain directories of the **root overlay filesystem** (`/workspace` for
   session files, one dir per project with a friendly no-hash symlink).
   Persistence is the overlay's own IndexedDB layer — do NOT mount separate
   per-volume persistent devices (see Pitfalls #3). Session files refresh
   each boot; project files copy add-only so guest edits survive. The
   provider callback is invoked ONCE inside the lazy boot, so a no-shell
   message never loads or decrypts file bytes.
10. **The outbox deliverables flow (files OUT).** Guest convention: the
    agent copies finished artifacts into `/workspace/outbox` (taught in the
    step prompt; the agent `mkdir -p`s it). Host side, after the loop and
    only if some command mentioned the outbox path: ONE listing exec parsed
    by a pure basename-only parser (a crafted path can't escape) with
    file-count and byte caps, then each file exported via the
    base64-through-exec round trip. UI renders download chips with an
    add-to-project menu; a synthetic transcript entry ("deliverables
    collected") is appended so synthesis refers to the attachments by name
    instead of pasting contents — it rides the existing transcript contract,
    zero new API fields.
11. **Boot observability.** Structured, namespaced client events buffered
    and beaconed to a server client-log endpoint: `boot_start`, one
    `boot_stage` per stage (the staged timeline: load engine → connect disk
    → prepare files → start Linux → mount files → ready), `boot_stalled`
    from a **stall watchdog timer** that fires every ~12 s independently of
    the hung await chain (warn level — always surfaces, always flushes),
    `boot_timeout`/`boot_failed`/`boot_done`, `exec_timeout`. Two debug
    switches: a client verbose toggle (localStorage + URL param + a console
    hook) that promotes debug events and flushes per-event, and the server
    log-level knob. Plus a compact per-exchange diagnostic object riding
    every chat request (`{coi, sab, knob, ran, fs}`) into the interaction
    log — the single most important field when debugging a real device.
12. **The agent-activity backdrop.** Never auto-pop a terminal panel over
    the chat (the reference removed exactly that). Instead: commands and
    raw output drift faintly across the page background (a ring-buffered
    multi-channel pure core + a fail-soft DOM layer fed from the single
    exec choke point), the raw console mirrored (ANSI-stripped) so the boot
    banner is the "Linux started" signal, and a header icon that swaps the
    conversation/terminal panes. Decoration must never break exec — wrap
    every feed fail-soft.
13. **Vendor the terminal, pin the engine question.** The terminal library
    is vendored same-origin with SHA-256 pins recorded next to the loader
    (a CDN outage must not break the boot); the VM engine may stay a CDN
    load only while its license question is open — record that status and
    require the CDN to serve CORP headers (COEP `require-corp` demands it).

## Reference implementation map

| Concept | File(s) in this repo |
|---|---|
| Shared pure core (intent, parse, clamp, transcript, step message, envelope codec, outbox helpers, `runShellLoop`) | `public/js/bash-core.js` (+ `.test.js`, EN+SV parity suite) |
| Server façade (re-export only, identity-pinned) | `src/bash-agent.js` (+ `.test.js`) |
| One-step decision endpoint | `src/bash-api.js` (`POST /api/bash/step`) |
| VM glue: boot, exec bridge, mounts, export, deliverables collect | `public/js/sandbox.js` |
| File-mount pure core (sanitize/dedupe/caps/manifest/seed script/`projHash`/`planSourceMount`) | `public/js/sandbox-files.js` (+ `.test.js`) |
| Server-tier loop driver | `public/js/bash-agent.js` (+ `.test.js`) |
| Client-tier loop + prompt | `public/js/drc-research.js` (`runDrcShellPass`, `drcBashAgentPrompt`) |
| COEP wiring + knob-gated isolation | `src/assets.js` (`serveAsset(.., {coep})`) |
| First-paint isolation self-heal + knob mirror | `public/js/sandbox-mode.js`, driven by `public/js/app.js` |
| Prompt awareness (`hasShell`), step prompt | `src/prompts.js` (`bashAgentPrompt`, `synthPrompt({hasShell})`) |
| Transcript into synthesis | `src/pipeline.js` (`ctx.shellBlock`), `src/chat.js` (`shell_transcript`), `src/validation.js` (`resolveShellTranscript`) |
| Activity backdrop (pure core + DOM glue + header switcher) | `public/js/agent-backdrop-core.js` (+ `.test.js`), `public/js/agent-backdrop.js` |
| Deliverable chips + add-to-project | `public/js/turns.js` (`renderDeliverables`), `public/js/projects.js` (`addFilesToProject`) |
| Boot observability + debug switches | `public/js/sandbox.js` (`sblog`/watchdog), `src/user-api.js` (`/api/client-log`), `.claude/skills/sandbox-debug/SKILL.md` |
| Vendored terminal (SHA-pinned) | `public/vendor/xterm/`, pins in `public/js/sandbox.js` |
| Device-API research + mount/outbox design | `docs/SANDBOX-HOST-COMMANDS.md` |

## Acceptance checklist

- [ ] Pure-core suites green in Node, including the language-parity suite
      for the intent heuristic and the RC-before-any-pipe envelope pin.
- [ ] The server façade's identity test proves its surface IS the core
      (same function objects — a re-implementation fails).
- [ ] Loop unit-tested end to end on both tiers against a mock step
      function and a mock sandbox (rounds, caps, `SHELL_DONE`, fail-soft).
- [ ] Step endpoint quota-gated; any server failure returns `done`.
- [ ] `crossOriginIsolated === true` verified live on the actual target
      browsers — including iOS Safari, not just Chromium.
- [ ] Live one-command round trip on a real device: boot → command →
      transcript → answer uses the real output.
- [ ] A file mounted into `/workspace` is `cat`-able in-guest; an outbox
      file round-trips out as a download chip.
- [ ] Boot-hang observability proven: a deliberately-blocked stage produces
      `boot_stalled` lines naming that stage.
- [ ] Knob OFF ⇒ zero sandbox code runs; knob ON + unsupported browser ⇒
      normal answer, no error.

## Pitfalls

- **Never gate execution on the intent regex.** The reference's 2026-07-10
  production defect: `bashIntent` gated the loop, missed a phrasing, and the
  site answered "I can't run code". The model decides (cold first step);
  the heuristic is telemetry only.
- **iOS Safari ignores COEP `credentialless`** (confirmed live 2026-07-11:
  header served, `crossOriginIsolated === false`, no `SharedArrayBuffer`).
  Use `require-corp`; every cross-origin subresource then needs CORP; the
  casualty class is CORP-less iframes. A Chromium pass proves nothing here.
- **The boot race:** a self-heal that waits for the settings fetch leaves a
  window where a send lands on a non-isolated page and silently falls back
  (reference chat_logs #306). The localStorage knob mirror + synchronous
  first-paint navigation closes it; reconcile with the server afterwards.
- **Bare persistent-device dir mounts wedge the guest** (CheerpX 1.2.6: the
  first read of a file from a `{type:"dir", dev: IDBDevice}` mount hangs
  forever — proven by an isolated side-by-side probe 2026-07-14). User files
  go: direct-byte ingest device → `cp` into plain dirs of the root overlay.
  Do not reintroduce per-volume persistent mounts.
- **Capture `$?` before any pipe.** Piping stdout into `base64` and reading
  `$?` after captures base64's exit (dash has no `PIPESTATUS`) — every exit
  code reads 0. Redirect to temp files, capture immediately, then encode.
- **Honest readiness:** a boot that reaches "ready", then tears itself down
  (timeout during a late verify step), must return false — the reference's
  "sandbox not ready" incident came from `bootVM` returning true over a
  dead VM.
- **Progress-sink lifecycle:** the boot-progress message sink lives at
  module scope; a pre-warm boot must let the real send ADOPT the in-flight
  boot's sink, and the quip-ticker stopper must never null it (both
  regressions shipped, same day, 2026-07-13 — frozen boot label).
- **Stale delivery masks everything.** Edge cache rules and installed-PWA
  shells can serve pre-fix bundles for days; an absent per-request
  diagnostic field means "old client", not "broken code" — fix delivery
  (purge + cache-busting URL), don't chase the code.
- **Public-allowlist 401s kill the whole client-tier module graph** — one
  non-allowlisted import in the chain and the tier ships dark for anonymous
  visitors while every authed probe passes. Walk the import closure against
  the allowlist whenever an import changes.
- **Cosmetic CDN loads must be non-fatal** (a transient terminal-CSS miss
  killed boots when it sat in a fatal `Promise.all`); load-bearing scripts
  stay fatal, cosmetics get `.catch`.
- **Debug verify steps stay off the hot path** — the reference's boot ran a
  debug-only `/workspace` listing on every production boot and the listing
  itself was the wedge trigger. Gate diagnostics behind the verbose toggle.
