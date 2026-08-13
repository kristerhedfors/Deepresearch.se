# pygram — a minimal Python for the in-browser sandbox

*Charter and design. Started 2026-08-13.*

**pygram** (py + gram) is a Python-subset runtime built for one job: run the
python one-liners an agentic coding CLI actually types, inside the in-browser
CheerpX Linux VM, without the cold-start cost that makes `python3` unusable
there.

It is deliberately **not** a Python implementation. It is the smallest thing
that executes the observed corpus. Everything it does not cover, it must fail
on loudly and predictably (§6).

> **Status: design + build in progress.** Nothing here is deployed. The
> companion documents are `docs/PYGRAM-RESEARCH.md` (what to build it from),
> `docs/PYGRAM-SUBSET.md` (what it must execute), and the corpus at
> `tests/pygram/`.

## 1. Why — the measurement that justifies the project

From `docs/SANDBOX-PERFORMANCE.md` §1, measured by
`tests/e2e/sandbox-perf.spec.js` driving a real Chromium against production:

| command | cold | warm | ratio |
|---|---|---|---|
| `python3 --version` | 8573 ms | 87 ms | 98× |
| `perl -e 'print 42'` | 8333 ms | 108 ms | 77× |

Eight and a half seconds to print a version string. The exec ceiling is 30 s,
and a command that crosses it **discards the VM and ends the agent's turn** —
so a cold python is not merely slow, it is within one factor of fatal.

The cause is not CPU. The root filesystem is an ext2 image streamed block by
block over a WebSocket and cached in IndexedDB, so the first execution of a
binary pulls its ELF, every library it links, and every file it opens, over the
network. CPython is close to the worst possible shape for that: a dynamically
linked interpreter plus `libpython`, plus `import site`, plus the `encodings`
package, plus a `/usr/lib/python3.11/` tree that a trivial `-c 'pass'` walks a
surprising amount of.

**So the metric pygram is optimised against is bytes and file-opens touched on
a cold run — not RSS, not warm benchmark throughput.** A fully static binary
with its standard library compiled in touches exactly one file: itself.

The other three costs bound what any solution can achieve
(`docs/SANDBOX-PERFORMANCE.md` §2–§4):

- **50–85 ms exec round-trip floor**, per command, unavoidable. No runtime and
  no daemon beats this.
- **6.5 ms per process spawn.**
- **~1.1 MB/s** returning output across the VM→JS boundary.

The 50–85 ms floor sets the target. There is no point making pygram faster than
the envelope it arrives in; the goal is to get a cold one-liner from ~8.5 s down
to *within the same order as the floor*.

## 2. Acceptance metric

One number, measured the same way the table above was measured — a new case in
`tests/e2e/sandbox-perf.spec.js`, against a real VM, cold cache:

> **A cold `pygram -c '<typical corpus one-liner>'` completes in under 500 ms,
> and a warm one within the 50–85 ms exec floor.**

Secondary, checked locally and cheaply in CI:

| gate | target | how it is checked |
|---|---|---|
| stripped static binary size | ≤ 700 KB | `node scripts/pygram-gate.mjs` |
| file-opens on `-c 'pass'` | ≤ 3 | same, via `strace -f -e trace=file` |
| linked shared objects | 0 | same, `file` reports "statically linked" |
| corpus conformance | 100% of Tier 0 | `npm run pygram:conformance` |

`scripts/pygram-gate.mjs` enforces the first three and prints the baseline
alongside, so a build change is judged in seconds instead of a Playwright run.

### The baseline, measured

`node scripts/pygram-gate.mjs <bin> --compare` on this dev container, against
the system CPython 3.11:

| | CPython 3.11 | an empty static i386 C binary |
|---|---|---|
| binary | 6,639,992 B, dynamically linked | 703,120 B, statically linked |
| distinct files opened on `-c 'pass'` | **22** | **0** |
| failed open probes | 7 | 0 |
| `stat`/`access` calls | 65 | 0 |

Twenty-two files opened, seven more probed and missed, sixty-five stat calls —
each one a lookup that in the VM crosses a network. That is the 8573 ms.

