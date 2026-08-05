#!/usr/bin/env bash
# The supervised `wrangler dev` that the e2e suite runs against.
#
# Playwright's `webServer` has no restart-on-exit, and `wrangler dev` exits on
# its own several times per CI run (see docs/MAINTENANCE-OWNERS.md, the row
# "CI's e2e job — the wrangler dev server staying up"). PR #365 wrapped it in a
# restart loop; this file is that loop, moved out of a config string so it can
# be read, run and timed on its own.
#
# WHY THE RESTART HAS TO BE FAST (measured 2026-08-05, occurrence 11,
# run 30988531735, verbatim from the job log):
#
#   08:31:28.244  [e2e] wrangler dev exited (1) — restarting
#   08:31:30.582  ✘ 64 ui.spec.js:164 … (1.1s)
#   08:31:32.759  ✘ 65 ui.spec.js:164 (retry #1) (1.3s)
#   08:31:33.237  [wrangler:info] Ready on http://localhost:8787
#
# The supervisor DID bring the port back — 0.48 s after Playwright had already
# spent the one retry on it. So the retry #365 added was never insufficient; it
# was spent INSIDE the outage window. Every occurrence since has that shape: the
# crash is wrangler's own (a transient loopback drop that its ProxyController
# escalates to a process-ending fatal), and what turns it into a red build is
# the length of the gap, not the crash.
#
# The 5.0 s gap measured there is mostly ours: ~2.0 s of the loop's own sleep
# and ~1.2 s of `npx` re-resolving a package already sitting in the cache
# (measured on a 4-vCPU machine: 2.8 s through `npx`, 1.7 s exec'ing the
# resolved entry point directly). Only the remaining ~1.8 s is wrangler
# starting. This script removes our share:
#
#   - the restart delay is 0.2 s — enough that a wrangler which cannot boot at
#     all does not spin the CPU, far too short to matter to a restart;
#   - `npx` runs ONCE, before the loop, purely to populate the cache; the loop
#     then execs the resolved entry point with `node`. Resolution failure is not
#     fatal — it falls back to plain `npx`, which is exactly the old behaviour.
#
# Measured end to end (kill the supervised wrangler, poll until the port answers
# again; 4 vCPU, same box and same wrangler both ways): 6049 / 6117 ms before,
# 3597 / 3188 ms after. The margin that buys is real but thin — scaled onto
# occurrence 11 the outage becomes ~2.8 s against a retry that navigated ~3.2 s
# in, so a 0.48 s loss turns into roughly a 0.4 s win. It gives the retry its
# chance back; it does not make the failure impossible.
#
# Neither change hides a Worker that cannot start: that still restarts in a loop
# and Playwright still times out on `webServer.url`, which is the behaviour the
# config comment has always promised.
set -uo pipefail

VERSION="${WRANGLER_VERSION:-4.118.0}"
PORT="${E2E_PORT:-8787}"
# Kept small on purpose, and asserted by tests/dev-server.test.js. Raising it
# re-opens the failure this file exists to close.
RESTART_DELAY_S="${E2E_RESTART_DELAY_S:-0.2}"
SPEC="wrangler@${VERSION}"

# Repo root — this file lives in tests/.
cd "$(dirname "${BASH_SOURCE[0]}")/.." || exit 1

ARGS=(dev -c wrangler.dev.toml --local --enable-containers=false --port "${PORT}")

# Populate the npx cache once and resolve the entry point out of it, so a
# restart is a plain `node <file>` rather than another package resolution.
resolve_bin() {
  local cache bin pkg found=""
  npx --yes "${SPEC}" --version >/dev/null 2>&1 || return 1
  cache="$(npm config get cache 2>/dev/null)" || return 1
  [ -n "${cache}" ] && [ "${cache}" != "undefined" ] || return 1
  for bin in "${cache}"/_npx/*/node_modules/wrangler/bin/wrangler.js; do
    [ -f "${bin}" ] || continue
    pkg="$(dirname "$(dirname "${bin}")")/package.json"
    # Only accept the pinned version: the cache can hold several.
    grep -q "\"version\": *\"${VERSION}\"" "${pkg}" 2>/dev/null && found="${bin}"
  done
  [ -n "${found}" ] || return 1
  printf '%s' "${found}"
}

# E2E_WRANGLER_BIN is the offline seam the unit test drives the loop through;
# set it and no package resolution happens at all.
BIN="${E2E_WRANGLER_BIN:-}"
[ -n "${BIN}" ] || BIN="$(resolve_bin || true)"

if [ -n "${BIN}" ]; then
  echo "[e2e] wrangler ${VERSION} resolved to ${BIN}" >&2
  RUN=(node "${BIN}")
else
  echo "[e2e] no cached wrangler ${VERSION} to exec directly; falling back to npx" >&2
  RUN=(npx --yes "${SPEC}")
fi

while true; do
  "${RUN[@]}" "${ARGS[@]}"
  code=$?
  echo "[e2e] wrangler dev exited (${code}) — restarting" >&2
  sleep "${RESTART_DELAY_S}"
done
