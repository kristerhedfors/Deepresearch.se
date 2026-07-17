---
name: docs-drift-validation
description: >-
  Load when validating the CANONICAL documentation against the actual source
  code — "validate the docs against the code", "has the documentation
  drifted", "are the architecture/privacy docs still true", "rebuild the docs
  from the code up" — or after any batch of source changes when the
  higher-level description (capability, architecture, privacy/security
  posture) may no longer match what the code demonstrably does. Builds on
  update-docs (which owns the mechanical reconciliation): adds the
  doc-age-vs-code-age DRIFT SCAN (source commits since each doc's last
  touch), the BOTTOM-UP layer walk (code → technical mirrors → subsystem
  docs → narrative/posture surfaces), the mechanical-vs-posture drift
  classification, and the OWNER SIGN-OFF loop — capability/posture drift is
  direction-ambiguous (the CODE may be the bug), so it is never rewritten
  silently: every Class C finding goes to the owner (AskUserQuestion
  in-session, a flagged [DRIFT] PR otherwise) and lands only with an
  explicit checkmark, recorded in docs/DOC-DRIFT-LOG.md. Also load when a
  change you are ABOUT to make would alter what the docs say the application
  can do or how private it is — that is Class C drift being born.
---

# docs-drift-validation — validate the canon against the code, bottom-up

`update-docs` reconciles the documentation surface mechanically (missing
rows, stale lists, regenerate rules). This skill is the layer above it: it
treats the code as ground truth for **what the application does**, walks the
documentation from the technical bottom to the narrative top, and — the part
update-docs deliberately does not do — refuses to silently rewrite any
**capability or posture claim**. When the code, read on its own, implies a
different answer to *what can this application do*, *how is it architected*,
or *what is its privacy/security posture* than the canon states, that is a
real drift in the capability/posture surface, and **only the owner can say
which side is wrong**. The skill's job is not finished when the diff is
written; it is finished when the owner's checkmark comes back.

(Owner directive, 2026-07-17: capability/posture drift must be validated by
the project owner — the skill must reach the human and get an explicit
approval back before the canon changes.)

## The layer model (validate strictly bottom-up)

| Layer | Surfaces | Rule |
|---|---|---|
| **L0 — ground truth** | `src/`, `public/`, `sdk/`, `wrangler.toml`, `package.json` scripts | The code is what the application *does*. Never edited by this skill. |
| **L1 — technical mirrors** | `docs/CODE-LAYOUT.md`, `docs/TESTING.md`, the test-enforced catalogs (`FEATURES.md` §3, `SECURITY-RISKS.md` §3), the generated artifacts (`public/introspect/*.json`, `public/pulse/data.json`) | Docs follow code, mechanically. Fix directly via **update-docs** (its greps, its regenerate rules). |
| **L2 — subsystem / design docs** | `docs/PRIVACY-MODEL.md`, `docs/ARCHITECTURE.md`, `docs/SERVER-TOKENS.md`, `docs/ENCRYPTION.md`, `docs/AGENT-PAIR-SDK.md`, `docs/WORKSPACE-*.md`, `docs/PIPELINE-LANGUAGE.md`, the rest of `docs/*.md` | Mixed: they *describe* the code AND *state intent*. Mechanical parts fix directly; claim-level parts classify below. |
| **L3 — narrative & posture** | `CLAUDE.md` (mission, load-bearing invariants), `README.md`, the static pages `public/{architecture,build,story,help,welcome}/`, each skill's `description` | Stated intent and posture. Code contradicting these is a **finding**, not a doc edit. |

Walk upward in order. Do not touch L2/L3 prose before L1 is reconciled —
half of the apparent high-level drift evaporates once the mirrors are fixed,
and what remains is the real signal. After each layer, ask the propagation
question: *does anything I just changed at this layer make a claim one layer
up false?* That question, asked layer by layer, is how low-level changes
surface as high-level drift instead of hiding under it.

## Step 1 — the age scan (drift since the docs were last updated)

Docs don't record their own review date; git does. For each canonical doc,
list the source commits that landed **after** the doc's last touch — those
commits are the only places new drift can hide, so recent source changes get
first attention:

```bash
for doc in docs/CODE-LAYOUT.md docs/TESTING.md docs/PRIVACY-MODEL.md \
           docs/ARCHITECTURE.md docs/SERVER-TOKENS.md docs/ENCRYPTION.md \
           docs/AGENT-PAIR-SDK.md README.md CLAUDE.md; do
  last=$(git log -1 --format=%H -- "$doc")
  echo "== $doc (last touched $(git log -1 --format=%cs -- "$doc"), \
$(git rev-list --count "$last"..HEAD -- src/ public/ sdk/) source commits since)"
  git log --oneline "$last"..HEAD -- src/ public/ sdk/
done
```

