---
name: merge-branches
description: >-
  Load when reconciling the repo's many unmerged feature branches — "evaluate
  the unmerged branches", "integrate branch X", "which branches still have
  work", "is branch Y already in main" — or when touching
  docs/MERGED-BRANCHES.md (the branch ledger / merged-tag) or
  scripts/check-merged-branches.mjs (the rule-break guard). Covers: the
  PR-based workflow (main is merge-only now), how to tell a squash-superseded
  branch from one with genuinely-new content, integrating a candidate as a
  focused PR, TAGGING an integrated branch so other agents stop building on it,
  and the guard that NOTIFIES the owner when someone breaks that rule.
---

# merge-branches — reconciling unmerged branches

This repo accumulated **86 remote branches**, 76 of them not fast-forward-merged
into `main`. Most are *already shipped* — their features are in `main`, just
squash-merged so the commit SHAs differ. A handful carry small unique deltas
that never landed. This skill is how to tell them apart, integrate the real
candidates, and mark the done ones so no agent wastes a session rebuilding on a
dead branch.

Two artifacts back it:

- **`docs/MERGED-BRANCHES.md`** — the ledger. It IS the "merged" tag: a branch
  listed there with verdict Merged / Superseded / Dropped is done. Discoverable
  (it's a committed doc every agent can read) and machine-checkable (it records
  each branch's tip SHA).
- **`scripts/check-merged-branches.mjs`** — the guard. Reads the ledger, fetches
  current tips, and prints a `NOTIFY OWNER` banner (exit 1) if a done branch got
  new commits. This is the "see if anyone breaks the rule and notify me" half.

## The workflow is now PR-based (2026-07-13)

`main` is **merge-only**. Do NOT `git push origin main`. Every change:

```bash
git fetch origin main
git checkout -B <feature-branch> origin/main
# …work…
git add -A && git commit -m "…"
git push -u origin <feature-branch>
# open a PR targeting main; the OWNER merges
```

This reverses the old "push straight to main" rule (see CLAUDE.md → Git
workflow). The `claude/hello-world-deploy-rubr64` branch that documented the old
rule is **Dropped** in the ledger for that reason.

## Step 1 — inventory (already captured, refresh when stale)

```bash
for b in $(git branch -r --no-merged origin/main | grep -v HEAD | sed 's/ *//' | grep -v 'origin/main$'); do
  name=${b#origin/}; tip=$(git rev-parse --short $b)
  ahead=$(git rev-list --count origin/main..$b)
  printf "%-52s %-9s ahead=%s  %s\n" "$name" "$tip" "$ahead" "$(git show -s --format=%s $b | cut -c1-50)"
done
```

**`ahead` is NOT "unmerged content".** A branch cut months ago and squash-merged
shows a huge `ahead` (200+) because its whole original history is non-ancestor
to `main` — yet its content is fully in `main`. Conversely a fresh 1-commit
branch (`ahead=1`) is the likeliest to hold a genuinely-new delta. So: **big
ahead ⇒ probably superseded; small ahead ⇒ inspect.** Never trust `git diff
origin/main..branch` size either — it's dominated by `main` being ahead.

## Step 2 — classify each branch (content check, not graph position)

The only reliable test is *"is this branch's actual change already in `main`?"*:

- **Named feature present in `main`?** `git ls-tree origin/main -- <signature-file>`
  (e.g. `src/tokemon.js`, `src/shodan.js`). Present ⇒ **Superseded**.
- **The unique commit(s):** `git log origin/main..origin/<branch> --oneline` then
  `git show --stat origin/<branch> -1`. Read what it touches.
- **Is that specific change in `main`?** `git grep -n "<distinctive string>" origin/main -- <file>`.
  Present ⇒ Superseded; absent ⇒ real **candidate** (Review).
- **Conflicts with a later decision?** ⇒ **Dropped** (e.g.
  `server-secure-storage-clarity` wanted to remove the storage knobs that
  invariant 4 deliberately keeps).

Worked examples from the 2026-07-13 pass (all in the ledger's §1):
| Branch | Check | Verdict |
|---|---|---|
| `firefox-focus-auth-redirect` | `main` index.js:157 already forces https | Superseded |
| `tool-calling-visibility` | `main` chatlog.js:100 already logs shell calls | Superseded |
| `refactor-skill-repo` | `src/billing.js` absent from `main` | **Candidate** |
| `glass-pane-close-icon` | close-chevron markup absent from `main` | **Candidate** |
| `security-assessment-owasp-setup` | OWASP corpus absent from `main` | **Candidate** |

## Step 3 — integrate a candidate (one focused PR each)

```bash
git fetch origin main <branch>
git checkout -B integrate/<short-name> origin/main
git cherry-pick <the unique commit(s)>     # or hand-port if it won't apply
```

**Expect conflicts in the committed introspection artifacts** —
`public/introspect/source-snapshot.json` and `.../source-rag.json`. Do NOT
merge those by hand. Take `main`'s side, apply the real code change, then
regenerate:

```bash
npm run bundle && npm run bundle:rag
npm test            # freshness checks in src/introspect.test.js gate on this
npm run typecheck
```

Then push the branch and open a PR to `main`. The owner merges (do not
self-merge unless told to).

## Step 4 — TAG it done (so other agents stop using it)

The moment a branch's work is in `main`, mark it in the SAME commit as the
integration (or immediately after the merge):

1. Flip its row in `docs/MERGED-BRANCHES.md` to **Merged**, add it to §1 with
   `tip@merge` = the branch tip you integrated.
2. (Optional, belt-and-suspenders) a git tag:
   `git tag merged/<branch> <branch-tip> && git push origin merged/<branch>`.
3. Commit + PR the ledger change.

The ledger entry is the load-bearing tag — agents read the repo, not the tag
namespace. Recording `tip@merge` is what lets the guard catch later violations.

## Step 5 — detect rule-breaks + notify the owner

The rule: **a Merged / Superseded / Dropped branch is dead — no new commits, no
new PRs from it.** The guard enforces it:

```bash
node scripts/check-merged-branches.mjs          # exit 0 clean, exit 1 = violation
MERGED_LEDGER=/path/to/ledger.md node scripts/check-merged-branches.mjs   # test override
```

It fetches each done branch's current tip and compares to the recorded SHA. If a
tip **advanced past** the recorded one, someone kept working on a finished
branch → it prints a `NOTIFY OWNER (krister.hedfors@gmail.com)` banner naming
the branch and the SHAs. When it fires: **surface it to the owner** (say which
branch moved and that the rule was broken) — do not silently re-tag or keep
building on it; that branch's new work belongs on a fresh branch off `main`.

Run it at session start (wire it into `.claude/hooks/sync-main.sh` if you want
it automatic) and before any branch reconciliation. A deleted branch is fine
(it's gone); an unchanged tip is fine; only an advanced/rewritten tip is a
violation.

## Guardrails

- Don't bulk-open PRs for all 76 branches. Most are Superseded; only the §2
  candidates warrant a PR, and the owner prioritises which.
- Don't assert Superseded from `ahead` alone — content-check first (Step 2).
- Keep the ledger honest: `Superseded?` (with the `?`) means heuristic,
  unverified. Promote to `Superseded` only after the content check.
- Never force-push or delete a remote branch to "clean up" without owner
  sign-off — the ledger is the cleanup, not deletion.
