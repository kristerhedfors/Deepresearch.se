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
# Cloudchamber API. An API token scoped only to Workers dies there with a bare
# `Forbidden` / `cloudchamber push failed` even though `wrangler deploy` works
# fine — the token needs the **Containers / Cloudchamber: Edit** permission
# (Workers Scripts: Edit is NOT enough). Measured 2026-07-26 with a Workers-only
# token on this account:
#
#   GET  /accounts/<id>/workers/scripts                     → 200   (control)
#   GET  /accounts/<id>/cloudchamber/me                      → 403
#   POST /accounts/<id>/cloudchamber/registries/credentials  → 405, code 10405
#                                    "Method not allowed for this authentication scheme"
#
# So the credentials endpoint does NOT answer 403 — it answers 405, and probing
# for 401/403 there silently passes a token that cannot push. `preflight_push`
# uses the `cloudchamber/me` GET, which does answer 403, and also treats CF error
# code 10405 as the same refusal.
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
             git python3 node jq bc file less tree rg sqlite3; do
      check "$t" "command -v $t"
    done

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

preflight_push() {
  command -v npx >/dev/null 2>&1 || die "npx not on PATH."
  local acct="${CLOUDFLARE_ACCOUNT_ID:-}"
  [ -n "$acct" ] || die "CLOUDFLARE_ACCOUNT_ID is not set."
  [ -n "${CLOUDFLARE_API_TOKEN:-}" ] || return 0   # OAuth login is fine; let wrangler decide.
  local code cred
  code=$(curl -s -o /dev/null -w '%{http_code}' \
    -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
    "https://api.cloudflare.com/client/v4/accounts/$acct/cloudchamber/me" || echo 000)
  cred=$(curl -s -X POST \
    -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H 'content-type: application/json' \
    -d '{"permissions":["push","pull"]}' \
    "https://api.cloudflare.com/client/v4/accounts/$acct/cloudchamber/registries/credentials" || echo '')
  if [ "$code" = "403" ] || [ "$code" = "401" ] || case "$cred" in *10405*) true ;; *) false ;; esac; then
    die "CLOUDFLARE_API_TOKEN cannot mint container registry credentials (cloudchamber/me → HTTP $code).
     This token is scoped for Workers but not Containers. In the Cloudflare
     dashboard → My Profile → API Tokens, add the permission
         Account · Cloudchamber (Containers) · Edit
     to the token, or run this push from a machine with \`wrangler login\` (OAuth).
     Everything else in this script works without it — build and verify already did."
  fi
}

cmd_push() {
  preflight_docker
  local tag; tag="$(registry_tag)"
  preflight_push
  docker image inspect "$LOCAL_TAG" >/dev/null 2>&1 || die "$LOCAL_TAG not built yet — run: $0 build"
  say "push $tag"
  docker tag "$LOCAL_TAG" "$tag"
  ( cd "$REPO_ROOT" && npx wrangler containers push "$tag" )
  cat <<EOF

Pushed. To switch the environment ON:
  1. uncomment the [[containers]] / [[durable_objects.bindings]] / [[migrations]]
     block in wrangler.toml and set image = "$tag"
  2. npx wrangler deploy
  3. confirm /api/settings reports available.exec_container: true while signed in

Leave the block commented until the push above has actually succeeded — a
binding whose resource does not exist fails EVERY deploy, not just this feature.
EOF
}

case "${1:-all}" in
  build)  cmd_build ;;
  verify) cmd_verify ;;
  push)   cmd_push ;;
  all)    cmd_build; cmd_verify; cmd_push ;;
  *)      die "usage: $0 [build|verify|push|all]" ;;
esac
