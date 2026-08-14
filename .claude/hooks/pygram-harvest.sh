#!/bin/sh
# pygram-capture: Stop hook — persist the session's captures before teardown.
#
# WHY THIS EXISTS. The capture log lives at $HOME/.pygram/invocations.jsonl,
# which is OUTSIDE the repository, and these containers are ephemeral. Capture
# itself worked from the day it shipped — but nothing ever moved the log into
# the tree, so every session's evidence died with its container. The corpus was
# committed exactly once (b07654c1) and had not grown since: 197 programs, all
# first seen inside one 36-minute window. This hook closes that gap by folding
# the log into tests/pygram/corpus.jsonl at the end of every session.
#
# It does NOT commit. A hook that writes to the index would fight the session's
# own git work and could smuggle content into an unrelated PR. It leaves the
# corpus dirty in the working tree, which is visible in `git status` and is the
# session's (or the next PR's) call to make.
#
# SAFE TO RE-RUN: harvest.mjs derives every count from stable sighting keys
# rather than incrementing, so running it twice over the same inputs produces a
# byte-identical corpus. Firing on every Stop is therefore idempotent, and a
# session that ran no python leaves the file untouched.
#
# It NEVER blocks and NEVER fails the session: it prints {"continue":true} and
# exits 0 on every path, including its own failures.
#
# Environment:
#   PYGRAM_LOG        log path (default $HOME/.pygram/invocations.jsonl)
#   PYGRAM_CAPTURE=0  disable capture entirely (this hook then does nothing)
#   PYGRAM_HARVEST=0  keep capturing, but never harvest automatically
ok() {
  printf '{"continue":true,"suppressOutput":true}\n'
  exit 0
}

[ "${PYGRAM_CAPTURE:-1}" = "0" ] && ok
[ "${PYGRAM_HARVEST:-1}" = "0" ] && ok

# Stop fires on every turn boundary, so the no-work path must be cheap. Bail
# before spawning node when there is no log to fold in — the overwhelmingly
# common case in a session that never touched python. (Transcripts are the
# harvester's other input, but they only matter alongside a log or an existing
# corpus, and re-scanning them on a python-free session buys nothing.)
LOG="${PYGRAM_LOG:-$HOME/.pygram/invocations.jsonl}"
[ -s "$LOG" ] || ok

command -v node >/dev/null 2>&1 || ok
[ -n "$CLAUDE_PROJECT_DIR" ] || ok
[ -f "$CLAUDE_PROJECT_DIR/scripts/pygram-capture/harvest.mjs" ] || ok

# --quiet keeps the transcript clean; the summary line still names what changed.
# stdout is redirected to stderr so hook output can never be mistaken for the
# hook's JSON protocol response, which must be the only thing on stdout.
node "$CLAUDE_PROJECT_DIR/scripts/pygram-capture/harvest.mjs" --quiet >&2 2>&1 || true

ok
