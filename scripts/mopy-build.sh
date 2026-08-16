#!/usr/bin/env bash
# Build mopy — Mixture of Pythons.
#
# The default target is STATIC MUSL, and that is not a preference. Measured on
# this container, `-c 'pass'`, min of 30:
#
#     glibc, dynamically linked   1.33 ms   5 file opens
#     musl, static                0.24 ms   0 file opens
#     pygram (musl, static)       0.21 ms   0 file opens
#
# Cold cost in the CheerpX sandbox tracks bytes and file opens and nothing else
# (docs/PYGRAM.md §1), so the dynamic loader's five opens are the whole gap. A
# dynamically linked mopy is 5.5x slower to start than a static one and gives
# back most of what the runtime won.
#
# Usage:
#   bash scripts/mopy-build.sh                # host musl (x86_64) — what the bench uses
#   bash scripts/mopy-build.sh --target i686  # the CheerpX sandbox target
#   bash scripts/mopy-build.sh --glibc        # the control, for the measurement above
#   bash scripts/mopy-build.sh --all

set -euo pipefail
cd "$(dirname "$0")/.."

bold() { printf '\033[1m%s\033[0m\n' "$*"; }

targets=()
while [ $# -gt 0 ]; do
  case "$1" in
    --target) targets+=("$2"); shift 2 ;;
    --glibc) targets+=("glibc"); shift ;;
    --all) targets+=("x86_64" "i686" "glibc"); shift ;;
    -h|--help) sed -n '2,22p' "$0"; exit 0 ;;
    *) echo "mopy-build: unknown option $1" >&2; exit 2 ;;
  esac
done
[ ${#targets[@]} -gt 0 ] || targets=("x86_64")

if ! command -v cargo >/dev/null; then
  echo "mopy-build: cargo not found. Install Rust: https://rustup.rs" >&2
  exit 1
fi

for t in "${targets[@]}"; do
  case "$t" in
    glibc)
      bold "==> mopy: host glibc (the dynamic-linking control)"
      cargo build --manifest-path mopy/Cargo.toml --release
      out=mopy/target/release/mopy
      ;;
    x86_64|i686)
      triple="${t}-unknown-linux-musl"
      if ! rustup target list --installed | grep -qx "$triple"; then
        bold "==> installing rust std for $triple"
        rustup target add "$triple"
      fi
      bold "==> mopy: $triple (static)"
      cargo build --manifest-path mopy/Cargo.toml --release --target "$triple"
      out="mopy/target/$triple/release/mopy"
      ;;
    *) echo "mopy-build: unknown target $t" >&2; exit 2 ;;
  esac

  size=$(stat -c %s "$out")
  bold "    $out — $size bytes"

  # The two shape checks the pygram gate taught us to make. Neither is a
  # substitute for conformance; both catch a regression conformance cannot see.
  if [ "$t" != "glibc" ]; then
    if file "$out" | grep -qv "statically linked\|static-pie"; then
      : # `file` wording varies by version; the open count below is the real test
    fi
    if command -v strace >/dev/null; then
      opens=$(strace -f -e trace=openat,open "$out" -c 'pass' 2>&1 | grep -cE '(openat|open)\(' || true)
      bold "    file opens on -c 'pass': $opens"
      if [ "$opens" != "0" ]; then
        echo "    WARNING: a static build should open nothing at startup." >&2
      fi
    fi
    # 131,072 B is CheerpX's device block; cold cost is a step function in it,
    # so the block count is the number that matters, not the byte count.
    blocks=$(( (size + 131071) / 131072 ))
    bold "    CheerpX device blocks (131,072 B each): $blocks"
  fi

  # The exit-90 contract, pinned here the way scripts/pygram-build.sh pins
  # pygram's — it has only ever broken silently.
  set +e
  "$out" -c 'import subprocess' >/dev/null 2>/tmp/mopy-smoke.$$
  rc=$?
  set -e
  if [ "$rc" != "90" ] || ! grep -q '^mopy: unsupported: module: import subprocess$' /tmp/mopy-smoke.$$; then
    echo "    FAIL: the unsupported contract is broken (exit $rc)" >&2
    cat /tmp/mopy-smoke.$$ >&2
    rm -f /tmp/mopy-smoke.$$
    exit 1
  fi
  rm -f /tmp/mopy-smoke.$$
  # …and that the refusal line goes to STDERR. pygram once wrote its
  # tracebacks to stdout and poisoned every `… | wc -l` pipeline while the exit
  # code still looked right (the pygram skill §5).
  if [ -n "$("$out" -c 'import subprocess' 2>/dev/null)" ]; then
    echo "    FAIL: the refusal line reached stdout" >&2
    exit 1
  fi
done

cat <<EOF

next:
    node tests/mopy/conformance.mjs          # three engines + routing safety
    node tests/mopy/conformance.mjs --plan   # what to build next in mopy
    node scripts/mopy-bench.mjs              # the four-arm benchmark
EOF
