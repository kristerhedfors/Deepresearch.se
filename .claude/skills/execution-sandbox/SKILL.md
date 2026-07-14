---
name: execution-sandbox
description: >-
  Load when working on the experimental in-browser Linux execution sandbox and
  the bash-lite agent — the `bash_lite_mcp` knob (DRS) / `bashLite` (DRC) — or
  anything touching public/js/bash-core.js (the shared pure core),
  src/bash-agent.js (its server façade), src/bash-api.js,
  public/js/sandbox.js, public/js/boot-messages.js (the rotating boot-bar
  quips shown while the VM boots), public/js/bash-agent.js (the DRS driver),
  the /api/bash/step endpoint, the shell transcript in the pipeline/synthesis, the
  cross-origin-isolation (COEP) headers, or the CheerpX WASM Linux VM. Covers
  the client-orchestrated agentic loop, the fenced-block (no-function-calling)
  convention, the fail-soft contract, EN+SV intent parity, and the live
  browser verification. ALSO the go-to when the
  sandbox "refuses to run code" on a real device: the COEP must be
  `require-corp` (iOS Safari ignores `credentialless`), the `client_diag`
  browser probe + `wrangler tail` debugging playbook, the edge/PWA
  stale-code caching traps, and the 2026-07-11 incident log of failed attempts
  and the working fix. ALSO covers MOUNTING user files into the VM
  (public/js/sandbox-files.js + the sandbox.js device mounts): the CheerpX
  device-API facts (DataDevice/IDBDevice/WebDevice/OverlayDevice, no host→guest
  hypercall, no host IDBDevice.writeFile), the /workspace + /mnt/<projname>-<hash>
  layout, the tiered ingest (DataDevice direct-bytes → WebDevice+SW → base64
  fallback), overlay persistence, and the fileProvider seam — load this when
  adding/changing how attachments or project files reach the sandbox.
---

# Execution sandbox (bash-lite)

An EXPERIMENTAL, opt-in, default-OFF capability: when a message "wants a
shell", a real x86 Linux boots **in the browser** (CheerpX WASM), an agentic
loop runs commands in it, and the real output feeds the answer. Present on
**both** tiers — DRS (`DeepResearch.Se/rver`) and DRC (`DeepResearch.Se/cure`).

