---
name: introspection
description: >-
  Load when working on introspection mode / the developer_mode knob — the
  feature that lets a conversation ask about THIS SITE's own implementation
  and get answered from the deployed source — or anything touching
  scripts/bundle-source.mjs, public/introspect/source-snapshot.json (the
  committed snapshot artifact), public/js/introspect-core.js (the shared pure
  core), public/js/introspect-ui.js (TIN the titanium mascot + the
  private-vs-remote model picker), src/introspect.js (the DRS enrichment),
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

DRC has no server embedder of the right model, so it can't do dense retrieval
(the client-side provider embedders differ); it injects the snapshot block
(orientation + named files, full index on strong intent) whenever developer
mode is on — same "always on in dev mode" rule, minus retrieval.

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
   (`stream.js` for DRS, `drc.js` for DRC). `planSourceMount`
   (sandbox-files.js) turns it into a flat Tier-1 **DataDevice** ingest
   (`/mnt/in-src/f0…`, files at the device root — the no-nested-dirs
   discipline) plus a tree-building seed script written INTO the device as
   `.seed` (never argv) that recreates the real paths at `/src`, refreshed
   every boot, with a `/workspace/source` symlink and an INDEX.txt note.
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
e5-large, 1024-d). The builder gets them via `BERGET_API_TOKEN` (direct) OR,
when that's absent, the live `/api/embed` with the break-glass creds
(`BASIC_AUTH_USER`/`PASS`) — production holds the key. It is RESILIENT: a
token-dense chunk that 502s the batch is retried, then the batch is split to
singles and any lone unembeddable chunk is skipped (logged), so one bad chunk
never aborts the ~2100-chunk build. Test files (`*.test.js`, `tests/`) are
excluded from the index (low value for "how does the app work"; still in the
snapshot, so a user can name one by path for its full text). NOT part of `npm
run bundle` (that stays pure/offline) and NOT run in CI.

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
the consistency check.

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
  testability path). UI row in the account panel's Settings view
  (`account-views.js` DEVELOPER_INFO / `wireDeveloperKnob`).
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
- `.json` was added to ASSET_REVALIDATE (src/index.js) so the snapshot
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
mount readable in-guest on a real browser (the seed script's `rm -rf /src` +
per-file `cp` path), the DRS enrichment step + the private browser-direct
route end to end with a real provider key (confirm the cross-origin provider
fetch is unaffected by COEP `require-corp` when the sandbox knob is also on —
the skill says CORS fetch is fine, verify it), and DRC introspection on a real
key — same live-verification discipline as the rest of the sandbox work.
