# mopy — Mixture of Pythons

**Status: experimental, measured, not wired into the sandbox yet.**

mopy is a Python subset written from scratch in Rust, sized to the *bottom* of
the distribution of one-liners an agentic CLI actually types — plus a classifier
that decides, per program, which of three interpreters should run it.

The three interpreters are the mixture:

| tier | what it is | where it lives |
|---|---|---|
| **mopy** | this — a Rust subset, ~1,300 lines of interpreter | `mopy/` |
| **pygram** | a MicroPython variant with a frozen shim stdlib | `pygram/`, [`docs/PYGRAM.md`](PYGRAM.md) |
| **CPython** | the real thing | the system `python3` |

pygram exists because CPython costs **8,573 ms cold** in the CheerpX sandbox
(`docs/SANDBOX-PERFORMANCE.md` §1) and the exec ceiling is 30 s. mopy exists
because pygram is still an interpreter written for microcontrollers, and the
programs an agent types are a much narrower target than "Python".

## 1. The measurement, first

Everything below is downstream of one table. 472 harvested programs
(`tests/pygram/corpus.jsonl` + `tests/pygram/seed-corpus.jsonl`), min of 5,
arms interleaved per entry, on this container (2026-08-16).

**Do not carry a remembered corpus size.** The capture harness grows it every
session — this project's first table was over 420 programs and the number was
stale within the day. Every tool prints the count it loaded; quote that.

```
startup — `-c 'pass'`

arm         min ms    vs cpython
cpython      11.04     1.000x
pygram        1.20     0.109x
mopy          1.03     0.093x
mixture       1.05     0.095x

corpus — 472 programs

arm         ran  refused   shared total (323)   vs cpython
cpython     472        0          4314.4 ms      1.000x
pygram      444       28           616.5 ms      0.143x
mopy        324      148           440.3 ms      0.102x
mixture     472        0           547.0 ms      0.127x

whole corpus — what a session of 472 one-liners costs

cpython     6987.9 ms   1.000x
pygram      1153.1 ms   0.165x   (28 unanswered)
mopy         673.3 ms   0.096x   (148 unanswered)
mixture     1860.8 ms   0.266x   (0 unanswered)
```

Read it in this order:

- **mopy is the fastest engine on the work it accepts** — 0.102x against
  CPython on the shared subset, and faster than pygram there (0.143x). That is
  the whole thesis: a runtime built for 69% of the distribution beats a general
  one on that 69%.
- **The mixture answers everything CPython answers** — 472/472, zero
  mismatches — at **0.266x of CPython's cost**, a 73.4% saving. The other two
  arms are cheaper only because they refuse work.
- **The subset was not tuned to this corpus.** It was built against 420
  programs; 52 more arrived when main folded in the day's sightings, and
  coverage went UP (67.1% → 68.6%) with mismatches still at zero. That is a
  small but real generalisation signal rather than a fit to the sample.
- **Startup is at parity with pygram, not better.** mopy's binary is 1,020,600 B
  against pygram's 269,316 B; both are static musl and both open zero files, so
  they arrive at the same place by different routes.

Reproduce: `bash scripts/mopy-build.sh && node scripts/mopy-bench.mjs`.

> **Running the corpus can rewrite this repository.** It is harvested from real
> agent sessions, so it is full of programs that edit `src/` and `docs/`. Every
> entry runs in its own temp directory, which contains the relative paths, but
> 17 entries carry an absolute one. Both tools bracket the run with a
> `git status` check that reports and restores anything they changed, and fail
> if they changed anything — this is a net, not a sandbox. It exists because the
> first measurement runs here rewrote 34 tracked files.

It is
deliberately **not in CI** — a wall-clock benchmark on a shared runner measures
the runner. CI keeps the deterministic half (conformance, routing safety).

## 2. Conformance: the number that must be zero

```
node tests/mopy/conformance.mjs
```

Every corpus program runs under CPython (the reference) and under each engine,
and each engine's result is one of three things:

| verdict | meaning | is it a failure? |
|---|---|---|
| MATCH | stdout + exit code identical to CPython | no |
| UNSUPPORTED | exit **90** with `mopy: unsupported: <kind>: <detail>` | **no** — this is coverage, and the build order |
| MISMATCH | anything else | **yes, always** |

Current (2026-08-16, 472 programs):

```
engine     MATCH  UNSUPPORTED  MISMATCH   coverage
mopy         324          148         0     68.6%
pygram       443           28         1     93.9%
mixture      472            0         0    100.0%
```

The one pygram MISMATCH is pre-existing and belongs to pygram: `json.load` on a
4 MB file exhausts its heap. The dispatcher recovers from it (§5).

**A subset runtime that silently disagrees with CPython is worse than no runtime
at all**, because the agent that typed the one-liner will not notice. That is
why MISMATCH is the gate and UNSUPPORTED is not.

## 3. What mopy implements, and why exactly that

