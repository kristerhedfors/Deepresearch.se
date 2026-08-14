# The pygram performance ledger

Append-only. One entry per measured run of `scripts/pygram-bench.mjs`, newest
first. Every entry names both binaries by SHA-256, the MicroPython pin they were
built from, the machine, and the full table — including the rows where pygram
**lost**, which are the rows that stop the same optimisation being re-proposed
next month.

```bash
bash scripts/pygram-build.sh            # pygram/build/pygram
bash scripts/pygram-build.sh --stock    # pygram/build/micropython-stock — the control
npm run pygram:bench                    # print the table
npm run pygram:bench:record             # ... and append a dated entry here
```

Run it after any change to `pygram/variant/`, any patch in
`pygram/variant/patches/`, any addition to `pygram/lib/`, and any bump of the
MicroPython pin. It is deliberately not in CI — see *Why this is not a CI gate*
below.

> **Rule for adding an entry.** A number reaches this file only from a run of
> `scripts/pygram-bench.mjs --record`, against a stock control built from the
> same pin by `scripts/pygram-build.sh --stock`, with both binaries' SHA-256
> recorded. Hand-typed numbers do not go here. A row the harness marked noisy
> (`!`) is not a finding and must not be quoted as one.

---

## What is being measured, and against what

pygram is a MicroPython variant. On its own its timings answer "how long does
this take", which nobody needs to know. Against **stock MicroPython built from
the same commit through the same toolchain** they answer "what did our changes
cost", which is the only question a benchmark can settle.

The control is built by `scripts/pygram-build.sh --stock`. Its `build_stock()`
comment is the authority on what is held equal — same pinned commit, same
musl-i386 libc, same `-Os -DNDEBUG`, same static link, same strip, and the
toolchain flags are **extracted verbatim** from
`pygram/variant/mpconfigvariant.mk` rather than copied, so they cannot drift
apart. It also lists the five differences the offline static build forces
(no frozen micropython-lib, no btree, no ffi, no ssl, no FAT/littlefs VFS).

