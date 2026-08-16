---
name: test-batches
description: >-
  Load when you want STANDARD, ready-made test cases for a specific piece of
  the pipeline — "get the test batch for the sandbox", "give me the quiz
  tests", "extend the search batch", "shrink the shodan batch", "mint the maps
  batch onto the queue", "what pipeline cases have test batches" — the curated
  library (docs/test-batches/<case>.json) of try-it points per pipeline case
  (direct, search, clarify, quiz, shodan, maps, sandbox, introspection,
  attachments, providers) plus scripts/test-batch to list/get/validate/extend/
  shrink them and feed them into the two channels (--mint onto the live queue,
  --to-request into a worker's PR file). Companion to testable-interaction-
  points (grammar), test-feedback-loop (the loop that consumes verdicts), and
  request-testing (the worker channel).
---

# Test batches — standard test cases per pipeline case

## What this is

The try-it queue tests one-off fixes; this is the **standing library** of
reusable test cases, organized by the pipeline CASE they exercise. Each case
has a curated batch of points in full try-it grammar, so instead of
hand-writing points every time you can pull the batch for a piece of the
pipeline, shape it, and feed it into whichever channel you need.

```
 docs/test-batches/<case>.json  ──get/extend/shrink──►  a batch you can work with
        │                                                        │
        ├── --mint <case> ──────────────────────────►  live try-it queue (owner tests now)
        └── --to-request <case> <branch> ───────────►  docs/test-requests/<branch>.json
                                                        (a worker ships it in its PR)
```

## The cases (one file each)

| Case | Exercises | Notes |
|---|---|---|
| `direct` | Triage → direct reply, no search wave | search left ON to prove triage chose to skip |
| `search` | Full pipeline: triage → search → gap → synth → validate | cited answer; gap-check follow-up round |
| `clarify` | Triage asks to narrow scope | vague ask → clarifying question, not a blind search |
| `quiz` | Inline quiz gen + grading | **EN + SV parity** (invariant 6) |
| `shodan` | Host-intelligence enrichment | fires on a host ask AND stays quiet on an unrelated ask (the relevance-note fix) |
| `maps` | Street View / Maps enrichment | **EN + SV parity** (`gatuvy`) |
| `sandbox` | In-browser Linux VM (bash-lite) | most regression-prone; several `runs:2` (tab + PWA) |
| `introspection` | Developer mode → answers from own source | cites real file paths |
| `attachments` | Document RAG + image vision | navigate-then-attach-BY-HAND (outside the action grammar) |
| `providers` | Split model routing | secondary-provider answer model, JSON phases stay Berget |

Adding a case = a new `docs/test-batches/<case>.json` (the `case` field must
equal the filename) — `--validate` and `--list` pick it up with no code
change. Cover a new pipeline capability with a batch the moment it ships.

## The CLI (`scripts/test-batch`)

Offline (no credentials):

```bash
scripts/test-batch --list                     # every case + point count
scripts/test-batch --get <case>               # print a batch (text; --json for JSON)
scripts/test-batch --validate                 # every point vs the REAL grammar (validateTestpointCreate)
scripts/test-batch --extend <case> '<point>'  # append a point {label,summary,target,actions?,runs?}
scripts/test-batch --shrink <case> <index>    # drop point #index (0-based, as --get numbers them)
scripts/test-batch --to-request <case> <branch> [--pr N]   # emit a worker request file
```

Live (break-glass `BASIC_AUTH_USER` / `BASIC_AUTH_PASS`):

```bash
scripts/test-batch --mint <case> [--only i,j]  # mint the batch (or just points i,j) onto the queue
```

`--extend` runs the point through the same validator the admin API applies
and REFUSES anything the grammar would reject or drop — a batch never holds a
point that won't mint. Minted points carry `ref: batch:<case>` so the
test-feedback loop can see where a verdict came from.

## Working WITH a batch (get / extend / shrink)

- **Get** to review or hand off: `--get sandbox` (human-readable) or
  `--get sandbox --json` (to pipe/edit).
- **Extend** when a new failure mode or phrasing is worth standing coverage:
  `--extend shodan '{"label":"…","summary":"… PASS=… FAIL=…","target":"/rver","actions":[…]}'`.
  Follow the authoring rules below.
- **Shrink** when a batch is too heavy to run in one sitting or a point is
  stale: `--shrink sandbox 2`. Keep batches to what the owner will actually
  run — a 12-point batch nobody finishes tests nothing.

Both edit the file in place; commit it so the library stays the shared source
of truth.

## Feeding a batch into the loop

- **Straight to the owner now**: `--mint <case>` drops the batch onto the live
  try-it queue; the owner taps verdicts; the **test-feedback-loop** sweeps and
  routes them. Use `--only i,j` to mint a subset (e.g. just the two parity
  points).
- **Into a worker's PR**: `--to-request <case> <branch> --pr N` writes
  `docs/test-requests/<branch>.json` seeded from the batch. The worker
  validates (`scripts/test-requests --validate`), trims to what its change
  actually touches, and commits it in the PR — see **request-testing**. This
  is how a worker reuses the standard cases instead of authoring from scratch.

## Authoring rules (shared with the whole loop)

- **`summary` states the exact PASS and FAIL.** "It did the thing but also
  other stuff" must be a recordable failure, not a shrug — so say "…and
  nothing else" when side-chatter would fail.
- **No stray trigger words in `compose` text.** A hostname fires Shodan,
  "quiz me" fires the quiz, street words fire Maps. Only include a trigger
  when the batch is FOR that gate (the shodan/maps/quiz batches do so
  deliberately; the sandbox hash point uses "hello world", not a domain).
- **EN + SV parity where invariant 6 applies** (quiz, maps): the Swedish
  point guards the gate unit tests drift on — keep it in the batch.
- **Knob state is scene.** The grammar can OPEN a settings knob's row
  (`openSettings`) but not SET it, so a point needing a knob ON carries an
  `openSettings` action + a `note` telling the tester to flip it. (A `setKnob`
  action is on the test-feedback-loop improvements backlog.)
- **`runs:N` for flaky/device-dependent behavior** (sandbox above all) — each
  pass before the Nth re-opens the point for the next confirmation.

## Boundaries

- Batches are TEMPLATES, not live state — minting/emitting COPIES points;
  editing a batch never touches already-queued points.
- `attachments` (and any future attach/camera/GPS case) is
  navigate-then-do-by-hand by design: the actions land you on the page, the
  `summary` says what to attach. Don't pretend the grammar reaches it.
- `--mint` needs break-glass creds and hits production; `--to-request`,
  `--get`, `--extend`, `--shrink`, `--validate`, `--list` are all offline.
