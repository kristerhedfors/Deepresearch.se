---
name: introspection-help
description: >-
  Load when giving a generated agent pair SELF-INTROSPECTION — the ability to
  answer questions about its OWN implementation from the exact source the
  running deploy serves — and its double, the interactive HELP layer that
  answers usage questions verbatim from the pair's documentation. Covers the
  committed-artifact pattern (source snapshot + dense int8 RAG index, delta
  builds, freshness enforced by unit tests), the shared intent/retrieval pure
  core behind the server enrichment and both tiers' clients, the docs corpus
  with resolved symbol references and rewritten images, the skills catalog
  surfaced to answer models, the capabilities-line flip, the ONE scoped
  dev-mode exception to PA-1 (agentic source tools with a deterministic read
  loop as universal fallback), and the private-vs-remote model picker. Also
  load when a generated pair's test suite fails on a stale-artifact freshness
  check — the fix is always "regenerate", never hand-editing.
---

# Introspection & help — the pair answers for its own implementation

With a developer-mode knob on (both tiers), a conversation can ask about the
pair's OWN implementation — "how are you built?", a named repo path, "prove
the server never sees my key" — and get answered from the **real deployed
source**, not memory or denial. The same machinery doubles as the pair's
interactive help: usage questions are answered near-verbatim from the
documentation corpus (structure, images, captions included), and follow-ups
escalate into the source for proof. For an open-source pair whose privacy
claims are meant to be *auditable*, this is the mission made interactive: the
product can walk a user through its own guarantees, grounded in code.

## Capability class & tier story

**Class X — shared substrate.** One pure core under the client tree (intent
gates, sticky conversation mode, the chunker, the int8 vector codec,
retrieval, the capped context-block builder, the skills-catalog parser) is
imported by the server enrichment AND both tiers' clients (PA-7).

- **The server tier** runs the full form: a pre-pipeline enrichment embeds
  the question server-side, dense-retrieves the top-K source chunks from the
  committed index, and injects the block; tool-capable answer models may
  drive the scoped agentic source-tool loop server-side.
- **The client tier** fetches the SAME committed snapshot and docs corpus as
  public static files and builds the block browser-side (lexical retrieval —
  it has no server embedder of the matching model), keeping the server out
  of the data path entirely. A tool-capable client-tier loop runs the same
  tools browser-side on the user's own provider, and — because the VM is
  browser-reachable — may add the execution sandbox's real shell as a
  `run_bash` tool, something the server tier structurally cannot.
- **The private route (server tier)**: a model picker lets the user answer
  an introspection question "privately" — browser-direct on their own key
  through the client-tier pipeline — so the server never sees a question the
  user marked private. Private is grouped first and recommended.

## Contracts

- **PA-1** — this module owns the ONE sanctioned exception: when dev mode is
  on AND the answer model supports real tool use, the model drives an
  agentic loop over three read-only source tools (grep / read file / list
  files). It is opt-in, capability-gated, fail-soft to the deterministic
  read loop (a JSON `{"read":[...]}` round-trip on the reliable model) that
  works for EVERY model — the no-function-calling guarantee holds everywhere
  else.
- **PA-2** — every layer fails soft: no index / embed failure →
  orientation-only block (still injected); no snapshot → conversation
  unchanged; tool-loop failure → read loop; retrieval failure → the prompt
  note still carries the behavior.
- **PA-4** — the snapshot serves only public-repo material; the client tier
  fetches artifacts unauthenticated so the server logs nothing about what a
  visitor introspects; the private route keeps even the question off the
  server.
- **PA-5** — the artifacts are committed and served by the same deploy: no
  runtime GitHub fetch, no decompression dependency, nothing to drift.
- **PA-6** — the intent gates (self-reference, help-shaped, external-source,
  security-assessment) carry all supported languages with parity suites.
- **PA-7** — one pure core, server façade re-export for the tool schemas and
  executors, identity-pinned by a unit test.
- **PA-10** — freshness is TEST-ENFORCED: the unit suite fails when an
  artifact is stale, and the retrieval path is verified live on both tiers.

## Build plan

1. **The snapshot bundler** (a script, no runtime deps): walk the
   git-tracked text source files (`git ls-files` — untracked files are
   invisible by design), write them uncompressed, one JSON record per file
   (`{path, size, text}`), sorted, no timestamp — byte-deterministic — into
   a committed artifact under the client tree's public static dir. Give it a
   `--check` mode that byte-compares against the tree. Because the artifact
   is committed and deploys WITH the code it describes, "the exact source
   this deploy runs" holds **by construction**.
2. **The freshness tests.** Unit tests that fail the whole suite when (a)
   the snapshot differs from the tree (`--check`), and (b) any RAG-index
   chunk reference no longer resolves against the current snapshot's
   chunking, with a minimum file-coverage floor. CI can't re-embed (no key),
   so (b) is the correctness guarantee: retrieved TEXT is always current
   even when vectors lag semantically.