Narrow the pathspec per doc — the canonical docs name their modules in
backticks, which **is** the doc→source mapping:

```bash
grep -oE '`[a-z0-9./_-]+\.(m?js)`' docs/PRIVACY-MODEL.md | tr -d '`' | sort -u
# → scan only commits touching those files for THAT doc's drift
```

The scan is commit-ordered, not date-ordered: a source commit landing the
same day as the doc's last touch still counts (verified 2026-07-17 —
`docs/*` at `6ae9266`, two later source commits the same day). Zero commits
since = that doc cannot have new drift; skip it. Read the surviving commits'
diffs against the doc's claims — that is the actual validation.

## Step 2 — classify every drift found

**Class M — mechanical.** Renamed/added/removed modules, stale file tables,
command names, counts, lists, test-suite mentions. Fix directly in the
normal working branch, following **update-docs** (its voice, branding, and
regenerate rules). No sign-off needed beyond the ordinary merge.

**Class C — capability / posture.** The code now implies a different answer
than the doc states to any of: what the application can do, how it is
architected, or what its privacy/security posture is. Concrete shapes in
this repo: a new data path that lets Se/cure content touch the server; a
third grant exception beyond the two in invariant 4; a pipeline phase using
function calling outside the one authorized exception; an outbound request
carrying more than the documented minimum; a new third-party integration;
`chat_logs` capturing something the incognito promise excludes; the answer
to "where does user data rest" changing.

Class C is **direction-ambiguous**, which is exactly why it can't be
auto-fixed: either (a) the change is intended evolution and the canon needs
rewriting, or (b) the code has drifted from the stated posture and the
**code is the bug** — the doc is the spec. A session cannot know which;
choosing wrongly either falsifies the canon or cements a regression. Only
the owner can pick the direction.

## Step 3 — the owner sign-off loop (Class C only)

1. **Write the finding**, one per distinct drift: the claim as documented
   (doc + quoted line), what the code now does (`file:line`), the commits
   that introduced it (from the age scan), and BOTH proposed resolutions —
   the doc rewrite if intended, the code fix if regression.
2. **Reach the owner.**
   - *Interactive session:* `AskUserQuestion` per finding — options
     "Intended — update the docs as proposed", "Regression — the docs
     stand, fix the code", plus discussion.
   - *Autonomous session:* land Class M fixes normally, but put each Class C
     doc change in its **own focused PR titled `[DRIFT] …`** with the
     finding as the body. `subscribe_pr_activity` immediately (standing
     owner directive) and schedule a `send_later` check-in ~1 h out.
     **Never merge a [DRIFT] PR yourself**, even though direct merges are
     otherwise allowed in this repo — the owner's merge or explicit
     approving comment IS the checkmark.
3. **On the checkmark:** land the approved side. If the verdict is
   "regression", the doc stays and the code fix routes back through
   **feature-maintenance** (comment on the owning PR) or a fresh fix branch;
   posture regressions also belong on the **security-posture** register.
4. **Record it** — append to `docs/DOC-DRIFT-LOG.md` (format in the file's
   header): date, finding, verdict, how the checkmark was given (PR # /
   AskUserQuestion), action taken. The ledger is what lets the next run
   distinguish *validated* posture changes from unexamined ones.
5. **No checkmark = no change.** A Class C finding parked in its open
   [DRIFT] PR is the *correct* end state until the owner answers. Do not
   time out into self-approval; re-nudge via the scheduled check-in instead.

## Verify & close

- `npm test` + `npm run typecheck` green; editing `docs/*.md` stales the
  committed docs corpus — fix with `npm run bundle:docs` (and
  `bundle:docs-rag`), never by hand (see **help-docs**).
- Re-run the age scan: every doc you reconciled now postdates the source
  commits it covers, so the next run starts clean.
- Doc rewrites honor **branding** (Se/cure-first, CamelCase display, no
  DRC/DRS in user-facing copy) and each surface's own voice.

## Guardrails

- **Bottom-up strictly.** L3 edits before L1/L2 are reconciled produce
  narrative patches over stale technical facts.
- **Never silently rewrite a capability or posture claim** — not in
  CLAUDE.md's invariants, not in PRIVACY-MODEL, not in README, not in the
  static pages. That includes "small" wording softening: weakening "never"
  to "normally" is a Class C change.
- **One [DRIFT] PR per finding.** A mega-PR forces the owner to approve or
  reject drift wholesale; separate findings get separate checkmarks.
- **This applies to changes you are authoring, too.** If your own feature
  branch changes what the docs may claim (a new data path, a new grant, a
  new integration), flag it as Class C in your PR body instead of quietly
  updating the posture docs — same checkmark rule.
- Scope: this skill validates and escalates. The mechanical fixing rules
  (inventory, greps, regenerate commands, prose voice) live in
  **update-docs** — load it, don't duplicate it.
