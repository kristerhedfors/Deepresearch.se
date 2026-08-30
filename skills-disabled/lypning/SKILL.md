---
name: lypning
description: >-
  Load when working on the Python the in-browser sandbox runs, or on anything
  that reports its numbers. The interpreter itself is NO LONGER IN THIS
  REPOSITORY — pygram and mopy were broken out into
  github.com/kristerhedfors/lypning on 2026-08-29 — so this skill is about the
  SEAM that stayed and the ways it fails quietly:
  scripts/build-sandbox-image.sh installing the two engines into the ext2 image
  (and skipping LOUDLY when they are absent or not i386, because an image built
  without them is the failure that looks like success), the paired probes in
  tests/e2e/sandbox-perf.spec.js that must use a builtin `[ -x … ]` and never
  `command -v`, .claude/hooks/lypning.sh, and the /lypning/ dashboard —
  public/js/lypning-core.js, public/js/lypning-page.js, public/lypning/,
  src/lypning-stats.js and scripts/build-lypning.mjs. ALSO load it before
  touching anything that PRESENTS a lypning number, because the one rule this
  surface exists to hold is lypning's own third invariant: never present a
  remembered number as a measurement. Covers the two kinds of number and how
  they are kept apart, why the battery is a list of small steps rather than one
  script, why it takes the minimum of N rather than the mean, and the three
  traps already paid for. Reference: docs/LYPNING.md.
---

# lypning — the interpreter that left, and the seam that stayed

`pygram/` and `mopy/` are gone from this repository. They became one project —
**[lypning](https://github.com/kristerhedfors/lypning)** — and its CI builds the
real i386 artifact, runs the shape gate (static, size, file opens) and diffs
every corpus entry against CPython. **Do not rebuild any of that here.** Gating
a copy nothing here builds would gate nothing.

`docs/LYPNING.md` is the reference. This page is the working knowledge.

## 1. What can actually go wrong on this side

Four things, and every one of them fails without an error.

**An image that ships with no fast Python and says nothing.**
`scripts/build-sandbox-image.sh`'s `install_engine` must SKIP with a message
when a binary is absent or is not `ELF 32-bit`. CheerpX is 32-bit x86 ONLY, and
every number lypning publishes upstream was measured on an x86-64 build on a
normal filesystem — so a binary that is not i386 must be skipped rather than
installed and hoped for. An image that built cleanly and has no interpreter
looks exactly like a successful build.

**A probe that walks PATH.** The absence check in
`tests/e2e/sandbox-perf.spec.js` is a shell BUILTIN test on one absolute path.
`docs/SANDBOX-LOCAL-IMAGE.md` records a `command -v` for a tool that was not
installed consuming the entire 30 s exec ceiling — which calls `resetSandbox`
and DESTROYS the VM, taking every later probe with it. A missing tool is exactly
the case these probes are for, so the PATH walk is the one thing they must not
do. Builtin `[ -x … ]` is ~0.1 ms.

**A stale dataset.** `npm run lypning` regenerates
`public/lypning/history.json` from a lypning clone; `npm run lypning:check`
exits 3 when the committed file no longer matches and runs in the unit suite. A
lypning bump nobody regenerated leaves the dashboard quietly describing an older
project — which is the same class of failure as the `CORPUS_FACTS.arxiv.window`
that went stale by 42,307 papers and told agents to stop looking.

**A quoted figure rendering as a measured one.** See §2. This is the one that
would undo the point of the page.

## 2. The two kinds of number

The dashboard holds both and keeps them apart. `measuredHere` rides on every
series and every battery row so nothing has to hard-code which is which.

| | where it comes from | may be presented as |
|---|---|---|
| **MEASURED HERE** | the reader's own browser Linux VM, just now; or `build-lypning.mjs` counting a lypning tree at a commit | a fact about this reader / this project |
| **QUOTED** | a figure some commit's README published, measured on the author's machine on a day that is gone | history, never "your number" |

This is lypning's own **invariant 3**, and it is the rule an eager assistant
breaks first: every tool over there prints the corpus size it loaded precisely
because yours will differ. Concretely, in this repository:

- A commit that published no measurement table contributes a **GAP** to a
  series, not a zero. It did not measure zero; it did not measure.
- An engine that is not in the reader's VM gets **no rows** — never rows filled
  in from the published table.
- A step that failed is shown **failed**. A battery that silently shrank when a
  case timed out would report a faster machine than the reader has.
- `readPublished()` returns **no field** rather than a zeroed one, and
  `scripts/build-lypning.test.mjs` asserts exactly that.

## 3. Why the battery is shaped the way it is

**A list of small steps, not one script.** A command that crosses the VM's exec
ceiling does not fail — it destroys the VM (`skills-disabled/sandbox-perf-eval`).
Every step carries its own budget strictly under the ceiling and they run one at
a time. The reader watching rows appear one by one is a side effect of that.

**`min` of N, not the mean.** Noise on a shared machine is one-sided —
scheduling, page faults and a neighbouring tab can only ever ADD time — so the
minimum of a repeated run is the least biased estimate. A mean would report the
reader's other tabs. Same reasoning as lypning's own bench ledger.

**Floor-subtracted, except the floor.** `-c 'pass'` is measured per engine and
taken off every other row, so a 3 ms workload is not reported as a 90 ms one
because process spawn dominated it. A row whose floor is missing is reported RAW
and flagged: subtracting a floor you did not measure is how a benchmark starts
lying.

**Cold start is measured once, and first.** The first invocation after boot is
the number lypning exists to attack, and measuring it warms it. There is no loop
around it — a loop would measure the warm case and call it cold.

## 4. Regenerating the history

```bash
git clone https://github.com/kristerhedfors/lypning ../lypning
npm run lypning                    # --repo <path>, $LYPNING_REPO, or ../lypning
npm run lypning:check              # exit 3 if the committed file is stale
```

The dataset carries **no wall-clock stamp**. A timestamp would make every
regeneration a diff and `--check` could never tell a stale file from a re-run
one.

The README parser is anchored on the PROSE around each figure rather than on
table geometry: that table has been reshaped twice upstream and the sentences
have not.

## 5. Building the engines for the image

```bash
cd ../lypning && pip install -e .
lypning build --rust --target i686      # → assets/rust/target/i686-unknown-linux-musl/release/lypning
lypning build --micropython             # → assets/micropython/build/lypning-mp (already musl-i386)
```

Then point `LYPNING_REPO` (or `LYPNING_BIN` / `LYPNING_MP_BIN`) at the result and
run `scripts/build-sandbox-image.sh`. Both engines are installed **alongside**
`python3`, never aliased over it: aliasing changes what an agent can do and is
not a call a build script makes silently.

## 6. What you do NOT have to do

**You do not have to write to a subset.** The mixture answers everything: a tier
that meets something it cannot take refuses with exit 90 and the dispatcher
falls onward, so a wrong route costs one wasted process spawn rather than a
wrong answer. Write ordinary Python. (This is a change from the pygram era,
when a rewrite table lived in CLAUDE.md — that table described one engine with
no tier below it.)

**lypning is never a runtime import of the Worker.** Nothing in `src/` imports
it, `package.json` gains no dependency, and the dashboard's server half reads a
committed JSON file (invariant 5). It is a build-time and image-time dependency
only.
