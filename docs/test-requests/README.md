# Test requests — a worker's test cases, shipped inside its PR

A worker that builds a feature and wants the owner to try things adds ONE
file here — `<branch-slug>.json`, committed on its feature branch, riding its
PR. That is the whole submission: communication happens over git, the worker
needs no admin credentials, and parallel workers never conflict (one file per
branch).

After the PR merges, the **test-feedback loop** mints each point into the
live try-it queue (`scripts/test-requests --mint`), the owner tests from
their phone, and the loop syncs each verdict back (`--sync`): stamped into
this file (git is the ledger) AND posted as a comment on the owning PR —
which wakes the subscribed author-worker. Verdicts are 👍 pass / 👎 fail /
❓ untestable. A 👎 comment is the worker's regression report; the follow-up
fix re-opens the point. A ❓ means the owner never reached a state where the
feature could be tried (or didn't understand what to do) — the note is a
question on the point's clarification thread, which the loop answers
(`scripts/testpoints --reply`) before re-opening the point.

A point with `"runs": N` asks for N confirmations (flaky or device-dependent
behavior): each 👍 before the Nth re-opens the point for the next round
(only 👍 passes count toward `runs`).

Format, authoring rules, and the full lifecycle: the **request-testing**
skill (worker side) and the **test-feedback-loop** skill (loop side).
Validate before committing — it runs the SAME validator the admin API applies:

```bash
scripts/test-requests --validate
```

Fully-done files are moved to `archive/` by the loop.
