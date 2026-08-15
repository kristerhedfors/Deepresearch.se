#!/bin/sh
# pygram-capture: Stop hook — persist the session's captures before teardown.
#
# WHY THIS EXISTS. The capture log lives at $HOME/.pygram/invocations.jsonl,
# which is OUTSIDE the repository, and these containers are ephemeral. Capture
# itself worked from the day it shipped — but nothing ever moved the log into
# the tree, so every session's evidence died with its container. The corpus was
# committed exactly once (b07654c1) and had not grown since: 197 programs, all
# first seen inside one 36-minute window.
#
# WHAT IT WRITES, AND WHY NOT THE CORPUS (revised 2026-08-14). This hook first
# folded the log into tests/pygram/corpus.jsonl, and that still lost the data.
# corpus.jsonl is ONE file that every session rewrites, so two branches touching
# it conflict by construction, and the merge was never worth it to a session
# whose PR was about something else. Measured over the 19 branches cut since the
# corpus landed: 2 carried any growth, and neither reached main — 17 sessions'
# python was captured, harvested, and thrown away.
#
# So it now publishes tests/pygram/sightings/<session>.jsonl instead: one writer
# per path, an ADDED file rather than a rewritten one, no possible conflict with
# another branch. The corpus is derived from those files by
# `npm run pygram:harvest`, which no longer has to be run by every session.
#
# It does NOT commit — a hook that makes commits would fight the session's own
# git work. The staging is left to .githooks/pre-commit, which adds only this
# one directory and only to a commit the session was making anyway.
#
# SAFE TO RE-RUN: the export is a union by sighting key, so running it twice
# over the same inputs produces a byte-identical file and does not touch it.
# Firing on every Stop is therefore idempotent, and a session that ran no python
# writes nothing at all.
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

# --export publishes the per-session sightings file and stops; it never writes
# the corpus. --quiet keeps the transcript clean — the one summary line is
# printed only when a file actually changed. stdout is redirected to stderr so
# hook output can never be mistaken for the hook's JSON protocol response, which
# must be the only thing on stdout.
node "$CLAUDE_PROJECT_DIR/scripts/pygram-capture/harvest.mjs" --export --quiet >&2 2>&1 || true

ok
