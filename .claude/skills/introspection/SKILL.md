---
name: introspection
description: >-
  Load when working on introspection mode / the developer_mode knob — the
  feature that lets a conversation ask about THIS SITE's own implementation
  and get answered from the deployed source — or anything touching
  scripts/bundle-source.mjs, public/introspect/source-snapshot.json (the
  committed snapshot artifact), public/js/introspect-core.js (the shared pure
  core), src/introspect.js (the DRS enrichment), the /src sandbox mount
  (sandbox-files.js planSourceMount), or the DRC developerMode knob. ALSO
  load when `npm test` fails on "source snapshot artifact matches the working
  tree" — the fix is `npm run bundle`, never editing the artifact by hand.
---

# Introspection mode (developer_mode)

With the **developer_mode** knob on (both tiers), a conversation that asks
about this site's own implementation ("how are you built?", "visa mig din
källkod", or naming a repo path like `src/pipeline.js`) enters INTROSPECTION
MODE: the exact deployed source is given to the model as structured context,
and — when the execution sandbox is also on — mounted at `/src` inside the
in-browser Linux VM for real `ls`/`cat`/`grep -rn` exploration.

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

## Freshness discipline

`src/introspect.test.js` runs `node scripts/bundle-source.mjs --check`; a
stale artifact **fails `npm test`**. So: touch any bundled source file →
`npm run bundle` → commit the regenerated artifact in the same commit. New
files must be `git add`ed BEFORE bundling (the walker uses `git ls-files`).
Never hand-edit the artifact.

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

The /src mount readable in-guest on a real browser (the seed script's `rm
-rf /src` + per-file `cp` path), the DRS enrichment step visible on the live
site with the knob on, and DRC introspection on a real key — same
live-verification discipline as the rest of the sandbox work.
