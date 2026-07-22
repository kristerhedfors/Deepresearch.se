# Repo secret-leak prevention (security register P-2)

This repository is **public** and **auto-deploys from `main`**, so any credential
that reaches a commit is published and deployed the moment it is pushed. Until
P-2, nothing but convention stood between a secret and a commit. This note
records the mechanical guards that now exist and the parts that still must be
done outside the repo.

## What is in the repo (code)

- **`scripts/scan-secrets`** — the scanner. Matches the canonical credential
  pattern set from the security-posture skill
  (`.claude/skills/security-posture/SKILL.md` §1): OpenAI `sk-`, Berget
  `sk_ber_`, Groq `gsk_`, Anthropic `sk-ant-` (a `sk-` variant), AWS `AKIA`,
  GitHub `ghp_` / `github_pat_`, Google `AIza`, Slack `xox*`, and PEM private-key
  blocks. Matches are **redacted** in the output (provider prefix + length only),
  so running it never prints a full secret. Modes:
  - default — scan the working tree's tracked + staged files;
  - `--staged` — scan the staged diff (pre-commit / pre-push);
  - `--range A..B` — scan the added lines of a commit range.
  Exit `0` = clean, `1` = a token matched, `2` = bad arguments. On failure it
  prints the rotation runbook (rotate at the provider FIRST, then rewrite
  history).

- **`.githooks/pre-commit`** — a git pre-commit hook (added 2026-07-15). Runs
  `scripts/scan-secrets --staged` over the staged diff, blocking the commit on
  a match — so a secret is stopped **before it enters history at all**, and no
  rewrite is ever needed when it fires. A verified false positive can bypass
  with `git commit --no-verify`.

- **`.githooks/pre-push`** — a git pre-push hook, the second line. Reads the
  standard pre-push stdin protocol (`<local ref> <local sha> <remote ref>
  <remote sha>` per line) and runs `scripts/scan-secrets --range <remote
  sha>..<local sha>` over exactly the outgoing commits, blocking the push on a
  match — this catches commits made while the hooks were inactive (a fresh
  clone before activation). Bypass a verified false positive with
  `git push --no-verify`.

- **`scripts/install-git-hooks`** — activates the hooks in a clone by setting
  `git config core.hooksPath .githooks`. Git does **not** auto-activate a
  repo's hooks in a fresh clone, so this must run once per clone. Idempotent.
  **Remote sessions run it automatically**: the SessionStart hook list in
  `.claude/settings.json` invokes it, so every session clone — where nearly
  all of this repo's commits are authored — has both hooks live without
  manual setup.

### First-time setup in a clone (manual clones only)

```bash
scripts/install-git-hooks     # once per clone — enables pre-commit + pre-push
scripts/scan-secrets          # optional: scan the current working tree now
```

## The server-side backstop and the full-history verdict

1. **GitHub secret scanning + push protection** — enabled **by default on
   public repos** (GitHub default since 2024): GitHub scans on its side and
   can reject a push containing a recognized secret even when a contributor
   has not activated the local hooks. The Settings → Code security toggle is
   not reachable from a session; the owner should eyeball it once to confirm
   nothing was manually disabled.

2. **Full-history scan — DONE, clean (2026-07-15).** The clone was unshallowed
   (`git fetch --unshallow`; 791 commits — the repo's entire history) and the
   canonical pattern set was run over every patch in `git log --all -p`:
   **no credential-shaped token has ever been committed.** Recorded in
   `SECURITY-RISKS.md`'s History log. Session clones remain shallow by
   default, so a future full-history re-scan needs `git fetch --unshallow`
   first.

With the commit-time + push-time gates auto-activated per clone, the clean
full-history verdict, and GitHub's default-on server-side scanning, P-2 is
**FIXED** (2026-07-15).
