#!/usr/bin/env bash
# Build a small i386 ext2 image for the in-browser Linux sandbox, then upload it
# to R2 and register it in the admin panel. See docs/SANDBOX-LOCAL-IMAGE.md.
#
# NOT run by deploy — this is a reproducible, out-of-band operator tool. Run it
# on a Linux host with root (loop-mount) + the distro bootstrap tool installed.
#
#   CheerpX is 32-bit x86 (i386) ONLY — every binary in the image MUST be i386
#   (mainline Arch is x86_64 and CANNOT boot; use Alpine i386 / Debian i386-slim /
#   archlinux32). Verify with: file mnt/bin/busybox  →  "ELF 32-bit … Intel 80386".
#
# Usage:
#   sudo ./scripts/build-sandbox-image.sh alpine  alpine-i386-2026-07  512
#   sudo ./scripts/build-sandbox-image.sh debian  debian-i386-slim-2026-07  700
#   sudo ./scripts/build-sandbox-image.sh arch32  arch32-i686-2026-07     1024
#   Then: npx wrangler r2 object put \
#           deepresearch-se-storage/sandbox-images/<id>.ext2 --file build/<id>.ext2
#   Then register + select it in /admin → Linux sandbox image.
#
# Engine is CheerpX (i386). The SMALL + FAST default is the alpine variant —
# owner directive 2026-07-16: it must load quickly and commands must not stall
# fetching hundreds of MB, so the default is the smallest practical image
# (Alpine i386, well under ~200 MB trimmed) paired with sandbox.prefetch=true
# so the whole disk loads into the browser's IndexedDB cache once ("loads in
# its entirety") and later commands touch the network zero times. Add nodejs +
# git (and any tools you need) so sdk/pair-cli.mjs and generated-app tests run
# inside the VM — the "add tools as we go" surface is this package list.
# The arch32 variant is a SELECTABLE heavier option (archlinux32 i686, since
# mainline Arch cannot boot on CheerpX), several hundred MB — NOT the speed
# default. Rollout stays verified-gated per docs/SANDBOX-LOCAL-IMAGE.md §7:
# build → upload → boot on a REAL device (iOS Safari under require-corp) → flip
# verified → only then select default.
set -euo pipefail

DISTRO="${1:-alpine}"     # alpine | debian | arch32
ID="${2:-alpine-i386-$(date +%Y-%m)}"
SIZE_MB="${3:-512}"       # ext2 size; leave headroom for guest work

OUT_DIR="build"
IMG="$OUT_DIR/$ID.ext2"
MNT="$OUT_DIR/mnt-$ID"

# The research toolchain the model reaches for + the pieces sandbox.js's exec
# marker protocol and seed script depend on (bash, sh, coreutils, base64).
# nodejs + git are included so sdk/pair-cli.mjs and generated-app tests run
# INSIDE the VM (the SDK-dev workflow). Add tools here as we go — this list is
# the "exactly the tools we need" surface; every addition grows the image, so
# keep it lean and re-measure the trimmed size against the load-fast target.
#
#   THIS LIST IS DELIBERATELY MINIMAL AND IS *NOT* KEPT IN STEP WITH
#   container/Dockerfile. Owner directive 2026-08-05: the new image is for the
#   SERVER-SIDE execution sandbox ONLY, and this on-device JS-emulated Linux VM
#   stays minimal. The two package lists are asymmetric on purpose. The
#   OCR/PDF/image group added to container/Dockerfile in 2026-08 — tesseract-ocr
#   plus the eng/swe language packs, poppler-utils, python3-pil, zbar-tools,
#   which took that image from 482 MB to 619 MB — is server-side only. Do NOT
#   mirror it here. scripts/build-sandbox-image.test.mjs fails the build if
#   anyone does.
#
#   The reasons are specific to THIS image rather than general thrift:
#
#   - Nothing here is ever installed on the device. Every byte of every binary
#     is streamed lazily over the network as the guest first touches it
#     (CheerpX block devices — docs/SANDBOX-LOCAL-IMAGE.md §2), so packages
#     nobody runs still cost: they add PATH entries and directory trees that a
#     cold `command -v` or a `grep -r` walks over the wire.
#   - Cold first use of a binary is nothing like it is on real hardware.
#     Measured (docs/SANDBOX-PERFORMANCE.md §1): `python3 --version` takes
#     8573 ms cold against 87 ms warm — 98×. And a `command -v` for a tool that
#     is NOT installed once took the whole 30 s exec ceiling, which discards
#     the VM and ends the turn. A heavy OCR stack is exactly the shape that
#     turns one command into a lost session.
#   - This VM is what the Se/cure tier runs its shell on (public/js/sandbox.js,
#     via drc-research.js's run_bash). Se/cure has no server in its data path,
#     so there is nothing to offload to — it is the tier that most needs the
#     image to stay light.
#
#   Leaving OCR out costs no capability. An attached picture is transcribed to
#   text by the ANSWER MODEL in phase 0, before triage (src/image-read.js), and
#   that runs in the pipeline rather than in a shell — so it is the same
#   whichever execution environment the commands go to, and "read this
#   screenshot" never depended on a binary in this list.
#
#   The full per-environment policy is the toolchain section of
#   docs/EXECUTION-ENVIRONMENTS.md; the image-side version is
#   docs/SANDBOX-LOCAL-IMAGE.md §5.
PKGS_COMMON="bash coreutils grep sed gawk findutils file less python3 jq nodejs git"

mkdir -p "$OUT_DIR"
echo "==> Creating ${SIZE_MB}MB ext2 image at $IMG"
dd if=/dev/zero of="$IMG" bs=1M count="$SIZE_MB" status=progress
mkfs.ext2 -F -q "$IMG"   # ext2 specifically — CheerpX mounts root as type:"ext2"

