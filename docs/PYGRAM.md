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
| stripped static binary size | < 400 KB | `node scripts/pygram-gate.mjs` |
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
in it at all**, already over the 400 KB gate. The same empty program against
musl on x86-64 is 18,688 B. So a musl-based static build is not a preference,
it is a precondition — `docs/PYGRAM-RESEARCH.md` owns finding a workable
i386+musl toolchain.

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

## 3. Where the cost actually goes, and what that means for the daemon

The owner asked for a daemon to cut startup. The honest analysis, which
`docs/PYGRAM-RESEARCH.md` is measuring properly:

A cold run pays **image streaming + interpreter init**. A warm run pays
**exec floor + process spawn + interpreter init**. A daemon removes interpreter
init and (after the first call) the page-in of the interpreter's own text — it
cannot remove the 50–85 ms exec floor, because the client still arrives as a
`/bin/sh -c` from JS.

So the daemon's value depends entirely on how large interpreter init is once
the binary is small and static. If a static pygram initialises in single-digit
milliseconds, the daemon saves single-digit milliseconds against an 85 ms floor
and is **not worth its risk** for startup alone. The research pass reports the
real number before we build it.

The daemon does have two independent justifications that survive regardless:

1. **Warm state across a pipeline.** An agent turn is often several python
   steps over the same data. A resident process can hold parsed data between
   calls instead of re-reading and re-parsing it — that is a *capability* win,
   not a startup win.
2. **Paying the page-in once** for whatever part of pygram is genuinely large.

### 3a. The risk the daemon carries here, which is specific and real

The VM is **single-threaded**. `public/js/sandbox.js` already documents a case
where a background process racing the foreground wedged the VM
(`chat_logs #522`: an over-budget file seed "keeps extracting in the background
— CheerpX can't kill it", and running a command during it wedged). `execInSandbox`
now has explicit wait-and-wedge-detect machinery to survive that.

A resident `pygramd` is exactly the shape that caused that incident. It should
be safe — a daemon blocked in `accept()` consumes no CPU — but "should be" is
not what this codebase accepts for the sandbox. **Two things must be verified
live before a daemon ships:**

- that a detached process started by one `cx.run` is still alive and schedulable
  during a later `cx.run` (plausible from the seed behaviour, unverified);
- that an idle `pygramd` measurably does not slow the foreground.

Until both are verified, pygram ships **daemonless**, and the daemon is a
separate follow-up change behind its own flag. The daemonless path must be good
enough on its own; the daemon is an optimisation, not the design.

## 4. The daemon protocol (`pygramd`), when we get there

A zygote/fork-server, the same shape Android's zygote and preforked CGI use.

```
pygram -c 'print(1)'        # the client: tiny, static, no interpreter in it
   └─ connect /run/pygram.sock
      └─ send request frame
         └─ pygramd forks a child that is already initialised
            └─ child dup2s the passed fds, chdir, runs, exits
               └─ daemon reports the exit status back
```

The request frame carries, and the forked child must faithfully adopt, all of:

| field | why it must be passed |
|---|---|
| `argv` | the program and its arguments |
| `cwd` | one-liners use relative paths constantly |
| `env` | `PATH`, `HOME`, and anything the script reads |
| stdin/stdout/stderr | **passed as file descriptors over `SCM_RIGHTS`**, not proxied |
| umask | file-creating scripts |

Passing the three fds over the unix socket rather than relaying bytes through
the daemon is the load-bearing choice: it keeps pipes, redirections and tty
detection (`sys.stdout.isatty()`) behaving exactly as they do for a normal
process, and it means the ~1.1 MB/s output path is not doubled.

The reply frame carries the wait status, so the client can `exit()` with the
right code — an agent loop branches on exit codes, so getting these wrong is a
correctness bug, not a cosmetic one.

**Failure is always soft.** If the socket is missing, refused, stale, or the
protocol version does not match, the client runs the program **in-process** and
says nothing. A daemon that can break a command is worse than no daemon. The
client therefore has to contain a full interpreter anyway — which means the
daemon saves initialisation, not code size.

Signals, `SIGPIPE` in a shell pipeline, and orphan reaping are the parts of this
design most likely to be got wrong; they get their own tests.

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
| 1 | implementation survey, ranked on cold-block cost | `docs/PYGRAM-RESEARCH.md` | in progress |
| 2 | capture harness + corpus growth | `scripts/pygram-capture/`, `tests/pygram/corpus.jsonl` | in progress |
| 3 | subset spec + seed corpus | `docs/PYGRAM-SUBSET.md`, `tests/pygram/seed-corpus.jsonl` | in progress |
| 4 | charter + daemon design | this file | drafted |
| 5 | interpreter core + conformance runner | `pygram/` | blocked on 1 and 3 |
| 6 | live cold/warm measurement in the real VM | `tests/e2e/sandbox-perf.spec.js` case | blocked on 5 |
| 7 | image delivery, staged | `scripts/build-sandbox-image.sh` | blocked on 6 |
| 8 | `pygramd`, behind a flag, after live verification of §3a | `pygram/daemon/` | blocked on 6 |

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