The subset is chosen from the corpus, not from the language reference. Measured
prevalence over the 558 harvested and seeded programs:

```
print(     93.5%      json.     16.5%      listcomp   5.9%
open(      42.7%      slice     12.4%      fstring    5.0%
for        38.4%      genexp    11.1%      try        4.8%
if         24.2%      sys.stdin 10.4%      os.        4.7%
assert     19.9%      re.       10.2%      def        3.2%
```

So: expressions, statements, comprehensions (list/dict/set/generator),
f-strings, `%` formatting, `.format()`, functions with closures, `try`/`except`,
`with`, slicing, unpacking — and the modules `sys`, `os`, `os.path`, `io`,
`json`.

`re` is the largest single gap (66 programs, 14.0%) and is **deliberately not
implemented**: pygram already has a regex engine, so `import re` is a routing
decision rather than a hole. `subprocess` appears nowhere in `src/` and goes
straight to CPython.

### The three refusals that keep it honest

A subset can be wrong in two ways, and only one of them is acceptable. These are
the places where mopy refuses rather than approximates:

1. **Integers are i64; Python's are arbitrary precision.** Every arithmetic
   operation is checked and an overflow is `unsupported: bigint`, never a wrap.
2. **Set iteration order is CPython's hashing, and cannot be reproduced.** So
   order-*independent* operations on sets work (`len`, `in`, the set algebra,
   `sorted`, `min`, `max`, `any`, `all`) and anything that would expose an order
   (`repr`, iteration, `list()`, `.join`) exits 90. Dicts, whose order Python
   *defines* as insertion order, have no such restriction.
3. **`repr` of a non-ASCII character** needs CPython's Unicode category tables
   to decide whether to escape it. mopy carries a whitelist of blocks that are
   unambiguously printable and refuses the rest.

Everything CPython specifies exactly is implemented exactly, including the ones
that look like they should fall out of the host language and do not: floor
division and `%` round toward negative infinity (Rust truncates), `/` on two
ints is always a float, `float` repr is shortest-roundtrip with the
fixed/scientific switch at `decpt <= -4 || decpt > 16`, and a function's
`UnboundLocalError` comes from a real analysis of the names its body assigns.

## 4. The classifier

```
mopy route -c 'import re; print(re.findall(r"\d+", s))'
    pygram   module: import re
```

Routing is a **static analysis over mopy's own front end**, not a heuristic over
the program text. That is the design:

- mopy's parser already reports the exact construct that would stop it. Asking
  the parser is therefore an *exact* answer to "can mopy run this", costing one
  parse and no process spawn.
- The tiers below cannot be asked the same way — they are separate binaries — so
  those are capability **tables** in `mopy/src/route.rs`, kept honest by the
  routing arm of the conformance runner.

The routing score is asymmetric on purpose:

```
routing over 472 programs

  IDEAL       439  routed to the cheapest engine that works
  WASTED       15  engine refused; one extra spawn, right answer
  LATE         17  worked, but a cheaper engine would have too
  UNSAFE        1  routed to an engine that MISMATCHES
  NO-ENGINE     0

  accuracy 93.0% ideal, 96.6% correct-on-first-try
  predictions: mopy=319  pygram=122  cpython=31
```

A wrong route costs a process spawn. A wrong *answer* costs the user's trust, so
UNSAFE is tracked separately and the dispatcher is built to recover from it.

## 5. The dispatcher, and why it is the binary itself

```
mopy run -c 'print(1 + 1)'
```

Two properties make the mixture cheap enough to be worth having:

- **The winning case costs nothing.** A program routed to mopy runs *in this
  process* — no second spawn, no pipe. Since 96% of a one-liner's cost is the OS
  spawning a process (`docs/PYGRAM.md` §8c), a dispatcher that spawned a child
  would give back most of what the fast engine won.
- **Falling onward costs one `exec`, not one fork** for the terminal tier. An
  *intermediate* tier is forked instead, because its own refusal has to be
  caught — pygram's capability table knows pygram *has* `hashlib` and `re`, not
  that this build lacks `hashlib.md5` and `re.VERBOSE`. Measurement found 14
  corpus programs where that difference bites.

The chain moves past an intermediate engine on three signals: exit 90; a
`MemoryError` (a property of that engine's heap, never the program's answer);
and a traceback with exit 0 (which no conforming Python produces). An ordinary
non-zero exit with a traceback is deliberately *not* one of them — that is very
often the program's own correct answer, and re-running it would execute its side
effects twice.

## 6. The commit barrier — what makes falling onward safe

Routing to mopy is only sound if a mopy run that ends in `unsupported` left
**nothing** behind. Otherwise the retry re-executes the side effects and the
file is written twice, or half. So a mopy run is transactional
(`mopy/src/io.rs`):

- stdout and stderr accumulate in memory and are written once, at a successful
  exit;
- file writes accumulate per path, and deletes and renames are staged;
- exit 90 discards all of it, so the program is observably a no-op.

