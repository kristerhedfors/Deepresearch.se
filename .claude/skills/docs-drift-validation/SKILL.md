---
name: docs-drift-validation
description: >-
  Load when asked to VALIDATE the documentation against the actual source code
  — "has the documentation drifted", "are the docs still true", "check the
  docs against the code", "validate the docs bottom-up", a drift check after a
  batch of merges — or when touching scripts/docs-drift.mjs (its WATCH /
  POSTURE / EXCLUDED tables). The TEMPORAL half of docs maintenance: for each
  documented surface, `npm run docs:drift` compares the doc's last commit time
  against the watched source commits SINCE, so validation starts from what
  actually changed, not from re-reading everything. Covers the bottom-up
  validation ladder (technical mirrors → subsystem/design → top-level
  narrative, carrying each confirmed delta upward), the triage into mechanical
  vs SIGNIFICANT drift, and the escalation rule: drift in the documented
  ARCHITECTURE, CAPABILITY, or PRIVACY POSTURE is reported to the OWNER for
  validation — never silently rewritten, because the doc may be the intent and
  the code the bug. Companion to update-docs (the structural greps + mirror
  inventory — the "how to fix" half once drift is confirmed).
---

# Validate the documentation against the code (drift, bottom-up)

**update-docs** answers "is every module/skill/suite *named* in the docs?"
(structural drift, greps + test-enforced mirrors). This skill answers the
other question: **"is what the docs *say* still what the code *does*?"** —
temporal drift, driven by git timestamps. The two run together on a full docs
pass; this one runs alone when the ask is *validate*, not *update*.

## The tool

```bash
npm run docs:drift            # full report, bottom-up by level, top changed files per doc
npm run docs:drift -- --quiet # summary lines + the NOTIFY OWNER block only
```

`scripts/docs-drift.mjs` holds three hand-maintained tables:

- **`WATCH`** — doc → the source paths whose truth it mirrors, with a level
  (1 technical mirror, 2 subsystem/design, 3 top-level narrative). **Mirror
  discipline: a new doc gets a `WATCH` row (or an `EXCLUDED` entry) in the
  same commit**, or the script flags it `UNMAPPED`.
- **`POSTURE`** — the routing / auth / provider / grant / privacy / `/cure`
  surfaces whose changes can move the documented capability or privacy
  posture. Hits here escalate (CSS files are exempt — styling never moves the
  posture).
- **`EXCLUDED`** — docs with their own freshness mechanism (the test-enforced
  board mirrors, the branch ledger, the owners registry). Don't re-add them.

For every `WATCH` row the script prints: when the doc was last committed, how
many watched commits landed strictly after, and the most-touched files.
Generated artifacts (`public/introspect/`, `public/pulse/`) are ignored as
noise. Exit 1 on any drift-suspect or unmapped doc, so a loop can gate on it.

**A hit is drift-SUSPECT, not proven drift.** The tool tells you *where to
look and since when*; the validation is reading the doc against the actual
diffs (`git log -p --since=… -- <paths>`) and asking: does any change alter a
claim this doc makes? "Code moved, claims intact" is the common, fine case —
note it and move on; do not touch the doc.

## The ladder — validate bottom-up, carry deltas upward

Work levels in order; a confirmed delta at one level is an *input* to the
level above, even when the higher doc's own watch paths are quiet:

1. **Technical mirrors** (CODE-LAYOUT, TESTING, AGENT-PAIR-SDK, SERVER-TOKENS,
   ENCRYPTION, the sandbox/workspace design docs, …). Closest to the code,
   cheapest to verify: check tables, module lists, endpoint names, status
   headers ("IMPLEMENTED"/"DESIGN") against the diffs.
2. **Subsystem / design** (ARCHITECTURE, PRIVACY-MODEL, BRANDING,
   STACKLESS-RESEARCH, roadmaps). For each confirmed level-1 delta ask: does
   this change what the subsystem doc *claims* — a new data path, a new
   phase, a changed guarantee, a dead knob still described as live?
3. **Top-level narrative** (README, AGENTS.md, CLAUDE.md, the static
   /help /build /architecture pages). Same question one floor up: does the
   accumulated delta change how the *project describes itself* — mission
   framing, the tier split, the invariants list, "what this is"?

The ripple test at each step: **"if a reader trusted only the higher doc,
would the change underneath surprise them?"** If yes, the higher doc is
drifted even though its text never mentions the changed file.

## Triage — mechanical vs significant

- **Mechanical drift** — a rename, a new helper module, a moved table, a
  count that's off. Fix it yourself per the **update-docs** workflow (mirror
  discipline, regenerate-don't-hand-edit, terse institutional voice), in the
  same session.
- **SIGNIFICANT drift** — the code now implies a different **architecture,
  capability, or privacy/security posture** than documented. Concretely, any
  of: a new or removed data path between client/server/third party; anything
  resembling a third Se/cure→server exception (invariant 4 allows exactly
  two); function/tool-calling appearing in the pipeline (invariant 1); a
  provider or auth-surface change; a change to what the grant/Se/rver tokens
  can reach; an invariant 1–6 contradiction; a tier described as something it
  no longer is. **Do NOT silently rewrite the doc to match the code.** The
  doc may be the intent and the code the bug — which side is right is the
  OWNER's call.

## Escalating significant drift to the owner

1. Put it in your final chat reply under an explicit **"Docs ⇄ code drift —
   owner validation needed"** heading: what the doc claims, what the code now
   does, the commits that introduced the gap, and your read on which side
   looks intended.
2. If the drifting code came from an identifiable merged PR, also comment the
   discrepancy on that PR (**feature-maintenance** back-channel) — the
   author-worker may know which side is the bug.
3. If interactive, `AskUserQuestion` with the doc-is-right / code-is-right
   options. If the answer is "code is right", update the doc (and its
   ancestors up the ladder) in the same session; if "doc is right", that's a
   regression — route it per **feature-maintenance**.
4. Never let escalation block the mechanical fixes: land those, list the
   significant items, end the turn with the report.

## Workflow

1. **Sync first** (**sync-main**) — a drift check on a stale base reports
   drift someone already fixed.
2. `npm run docs:drift` + `npm test` (the test-enforced mirrors are the other
   half of freshness; a failure there names its own fix).
3. Walk the report bottom-up; for each doc read the actual diffs since its
   last commit, confirm or clear the suspicion.
4. Fix mechanical drift (per **update-docs**); collect significant drift into
   the owner report.
5. Verify: `npm test`, `npm run typecheck`, re-run `npm run docs:drift` —
   fixed docs drop out of the report (their last-commit time is now newest).
6. Commit + push; deliver the drift report (including "checked, claims
   intact" for cleared suspects — that's the validation record).

## Caveats

- **The timestamp method sees commit times, not substance.** A doc touched by
  a mass mechanical commit (a rename sweep, a link fix) *looks* fresh while
  its claims rot. When a doc central to the ask shows clean, spot-check that
  its last commit was substantive (`git show <sha> -- <doc>`).
- Vision/roadmap docs (ARCHITECTURE-ROADMAP, FOREVERAGENT-*, STACKLESS-
  RESEARCH) drift by design — they describe intent, not state. Validate their
  *status/implemented* markers, not their aspirations.
- On an active repo the level-2/3 rows are almost never empty. That is not
  failure noise — the count tells you how much accumulated since the doc was
  last true-checked; the read of the diffs tells you whether it matters.
- Keep `WATCH`/`POSTURE` evidence-based: add paths when a real drift slipped
  through, not speculatively.
