---
name: pygram
description: >-
  Load when working on pygram — the minimal Python-subset runtime built for the
  in-browser CheerpX sandbox (docs/PYGRAM.md). Triggers: "build pygram", "run
  the pygram gates", "why is python slow in the sandbox", "add a module to
  pygram", "the conformance run has mismatches", "grow the python corpus",
  anything touching pygram/, scripts/pygram-build.sh, scripts/pygram-gate.mjs,
  scripts/pygram-capture/, or tests/pygram/. Covers the cost model that
  justifies the project, the two gates and how to read them, the capture
  harness that grows the corpus by itself, and the six traps already paid for —
  including a .gitignore that silently swallowed the whole frozen stdlib and a
  measurement bug that inverted into a pass.
---

# pygram — the minimal Python for the sandbox

**pygram** (py + gram) is a MicroPython unix-port variant — static, musl, i386,
frozen stdlib — that runs the python one-liners an agentic CLI actually types,
inside the CheerpX Linux VM. It is deliberately not a Python implementation.

Full charter: `docs/PYGRAM.md`. Subset spec: `docs/PYGRAM-SUBSET.md`. The survey
that chose the base: `docs/PYGRAM-RESEARCH.md`.

## 1. The one number that justifies everything

`docs/SANDBOX-PERFORMANCE.md` §1, measured against production:

> `python3 --version` — **8573 ms cold**, 87 ms warm. The exec ceiling is 30 s,
> and crossing it **destroys the VM and ends the agent's turn.**

The cost is not CPU. The root filesystem streams block by block over a
WebSocket, so cold cost tracks **bytes and file-opens**, nothing else. CPython
opens 22 files on `-c 'pass'`, probes 7 more that do not exist, and makes 65
stat calls, from a 6.6 MB dynamically linked binary. pygram opens **zero**.

**So optimise for file touches, not RSS and not warm throughput.** Any change
that adds a file the interpreter reads at startup is a regression even if it
makes the binary smaller.

Three costs bound what is achievable and no runtime beats them: a **50–85 ms
exec round-trip floor** per command, **6.5 ms** per process spawn, and
**~1.1 MB/s** returning output to JS.

## 2. The two gates — run both, they answer different questions

```bash
node scripts/pygram-gate.mjs pygram/build/pygram --compare   # shape
PYGRAM_BIN=pygram/build/pygram npm run pygram:conformance    # correctness
```

**The build gate** checks static / ≤700,000 B / ≤3 file opens on `-c 'pass'`,
and prints CPython beside it. It projects a cold cost from the measured shape —
that projection is a convenience, never the acceptance. `docs/PYGRAM.md` §2
accepts on `tests/e2e/sandbox-perf.spec.js` against a real VM.

**The conformance runner** executes every corpus entry under *both* CPython and
pygram and splits the result three ways. The split is the whole point:

| verdict | meaning | is it a failure? |
|---|---|---|
| MATCH | stdout + exit code identical to CPython | no |
| UNSUPPORTED | exit **90** with `pygram: unsupported: <kind>: <detail>` | **no** — this is coverage, and the build order |
| MISMATCH | anything else | **yes, always** |

Silent semantic divergence is the one outcome that would make a subset runtime
worse than nothing, because the agent that typed the one-liner will not notice.
MISMATCH must be zero; UNSUPPORTED is just work not done yet.

Useful invocations:

```bash
node tests/pygram/conformance.mjs                    # reference-only: is the CORPUS still sane?
... conformance.mjs --plan                           # just the ranked build order
... conformance.mjs --tag json                       # one module at a time
... conformance.mjs --json | node -e '…'             # machine-readable
```

`--plan` ranks every missing feature by how many corpus entries it unblocks.
**That is the build order.** Re-run after each module — the counts shift as
features land, because an entry is only ever blocked by the first thing the
interpreter hits.

## 3. The corpus grows by itself — do not hand-write entries