3. **The shared pure core.** In one client-tree module: the
   self-referential intent gate ("your source code", never bare "source
   code") with language parity; the sticky conversation-mode gate (any
   earlier engaging user turn keeps the mode on); a cheap path-mention
   pre-filter so ordinary chat never parses the multi-MB artifact; snapshot
   validation; the deterministic chunker (sized so the embedder's token
   window never overflows); the int8 vector codec — quantize each vector by
   its own max-abs (cosine is scale-invariant, so this is lossless for
   ranking and no scale is stored); retrieval (`{path, chunkIndex}` →
   re-chunk the snapshot to resolve text, so returned code is ALWAYS
   current); and the capped block builder — capability line, file index, an
   orientation excerpt from the project's memory file, named files inlined
   under per-file/total caps. Depth beyond the caps is the sandbox's job.
4. **The dense index builder** (a second script, needs the embed key —
   never run in CI): chunk the committed snapshot with the SHARED chunker,
   embed each chunk, store ONE int8 vector per `{path, chunkIndex}` — never
   the text. Make it resilient: a global min-interval gate on request starts
   (the provider rate ceiling), retry-never-skip on rate limits, shrink
   over-long chunks in place, binary-split then skip only a lone straggler.
   Add **delta builds**: a per-file content hash in the index; a rebuild
   re-embeds only changed/new files and reuses vectors keyed by hash AND
   current chunk-count coverage (never splice a stale vector onto shifted
   text). Exclude test files from the index (low retrieval value; still in
   the snapshot for by-path reads).
5. **The server enrichment.** Dev mode ON is the ONLY gate — ALWAYS inject;
   no intent regex decides *whether* (the reference's narrow gate produced
   stock "not a coding tool" denials). Embed the question once, dense-rank
   against the index, top-K excerpts + orientation + (only on strong
   "how are you built" intent) the full file index + named files inlined.
   Set a `hasSource` flag that flips the answer prompts' capabilities line —
   without it the model denies the capability with source in front of it.
6. **Search suppression + the external-source gate.** With own-source in
   context, default to answering FROM it with no web-search wave (the wave
   drags in unrelated third-party repos sharing the product's name).
   Re-enable search only on an explicit external-intent gate (web/cited
   sources/outward recency/comparison-vs-external), conservative by design,
   language-parity tested, and evaluated against the CLEAN pre-enrichment
   text (the injected block itself trips naive gates).
7. **The scoped tool loop (the PA-1 exception).** Three provider-neutral
   tool schemas + pure snapshot executors (grep / read file / list files)
   live in the shared core; a thin server façade re-exports them. When the
   answer model supports tool use, run the tool loop (round-capped, forced
   final answer at the cap, billed to the answer model's bucket, one visible
   activity step per call); otherwise — or on ANY failure — the
   deterministic read loop on the reliable JSON model. Feed BOTH planners
   the clean pre-enrichment text: a planner that sees the wall of injected
   excerpts concludes "I have enough" and investigates nothing.
8. **The help layer (docs corpus).** A second committed artifact pair:
   the repo's Markdown documentation as a snapshot-shaped corpus (reusing
   the validator, chunker, retrieval verbatim) with three extras — per-doc
   first-heading titles; every backticked symbol RESOLVED against the real
   tree (file + definition line + a public-repo blob link; a stopword list
   drops generic names); images copied to a served static prefix with
   references rewritten so a verbatim quote renders the real screenshot —
   plus its own dense index. Injection: docs-first for usage questions,
   quoted VERBATIM (structure, images, italic captions), symbol refs
   attached to every code name; follow-ups escalate into the source. The
   help intent gate never decides WHETHER (dev mode does), only emphasis
   (wider retrieval k, a "documentation (help)" step label). Carry worked
   examples of the docs-then-source escalation in the system prompt, and
   punch a narrow same-origin image allowlist through the chat sanitizer
   (fixed static prefixes only, no `..`, no `//`).
9. **The skills catalog.** The repo's agent playbooks (skill files) are
   tracked Markdown, so they already ride the snapshot and the index; the
   block builder additionally lists them as a first-class catalog (name +
   frontmatter one-liner) so ANY answer model in EITHER tier sees the
   institutional knowledge exists and can quote or inline a playbook by
   name — the same knowledge the pair's dev agents work from. Keep the
   catalog always-on (small, and it is the point).
10. **The client-tier wiring.** Fetch snapshot + docs corpus as public
    static files (allowlist them; make JSON revalidate per deploy), build
    the block with the shared core (lexical retrieval), thread it through
    the client pipeline like the recall block; the sandbox knob additionally
    mounts the snapshot tree at `/src` in the VM for real `grep -rn`.
11. **Gating + UI.** A per-user dev-mode knob on the server tier (grant it
    unconditionally to the break-glass admin — the testability path, but see
    Pitfalls for the eval interaction); a sealed-state flag on the client
    tier; optionally a mascot + the private-vs-remote picker with the
    private route recommended and keys held browser-only.

## Reference implementation map

