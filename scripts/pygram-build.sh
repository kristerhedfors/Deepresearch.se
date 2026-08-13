#!/usr/bin/env bash
#
# Build pygram: a stripped, statically linked, i386 Python-subset runtime for
# the in-browser CheerpX sandbox. See docs/PYGRAM.md for why it exists and
# docs/PYGRAM-RESEARCH.md for why it is built this way.
#
#   bash scripts/pygram-build.sh              # → pygram/build/pygram
#   bash scripts/pygram-build.sh --clean      # discard the work dir first
#   bash scripts/pygram-build.sh --verify     # build, then run the gates
#
# From scratch this takes a few minutes, almost all of it musl and the first
# MicroPython compile. Both are cached in pygram/.build, so a rebuild after
# editing the variant or pygram/lib is seconds.
#
# NETWORK is needed exactly once, for two downloads, both pinned by version and
# both verified: the musl source tarball (by SHA-256) and the MicroPython git
# tag (by commit SHA). Nothing floats on `master`.
#
# WHY THIS SHAPE, and not the obvious alternatives — every one of these was
# tried in the container this runs in (docs/PYGRAM-RESEARCH.md §6 item 4):
#
#   - Docker: no daemon available.
#   - musl-cross-make: needs a full GCC bootstrap, which is long and pointless
#     once `gcc -m32` exists.
#   - Ubuntu's musl-tools: x86_64 only. Its -m32 mode cannot work, because the
#     package contains no 32-bit musl libc.
#   - A prebuilt i686-linux-musl toolchain: means trusting a third-party binary.
#   - tcc: x86_64 only here, and has no i386 crt files.
#   - glibc-static: 635,744 B for an empty main() against musl's 13,020, and
#     /usr/lib32/libm.a does not even resolve fmod. It would blow the 700 KB
#     gate before a line of interpreter existed.
#
# Building musl from source with the host gcc's -m32 takes under a minute and
# needs no root, so that is what this does.

set -euo pipefail

# --------------------------------------------------------------------------
# Pinned inputs. Changing either of these is a deliberate act: re-run the
# gates and the conformance battery, and expect the port patch to need a
# rebase.
# --------------------------------------------------------------------------
MUSL_VERSION="1.2.5"
MUSL_SHA256="a9a118bbe84d8764da0ea0d28b3ab3fae8477fc7e4085d90102b8596fc7c75e4"
MUSL_URL="https://musl.libc.org/releases/musl-${MUSL_VERSION}.tar.gz"

# v1.28.0, the newest MicroPython RELEASE tag. The research pass measured
# against a 1.29.0-preview commit; a tag is pinned here instead, because a
# preview moves and the whole point of the variant is that tracking upstream
# stays a rebase we choose to do.
MPY_TAG="v1.28.0"
MPY_COMMIT="e0e9fbb17ed6fd06bb76e266ae554784c9c80804"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PYGRAM_DIR="$REPO_ROOT/pygram"
WORK="${PYGRAM_WORK:-$PYGRAM_DIR/.build}"
OUT="$PYGRAM_DIR/build/pygram"

MUSL_PREFIX="$WORK/musl-i386"
MPY_DIR="$WORK/micropython"
VARIANT_DEST="$MPY_DIR/ports/unix/variants/pygram"
JOBS="$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 4)"

DO_CLEAN=0
DO_VERIFY=0
for arg in "$@"; do
    case "$arg" in
        --clean) DO_CLEAN=1 ;;
        --verify) DO_VERIFY=1 ;;
        -h|--help) sed -n '2,40p' "${BASH_SOURCE[0]}"; exit 0 ;;
        *) echo "pygram-build: unknown option $arg" >&2; exit 2 ;;
    esac
done

say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
die() { printf '\npygram-build: %s\n' "$*" >&2; exit 1; }

# --------------------------------------------------------------------------
# 0. Host requirements
# --------------------------------------------------------------------------
for tool in gcc make git python3 tar; do
    command -v "$tool" >/dev/null 2>&1 || die "missing required tool: $tool"
done
if command -v curl >/dev/null 2>&1; then
    FETCH=(curl -fsSL -o)
elif command -v wget >/dev/null 2>&1; then
    FETCH=(wget -q -O)
else
    die "need curl or wget to download the musl tarball"
fi

# The 32-bit host toolchain. Without it there is no i386 target at all, and the
# apt package name is the single most useful thing this script can say.
if ! echo 'int main(void){return 0;}' | gcc -m32 -x c - -o /dev/null 2>/dev/null; then
    die "gcc cannot target i386. Install the multilib toolchain:
    sudo apt-get update && sudo apt-get install -y gcc-multilib libc6-dev-i386"