The 703 KB figure is also a warning: that is glibc-static with **no interpreter
in it at all**. The same empty program against musl is 18,688 B on x86-64 and
13,020 B on i386. So a musl-based static build is not a preference, it is a
precondition, and `docs/PYGRAM-RESEARCH.md` §2.1 has the working i386 musl
build — from source, in this container, in under a minute, no Docker and no
cross toolchain.

That measurement also retired the original 400 KB size gate. It was set before
the floor was known and was unreachable for anything that speaks Python: an
empty `main` is 635,744 B under glibc-static i386, and Berry — a complete,
mature dynamic-language VM with **neither `re` nor `json`** — compiles to
365,660 B. **The gate is 700 KB**, set against the measured 541,688 B
MicroPython prototype with room for the frozen shims.

### The toolchain works here, which makes the gate cheap

Verified in this container: `gcc -m32 -static` produces a working
`ELF 32-bit LSB executable, Intel 80386, statically linked`, **and i386
binaries execute here**. So the real target artifact can be built and measured
locally and in CI without a browser or a VM. `strace` is available and
unrestricted. What is missing is a 32-bit musl libc (`musl-gcc` here is
x86-64 only) and a usable Docker daemon.

The conformance runner is the one that matters for correctness: every corpus
entry is executed by **both** system CPython and pygram, and the stdout, stderr
and exit code must match. A subset runtime that silently disagrees with Python
is worse than no runtime, because the agent will not notice.

## 3. The implementation, and the daemon that was asked for

**Decided (2026-08-13, `docs/PYGRAM-RESEARCH.md` §6): pygram is a MicroPython
unix-port variant** — static, musl, i386, with a frozen pygram stdlib and
`sys.path` pinned to `['.frozen']`. A shallow variant, so tracking upstream
stays a rebase rather than a merge.

The two alternatives were considered and rejected on measurement, not taste:

- **A purpose-built C interpreter for the corpus.** The most appealing option on
  paper, and the corpus is narrow enough that it is not absurd. Berry is the
  control experiment: a complete, mature dynamic-language VM with a frozen
  stdlib, written by people optimising for exactly this, lands at 365,660 B —
  only 32% below MicroPython's 541,688 B, which already speaks Python and
  already has `re` and `json`. A couple of hundred KB, against writing *and then
  owning* a tokenizer, parser, bytecode VM, GC, regex engine and JSON parser,
  plus matching CPython closely enough that generated one-liners do not silently
  produce wrong answers. In a VM whose exec floor is 50–85 ms, that size
  difference is worth roughly 150 ms. It does not buy back the risk.
- **Stripping CPython.** Looks like the safe option and is not. 6.6 MB before
  stripping, dynamically linked against 3.1 MB of libraries, and a stdlib that
  lives as files on disk — which is the actual source of the 8573 ms. One cheap
  win is worth stealing regardless: **`-S` cuts CPython's startup file syscalls
  109 → 63**, so while `python3` remains in the image the agent prompt should
  prefer `python3 -S -c`.

### 3a. The daemon does not earn its keep, and the mechanism it needs is broken

The daemon was an explicit requirement — a resident runtime to cut startup — so
it was measured before being dropped rather than argued away. Three findings,
in order of force:

**There is nothing left to save.** A fork server's entire product is
"interpreter initialisation, amortised". Measured, pygram's interpreter init is
**0.96 ms against a 0.92 ms empty-C-program floor**. A zygote would amortise
0.04 ms. Meanwhile every one-liner still arrives as `execInSandbox` →
`/bin/sh -c`, whose **50–85 ms floor a daemon cannot touch** — a socket
round-trip from a thin client sits *inside* that envelope, not instead of it.
The daemon would be optimising roughly 0.05% of the cost.

**The mechanism is not functional in this guest.**
`docs/SANDBOX-PERFORMANCE.md` records a direct probe: `timeout 2 sleep 60`,
`timeout -s KILL 2 sleep 60`, and an explicit `kill -9` on a known PID **all
fail** — "signal delivery and process termination are not functional in the
CheerpX guest". A fork server's core loop is fork, wait, reap, forward signals.
Half of that does not work. It would also die with the VM on every
`resetSandbox`, needing constant re-establishment, and a resident background
process is the exact shape that wedged the single-threaded VM in `chat_logs
#522`.

