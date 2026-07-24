# Sandbox command performance

Measured cost of running shell commands in the in-browser Linux sandbox
(CheerpX, `public/js/sandbox.js`), and what follows from it for the commands
the bash-lite agent should prefer.

All numbers come from `tests/e2e/sandbox-perf.spec.js` driving a real Chromium
against production. They are order-of-magnitude figures, not benchmarks: the
disk is streamed over the network, so run-to-run variance of ±50% is normal on
anything that touches a cold block. The *ratios* are stable and are what the
guidance rests on.

```bash
cd tests
npx playwright test --config=sandbox-perf.pw.config.js -g "performance"   # the battery
npx playwright test --config=sandbox-perf.pw.config.js -g "agent trace"   # one agent turn, timestamped
PERF_REPEATS=5 npx playwright test --config=sandbox-perf.pw.config.js     # more samples
```

Both specs need `BASIC_AUTH_USER` / `BASIC_AUTH_PASS` (break-glass), and both
call `stripCrossOriginAuth()` from `e2e/helpers.js` — see the "Auth must not
reach the CDN" note at the bottom, which is a trap worth knowing about.

## The cost model

Four costs dominate, in this order. Nothing else measured mattered.

### 1. Cold block streaming — 10× to 100×

The root filesystem is a Debian ext2 image streamed block by block from
`wss://disks.webvm.io`, cached in IndexedDB. The first execution of a binary
pulls its ELF and every library it links; the second reads the cache.

| command | cold | warm | ratio |
|---|---|---|---|
| `python3 --version` | 8573 ms | 87 ms | 98× |
| `perl -e 'print 42'` | 8333 ms | 108 ms | 77× |
| `find /usr/share/doc -maxdepth 2` | 9751 ms | 268 ms | 36× |
| `du -sh /etc` | 5770 ms | 161 ms | 36× |
| `ls /usr/bin \| wc -l` | 1143 ms | 125 ms | 9× |
| `/usr/bin/test -f …` | 343 ms | 69 ms | 5× |

This is the largest single effect in the system, and it is entirely about
*which* binaries and directories a command touches — not how much work it does.
A command is cheap or expensive mostly according to whether someone already ran
something similar in this VM.

### 2. The exec round-trip floor — 50 to 85 ms

Every `execInSandbox` is one `/bin/sh -c` on a WASM CPU, wrapped in a
marker-and-base64 envelope. `true` costs 50–85 ms and that is the floor for any
command whatsoever. Ten trivial commands as ten round-trips cost ~10× what the
same ten cost batched into one.

### 3. Process spawns — 6.5 ms each, minimum

A fork-cost ladder (identical loop body, only the spawn count varying) gives a
clean linear fit:

```
   0 spawns →  86 ms
  10 spawns → 145 ms
  25 spawns → 238 ms
  50 spawns → 375 ms
 100 spawns → 740 ms
 → 6.51 ms per spawn (intercept 76 ms = the round-trip floor)
```

6.5 ms is the floor, measured with `/bin/true`. A substantial binary costs
several times that: `find -exec grep` over 200 files takes 5994 ms against
111 ms for one recursive `grep` — about 29 ms per `grep` spawn.

Shell builtins are effectively free by comparison. 1500 builtin `[ -f … ]`
tests cost 169 ms total (~0.1 ms each), so syscalls are not the problem —
process creation is. This matches the finding already recorded in
`public/js/sandbox-files.js`, where a per-file `cp` seed blew the 90 s boot
ceiling on a phone and was replaced by a single `tar -xf`.

### 4. Returning output — about 1.1 MB/s

Cost tracks bytes *returned to JS*, not bytes read inside the VM. The clearest
pair:

| command | warm | what it does |
|---|---|---|
| `wc -c < f2048k.txt` | 60 ms | reads 2 MB, returns 8 bytes |
| `cat f2048k.txt` | 1903 ms | reads 2 MB, returns 2 MB |
| `head -c 1024 f2048k.txt` | 63 ms | reads 2 MB, returns 1 KB |

Reading 2 MB inside the guest is nearly free. Handing 2 MB back across the
VM→JS boundary costs ~1.9 s. Below ~64 KB the round-trip floor dominates and
size is irrelevant:

| size | warm | ms/KB |
|---|---|---|
| 1 KB | 78 ms | 78 |
| 64 KB | 136 ms | 2.1 |
| 512 KB | 451 ms | 0.88 |
| 2048 KB | 1903 ms | 0.93 |

Marginal throughput above 64 KB is ~0.9 ms/KB, i.e. ~1.1 MB/s.

## What this means for the agent

Prefer:

- **Batching.** Several steps in one `execInSandbox` pay the ~50–85 ms floor
  once. Five commands batched cost 106 ms; as five round-trips they cost ~350 ms
  before any work.
- **One process over many.** `grep -rl needle tree/` (111 ms) instead of
  `find tree/ -exec grep -l needle {} \;` (5994 ms) — same answer, 54× apart.
  Same for `seq 1 50` (82 ms) over a 50-iteration loop spawning `/bin/echo`
  (596 ms).
- **Builtins where they exist.** `echo`, `pwd`, `[` cost nothing; `/bin/echo`,
  `/bin/pwd`, `/usr/bin/test` add a spawn and, on first use, a cold ELF fetch.
- **Slicing output at the source.** `head -c`, `wc -l`, `grep -c`, `cut` — let
  the guest reduce, and return a small answer. Returning a whole file to have
  the model read part of it is the expensive shape.

Avoid:

- **Interpreters for small jobs.** A cold `python3` is 8.5 s. `awk`/`sed` cost
  ~100 ms warm and cover most of what one-line Python would do.
- **Walking cold trees.** Anything under `/usr/share`, `/usr/lib`, or a broad
  `grep -r` outside a known-warm directory pulls megabytes over the network.
- **`command -v <tool>` for a tool that is not installed.** This looks harmless
  and is one of the most expensive things measured: it stats every `PATH`
  directory, all cold, and in one run took the full 30 s ceiling.

## The 30 s ceiling destroys the VM

This is the sharpest operational edge and it is easy to hit by accident.

`execInSandbox` races every command against `DEFAULT_EXEC_TIMEOUT_MS` (30 s).
On timeout it returns rc 124 *and calls* `resetSandbox("exec_timeout")`, which
discards the CheerpX instance — CheerpX cannot abort a running guest process, so
throwing the VM away is the only way to avoid running the next command on a
wedged one. Every later command then returns `sandbox not ready` until something
re-boots, and a re-boot gets a fresh overlay, so anything written to the
filesystem is gone.

Observed twice while building this battery:

- An unbounded `grep -rl … /usr/share/doc` hit the ceiling and cost the 15
  probes that followed it — they all returned `sandbox not ready`.
- `command -v node >/dev/null && node --version || echo '(node absent)'` — a
  command written specifically to be safe when `node` is missing — took the full
  30 s cold and destroyed the VM.

So a single unlucky command does not merely fail; it ends the sandbox for the
rest of the turn. Two mitigations, both cheap:

- Wrap anything that might walk a cold tree in a guest-side `timeout 20 …`, so
  the command fails inside its own budget and the VM survives. The battery does
  this for every cold-region probe.
- Treat rc 124 as "the VM is gone", not "this command was slow". The battery's
  runner detects it, re-boots, and re-creates its fixtures.

## Where a sandbox-backed turn spends its time

From `sandbox-agent-trace.spec.js`, one turn that wrote a file and read it back:

```
     t(ms)   Δ(ms)  event
        0       0  ── send-click ──
       83      83  req: /api/bash/step
     1691    1608  res: /api/bash/step 200
    26333   24642  req: /api/bash/step          ← VM boot 24352 ms + commands ~290 ms
    27389    1056  res: /api/bash/step 200
    27391       2  req: /api/chat
    28148     243  sse: step_start [introspect] Reading the site's own source…
    34597    5716  sse: step_done  [source] Read 5 source files from the project
    37143    2546  sse: 452 answer deltas over 6218 ms (2124 chars)
    43892     531  sse: done (15564ms)
    44275     262  ── turn-complete ──

  round 1: step 1608 ms   exec window 24642 ms  = VM boot 24352 ms + commands ~290 ms
  round 2: step 1056 ms   (last round)
  shell loop total : 27306 ms  (LLM steps 2664 ms + in-VM 24642 ms)
```

The commands themselves were 290 ms of a 44 s turn. Everything else was the
cold VM boot (24.4 s here, with the `/src` source mount; a bare boot measures
3.6–4.4 s) and the LLM. **Optimising command choice matters far less than not
paying a cold boot**, which argues for pre-warming the VM and for keeping it
alive rather than shaving milliseconds off individual commands.

## On short-circuiting `cat`

An obvious idea is to intercept `cat <path>` in `execInSandbox` and serve it
some faster way. The measurements say what that would and would not buy.

It would **not** avoid the dominant cost. `cat`'s expense is not the disk read
(`wc -c` proves reading 2 MB is ~60 ms) and not the spawn (~6.5–30 ms) — it is
moving the bytes across the VM→JS boundary at ~1.1 MB/s. A shortcut that still
reads the guest filesystem pays that same transport, because the guest's ext2
image is only reachable through the VM. Net saving: one spawn, tens of
milliseconds.

There is one case where a shortcut is genuinely free, and it is worth doing:
**files the host itself put into the VM**. Mounted attachments, project files,
and the `/src` introspection tree are all seeded from `Uint8Array`s that JS
still has (`public/js/sandbox-files.js`). For a path under `/workspace`,
`/mnt/<proj>`, or `/src` that has not been modified in-guest, the host can
answer a read from its own copy without entering the VM at all — saving the
full round trip, and for a large file seconds of base64 transport. The
correctness condition is the hard part: the guest may have rewritten the file,
so the shortcut needs either a modification check or a restriction to paths the
agent has not written to in this session.

The larger win is upstream of any of this: teach the step prompt to slice at
the source. `head -c 2000 file` costs 63 ms against `cat file`'s 1903 ms on a
2 MB file, and for a model that is about to read the content anyway, the sliced
version is usually what it actually needed.

## Auth must not reach the CheerpX CDN

Both configs authenticate with Playwright's `extraHTTPHeaders`, which is
required — an unauthenticated `/` redirects to the anonymous `/cure` tier, which
never sets `window.__appReady`, so origin-scoped `httpCredentials` does not work
(no 401 challenge ever happens). But Playwright puts those headers on *every*
request the context makes, cross-origin included, and with an `authorization`
header attached the runtime's `import(CHEERPX_CDN)` fails with
`net::ERR_FAILED`. The VM then dies at the "loading CheerpX…" stage — measured
3.2 s, every time — and the spec silently exercises only the fail-soft fallback
instead of the sandbox.

`stripCrossOriginAuth(context)` in `tests/e2e/helpers.js` removes the header for
any origin that is not the site under test. Call it in any spec that boots the
sandbox. It also stops handing the break-glass admin password to third parties.
