---
name: anti-ai-smell
description: >-
  Load when removing "AI smell" (AI slop, LLM writing tells) from documentation
  prose — "de-smell the docs", "these docs read like AI wrote them", "make the
  README sound human", "strip the AI tells", regenerating an AI-generated doc so
  it reads like a person wrote it, or wiring a prose linter that flags AI writing
  patterns. This is also THE CLEAN STEP wired into every documentation pipeline
  (owner directive, 2026-07-23): whenever a doc is updated or changed — via
  update-docs, docs-drift-validation, pr, or a hand edit — the pass here runs
  last, in place, so the file that lands is "Cleaned". So ALSO load this as the
  final tail of any doc-writing pass, even one you didn't start for style. Covers
  the tell taxonomy (references/ai-tells.md — vocabulary fingerprints, phrase
  templates, structural + epistemic tells), the two de-smell modes (lint-guided
  edit vs. full regeneration + fact-verify), the fact-preservation contract
  (facts/invariants/dated-directives/branding kept verbatim), and the runnable
  Vale style under vale/. This is the ONE place where rewriting doc prose for
  STYLE is the goal — the update-docs skill deliberately does not do that;
  docs-drift-validation owns capability/posture correctness. Applies to .md /
  documentation files ONLY — never rewrite source code prose or comments in this
  pass unless the owner says so.
---

# Remove AI smell from documentation

AI-generated docs carry statistical fingerprints — vocabulary spikes, phrase
templates, structural symmetry, flat epistemic texture — that read as machine
prose. This skill removes those tells while keeping every fact intact. It is a
STYLE pass, and it is the only skill in this repo whose job is to change how the
prose reads. `update-docs` reconciles docs with code and explicitly does *not*
rewrite for style; `docs-drift-validation` owns whether a capability/posture
claim is still true. Stay in your lane: texture, not facts.

## The Clean step ("Cleaned") — the pipeline tail

Owner directive (2026-07-23): treat AI-smell removal as **the standard final
step of every documentation pipeline**, not an occasional chore. Any pass that
writes or changes a doc ends by running this skill on the files it touched,
editing them **in place**, so the committed version is the Cleaned one. We keep
only that: no smelly draft to clean up later — the touched doc leaves the pass
Cleaned, or the pass isn't done.

Where the Clean step is wired in (each of these skills points back here):

- **update-docs** — after reconciling prose with code, Clean every doc you
  edited before the verify/commit step.
- **docs-drift-validation** — Clean any prose you reconciled (Class M) or
  rewrote after owner sign-off (approved Class C) before closing out.
- **pr** — if the branch diff touched documentation prose, confirm those files
  are Cleaned before the green gate.
- **any hand edit** — if you change a doc's prose for any reason, Clean the
  paragraphs you touched in the same edit.

Scope of a wired Clean step (as opposed to an owner-requested full de-smell of a
whole file): touch the prose the pass **actually changed or added**, plus any
smell it sits next to, under the same fact-preservation contract below. You are
Cleaning your own new/edited text, not re-styling untouched paragraphs — that
keeps the diff reviewable and avoids churn on prose the owner didn't ask about.
Use Mode A (lint-guided in-place edit) by default; Mode B (full regeneration) is
still owner-requested only.

The **`docs/clean/` review candidates + the Original⇄Cleaned toggle**
(`bundle-docs-clean.mjs`, `public/js/doc-variant.js`, `/docs`) are the SEPARATE
compare-and-decide surface where the owner reviews de-smelled whole-file
candidates against the originals; the wired Clean step above operates on the
authoritative doc directly and does not go through that staging.

## Scope guard (read first)

- **Documentation files only** — `*.md`, README, static-page prose, skill
  bodies. **Do not rewrite source code, code comments, or identifiers** in a
  de-smell pass (owner constraint, 2026-07-22). The source-code section of the
  tell rubric is reference for when a doc *discusses* code style, not a licence
  to edit code.
- **Never touch generated artifacts** — `source-snapshot.json`,
  `source-rag.json`, `pulse/data.json`, the docs-corpus/rag bundles. They are
  build outputs; a hand edit fails the freshness test. If a de-smell edit to a
  tracked `.md` or source-of-truth changes them, regenerate per **update-docs**
  (`npm run bundle:docs` etc.), never by hand.
- **Never rewrite append-only ledgers** — `tests/*-FINDINGS.md`,
  `public/build/history.md`, the `SECURITY-RISKS.md` history log,
  `docs/DOC-DRIFT-LOG.md`, `docs/MERGED-BRANCHES.md`. They record what
  happened; leave the prose as written.

## The fact-preservation contract

The one rule that outranks every stylistic fix:

> Preserve every fact, number, invariant, dated directive, branding form, and
> code identifier **verbatim**. De-smelling changes prose texture, never
> meaning. A slightly AI-flavoured true sentence beats a clean false one.

