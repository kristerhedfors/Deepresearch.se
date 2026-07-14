---
name: update-docs
description: >-
  Load when asked to update, refresh, sync, or audit ALL the documentation in
  this repo — "update the docs", "make sure the docs are current", "the docs
  drifted", a docs-update pass after a batch of code changes — or when adding a
  new module/skill/feature and you need to know which docs must be touched in
  the same change. The single playbook for the repo's whole documentation
  surface: the inventory (CLAUDE.md, README, AGENTS.md, FEATURES.md,
  SECURITY-RISKS.md, docs/, the skills, the static /help /build /story
  /architecture /welcome pages, the committed introspection/pulse artifacts),
  the split between TEST-ENFORCED mirrors (run `npm test` — a failure names the
  drift) and HAND-MAINTAINED prose (no test catches it — grep for drift), the
  exact drift-detection commands, the regenerate-don't-hand-edit rule for
  generated artifacts, and the survey → detect → update → verify → commit
  workflow. Companion to introspection (the source snapshot), feature-board /
  security-posture (the two mirrored catalogs), and commit-analytics (pulse).
---

# Update all documentation

This repo carries an unusually large, deliberately maintained documentation
surface. "Update all documentation" here does **not** mean rewrite prose for
style — it means **reconcile every doc with the current code**, so a reader
(human or an answer model via introspection mode) never sees a table, list, or
claim that the tree contradicts. Most drift is mechanical (a new module absent
from the CLAUDE.md file table); some is caught for you by a failing test; some
needs a human eye.

## The documentation inventory

Everything below is "documentation" for the purposes of this pass:

| Surface | Files | Kind |
|---|---|---|
| Repo guide | `CLAUDE.md` | hand-maintained (the big one) |
| Public readme | `README.md`, `AGENTS.md` (vendor-neutral pointer) | hand-maintained |
| Backlog catalogs | `FEATURES.md`, `SECURITY-RISKS.md`, `SECURITY-ASSESSMENT.md` | mirrored (test-enforced §3) |
| Design docs | `docs/*.md` (ARCHITECTURE, ARCHITECTURE-ROADMAP, DECISION-BOARD-LOOPS, SANDBOX-HOST-COMMANDS, GOOGLE-AUTH, SECRET-SCANNING, FOREVERAGENT-*) | hand-maintained |
| Registries | `docs/MAINTENANCE-OWNERS.md`, `docs/MERGED-BRANCHES.md`, `docs/MERGE-STATUS.json` | hand-maintained, update-in-place per their own rules |
| Skills | `.claude/skills/*/SKILL.md` — body **and** `description` frontmatter | hand-maintained |
| Static pages | `public/{help,build,story,architecture,welcome}/index.html` + `public/build/history.md` | hand-maintained |
| Generated artifacts | `public/introspect/source-snapshot.json`, `public/introspect/source-rag.json`, `public/pulse/data.json` | **regenerate, never hand-edit** |
| Append-only ledgers | `tests/*-FINDINGS.md` (MODEL-EVAL, EVAL-BENCH, HF-BENCH) | leave alone unless you ran the battery |

## Two classes of doc invariant

### 1. Test-enforced mirrors — `npm test` names the drift

A failing test tells you the doc is stale and how to fix it. **Run `npm test`
first**; if these fail, fix them the prescribed way — do not edit the artifact
by hand:

- **`FEATURES.md` §3 ⇄ `src/features.js` catalog** (`features.test.js`). Same
  F-ids, same order — edit both in the same commit (see the **feature-board**
  skill).
- **`SECURITY-RISKS.md` §3 ⇄ `src/security-risks.js` catalog**
  (`security-risks.test.js`). Same P-ids, same order (see **security-posture**).
- **`public/introspect/source-snapshot.json` ⇄ the `src/`+`public/` tree**
  (`introspect.test.js` FRESHNESS check). Fix: **`npm run bundle`**.
- **`source-rag.json` chunk refs ⇄ the snapshot** (same suite). Fix:
  **`npm run bundle:rag`**. (See the **introspection** skill.)
- **Board façades** (`features.js`/`security-risks.js`/`panels.js`) re-export
  `board.js` — `board.test.js` pins "façade IS the core" (see **decision-boards**).

If `npm test` is green, all of the above are already in sync — you only have
prose left to review.

### 2. Hand-maintained prose — no test catches it

Nothing fails when these drift. Detect them with the greps below.

