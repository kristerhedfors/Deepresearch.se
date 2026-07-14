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
#   Then: npx wrangler r2 object put \
#           deepresearch-se-storage/sandbox-images/<id>.ext2 --file build/<id>.ext2
#   Then register + select it in /admin → Linux sandbox image.
set -euo pipefail

DISTRO="${1:-alpine}"     # alpine | debian
ID="${2:-alpine-i386-$(date +%Y-%m)}"
SIZE_MB="${3:-512}"       # ext2 size; leave headroom for guest work

OUT_DIR="build"
IMG="$OUT_DIR/$ID.ext2"
MNT="$OUT_DIR/mnt-$ID"

# The research toolchain the model reaches for + the pieces sandbox.js's exec
# marker protocol and seed script depend on (bash, sh, coreutils, base64).
PKGS_COMMON="bash coreutils grep sed gawk findutils file less python3 jq"

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
  *)
    echo "Unknown distro: $DISTRO (alpine|debian)"; exit 1 ;;
esac

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