Concretely, keep untouched: version numbers and limits (`cpu_ms = 300_000`,
1024 dims), secret/variable names, file and route paths, the dated owner
directives, the **branding rule** (CamelCase `Se/cure`/`Se/rver`, Se/cure-first
when the pair is named — see `docs/BRANDING.md`), and the "still experimental,
not production-ready" framing the mission requires. Internal names (DRC/DRS)
stay out of user-facing copy.

## The tell taxonomy

Full rubric with fixes and the vocabulary/phrase lists:
**`references/ai-tells.md`**. The short version:

- **Structural** — tricolon reflex, symmetric sections, throat-clearing
  openers, clean wrap-ups, rhetorical-question scaffolding, bold/emoji excess.
- **Epistemic** — no situated author, uniform confidence, vague attribution,
  fake hedging.
- **Sentence-level** — nominalization, copula inflation ("serves as"→"is"),
  adverb inflation, verb upgrading, participle chains, negative parallelism
  ("not just X, it's Y"), em-dash overuse.
- **Vocabulary fingerprints** — delve, leverage, utilize, foster, underscore,
  showcase, boast, tapestry, pivotal, comprehensive, robust, seamless, myriad,
  and kin (full table + plain swaps in the rubric).
- **Phrase templates** — "In today's fast-paced world," "it's important to note
  that," "plays a crucial role," "when it comes to."

## Two modes

Pick per the owner's instruction for the pass.

### A. Lint-guided edit (default, lowest risk)

Edit in place; touch only smelly prose; leave everything else byte-for-byte.
Best for invariant-heavy docs where a regeneration could silently drop a dated
directive.

1. Run the Vale style (below) to get a hit list.
2. For each hit, apply the rubric fix — but only when it doesn't cost a fact.
3. Read the whole doc once by hand for the structural/epistemic tells Vale
   can't see (section symmetry, throat-clearing, clean wrap-ups).
4. `git diff` — every change should be prose texture; a changed number, path,
   or directive is a bug in your edit.

### B. Full regeneration + fact-verify (owner-requested, higher effort)

Rewrite the doc fresh in a human voice from the source of truth, then verify
every claim survived.

1. **Gather ground truth** — read the actual sources the doc describes
   (`wrangler.toml`, `package.json`, `src/`, the code it documents), not just
   the old doc. The old doc may itself be wrong.
2. **Build a fact inventory** — list every checkable claim in the OLD doc
   (numbers, secret names, paths, steps, tables). This is your checklist.
3. **Write fresh** — human voice, house terseness, no tells, branding honored.
4. **Verify** — walk the fact inventory against the NEW doc AND against the
   real sources. Every fact present and correct. Flag anything the old doc
   asserted that the code contradicts (that is Class C drift — do NOT silently
   "fix" it; surface it per **docs-drift-validation**).
5. **Diff-review** — read old vs. new side by side for dropped facts.

Regeneration is riskier precisely because dropped facts don't announce
themselves. Never regenerate an append-only ledger or a generated artifact.

## The Vale style (mechanical hit list)

A runnable Vale config lives under `vale/` — a vendored `AISmell` style
(vocabulary fingerprints, phrase templates, negative parallelism, vague
attribution, copula inflation, promotional tone, em-dash density). It is kept
inside this skill deliberately: it is documentation tooling, not wired into
`npm test` or CI, so it never gates a build. Run it on demand:

```bash
# needs vale installed (brew install vale / go install / release binary)
vale --config=.claude/skills/anti-ai-smell/vale/.vale.ini README.md
vale --config=.claude/skills/anti-ai-smell/vale/.vale.ini docs/
```

Severity is `suggestion`/`warning`, never `error` — this repo's docs are dense
and technical, so treat every hit as "look here," not "must change." Many
flagged words have a legitimate use; the fact-preservation contract wins over
any lint hit.

Rule files (`vale/styles/AISmell/`):

- `Vocabulary.yml` — AI-favoured words → plain swaps (substitution).
- `Phrases.yml` — throat-clearing / filler phrase templates.
- `NegativeParallelism.yml` — "not just X, it's Y".
- `VagueAttribution.yml` — "studies show", "experts agree".
- `Copula.yml` — "serves as / acts as / functions as" → "is".
- `Promotional.yml` — "powerful / robust / seamless / game-changer".
- `EmDashDensity.yml` — flags files that lean on em-dashes.

To extend: add a token to the relevant `.yml`, or vendor upstream lists
(vale-ai-tells, no-slop) into a new file under the same style. Keep severity low.

## Relationship to the rest of the repo

- **update-docs** — reconciles docs with code (mechanical drift). Runs first if
  the doc is also stale; then de-smell the reconciled prose.
- **docs-drift-validation** — owns capability/posture correctness and the
  owner sign-off loop. A de-smell edit must never change what a doc *claims* the
  app can do; if it would, that's Class C drift — stop and escalate.
- **BRANDING.md / slash-spacing** — the naming rule de-smelling must honor.
