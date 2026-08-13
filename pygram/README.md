# pygram

A Python-subset runtime for the in-browser CheerpX Linux sandbox: one stripped,
statically linked i386 ELF that opens **no files at all** on a trivial run.

`python3 --version` costs **8573 ms cold** in that sandbox against 87 ms warm,
because the root filesystem is an ext2 image streamed block by block over a
WebSocket — so the first run of a binary pulls its ELF, every library it links,
and every file it opens, over a network. The exec ceiling is 30 s and crossing
it discards the VM. pygram is what replaces `python3` there.

The charter is `docs/PYGRAM.md`, the subset spec is `docs/PYGRAM-SUBSET.md`, and
`docs/PYGRAM-RESEARCH.md` is the survey that picked MicroPython over pocketpy,
Berry, RustPython and a stripped CPython.

## Build

```bash
bash scripts/pygram-build.sh        # → pygram/build/pygram
make -C pygram verify               # build, then run both gates
```

About 40 s from nothing on this container, seconds on a rebuild. It needs the
network exactly once, for two pinned downloads. It needs no root beyond the
one-time toolchain install, no Docker, no VM and no cross toolchain:

```bash
sudo apt-get install -y gcc-multilib libc6-dev-i386
```

That is the whole host requirement, and it works because **i386 binaries
execute on an ordinary x86-64 Linux box** — so the real target artifact is
built *and run* in this container and in CI.

`make -C pygram distclean` drops the cache and forces the downloads again.

## Gates

```bash
node scripts/pygram-gate.mjs pygram/build/pygram --compare
PYGRAM_BIN=$PWD/pygram/build/pygram node tests/pygram/conformance.mjs
```

The first measures the three things that predict cold cost — statically linked,
stripped bytes, and distinct files opened on `-c 'pass'` — and prints the system
CPython alongside as the baseline being replaced. The second runs every corpus
entry twice, once under CPython and once under pygram, and diffs stdout and the
exit code.

`PYGRAM_BIN` must be an **absolute** path: the conformance runner gives each
entry a fresh temp directory as its cwd, so a relative path resolves to nothing.

Latest measured (390,456 B binary, 201 corpus entries):