fi

if [ "$DO_CLEAN" = 1 ]; then
    say "Clean: removing $WORK"
    rm -rf "$WORK" "$PYGRAM_DIR/build"
fi
mkdir -p "$WORK/dl" "$PYGRAM_DIR/build"

# --------------------------------------------------------------------------
# 1. musl for i386, from source, cached
# --------------------------------------------------------------------------
if [ -f "$MUSL_PREFIX/lib/libc.a" ] && [ -x "$MUSL_PREFIX/bin/musl-gcc" ]; then
    say "musl $MUSL_VERSION: cached"
else
    say "musl $MUSL_VERSION: building for i386 (about a minute)"
    TARBALL="$WORK/dl/musl-${MUSL_VERSION}.tar.gz"
    if [ ! -f "$TARBALL" ]; then
        "${FETCH[@]}" "$TARBALL" "$MUSL_URL"
    fi
    echo "$MUSL_SHA256  $TARBALL" | sha256sum -c - >/dev/null \
        || die "musl tarball checksum mismatch — refusing to build against it"

    rm -rf "$WORK/musl-${MUSL_VERSION}" "$MUSL_PREFIX"
    tar -xzf "$TARBALL" -C "$WORK"
    (
        cd "$WORK/musl-${MUSL_VERSION}"
        # TRAP 1 (cost a build): --target=i386 makes musl look for `i386-ar` and
        # `i386-ranlib`, which do not exist. It must be i686, AND the tools have
        # to be named explicitly. docs/PYGRAM-RESEARCH.md §2.1.
        ./configure --prefix="$MUSL_PREFIX" --target=i686 \
            CC="gcc -m32" AR=ar RANLIB=ranlib >"$WORK/musl-configure.log" 2>&1 \
            || { tail -20 "$WORK/musl-configure.log"; die "musl configure failed"; }
        make -j"$JOBS" >"$WORK/musl-make.log" 2>&1 \
            || { tail -20 "$WORK/musl-make.log"; die "musl build failed"; }
        make install >>"$WORK/musl-make.log" 2>&1 \
            || { tail -20 "$WORK/musl-make.log"; die "musl install failed"; }
    )

    # TRAP 2 (cost a build): the musl-gcc wrapper musl generates does not pass
    # -m32 through to the linker's emulation, so the link dies with
    # "skipping incompatible .../libc.a". -Wl,-m,elf_i386 is the fix.
    cat >"$MUSL_PREFIX/bin/musl-gcc" <<EOF
#!/bin/sh
exec gcc -m32 "\$@" -Wl,-m,elf_i386 -specs "$MUSL_PREFIX/lib/musl-gcc.specs"
EOF
    chmod +x "$MUSL_PREFIX/bin/musl-gcc"
fi

# Prove the toolchain before spending minutes on the interpreter: a static
# hello that is 13 KB, not 636 KB, is the whole reason musl is here.
FLOOR_C="$WORK/floor.c"
printf 'int main(void){return 0;}\n' >"$FLOOR_C"
"$MUSL_PREFIX/bin/musl-gcc" -Os -static -o "$WORK/floor" "$FLOOR_C" \
    || die "the musl-i386 wrapper cannot link a static binary"
strip "$WORK/floor"
FLOOR_BYTES="$(stat -c %s "$WORK/floor")"
echo "    static i386 floor: ${FLOOR_BYTES} B (glibc-static would be ~635,744)"
[ "$FLOOR_BYTES" -lt 100000 ] || die "static floor is ${FLOOR_BYTES} B — this is not linking against musl"

# --------------------------------------------------------------------------
# 2. MicroPython at a pinned tag
# --------------------------------------------------------------------------
if [ -d "$MPY_DIR/.git" ] && [ "$(git -C "$MPY_DIR" rev-parse HEAD 2>/dev/null || true)" = "$MPY_COMMIT" ]; then
    say "MicroPython $MPY_TAG: cached"
else
    say "MicroPython $MPY_TAG: cloning"
    rm -rf "$MPY_DIR"
    git clone --depth 1 --branch "$MPY_TAG" \
        https://github.com/micropython/micropython.git "$MPY_DIR" >/dev/null 2>&1 \
        || die "could not clone MicroPython $MPY_TAG"
fi
HEAD_SHA="$(git -C "$MPY_DIR" rev-parse HEAD)"
[ "$HEAD_SHA" = "$MPY_COMMIT" ] \
    || die "MicroPython HEAD is $HEAD_SHA, expected $MPY_COMMIT for $MPY_TAG"