> ## ✅ WORKING FOUNDATION — DRS verified end to end (2026-07-13)
>
> **DRS (Se/rver) sandbox execution is CONFIRMED WORKING on the owner's real
> device** (iOS Safari, knob on): "list files in /" booted the VM with a live,
> elaborating boot-progress line + rotating quips, ran `ls /`, showed the
> commands as they executed (live `Sandbox › $ …` line) and as an expandable
> transcript, and answered from the real output. This is the **known-good
> baseline — treat it as a protected foundation, not experimental scaffolding to
> freely rework.** The pieces that make it work, and MUST NOT regress:
> - **The boot-progress sink is module-scoped and never nulled by
>   `stopBootQuips`** (`public/js/sandbox.js` `_bootOnMessage`). Clearing it in
>   `stopBootQuips` froze the whole boot line — see the sandbox-debug skill's
>   LOAD-BEARING GUARD. `ensureSandboxBooted` sets the sink before `bootVM`; the
>   ticker reads it live; a real send adopts a pre-warm's in-flight boot.
> - **Command visibility:** the live `onExec` line + `finishSandboxStep`
>   expandable transcript (`stream.js` / `activity.js`, from the command-metadata
>   work). The user explicitly values this "nice elaborating" execution view.
> - **Fail-soft boot timeout** (`BOOT_TIMEOUT_MS`, 90 s) so a wedged boot answers
>   normally instead of freezing.
> - **First-paint isolation self-heal** from the cached knob (`sandbox-mode.js`).
>
> Before changing ANY of `sandbox.js` boot/exec, `bash-core.js`, `stream.js`
> `maybeRunShellLoop`, or `activity.js` `finishSandboxStep`: re-read this list,
> keep the behavior, and **verify live on a real device** (this area is
> browser/WASM glue with no Node unit test — it regressed TWICE from unverified
> changes on 2026-07-13; the boot-progress sink-null and the pre-warm swallow).
>
> **Known-next fix (DRC only, NOT yet done):** on **DRC (Se/cure)** an ugly
> **xterm terminal panel pops up covering the bottom half of the screen** during
> sandbox use. DRS already suppresses this (the panel is built-but-hidden, 2026-
> 07-12; activity shows on the faint backdrop instead). DRC needs the same
> treatment — keep the terminal hidden by default and surface activity on the
> backdrop layer. This is the next item on the fixlist; do it the DRS way.

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
| SHARED pure core (intent, parse, exec-result clamping, transcript, the per-round step user-message `buildStepUserMessage`, the generic injected-step `runShellLoop` driver, caps) | `public/js/bash-core.js` (+ `.test.js`, Swedish-parity suite) — the ONE implementation. Lives under `public/` because the browser can only import served modules while the Worker bundler (wrangler/esbuild) imports from any repo path; it is BOTH served to the browser AND bundled into the Worker. In `assets.js`'s `isPublicAsset` allowlist (the /cure module graph imports it) |
| Server façade over the core | `src/bash-agent.js` (re-export ONLY — since 2026-07-11 this replaced the old hand-mirrored copy; `.test.js` pins the re-export contract so a re-implementation fails the suite) |
| Settings knob `bash_lite_mcp` | `src/settings.js` (`bashLiteEnabled`, availability = user row only, no secret) |
| Step prompt + synthesis clause | `src/prompts.js` (`bashAgentPrompt`, `synthPrompt({hasShell})`) |
| Step endpoint `/api/bash/step` | `src/bash-api.js` (one model turn on `DEFAULT_MODEL`, quota-gated, usage-recorded) |
| Pipeline consumption | `src/pipeline.js` (`ctx.shellBlock` → synthesis + direct/search-off), `src/chat.js` (`shell_transcript` request field → `state.shellTranscript`) |
| COEP / cross-origin isolation | `src/assets.js` (`serveAsset(..,{coep})` sets COEP **`require-corp`** + `no-store`, strips conditional headers: DRC page always, DRS shell when the knob is on) |
| DRS client driver | `public/js/bash-agent.js` (`fetchShellStep` + the DRS-shaped `runShellLoop` — the core driver with the step wired to `/api/bash/step`; re-exports the core's pure API) |
| The CheerpX VM + terminal + exec bridge | `public/js/sandbox.js` (NOT `@ts-check` — browser/WASM glue). Since 2026-07-12 the terminal panel is **built but NOT auto-shown** — activity surfaces on the backdrop layer instead (see below); the panel stays hidden unless the user opens it |
| Agent activity backdrop (the faint page-background command/output layer) | `public/js/agent-backdrop.js` (DOM glue, NOT `@ts-check`) over the pure core `public/js/agent-backdrop-core.js` (+ `.test.js`) — fed from `execInSandbox` so BOTH tiers + any agent surface automatically. Both allowlisted in `assets.js` (sandbox.js is in the /cure graph). Styled in `css/app.css` (DRS) AND `cure/drc.css` (DRC self-contained) under `#dr-agent-backdrop` |
| DRS send integration | `public/js/stream.js` (`maybeRunShellLoop` before `/api/chat`, attaches `shell_transcript` + the `client_diag` probe) |
| Isolation self-heal | `public/js/sandbox-mode.js` (the pure logic: `cachedSandboxMode`/`storeSandboxMode` — a localStorage mirror of the knob like `dev-mode.js` — plus `isolateForSandbox`/`shouldIsolate`/`clearIsolationGuard`), driven by `public/js/app.js`. Fires **SYNCHRONOUSLY at first paint from the cached knob** (not only after `/api/settings` resolves — that lag was the 2026-07-13 boot-race defect, chat_logs #306), navigating to a fresh `?_coep=<ts>` URL (NOT `location.reload()`); the `dr_coep_reload` sessionStorage one-shot prevents a loop, `loadSettings()` reconciles the cache + handles a first-ever enable, and the `pageshow(persisted)` bfcache handler retries with the guard reset |
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

## `run_bash` as a NATIVE TOOL — DRC developer mode (2026-07-12)

Separate from the fenced-block shell pass above: DRC's **developer-mode**
investigation drives a native FUNCTION-CALLING loop (the owner-authorized
invariant-1 exception — see the **introspection** skill), and because CheerpX
is browser-reachable it gives the model a real `run_bash` tool that the SERVER
tier structurally cannot (a server-driven `/api/chat` request can't reach the
browser VM synchronously).

- `public/js/drc-research.js` `runDrcSourceTools` runs the loop when the page
  hands `runDrcResearch` a `snapshot` (dev mode on). Tools: the shared
  `INTROSPECTION_TOOLS` (`grep_source`/`read_file`/`list_files`, executed over
  the snapshot via `runIntrospectionTool` from `introspect-core.js`) PLUS
  `RUN_BASH_TOOL` — appended ONLY when `bash === true && sandboxSupported()`.
- `RUN_BASH_TOOL`'s executor boots the VM lazily on the first call
  (`sb.boot(fileProvider)` — the SAME `/src`-mounting `fileProvider` the shell
  pass uses), runs the command via `execInSandbox`, and returns
  `formatShellResult(normalizeExecResult(...))` from `bash-core.js` — one shared
  formatting for both mechanisms.
- The loop itself is `public/js/drc-providers.js` `drcToolRun` (the OpenAI
  `tools`/`tool_calls` wire — all three DRC providers speak it; `toOpenAiTools`
  maps the provider-neutral defs). Non-streaming rounds; the final answer is
  emitted chunked. System prompt: `drcSourceToolPrompt({bash})`.
- Fail-soft: no tool support / any failure → falls through to the normal DRC
  phases (which still carry the injected introspection block). Node-tested end
  to end against a mock provider (`drc-research.test.js`,
  `drc-providers.test.js`). **Still owed:** live in-browser verification of the
  real `run_bash` tool on a user key (the CheerpX + provider-tool-call path).

The DRS tier's equivalent (server-side, `grep_source`/`read_file`/`list_files`
only, NO `run_bash`) is `runSourceResearchTools` + `anthropicToolRun` — see the
**introspection** skill.

## Activity backdrop + transparency bar (no auto-popping terminal — 2026-07-12)

The floating xterm terminal used to `showSandbox()` itself the moment the VM
booted, covering the screen and breaking the prompt-first flow. It no longer
does: `bootVM` builds the panel (exec still needs the xterm console) but leaves
it **hidden**. Instead every command and its raw output drift **faintly across
the page's sky-blue/khaki background**, and — **this is the whole UX** — a small
**transparency BAR appears WHILE the terminal is running** so the user tunes how
visible that layer is, live, right there. There is deliberately **NO settings /
config entry** (2026-07-12 directive): the bar IS the control.

- **One feed point.** `execInSandbox` (the single exec choke point on BOTH
  tiers) calls `feedCommand("shell", cmd)` before running and
  `feedResult("shell", result)` after parsing — so DRS, DRC, and any future
  agent surface automatically, with no callback threading through
  `stream.js`/`drc-research.js`. Both feeds are wrapped fail-soft (decoration
  must never break exec).
- **The bar (`#dr-backdrop-bar`)** is shown on every feed and **auto-hides**
  ~6 s after the terminal goes quiet (kept alive while the user touches it). Its
  slider drives `setBackdropOpacity` live. At **0 the text layer is not built or
  rendered at all** (the "if not shown, optimize that case" directive) — only
  the tiny bar shows so the user can bring it back. The chosen value is
  remembered per browser (localStorage `dr_agent_backdrop`) so the bar returns
  where it was left — this is a remembered position, NOT a settings screen.
- **Pure core** `agent-backdrop-core.js`: a ring-buffered, multi-CHANNEL
  transcript (one channel per agent id) + the round-robin `clipToNextChannel`
  that "clips between agents" when several are active + `ShellRun`→lines
  formatting + the transparency parse/clamp (`opacityCss` caps CSS opacity at
  `OPACITY_CEILING` = 0.72 so even "full" reads as background) + `stripAnsi` /
  `replaceLastLine` for the raw-terminal mirror. Node-tested.
- **DOM glue** `agent-backdrop.js`: lazily builds `#dr-agent-backdrop` (fixed,
  `z-index:-1`, `pointer-events:none`, behind the chat) AND the floating bar;
  import-safe in Node (guards every browser global) because
  `sandbox.js`←`drc-research.js` is Node-tested.
- **CSS lives in two places** because `drc.css` is self-contained (app.css is
  auth-served): `#dr-agent-backdrop` + `.dr-agent-backdrop-text` + the
  `agent-wave` keyframe are mirrored in `css/app.css` and `cure/drc.css` (only
  the palette colors differ). If you touch the look, update BOTH. A CSS change to
  app.css also needs the `--css-version`/`CSS_VERSION` handshake bump (at `h33`
  for this; the floating transparency bar/slider was removed 2026-07-13 — the
  layer is one fixed faint value now).

### Start-immediately + raw-terminal mirroring + more prominent (2026-07-14)

Owner directive: "the execution sandbox, if enabled, should start immediately;
all the terminal text should be visible in the chat background (new lines
appearing just above the input pane); terminal characters in the background are
the distinguishing sign that Linux has started; make it slightly more visible."
Three coordinated changes:

- **Auto-start when enabled.** DRS `app.js` calls `prewarmSandbox()` in the
  `loadSettings().then` once the knob is confirmed on AND the page is isolated
  (didn't navigate for the COEP self-heal). DRC `cure/drc.js` `prewarmDrcSandbox()`
  boots at page init and on knob-enable. Both are the SAME bare, idempotent,
  `sandboxIdle`-gated boot as the composer-focus pre-warm, and both SKIP when
  developer mode is on (that path mounts `/src` at boot; a bare pre-warm would be
  adopted and lose the mount). So "enabled" now means the VM is already booting
  the moment the app opens, not only on composer focus / first shell send.
- **Raw terminal mirrored to the backdrop.** `sandbox.js` `writeData` (the
  CheerpX console writer) decodes each chunk with a streaming `TextDecoder` and
  calls `agent-backdrop.js` `feedTerminal()`. This surfaces the boot/login
  banner + shell prompt behind the chat — the "Linux started" signal — separate
  from the clean `feedCommand`/`feedResult` command view. **Why it stays clean:**
  during a command `execInSandbox` swaps the console to a private byte collector,
  so `writeData` only ever carries the interactive shell's own output, never the
  base64 marker envelope. `feedTerminal` strips ANSI (`stripAnsi` in the core),
  commits newline-terminated lines, and shows the unterminated tail (the live
  prompt) via `render()`; `feedCommand` first `flushTermTail()`s so a command
  lands BELOW the prompt. All on the single `"shell"` channel = one coherent
  terminal.
- **Slightly more prominent.** `agent-backdrop-core.js` `OPACITY_CEILING`
  0.55 → 0.72; `.dr-agent-backdrop-pre` font-size 12→13px and text alpha
  .5→.62 (app) / .55→.66 (drc). Still a backdrop, not a wall.

New pure exports (`agent-backdrop-core.js`, Node-tested): `stripAnsi`,
`replaceLastLine`, `OPACITY_CEILING`. `feedTerminal` is DOM glue (not unit-
tested; verify live). **Still owed:** live confirmation on the real device that
the boot banner drifts behind the chat and auto-start fires on open.

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

## Mounting user files into the VM (part B — Tier 1 shipped 2026-07-11)

Attachments and project files are mounted into the guest so the model can
`cat`/`grep`/`python3` them. Full design + research citations:
`docs/SANDBOX-HOST-COMMANDS.md`. The load-bearing facts (all from CheerpX's
primary docs — mirrored in the `aisecurityliteracy.dev` clone under
`docs/cheerpx/` — cross-checked against WebVM's source):

**CheerpX device-API reality (memorize this — it dictates every choice):**
- **No guest→host hypercall / callback-device / custom-syscall exists** in any
  CheerpX version through 1.3.5, and there's no feature request. `registerCallback`
  is monitoring-only (cpu/disk/processCreated, no payload). So we NEVER rely on
  the guest calling JS; the loop stays host-orchestrated.
- **`DataDevice`** — host→guest, `writeFile(path, Uint8Array | string)` (binary
  first-class, **no base64**; `ArrayBuffer`/`Blob` NOT accepted — wrap in
  `new Uint8Array`). Mounted `{type:"dir", …}`. **Read-only in the guest,
  in-memory** (re-supplied every boot, bounded by page RAM).
- **`IDBDevice`** — persistent RW (IndexedDB), mounted `{type:"dir", …}`.
  Host side has **only** `readFileAsBlob(path)` and `reset()` — **there is NO
  host `IDBDevice.writeFile`**. That single fact is why host bytes can't be
  written straight into the persistent volume and must transit a DataDevice.
- **`OverlayDevice(base, IDBDevice)`** — guest writes to `/` persist in the IDB
  layer across reloads (reuse the same db name). WebVM 2.0 confirms this.
- **`WebDevice.create(path)`** — read-only, lazy: guest reads become same-origin
  HTTP GETs relative to the page URL → a **Service Worker can intercept them**
  (architecturally sound, undocumented — verify live) to stream huge files.

**Layout** (`/workspace` = session, project = its own mount, friendly symlink):
```
/workspace/                    session files + guest scratch · persistent RW
/workspace/INDEX.txt           manifest (scope name type size tier)
/workspace/<projname> -> /mnt/<projname>-<hash>   friendly symlink, NO hash
/mnt/<projname>-<hash>/        the active project · its own persistent volume
```
`<hash>` = `projHash(projId)` (stable FNV-1a, 8 hex) — unique + stable so the
same project reuses the same `dr-proj-<hash>` IndexedDB across sessions.

**Tiered ingest (base64 is ONLY the fallback — it inflates ~33% + is byte-by-byte
through the console, wrong for large files):**
1. **DataDevice (default, shipped)** — `writeFile(path, Uint8Array)` into two
   flat ingest devices `/mnt/in-s` (session) + `/mnt/in-p` (project), then a boot
   `cp` into the persistent tree. Flat (files at device root) so we never depend
   on DataDevice auto-creating nested dirs.
2. **WebDevice + Service Worker (deferred)** — for files over the memory budget;
   needs a SW we don't have yet, and the SW-intercept is unverified.
3. **base64-through-`exec` (fallback)** — small writable/executable files only.

**Seed policy:** session refreshed each boot (`cp -a`); project add/update-only
(`cp -an`) so guest edits aren't clobbered. `readFileAsBlob` gives the
round-trip OUT (guest-written files back to the user).

**Implementation map:**
| Concern | Where |
|---|---|
| Pure core (sanitize/dedupe/cap/manifest/`projHash`/`buildSeedScript`/`shellEscape`) | `public/js/sandbox-files.js` (+ `.test.js`); in `isPublicAsset` |
| Device mounts + seed + `exportFile` | `public/js/sandbox.js` `bootVM` (extra mounts STAGED locally, committed only on full success; all fail-soft → bare VM) |
| Boot signature | `ensureSandboxBooted(fileProvider?)` — provider is `async () => ({session:[{name,type,bytes}], project:{name,id,files:[…]}|null})` |
| DRS provider | `public/js/stream.js` `buildSandboxFileProvider(opts)` — attachments→session, `activeProject().files`→project; bytes from OPFS (`loadOriginal`) decrypted with the in-memory history key (`decryptBytes`) when the meta row's `enc` is set; inline `att.text` preferred. Deferred into the lazy boot so bytes load only if the VM is needed |
| Prompt awareness | `bashAgentPrompt` (points the model at `/workspace/INDEX.txt`) |

**Gotchas / rules:**
- The provider is called ONCE inside `ensureSandboxBooted` (which `runShellLoop`
  invokes only when the model proposes a command) — so a no-shell message never
  loads/decrypts bytes and never boots the VM. Keep it that way.
- Stage extra mounts in a local array; a partial device-setup failure must NOT
  reach `Linux.create` (would break the whole boot).
- `sandbox.js` imports `sandbox-files.js` → BOTH must be in `isPublicAsset` or
  `/cure` goes dark (the recurring public-graph 401 class).
- **DRC note:** attach is a DRS-only feature (the `/cure` attach button is
  dimmed), so chat-attachment mounting is inherently DRS. `sandbox.js` is
  provider-agnostic; DRC would only ever wire *project* files, and hasn't yet.
- **Still owed (live-verify):** DataDevice mount readable in-guest on real iOS
  Safari under `require-corp`; `/workspace` + project-volume persistence across
  reload; cross-mount symlink resolves; binary round-trip byte-exact. Logic is
  green in CI but unproven in a real browser.

> **Boot HANGS ("booting sandbox" spinner that never finishes) → the
> `sandbox-debug` skill.** It covers the full boot-stage timeline
> (`sandbox.boot_stage`), the stall watchdog (`sandbox.boot_stalled`, which
> flushes a hang the buffered path can't), and the verbose toggle
> (`dr_sandbox_debug` / `?sbdebug=1` / `window.__DR_SANDBOX_DEBUG`). The
> mount-telemetry below is for a boot that SUCCEEDS but mounts wrong.

**Observability — reaching the mount telemetry through the log URL.** The mount
path runs client-side, so it's shipped to Workers Logs two ways:
1. **The debug beacon.** `sandbox.js` `sblog()` buffers structured events and
   `flushSandboxLog()` beacons them to **`POST /api/client-log`**
   (`src/user-api.js` `handleClientLog`), which re-emits each through `log.js`
   with `client:true` + `user_id`. Events (all namespaced `sandbox.*`):
   `sandbox.boot_start`/`boot_done`/`boot_failed`, `sandbox.fs.provider`
   (bytes assembled, decrypt/source failures — `stream.js`), `sandbox.fs.plan`,
   `sandbox.fs.mount`, `sandbox.fs.write` (per file, **debug**),
   `sandbox.fs.dropped` (**debug**), `sandbox.fs.seed` (seed script exit),
   `sandbox.fs.verify` (a real `ls -la /workspace` listing, **debug**),
   `sandbox.fs.export`. Levels are honored end to end: **debug events only
   surface when `LOG_LEVEL=debug`** (`wrangler.toml`) — flip it to debug for
   heavy testing (per-file writes + the on-disk verify listing), back to info
   for production milestones; no client redeploy.
2. **`client_diag.fs`.** A compact last-mount summary (`sandboxFsSummary()` →
   `{n,b,proj,drop,ms,err}`) rides on **every `/api/chat`** and lands in the
   `chat_logs` meta + the `chat.client_diag` log line — so a mount problem is
   visible per-exchange even without the debug beacon.

   Read them: `npx wrangler tail deepresearch-se --format json` and grep for
   `sandbox.` (or `"client":true`); or `scripts/chatlogs --id N --json` for the
   `client_diag.fs` summary. Server-side loop detail is `bash.step` (info) +
   `bash.step_commands` (**debug**) in `src/bash-api.js`.
3. **`meta.shell` (the tool-call record).** The full shell transcript the
   loop ran — each `command`, `exitCode`, clamped `stdout`/`stderr` — is
   persisted in the `chat_logs` meta (`shellLogSummary`, `src/chatlog.js`),
   so `scripts/chatlogs --id N` (text) prints a readable `TOOLS: bash-lite
   ran N commands` block and you can see EXACTLY what the agent executed
   without the debug beacon or device access. `client_diag.ran` is just the
   count; `meta.shell` is the calls themselves.

## Live verification (DONE — 2026-07-11, re-confirmed 2026-07-13)

Verified end to end on the real target device. On **iOS 18.7 Safari 26.5**,
knob ON, `/rver` serving `require-corp`: the live `client_diag` flipped to
`{coi:true, sab:true, sb:true, ran:1}` and `/api/bash/step` returned
`ls /` → `SHELL_DONE`; the answer listed the real Debian root. Also verified
from a fresh Chromium context (Playwright) and the break-glass admin session.

**Re-confirmed 2026-07-13** on iOS Safari after the boot-progress + command-
visibility work landed and its regressions were fixed (see the WORKING
FOUNDATION note at the top): "list files in /" showed the live elaborating
boot-progress line, the executing commands, and the expandable transcript, then
answered — the owner's words: *"Now it works!!! The nice elaborating sandbox
execution!!"* This is the protected DRS baseline.

Two things to still spot-check when you touch this: the keyless Street View
Embed **iframe** (the one casualty of `require-corp`), and DRC `/cure` on the
user's own provider key — **DRC still has the ugly bottom-half terminal popup
(the next fixlist item; DRS already hides it).**

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

## Incident — the boot-race intermittent failure (2026-07-13)

**Symptom:** "list files in /" answered from a web search (generic textbook `ls`
output) instead of running the sandbox — intermittently. The user swore it had
worked before.

**How the logs cracked it:** two `chat_logs` rows, same iPhone, **same client
build (css h32)**, 23 s apart — `scripts/chatlogs --id N --json` → `meta.client_diag`:
- #306 (failed): `{coi:false, sab:false, bl:false, ran:0}` → page NOT isolated,
  knob read off, no shell → web fallback.
- #307 (worked): `{coi:true, sab:true, bl:true, ran:1}` + a real `meta.shell`
  transcript (`ls /` → the Debian root).

Same code both worked and failed → **not a code regression**; the variable was
cross-origin isolation. The load-bearing commit that made execution work on iOS
at all is still `ea1e190` ("COEP require-corp so iOS Safari actually isolates").

**Root cause:** the isolation self-heal fired only AFTER `/api/settings`
resolved. On a cold load that left a window where the knob is really on, the
page isn't yet isolated, and `bashLiteOn()` still reads false — a send in that
window silently fell back with NO sandbox activity. #307 worked because the
self-heal's `?_coep=` navigation had by then landed an isolated shell.

**Fix:** `public/js/sandbox-mode.js` — mirror the knob into localStorage
(`dr_bash_lite`, like `dev-mode.js`) so the self-heal fires **synchronously at
first paint from the cache**, before settings resolves and before a send can
land non-isolated. `loadSettings()` reconciles the cache (cross-device flips,
first-ever enable). The knob toggle and `pageshow` bfcache handler also route
through the single `isolateForSandbox` helper. Still owed: live confirmation on
the real device that the boot-race window is actually closed (the diagnosis is
from logs; the fix is unit-tested but the iOS timing is unproven in-session).

**Related (not sandbox, surfaced during an earlier session):** Google OAuth
`redirect_uri_mismatch` — the Worker is routed on both apex and `www`, and
`redirect_uri` is built from the request host, so a `www` sign-in sent Google a
`www` callback that only a (non-matching) wildcard covered. Fixed by
canonicalizing `www → apex` (301) at the top of `route()` before anything else.
See the **access-control** skill.