**It is the right fix for the wrong binary.** A zygote is genuinely the correct
answer *for CPython*: 8573 ms cold against 87 ms warm is precisely the profile
it repairs. But it repairs it by keeping a 9.7 MiB working set resident in a VM
whose memory is the browser's, and it does nothing about the first boot.
Shipping a 541 KB static binary removes the problem instead of amortising it.

**So pygram ships daemonless, and `pygramd` is not built.** The design is
recorded in §4 because the decision should be reversible on evidence rather
than re-derived. Revisit it if — and only if — a measurement shows interpreter
init appearing in a real trace: a future workload running many one-liners
inside one `execInSandbox` batch, or a pygram whose initialisation grows
expensive (a large frozen corpus, a loaded index). Neither is true today.

## 4. The `pygramd` design, recorded but not built

Kept so that reversing §3a means reading a design rather than rediscovering
one. A zygote, the shape Android's zygote and preforked application servers
use: pay initialisation once in a parent, `fork()` per request so children
inherit the initialised heap copy-on-write.

The request frame would carry, and the forked child would have to faithfully
adopt, all of:

| field | why it must be passed |
|---|---|
| `argv` | the program and its arguments, `argv[0]` included |
| `cwd` | one-liners use relative paths constantly |
| `env` | inheriting the daemon's env silently changes `PATH`, `HOME`, locale |
| stdin/stdout/stderr | **passed as file descriptors over `SCM_RIGHTS`**, not proxied |
| umask | file-creating scripts |
| signal handlers and mask | inherited across `fork`, so they must be reset in the child |

Passing the three fds over the socket rather than relaying bytes through the
daemon is the load-bearing choice: it keeps pipes, redirections and
`sys.stdout.isatty()` behaving exactly as they do for a normal process, and it
avoids doubling the ~1.1 MB/s output path. The reply frame carries the wait
status so the thin client can exit with the right code — an agent loop branches
on exit codes, so getting these wrong is a correctness bug.

**Failure would always be soft.** Socket missing, refused, stale, or a protocol
version mismatch ⇒ the client runs the program in-process and says nothing. A
daemon that can break a command is worse than no daemon. Which means the client
must contain a full interpreter anyway — so the daemon could only ever save
initialisation, never size. Given that initialisation measures 0.96 ms, that
observation is most of §3a on its own.

## 5. Delivery path into the sandbox

`scripts/build-sandbox-image.sh` builds the Alpine i386 image and today lists:

```
PKGS_COMMON="bash coreutils grep sed gawk findutils file less python3 jq nodejs git"
```

That recipe is the delivery path. The end state is pygram installed as
`/usr/local/bin/pygram`, plus a decision about `python3` that
`docs/PYGRAM-RESEARCH.md` must answer explicitly:

- **Add alongside** — `python3` stays, pygram is opt-in. Safe, and costs nothing
  at rest (unrun binaries are never streamed), but the agent keeps typing
  `python3` and keeps paying 8.5 s, so it wins nothing without also teaching
  the agent loop to prefer pygram.
- **Replace** — pygram becomes `python3`. Wins immediately and everywhere, and
  breaks the moment a one-liner leaves the subset. Only defensible once the
  fallback contract in §6 is solid and the corpus is broad.

The staged answer: add alongside first, measure against the real corpus, and
only then consider shadowing `python3`. This image is also the tier that has no
server to fall back on (Se/cure), so the conservative order is the right one.

The same binary is relevant to `container/Dockerfile` (the server-side
execution environment) but wins far less there — that image is a normal
container on a normal filesystem, where CPython's cold cost is a page cache
miss rather than a network fetch. **pygram is a sandbox optimisation, not a
platform-wide python replacement.**

## 6. The fallback contract — what happens outside the subset

This is the part that decides whether a subset runtime is usable at all.

When pygram meets syntax or a name it does not implement, it must:

1. write a single greppable line to **stderr** naming the exact missing
   feature — module, attribute or construct — and nothing else;
2. exit with a **distinctive code** reserved for "unsupported", never 1, so a
   caller can tell "your program is wrong" from "pygram is too small";
3. never partially execute a program it cannot finish, where that is
   detectable ahead of time. Unsupported *syntax* is caught at parse time and
   costs nothing. Unsupported *attributes* are only discoverable at runtime, so
   partial execution is sometimes unavoidable — the error line has to make it
   obvious that this is what happened.