| Concept | File(s) in this repo |
|---|---|
| Snapshot bundler + committed artifact | `scripts/bundle-source.mjs` → `public/introspect/source-snapshot.json` (`npm run bundle`) |
| Dense index builder (delta, int8) | `scripts/bundle-source-rag.mjs` → `public/introspect/source-rag.json` (`npm run bundle:rag`) |
| Shared pure core (gates, chunker, codec, retrieval, block, skills catalog, tools) | `public/js/introspect-core.js` (+ `.test.js`) |
| Server enrichment (always-inject, dense retrieval, `hasSource`) | `src/introspect.js` (+ freshness tests in `src/introspect.test.js`) |
| Tool façade (schemas + executors re-export, identity-pinned) | `src/introspect-tools.js` (+ `.test.js`) |
| Tool loop (server tier) / read loop | `src/anthropic.js` (`anthropicToolRun`), `src/pipeline.js` (`runSourceResearch*`), core `runSourceReadLoop` |
| Client-tier loop + `run_bash` | `public/js/drc-research.js` (`runDrcSourceTools`), `public/js/drc-providers.js` (`drcToolRun`) |
| Docs corpus + images + symbol refs | `scripts/bundle-docs.mjs` → `public/introspect/docs-corpus.json` + `docs-img/`; index `scripts/bundle-docs-rag.mjs` → `docs-rag.json` |
| Help retrieval + worked examples | `src/introspect.js` (`retrieveHelpDocs`), `src/prompts.js` (`HELP_DOCS_NOTE`), `public/cure/drc.js` (`helpDocsBlockFor`) |
| Image sanitizer exception | `public/js/markdown.js` (`isSafeDocImage`) |
| Capabilities-line flip | `src/prompts.js` (`capabilitiesTail`), threaded via `src/pipeline.js` `ctx.hasSource` |
| Mascot + picker + private route | `public/js/introspect-ui.js`, `public/js/stream.js` (`maybePrivateIntrospection`) |
| Sandbox `/src` mount | `public/js/sandbox-files.js` (`planSourceMount`) |
| External-agent pointer to the same catalog | `AGENTS.md` (repo root) |

## Acceptance checklist

- [ ] Freshness tests fail the unit suite on a stale snapshot, a stale docs
      corpus, or an index chunk-ref that no longer resolves.
- [ ] Snapshot build is byte-deterministic (two runs, identical bytes).
- [ ] Pure-core suites green: intent gates with language parity, sticky
      mode, chunker coverage/overlap properties, int8 codec round-trip,
      retrieval, block caps, skills-catalog parsing.
- [ ] Tool façade identity test proves its surface IS the core.
- [ ] Both tiers answer a "how are you built" question from real source,
      live; the model quotes files instead of denying capability.
- [ ] A usage question is answered from the docs with an inline image
      rendering; a "prove it" follow-up escalates into source.
- [ ] Tool loop verified live on a tool-capable model; a non-tool model
      transparently gets the read loop.
- [ ] Dev mode OFF ⇒ no artifact is ever fetched or parsed.

## Pitfalls

- **Never hand-edit the artifacts; regenerate in order.** Edits → snapshot
  bundle → docs bundle → dense indexes → commit everything together. The
  index chunk-map is built against the FINAL snapshot; bundling rag first
  leaves it misaligned and the consistency check names it. A SOURCE edit can
  stale the DOCS corpus too — symbol references carry definition line
  numbers, which shift.
- **A narrow intent gate produces denials** (reference chat_logs #275:
  "Code examples from site" matched nothing → stock refusal). The knob is
  the gate; always inject in dev mode.
- **Feed planners the clean pre-enrichment text.** The reference's
  "security assessment" ask summarized its own injected docs instead of
  investigating (chat_logs #289/#290) because the planner saw the excerpt
  wall; and the external-source gate false-fired on a bare "vs" inside the
  injected orientation text.
- **The embedder's window is TOKENS, not chars** — dense code runs ~2.4
  chars/token, so full-size chunks 400 with "maximum context length".
  Pre-truncate vectors to the chunker's advance (every byte stays covered);
  the retrieved text is always the full chunk.
- **Rate-limit skips make coverage holes.** Without a global request-start
  gate, a burst of retries 429s and chunks get silently skipped — the
  reference's first build did exactly that. Retry rate limits forever;
  never skip on 429.
- **New files must be `git add`ed before bundling** — the walker uses
  `git ls-files`, so an untracked new module silently vanishes from the
  snapshot and the freshness check passes anyway.
- **Committed-artifact caching:** make the JSON revalidate per deploy or
  the site serves a previous deploy's source for up to the cache TTL —
  "introspection" that describes last week's code.
- **Always-on dev mode for the admin identity breaks eval harnesses** —
  every benchmark request routes introspection-first. Accept a per-request
  OFF-only override (the incognito pattern: can disable, can never enable)
  and send it from the harnesses.
- **The snapshot must be public-repo material only.** The client tier
  fetches it unauthenticated; if the repo ever grows private files, the
  bundler's walk — not the allowlist — is the guard to fix.
