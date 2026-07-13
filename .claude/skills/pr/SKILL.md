---
name: pr
description: >-
  Load when the user types "pr" (or "prep pr", "get this ready to merge", "ship
  it") — the one-word trigger that PREPARES the current feature branch for the
  merge-branches ("Merger") workflow: sync onto latest origin/main, regenerate
  the committed introspection artifacts if source changed, run npm test +
  typecheck, commit pending work, push the branch, and open a focused PR
  targeting main. Leaves everything ready for merge-branches (Step 4 tagging in
  docs/MERGED-BRANCHES.md) and the owner's merge. Companion to merge-branches
  (the reconciliation/merge half) and sync-main (the base-is-current half).
---

# pr — prepare the branch for the Merger

Typing **`pr`** means: *"take whatever I've done on this branch and get it fully
ready to be merged."* This skill is the deterministic pre-flight that produces a
clean, tested, pushed branch + a focused PR to `main`, so the
**merge-branches** skill (the "Merger") can take over: tag it in
`docs/MERGED-BRANCHES.md` and let the owner merge.

It does NOT merge. `main` is merge-only (see CLAUDE.md → Git workflow and the
merge-branches skill) — the owner merges the PR. `pr` gets everything to the
edge of that merge.

Run the steps in order and STOP at the first hard failure (report it; don't push
a red branch). Steps that only *maybe* apply are marked.

## Step 0 — barrier + base check (never skip)

```bash
git fetch origin main
# MERGE BARRIER: if docs/MERGE-STATUS.json is active AND this branch doesn't
# contain the recorded main_sha, you're on a stale/merged branch — STOP and
# tell the user to branch fresh off main (per CLAUDE.md's MERGE BARRIER).
git rev-parse --short HEAD origin/main
git log --oneline origin/main..HEAD    # what this PR will actually contain
```

- **Nothing ahead of `origin/main`?** There's no PR to make — tell the user and
  stop.
- **Behind/diverged from `origin/main`?** Rebase onto it first
  (`git rebase origin/main`); resolve conflicts before continuing. The
  sync-main skill covers the off-sync cases.
- **On a branch already tagged done in `docs/MERGED-BRANCHES.md`?** STOP — that
  branch is dead. Branch fresh off `main` and move the work there (merge-branches
  Step 5 rule). The `check-merged-branches.mjs` guard also catches this.

## Step 1 — regenerate committed artifacts IF tracked text changed (maybe)

The introspection snapshot walks **every git-tracked text file** (`bundle-source.mjs`
runs `git ls-files`), not just `src/`/`public/` — so a change to `CLAUDE.md`,
a `.claude/skills/*` file, or a `docs/*` file makes it stale just as a code
change does. If the diff touches ANY tracked text file (i.e. almost always,
excluding a pure binary/artifact-only change), rebuild both committed artifacts
IN THE SAME PR or `src/introspect.test.js`'s freshness checks fail:

```bash
# rebuild whenever any tracked text file changed (the common case).
# The snapshot excludes only lockfiles, generated fixtures, binaries, and
# itself — see bundle-source.mjs — so a code-free docs/skill edit still needs it.
npm run bundle && npm run bundle:rag   # source-snapshot.json + source-rag.json
```

Order matters: `bundle` first (snapshot), then `bundle:rag` (index refs the
snapshot). Never hand-edit those two JSON files. `bundle:rag` re-embeds only the
changed files' chunks via Berget, so it needs network + the embedding key; if
that's unavailable, the snapshot check still gates and the rag ref-check passes,
but flag it. The ONLY time you can skip Step 1 is a diff that touches no tracked
text file the snapshot indexes (e.g. binary assets only) — when unsure, rebuild:
it's cheap and the Step 2 freshness check will fail you if you guessed wrong.

> Editing this skill (or any tracked text) in Step 1 itself changes a snapshotted
> file — so run the bundle AFTER your last content edit, then commit the artifacts
> alongside it in Step 3.

## Step 2 — the green gate (never skip)

```bash
npm test          # node --test src/*.test.js public/js/*.test.js
npm run typecheck  # both tsconfigs, strict — must stay clean
```

Both must pass. Test failures or type errors mean the branch is NOT ready — fix
them (or report and stop). The freshness checks in `src/introspect.test.js` also
fire here, so a skipped Step 1 surfaces as a test failure, not a silent gap.

## Step 3 — commit pending work (maybe)

If `git status` shows uncommitted changes (including the regenerated artifacts),
commit them with a clear message describing the change — not "prep pr":

```bash
git add -A
git commit -m "<what changed and why>"
```

Do not amend or force-push already-pushed history unless the user asks. Keep the
model identifier out of the message (see the model-identity rule).

## Step 4 — push the branch (never skip)

```bash
git fetch origin main                       # re-fetch right before pushing
git push -u origin "$(git branch --show-current)"
```

On network failure retry up to 4× with exponential backoff (2s, 4s, 8s, 16s).
The "Unverified" badge on the pushed commits is EXPECTED here (no signing key in
these containers — CLAUDE.md documents it); do not try to fix it.

## Step 5 — open the PR to main (never skip)

Use the GitHub MCP tools (`mcp__github__create_pull_request`), base `main`, head
the feature branch. Check for a PR template first
(`.github/pull_request_template.md` / `PULL_REQUEST_TEMPLATE.md`); mirror its
sections if one exists, otherwise write a normal body: what changed, why, and how
it was verified (the test/typecheck results from Step 2). End the body with the
generated-with footer per the repo's PR convention.

One focused PR for this branch's change — don't bundle unrelated work.

## Step 6 — hand off to the Merger

Report to the user, in one message:

- the PR URL,
- the green test/typecheck status,
- that `main` is merge-only, so **the owner merges** (merge-branches Step 4/5).

Then offer to watch the PR (`subscribe_pr_activity`) for CI/review, and remind
that once it's merged the branch is DONE — new work starts on a fresh branch off
`main` (merge-branches ledger discipline).

## Guardrails

- `pr` PREPARES; it never merges or pushes to `main`.
- Never push a branch that failed Step 2 — a red PR wastes the owner's review.
- Never skip Step 1 when source changed; the freshness gate will fail the merge
  later even if you got lucky locally.
- Don't open a PR when nothing is ahead of `origin/main` (Step 0).
- Don't reopen work on a branch the ledger marks done — branch fresh.
