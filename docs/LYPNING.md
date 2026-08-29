# lypning — the Python this project runs, and the dashboard that measures it

`pygram` and `mopy` used to live in this repository. They do not any more. Both
were folded into one project — **[lypning](https://github.com/kristerhedfors/lypning)**
— and this repository now *depends on* that project instead of carrying it.

This document is the seam: what lypning is, where it plugs in here, what this
repository still owns, and how the `/lypning/` dashboard gets its numbers.

---

## 1. What lypning is

A **mixture of Pythons**. A program is run on the cheapest of three interpreters
that can actually run it:

| tier | what it is | how it runs |
|---|---|---|
| `lypning` | a from-scratch Python subset in Rust | in-process — zero spawns |
| `lypning-mp` | a MicroPython variant with a frozen shim stdlib | forked, so its refusal is catchable |
| `cpython` | the real thing | `exec`'d — no fork, no way back, and none needed |

A classifier picks the tier by asking the Rust core's own parser, so "can tier 1
run this" is an exact answer costing one parse and no spawn. Every tier refuses
the same way — **exit `90`, one line on stderr, nothing on stdout** — which is
what makes the three interchangeable and what makes a wrong route cost one
wasted process spawn instead of a wrong answer.

The subset is not sized to Python. It is sized to the one-liners a coding agent
actually types, which is a much narrower target and is the only reason any of it
is affordable.

**Do not quote a number from lypning's README here.** That is lypning's own
invariant 3 and it is the rule this repository breaks most easily: every tool
over there prints the corpus size it loaded because yours will differ. Where this
repository shows a figure, it either measured it (the dashboard's live battery,
`scripts/build-lypning.mjs` counting a tree) or labels it a quote.

## 2. Why the sandbox needs it

The in-browser execution sandbox is a CheerpX x86 Linux VM whose disk is
streamed block by block over a WebSocket. Cost there is **bytes and file opens**,
not CPU. Measured in a real VM on 2026-08-14 against the image
`scripts/build-sandbox-image.sh` builds:

```
a frozen subset  -c 'import json; …'    27 ms cold, streaming ZERO bytes
a frozen subset  --version              86 ms cold, 1,152 KB
python3 --version                      318 ms cold, 3,460 KB
python3 -c 'print(1+1)'                NEVER COMPLETED — 2.3 MB streamed, then
                                       the block fetches stop dead and the VM
                                       is wedged. `-S` does not save it.
```

So this is not a preference between interpreters. In that image CPython cannot
run a one-liner at all, and a static interpreter with its stdlib frozen in — one
that opens **zero** files at startup — is the difference between the sandbox
having Python and not having it.

The two engines are installed **alongside** `python3`, never aliased over it.
Aliasing changes what an agent can do and is not a call a build script makes
silently.

## 3. Where it plugs in here

| here | does what |
|---|---|
| `scripts/build-sandbox-image.sh` | installs `lypning` and `lypning-mp` into the ext2 sandbox image. Both are SKIPPED with a message when absent or not i386 — an image with no fast Python is loud, never silent. |
| `.claude/hooks/lypning.sh` | SessionStart: uses lypning's own shim when lypning is pip-installed, and says so when it is not. Never blocks, never fails a session. |
| `tests/e2e/sandbox-perf.spec.js` | probes both engines against the three CPython probes. The pair IS the acceptance metric. |
| `scripts/build-lypning.mjs` | walks a lypning clone's history into `public/lypning/history.json`. |
| `public/js/lypning-core.js` | the dashboard's pure core — the battery, the series, the local responder. |
| `public/lypning/index.html` + `public/js/lypning-page.js` | the dashboard. |

**CheerpX is 32-bit x86 only.** An x86_64 build cannot run there, and lypning's
published numbers were all measured on one, on a normal filesystem. A binary
that is not i386 is skipped rather than installed and hoped for.

Building the engines:

```bash
git clone https://github.com/kristerhedfors/lypning ../lypning
cd ../lypning && pip install -e .
lypning build --rust --target i686     # → assets/rust/target/i686-unknown-linux-musl/release/lypning
lypning build --micropython            # → assets/micropython/build/lypning-mp  (already musl-i386)
```

then point `LYPNING_REPO` (or `LYPNING_BIN` / `LYPNING_MP_BIN`) at the result and
run `scripts/build-sandbox-image.sh`.

**lypning is never a runtime import of the Worker** (CLAUDE.md invariant 5).
Nothing in `src/` imports it, `package.json` gains no dependency, and the
dashboard's server half reads a committed JSON file. lypning is a build-time and
image-time dependency only.

## 4. The dashboard at `/lypning/`

Public, no account, and cross-origin isolated so the VM can boot there (the COEP
document, `src/assets.js` / `src/index.js`). It shows **two kinds of number and
never mixes them**:

- **Live — measured here.** The battery runs in the reader's own browser Linux
  VM. It probes which engines that VM actually has, then times a small set of
  agent-shaped one-liners: `min` of N rather than the mean (noise in a browser
  tab is one-sided — it can only ever add time), floor-subtracted against each
  engine's own `-c 'pass'`, cold start measured once because measuring it warms
  it. An engine that is not in the VM gets no rows and says so; a case that
  failed is shown failed. Nothing is ever back-filled from the published table.
- **Backwards — quoted or counted.** Every commit in lypning's history, with
  either what it *contained* (counted out of the tree by `build-lypning.mjs` —
  corpus entries, Rust lines, frozen stdlib modules) or what it *claimed* (read
  off the README that commit published — the cost ratio, startup, MISMATCH
  counts, route accuracy, binary sizes). A quoted figure was measured on somebody
  else's machine on a day that is gone. `measuredHere` rides on every series so
  the page renders the two differently without a hard-coded list.

A commit that published no table contributes a **gap**, not a zero: it did not
measure zero, it did not measure.

### The battery is a list of small steps on purpose

A command that crosses the VM's exec ceiling does not fail — it **destroys the
VM**. So the battery is one short command per case, each with its own budget
strictly under the ceiling, run one at a time. The reader watching rows appear
one by one is a side effect of that constraint.

### Regenerating the history

```bash
npm run lypning                 # needs a lypning clone: --repo, $LYPNING_REPO, or ../lypning
npm run lypning:check           # exit 3 if the committed file is stale
```

The check runs in the unit suite, so a lypning bump nobody regenerated is loud
rather than quietly old.

## 5. What this repository no longer owns

Deleted with this change, and living in lypning now: the `pygram/` and `mopy/`
source trees, their build/bench/gate/fuzz scripts, the conformance batteries and
sighting corpus under `tests/`, the capture hooks, the CI job that built the i386
artifact, and `docs/PYGRAM*.md` + `docs/MOPY.md`. lypning's own CI gates all of
it — building the real artifact, the shape gate (static, size, file opens) and
the CPython diff — and duplicating that here would gate a copy nothing here
builds.

The corpus that grew from real agent sessions grew *here*, and that loop moves
with it: lypning has its own capture (`lypning harvest`) and its own hooks.
