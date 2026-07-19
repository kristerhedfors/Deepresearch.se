---
name: introspection
description: >-
  Load when working on introspection mode / the developer_mode knob — the
  feature that lets a conversation ask about THIS SITE's own implementation
  and get answered from the deployed source — or anything touching
  scripts/bundle-source.mjs, public/introspect/source-snapshot.json (the
  committed snapshot artifact), public/js/introspect-core.js (the shared pure
  core), public/js/introspect-ui.js (TIN the titanium mascot + the
  private-vs-remote model picker), public/js/dev-mode.js (the client
  titanium-palette theme + the dr_dev_mode first-paint cache),
  src/introspect.js (the DRS enrichment),
  the DRS private browser-direct route (stream.js maybePrivateIntrospection),
  the /src sandbox mount (sandbox-files.js planSourceMount), or the DRC
  developerMode knob. ALSO load when `npm test` fails on "source snapshot
  artifact matches the working tree" — the fix is `npm run bundle`, never
  editing the artifact by hand.
---

# Introspection mode (developer_mode)

With the **developer_mode** knob on (both tiers), a conversation that asks
about this site's own implementation ("how are you built?", "visa mig din
källkod", or naming a repo path like `src/pipeline.js`) enters INTROSPECTION
MODE: the exact deployed source is given to the model as structured context,
and — when the execution sandbox is also on — mounted at `/src` inside the
in-browser Linux VM for real `ls`/`cat`/`grep -rn` exploration.

## How it engages (2026-07-12 redesign — READ THIS FIRST)