That contract is what lets the agent loop, or a shell wrapper, retry with real
`python3` automatically. `docs/PYGRAM-SUBSET.md` owns the exact exit code and
message format.

## 7. Growing the corpus

pygram is defined by what it is asked to run, so the corpus is the
specification and it must keep growing on its own.

`scripts/pygram-capture/` installs a `python`/`python3` shim early on `$PATH`
that appends every invocation — argv, the `-c` program text, cwd, exit code —
to a log, plus a `PreToolUse` hook that records python-bearing shell commands.
`harvest.mjs` merges those, and any Claude Code transcript it can find, into
`tests/pygram/corpus.jsonl`, deduplicated by normalised program text.

Two rules keep this honest:

- **Every entry is tagged with provenance** — observed from a real invocation,
  or written from expectation. They are not the same evidence and the frequency
  table must not blend them.
- **The corpus is committed, so harvest redacts.** Captured programs can embed
  repo content and secrets; harvest runs the `scripts/scan-secrets` patterns
  over every entry before it lands.

The corpus drives the build order: implement in descending order of how many
entries a feature unblocks, and re-run the conformance diff against CPython on
every change.

## 8. Work breakdown

| # | piece | artifact | state |
|---|---|---|---|
| 1 | implementation survey, ranked on cold cost | `docs/PYGRAM-RESEARCH.md` | **done** — MicroPython variant, musl, i386 |
| 2 | subset spec + seed corpus | `docs/PYGRAM-SUBSET.md`, `tests/pygram/seed-corpus.jsonl` | **done** — 139 entries, tiered |
| 3 | conformance runner + build gate | `tests/pygram/conformance.mjs`, `scripts/pygram-gate.mjs` | **done** — both proven against stubs |
| 4 | charter | this file | **done** |
| 5 | capture harness + corpus growth | `scripts/pygram-capture/` | in progress |
| 6 | the variant + build | `pygram/`, `scripts/pygram-build.sh` | in progress |
| 7 | the frozen shim stdlib | `pygram/lib/` | in progress |
| 8 | live cold/warm measurement in the real VM | `tests/e2e/sandbox-perf.spec.js` case | blocked on 6 |
| 9 | image delivery, staged | `scripts/build-sandbox-image.sh` | blocked on 8 |
| — | `pygramd` | — | **not being built** — §3a |

## 9. What would make this project wrong

Recorded up front so it can be checked rather than argued:

- **If the 8573 ms is not mostly file-touching.** The whole premise is that
  cold cost tracks bytes and opens. If a static pygram still takes seconds cold,
  the cost was somewhere else and the design was aimed at the wrong thing.
- **If the corpus is much wider than expected.** "Just enough Python" only works
  if the distribution has a short head. If the observed one-liners keep reaching
  for new modules, the subset grows until it is CPython with bugs, and the right
  answer becomes a smaller *CPython*, not a new interpreter.
- **If disagreement with CPython shows up in the conformance diff and cannot be
  fixed cheaply.** Silent semantic divergence is the failure mode that would
  make pygram a liability rather than an optimisation.

Each of these is measurable, and each has a gate above that would catch it.

### What pygram does not fix, stated plainly

Cold **VM boot** still dominates a sandbox turn. The agent trace in
`docs/SANDBOX-PERFORMANCE.md` shows 24.4 s of boot against 290 ms of commands,
so pygram improves a real but **secondary** term. It is worth doing because it
is cheap, because 8.5 s is a large secondary term that can cross the 30 s
ceiling and destroy the VM, and because removing CPython takes 27.0 MiB and 16
shared-library dependencies out of an image whose entire design goal is to be
small and to stream without stalling — which helps the boot too. It is not
worth doing on a claim that it makes the sandbox fast, and no user-facing copy
should say that.

The other honest gap is `subprocess`. It appears nowhere in this repository, so
excluding it is evidence-backed (`docs/PYGRAM-SUBSET.md` §5) — but a subset
runtime aliased as `python3` will meet it eventually, and the answer is exit 90
plus a stated non-goal in `bashAgentPrompt`, so the agent hoists the command
into its own bash block rather than being silently misled.
