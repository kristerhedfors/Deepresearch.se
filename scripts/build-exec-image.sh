#!/usr/bin/env bash
# Build, VERIFY and push the image behind the server-side execution environment
# (container/Dockerfile → src/exec-container.js). See docs/EXECUTION-ENVIRONMENTS.md §9.
#
# NOT run by deploy — a reproducible, out-of-band operator tool, the sibling of
# scripts/build-sandbox-image.sh (which builds the BROWSER VM's ext2 image).
# The two images are unrelated on purpose: CheerpX needs i386 ext2, this one is
# an ordinary linux/amd64 OCI image for Cloudflare Containers.
#
# Usage:
#   ./scripts/build-exec-image.sh build     # build the image locally
#   ./scripts/build-exec-image.sh verify    # run the battery against a built image
#   ./scripts/build-exec-image.sh push      # push to the Cloudflare managed registry
#   ./scripts/build-exec-image.sh all       # build → verify → push  (default)
#
# Env overrides: IMAGE_NAME (deepresearch-exec), IMAGE_TAG (1),
#                CLOUDFLARE_ACCOUNT_ID (required for push).
#
# ---- why `verify` exists -----------------------------------------------------
#
# docs/EXECUTION-ENVIRONMENTS.md §10 listed "the container backends have not been
# run here — no container runtime exists in the build environment" as still-owed
# work. That is no longer true: the agent containers this repo is developed in
# now ship a Docker client AND `dockerd`, so the image can be built and exercised
# in-session (start the daemon with `dockerd &` if /var/run/docker.sock is absent).
# `verify` is the battery that closes that gap. It asserts the contracts
# src/exec-container.js actually depends on, not just "the image builds":
#
#   * every tool in the Dockerfile's list resolves on PATH — the container runs
#     with enableInternet:false, so a missing tool is a failed research pass and
#     nothing can be apt-got at run time;
#   * `bash -lc` is the argv shape (shellArgv()) and a LOGIN shell must still see
#     a sane PATH and the image's ENV (a login shell re-runs /etc/profile);
#   * GNU tar handles `tar -xf - -C / --no-same-owner` (mountExtractScript()) and
#     `-C /src` (the source mount) — busybox tar does NOT take --no-same-owner,
#     which is why the image may never be slimmed to a busybox base;
#   * mountSeedScript()'s `mkdir -p` + `ln -sfn` layout works, so /workspace/<proj>
#     and /workspace/source resolve;
#   * `node /src/sdk/pair-cli.mjs list` runs — the Dockerfile's headline claim,
#     checked against THIS repo mounted at /src rather than asserted in a comment.
#
# ---- the push, and the permission it needs -----------------------------------
#
# `wrangler containers push` mints short-lived registry credentials from the
# Cloudchamber API, and the environment's DEFAULT token cannot do that. There
# are two Cloudflare tokens here and they are not interchangeable (the full
# table lives in the `deploy` skill):
#
#   CLOUDFLARE_API_TOKEN        account-owned. Deploys Workers. CANNOT touch
#                               Containers — `wrangler containers …` dies with a
#                               bare `✘ Forbidden` / `cloudchamber push failed`.
#   CLOUDFLARE_USER_API_TOKEN   a USER API token (owner-added 2026-07-26, full
#                               Workers + Containers edit). This is the one that
#                               pushes.
#
# Adding the Cloudchamber permission to the ACCOUNT token does not help — the
# blocker was the token TYPE, not its permissions. `wrangler` only ever reads
# `CLOUDFLARE_API_TOKEN`, so the push below overrides that variable inline.
#
# Do NOT preflight on the Cloudchamber API. Measured 2026-07-26, both tokens:
#
#   GET  /accounts/<id>/cloudchamber/me                      → 401 (account) / 403 (user)
#   POST /accounts/<id>/cloudchamber/registries/credentials  → 405 code 10405 for BOTH
#                                    "Method not allowed for this authentication scheme"
#
# — i.e. the endpoints that look like permission probes refuse the WORKING token
# too. `wrangler containers images list` is the only honest check, and that is
# what preflight_push uses.
set -euo pipefail

IMAGE_NAME="${IMAGE_NAME:-deepresearch-exec}"
IMAGE_TAG="${IMAGE_TAG:-1}"
LOCAL_TAG="$IMAGE_NAME:$IMAGE_TAG"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Cloudflare Containers run linux/amd64. Attestation/SBOM manifests turn the
# result into a manifest LIST, which the managed registry does not want, so both
# are switched off — the image must be a single plain manifest.
BUILD_FLAGS=(--platform linux/amd64 --provenance=false --sbom=false)

say() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
die() { printf '\033[31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

registry_tag() {
  [ -n "${CLOUDFLARE_ACCOUNT_ID:-}" ] || die "CLOUDFLARE_ACCOUNT_ID is not set — needed to tag for the managed registry."
  printf 'registry.cloudflare.com/%s/%s:%s' "$CLOUDFLARE_ACCOUNT_ID" "$IMAGE_NAME" "$IMAGE_TAG"
}

preflight_docker() {
  command -v docker >/dev/null 2>&1 || die "no docker client on PATH."
  if ! docker info >/dev/null 2>&1; then
    printf 'docker daemon unreachable; trying to start dockerd …\n'
    command -v dockerd >/dev/null 2>&1 || die "no dockerd either — run this on a machine with Docker."
    nohup dockerd >/tmp/dockerd.log 2>&1 &
    for _ in $(seq 1 20); do docker info >/dev/null 2>&1 && break; sleep 1; done
    docker info >/dev/null 2>&1 || die "dockerd did not come up — see /tmp/dockerd.log."
  fi
}

cmd_build() {
  preflight_docker
  say "build $LOCAL_TAG (linux/amd64, no attestation)"
  docker build "${BUILD_FLAGS[@]}" -t "$LOCAL_TAG" "$REPO_ROOT/container/"
  printf 'size: %s\n' "$(docker images "$LOCAL_TAG" --format '{{.Size}}')"
}

# The battery. Runs entirely inside the image, with this repo mounted read-only
# at /src so the SDK check exercises the real tree. Every check is an assertion:
# the script exits non-zero on the first failure, so `all` never pushes an image
# that would break a research pass.
cmd_verify() {
  preflight_docker
  docker image inspect "$LOCAL_TAG" >/dev/null 2>&1 || die "$LOCAL_TAG not built yet — run: $0 build"
  say "verify $LOCAL_TAG"
  # --network none mirrors the container's enableInternet:false.
  docker run --rm --network none -v "$REPO_ROOT":/src:ro --entrypoint bash "$LOCAL_TAG" -lc '
    set -uo pipefail
    fails=0
    ok()   { printf "  \033[32mok\033[0m   %s\n" "$1"; }
    bad()  { printf "  \033[31mFAIL\033[0m %s\n" "$1"; fails=$((fails+1)); }
    check(){ if eval "$2" >/dev/null 2>&1; then ok "$1"; else bad "$1"; fi; }

    echo "-- toolchain on PATH (no network at run time: absent == unavailable)"
    for t in bash ls find diff grep sed gawk tar gzip bzip2 xz zip unzip \
             git python3 node jq bc file less tree rg sqlite3 \
             tesseract pdftotext zbarimg; do
      check "$t" "command -v $t"
    done

    echo "-- reading attached images (feedback #60: no network, so it ships or it fails)"
    check "python3 imports PIL"    "python3 -c \"import PIL\""
    check "tesseract lang eng"     "tesseract --list-langs 2>&1 | grep -qx eng"
    check "tesseract lang swe"     "tesseract --list-langs 2>&1 | grep -qx swe"

    echo "-- the argv shape src/exec-container.js uses (shellArgv → bash -lc)"
    check "login shell keeps a usable PATH" "[ -x \"\$(command -v ls)\" ]"
    check "login shell keeps the image ENV"  "[ \"\$DR_EXEC\" = cloudflare-container ]"
    check "HOME is set"                      "[ \"\$HOME\" = /root ]"
    check "starts in /workspace"             "[ \"\$(pwd)\" = /workspace ]"

    echo "-- the layout the mount bridge fills in"
    for d in /workspace /workspace/outbox /mnt /src; do check "$d exists" "[ -d $d ]"; done

    echo "-- GNU tar contracts (mountExtractScript / the /src source mount)"
    # busybox tar rejects --no-same-owner, so the base must stay GNU. Assert the
    # identity, then let the two extract checks below exercise the flag for real
    # — `tar --help` does not list --no-same-owner even though GNU tar takes it,
    # so grepping the help text is a false negative, not a finding.
    check "GNU tar (busybox tar cannot take --no-same-owner)" "tar --version | head -1 | grep -q GNU"
    tmp=$(mktemp -d); mkdir -p "$tmp/workspace"; echo hello > "$tmp/workspace/probe.txt"
    ( cd "$tmp" && tar -cf /tmp/m.tar workspace )
    check "extract at / (client mount)" "tar -xf /tmp/m.tar -C / --no-same-owner && [ \"\$(cat /workspace/probe.txt)\" = hello ]"
    ( cd "$tmp/workspace" && tar -cf /tmp/s.tar probe.txt )
    check "extract at /src (source mount)" "tar -xf /tmp/s.tar -C /tmp --no-same-owner"

    echo "-- mountSeedScript layout (mkdir -p + ln -sfn)"
    check "project mount dir"  "mkdir -p /mnt/demo-abc123"
    check "workspace symlink"  "ln -sfn /mnt/demo-abc123 /workspace/demo && [ -d /workspace/demo ]"
    check "source symlink"     "ln -sfn /src /workspace/source && [ -d /workspace/source ]"

    echo "-- the Dockerfile headline claim: the SDK CLI runs from the mounted tree"
    check "node /src/sdk/pair-cli.mjs list" "node /src/sdk/pair-cli.mjs list | grep -q Layer"
    check "node /src/sdk/pair-cli.mjs agents" "node /src/sdk/pair-cli.mjs agents | grep -qi agents"

    echo "-- outbox convention is writable"
    check "write to /workspace/outbox" "echo x > /workspace/outbox/a && [ -s /workspace/outbox/a ]"

    echo
    if [ "$fails" -ne 0 ]; then printf "\033[31m%s check(s) FAILED\033[0m\n" "$fails"; exit 1; fi
    printf "\033[32mall checks passed\033[0m\n"
  '
}

# The token `wrangler containers …` must run with. Prefers the user token; falls
# back to the account token so a machine using `wrangler login` (OAuth) or a
# correctly-scoped single token still works.
push_token() { printf '%s' "${CLOUDFLARE_USER_API_TOKEN:-${CLOUDFLARE_API_TOKEN:-}}"; }

preflight_push() {
  command -v npx >/dev/null 2>&1 || die "npx not on PATH."
  [ -n "${CLOUDFLARE_ACCOUNT_ID:-}" ] || die "CLOUDFLARE_ACCOUNT_ID is not set."
  [ -n "$(push_token)" ] || return 0   # OAuth login is fine; let wrangler decide.
  # The ONE honest probe: it succeeds only with a Containers-capable token.
  if ! CLOUDFLARE_API_TOKEN="$(push_token)" \
       npx wrangler containers images list >/dev/null 2>&1; then
    die "this token cannot reach the container registry.
     \`wrangler containers images list\` was refused. Set CLOUDFLARE_USER_API_TOKEN
     to a Cloudflare **User** API token (dashboard → My Profile → API Tokens)
     with Workers + Containers edit — an ACCOUNT-owned token cannot do this no
     matter which permissions it carries. Or run from a machine with
     \`wrangler login\` (OAuth).
     Build and verify work without it; only the push needs this."
  fi
}

# The image must be a single plain manifest. BuildKit otherwise publishes an OCI
# index with an attestation manifest attached, and `docker push` will happily
# send that — this bit once (2026-07-26): a stale tag pointed at an earlier
# attestation build and an index reached the registry. Checked locally, before
# the push, because after the push `docker manifest inspect` serves a CACHED
# answer and will show the old shape (use `docker buildx imagetools inspect
# --raw` for a live read).
assert_single_manifest() {
  local tag="$1" mt
  mt=$(docker image inspect "$tag" --format '{{.Descriptor.MediaType}}' 2>/dev/null || echo '')
  case "$mt" in
    *index*|*list*)
      die "$tag is a manifest LIST ($mt), not a single image.
     Rebuild with --provenance=false --sbom=false (this script's `build` does).
     A stale tag from an earlier attestation build is the usual cause: run
       docker rmi -f $tag && $0 build" ;;
    "") die "cannot read the media type of $tag — is it built?" ;;
  esac
  printf 'manifest: %s\n' "$mt"
}

cmd_push() {
  preflight_docker
  local tag; tag="$(registry_tag)"
  preflight_push
  docker image inspect "$LOCAL_TAG" >/dev/null 2>&1 || die "$LOCAL_TAG not built yet — run: $0 build"
  say "push $tag"
  docker tag "$LOCAL_TAG" "$tag"
  assert_single_manifest "$tag"
  ( cd "$REPO_ROOT" && CLOUDFLARE_API_TOKEN="$(push_token)" npx wrangler containers push "$tag" )
  cat <<EOF

Pushed. wrangler.toml's [[containers]] block already points at
  $tag
so the next deploy that includes it switches the environment on:
  npx wrangler deploy
  # then confirm /api/settings reports available.exec_container: true (signed in)

If you ever re-comment that block, keep it commented until a push has actually
succeeded — a binding whose resource does not exist fails EVERY deploy, not just
this feature.
EOF
}

case "${1:-all}" in
  build)  cmd_build ;;
  verify) cmd_verify ;;
  push)   cmd_push ;;
  all)    cmd_build; cmd_verify; cmd_push ;;
  *)      die "usage: $0 [build|verify|push|all]" ;;
esac
