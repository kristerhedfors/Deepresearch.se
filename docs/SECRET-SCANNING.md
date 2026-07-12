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

- **`.githooks/pre-push`** — a git pre-push hook. Reads the standard pre-push
  stdin protocol (`<local ref> <local sha> <remote ref> <remote sha>` per line)
  and runs `scripts/scan-secrets --range <remote sha>..<local sha>` over exactly
  the outgoing commits, blocking the push on a match. A verified false positive
  can bypass with `git push --no-verify`.

- **`scripts/install-git-hooks`** — activates the hooks in a clone by setting
  `git config core.hooksPath .githooks`. Git does **not** auto-activate a repo's
  hooks in a fresh clone, so this must be run once per clone. Idempotent.

### First-time setup in a clone

```bash
scripts/install-git-hooks     # once per clone — enables the pre-push hook
scripts/scan-secrets          # optional: scan the current working tree now
```

## What is NOT in the repo (operational — still owed for P-2)

These cannot be done from inside this repository and remain open:

1. **GitHub secret scanning + push protection.** Enable in the repo
   **Settings → Code security** (free for public repos). This is the
   server-side backstop: it scans on GitHub's side and can reject a push
   containing a recognized secret even when a contributor has not installed the
   local hook. A dashboard/GitHub action — it cannot be configured from this
   repo's code.

2. **Full-history scan from an un-shallowed clone.** Remote-session clones are
   **shallow** (`git rev-parse --is-shallow-repository` → `true`), so a
   `--range`/history scan only covers fetched commits. A full-history verdict
   needs `git fetch --unshallow` first (then scan `--range <root>..HEAD`), or
   relies on GitHub's server-side scanning above. Run this once from a full
   clone and record the result in `SECURITY-RISKS.md`'s History log.

Because of (1) and (2), P-2 is **partial**: the local pre-push gate + scanner
are in place; the server-side push protection toggle and the one-time
full-history unshallow scan remain operational to-dos.
