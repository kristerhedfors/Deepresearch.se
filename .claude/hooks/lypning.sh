#!/bin/sh
# SessionStart: put a Python on PATH that does not cost 8.5 seconds to say hello.
#
# The interpreter itself is no longer in this repository. It was broken out to
# https://github.com/kristerhedfors/lypning — a mixture of three Pythons (a Rust
# subset, a MicroPython variant with a frozen stdlib, and real CPython) with a
# classifier that picks per program and a refusal contract (exit 90, one line on
# stderr, nothing on stdout) that makes a wrong pick cost one wasted spawn
# instead of a wrong answer. This hook's whole job is to use it when it is here.
#
# NEVER BLOCKS AND NEVER FAILS A SESSION. lypning is a convenience, not a
# dependency: a container without it must start exactly as fast and work exactly
# as well, so every path below prints the continue envelope and exits 0 —
# including its own failures. That rule is inherited from the hook it replaces
# and it is the reason this file has no `set -e`.

emit() { printf '{"continue":true,"suppressOutput":true}\n'; }

# Already installed? Say where, and stop — re-installing on every session start
# would cost more than the shim saves.
if command -v lypning >/dev/null 2>&1; then
    echo "lypning: $(command -v lypning)"
    lypning install --quiet 2>/dev/null || true
    emit
    exit 0
fi

echo "lypning: not installed — sessions use the system python3."
echo "  pip install lypning            # then restart the session"
echo "  https://github.com/kristerhedfors/lypning"
emit
exit 0
