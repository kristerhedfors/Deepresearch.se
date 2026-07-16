---
name: agent-dev-workflow
description: >-
  Load when setting up or operating the development system that keeps a pair
  buildable BY agent sessions — the slim project memory + on-demand skills
  structure, the git discipline for a fleet of parallel sessions (sync-main
  hooks, the merge barrier, the merged-branch ledger, PR watching), regression
  routing to author-workers via the maintenance-owners registry, secret
  scanning on commit/push, docs-as-mirrors drift enforcement, or the security
  risk register + fix loop. Covers persist-solved-tasks-as-skills, the
  skills-document-and-operate boundary, and both merge styles.
---

# The agent development system

A pair is built and maintained by many short-lived agent sessions working
in parallel on one repository. Left alone, that fleet re-derives solved
problems, builds on stale bases, rebuilds on dead branches, leaks secrets
into public history, and lets docs rot. This module is the development
system that prevents all of it: slim always-loaded memory with on-demand
skills, hooks that enforce the git discipline mechanically, a registry that
routes regressions to the worker who owns the fix, scanners that gate
commits, and mirror tests that name documentation drift. It is what makes
every other module's "an agent session can execute this" claim true.

## Capability class & tier story

**Class D** — development system (`deps: pair-architecture`). Nothing here
is product code: it lives in the repo's memory file, skills directory,
hooks, registries, and scripts, and in the sessions' own behavior. It is
tier-agnostic — the same discipline governs work on the client tier, the
server tier, and the bridge — but it is what enforces the tier rules in
practice: the class constraints (no S imports in a C graph), the mirror
disciplines, and PA-10's merge gates all live in tests and hooks this
module installs.

## Contracts

- **PA-10 (enforced):** the workflow is where "measure before believing"
  becomes mechanical — green-gate before push, live-verify conventions,
  eval merge gates, and the boards/loops that carry verified status flips.
