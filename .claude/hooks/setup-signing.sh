#!/bin/sh
# setup-signing: enable SSH commit signing when the session's environment
# provides a key, so pushed commits show as Verified on GitHub.
#
# Provisioning (one-time, outside the repo — see the deploy skill's
# "commit signing" note): generate a dedicated ed25519 key on YOUR machine,
# add the PUBLIC half to GitHub as a *Signing Key* (Settings → SSH and GPG
# keys → New SSH key → key type "Signing Key"), then put the PRIVATE half in
# the Claude Code environment's secret env vars as GIT_SIGNING_KEY (plain
# OpenSSH PEM or base64 of it). Optionally set GIT_SIGNING_EMAIL to the
# GitHub-verified email the badge should verify against — GitHub only marks
# a commit Verified when the COMMITTER email is a verified address on the
# account that owns the signing key (an @users.noreply.github.com address
# works; noreply@anthropic.com can never verify).
#
# This file is committed to the PUBLIC repo and must never contain key
# material — it only reads the env var the environment injects. Without
# GIT_SIGNING_KEY it exits silently and commits stay unsigned (register
# R-1: a missing knob degrades, it never blocks).
set -eu

[ -n "${GIT_SIGNING_KEY:-}" ] || exit 0
cd "$(git rev-parse --show-toplevel 2>/dev/null)" || exit 0

# git's SSH signing shells out to ssh-keygen, which the remote container
# image does not ship (observed 2026-07-12). Install it on demand — only
# when a key is actually configured — and degrade to unsigned commits if
# the install fails (offline mirror, non-root, …).
if ! command -v ssh-keygen >/dev/null 2>&1; then
  (apt-get update -qq && apt-get install -y -qq openssh-client) >/dev/null 2>&1 || true
fi
if ! command -v ssh-keygen >/dev/null 2>&1; then
  echo "setup-signing: ssh-keygen unavailable and apt install failed — signing NOT enabled"
  exit 0
fi

dir="$HOME/.ssh"
keyfile="$dir/claude_signing"
mkdir -p "$dir"
chmod 700 "$dir"

# Accept the key as plain OpenSSH PEM or base64-encoded (secret-env UIs are
# friendlier to single-line values).
case "$GIT_SIGNING_KEY" in
  *"-----BEGIN "*) printf '%s\n' "$GIT_SIGNING_KEY" > "$keyfile" ;;
  *) printf '%s' "$GIT_SIGNING_KEY" | base64 -d > "$keyfile" 2>/dev/null || {
       echo "setup-signing: GIT_SIGNING_KEY is neither PEM nor valid base64 — signing NOT enabled"
       rm -f "$keyfile"
       exit 0
     } ;;
esac
chmod 600 "$keyfile"

# Sanity: derive the public key; a garbage/passphrase-protected key fails
# here rather than at commit time.
if ! ssh-keygen -y -f "$keyfile" > "$keyfile.pub" 2>/dev/null; then
  echo "setup-signing: key unusable (corrupt or passphrase-protected) — signing NOT enabled"
  rm -f "$keyfile" "$keyfile.pub"
  exit 0
fi

# Repo-local config overrides the container's GLOBAL signing setup, which
# routes ssh signing through a managed wrapper (gpg.ssh.program=/tmp/code-sign,
# observed 2026-07-12) that signs with an environment-managed key GitHub
# doesn't know (commits get no Verified badge) and IGNORES user.signingkey —
# so gpg.ssh.program must be pointed back at the real ssh-keygen or the
# provisioned key never gets used.
git config gpg.format ssh
git config gpg.ssh.program "$(command -v ssh-keygen)"
git config user.signingkey "$keyfile"
git config commit.gpgsign true
if [ -n "${GIT_SIGNING_EMAIL:-}" ]; then
  # GitHub marks a commit Verified only when the COMMITTER email is a
  # verified address on the signing key's account — use your
  # <id>+<user>@users.noreply.github.com address (a personal address works
  # too unless "block pushes that expose my email" is on, which would
  # REJECT the push).
  git config user.email "$GIT_SIGNING_EMAIL"
fi
echo "setup-signing: SSH commit signing enabled ($(cut -d' ' -f1-2 < "$keyfile.pub" | cut -c1-40)…${GIT_SIGNING_EMAIL:+, committer $GIT_SIGNING_EMAIL})"