`scripts/pygram-capture/` installs a `python`/`python3` shim early on `$PATH`
that logs every invocation, plus a PreToolUse hook that catches command strings
the shim cannot see (heredocs, `uv run`). `harvest.mjs` merges those and any
Claude Code transcript into `tests/pygram/corpus.jsonl`, deduped by normalised
program text. Both are wired into `.claude/settings.json`, so every session in
this repo feeds it.

```bash
sh scripts/pygram-capture/install          # idempotent; --status, --uninstall, --force
npm run pygram:harvest
```

Two rules that keep the evidence honest:

- **The two corpus files stay separate.** `seed-corpus.jsonl` is written from
  expectation; `corpus.jsonl` is harvested from real invocations. Blending them
  lets guesswork inflate the frequency table that decides build order.
- **Harvest redacts before committing.** Captured programs embed repo content;
  the `scripts/scan-secrets` patterns run over every entry. This is not
  theoretical — two credential-shaped tokens were redacted on the first real
  harvest.

## 4. Building

```bash
bash scripts/pygram-build.sh          # musl-i386 from source, pinned MicroPython, variant, strip
```

`gcc -m32 -static` works in the dev container **and i386 binaries execute
there**, so the real target artifact can be built and gated in CI with no
browser, no VM, no Docker and no cross toolchain. Building musl for i386 from
source takes under a minute. Two flag traps: the target is `i686`, not `i386`,
and it needs `AR=ar RANLIB=ranlib`; the `musl-gcc` wrapper then needs
`-Wl,-m,elf_i386`.

**musl is a precondition, not a preference.** An empty `main` is 635,744 B
under glibc-static i386 and 13,020 B under musl. The 700 KB gate is unreachable
with glibc before a single line of interpreter exists.

**The `sys.path` pin is load-bearing.** MicroPython probes `sys.path` *before*
consulting the frozen table, at 3 `statx` per entry per module. Trimming the
path to `['.frozen']` cut a workload from 56 syscalls to 26. Verify with
`strace` after any variant change — this is exactly the pathology the project
exists to avoid, and it is invisible without measuring.

## 4a. Optimising it further — what is left, and what is settled

The 2026-08-14 pass took the binary 390,456 → 304,440 B (−22%) with 0 MISMATCH
throughout. `docs/PYGRAM.md` §8a has the full table. What matters when you come
back to this:

**Opens are at zero and cannot improve.** A six-module import costs 13 syscalls
and no file syscalls at all. Cold cost tracks bytes and opens, so **bytes are
the only lever left** — check `size -A` before theorising about anything else.

**The wins were dead weight, not tuning.** `.eh_frame` was 51,644 B of DWARF
unwind tables that nothing could read (MicroPython raises through setjmp, and
`nm` shows zero `_Unwind`/`__cxa`/`backtrace` symbols); `--gc-sections` does not
collect `.eh_frame`, so it survives size passes while looking legitimate. Then
`framebuf` + `uctypes` at 9,789 B. **The test for cutting a module is not "is it
in the corpus" but "does CPython have it"** — conformance is defined against
CPython, so a MicroPython-only module can never appear in a MATCHing entry.
That is why `framebuf`/`uctypes`/`micropython` went and `heapq` stayed despite
zero corpus references.

**LTO is on, and it is the one flag that is also a correctness risk.** It buys
16,384 B and 16% workload speed, but LTO across setjmp/longjmp is the classic
miscompile and that is exactly how MicroPython raises. The six `nlr-*`
seed-corpus entries exist for this. If you bump MicroPython or change LTO flags,
those are the entries to watch.