| gate | budget | measured |
|---|---|---|
| statically linked | yes | yes |
| stripped size | ≤ 700,000 B | **390,456 B** |
| file opens on `-c 'pass'` | ≤ 3 | **0** |
| stat/access calls | — | **0** |
| conformance MISMATCH | 0 | **3** (see [Known gaps](#known-gaps)) |
| conformance MATCH / UNSUPPORTED | — | 185 / 13 |

CPython 3.11 on the same gate: 6,639,992 B, dynamically linked, 22 files opened,
7 failed probes, 65 stat/access calls. **17.0× smaller, and it touches nothing.**

## What is pinned, and why

| pin | value | why |
|---|---|---|
| musl | **1.2.5**, SHA-256 verified | The static floor. An empty `main()` is 13,020 B under musl-i386 and **635,744 B** under glibc-static — which would spend 91% of the size gate before an interpreter existed. `/usr/lib32/libm.a` also fails to resolve `fmod`, so glibc-static does not merely lose, it does not link. |
| MicroPython | **v1.28.0**, commit `e0e9fbb1…` | A release tag, not `master` and not the 1.29.0-preview the research measured. The build verifies the checked-out SHA, so a moved tag fails loudly instead of quietly building something else. |

Both are checked, not trusted: the tarball by checksum, the checkout by commit
SHA. A rebuild months from now produces the same binary or says why not.

## Layout

```
pygram/
  Makefile                     the obvious entry point; delegates to the script
  variant/
    mpconfigvariant.h          the entire C-level configuration
    mpconfigvariant.mk         make-level: what gets compiled and linked at all
    manifest.py                freezes pygram/lib/*.py by GLOB, naming nothing
    pygram_unsupported.h       the exit-90 contract + the CPython name tables
    pygram_slice.h             the step-slicing walk, so the patch stays call sites
    patches/
      0001-pygram-port.patch   ~400 lines across 15 upstream files
  lib/                         the frozen shim stdlib (owned separately)
  build/pygram                 the artifact (gitignored)
  .build/                      musl + the MicroPython checkout (gitignored)
```

`manifest.py` globs `pygram/lib/*.py` rather than listing modules, so a shim
that lands in that directory is frozen into the next build with nothing else
edited.

### The two mechanisms

**Static.** A dynamically linked interpreter pays `ld.so`'s search — a `stat`
per candidate directory per library — and then streams every `.so`. A fully
static binary links nothing, so there is no search and no streaming. This is
not a preference; it is the mechanism.

**Frozen, with `sys.path` pinned to `['.frozen']`.** Freezing the stdlib into
the binary is the other half, but freezing alone is not enough: MicroPython
searches `sys.path` *before* consulting its frozen table, at three `statx`
calls per path entry per module. The stock path is
`['', '.frozen', '~/.micropython/lib', '/usr/lib/micropython']`, so a
five-import workload costs 56 file syscalls. Trimming it to `.frozen` alone
takes that to 26. In the sandbox those probes are the same pathology that made
`command -v <absent tool>` cost 30 s and destroy the VM.

Both halves of the trim are needed and they live in different files: the
variant header sets `MICROPY_PY_SYS_PATH_DEFAULT`, and the port patch removes
the `""` (cwd) entry that `main()` prepends unconditionally. Removing `.frozen`
as well breaks frozen imports outright.

Verified with strace, not assumed — `-c 'pass'` issues exactly one file
syscall, the `execve` itself.

## The port patch

Kept as a patch against a pinned tag rather than a fork, so tracking upstream
stays a rebase. It touches fifteen files:

| file | what |
|---|---|
| `ports/unix/main.c` | `--version`/`-V` printing `pygram 0.1 (python subset)`; `-` (program on stdin); the `sys.path` pin; script mode inserting the script's directory instead of overwriting `.frozen`; `sys.executable` without `realpath()`'s per-component `readlink`; `do_repl()` removed |
| `shared/runtime/pyexec.c` | the uncaught traceback goes to **stderr**, not stdout |
| `py/builtinimport.c` | a failed import of a module CPython has → exit 90 |
| `py/runtime.c` | a missing attribute on a stdlib module or built-in type, an undefined name that is a CPython builtin, and `NotImplementedError` → exit 90 |
| `py/argcheck.c` | a keyword a C function does not accept → exit 90 |
| `extmod/modre.c` | a pattern the engine cannot compile → exit 90 |
| `py/objstr.c`, `py/objstrunicode.c`, `py/objtuple.c` | slicing with a step (`s[::-1]`, `t[::2]`); `str.zfill`/`ljust`/`rjust`; `repr()` of a non-ASCII character is the character |
| `lib/re1.5/charclass.c` | `\w` treats bytes ≥ 0x80 as word constituents |
| `extmod/vfs.c` | `open(errors=, newline=)` accepted and ignored |
| `py/objfloat.c` | CPython's shortest round-trip float repr |
| `py/modbuiltins.c` | `round(x, n)` rounding the binary value, as CPython does; `print(flush=)` accepted and ignored; `dir()` sorted |
| `py/parsenum.c` | CPython's exact `int()` error message |
| `py/objexcept.c` | `str(KeyError)` is `repr(key)`, as in CPython |

Four are worth naming, because they were silent-divergence bugs rather than
missing features — a program that ran, printed something plausible and exited 0.

**The traceback was going to stdout.** Every corpus entry is a pipeline stage,
and a traceback on stdout means a failing `pygram … | wc -l` *counts the
traceback* and `pygram … > f` writes the error into the file. The exit code was
right, so a careful caller survived and a pipeline quietly ingested garbage.
Fixing it took conformance MISMATCH from 62 to 21 in one change.

**`round()` and float repr.** `round(2.675, 2)` answered 2.68 where CPython
answers 2.67, because upstream computes `nearbyint(val * 10**n) / 10**n` and
`2.675 * 100` is `267.50000000000006` in binary. And `9.7` printed as
`9.699999999999999` — right to sixteen digits and wrong as an answer.
`docs/PYGRAM-SUBSET.md` §6 makes both contractual, precisely because a program
that runs, prints something plausible and exits 0 is the failure mode the
project exists to prevent.

**Swedish was broken in two places, silently.** CLAUDE.md invariant 6 asks for
equal Swedish and English support in every deterministic gate, and neither of
these announced itself:

```
re.findall(r"\w+", "räksmörgås")   →  ['r', 'ksm', 'rg', 's']      (was)
print(["Ärlig", "Öl"])             →  ['\xc4rlig', '\xd6l']         (was)
```

re1.5 matches **bytes**, so an ASCII-only `\w` did not drop non-English words,
it cut them into fragments at every non-ASCII byte — a plausible-looking wrong
answer with a zero exit code. And `repr()` escaped everything above U+007E, so
every Swedish string inside a list or dict printed as `\xNN`, which is exactly
what `print(re.findall(...))` produces. Both are fixed, both are checked in the
build's smoke tests, and four `sv-*` parity entries are in the corpus.

The one divergence that remains from the `\w` fix: a non-ASCII *punctuation*
character is now absorbed into a word rather than treated as a separator, since
the byte-level engine cannot tell a letter from a dash. That is a much smaller
and far less silent error than cutting a word in half.

### Upgrading MicroPython

Change `MPY_TAG`/`MPY_COMMIT` in `scripts/pygram-build.sh` and re-run. If the
patch no longer applies the build stops and says so. Rebase the patch against
the new tag — do not hand-edit `pygram/.build/micropython`, which is reset to
the pinned commit on every run. Then re-run both gates: the size gate catches
an upstream feature-level change, and conformance catches a semantic one.

## The unsupported contract

Outside the subset, pygram exits **90** with exactly one line on stderr and
nothing on stdout:

```
$ pygram -c 'import subprocess'; echo $?
pygram: unsupported: module: subprocess
90
```

90 is clear of 0/1/2, of 126/127 and of 128+n, so a caller can branch on it and
retry the same line with real `python3`. The kinds implemented are `module`,
`attribute`, `builtin`, `argument` and `syntax`.

The distinction that makes it useful is `docs/PYGRAM-SUBSET.md` §7 rule 4:

```
$ pygram -c 'import PIL'; echo $?          # CPython lacks it here too
ImportError: no module named 'PIL'          (on stderr)
1
```

A module CPython also lacks is a program that **ran correctly** and found its
dependency missing — exit 1, same as CPython. Exit 90 is reserved for pygram
being too small. Collapsing the two would make the retry undecidable.
`pygram/variant/pygram_unsupported.h` carries CPython 3.11's 217 stdlib module
names and 149 builtin names, packed as `\0`-separated blobs, to tell them
apart.

## Known gaps

Five conformance entries still MISMATCH. Three of them cannot be fixed by any
subset runtime, and two are real.

**Real, and not fixed here.**

*Dictionaries are not insertion-ordered* (`dict-items-loop`,
`collections-defaultdict`). CPython's `dict` has preserved insertion order
since 3.7, where it is a language guarantee; MicroPython's is an
open-addressing hash map that does not. It changes the output of `print(d)`,
`d.items()`, `json.dumps(d)` and every Counter/defaultdict display — plausible,
different, exit 0.

The ordered machinery IS already compiled in (`mp_map_t.is_ordered`, used by
`collections.OrderedDict`), and pointing the builtin `dict` at it is **one
line** in `mp_obj_new_dict()`. It was built and measured. It produces exactly
CPython's order, and it costs **zero bytes** — the two binaries are byte-for-byte
the same size. The cost is asymptotic, because MicroPython's ordered map is a
linear array with a linear scan:

| distinct keys | hashed (shipped) | ordered | ratio |
|---|---|---|---|
| 1,000 | 10 ms | 19 ms | 2.0× |
| 2,000 | 37 ms | 68 ms | 1.8× |
| 5,000 | 105 ms | 384 ms | 3.7× |
| 10,000 | 216 ms | 1,562 ms | **7.2×** |

The ratio itself grows, which is the quadratic showing. Those are native
x86-64 host numbers; the same work in the CheerpX guest is far slower, against
an exec ceiling that **destroys the VM** when crossed (`docs/PYGRAM.md` §1). A
word count over a moderately large file is an ordinary one-liner, and this
trade converts one into a lost turn.

So it is not a build option and it is not a byte budget question — it is a data
structure. The right fix is CPython's compact-dict layout (an ordered array
with a hash index), which is a VM change of a different order from a shallow
variant. Documented here as the largest remaining divergence rather than
absorbed.

*`zlib.compress` output length* (`zlib-crc32`). The entry prints
`len(zlib.compress(data))`, and MicroPython's deflate emits 11 bytes where
zlib emits 12 for that input. Both decompress to the identical data and the
CRC32 matches — two conforming DEFLATE encoders simply do not have to agree on
size. The corpus entry is asserting on something the format does not promise.

**Other limits worth knowing.**

- **`hashlib.md5` and `hashlib.sha1` are not a build flag**, which is worth
  recording so nobody spends the afternoon again. They default to
  `MICROPY_PY_SSL`, but turning them on by name does not compile: unlike
  `sha256`, which has a vendored implementation in `lib/crypto-algorithms`,
  both exist only as bindings to mbedtls or axtls. Having them means an SSL
  submodule — a second network dependency and a large crypto stack behind a
  390 KB binary. If they are needed, pure Python in `pygram/lib` is the cheaper
  route.
- **`FileNotFoundError` and `os.fstat` are real work, not flags.** MicroPython
  has only `OSError` (with `.errno`), and the `OSError` subclass hierarchy §6
  asks for would be a new set of exception types plus errno mapping. Both
  currently exit 90 with the contract line, which is the honest answer.
- **A typo is reported as unsupported.** `"x".casefld()` exits 90 like
  `"x".casefold()` does, where CPython gives `AttributeError` and exit 1.
  pygram cannot tell a method CPython has from a misspelling without carrying
  CPython's full attribute table — tens of KB against a 700 KB budget, to
  improve the diagnosis of a typo. The cost of being wrong is bounded: the
  caller retries with real `python3` and gets the accurate error.
- **A stdlib import cannot be caught.** `try: import csv / except ImportError`
  exits 90 rather than taking the branch — correctly, since under CPython the
  import succeeds and the branch is not taken either.
- `subprocess`, `os.system`, threading, sockets and the REPL are **out of
  scope**, not missing (`docs/PYGRAM-SUBSET.md` §5). `os.system` is compiled
  out rather than left working, because a fake that works keeps the expensive
  pattern alive.
- The interpreter heap is 1 MB on i386. A dict with ~20,000 keys raises
  `MemoryError`. That is upstream's default (`-X heapsize=` raises it) and no
  corpus entry comes near it.

## Still to do

The acceptance metric in `docs/PYGRAM.md` §2 is **not** any number on this
page. It is a cold `pygram -c '<one-liner>'` under 500 ms in a real VM,
measured by `tests/e2e/sandbox-perf.spec.js` against a real Alpine i386 image.
The gate's `~499 ms` estimate is a projection from binary shape and is labelled
as one everywhere it prints. Confirm it before quoting it, then edit
`PKGS_COMMON` in `scripts/build-sandbox-image.sh`.
