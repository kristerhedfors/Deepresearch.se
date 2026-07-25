---
name: sandbox-perf-eval
description: >-
  Load when measuring or reasoning about how LONG things take in the in-browser
  Linux sandbox — "which commands are slow", "why is the sandbox turn taking a
  minute", "should we shortcut cat / hijack file reads", "profile the shell
  loop", tuning which commands the bash-lite step prompt proposes, or picking a
  per-command timeout. Covers the two browser-driven harnesses
  (tests/e2e/sandbox-perf.spec.js — a cold/warm command battery with a fork-cost
  ladder and a read-size slope; tests/e2e/sandbox-agent-trace.spec.js — one
  agent turn with every event timestamped), both run via
  tests/sandbox-perf.pw.config.js, how to add a probe, how to read the output,
  and the measured cost model in docs/SANDBOX-PERFORMANCE.md. ALSO the two traps
  that make these runs silently useless: the break-glass Authorization header
  reaching the CheerpX CDN (the VM then never boots and you test only the
  fail-soft fallback), and a command hitting the 30 s exec ceiling, which
  DESTROYS the VM so every later command returns "sandbox not ready". Companion
  to execution-sandbox (the feature) and sandbox-debug (boot hangs); this one is
  the performance-evaluation loop.
---

# Evaluating sandbox command performance

The sandbox's cost model is not a normal Linux box's, so intuition transfers
badly. This skill is the method for measuring it, and the traps that make a run
look successful while measuring nothing.

The measurements themselves and the guidance drawn from them live in
**`docs/SANDBOX-PERFORMANCE.md`** — read that for the numbers. This file is how
to reproduce and extend them.

## Running it

```bash
cd tests && npm install                                                    # once
npx playwright test --config=sandbox-perf.pw.config.js -g "performance"    # battery, ~2 min
npx playwright test --config=sandbox-perf.pw.config.js -g "agent trace"    # one turn, ~1 min
PERF_REPEATS=5 npx playwright test --config=sandbox-perf.pw.config.js -g "performance"
TRACE_PROMPT="…" npx playwright test --config=sandbox-perf.pw.config.js -g "agent trace"
```

Needs `BASIC_AUTH_USER` / `BASIC_AUTH_PASS`. Both write a JSON attachment
(`sandbox-perf.json`, `sandbox-agent-trace.json`) with every raw sample, so a
run can be re-analysed without re-running it.

**Pipe output to a file, not to `tail`.** Playwright's list reporter plus the
specs' own `console.log` only reach a pipe when the run ends; `| tail -N` looks
like a hang for the whole run. Redirect to a log and poll it instead.

**Do not run anything else heavy concurrently.** Both harnesses measure wall
time in a single-threaded WASM VM; a parallel browser or test run skews every
number.

## What the battery measures, and why it is shaped that way

`tests/e2e/sandbox-perf.spec.js` boots one bare VM (no file mounts, so a seed
does not contaminate the timings), builds fixtures, then runs each probe
`PERF_REPEATS` times.

**Every probe reports cold (run 1) and warm (median of the rest) separately.**
This is not a nicety — cold/warm is the largest effect in the system (up to
98×), because the root filesystem is an ext2 image streamed block-by-block from
`wss://disks.webvm.io` behind an IndexedDB cache. A single-sample benchmark of
this sandbox measures network luck, not the command.

Probes are grouped by the QUESTION each answers, not by command, so the report
reads as guidance: round-trip floor, builtin vs external, directory-by-mount,
read-by-size and by-location, tree scans, interpreter startup, command shape,
and a fork-cost ladder.

Two groups exist to isolate a slope rather than a single figure:

- **Fork ladder** (`fork-0/10/25/50/100`, identical loop body, only the spawn
  count varying) — a least-squares fit over it gives the marginal cost of one
  process spawn, with the intercept falling out as the exec round-trip floor.
  This is more trustworthy than differencing two hand-picked commands, which
  confounds the spawn with the tool's own work.
- **Read-size fixtures** (1/64/512/2048 KB) — the slope above 64 KB is the
  VM→JS transport rate; below it the round-trip floor dominates and size is
  irrelevant.

### Adding a probe

Append to `PROBES` with `{ id, group, cmd, note }`; add the group to `GROUPS` if
it is new. Rules learned the hard way:

- **Bound anything that might walk a cold tree** with a guest-side
  `timeout 20 …`, under the 30 s ceiling. See the ceiling section below.
- **Pair every "expensive" probe with the cheap equivalent that produces the
  same answer.** A number alone is not guidance; `find -exec grep` (5994 ms)
  next to `grep -r` (111 ms) is.
- **Keep the note honest about what is being paid.** `wc -c < f2048k.txt` is
  only interesting stated as "reads 2 MB, returns 8 bytes".

## Trap 1 — the auth header must not reach the CDN

`tests/sandbox*.pw.config.js` authenticate with Playwright's
`extraHTTPHeaders`. That is **required**: an unauthenticated `/` 302s to the
anonymous `/cure` tier, which never sets `window.__appReady`, and the Worker
never emits a 401 challenge, so `httpCredentials` (even origin-scoped) never
engages.

