#!/bin/sh
# merge-barrier: the per-prompt / per-session check for the mass-reconciliation
# MERGE BARRIER (see CLAUDE.md → Git workflow and the merge-branches skill).
#
# docs/MERGE-STATUS.json carries a one-time flag: when `active` is true, the many
# pre-existing branches have been merged into `main` and are STALE. Any client
# whose current branch does not contain the recorded `main_sha` must sync to main
# and cut a NEW branch before doing work. This hook detects that state and prints
# an instruction; a session already branched off the reconciled main contains
# `main_sha`, so it stays SILENT. Fail-soft: never blocks, never errors the turn.
cd "$(git rev-parse --show-toplevel 2>/dev/null)" || exit 0

STATUS="docs/MERGE-STATUS.json"
[ -f "$STATUS" ] || exit 0

# Tiny dependency-free JSON field reads (the file is machine-written, one flat
# object, so a grep is enough and avoids requiring node/jq in the hook).
active=$(grep -o '"active"[[:space:]]*:[[:space:]]*true' "$STATUS")
[ -n "$active" ] || exit 0   # barrier cleared → nothing to do

main_sha=$(grep -o '"main_sha"[[:space:]]*:[[:space:]]*"[0-9a-f]*"' "$STATUS" | grep -o '[0-9a-f]\{7,40\}')
[ -n "$main_sha" ] || exit 0 # not finalized yet → don't nag

# Compliant if HEAD already contains the reconciled tip.
if git merge-base --is-ancestor "$main_sha" HEAD 2>/dev/null; then
  exit 0
fi

current=$(git rev-parse --abbrev-ref HEAD 2>/dev/null)
merged_at=$(grep -o '"merged_at"[[:space:]]*:[[:space:]]*"[^"]*"' "$STATUS" | sed 's/.*: *"//; s/"$//')
echo "=================== MERGE BARRIER ACTIVE ==================="
echo "A mass-reconciliation merge into main happened${merged_at:+ at $merged_at}."
echo "Your branch '$current' predates it (does not contain $main_sha) — it is STALE."
echo "Per CLAUDE.md: sync to main and CREATE A NEW BRANCH before making any change:"
echo "    git fetch origin main && git checkout -B <fresh-branch> origin/main"
echo "Do NOT keep working on '$current' — its history is already merged."
echo "==========================================================="
exit 0