- **CLAUDE.md "Code layout" file table ⇄ `src/*.js`** — one row per non-test
  module.
- **CLAUDE.md client-module prose ⇄ `public/js/*.js`** — the long paragraph
  describing every client module.
- **CLAUDE.md "Unit tests" / "Additional server suites" prose ⇄ `*.test.js`.**
- **CLAUDE.md "Skills" bullet list ⇄ `.claude/skills/` dirs** — one `- **name**`
  bullet per skill.
- **Each skill's `description` frontmatter** — the trigger text that decides
  when it loads; keep it matching what the skill now covers.
- **README / AGENTS.md ⇄ current architecture** — the intro, the ASCII map, the
  provider/feature list.
- **The registries** — `docs/MAINTENANCE-OWNERS.md` (subsystem → owning PR),
  `docs/MERGED-BRANCHES.md` (per its own tagging rules — see **merge-branches**).

## Drift-detection commands

Run these from the repo root; each prints only the drift.

```bash
# src modules missing from the CLAUDE.md file table
for f in $(ls src/*.js | grep -v '\.test\.js' | xargs -n1 basename); do
  grep -q "\`$f\`" CLAUDE.md || echo "src not in CLAUDE.md table: $f"
done

# skills on disk missing a bullet in CLAUDE.md's Skills list
for s in $(ls .claude/skills/); do
  grep -q "^- \*\*$s\*\*" CLAUDE.md || echo "skill not in CLAUDE.md list: $s"
done

# CLAUDE.md bullets naming a skill dir that no longer exists (reverse drift)
grep -oE '^- \*\*[a-z0-9-]+\*\*' CLAUDE.md | sed -E 's/^- \*\*(.*)\*\*/\1/' \
  | while read s; do [ -d ".claude/skills/$s" ] || echo "CLAUDE.md lists missing skill: $s"; done

# client modules / test files not named anywhere in CLAUDE.md (noisier — triage by hand)
for f in $(ls public/js/*.js src/*.test.js public/js/*.test.js | xargs -n1 basename); do
  grep -q "\`$f\`" CLAUDE.md || echo "not named in CLAUDE.md: $f"
done

npm test          # the test-enforced mirrors + the two freshness checks
npm run typecheck # keeps @ts-check'd docs-as-code honest
```

The client/test grep is intentionally loose — not every helper earns its own
backtick mention, so triage its output by hand; the `src/*.js` and skills greps
are exact and any hit is real drift.

## The workflow

1. **Sync first** (see **sync-main**): `git fetch origin main` and rebase; a
   docs pass on a stale base re-introduces drift someone already fixed.
2. **Survey**: run all the drift-detection commands + `npm test`. Collect the
   real hits.
3. **Regenerate the generated artifacts** if their freshness test failed —
   `npm run bundle` and/or `npm run bundle:rag`. Never hand-edit the JSON.
4. **Update the hand-maintained prose** for each real hit: add the missing file
   table row / skill bullet / test-suite mention; fix any claim the code now
   contradicts. Match the surrounding **terse, institutional voice** — dense
   rows that say *what the module is for and how it relates to its neighbours*,
   not tutorials. Honor the **branding rule** (CamelCase `Se/cure`/`Se/rver`,
   Se/cure-first when paired) and keep internal names (DRC/DRS) out of
   user-facing copy (README, static pages).
5. **Verify**: `npm test` and `npm run typecheck` both green; re-run the drift
   greps until they print nothing.
6. **Commit + push** to the working branch with a clear message; open a PR only
   if asked (see the **pr** skill).

## Guardrails

- **Regenerate, never hand-edit** `source-snapshot.json`, `source-rag.json`,
  `public/pulse/data.json` — they are build outputs; a hand edit fails the
  freshness test or silently lies.
- **Don't rewrite append-only ledgers** (`tests/*-FINDINGS.md`,
  `public/build/history.md`, the `SECURITY-RISKS.md` history log) — they record
  what happened; only append, and only when you did the thing.
- **The file table is a `\|`-delimited Markdown table** — keep one row per
  module, description in the second cell, escape any literal `|`.
- **A new module/skill/feature is not "done" until its docs row exists.** This
  pass is the safety net; the real fix is adding the row in the same commit that
  adds the code (the mirror discipline the whole repo runs on).
- Scope: reconcile docs with code. Do **not** refactor code, "improve" wording
  for its own sake, or touch a doc the code doesn't contradict.
