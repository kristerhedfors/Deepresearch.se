# The image behind the SERVER-SIDE execution environment (src/exec-container.js)
# — one ephemeral Cloudflare Container per research session, offered on Se/rver
# as an alternative to the in-browser CheerpX Linux VM.
#
# WHAT IT MUST CARRY, and why: the point of this environment is that a research
# shell behaves the SAME as it does in the browser VM. The agent loop
# (public/js/bash-core.js) proposes ordinary Debian commands, developer mode
# mounts this deploy's source tree at /src — including sdk/, so
# `node /src/sdk/pair-cli.mjs list` works exactly as it does in the VM — and the
# outbox convention exports finished artifacts from /workspace/outbox. So the
# toolchain has to be present at BOOT: the container starts with no network
# (enableInternet:false, matching the browser VM), so nothing can be installed
# on demand. A missing tool is a failed research pass, not a slow one.
#
# NO SERVICE RUNS IN HERE. Commands are started as separate processes through
# the Durable Object's container API (`ctx.container.exec`), so there is no
# port, no HTTP server and no agent inside the image — the entrypoint exists
# only to keep the instance alive until it is reaped.
#
# BUILDING IT. `wrangler deploy` builds and pushes this automatically when the
# [[containers]] block in wrangler.toml is enabled, but that block stays
# commented out until the image exists, so the supported path is to build out of
# band and reference the pushed image by URI (wrangler.toml's commented block and
# docs/EXECUTION-ENVIRONMENTS.md §9). One command does build + verify + push:
#
#   ./scripts/build-exec-image.sh all
#
# Build it linux/amd64 with attestation and SBOM OFF — those turn the result into
# a manifest list, and the managed registry wants a single plain manifest:
#
#   docker build --platform linux/amd64 --provenance=false --sbom=false \
#     -t registry.cloudflare.com/<account>/deepresearch-exec:1 container/
#   npx wrangler containers push registry.cloudflare.com/<account>/deepresearch-exec:1
#
# The base must stay GNU, not busybox: both mount paths in src/exec-container.js
# call `tar … --no-same-owner`, which busybox tar rejects.
#
# KEEP IT SMALL. The same requirement the browser VM's image has
# (docs/JS-VM-RESEARCH.md: small, fast, no mid-command stalls) applies here for
# a different reason — image size is what dominates a Cloudflare container cold
# start, and the cold start is what the user waits for on their first command.
# Add tools deliberately, pin nothing you do not need, and strip the caches.

FROM debian:stable-slim

# One layer, no recommends, caches stripped: the whole list below is what a
# research shell is expected to find. Anything not here is unavailable at run
# time (no network), so additions belong in this file rather than in a command.
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      bash coreutils findutils diffutils grep sed gawk \
      tar gzip bzip2 xz-utils zip unzip \
      ca-certificates \
      git \
      python3 python3-venv \
      nodejs \
      jq bc file less tree \
      ripgrep \
      sqlite3 \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/* /usr/share/doc /usr/share/man /usr/share/locale

# The layout the mount bridge fills in (src/exec-container.js, and its browser-VM
# counterpart in public/js/sandbox-files.js):
#   /workspace            this session's files + the agent's scratch space
#   /workspace/INDEX.txt  the manifest of what was mounted
#   /workspace/outbox     the deliverables convention (exported back to the chat)
#   /workspace/source ->  /src   (developer mode)
#   /mnt/<project>-<hash> the active project's files
#   /src                  this deploy's own source tree, sdk/ included
RUN mkdir -p /workspace/outbox /mnt /src

WORKDIR /workspace
ENV HOME=/root TERM=dumb DR_EXEC=cloudflare-container

# Nothing to serve — just stay alive. The Durable Object passes this same
# entrypoint on start(), so it holds even if the image is swapped.
ENTRYPOINT ["sleep", "infinity"]
