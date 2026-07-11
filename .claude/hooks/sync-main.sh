#!/bin/sh
# sync-main: run at session start so work NEVER begins from a stale base.
# New remote sessions routinely start off-sync with origin/main (observed
# repeatedly; explicit product instruction 2026-07-11) — this hook fetches
# the latest main and fast-forwards when that is safe, or prints a loud
# warning when it is not.
cd "$(git rev-parse --show-toplevel 2>/dev/null)" || exit 0

if ! git fetch --quiet origin main 2>/dev/null; then
  echo "sync-main: could not fetch origin/main (network?) — verify branch freshness manually before implementing"
  exit 0
fi

current=$(git rev-parse --abbrev-ref HEAD)

# Keep the local main REF current even when working on a feature branch,
# so `git log main..` style comparisons aren't lying.
if [ "$current" = "main" ]; then
  if [ -z "$(git status --porcelain)" ]; then
    git merge --ff-only origin/main >/dev/null 2>&1 \
      || echo "sync-main: local main has DIVERGED from origin/main — resolve manually"
  fi
else
  git fetch --quiet origin main:main 2>/dev/null || true
fi

behind=$(git rev-list --count HEAD..origin/main 2>/dev/null || echo "?")
ahead=$(git rev-list --count origin/main..HEAD 2>/dev/null || echo "?")

if [ "$behind" = "0" ]; then
  echo "sync-main: $current is up to date with origin/main (ahead by $ahead)"
elif [ "$ahead" = "0" ] && [ -z "$(git status --porcelain)" ]; then
  # Pure fast-forward: no local commits, clean tree — safe to move up.
  git reset --hard origin/main >/dev/null
  echo "sync-main: fast-forwarded $current to origin/main (was $behind behind)"
else
  echo "sync-main: WARNING — $current is $behind commit(s) BEHIND origin/main (and $ahead ahead)."
  echo "sync-main: rebase before implementing: git rebase origin/main"
fi
