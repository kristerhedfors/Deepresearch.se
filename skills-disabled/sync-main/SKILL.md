---
name: sync-main
description: >-
  Load at the START of every session, before implementing anything — new
  sessions are routinely off-sync with origin/main (fresh containers,
  stale clones, branches cut from an old base). Covers the mandatory
  fetch-latest-main-first rule, the SessionStart hook that automates it
  (.claude/hooks/sync-main.sh), what to do when the hook reports a
  behind/diverged branch, and how to verify the base is current before
  touching code.
---

# Sync with origin/main before implementing

**The rule (explicit product instruction, 2026-07-11): always pull the
latest `origin/main` BEFORE starting any implementation work.** New
sessions are always off-sync — the remote container clones at session
creation, feature branches get cut from whatever the clone happened to
contain, and by the time work starts, `main` has usually moved (this
project pushes straight to `main` many times a day).

## The automated path (normally you do nothing)

`.claude/settings.json` registers a **SessionStart hook** that runs
`.claude/hooks/sync-main.sh` when a session begins. It:

1. `git fetch origin main` (quiet; degrades to a warning offline).
2. Keeps the local `main` REF current (`git fetch origin main:main`
   when on a feature branch; `merge --ff-only` when on main) so
   `git log main..HEAD` comparisons stay honest.
3. If the current branch is **behind and has no commits of its own**
   (clean tree): fast-forwards it to `origin/main` automatically.
4. If the branch is behind but **has its own commits**: prints a loud
   `WARNING` telling you to `git rebase origin/main` — it never rebases
   for you, because that can conflict.

Read the hook's output at session start. If it printed a WARNING, deal
with it BEFORE implementing, not after.

## The manual path (hook missing, failed, or mid-session staleness)

```bash
git fetch origin main
git rev-list --count HEAD..origin/main   # >0 means you are stale
# no local commits yet:
git rebase origin/main                    # trivially fast-forwards
# local commits exist:
git rebase origin/main                    # replay them on the new base
```

Long-running sessions go stale too: **re-fetch before every push** and
after any pause measured in hours. A push rejected as non-fast-forward
means main (or the remote branch) moved — fetch and rebase, don't
force-push over it.

## Why this matters here specifically

- The normal workflow pushes **straight to `main`** (see CLAUDE.md), so
  main advances constantly; a branch cut yesterday conflicts today.
- Deploys are git-connected to `main` (see the **deploy** skill) — code
  reviewed against a stale base can look correct and still break the
  merge result that actually deploys.
- Sessions on feature branches (remote/web sessions get a designated
  `claude/…` branch) must still BASE that branch on the latest main:
  `git checkout -B <branch> origin/main` when the branch has no unique
  commits yet, `git rebase origin/main` when it does.
