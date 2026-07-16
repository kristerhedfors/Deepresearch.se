---
name: request-testing
description: >-
  Load when a WORKER session finishes a feature or fix and wants specific
  things tried by the owner on the live site — "queue these for the owner to
  test", "request testing for this feature", "I want this confirmed twice on
  device" — the producer side of the test-feedback loop. Covers the
  docs/test-requests/<branch>.json file a worker commits INSIDE its PR (the
  git transport — no admin credentials needed), the point format incl.
  runs:N repeat confirmations, offline validation (scripts/test-requests
  --validate), and what comes back: each verdict lands as a COMMENT on your
  PR (stay subscribed — that comment is your wake-up and your regression
  report). Companion to test-feedback-loop (the loop that mints and syncs)
  and testable-interaction-points (the queue mechanics + action grammar).
---

# Request testing — ship your test cases inside your PR

## What this is

You built a feature on a branch and want the owner to try specific things on
the live site — once, or several times (flaky/device-dependent behavior).
You do NOT call the admin API, and you do NOT need credentials. You commit a
**test-request file inside your PR**, and the plumbing does the rest:

```
 YOU (worker)                         THE LOOP (test-feedback-loop)         THE OWNER
 ────────────                         ─────────────────────────────         ─────────
 write docs/test-requests/            after your PR MERGES:                 taps /try/<id>,
   <branch-slug>.json                   --mint → live queue points,         records 👍/👎/❓
 validate offline                       ids stamped back + committed          + note
 push; open PR; STAY SUBSCRIBED         --sync each tick → verdict
                                        stamped into your file (git =
                                        the ledger) AND posted as a
                                        COMMENT ON YOUR PR ──────────────►  you wake up
```

A 👎 comment (or a 👍 whose note carries a complaint — read it fully) is your
regression report: fix on a fresh branch off the updated `main`, and include
a new request file for the re-test if what-to-check changed; otherwise the
loop re-opens the original point once your fix merges.

A ❓ comment means UNTESTABLE — the owner never reached a state where your
feature could be tried, or didn't understand what to do. The note is a
question on the point's clarification thread; the loop answers it (and fixes
the point's target/actions when the scene was broken) and re-opens the point.
If the answer needs YOUR knowledge, the loop's PR comment will ask — reply
with what the tester should do, and write the next request file's `summary`
so it can't happen again (exact steps, exact pass criterion).

## Declaring a request

One file per branch: `docs/test-requests/<branch-slug>.json` (slug = branch
with `/` → `-`). One file per branch means parallel workers never conflict.

**Fastest start — seed from a standard batch.** If your feature touches a
pipeline case that already has a batch (`scripts/test-batch --list` — the
**test-batches** skill), generate the file and trim it to your change:
`scripts/test-batch --to-request <case> <your-branch> --pr <n>`. Then edit
down to the points your PR actually affects and add any feature-specific ones.

```json
{
  "branch": "claude/your-branch-name",
  "pr": null,
  "requested_at": "2026-07-15",
  "points": [
    {
      "label": "Short queue label",
      "summary": "What changed + the EXACT pass criterion (and what would be a fail).",
      "target": "/rver",
      "actions": [ { "type": "compose", "text": "…" } ],
      "runs": 1,
      "minted_id": null,
      "verdicts": []
    }
  ]
}
```

- `branch` (required) — how the loop finds your PR to comment on. `pr` may
  stay `null`; the loop resolves and stamps it.
- `points[]` — each entry is a full try-it queue point: `label`, `summary`,
  `target`, `actions` per the **testable-interaction-points** ACTION GRAMMAR.
  The validator is the REAL one the admin API runs, so what validates here
  mints verbatim.
- `runs` (default 1, max 10) — how many confirmations you want. Each 👍
  before the Nth re-opens the point; use for anything device- or
  timing-dependent ("confirm twice: once in a tab, once in the PWA" — say so
  in the summary).
- `minted_id` / `verdicts` / `done` — leave as `null`/`[]`/absent; the loop
  stamps them. Your file's git history becomes the audit trail of what was
  tested and what came back.

Authoring rules (the test-feedback-loop skill's round-1 lessons apply):
state the exact expected behavior in the `summary` — including "and nothing
else" when side-chatter would be a failure; no trigger words (hostnames,
"quiz me", street names) in `compose` text unless testing that gate; prefer
prefill over `send:true`; ask for the research-debug JSON in the note when
the point probes pipeline behavior.

## Before you push

```bash
scripts/test-requests --validate   # the API's own validator, offline
scripts/test-requests --pending    # what the loop will see
```

A file that fails validation will not mint — fix it before the PR, not
after. Then push, open the PR, and **subscribe to it**
(`subscribe_pr_activity`, the standing owner directive) — the verdict
comments are useless if nobody is listening for them.

## What you'll receive on the PR

One comment per verdict, from the loop:
`👍/👎/❓ "<label>" (queue #<id>, <k>/<runs>)` plus the owner's note verbatim —
notes routinely carry the full research-debug JSON, i.e. a complete
diagnosis. Treat any complaint in ANY verdict as actionable, pass or fail;
only 👍 passes count toward `runs`.

## Boundaries

- **Mint happens at merge**, not at push — points test the DEPLOYED site, and
  push-to-main is the deploy. Don't expect queue traffic while the PR is open.
- The loop owns `--mint`/`--sync` and the file stamps; don't run those from a
  worker session or hand-edit stamped fields.
- Everything the ACTION GRAMMAR can't reach is
  navigate-then-do-by-hand prose in the `summary` — see
  **testable-interaction-points** for the exact boundary.
