---
name: help-docs
description: >-
  Load when working on HELP MODE — the documentation-first layer of
  introspection (introspection is also the site's interactive help): the
  committed docs corpus (scripts/bundle-docs.mjs →
  public/introspect/docs-corpus.json + the copied docs-img/ images), its dense
  index (scripts/bundle-docs-rag.mjs → docs-rag.json), the help gate/block in
  public/js/introspect-core.js (helpIntent, buildHelpDocsBlock,
  docsCorpusMeta, helpSymbolRefs), the DRS help retrieval in src/introspect.js
  (retrieveHelpDocs, state.helpBlock), the HELP_DOCS_NOTE worked examples in
  src/prompts.js, DRC's helpDocsBlockFor (public/cure/drc.js), or the
  same-origin doc-image allowlist in public/js/markdown.js (isSafeDocImage).
  ALSO load when `npm test` fails on "docs corpus artifact matches the working
  tree" — the fix is `npm run bundle:docs` (NEVER hand-editing the artifact),
  and note a SOURCE edit can trip it too (symbol definition lines shift).
---

# Help mode — the documentation-first layer of introspection

Owner directive (2026-07-16): **introspection is also the site's interactive
help** — ONE interface for every depth of question, from "what does the ghost
button do?" down to "prove the server never sees the vault key". The split:

- **The documentation is the FIRST layer.** A usage / how-do-I / what-is
  question is answered FROM the committed docs corpus, mirroring the
  documentation near-verbatim — structure, wording, links, **images with the
  italic caption under them**, and **symbol references resolved to the
  source** (file, line, GitHub link) attached to every code name shown.
- **The source is the DEEPER support level.** A follow-up that asks how
  something is implemented, challenges a documented claim, or wants proof
  escalates into the source-investigation machinery introspection already has
  (retrieved excerpts → native tools → read loop) and ends in a PROVABLE
  conclusion grounded in code actually read. The system prompt carries WORKED
  EXAMPLES of exactly this flow (`HELP_DOCS_NOTE` in src/prompts.js, EN + SV).

Same gate as introspection: the `developer_mode` knob, both tiers. Same
no-brittle-gate rule as the 2026-07-12 source-injection redesign: in dev mode
the docs block is ALWAYS retrieved and injected — `helpIntent` (EN+SV,
invariant 6, Node-tested) never decides WHETHER, only the EMPHASIS (a
help-shaped ask widens retrieval k 4→8 and labels the step "documentation
(help)").

## The two committed artifacts (the owasp-corpus pattern)

- **`public/introspect/docs-corpus.json`** (`scripts/bundle-docs.mjs`,
  `npm run bundle:docs`) — the repo's whole Markdown documentation (root
  `*.md` + `docs/*.md`, minus MERGED-BRANCHES.md; the skills already ride in
  the source snapshot's catalog) as a SNAPSHOT-SHAPED corpus
  (`{v,digest,count,bytes,files:[{p,s,t}]}`) so it reuses `validateSnapshot`,
  the chunker, and `retrieveSourceChunks` verbatim. Three help extras ride
  alongside:
  - `sources` `{docPath:{title}}` — first-heading titles for attribution.
  - `symbols` `{docPath:[{sym,file,line?}]}` — every backticked symbol in the
    doc RESOLVED against the real tree: tracked file paths as-is, bare
    identifiers located at their definition site (a small tiered
    export/function/const regex index over src/, public/js/, public/cure/,
    scripts/). A stopword list drops generic property names (`id`, `label`,
    `state`, …) that would resolve to arbitrary sites.
  - `repo` — the GitHub blob base (derived from the origin remote) so
    references render as clickable links; the repo is public.
- **`public/introspect/docs-rag.json`** (`scripts/bundle-docs-rag.mjs`,
  `npm run bundle:docs-rag`) — one int8 vector per `{p,ci}`, IDENTICAL format
  to source-rag/owasp-rag (Berget e5-large 1024-d, passage prefix, needs
  `BERGET_API_KEY`/`BERGET_API_TOKEN`). Small corpus → single fast full
  build, no delta.

## Images — how docs screenshots reach the chat

Docs embed images by relative path (docs/ENCRYPTION.md → `img/encryption/…`)
that the site never served. The bundler COPIES every referenced, tracked,
≤2 MB image to `public/introspect/docs-img/<repo path>` and REWRITES the
reference in the corpus copy to that absolute URL — so a verbatim quote of the
documentation renders the real screenshot inline.

The chat's sanitizer forbids `<img>` (the tracking-pixel/exfiltration class).
The ONE exception is `isSafeDocImage` (public/js/markdown.js): a DOMPurify
hook admits only the fixed same-origin static prefixes `/introspect/docs-img/`
and `/help/img/` (no `..`, no `//`) and tags them `.doc-img` (styled in
app.css + drc.css — bumping the CSS↔JS handshake went with it, h41→h42). Do
NOT widen that allowlist without the same third-party-request reasoning.

Both the corpus and `/introspect/docs-img/*` are in `isPublicAsset`
(src/assets.js) — DRC fetches the corpus browser-side and images must render
on both tiers; it is all public-repo material. The dense docs-rag.json stays
DRS-only (ASSETS binding).

## Retrieval + injection wiring

- **DRS** (`src/introspect.js`): the enrichment reuses the ONE query embedding
  for source AND docs retrieval; `retrieveHelpDocs` runs dense
  (`diversifyByCategory` — doc paths carry no space, so the "category" is the
  whole path = a per-doc cap) with lexical TF-IDF fallback
  (`lexicalRetrieveCorpus` — `lexicalRetrieveOwasp` is now a pure alias of
  it). The block (`buildHelpDocsBlock`) is appended to the conversation AND
  stashed in `state.helpBlock`, which `pipeline.js runSourceResearchTools`
  injects explicitly (the native-tool path reads the CLEAN pre-enrichment
  text — the owaspBlock pattern). The read-loop planner prompt
  (`sourceAgentPrompt`) lets a docs-answered help question reply
  `{"done":true}` immediately, so simple usage questions don't spin the read
  loop.
- **DRC** (`public/cure/drc.js` `helpDocsBlockFor`): fetches the corpus once
  (public static file), lexical-retrieves, appends the block to the
  introspection context — the server stays in no data path.
- The instruction rides INSIDE the block (docs-first, verbatim images +
  captions, attach symbol refs, escalate to source for proof) AND in the
  always-spliced `HELP_DOCS_NOTE`, so the behavior holds even when retrieval
  fails soft.

## Regeneration — the full order when things change

`npm test` enforces freshness (src/introspect.test.js): `bundle-docs.mjs
--check` byte-compares the corpus AND the copied images; the docs-rag check
enforces every `{p,ci}` resolves against the current corpus chunking with full
doc coverage (skips only while the artifact doesn't exist yet).

**A SOURCE edit can stale the docs corpus** — symbol references carry
definition LINE NUMBERS, so editing a file a doc references shifts them. The
complete order after any edit session:

```bash
npm run bundle           # source snapshot (if any bundled source changed)
npm run bundle:docs      # docs corpus (if any doc OR referenced source changed)
npm run bundle:rag       # source dense index (delta — needs the key)
npm run bundle:docs-rag  # docs dense index (full, fast — needs the key)
npm test                 # freshness checks name any step you missed
```

Never hand-edit the artifacts. New docs/images must be `git add`ed BEFORE
bundling (`git ls-files` is the walker).

## Extending

- **New documentation file**: root `*.md` and `docs/*.md` are picked up
  automatically; other locations need a `DOC_INCLUDE` entry in
  scripts/bundle-docs.mjs. Rebuild both artifacts.
- **New image location**: only tracked images referenced by a bundled doc are
  copied; nothing else to do. If a NEW serving prefix is ever needed,
  isSafeDocImage + isPublicAsset must both learn it — think before widening.
- **Tuning the gate**: helpIntent lives in introspect-core.js with an EN+SV
  parity suite (invariant 6) — extend both languages and the tests together.
- **The worked examples** (`HELP_DOCS_NOTE`): keep them pointing at REAL
  files/flows (they're structurally asserted in src/prompts.test.js); update
  them if the referenced flows move.

Companion skills: **introspection** (the mode this layer rides on),
**update-docs** (keeping the documentation itself current — which now also
means rebuilding these artifacts).