**Settled negatives — do not re-run these:** disabling computed goto (saves
4,096 B, costs 0.14 ms per program, break-even at ~37 programs per session);
cutting `complex` (the `1j` literal escapes the exit-90 contract and closing it
costs a port-patch hunk); `ld.lld` (cannot consume GCC's GIMPLE LTO plugin);
`ld.gold --icf=safe` (folds 14 bytes and forbids `-z noseparate-code`); `-Oz`
(a clang flag, not GCC).

**Two traps when measuring.** File size is quantised to the 4,096 B page, so
unrelated changes all report −4,096 B and one of them may have moved 2,100 B —
use `size -A`. And a synthetic heavy workload overstates VM speed by ~10× against
the real corpus; time the 340 corpus programs, not a benchmark you wrote.

Rebuilding after a **config** change needs the generated headers dropped —
`rm -rf pygram/.build/micropython/ports/unix/build-pygram` — or a stale
`moduledefs.h` keeps a disabled module in the builtin table and the link fails
on `undefined reference to mp_module_framebuf`.

## 5. Traps already paid for

Each of these cost real time and each would recur.

- **A bare `lib/` in the root `.gitignore` swallowed the entire frozen
  stdlib.** It comes from the standard Python-packaging template, and unanchored
  it matches a directory named `lib` at *any* depth — so every module in
  `pygram/lib/` was untracked. It built perfectly locally and would have shipped
  a stdlib-less binary from CI. Now `/lib/`. **Check `git check-ignore -v` on a
  new source directory before trusting that it is committed.**
- **Tracebacks must go to stderr.** pygram wrote uncaught tracebacks to
  *stdout*, which poisons a pipeline — `stdin → transform → stdout` is the
  corpus's largest cluster, so `pygram … | wc -l` counted the traceback. The
  exit code was right, which is what makes it insidious. The exit-90 contract
  line has the identical failure mode; both are pinned by tests.
- **A measurement bug can invert into a pass.** The gate's strace parser missed
  the bare-pid prefix that `-f -o` emits and read a 110-line trace as **zero
  file opens** — a perfect score on the project's central metric. Zero is the
  target, so nothing looked wrong. Prefix forms are now pinned in
  `scripts/pygram-gate.test.mjs`.
- **The capture shim breaks naive baselines.** With the shim installed,
  `command -v python3` returns an 8,971-byte shell script; measuring it as "the
  baseline" gave 30 file opens and a projected cold cost of 330 seconds. A wrong
  baseline is worse than none because it looks like a number. Use
  `findRealCPython`, which walks PATH for a genuine ELF.
- **Per-entry temp cwd breaks relative binary paths.** The conformance runner
  gives every entry its own temp directory (so file-writing entries stop
  littering the repo, and so pygram cannot read back a file CPython created).
  That makes `PYGRAM_BIN=pygram/build/pygram` resolve against the temp dir.
  Resolve to absolute once.
- **`process.exit()` truncates piped stdout.** Node's stdout is async on a pipe,
  so `--json` was cut mid-object. Set `process.exitCode` and return.

## 6. What is deliberately NOT here

- **No daemon.** `pygramd` was an explicit requirement and was measured before
  being dropped: interpreter init is **0.96 ms against a 0.92 ms empty-C
  floor**, so a zygote amortises 0.04 ms inside a 50–85 ms exec floor it cannot
  touch — and signal delivery and process termination **do not work in the
  CheerpX guest**, which is a fork server's core loop. Owner-confirmed
  2026-08-13. The design is preserved in `docs/PYGRAM.md` §4 with the
  measurement that would justify reversing it. Do not rebuild it on intuition.
- **No `subprocess`.** It appears nowhere in this repository, so excluding it is
  evidence rather than taste. It must exit 90 rather than fake a shell-out, so
  the agent hoists the command into its own bash block.
- **pygram is not a platform-wide python replacement.** It wins in the streamed
  in-browser VM. In `container/Dockerfile` — a normal container on a normal
  filesystem — CPython's cold cost is a page-cache miss, and pygram buys little.

## 7. Honest scope

Cold **VM boot** still dominates a sandbox turn: 24.4 s of boot against 290 ms
of commands. pygram improves a real but **secondary** term. It is worth doing
because 8.5 s is a large secondary term that can cross the 30 s ceiling and
destroy the VM, and because dropping CPython takes 27.0 MiB and 16 shared
libraries out of an image whose whole design goal is to stream without
stalling. It does not make the sandbox fast, and no user-facing copy should say
so.