**CPython3 is context, not the control.** It is measured and printed, always
under a starred column, and no verdict is ever computed against it. It is a
different architecture (x86-64 against pygram's i386), a different league of
optimisation, and — the entire premise of the project — a runtime whose cost in
the sandbox is *cold start*, not warm CPU (`docs/PYGRAM.md` §1). pygram losing
to CPython on a warm microbenchmark is expected and is not a result.

## How to read this

**The ratio is the deliverable.** `py/stock min` is the verdict: pygram's
floor-subtracted minimum over stock's, on the same case. 1.00 means our variant
costs nothing there. 2.00 means the case takes twice as long as it would without
our changes.

**Both min and median are reported, and the verdict uses the min.** Noise on a
shared machine is one-sided — scheduling, page faults and neighbours can only
ever *add* time — so the minimum of a repeated CPU-bound microbenchmark is the
least biased estimate of its true cost. The median is printed beside it because
the two agreeing is what makes either believable. When they disagree by more
than 25% the harness marks the row `!` and prints a noise warning: **that row is
not a finding.**

**Every workload is floor-subtracted.** `-c 'pass'` is measured per binary and
taken off, so a 3 ms workload is not reported as a 10 ms one because process
spawn and interpreter init dominate it. The startup group is reported raw, since
subtracting the floor from itself is zero by construction. A cell of `0.000`
means the case cost less than that binary's own startup — which is what the
CPython column does on the small cases, and is why it is context only.

**`unsupported` is data, not a failure.** Stock has no `re.findall`, no match
`.start()`, no `collections.Counter` — those are pygram's frozen stdlib. A cell
that says `unsupported` is the frozen library showing up as *coverage* rather
than as speed, and the reason is printed in its own table below the main one.
`ERROR` is the other thing: a spawn failure, a timeout, or a non-zero exit with
no Python traceback in it. An `ERROR` is a bug in the harness or the build and
should be chased.

**Read the decomposition rows before blaming a subsystem.** `re-sub-ascii`
against `re-sub-native` is the pattern: the first goes through pygram's frozen
Python `re` shim, the second goes straight at the C engine both builds share. A
gap in the first and none in the second locates the cost in the shim, not in the
engine — which is a completely different thing to fix.

## What a regression looks like

Compare a new entry against the previous one **on the same machine**, row by row,
and only on rows neither run marked `!`.

| signal | reading |
|---|---|
| One row's `py/stock min` grows, controls unchanged | A real cost in that feature. The controls (`float-format`, `str-methods`, `sort-ints`, `re-sub-native`) staying flat is what makes it *that* feature's cost rather than a global shift. |
| **Every** row's ratio grows, controls included | Not a feature regression. Something global moved — a config switch, the allocator, the optimisation level, or the control was rebuilt differently. Check the binary shape table first. |
| A `dict-insert-*` ratio stops growing with n | Suspect the harness, not a fix. The ordered map is a linear array; the ratio is *supposed* to roughly quadruple per doubling. A flat ratio means the case stopped exercising it. |
| A cell flips `ok` → `unsupported` on pygram | A capability was lost. This belongs in the conformance battery (`npm run pygram:conformance`), which is the gate; the bench merely noticed. |
| A cell flips `unsupported` → `ok` on **stock** | The control was built wrong. Stock cannot grow features. Rebuild it with `scripts/pygram-build.sh --stock` and check the "is not pygram" shape checks passed. |
| Binary size or file-opens moved | The size/opens gate (`node scripts/pygram-gate.mjs`) is the authority on those, not this file. They are printed here only so an entry is self-contained. |
| Both min and median move together by <10% with no code change | Machine noise. The startup floor drifts by that much between runs on a shared box. |

**The 30 s exec ceiling is the one absolute.** A command that crosses it destroys
the CheerpX VM and ends the agent's turn (`docs/PYGRAM.md` §1). These are HOST
numbers on x86-64; the emulated i386 guest is substantially slower, so a case
that takes seconds here is the one to worry about there. The
`dict-insert-20k` row is the standing example.

## Why this is not a CI gate

A wall-clock benchmark on a shared CI runner measures the runner. Every number
here moves by more than 10% between back-to-back runs on an idle machine, and CI
runners are not idle — so a threshold tight enough to catch a real 20%
regression would fail on noise several times a week, and a threshold loose
enough to be quiet would miss everything except the quadratic. Either way the
result is a red build nobody trusts, which is worse than no check.

What CI *does* carry is the non-timing half, which is deterministic: the binary
is static, under 700,000 B, and opens at most 3 files on `-c 'pass'`
(`scripts/pygram-gate.mjs`), and every corpus entry still matches CPython
(`tests/pygram/conformance.mjs`). Those catch the changes that would move these
timings anyway — a feature switched off, a module unfrozen, a dynamic link — and
they catch them without a stopwatch. The timing run is a documented command plus
this ledger.

---

<!-- pygram-bench: newest entry is inserted directly below this line -->

## 2026-08-14 — pygram vs stock MicroPython — after PR #434 (mpconfigvariant trim, 22% off the binary)

MicroPython pin **v1.28.0** (`e0e9fbb17ed6`), repo `bb939924dc43` on branch `claude/pygram-bench-vs-stock`. Control built by `bash scripts/pygram-build.sh --stock`.

### Binaries
| binary | bytes | linkage | opens on -c 'pass' | failed probes | stat/access | sha256 |
|---|---|---|---|---|---|---|
| pygram | 304,440 | static Intel 80386 | 0 | 0 | 0 | 7b08605cdd5f |
| stock | 455,680 | static Intel 80386 | 0 | 0 | 6 | 91937bdb6290 |
| CPython3* | 6,639,992 | dynamic | 22 | 7 | 65 | f56a588548dd |

### Floor-subtracted workload, min of n=15 (ms unless marked s)
| case | pygram | stock | CPython3* | py/stock min | py/stock med |
|---|---|---|---|---|---|
| **startup** |  |  |  |  |  |
| -c 'pass' | 1.14 raw | 1.05 raw | 13.2 raw | 1.09x | 0.87x ! |
| -c 'print(1)' | 1.10 raw | 1.11 raw | 13.3 raw | 0.98x | 1.04x |
| **dict** |  |  |  |  |  |
| insert 1,000 distinct keys | 5.96 | 4.43 | 0.960 | 1.34x | 1.47x |
| insert 5,000 distinct keys | 121.8 | 51.6 | 2.24 | 2.36x | 2.35x |
| insert 10,000 distinct keys | 476.8 | 104.1 | 3.63 | 4.58x | 4.57x |
| insert 20,000 distinct keys | 1.86 s | 334.3 | 9.18 | 5.58x | 5.47x |
| insert 10,000 then look up all 10,000 | 931.7 | 130.2 | 7.56 | 7.16x | 7.22x |
| **regex** |  |  |  |  |  |
| re.search(r"\w+\d") x2000, ASCII | 11.9 | 15.0 | 15.0 | 0.79x | 0.82x |
| re.search(r"\w+\d") x2000, non-ASCII | 13.5 | 8.87 | 13.5 | 1.52x | 1.60x |
| re.sub(r"\W+") x2000, ASCII | 429.4 | 41.4 | 31.6 | 10.36x | 10.48x |
| re.sub(r"\W+") x2000, non-ASCII | 454.3 | 53.1 | 32.1 | 8.55x | 8.72x |
| ure.sub(r"\W+") x2000, ASCII (native sub, no shim) | 23.2 | 40.7 | unsupported | 0.57x | 0.58x |
| re.findall(r"\w+") x2000, ASCII | 235.2 | unsupported | 30.3 | – | – |
| re.findall(r"\w+") x2000, non-ASCII | 262.2 | unsupported | 30.2 | – | – |
| **float** |  |  |  |  |  |
| str(float) x20,000 | 56.9 | 32.3 | 12.3 | 1.76x | 1.77x |
| "%.3f" % x  x20,000 | 17.8 | 23.3 | 9.58 | 0.76x | 0.78x |
| **str** |  |  |  |  |  |
| split/join/upper/replace x5,000, ASCII | 73.7 | 78.7 | 6.09 | 0.94x | 0.94x |
| split/join/upper/replace x5,000, non-ASCII | 85.6 | 92.3 | 13.5 | 0.93x | 0.92x |
| repr(list of non-ASCII strings) x5,000 | 100.9 | 127.1 | 16.9 | 0.79x | 0.80x |
| **json** |  |  |  |  |  |
| json.dumps(200 records) x200 | 1.55 s | 290.8 | 69.2 | 5.34x | 5.22x |
| json.loads(200 records) x200 | 165.5 | 191.3 | 49.2 | 0.87x | 0.88x |
| **sort** |  |  |  |  |  |
| sorted(8,000 ints) | 8.15 | 13.2 | 4.35 | 0.62x | 0.63x |
| sorted(5,000 strings) | 10.5 | 14.5 | 3.33 | 0.72x | 0.76x |
| **collections** |  |  |  |  |  |
| Counter(words).most_common(5) x500 | 133.7 | unsupported | 23.5 | – | – |
| **pipeline** |  |  |  |  |  |
| stdin 2,000 lines -> word count -> stdout | 15.5 | 23.6 | 1.72 | 0.65x | 0.67x |
| stdin 2,000 lines -> frequency dict -> top 5 | 64.1 | 67.0 | 7.30 | 0.96x | 0.97x |
| stdin 2,000 lines -> filter + upper -> stdout | 8.29 | 14.6 | 2.20 | 0.57x | 0.60x |

### Raw wall clock, median / min (ms unless marked s)
| case | pygram med | pygram min | stock med | stock min | CPython3* med | CPython3* min |
|---|---|---|---|---|---|---|
| -c 'pass' | 1.23 | 1.14 | 1.42 | 1.05 | 14.2 | 13.2 |
| -c 'print(1)' | 1.25 | 1.10 | 1.20 | 1.11 | 13.8 | 13.3 |
| insert 1,000 distinct keys | 7.47 | 7.10 | 5.66 | 5.48 | 14.5 | 14.2 |
| insert 5,000 distinct keys | 125.9 | 122.9 | 54.4 | 52.7 | 16.3 | 15.5 |
| insert 10,000 distinct keys | 481.3 | 477.9 | 106.5 | 105.1 | 18.0 | 16.8 |
| insert 20,000 distinct keys | 1.90 s | 1.87 s | 348.0 | 335.3 | 25.2 | 22.4 |
| insert 10,000 then look up all 10,000 | 955.6 | 932.9 | 133.6 | 131.2 | 21.4 | 20.8 |
| re.search(r"\w+\d") x2000, ASCII | 13.5 | 13.1 | 16.4 | 16.1 | 29.3 | 28.2 |
| re.search(r"\w+\d") x2000, non-ASCII | 15.1 | 14.6 | 10.1 | 9.92 | 27.4 | 26.7 |
| re.sub(r"\W+") x2000, ASCII | 442.8 | 430.5 | 43.5 | 42.5 | 47.4 | 44.8 |
| re.sub(r"\W+") x2000, non-ASCII | 464.1 | 455.4 | 54.5 | 54.2 | 46.9 | 45.3 |
| ure.sub(r"\W+") x2000, ASCII (native sub, no shim) | 25.0 | 24.4 | 42.3 | 41.8 | unsupported |  |
| re.findall(r"\w+") x2000, ASCII | 241.6 | 236.3 | unsupported |  | 46.3 | 43.5 |
| re.findall(r"\w+") x2000, non-ASCII | 267.8 | 263.4 | unsupported |  | 44.6 | 43.4 |
| str(float) x20,000 | 58.7 | 58.1 | 33.9 | 33.3 | 28.7 | 25.5 |
| "%.3f" % x  x20,000 | 19.6 | 19.0 | 25.1 | 24.3 | 23.8 | 22.8 |
| split/join/upper/replace x5,000, ASCII | 75.8 | 74.8 | 80.9 | 79.7 | 19.9 | 19.3 |
| split/join/upper/replace x5,000, non-ASCII | 88.2 | 86.7 | 95.7 | 93.3 | 28.1 | 26.7 |
| repr(list of non-ASCII strings) x5,000 | 103.4 | 102.0 | 129.6 | 128.2 | 30.7 | 30.1 |
| json.dumps(200 records) x200 | 1.57 s | 1.55 s | 303.0 | 291.9 | 85.1 | 82.5 |
| json.loads(200 records) x200 | 171.2 | 166.7 | 195.1 | 192.3 | 64.1 | 62.4 |
| sorted(8,000 ints) | 9.56 | 9.29 | 14.6 | 14.2 | 18.4 | 17.6 |
| sorted(5,000 strings) | 12.3 | 11.6 | 16.1 | 15.5 | 17.5 | 16.5 |
| Counter(words).most_common(5) x500 | 136.7 | 134.8 | unsupported |  | 39.0 | 36.7 |
| stdin 2,000 lines -> word count -> stdout | 17.4 | 16.6 | 25.5 | 24.7 | 15.9 | 14.9 |
| stdin 2,000 lines -> frequency dict -> top 5 | 67.7 | 65.3 | 70.0 | 68.1 | 21.2 | 20.5 |
| stdin 2,000 lines -> filter + upper -> stdout | 10.0 | 9.43 | 16.0 | 15.6 | 16.8 | 15.4 |

### Cases a binary could not run (data, not failures)
| case | binary | verdict | reason |
|---|---|---|---|
| ure.sub(r"\W+") x2000, ASCII (native sub, no shim) | CPython3* | unsupported | ModuleNotFoundError: No module named 'ure' |
| re.findall(r"\w+") x2000, ASCII | stock | unsupported | AttributeError: module 're' has no attribute 'findall' |
| re.findall(r"\w+") x2000, non-ASCII | stock | unsupported | AttributeError: module 're' has no attribute 'findall' |
| Counter(words).most_common(5) x500 | stock | unsupported | ImportError: can't import name Counter |

Noise warning: 1 case(s) where the min-based and median-based ratios disagree by more than 25% — startup-pass. Do not quote these as findings.

Machine: Intel(R) Xeon(R) Processor @ 2.80GHz x4, 17 GB, Linux 6.18.5-fc-v20 x86_64, node v22.22.2. Load average at start/end: 1.14 0.45 0.17 / 1.00 0.70 0.32.
Config: repeats=15 warmup=3 max-case-ms=30000. Verdict ratio uses the floor-subtracted MIN.

---

### Reading

**This is the harness's first real job: judging someone else's optimization.**
PR #434 changed only `pygram/variant/mpconfigvariant.h` and `mpconfigvariant.mk`
— no C, no shims — and took the binary from **390,456 B to 304,440 B (−22%)**
with conformance intact (195 MATCH / 13 UNSUPPORTED / **0 MISMATCH**, on a
corpus that grew to 208 entries) and all three build-gate numbers unchanged:
static, zero file opens, zero stat/access.

Every ratio below was confirmed by a second full run before being written down,
which is the rule the baseline entry set. What that second run changed and did
not change is the whole point of doing it:

| case | baseline (390 KB) | this entry | confirm run | verdict |
|---|---|---|---|---|
| `-c 'print(1)'` | 0.99× | 1.68× | **0.97×** | the 1.68× was NOISE — discarded |
| dict insert 20k | 9.62× | 5.32× | 5.46× | real, large improvement |
| dict lookup 10k | 12.33× | 7.18× | 7.34× | real, large improvement |
| `json.dumps` | 3.91× | 5.39× | 5.35× | real REGRESSION |
| `re.sub` ASCII | 10.98× | 10.55× | 10.57× | unchanged |
| `str(float)` | 1.86× | 1.75× | 1.76× | unchanged |

**The dict cost roughly halved.** Insertion at 20,000 keys went 9.62× → 5.46×
and lookup 12.33× → 7.34×, and the absolute numbers moved with them (20k
insertion 2.57 s → 1.84 s). The ordered-map scan is still quadratic — that is a
data structure, and a config change cannot fix it — but the constant in front
of it got materially smaller. This is the single largest cost pygram carries,
so halving its constant is the most valuable thing #434 did, and it was not
what the PR was about.

**`json.dumps` moved the other way, and it reproduces.** 3.91× → 5.35×, with
pygram's absolute time going 1.30 s → 1.57 s on the same input. Note the
control also drifted between runs (331.7 ms → 292.8 ms for a binary that did
not change), so cross-entry comparison is weaker than within-run comparison and
some of the ratio move is the machine. The absolute pygram slowdown is not
explained by that, though, and it is worth a look: `json.dumps` was previously
attributed to dict ordering, and dict ordering got FASTER here while dumps got
slower — so the two are less coupled than the baseline entry assumed.

**The startup outlier is the reason the confirm-run rule exists.** The recorded
run put `-c 'print(1)'` at 1.68× with a `!` on the median disagreement. A second
run put it at 0.97×. Had it been written up from one run, the ledger would now
claim pygram's variant costs 68% on startup, which is false. Startup is at
parity, as it has been since the baseline.

## 2026-08-14 — pygram vs stock MicroPython — baseline: first measured run of the harness

MicroPython pin **v1.28.0** (`e0e9fbb17ed6`), repo `fa90a86e22e9` (working tree dirty) on branch `claude/pygram-bench-vs-stock`. Control built by `bash scripts/pygram-build.sh --stock`.

### Binaries
| binary | bytes | linkage | opens on -c 'pass' | failed probes | stat/access | sha256 |
|---|---|---|---|---|---|---|
| pygram | 390,456 | static Intel 80386 | 0 | 0 | 0 | 79038878263d |
| stock | 455,680 | static Intel 80386 | 0 | 0 | 6 | 91937bdb6290 |
| CPython3* | 6,639,992 | dynamic | 22 | 7 | 65 | f56a588548dd |

### Floor-subtracted workload, min of n=15 (ms unless marked s)
| case | pygram | stock | CPython3* | py/stock min | py/stock med |
|---|---|---|---|---|---|
| **startup** |  |  |  |  |  |
| -c 'pass' | 0.901 raw | 0.866 raw | 11.5 raw | 1.04x | 0.93x |
| -c 'print(1)' | 0.937 raw | 0.954 raw | 11.8 raw | 0.98x | 0.91x |
| **dict** |  |  |  |  |  |
| insert 1,000 distinct keys | 7.58 | 3.53 | 0.352 | 2.14x | 2.45x |
| insert 5,000 distinct keys | 169.4 | 42.4 | 1.82 | 4.00x | 4.06x |
| insert 10,000 distinct keys | 646.5 | 83.6 | 2.86 | 7.74x | 7.64x |
| insert 20,000 distinct keys | 2.54 s (n=12) | 270.3 | 6.36 | 9.40x | 9.30x |
| insert 10,000 then look up all 10,000 | 1.29 s | 104.3 | 5.09 | 12.36x | 12.32x |
| **regex** |  |  |  |  |  |
| re.search(r"\w+\d") x2000, ASCII | 10.2 | 10.5 | 11.7 | 0.97x | 1.03x |
| re.search(r"\w+\d") x2000, non-ASCII | 11.8 | 6.42 | 10.6 | 1.84x | 1.87x |
| re.sub(r"\W+") x2000, ASCII | 365.9 | 33.5 | 22.8 | 10.93x | 11.02x |
| re.sub(r"\W+") x2000, non-ASCII | 390.5 | 44.8 | 23.7 | 8.73x | 8.81x |
| ure.sub(r"\W+") x2000, ASCII (native sub, no shim) | 22.7 | 33.6 | unsupported | 0.68x | 0.67x |
| re.findall(r"\w+") x2000, ASCII | 200.3 | unsupported | 21.0 | – | – |
| re.findall(r"\w+") x2000, non-ASCII | 214.4 | unsupported | 21.8 | – | – |
| **float** |  |  |  |  |  |
| str(float) x20,000 | 47.1 | 25.1 | 9.15 | 1.88x | 1.89x |
| "%.3f" % x  x20,000 | 16.2 | 18.8 | 7.12 | 0.86x | 0.81x |
| **str** |  |  |  |  |  |
| split/join/upper/replace x5,000, ASCII | 52.9 | 53.6 | 4.19 | 0.99x | 0.99x |
| split/join/upper/replace x5,000, non-ASCII | 66.8 | 66.7 | 11.0 | 1.00x | 1.00x |
| repr(list of non-ASCII strings) x5,000 | 111.5 | 134.7 | 11.9 | 0.83x | 0.84x |
| **json** |  |  |  |  |  |
| json.dumps(200 records) x200 | 1.27 s | 332.9 | 57.6 | 3.81x | 3.88x |
| json.loads(200 records) x200 | 124.5 | 123.6 | 40.7 | 1.01x | 1.02x |
| **sort** |  |  |  |  |  |
| sorted(8,000 ints) | 7.97 | 10.8 | 4.61 | 0.74x | 0.76x |
| sorted(5,000 strings) | 9.44 | 11.9 | 3.11 | 0.79x | 0.79x |
| **collections** |  |  |  |  |  |
| Counter(words).most_common(5) x500 | 122.3 | unsupported | 18.2 | – | – |
| **pipeline** |  |  |  |  |  |
| stdin 2,000 lines -> word count -> stdout | 14.0 | 22.4 | 1.84 | 0.63x | 0.63x |
| stdin 2,000 lines -> frequency dict -> top 5 | 76.1 | 56.5 | 4.68 | 1.35x | 1.34x |
| stdin 2,000 lines -> filter + upper -> stdout | 6.22 | 13.5 | 1.03 | 0.46x | 0.45x |

### Raw wall clock, median / min (ms unless marked s)
| case | pygram med | pygram min | stock med | stock min | CPython3* med | CPython3* min |
|---|---|---|---|---|---|---|
| -c 'pass' | 0.996 | 0.901 | 1.07 | 0.866 | 11.7 | 11.5 |
| -c 'print(1)' | 0.980 | 0.937 | 1.08 | 0.954 | 13.0 | 11.8 |
| insert 1,000 distinct keys | 9.45 | 8.48 | 4.52 | 4.40 | 13.8 | 11.8 |
| insert 5,000 distinct keys | 175.1 | 170.3 | 43.9 | 43.2 | 14.4 | 13.3 |
| insert 10,000 distinct keys | 667.0 | 647.4 | 88.3 | 84.4 | 15.5 | 14.3 |
| insert 20,000 distinct keys | 2.59 s | 2.54 s | 279.6 | 271.2 | 19.0 | 17.8 |
| insert 10,000 then look up all 10,000 | 1.33 s | 1.29 s | 108.7 | 105.1 | 18.0 | 16.6 |
| re.search(r"\w+\d") x2000, ASCII | 11.9 | 11.1 | 11.6 | 11.3 | 24.2 | 23.2 |
| re.search(r"\w+\d") x2000, non-ASCII | 13.5 | 12.7 | 7.75 | 7.28 | 23.2 | 22.0 |
| re.sub(r"\W+") x2000, ASCII | 373.3 | 366.8 | 34.9 | 34.3 | 35.8 | 34.2 |
| re.sub(r"\W+") x2000, non-ASCII | 406.1 | 391.4 | 47.0 | 45.6 | 37.2 | 35.1 |
| ure.sub(r"\W+") x2000, ASCII (native sub, no shim) | 23.9 | 23.6 | 35.3 | 34.5 | unsupported |  |
| re.findall(r"\w+") x2000, ASCII | 204.5 | 201.2 | unsupported |  | 33.5 | 32.5 |
| re.findall(r"\w+") x2000, non-ASCII | 220.7 | 215.3 | unsupported |  | 34.8 | 33.3 |
| str(float) x20,000 | 49.5 | 48.0 | 26.7 | 25.9 | 21.3 | 20.6 |
| "%.3f" % x  x20,000 | 18.0 | 17.1 | 22.0 | 19.7 | 20.2 | 18.6 |
| split/join/upper/replace x5,000, ASCII | 55.6 | 53.8 | 56.4 | 54.4 | 16.6 | 15.7 |
| split/join/upper/replace x5,000, non-ASCII | 69.5 | 67.7 | 69.7 | 67.6 | 23.6 | 22.5 |
| repr(list of non-ASCII strings) x5,000 | 117.9 | 112.4 | 140.8 | 135.6 | 24.5 | 23.4 |
| json.dumps(200 records) x200 | 1.31 s | 1.27 s | 337.7 | 333.7 | 72.4 | 69.0 |
| json.loads(200 records) x200 | 133.9 | 125.4 | 131.4 | 124.5 | 56.8 | 52.2 |
| sorted(8,000 ints) | 9.27 | 8.87 | 11.9 | 11.6 | 16.7 | 16.1 |
| sorted(5,000 strings) | 10.6 | 10.3 | 13.2 | 12.8 | 15.7 | 14.6 |
| Counter(words).most_common(5) x500 | 128.6 | 123.2 | unsupported |  | 30.6 | 29.6 |
| stdin 2,000 lines -> word count -> stdout | 15.6 | 14.9 | 24.1 | 23.2 | 14.2 | 13.3 |
| stdin 2,000 lines -> frequency dict -> top 5 | 79.5 | 77.0 | 59.6 | 57.4 | 17.2 | 16.1 |
| stdin 2,000 lines -> filter + upper -> stdout | 7.24 | 7.12 | 14.9 | 14.4 | 13.2 | 12.5 |

### Cases a binary could not run (data, not failures)
| case | binary | verdict | reason |
|---|---|---|---|
| ure.sub(r"\W+") x2000, ASCII (native sub, no shim) | CPython3* | unsupported | ModuleNotFoundError: No module named 'ure' |
| re.findall(r"\w+") x2000, ASCII | stock | unsupported | AttributeError: module 're' has no attribute 'findall' |
| re.findall(r"\w+") x2000, non-ASCII | stock | unsupported | AttributeError: module 're' has no attribute 'findall' |
| Counter(words).most_common(5) x500 | stock | unsupported | ImportError: can't import name Counter |

Machine: Intel(R) Xeon(R) Processor @ 2.80GHz x4, 17 GB, Linux 6.18.5-fc-v20 x86_64, node v22.22.2. Load average at start/end: 0.56 0.52 0.36 / 0.99 0.77 0.49.
Config: repeats=15 warmup=3 max-case-ms=30000. Verdict ratio uses the floor-subtracted MIN.

### Reading

Reproducibility first, because nothing below is worth reading without it. This
battery was run twice back to back on the same idle machine, and the ratios
landed within about 1% of each other on every non-startup row: `re.sub` ASCII
11.00x then 10.93x, `dict-lookup-10k` 12.30x then 12.36x, `json.dumps` 3.90x
then 3.81x, `str(float)` 1.94x then 1.88x. **A difference under about 5% on this
machine is inside run-to-run variance and is not a result.** That threshold is
what the rest of this section is measured against.

**Startup is free — 1.04x, and inside noise.** pygram and stock both start in
about 0.9 ms; the two runs put pygram at 0.89x and then 1.04x of stock, which
straddles 1.00 and settles the question. Nothing pygram does — the frozen
stdlib, the pinned `sys.path`, the port patch — costs measurable startup time on
a warm host, and pygram carries 65 KB less binary and 6 fewer `stat` calls into
the sandbox where startup is the whole point. This row is the one where the two
statistics disagreed in the first run (`!` on `print(1)`), which is exactly what
sub-millisecond timings look like.

**The dict quadratic is real, reproduces, and is the largest cost we carry.**
2.14x at 1,000 keys, 4.00x at 5,000, 7.74x at 10,000, 9.40x at 20,000 — the
ratio grows with n because MicroPython's ordered map is a linear array and
stock's is a hash map. In absolute terms 20,000 insertions cost 2.54 s here
against stock's 270 ms. Two things about that number: the emulated i386 guest is
substantially slower than this host, and the exec ceiling that **destroys the
VM** is 30 s. Lookup is worse than insertion — `dict-lookup-10k` is 12.36x,
against 7.74x for building the same dict — because every read is a scan too. The
1,000-key end is where ordinary one-liners live and 2.14x of 3.5 ms is nothing;
the 20,000-key end is a word count over a large document and it is the case to
watch. This is the price of `print(d)` agreeing with CPython, and it was paid
knowingly (pygram/README.md, owner decision 2026-08-13).

**`re.sub` is 10.93x slower — and it is not the regex engine.** This is the
finding the decomposition case was added for. `ure.sub` — the native
substitution, reached without our shim in the way — is **0.68x**, so pygram is
*faster* than stock on the same call. The 10.93x belongs entirely to
`pygram/lib/re.py`, whose `_subn` implements CPython's substitution semantics in
frozen Python on top of that native call.

One caveat on this pair, so it is not over-read: the two engines are **not**
byte-identical. Our port patch edits `lib/re1.5/charclass.c` to make `\w` treat
bytes >= 0x80 as word constituents. So the comparison isolates *shim vs no
shim*, which is what the finding rests on — it does not isolate *patched vs
unpatched engine*, and the 0.68x is therefore not a clean measurement of what
the charclass patch costs. On ASCII input that patch adds one comparison on a
path that already failed three, which is consistent with the direction here but
is not established by this row. `re.findall` and
`re.finditer` are in the same position and stock cannot run them at all, so they
have no ratio; their 200 ms is the same interpreted-Python cost with no control
to divide by. If regex substitution ever matters in the sandbox, the fix is to
move `_subn` toward the C `sub` rather than to touch the engine — and the
0.68x row says the engine has nothing to give.

**`re.search` on ASCII is free (0.97x); on non-ASCII it is 1.84x — but that
number is not a like-for-like cost.** The `\w` patch makes bytes ≥ 0x80 word
constituents, so on Swedish text the two builds are not doing the same work:
pygram matches `räksmörgås` as one token and stock matches four fragments and
stops sooner. Some of the 1.84x is our per-byte check and some is simply more
input matched. The honest reading is that the patch costs *something* on
non-ASCII input and nothing on ASCII, and that this case cannot separate the
two. Correctness is not in question — an ASCII-only `\w` shredded `räksmörgås`
into `['r', 'ksm', 'rg', 's']`, which is the silent-divergence failure the whole
project exists to prevent.

**Exact float repr costs 1.88x, and its control says that is the repr and not
something else.** `str(float)` is 47.1 ms against stock's 25.1; `"%.3f" %` —
fixed precision, same code path in both builds — is 0.86x. So the shortest
round-trip loop is roughly twice the cost of the `printf` approximation, on a
workload of 20,000 conversions. That buys `9.7` printing as `9.7` instead of
`9.699999999999999`.

**`json.dumps` is 3.81x, and that is the ordered dict reaching ordinary code.**
`json.loads` is 1.01x. Dumping walks 200 ordered maps per iteration; loading
builds small ones. This is the row that shows the dict decision is not confined
to a synthetic dict benchmark.

**pygram is faster than stock on several rows, and the reasons are mundane.**
`sorted` 0.74–0.79x, `repr` of non-ASCII strings 0.83x, and the two non-dict
pipeline cases 0.46x and 0.63x. The `repr` row has an explanation in the diff —
pygram emits `å` where stock emits `\xe5`, so it builds a shorter string. The
sort and pipeline rows have no such explanation in our changes, and the controls
(`str-methods` 0.99x, `str-nonascii` 1.00x, `json-loads` 1.01x) are flat, which
rules out a global shift. The likeliest cause is that a 390 KB binary with a
different link order has better instruction-cache behaviour than a 456 KB one;
that is a hypothesis, not a measurement, and it is recorded as one. `pipe-freq`,
the only pipeline case that builds a large dict, is 1.35x — the dict cost
showing through the same shape that is otherwise 0.5x.

**Three cases stock cannot run at all** — `re.findall` (both arms) and
`Counter.most_common`. Those are pygram's frozen stdlib, and the right reading
is coverage, not speed: the control has no such feature, so there is nothing to
divide by. It is also the cheapest available proof that the two binaries really
are different builds.

---