The barrier is invisible to the program and visible only to the dispatcher: a
read consults the staged writes first, so `open(p,'w').write(x)` followed by
`open(p).read()` behaves exactly as in CPython. `os.path.exists`, `getsize`,
`isfile`, `remove` and `rename` all see the overlay too.

Two escape hatches, both handled rather than assumed away:

- **Size.** Past 8 MiB of buffered output the run commits early and *loses* its
  ability to fall back; a later refusal is then reported as a hard error rather
  than a routing signal. Nothing in the corpus comes close.
- **stdin.** A consumed pipe cannot be rewound. If mopy already read stdin
  before refusing, the dispatcher forks instead of exec'ing and replays the
  captured bytes.

## 7. Building

```bash
bash scripts/mopy-build.sh                # host musl (x86_64) — what the bench uses
bash scripts/mopy-build.sh --target i686  # the CheerpX sandbox target
bash scripts/mopy-build.sh --glibc        # the dynamic-linking control
```

**Static musl is a precondition, not a preference.** Measured, `-c 'pass'`, min
of 30:

| build | startup | file opens |
|---|---|---|
| glibc, dynamically linked | 1.33 ms | 5 |
| musl, static | **0.24 ms** | **0** |
| pygram (musl, static) | 0.21 ms | 0 |

Cold cost in the sandbox tracks bytes and file opens and nothing else, so the
dynamic loader's five opens are the entire gap. A dynamically linked mopy is
5.5x slower to start and gives back most of what the runtime won.

Zero runtime dependencies — `std` only. That follows CLAUDE.md invariant 5 and
adds a second reason: every crate linked in is bytes in a binary whose cold cost
is a step function in CheerpX's 131,072 B device blocks.

## 8. Size: where it stands

| binary | bytes | CheerpX blocks |
|---|---|---|
| pygram | 269,316 | 3 |
| mopy (x86_64 musl) | 1,020,600 | 8 |
| mopy (i686 musl) | 973,428 | 8 |
| CPython 3.11 | 6,639,992 | 51 |

`opt-level = "z"` was measured at 963,256 B — 57,344 B smaller, and **still 8
blocks**, so it buys nothing under the cost model that matters. Getting to 7
blocks needs 103,096 B, which no single flag provides; the levers not yet tried
are `build-std` with `panic_immediate_abort` (nightly) and cutting the `std`
formatting machinery. This is the clearest open work item.

## 9. What is deliberately not here

- **No `re`.** 14.0% of the corpus and the single biggest routing bucket, but a
  regex engine is a large amount of code with deep semantics, and pygram already
  has one. If mopy ever gets one it should be a small backtracking engine that
  exits 90 on any syntax outside a measured subset — the mixture pattern applied
  one level down.
- **No `subprocess`, threading, or networking.** They appear in the corpus only
  as CPython-routed programs.
- **No classes, decorators, generators, or `async`.** Under 4% combined, and
  each is a routing decision today.
- **No daemon.** The same reasoning that ruled one out for pygram
  (`docs/PYGRAM.md` §4) applies unchanged: interpreter init is a rounding error
  inside the process-spawn floor.

## 10. Files

| path | what |
|---|---|
| `mopy/Cargo.toml` | zero-dependency crate, size-tuned release profile |
| `mopy/src/lex.rs` | tokenizer, layout (INDENT/DEDENT), string prefixes and escapes |
| `mopy/src/parse.rs` | recursive-descent parser; every gap becomes `unsupported: <kind>` |
| `mopy/src/ast.rs` | the subset AST |
| `mopy/src/eval.rs` | tree-walking evaluator, real scope chains, `UnboundLocalError` analysis |
| `mopy/src/value.rs` | values, insertion-ordered dict, set, the bigint and set-order refusals |
| `mopy/src/ops.rs` | operators, indexing, slicing, `%`-formatting, Python's floor/mod rules |
| `mopy/src/iter.rs` | iteration; lazy `range`, file lines and generator expressions |
| `mopy/src/fmt.rs` | `str`/`repr`, float repr, the format-spec mini-language |
| `mopy/src/builtins.rs` | the builtin functions, chosen by corpus frequency |
| `mopy/src/methods.rs` | str/list/dict/set/bytes/file methods; the tables the router reads |
| `mopy/src/modules.rs` | `sys`, `os`, `os.path`, `io`, `json` |
| `mopy/src/json.rs` | JSON parse + dump, written against CPython's exact output |
| `mopy/src/io.rs` | files, streams, and the commit barrier |
| `mopy/src/route.rs` | the classifier |
| `mopy/src/main.rs` | CLI, the exit contract, and the dispatcher |
| `scripts/mopy-build.sh` | the build, with the shape and contract smoke checks |
| `scripts/mopy-bench.mjs` | the four-arm benchmark |
| `tests/mopy/conformance.mjs` | three engines + the mixture + routing accuracy |
| `tests/mopy/routing.test.mjs` | unit tests, in `npm test` |