- **PA-5 (carried):** the whole system is plain shell hooks, dependency-free
  Node scripts, and Markdown — knowledge shipped as skills, not a framework
  (the SDK's own founding decision).
- **PA-4 (enforced at commit time):** the secret scanner and the
  commit-time hygiene rules keep credentials and live user data out of the
  public repository — the privacy split extends to the repo itself.
- **PA-7 (enforced):** the docs-mirror and façade-identity tests this
  module wires are what keep "one implementation, pinned by a test" true
  as the fleet edits in parallel.

## Build plan

1. **Slim project memory + on-demand skills (progressive disclosure).**
   ONE always-loaded memory file (the reference: CLAUDE.md) carrying only
   what every session needs: the mission, the load-bearing invariants, the
   git workflow, the module tables, and a one-line index of skills.
   Everything deep goes into `.claude/skills/<name>/SKILL.md` files loaded
   on demand, each with a `description` frontmatter written as a trigger
   ("Load when…"). **The boundary:** skills DOCUMENT and OPERATE — build
   plans, runbooks, incident history, CLI usage; product logic never lives
   in a skill. **Persist solved tasks as skills:** when a session solves
   something likely to recur (a deploy path, a debugging workflow, an API
   quirk that cost real time), it writes or extends a skill before the
   session ends — prefer extending over near-duplicates, keep entries
   evidence-based (what was observed, not what docs claim), and update the
   memory file's skill index + the frontmatter in the same change.
2. **Session-start hooks.** A SessionStart hook that (a) fetches
   `origin/main` and fast-forwards a clean behind-branch automatically,
   printing a loud WARNING (rebase before touching code) when the branch
   has its own commits; (b) installs the git hooks (`core.hooksPath`); and
   (c) wires any credential/signing setup from environment secrets. Fresh
   containers are ALWAYS off-sync; the hook makes the sync-first rule
   mechanical. Re-fetch before every push; a non-fast-forward rejection
   means fetch and rebase, never force-push.
3. **The merge barrier — a flag file for fleet-wide resets.** A committed
   JSON flag (`active`, `main_sha`, reason, ledger pointer) that signals
   "a mass reconciliation happened; branches predating `main_sha` are
   stale". A hook checks it on every prompt: if active AND the current
   branch doesn't contain `main_sha`, the session must sync and cut a NEW
   branch before any work. The owner clears it once the fleet has reset.
4. **The merged-branch ledger — tagging branches DONE.** A committed doc
   listing every reconciled branch with a verdict (Merged / Superseded /
   Dropped) and its tip SHA at merge. The ledger IS the tag: a listed
   branch is dead — no new commits, no PRs from it; new work starts fresh
   off `main`. A guard script fetches current tips and prints a
   NOTIFY-OWNER banner (exit 1) when a done branch advanced. Classify by
   CONTENT, not graph position: a squash-merged branch shows a huge
   `ahead` count with nothing new; a fresh 1-commit branch is the likelier
   real candidate — check whether the distinctive change is already in
   `main` before calling anything superseded.
5. **Both merge styles; focused PRs; watch your own PR.** A change lands
   EITHER by a PR merged into `main` OR by a direct branch merge — always
   cut from the latest `origin/main`, one focused change per PR. A
   one-word "pr" runbook makes preparation deterministic: barrier + base
   check → regenerate committed artifacts if tracked text changed → green
   gate (`npm test` + typecheck; never push red) → commit → push → open
   the PR. **The moment a session opens a PR it subscribes to it** and
   follows it to merged-or-closed: investigate every CI failure and review
   comment, push small confident fixes, ask on ambiguity. Webhooks don't
   deliver CI success, new pushes, or merge-conflict transitions — so also
   schedule a timed self check-in (~1 h) that re-checks state and re-arms
   silently if nothing changed.
6. **Regression routing + the maintenance-owners registry.** A fix is not
   done at merge; regression-prone features need a standing owner. Keep a
   registry doc: one row per maintained subsystem → owning PR #, branch,
   author session, the files it guards, and the FAILURE SIGNATURES to
   watch (interaction-log keywords, diag counters). The back-channel: a
   comment on a PR wakes that PR's subscribed author-worker — so the
   watcher/merger sweeps each tick (log keyword search + live probes +
   user reports) and, on a regression, comments on the owning PR with an
   actionable report (one-line symptom, log row id + counters, VERBATIM
   repro, which prior fix regressed, what "fixed" looks like) instead of
   silently fixing. The newest merged fix PR for a subsystem becomes its
   owner — update the row in the same pass. Fallback when the owner is
   unresponsive: fix directly WITH a regression test and note it.
7. **Secret scanning — hooks, not hope.** One scanner script over a
   provider-prefix pattern set (extend it when a provider joins), runnable
   against the working tree, the staged diff, or a commit range, redacting
   matches and printing the rotation runbook on a hit. Wire it TWICE:
   a pre-commit hook over the staged diff (the secret never enters
   history) and a pre-push hook over outgoing commits (the second line);
   platform-side secret scanning + push protection as the backstop. If a
   secret is ever found: rotate at the provider FIRST (a public repo is
   compromised the moment it was pushed), then rewrite history, then log
   the incident in the risk register.
8. **Commit-time hygiene for live data.** Anything derived from production
   traffic (log excerpts, feedback threads, verbatim-message regression
   tests, ledger entries) gets scrubbed before commit: no full log rows,
   no names/emails/locations identifying a user, and the secret scan over
   the staged diff — users paste keys into chats. The repo is public; a
   committed excerpt is published.
9. **Docs as mirrors.** Split the documentation surface into
   **test-enforced mirrors** — the register⇄catalog pairs, the
   façade-identity pins, generated-artifact freshness checks — where
   `npm test` NAMES the drift and the fix is prescribed
   (regenerate-don't-hand-edit for generated artifacts), and
   **hand-maintained prose** — the memory file's module tables and skill
   index, the README — covered by drift-detection greps (modules missing a
   table row, skills missing an index bullet, bullets naming dead skills)
   run as a periodic docs pass: sync first, survey, regenerate, update
   prose in the surrounding voice, verify green, commit. A new
   module/skill/feature is not done until its docs row exists in the same
   commit.
10. **The security risk register + fix loop (sketch).** A living register
    `.md`: the public-source threat model, a §-numbered priority-ordered
    open-fix backlog with stable ids, an append-only history log — mirrored
    by a code catalog on the decision-board core so the human's board
    priority is the fix loop's FIXED work order. A companion skill holds
    the concrete re-check procedure per register item (scans, header
    probes, per-finding greps). Fix rounds read the board first; a fixed
    item flips catalog status + register tag + history line in the same
    commit as the fix.

## Reference implementation map

| Concept | File(s) in this repo |
|---|---|
| Slim memory + skill index | `CLAUDE.md` (invariants, file tables, skills list) |
| On-demand skills (the library itself) | `.claude/skills/*/SKILL.md` |
| Session-start sync + hook install + signing | `.claude/hooks/sync-main.sh`, `.claude/hooks/setup-signing.sh`, `.claude/settings.json`, `.claude/skills/sync-main/SKILL.md` |
| Merge barrier flag + hook | `docs/MERGE-STATUS.json`, `.claude/hooks/merge-barrier.sh`, CLAUDE.md "MERGE BARRIER" |
| Merged-branch ledger + guard | `docs/MERGED-BRANCHES.md`, `scripts/check-merged-branches.mjs`, `.claude/skills/merge-branches/SKILL.md` |
| PR preparation runbook | `.claude/skills/pr/SKILL.md` |
| PR watching + self check-in directive | CLAUDE.md "ALWAYS watch a PR you open" (subscribe_pr_activity + send_later) |
| Maintenance-owners registry + regression routing | `docs/MAINTENANCE-OWNERS.md`, `.claude/skills/feature-maintenance/SKILL.md`, CLAUDE.md "Regression feedback loop" |
| Secret scanner + git hooks | `scripts/scan-secrets`, `.githooks/pre-commit`, `.githooks/pre-push`, `scripts/install-git-hooks`, `docs/SECRET-SCANNING.md` |
| Commit-time hygiene rules | `.claude/skills/security-posture/SKILL.md` §2 |
| Docs-mirror split + drift greps | `.claude/skills/update-docs/SKILL.md`; freshness tests in `src/introspect.test.js`; mirror tests in `src/features.test.js`, `src/security-risks.test.js` |
| Risk register + fix loop | `SECURITY-RISKS.md`, `src/security-risks.js`, `scripts/security`, `.claude/skills/security-posture/SKILL.md` |
| Keyword-to-fix + verbatim regression tests | `.claude/skills/bugreport-bugfix/SKILL.md` |

## Acceptance checklist

- [ ] The SessionStart hook fires on a fresh session: fetches main,
      fast-forwards or warns, installs the git hooks — observed in a real
      session's startup output.
- [ ] The merge-barrier hook blocks work on a pre-barrier branch and stays
      silent on a branch containing the recorded `main_sha`.
- [ ] The merged-branch guard exits 1 with a NOTIFY banner when a ledger'd
      branch's tip advances (test with an override ledger).
- [ ] A staged diff containing a fake provider-prefixed key is BLOCKED at
      commit; the same key in an outgoing commit is blocked at push.
- [ ] A regression report comment on an owning PR wakes its subscribed
      author-worker (verified once end to end); the registry row updates
      when a newer fix PR merges.
- [ ] `npm test` names every mirror drift: register⇄catalog edits split
      across commits fail; stale generated artifacts fail; the docs-pass
      greps print nothing on a clean tree.
- [ ] Every skill on disk has an index bullet in the memory file and a
      trigger-shaped `description`; the reverse grep finds no dead bullets.
- [ ] A session that opens a PR is subscribed to it and has a scheduled
      self check-in; the PR reaches merged/closed under watch.

## Pitfalls

- **`ahead` is not "unmerged content".** A squash-merged branch shows 200+
  ahead with nothing new; a 1-commit branch is the likelier real candidate.
  The reference's 86-branch reconciliation was classified by content checks
  (`git grep` the distinctive string in `origin/main`), never by graph
  position.
- **A merged branch is DONE.** Building on it again is the fleet's most
  common rule-break — hence the ledger, the guard, and the barrier all
  exist as three separate defenses.
- **Regenerate committed artifacts after your LAST content edit.** The
  reference's source snapshot indexes every tracked text file — editing a
  skill or doc stales it just like code; freshness tests fail the PR later
  even if it looked fine locally. Bundle, then commit, in that order.
- **Shallow clones lie to the secret scan.** Remote-session clones are
  shallow; a FULL-history verdict needs `git fetch --unshallow` first (the
  reference's clean full-history scan was run unshallowed, 791 commits).
- **Rotate first, clean up second.** A pushed secret in a public repo is
  compromised at push time; history rewriting is remediation theater until
  the key is dead at the provider.
- **Unverified commit badges may be EXPECTED.** The reference containers
  ship no signing key; sessions must not burn turns trying to fix what
  only an owner-side secret can (the hook wires it automatically once the
  secret exists). Document the expected state so sessions stop "fixing" it.
- **A docs pass on a stale base re-introduces drift someone already
  fixed** — sync first is step 1 of the docs workflow, not a formality.
- **Don't silently fix an owned subsystem.** The routing exists because a
  silent fix orphans the standing owner's context — the next regression
  then has TWO half-owners. Comment on the owning PR; fix directly only as
  the recorded fallback.
- **Never auto-approve on a human channel, never spam a thread** — the
  human-in-the-loop checkpoints (feedback entries, board priorities) are
  the pair's steering; a workflow that routes around them optimizes itself
  out of alignment with its owner.
- **Webhooks are incomplete by design** — CI success, new pushes, and
  merge-conflict transitions never arrive; the scheduled self check-in is
  load-bearing, not belt-and-suspenders.