mkdir -p "$MNT"
mount -o loop "$IMG" "$MNT"
trap 'umount "$MNT" 2>/dev/null || true' EXIT

case "$DISTRO" in
  alpine)
    # Alpine i386 — the small default (~100–200MB with the toolchain).
    MIRROR="http://dl-cdn.alpinelinux.org/alpine/latest-stable/main"
    apk --arch x86 -X "$MIRROR" -U --allow-untrusted --root "$MNT" --initdb add \
        alpine-base $PKGS_COMMON py3-pip
    ;;
  debian)
    # Debian i386-slim — the compatibility option (glibc, WebVM's lineage).
    debootstrap --arch=i386 --variant=minbase bookworm "$MNT" \
        http://deb.debian.org/debian
    chroot "$MNT" /bin/sh -c "apt-get update && apt-get install -y --no-install-recommends $PKGS_COMMON && apt-get clean"
    ;;
  arch32)
    # archlinux32 (i686 community fork) — SELECTABLE heavier option, not the
    # default. Mainline Arch is x86_64-only and cannot boot on CheerpX;
    # archlinux32 is the only Arch that can. Bootstrap from the archlinux32
    # tarball (an i686 userland runs fine chrooted on an x86_64 host kernel),
    # then install the toolchain (PKGS_COMMON already carries nodejs+git).
    ARCH32_MIRROR="${ARCH32_MIRROR:-https://mirror.archlinux32.org}"
    BOOTSTRAP_TAR="${ARCH32_BOOTSTRAP:-}"  # path to archlinux32-bootstrap-*.tar.zst
    if [ -z "$BOOTSTRAP_TAR" ]; then
      echo "Set ARCH32_BOOTSTRAP=/path/to/archlinux32-bootstrap-<date>-i686.tar.zst"
      echo "(download from $ARCH32_MIRROR/archisos/ and verify its signature first)"; exit 1
    fi
    tar --zstd -xf "$BOOTSTRAP_TAR" -C "$MNT" --strip-components=1
    printf 'Server = %s/$repo/os/$arch\n' "$ARCH32_MIRROR" > "$MNT/etc/pacman.d/mirrorlist"
    chroot "$MNT" /bin/sh -c "pacman-key --init && pacman-key --populate archlinux32 || true"
    chroot "$MNT" /bin/sh -c "pacman -Sy --noconfirm $PKGS_COMMON && pacman -Scc --noconfirm"
    ;;
  *)
    echo "Unknown distro: $DISTRO (alpine|debian|arch32)"; exit 1 ;;
esac

echo "==> Installing pygram (docs/PYGRAM.md)"
# The Python-subset runtime, as /usr/local/bin/pygram. One static i386 ELF with
# its stdlib frozen in, so it opens ZERO files at startup.
#
# MEASURED IN A REAL VM on 2026-08-14 with scripts/pygram-vm-measure.mjs against
# this image, and the result is stronger than the speed-up it was built for:
#
#   pygram -c 'import json; …'   27 ms cold, streaming ZERO bytes off the disk
#   pygram --version             86 ms cold, 1,152 KB
#   python3 --version           318 ms cold, 3,460 KB
#   python3 -c 'print(1+1)'     NEVER COMPLETED — 2.3 MB streamed, then the
#                               block fetches stop dead and the VM is wedged.
#                               `-S` does not save it either.
#
# So in this image CPython cannot run a one-liner at all, while pygram runs the
# same work in tens of milliseconds. That turns docs/PYGRAM.md §5's "alias vs
# add alongside" from a preference into an evidence-backed question for the
# owner: what is here now is ADD ALONGSIDE, because aliasing changes what the
# agent can do and is not a call this script should make silently.
PYGRAM_BIN="${PYGRAM_BIN:-$(dirname "$0")/../pygram/build/pygram}"
if [ -f "$PYGRAM_BIN" ]; then
    install -Dm755 "$PYGRAM_BIN" "$MNT/usr/local/bin/pygram"
    echo "    installed $(stat -c %s "$PYGRAM_BIN") B from $PYGRAM_BIN"
else
    echo "    SKIPPED — no binary at $PYGRAM_BIN (build it: bash scripts/pygram-build.sh)"
fi

echo "==> Configuring root shell + /root (sandbox.js launches /bin/bash --login, HOME=/root, uid 0)"
mkdir -p "$MNT/root"
grep -q '^root:' "$MNT/etc/passwd" 2>/dev/null || echo 'root:x:0:0:root:/root:/bin/bash' >> "$MNT/etc/passwd"

echo "==> Trimming caches / docs to shrink the image"
rm -rf "$MNT/var/cache/apk/"* "$MNT/usr/share/man/"* "$MNT/usr/share/doc/"* \
       "$MNT/root/.cache" 2>/dev/null || true
find "$MNT" -type d -name __pycache__ -prune -exec rm -rf {} + 2>/dev/null || true

echo "==> Verifying the userland is i386 (must say Intel 80386)"
BUSY="$(command -v true)"; file "$MNT/bin/busybox" 2>/dev/null || file "$MNT/bin/"* 2>/dev/null | head -3 || true

umount "$MNT"; trap - EXIT
# Optional: shrink the filesystem to used size before upload.
# e2fsck -f "$IMG" && resize2fs -M "$IMG"

echo "==> Done: $IMG"
echo "    Upload:  npx wrangler r2 object put deepresearch-se-storage/sandbox-images/$ID.ext2 --file $IMG"
echo "    Then register id='$ID' (arch i386) in /admin → Linux sandbox image and select it."
