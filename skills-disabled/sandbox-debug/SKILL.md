---
name: sandbox-debug
description: >-
  Load when the in-browser Linux sandbox HANGS or misbehaves at boot — the UI
  stuck on "booting sandbox" / "loading CheerpX…" / "connecting disk…" /
  "starting Linux…", the VM never reaching ready, or any "the sandbox spins
  forever" report — and you need the full boot timeline. Covers turning verbose
  sandbox debugging ON/OFF (the client `dr_sandbox_debug` toggle + the server
  `LOG_LEVEL=debug` knob), the `sandbox.boot_*` event vocabulary and what each
  boot stage means, the stall watchdog (`sandbox.boot_stalled`) that reports a
  hang's exact stage even when nothing else flushes, and the read-the-timeline
  playbook (`wrangler tail` / `scripts/chatlogs`). Companion to the
  execution-sandbox skill (which covers the sandbox itself); this one is
  specifically the debug/observability switch and the boot-hang diagnosis.
---

# Sandbox boot debugging — full-coverage timeline

The execution sandbox (CheerpX WASM Linux) boots **in the browser**, so a boot
that HANGS ("booting sandbox" spinner that never finishes) is invisible
server-side unless the boot timeline is shipped out. This skill is the switch
that makes the whole boot timeline visible, and the playbook for reading it.