# --------------------------------------------------------------------------
# 3. The port patch
# --------------------------------------------------------------------------
# Reset to the pinned commit and re-apply, every run. This is what keeps the
# script idempotent: the tree is a pure function of (commit, patches), never of
# how many times it has been built. `reset --hard` leaves untracked files, so
# the object files from the last build survive and make stays incremental.
say "Applying the port patch"
git -C "$MPY_DIR" reset --hard "$MPY_COMMIT" >/dev/null
shopt -s nullglob
PATCHES=("$PYGRAM_DIR/variant/patches"/*.patch)
shopt -u nullglob
[ ${#PATCHES[@]} -gt 0 ] || die "no patches in pygram/variant/patches — the variant cannot build without them"
for patch in "${PATCHES[@]}"; do
    git -C "$MPY_DIR" apply --whitespace=nowarn "$patch" \
        || die "patch failed to apply: $(basename "$patch")
This is what a MicroPython version bump looks like. Rebase the patch against
$MPY_TAG rather than editing the checkout by hand — see pygram/README.md."
    echo "    $(basename "$patch")"
done

# --------------------------------------------------------------------------
# 4. Sync the variant and the frozen library
# --------------------------------------------------------------------------
# pygram/lib/ is owned by the frozen-stdlib work and is globbed by manifest.py,
# so modules appear in the build purely by existing. The destination is wiped
# rather than overwritten: a stale copy of a module that was deleted upstream
# would otherwise stay frozen into the binary forever.
say "Syncing the variant"
rm -rf "$VARIANT_DEST"
mkdir -p "$VARIANT_DEST/lib"
cp "$PYGRAM_DIR/variant"/*.h "$PYGRAM_DIR/variant"/*.mk "$PYGRAM_DIR/variant/manifest.py" "$VARIANT_DEST/"
LIB_COUNT=0
if compgen -G "$PYGRAM_DIR/lib/*.py" >/dev/null; then
    cp -r "$PYGRAM_DIR/lib"/*.py "$VARIANT_DEST/lib/"
    LIB_COUNT="$(find "$PYGRAM_DIR/lib" -name '*.py' | wc -l | tr -d ' ')"
fi
for d in "$PYGRAM_DIR/lib"/*/; do
    [ -d "$d" ] || continue
    cp -r "$d" "$VARIANT_DEST/lib/"
done
echo "    frozen modules from pygram/lib: $LIB_COUNT"

# micropython-lib is a git submodule this build never reads: manifest.py freezes
# pygram/lib and requires nothing from upstream's library. The Makefile still
# insists the directory exists, so point it at a stub rather than cloning tens
# of megabytes of modules that would not be frozen.
MPY_LIB_STUB="$WORK/mpy-lib-stub"
mkdir -p "$MPY_LIB_STUB"
printf 'Not micropython-lib. pygram freezes only pygram/lib; see manifest.py.\n' \
    >"$MPY_LIB_STUB/README.md"

# --------------------------------------------------------------------------
# 5. Build
# --------------------------------------------------------------------------
# mpy-cross is a HOST tool (it compiles the frozen .py to .mpy at build time),
# so it is built first, on its own, with the plain host compiler. Building it
# in the same invocation as the port would push CC=musl-gcc into its sub-make
# through MAKEFLAGS and cross-compile the build tool.
say "Building mpy-cross (host tool)"
make -C "$MPY_DIR/mpy-cross" -j"$JOBS" >"$WORK/mpy-cross.log" 2>&1 \
    || { tail -30 "$WORK/mpy-cross.log"; die "mpy-cross build failed"; }

say "Building pygram (i386, musl, static)"
make -C "$MPY_DIR/ports/unix" \
    VARIANT=pygram \
    CC="$MUSL_PREFIX/bin/musl-gcc" \
    LD="$MUSL_PREFIX/bin/musl-gcc" \
    STRIP=strip \
    MPY_LIB_DIR="$MPY_LIB_STUB" \
    -j"$JOBS" >"$WORK/pygram.log" 2>&1 \
    || { tail -40 "$WORK/pygram.log"; die "pygram build failed — full log in $WORK/pygram.log"; }

BUILT="$MPY_DIR/ports/unix/build-pygram/pygram"
[ -f "$BUILT" ] || die "the build reported success but produced no binary"

# The port's own strip already ran; this is belt and braces for the case where
# STRIP was overridden, and it is what the size gate measures.
strip "$BUILT" 2>/dev/null || true
cp "$BUILT" "$OUT"

# --------------------------------------------------------------------------
# 6. Smoke checks — the contracts that must hold on every build
# --------------------------------------------------------------------------
# These are not the gates (scripts/pygram-gate.mjs) and not the conformance
# battery (tests/pygram/conformance.mjs). They are the handful of properties
# that make those two worth running at all, checked here so a broken build
# fails at the build rather than three tools later.
say "Smoke checks"
fail=0
check() {
    local name="$1" got="$2" want="$3"
    if [ "$got" = "$want" ]; then
        printf '    ok    %-42s %s\n' "$name" "$got"
    else
        printf '    FAIL  %-42s got %s, want %s\n' "$name" "$got" "$want"
        fail=1
    fi
}

check "statically linked" \
    "$(file -L "$OUT" | grep -c 'statically linked')" "1"
check "ELF 32-bit i386" \
    "$(file -L "$OUT" | grep -c 'ELF 32-bit.*80386')" "1"
check "stripped" \
    "$(file -L "$OUT" | grep -c ', stripped')" "1"
check "runs -c 'pass'" \
    "$("$OUT" -c 'pass' >/dev/null 2>&1; echo $?)" "0"
check "--version does not claim CPython" \
    "$("$OUT" --version)" "pygram 0.1 (python subset)"
check "-V is the same" \
    "$("$OUT" -V)" "pygram 0.1 (python subset)"
check "sys.argv[0] is -c, as in CPython" \
    "$("$OUT" -c 'import sys; print(sys.argv)' a b)" "['-c', 'a', 'b']"
check "program on stdin, argv[0] is -" \
    "$(echo 'import sys; print(sys.argv)' | "$OUT" - x)" "['-', 'x']"
check "sys.path is pinned to ['.frozen']" \
    "$("$OUT" -c 'import sys; print(sys.path)')" "['.frozen']"

# The unsupported contract (docs/PYGRAM-SUBSET.md §7). Rule 4 — the distinction
# between "pygram is too small" and "your dependency is missing" — is the one
# that makes exit 90 branchable, so it is checked in both directions.
check "unsupported module exits 90" \
    "$("$OUT" -c 'import subprocess' >/dev/null 2>&1; echo $?)" "90"
check "unsupported module: one stderr line" \
    "$("$OUT" -c 'import subprocess' 2>&1 >/dev/null)" "pygram: unsupported: module: subprocess"
check "unsupported module: stdout untouched" \
    "$("$OUT" -c 'import subprocess' 2>/dev/null | wc -c | tr -d ' ')" "0"
check "a module CPython lacks too still exits 1" \
    "$("$OUT" -c 'import PIL' >/dev/null 2>&1; echo $?)" "1"

# The stdout/stderr split. A traceback on stdout means a failing
# `pygram ... | wc -l` counts the traceback and `pygram ... > f` writes the
# error into the file — a pipeline silently ingesting garbage, which is exactly
# the silent divergence docs/PYGRAM.md exists to prevent.
check "a failing program writes nothing to stdout" \
    "$("$OUT" -c 'raise ValueError("boom")' 2>/dev/null | wc -c | tr -d ' ')" "0"
check "a failing program writes to stderr" \
    "$("$OUT" -c 'raise ValueError("boom")' 2>&1 >/dev/null | grep -c 'ValueError')" "1"
check "a failing program exits 1, not 90" \
    "$("$OUT" -c 'raise ValueError("boom")' >/dev/null 2>&1; echo $?)" "1"

# Semantics §6 makes contractual, and which a config change could silently undo.
check "float repr is shortest round-trip" \
    "$("$OUT" -c 'print(0.1 + 0.2, 9.7, 100.0 / 4, 1e22)')" "0.30000000000000004 9.7 25.0 1e+22"
check "round() rounds the binary value" \
    "$("$OUT" -c 'print(round(2.675, 2), round(2.5), round(1.5))')" "2.67 2 2"
check "int() arbitrary precision" \
    "$("$OUT" -c 'print(2 ** 100)')" "1267650600228229401496703205376"
check "floor division floors toward -inf" \
    "$("$OUT" -c 'print(-7 // 2)')" "-4"

BYTES="$(stat -c %s "$OUT")"
[ "$fail" = 0 ] || die "smoke checks failed"

say "Built $OUT — $BYTES bytes"
echo "    file opens on -c 'pass':  node scripts/pygram-gate.mjs $OUT --compare"
echo "    conformance vs CPython:   PYGRAM_BIN=$OUT node tests/pygram/conformance.mjs"

if [ "$DO_VERIFY" = 1 ]; then
    say "Gate"
    node "$REPO_ROOT/scripts/pygram-gate.mjs" "$OUT" --compare
    say "Conformance"
    PYGRAM_BIN="$OUT" node "$REPO_ROOT/tests/pygram/conformance.mjs"
fi