But Playwright puts those headers on *every* request the context makes,
cross-origin included, and with an `authorization` header attached the CheerpX
runtime's `import(CHEERPX_CDN)` fails with `net::ERR_FAILED`. The VM then dies
at the "loading CheerpX…" stage — measured 3.2 s, reproducibly — and the spec
happily passes while exercising only the fail-soft fallback.

**Every spec that boots the sandbox must call `stripCrossOriginAuth(context)`**
(`tests/e2e/helpers.js`) before navigating. It removes the header for any origin
that is not the site under test, which also stops handing the break-glass
password to third parties.

The signature to recognise, from the boot summary:

```
BOOT: { ok: false, ms: 3246,
  fs: { err: "Failed to fetch dynamically imported module: https://cxrtnc.leaningtech.com/…/cx.esm.js" } }
```

Also always assert readiness with a **fail-fast** guard. A bare
`waitForFunction(() => window.__appReady)` on a page that landed on `/cure` will
consume the entire test timeout and produce no output at all — 20 minutes for
nothing, observed.

## Trap 2 — the 30 s ceiling destroys the VM

`execInSandbox` races every command against `DEFAULT_EXEC_TIMEOUT_MS` (30 s,
`bash-core.js`). On timeout it returns rc 124 **and calls
`resetSandbox("exec_timeout")`**, discarding the CheerpX instance — CheerpX
cannot abort a guest process, so throwing the VM away is the only way to keep
the next command off a wedged one.

Consequences for any evaluation, and for production alike:

- Every later command returns `sandbox not ready` until something re-boots.
- A re-boot gets a **fresh overlay**, so fixtures and anything else written to
  the filesystem are gone. A recovery that does not re-seed measures a different
  machine than the one before the timeout.
- One unlucky command therefore ends the sandbox for the rest of the turn.

The battery's runner handles this: it treats rc 124 or `not ready` as "the VM is
gone", re-boots, re-runs the fixture setup, and records `killedVm` /`recovered`
on the probe so the report shows it instead of silently losing the rest of the
run. Preserve that behaviour when editing the runner — the first real run lost
15 of 40 probes to a single unbounded `grep -r /usr/share/doc`.

Commands that look harmless and are not: `command -v <tool>` for a tool that is
**not** installed stats every `PATH` directory, all cold, and took the full 30 s
in one run — destroying the VM.

## The agent trace

`tests/e2e/sandbox-agent-trace.spec.js` runs one real sandbox-backed chat turn
and timestamps every observable event, relative to the send click.

The measurement seam matters: **`execInSandbox` is imported as a module binding
in `stream.js`, not read off `window`**, so it cannot be monkey-patched from a
test. The trace instead wraps `window.fetch` in an init script and derives in-VM
time from the GAP between one `/api/bash/step` response and the next request —
that window IS the round's execution. `window.__DR_SANDBOX.exec` exists but is
only used by the battery, which calls it directly.

Two things the report must keep doing, both learned by getting them wrong:

- **Parse the real SSE shape.** Frames are OpenAI-style deltas
  (`{"choices":[{"delta":{"content":…}}]}`) plus custom
  `{"status":{"type":…}}` events — there is no top-level `type`, so a naive
  parser logs several hundred `(no-type)` lines. See the **sse-protocol** skill.
- **Collapse consecutive answer deltas** into one row. 452 delta frames printed
  individually bury every pipeline phase in the timeline.

**Attribute round 1's exec window to the boot.** The sandbox boots lazily, on
the first proposed command, so round 1's window is boot + commands. Splitting it
with `sandboxFsSummary().ms` is the difference between "in-VM execution took
24.6 s" and the truth: 24.4 s of cold boot and 290 ms of commands.

## Interpreting results

- **Ratios, not absolutes.** Anything touching a cold block varies ±50% between
  runs. `docs/SANDBOX-PERFORMANCE.md` states figures to two significant digits
  for that reason, and the assertions in both specs only check that usable data
  was produced — these are exploration tools, never merge gates.
- **Check what the run actually did before trusting it.** `boot.ok`, `VM LIVE`,
  and any `killedVm` notes come first; a battery whose VM never booted still
  prints a full table of `-1`s.
- **Re-run after anything that changes the disk image, the CheerpX version
  (`CHEERPX_CDN` in `sandbox.js`), the exec envelope in `bash-core.js`, or the
  mount plan.** Those are the only changes that move these numbers; ordinary
  pipeline work does not.

## What the numbers are for

The point is choosing what the bash-lite step prompt proposes. In one traced
turn the commands were 290 ms of a 44 s turn, so the ranked levers are:

1. **Do not pay a cold boot** — pre-warm, and keep the VM alive.
2. **Batch** — the ~50–85 ms exec floor is paid per round-trip, not per command.
3. **One process, not many** — spawns cost 6.5 ms minimum, ~29 ms for a real
   binary; builtins are ~0.1 ms.
4. **Return less** — cost tracks bytes handed back (~1.1 MB/s), not bytes read.
   Slice in the guest with `head -c` / `wc -l` / `grep -c`.

Micro-optimising individual commands sits below all of these. Before proposing
an optimisation (the recurring "short-circuit `cat`" idea, for example), check
which of the four costs it actually removes — `docs/SANDBOX-PERFORMANCE.md`
works that specific example through, and the answer is that it removes the
spawn but not the transport, except for host-seeded files whose bytes JS still
holds.