Everything here is in `public/js/sandbox.js` (the browser VM glue — NOT
`@ts-check`, NOT Node-unit-tested; verified live). The server side is the
existing `POST /api/client-log` beacon (`src/user-api.js handleClientLog`) →
`log.js` → Workers Logs, exactly as the file-mount telemetry uses (see the
**execution-sandbox** skill's Observability section).

## The problem this solves

Before this instrumentation there were two blind spots on a boot hang:

1. **No per-stage record.** The boot advances through cosmetic `setStatus(...)`
   strings — `booting` → `loading CheerpX…` → `connecting disk…` →
   `preparing files…` → `starting Linux…` → `mounting files…` → `ready` — but
   only `boot_start` / `boot_done` / `boot_failed` were ever logged. A hang
   between two awaits left no breadcrumb of WHICH stage died.
2. **The buffer only flushed on a terminal state.** `sblog()` buffers events;
   `flushSandboxLog()` beacons them. It was only called on `boot_done` /
   `boot_failed`. A genuine hang — an `await` that never resolves (disk fetch,
   `Linux.create`) — reaches neither, so **nothing was ever beaconed**, not even
   `boot_start`. Total silence.

Both are now closed: every stage is logged (`sandbox.boot_stage`), and a
**stall watchdog** flushes from a timer that runs independently of the hung
await-chain.

## Turning debugging ON / OFF

There are TWO independent switches. For a live boot-hang investigation you
usually want **the client toggle** (no redeploy, and it self-flushes).

### 1. Client verbose toggle — `dr_sandbox_debug` (the main one)

When ON: every `sblog` event — including the debug-level `boot_stage`
breadcrumbs — is **promoted to info** (so it surfaces even when the server is
NOT on `LOG_LEVEL=debug`) AND the buffer is **flushed after every event** (so a
hang loses nothing). When OFF it is byte-identical to the old buffered behavior.

Three ways to flip it, all persist in `localStorage.dr_sandbox_debug`:

- **From the device console** (the operator's phone, remote-debugging):
  `window.__DR_SANDBOX_DEBUG(true)` → returns `true`, logs+flushes a
  `sandbox.debug_toggle` line so you can confirm the exact moment it turned on.
  `window.__DR_SANDBOX_DEBUG()` (no arg) reads the current state;
  `window.__DR_SANDBOX_DEBUG(false)` turns it off.
- **URL param** — append `?sbdebug=1` to the page URL (survives into the session
  even without console access; handy to hand a user a link). Read once at module
  load.
- **localStorage directly** — `localStorage.dr_sandbox_debug = "1"` then reload.

Turn it OFF when done (`window.__DR_SANDBOX_DEBUG(false)`) so production isn't
beaconing a flush per event.

### 2. Server `LOG_LEVEL=debug` (the other half)

`handleClientLog` re-emits each event at its own level, and `log.js` drops
`debug` lines unless `LOG_LEVEL=debug` (`wrangler.toml`). So the debug-level
`boot_stage` / `fs.write` / `fs.verify` events ONLY surface server-side when
either (a) the client toggle promoted them to info, or (b) the server is on
`LOG_LEVEL=debug`. For a one-off remote hang, prefer (a) — no redeploy. For a
sustained testing session on your own device, (b) is fine too. Flip
`wrangler.toml` `[vars] LOG_LEVEL = "debug"` → deploy → and remember to flip it
back to `info` for production (per the execution-sandbox skill's note).

**Why both exist:** the client toggle needs no deploy and captures hangs (eager
flush); the server knob captures the debug stream for ALL users at once without
each of them flipping a client flag. They compose — either surfaces the debug
events.

## The boot-stage vocabulary

Each stage is the `stage` field on `sandbox.boot_stage` (and the `stage` a stall
or failure reports). In order:

| stage | what is awaiting — where a hang here points |
|---|---|
| `boot_start` | entered `bootVM`; isolation checked next |
| `booting` | panel built; about to load the xterm CDN scripts |
| `loading CheerpX…` | `import(CHEERPX_CDN)` — the CheerpX module fetch (cxrtnc CDN) |
| `connecting disk…` | `CloudDevice.create(DISK_URL)` + IDB cache + overlay — the **Debian disk image fetch**, the most common slow/hang stage on a cold cache or flaky network |
| `preparing files…` | building the file-mount plan from the provider (only with attachments/project/source) |
| `starting Linux…` | `CheerpX.Linux.create({mounts})` — the actual VM bring-up |
| `mounting files…` | seeding `/workspace` + project + `/src` from the ingest devices |
| `ready` | booted; exec available. Watchdog stopped here |

## The events to grep for

All namespaced `sandbox.*`, shipped via `/api/client-log` (so `"client":true`,
with `user_id`, `ua`):

- `sandbox.boot_start` `{coi, sab, provider, debug}` — boot began. `debug:true`
  confirms the verbose toggle is on for this session.
- `sandbox.boot_stage` `{stage, ms}` — **the timeline.** One per stage entered,
  `ms` since boot start. Debug-level (promoted to info when verbose).
- `sandbox.boot_stalled` `{stage, ms}` — **the hang signal.** Emitted by the
  watchdog every `BOOT_STALL_MS` (12 s) while the boot has not resolved, naming
  the last stage entered. **warn-level → always surfaces, even with verbose
  OFF**, and always flushes. Repeated lines = still stuck; the `stage` is where.
- `sandbox.boot_failed` `{error, stage}` — boot threw; `stage` is where.
- `sandbox.fs.seed_timeout` `{ms, source_files}` — the file-seed run inside
  `mounting files…` hit `SEED_TIMEOUT_MS` (45 s); the boot **continued** while
  the guest seed keeps extracting in the background (CheerpX can't kill it —
  its completion stays TRACKED, see `seed_late_done`). Warn-level.
  Before 2026-07-17 a slow seed instead rode all the way to `boot_timeout`
  ("boot timed out at mounting files…", chat_logs #515).
- `sandbox.fs.seed_late_done` `{ms, exit}` — the background seed a
  `seed_timeout` abandoned finally finished; `ms` is its true total duration
  (how slow the guest really was) and a 0 `exit` means the /src stamp got
  written, so the NEXT boot's seed skips extraction entirely. Info-level.
- `sandbox.exec_seed_busy` `{waited_ms, seed_age_ms, command}` — a command
  wanted to run while the background seed was still extracting; execInSandbox
  waited the SEED's own ceiling (`SEED_WAIT_MS`, `waited_ms`) for it and gave up
  **without tearing the VM down** (the instance is healthy, just busy).
  `seed_age_ms` is how long the seed had been running in total (boot head start
  + this wait). The command returns exit 124 with a "still preparing mounted
  files" stderr; the loop ends fail-soft, and a later send hits the now-stamped
  fast path. Before 2026-07-17 the command instead RACED the seed on the
  single-threaded VM and wedged into `exec_timeout` + teardown (chat_logs #522:
  `ls -l /src` at 30 s, fs.ms 61914). **2026-07-18:** the wait was decoupled
  from the per-command exec ceiling — a cold /src seed is one-time setup latency
  (~80 s on iOS, chat_logs #526 fs.ms 80401), so waiting only the 30 s command
  ceiling soft-failed the first `ls -l /src` after every deploy though the seed
  was seconds from done; `SEED_WAIT_MS` (bash-core.js, 60 s) now covers the tail.
- `sandbox.exec_seed_ready` `{waited_ms, seed_age_ms}` — the counterpart to the
  above: a command waited on a still-running seed and it **settled during the
  wait**, so the command then ran against a fully-seeded tree (the fix landing).
  Only logged when the wait exceeded ~250 ms. info-level → confirms on-device
  that the first post-deploy `ls -l /src` lands instead of 124-ing.
- `sandbox.seed_wedged` `{ms, command}` — the background seed has been running
  longer than `SEED_WEDGE_MS` (180 s): declared genuinely wedged, VM discarded
  (`resetSandbox("seed_wedged")`), exit 124. warn-level. The `SEED_WAIT_MS`
  wait above is always bounded by this cap (`min(SEED_WAIT_MS, SEED_WEDGE_MS −
  seed_age)`), so no command waits past the point the seed is declared wedged.
- `sandbox.boot_timeout` `{stage, ms}` — the boot exceeded `BOOT_TIMEOUT_MS`
  (90 s) without resolving — a genuine hang (a disk/CDN fetch that never
  returns, e.g. a privacy browser like **Firefox Focus** that blocks the CheerpX
  CDN or clears the disk cache every session). The boot then **fails soft**:
  the wedged VM is discarded (`resetSandbox`) and the send answers normally
  instead of freezing forever. `stage` names where it wedged (usually
  `connecting disk…`). warn-level → always surfaces.
- `sandbox.boot_unsupported` `{coi, sab}` — not cross-origin isolated (can't
  boot here at all — an isolation problem, not a boot hang; see the
  execution-sandbox skill's COEP section).
- `sandbox.boot_done` `{ms, files, bytes, project}` — success.
- `sandbox.exec_timeout` `{ms, command}` — a boot SUCCEEDED but a single guest
  command ran past its ceiling and was treated as wedged. The ceiling is
  `DEFAULT_EXEC_TIMEOUT_MS` (30 s, bash-core.js) — or LESS when the user's
  research time budget scopes it down (`execTimeoutForBudget`: a 15 s question
  caps each command at 15 s, floored at 5 s; `ms` is the ceiling used). Distinct
  from a boot hang: the VM is up, the label sits on `Sandbox › $ <command>` (the
  command was fed to the backdrop but never returned its output). Cause is a
  guest read that blocks forever — a mount/device stall on some environments
  (seen as a `cat` on a file whose backing device never returns, sometimes with
  inconsistent FS metadata: link count 0, a regular file matched by a `*/`
  glob). CheerpX can't kill a process, so `execInSandbox` **fails soft**: the VM
  is discarded (`resetSandbox`), the command returns exit 124, the shell loop
  ends, and synthesis still runs with the transcript so far — never leaving the
  request hung with no answer. warn-level → always surfaces. `command` is the
  wedged command (clipped). Added 2026-07-13 to close the "stuck at $ cat …"
  wedge (the exec path had no ceiling; only the boot did).
- `sandbox.debug_toggle` `{on}` — the verbose switch flipped.
- `sandbox.fs.*` — the file-mount events (see the execution-sandbox skill).

## Reading the timeline

```bash
# Live, from the repo root (or pass the worker name):
npx wrangler tail deepresearch-se --format json | grep -E 'sandbox\.(boot|debug)'

# After the fact, per exchange — the compact summary that always rides along:
scripts/chatlogs --id N --json      # client_diag.fs = last-mount summary
```

`client_diag` (on every `/api/chat`) still carries the coarse signal —
`{coi, sab, sb, bl, ran}` — read it FIRST (see the execution-sandbox debugging
playbook): if `coi:false`/`sab:false` the page never isolated and the VM could
never boot (an isolation/COEP problem, not a boot hang — do not chase the boot
timeline). Only once `coi:true` does the boot timeline matter, and that's when
`sandbox.boot_stalled` tells you the stuck stage.

## Diagnosing a "booting sandbox" hang — the steps

1. Confirm isolation is fine: `client_diag` shows `coi:true, sab:true`. If not,
   it's a COEP/isolation problem — go to the execution-sandbox skill, not here.
2. Turn verbose on for the affected session: hand the user a `?sbdebug=1` link,
   or `window.__DR_SANDBOX_DEBUG(true)` on their device.
3. Reproduce the boot; watch `wrangler tail` for `sandbox.boot_stage` lines. The
   **last** `boot_stage` before the trail goes quiet — and the `stage` on the
   repeating `sandbox.boot_stalled` — is exactly where it hangs.
4. Map the stage via the table above to the awaiting call:
   - stuck at `connecting disk…` → the Debian disk image fetch (`DISK_URL`,
     cxrtnc CDN); check the CDN/network, a cold IDB cache, or a CORP header on
     the disk host.
   - stuck at `loading CheerpX…` → the CheerpX module fetch (blocked script /
     CDN miss / CORP).
   - stuck at `starting Linux…` → `Linux.create`; usually a bad mount config
     from a partial file-mount (though those are staged fail-soft) or a CheerpX
     version issue.
5. Fix at that layer, redeploy, re-verify the timeline reaches `boot_done`.

## "The boot label is frozen and the quips vanished" (2026-07-13, RESOLVED — verified working)

A distinct symptom from a true hang: the activity label sticks on the caller's
initial `Booting Linux sandbox…` string with **no progress bar and no rotating
quips**, even while the boot is actually advancing. Two stacked causes, both now
fixed and **verified working live on DRS (Se/rver)** — see the working-foundation
note in the execution-sandbox skill:

1. **Pre-warm swallowed the real sink.** `prewarmSandbox` (composer focus) starts
   the boot with a NO-OP message sink; when the real send reused that in-flight
   boot, `ensureSandboxBooted` returned early (`if (bootPromise) return
   bootPromise`) and dropped the send's real sink. Fixed by holding the sink at
   module scope (`_bootOnMessage`) so `ensureSandboxBooted` can ADOPT the latest
   caller's sink even for an in-flight boot.
2. **The adopt fix nulled its own sink (the worse regression).** `startBootQuips`
   calls `stopBootQuips` on its first line to clear any prior timer, and the
   first cut of the adopt fix made `stopBootQuips` set `_bootOnMessage = null`.
   So the sink `ensureSandboxBooted` had just set was wiped BEFORE the ticker's
   first tick could paint — frozen label in EVERY case. Fixed: `stopBootQuips`
   only stops the timer; the sink is cleared solely on a full `resetSandbox`.

> **LOAD-BEARING GUARD — do not reintroduce.** `stopBootQuips` MUST NOT clear
> `_bootOnMessage`, and the ticker MUST read the sink at module scope (never a
> captured param), or the boot line freezes again. `ensureSandboxBooted` sets the
> sink BEFORE `bootVM` runs; that ordering is the contract.

If you see a frozen boot label, confirm the sink survives `startBootQuips`'s
internal `stopBootQuips()` — don't chase the disk fetch; the boot may be fine,
only its progress invisible.

## Caveats

- **A synchronous WASM busy-loop would starve the watchdog timer.** The realistic
  "booting sandbox" spinner is an unresolved network/await (disk fetch, module
  import), which yields the main thread and lets the timer fire. A hard
  CPU-spin inside CheerpX would not — but that presents as a frozen tab, not a
  spinner, and is out of scope here.
- **Turn verbose OFF when done** — it flushes a beacon per event.
- Editing `sandbox.js` changes a bundled source file: after any change run
  `npm run bundle` + `npm run bundle:rag` and commit all three (the introspection
  snapshot freshness test fails otherwise — see the **introspection** skill).
- `sandbox.js` is not `@ts-check`'d and not Node-unit-tested (browser/WASM glue);
  it IS import-safe in Node (drc-research.test.js pulls it in), so keep the new
  code guarded behind `typeof window/localStorage/location` checks and Node-safe
  globals (`setInterval`/`clearInterval`).