Developer mode being ON is the ONLY gate. There is NO intent regex deciding
whether to inject the source. The original gate (`introspectionActive` — "your
source code" / "how are you built" / a named path) was too narrow: "Code
examples from site" matched nothing, so nothing was injected and the model
gave its stock "isn't a coding tool" denial (chat_logs #275). Now, whenever
developer mode is on (`state.introspection`), `src/introspect.js` ALWAYS
appends the site's own source, built around **dense RAG retrieval**:

1. Embed the user's question server-side (Berget e5, `query:` prefix).
2. Cosine-rank it against the committed DENSE index
   `public/introspect/source-rag.json` (one int8 embedding per source chunk),
   take the top-K (6) chunks — the code relevant to THIS question, for any
   phrasing, NO VM.
3. Build the block: the retrieved excerpts + a CLAUDE.md orientation excerpt +
   (only for strong "how are you built / list files" asks) the full file index
   + any file the message names by path, inlined.
4. `hasSource` flips the answer prompts' capabilities tail
   (`prompts.js capabilitiesTail`, threaded via `pipeline.js ctx.hasSource ←
   state.introspectionCount`) so the model quotes the source instead of
   denying it.

`introspectionActive` still exists — but only to decide `includeIndex` (full
file index vs the lean "name any file" pointer) and named-file inlining, never
whether to engage. Everything is fail-soft: no rag index / embed failure →
orientation-only block (still injected, model still has source); no snapshot →
unchanged conversation.

## Introspection-first search suppression (2026-07-12)

A pure "how is X implemented / show me the code" ask in dev mode used to STILL
run the web + HF search wave, which pulled in unrelated third-party repos that
share the "deep research" name (e.g. Jina's node-DeepResearch, u14app) and
presented them as sources. The fix, in `pipeline.js runResearch`: when the
site's own source is in context (`ctx.hasSource`, i.e. dev mode on) **the
default is to answer from THAT source with NO search wave** — it routes to
`runDirectReply` (the source is already injected, `hasSource` is set) and emits
a "Answering from the site's own source — web search skipped" plan step.

The search wave is re-enabled only when the user EXPLICITLY wants outside
material, decided by `externalSourceIntent` (introspect-core.js, EN+SV per
invariant 6, Node-tested with a parity suite): explicit web/internet search,
cited/external sources, outward-facing recency ("latest news", "up to date" —
NOT bare "current"/"latest", which still read as the site's current code), or a
comparison against something external ("compare our X with …", "versus"). The
gate is deliberately CONSERVATIVE — leaning toward pure introspection is the
product intent, and a false negative just means the user re-asks with "search
the web". Note the trigger is `hasSource` (dev mode on), NOT
`introspectionIntent`: the canonical failing asks ("gimme source code
examples") don't match the intent regex at all — that's exactly why dev mode
always injects — so the intent gate can't be the signal here.

DRC has no server embedder of the right model, so it can't do dense retrieval
(the client-side provider embedders differ); it injects the snapshot block
(orientation + named files, full index on strong intent) whenever developer
mode is on — same "always on in dev mode" rule, minus retrieval.

**Off-only request override (2026-07-15):** `/api/chat` accepts
`developer_mode: false` in the body to SKIP the introspection enrichment for
that one request (never enables — the incognito pattern; `chat.js
resolveEnrichmentOptions`). Exists because developer mode is ALWAYS ON for
the break-glass admin (`settings.js` — no settings row to flip, the PUT
refuses break-glass), which made the eval harnesses structurally unable to
measure the web pipeline: every bench request routed introspection-first,
and pre-fix even quiz-triggered off the injected CLAUDE.md prose (chat_logs
#360 — the quiz gate now reads `cleanLastUser`, source-pinned in
`pipeline.test.js`). `tests/eval-bench.mjs` and `tests/model-eval.mjs`
always send it.

## Agentic source investigation — read loop + native tools (2026-07-12)

Injecting retrieved excerpts is not enough for "assess/audit/how does X work"
asks — the model would summarize the excerpts (or, worse, the repo's own
security DOCS) instead of investigating the code (the "conduct a proper security
assessment" → doc-recap UX bug, chat_logs #289/#290). So dev mode does REAL
research in the source. `pipeline.js runResearch` routes a dev-mode,
non-`externalSourceIntent` ask to **`runSourceResearch`** (NOT `runDirectReply`
— that older note is superseded), which has two paths:

1. **Native tool calling (the invariant-1 EXCEPTION, owner-authorized).** When
   the ANSWER model supports real function calling (`introspectionToolsAvailable`
   = `isAnthropicModel(model) && anthropicConfigured(env) && no images`), the
   model ITSELF drives an agentic loop with three tools — `grep_source`
   (≈ `grep -rn`), `read_file` (≈ `cat`), `list_files` (≈ `ls`) — executed
   server-side against `state.sourceSnapshot`. `src/anthropic.js`
   `anthropicToolRun` runs the Messages-API tool loop (tool_use → tool_result →
   repeat → force a final answer at the round cap, `MAX_SOURCE_TOOL_ROUNDS=6`);
   `pipeline.js runSourceResearchTools` wires it, emits a `source` step per tool
   call ("Investigated the source with N tool calls"), and bills the rounds to
   the answer model's bucket. System prompt: `prompts.js sourceToolAgentPrompt`.
2. **Deterministic read loop (fallback, every other model).** The reliable JSON
   model (Mistral) drives `runSourceReadLoop` (introspect-core.js): each round
   it returns `{"read":[...]}` JSON, the server serves those files from the
   snapshot, up to `MAX_SOURCE_READ_ROUNDS`. System prompt: `sourceAgentPrompt`;
   answer: `sourceAnswerPrompt`. This is the pure no-function-calling path.

`runSourceResearch` tries the tool path first, **fail-soft**: any provider
failure logs `introspect.tools_failed` and falls through to the read loop; a
model with no tool support skips straight to it. So catalog-wide compatibility
holds — only the tool-capable dev-mode answer path uses function calling
(invariant 1's exception; documented there and in `src/introspect-tools.js`).

**Feed the PLANNER clean text.** Both paths read `ctx.cleanLastUser` /
`ctx.cleanConvText` (built from the PRE-enrichment conversation), NOT the
excerpt-appended `lastUser`/`convText`. The enrichment appends its block to the
last user message; if the planner sees that wall of pre-loaded excerpts it
concludes "I already have enough" and reads nothing → doc-recap. `cleanLastUser`
is also what `externalSourceIntent` is tested against (the CLAUDE.md orientation
in the block trips it, e.g. a bare "vs", spuriously routing to web search).

**The tools live in the SHARED core.** `INTROSPECTION_TOOLS` + the pure
executors (`grepSource`/`readFileTool`/`listFilesTool`/`runIntrospectionTool`)
are in `public/js/introspect-core.js`; `src/introspect-tools.js` is a thin
re-export façade (the `bash-core.js`/`bash-agent.js` pattern) so BOTH tiers
share one implementation. DRC's client-side counterpart is in the
**execution-sandbox** skill (it adds a real `run_bash` tool over CheerpX).

## The load-bearing idea: ONE committed snapshot artifact

`scripts/bundle-source.mjs` (`npm run bundle`) walks the **git-tracked** text
source files and writes them — uncompressed, one JSON line per file
(`{p,s,t}`), sorted, no timestamp (deterministic) — into
**`public/introspect/source-snapshot.json`** (~3.2 MB). Because that artifact
is committed and deploys as a static asset of the same deploy that runs the
code, "the exact code that is running" holds **by construction**: no GitHub
fetch at runtime, no drift window, nothing to decompress anywhere.

Three consumers, one artifact:

1. **DRS server enrichment** — `src/introspect.js` reads it back through the
   `env.ASSETS` binding and appends the context block to the conversation
   (registered in `src/enrichment.js`, gated on `state.introspection` ←
   `developerModeEnabled` in chat.js). Standard enrichment contract: silent
   when not engaged, a visible `introspect` step when it is, fail-soft
   everywhere.
2. **The sandbox mount (both tiers)** — the browser fetches the snapshot and
   hands it to the VM boot as the `source` scope of the fileProvider
   (`stream.js` for DRS, `drc.js` for DRC). **Dev mode alone is the gate on
   BOTH tiers (2026-07-17):** DRS used to require the introspection-intent
   regexes on top, which left `/src` missing for phrasings they don't cover
   while the server enrichment claimed it was there (chat_logs #514, "Where
   is my source code") — now every dev-mode sandbox boot carries the source,
   the dev-mode pre-warm included (`prewarmSandbox`), and a live VM booted
   without it is discarded at send time (`resetSandboxIfLacking`).
   `planSourceMount` (sandbox-files.js) turns the snapshot into ONE ustar
   archive (`buildTar`, pure JS) extracted with a single `tar -xf` spawn —
   the per-file `cp` storm (463 spawns) blew the 90 s boot ceiling on a phone
   ("boot timed out at mounting files…", chat_logs #515) — plus the flat
   Tier-1 **DataDevice** ingest (`/mnt/in-src/f0…`, files at the device root
   — the no-nested-dirs discipline) with a per-file `cp` script (`.seedcp`)
   as the fallback for a guest without tar. Both scripts are written INTO
   the device (never argv); the extraction is STAMP-GUARDED (`sourceStamp` →
   `/src/.dr-stamp`, written only after a successful extraction): a boot
   whose persistent overlay already carries this exact snapshot skips the
   `rm -rf` + tar entirely (only the `/workspace/source` symlink refreshes),
   so re-boots after the first are cheap — the fix for the chat_logs #522
   wedge, where re-extracting every boot overran the seed ceiling on a phone
   and the model's `ls -l /src` then raced the still-running extraction. The
   seed run itself is time-bounded (`SEED_TIMEOUT_MS`, sandbox.js): past it
   the boot proceeds and execInSandbox WAITS for the tracked background seed
   instead of racing it (sandbox-debug skill has the event vocabulary).
3. **DRC context block** — built client-side (`introspectionContext` in
   drc.js) and threaded through the client pipeline exactly like the RAG
   recall block (`runDrcResearch({introspection, fileProvider})`). The
   snapshot is fetched as a PUBLIC static file, so the server stays out of
   the DRC data path.

**Why no Tier-2 (WebDevice + Service Worker):** the snapshot is a pre-bundled
~3 MB of raw text — far under the DataDevice memory budget — so the deferred
streaming tier is unnecessary. Raw bytes stream host→guest via
`DataDevice.writeFile` with no base64 and no unpacking in the guest. This was
an explicit design decision (2026-07-12): pre-bundle at commit time, stream
in, done.

## The shared pure core — public/js/introspect-core.js

The bash-core.js pattern: ONE implementation, served to the browser AND
imported by the Worker (src/introspect.js imports from `../public/js/`). It
holds: `introspectionIntent` (EN+SV parity per invariant 6, self-referential
phrasings only — "your source code"/"din källkod", never bare "source code"),
`introspectionActive` (the MODE is sticky: any earlier engaging user message
keeps it on; a directory-qualified snapshot path also engages it, bare
basenames deliberately don't), `maybeRepoPathMention` (the cheap pre-filter
that keeps ordinary dev-mode chat from ever fetching/parsing the multi-MB
artifact), `validateSnapshot`, and `buildIntrospectionBlock` — the labeled
block: capability line ("You DO have access…", the hasShell lesson), the full
path+bytes index, a CLAUDE.md orientation excerpt (6k chars), and named files
inlined under caps (30k/file, 60k total, 6 files). Depth beyond the caps is
the sandbox's job, not more inlining — the block rides through EVERY phase
including the ~32k-context JSON model.

## The skills catalog in the block (institutional knowledge, any model)

`buildIntrospectionBlock` also surfaces the repo's **skills catalog** as a
first-class section — `skillsCatalog` / `skillsIndex` / `mentionedSkills` in
`introspect-core.js`. The `.claude/skills/<name>/SKILL.md` playbooks are
ordinary tracked Markdown, so they already ride in the snapshot AND the dense
RAG index like any other file. The catalog section lists every skill as
`- name — one-line summary` (parsed from each SKILL.md's YAML frontmatter by
`parseSkillFrontmatter`, clipped to `SKILL_SUMMARY_CHARS`), so ANY answer model
— the whole Berget catalog plus the Anthropic/OpenAI answer models — sees the
playbooks exist and can quote them. Naming a skill the way you'd name it to
Claude Code ("the deploy skill", `/deploy`, "the feedback loop skill" —
hyphen/space tolerant) inlines its full SKILL.md via `mentionedSkills` folded
into the same named-file inlining path. Relevant skill *content* is also pulled
in automatically by dense retrieval (the SKILL.md bodies are chunked into
`source-rag.json`). This is what makes the skills — originally a Claude Code
(CLI) convention — work "regardless of model" and identically in BOTH tiers
(both call `buildIntrospectionBlock`). The catalog is intentionally always-on
(not gated on strong intent) since it's small and it's the whole point.

A vendor-neutral **`AGENTS.md`** at the repo root points *external* coding
agents (any model/harness) at the same catalog + `CLAUDE.md`, so the pickup is
also harness-agnostic. Its per-skill summaries mirror the SKILL.md frontmatter;
regenerate them with the parser if a `description` changes. `AGENTS.md` is a
tracked `.md`, so it too rides in the snapshot — self-consistent.

`parseSkillFrontmatter` / `skillsCatalog` / `skillsIndex` / `mentionedSkills`
are pure and Node-tested in `public/js/introspect-core.test.js`.

## The dense RAG index (`source-rag.json`)

`scripts/bundle-source-rag.mjs` (`npm run bundle:rag`) chunks the committed
snapshot with the SHARED deterministic chunker (`introspect-core.js
chunkSourceText`, 1400/200 — mirrors rag.js so e5's ~512-token window never
overflows), embeds each chunk, and stores ONE **int8-quantized** vector per
`{p, ci}` (path + chunk index) — NOT the text. Cosine is scale-invariant, so
quantizing each vector by its own max-abs (÷127) is lossless for ranking and
no scale is stored. Retrieval RE-CHUNKS the snapshot to resolve `{p, ci}` →
text, so the returned code is ALWAYS current even if vectors lag.

Embeddings must match the model the server embeds the query with (Berget
e5-large, 1024-d). The builder gets them via the raw Berget key — env
`BERGET_API_KEY` (current name) or `BERGET_API_TOKEN` (older name), either
works — calling Berget's `/v1/embeddings` DIRECTLY, OR, when neither key is
set, the live `/api/embed` with the break-glass creds (`BASIC_AUTH_USER`/
`PASS`) — production holds the key. It is RESILIENT (see the failure classes
below): rate-limits are paced and retried, over-long chunks are shrunk in
place, and only a persistently-failing lone chunk is ever skipped — so nothing
aborts the ~2100-chunk build. Test files (`*.test.js`, `tests/`) are excluded
from the
index (low value for "how does the app work"; still in the snapshot, so a user
can name one by path for its full text). NOT part of `npm run bundle` (that
stays pure/offline) and NOT run in CI.

**Speed & the two hard limits (2026-07-12 rebuild — full build now ~25 s / 98
requests, 0 skipped; was 4m40s).** A full rebuild embeds ~2100 chunks. Two
Berget facts shape the loop, both learned the hard way:

1. **e5's window is 512 TOKENS, not chars.** Dense code runs ~2.4 chars/token,
   so a full 1400-char code chunk is ~540 tokens and **400s** ("maximum context
   length"). The builder pre-truncates every chunk to **1200 chars** before
   embedding — the chunker's ADVANCE (target 1400 − overlap 200), so every byte
   of source stays covered by at least one chunk's vector (no gaps) while only
   the densest chunks lose a short tail. The retrieved TEXT is always the FULL
   chunk (re-chunked from the snapshot), so this trims a vector's tail, never
   what the user sees. A chunk still over 512 tokens at 1200 chars is shrunk
   further on demand (below) — never dropped.
2. **Berget caps at 300 requests/MINUTE.** A global min-interval GATE on request
   starts (default 230 ms ≈ 260/min) keeps the aggregate rate under the ceiling
   no matter how many retries/shrinks fire — single-threaded JS makes the
   gate's read-modify-write atomic across the concurrent workers. This is the
   correctness guard: without it, a burst of splits 429s and those chunks get
   SKIPPED (coverage holes) — the bug behind the 4m40s attempt.

Given those, the loop: pre-truncated batches (default 32) run through a
concurrency POOL (default 8) behind the gate. Failure classes — (a) **429 /
rate-limit** → wait 2 s and retry, NEVER skip; (b) **too-long 400** → shrink
EVERY chunk in the batch ×0.8 and retry the batch (one dense chunk poisons the
whole batch, and shrinking uniformly costs ~1 request vs the request-storm of
binary-splitting a dense-file batch down to singles; dense chunks cluster in
dense files, so the collateral trim mostly lands on already-dense chunks); (c)
**transient 5xx/network** → 2 backoff retries, then binary split, then skip a
lone straggler. Each chunk owns a unique `{p, ci}` slot, so parallel batches
never collide on write-back. Net: a full rebuild is ~70–110 requests, well
under a minute; a delta rebuild is a handful of chunks, near-instant. Tunables
(env): `INTROSPECT_EMBED_CONCURRENCY`, `INTROSPECT_EMBED_INTERVAL_MS` (gate
spacing; raise it if Berget's limit tightens), `INTROSPECT_EMBED_BATCH`.

**DELTA rebuilds (2026-07-12).** The index carries a per-file content hash
(`hashes: {p: sha256/16}`). A rebuild re-embeds ONLY files whose hash changed
(plus new files) and REUSES the existing int8 vectors for everything else — so
after a one-file edit, `npm run bundle:rag` embeds a handful of chunks in
seconds instead of re-embedding all ~2100. A FULL rebuild happens only when
there's no prior index, or the embed model / chunker params changed (all
vectors would be incomparable). The reuse is keyed by hash AND requires the old
chunk vectors to still cover the file's current chunk count, so it can never
splice a stale vector onto shifted text. The delta-built index is byte-for-byte
a normal index (same flat `vectors`/`map`), committed and served like before —
so it "follows along" into the web app with no server change; retrieval ignores
`hashes`.

**Rebuild order when source changes:** finish edits → `npm run bundle`
(snapshot) → `npm run bundle:rag` (index, against the FINAL snapshot — now a
cheap DELTA that only re-embeds the changed files) → commit all three. Doing
rag before the final snapshot leaves the index chunk-map misaligned and trips
the consistency check. Since the HELP layer (2026-07-16), a source edit can
ALSO stale the docs corpus (its symbol references carry definition line
numbers) — add `npm run bundle:docs` + `npm run bundle:docs-rag` to the pass;
the full order and the whole help layer live in the **help-docs** skill.

## The OWASP Top 10 reference corpus (security assessments)

A dev-mode conversation that asks for a **security assessment** (audit / review
/ pentest / threat model / "how secure is X", `securityAssessmentIntent` in
introspect-core.js — EN+SV parity per invariant 6) gets the OWASP Top 10 text
injected alongside the site's own source, so findings are classified against —
and quote — the actual OWASP wording. Owner directive (2026-07-13): with no
framework named, DEFAULT to the **OWASP Top 10 for LLM Applications (2025)** +
the **OWASP Top 10 for Web Applications (2021)** for structure, terminology, and
classification, plus **CVSS estimates with the uncertainty stated explicitly**.
The report leads with an **Executive Summary** (user-facing, plain language),
then **Scope**, then **Findings** (the technical per-finding detail) — that
fixed order is carried by both `OWASP_ASSESSMENT_NOTE` (prompts.js) and the
injected block (`buildOwaspReferenceBlock`).

Two committed artifacts, mirroring the source snapshot/index pair (both under
the ASSETS-excluded `public/introspect/`, server-only — DRC doesn't use them):

- **`owasp-corpus.json`** (`scripts/fetch-owasp.mjs`, `npm run fetch:owasp`) —
  the full Markdown text of all 20 categories (LLM01…LLM10 + A01…A10), fetched
  from the projects' OWN Markdown source of record (github.com/OWASP: the
  `www-project-top-10-for-large-language-model-applications` `2_0_vulns/` files
  and `Top10` `2021/docs/en/`). It is **snapshot-shaped** (`{v,digest,count,
  bytes,files:[{p,s,t}]}`, `p` = the citation id like `LLM01:2025 Prompt
  Injection`) plus a parallel `sources` map (cat/family/year/title/url) — so it
  reuses `validateSnapshot`, the chunker, and `retrieveSourceChunks` verbatim.
- **`owasp-rag.json`** (`scripts/bundle-owasp-rag.mjs`, `npm run
  bundle:owasp-rag`) — int8 vectors per `{p,ci}`, the SAME format as
  source-rag.json (Berget e5, 1024-d). Small corpus (~20 docs / ~150 chunks) →
  a single fast full build, no delta. Needs `BERGET_API_KEY`.

**Retrieval spans MULTIPLE categories, and works OFFLINE.** Two facts matter
for "quote several different vulnerabilities, self-contained":
- `diversifyByCategory` caps how many chunks come from any one OWASP category
  (default k=8, perCat=2) and backfills — so the block spans ~4-6 categories,
  not k near-duplicate chunks from the closest doc.
- `lexicalRetrieveOwasp` is an embedding-FREE TF-IDF retrieval over the corpus.
  It needs no embedder at all, so the OWASP grounding is fully self-contained:
  **DRC (Se/cure) uses it** (the browser has no Berget e5) and **DRS falls back
  to it** when the query embed is unavailable. Verified live to surface 6-7
  correct categories per query and to drive accurate multi-category quoting.

Wiring — **DRS** (`src/introspect.js`): embeds the query ONCE (`embedQuery`) and
reuses it for source retrieval and — when `securityAssessmentIntent` fires
(sticky over the conversation) — `retrieveOwasp` (dense+diversify, else lexical)
→ `buildOwaspReferenceBlock`. The block is appended to the conversation (so the
read-loop synthesis sees it via the DIRTY convText) AND stashed in
`state.owaspBlock`, which `pipeline.js runSourceResearchTools` injects explicitly
(the native-tool path reads the CLEAN pre-enrichment text). Wiring — **DRC**
(`public/cure/drc.js` `owaspBlockFor`): fetches `owasp-corpus.json` (a PUBLIC
static asset — added to `isPublicAsset`), lexical-retrieves, and appends the
block to the introspection context — server in no data path. The
`OWASP_ASSESSMENT_NOTE` in `prompts.js` (spliced into `sourceAnswerPrompt` +
`sourceToolAgentPrompt`) AND the instruction inside `buildOwaspReferenceBlock`
both carry the default + the report structure, so it holds even if retrieval or
the prompt is bypassed.

**Verify multi-source quoting:** `npm run verify:owasp`
(`scripts/verify-owasp-quotes.mjs`, needs `BERGET_API_KEY`) drives real models
with the injected block (dense AND lexical) and asserts ≥2 distinct OWASP
categories are quoted VERBATIM (a ≥60-char fragment of a retrieved chunk found
in the answer — a match can only come from the provided text, not memory). A
live-verify tool, not a unit test; not in CI.

Refresh: `npm run fetch:owasp` → `npm run bundle:owasp-rag` → commit both. The
freshness test in `src/introspect.test.js` (mirrors the source-rag one) enforces
every owasp-rag `{p,ci}` still resolves against the corpus chunking and all 20
docs are covered. Not part of `npm run bundle`, not run in CI (network / key).

## Freshness discipline

`src/introspect.test.js` enforces two things and **fails `npm test`** on
either: (1) `node scripts/bundle-source.mjs --check` — the snapshot matches the
tree; (2) the rag index's every `{p, ci}` still resolves against the current
snapshot's chunking (no stale refs) and covers ≥90% of files. CI can't
re-embed (no key), so #2 is the correctness guarantee — the retrieved TEXT is
always current; vectors may lag semantically until someone re-runs
`npm run bundle:rag`. So: touch a bundled source file → `npm run bundle` →
`npm run bundle:rag` → commit all three (source, snapshot, rag). New files must
be `git add`ed BEFORE bundling (the walker uses `git ls-files`). Never
hand-edit the artifacts.

## Gating

- DRS: `developer_mode` in `src/settings.js` (sixth knob, default OFF, needs
  only a user row; break-glass admin gets it unconditionally — the
  testability path). In the account panel's Settings view the capability is
  now driven by the **Chat mode dropdown** (`account-views.js` MODE_INFO /
  `wireModeKnob` — picking Introspection/SDK turns developer_mode on,
  Research turns it off), which replaced the old Introspection on/off switch.
- DRC: `state.developerMode` in the sealed project state (`drc-core.js`),
  knob in the settings drawer (`#devpanel` in cure/index.html).
- No /api/chat protocol change: the SERVER decides from the knob + the
  conversation it already receives; the client mirrors the same shared gate
  only to decide the sandbox mount.

## TIN — the mascot, the model picker, and the private route

`public/js/introspect-ui.js` is the user-facing side (DOM/browser glue, no
`@ts-check`, verified live — screenshot 2026-07-12). It's a self-styled
component (injects its own scoped `#iui-*` CSS, the sandbox-panel precedent)
served on BOTH tiers, so it's in `isPublicAsset`.

- **TIN** is the introspection mascot — a **titanium-white** robot (dome +
  antenna + visor, silver/white fills, slate strokes), deliberately its OWN
  palette next to the blue tier and khaki DRC. Same choreography as the
  landing ghost: slide in on the wrapper transition, dance→settle keyframes
  on the body, a waving arm. Triggers: `noteIntrospectionText` (debounced, as
  the user TYPES an introspection ask — so the route can be chosen before
  send, wired in app.js/drc.js) and `engageIntrospection` (on an actual
  engaged send). Dismiss = ✕, outside pointerdown, or `prefers-reduced-motion`
  skips the animation.
- **The picker (DRS)** answers "who answers?": private (the user's own
  provider key, browser-direct) vs remote (this site's server models from
  `/api/models`). Grouping/labeling is the PURE `groupIntrospectionModels`
  (introspect-core.js, Node-tested): **private group FIRST, 🔒-marked, green,
  and auto-selected as the recommendation** — the privacy-obvious choice the
  user asked for; remote is ☁-badged "remote (this site's server)". A note
  line under the select spells out the current choice's privacy meaning
  (option styling is unreliable on mobile, so the note carries the
  understanding). Keys are entered/removed inline, stored in localStorage
  `dr_introspect_keys` (browser-only, never sent to this site's server); the
  picked route is `dr_introspect_choice`. On DRC the panel is informational —
  everything is already browser-direct.
- **The private route (DRS)** — `stream.js` `maybePrivateIntrospection`:
  when developer mode is on, the conversation is introspection-engaged, AND a
  private model is picked (`privateIntrospectionRoute()`), the ENTIRE exchange
  runs browser-direct through the client pipeline (`runDrcResearch` on the
  user's key) — `/api/chat` is never called, so the server sees nothing of an
  introspection question the user marked private. It settles entirely inside
  `runPrivateIntrospection` (before the watchdog/recovery setup), reusing the
  page-lifetime snapshot cache; Stop aborts the same controller. When a
  **remote** model is picked instead, the normal server path runs but
  `introspectionRemoteModel()` overrides the composer's model. Accessors are
  Node-tested (`introspect-ui.test.js`, localStorage-stubbed); the DOM is
  verified live.

## Allowlist / caching facts

- `/js/introspect-core.js` and `/introspect/source-snapshot.json` are in
  `isPublicAsset` (the /cure module graph imports the core; DRC fetches the
  snapshot unauthenticated). The repo is public on GitHub — serving the
  snapshot exposes nothing new.
- `.json` was added to ASSET_REVALIDATE (src/assets.js) so the snapshot
  revalidates per deploy instead of serving a previous deploy's source for
  up to an hour.

## Observability

- Server: the `introspect` step in the activity stream; `introspect.applied`
  / `introspect.snapshot_*` log lines; `introspection: 0|1` in
  `chat.complete` and the chat_logs meta (scripts/chatlogs).
- Client mount: `sandbox.fs.plan`/`sandbox.fs.mount` carry `source_files`;
  `client_diag.fs.src` is the per-exchange source-mount file count.

## Still owed (live-verify)

Verified 2026-07-12 in a local Chromium harness: TIN renders, the picker
groups private-first/remote-badged with the recommended private option
auto-selected, zero console errors. Still owed on the DEPLOYED site: the /src
mount readable in-guest on a real browser (`ls -l /src` fast on a SECOND
dev-mode boot — the stamp-guarded skip — and the seed-busy fail-soft on the
first), the DRS enrichment step + the private browser-direct
route end to end with a real provider key (confirm the cross-origin provider
fetch is unaffected by COEP `require-corp` when the sandbox knob is also on —
the skill says CORS fetch is fine, verify it), and DRC introspection on a real
key — same live-verification discipline as the rest of the sandbox work.
