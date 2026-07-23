# Publishing an already-built app bundle (the sandbox/CLI bridge into SDK mode)

## What this is — and what it is NOT

This is a small bridge into the **sdk-mode** feature (`/app/<slug>/`,
`src/build-pub.js`), NOT a separate publishing system. Load the **sdk-mode**
skill first for the full picture (the chat-mode dropdown, `runSdkBuild`, the
opaque-origin CSP-sandboxed serving model, the storage shape). This skill
covers ONLY the one thing sdk-mode didn't have: a way to publish a bundle of
files that was built OUTSIDE the chat/tool loop — most commonly the
**execution-sandbox**'s outbox convention, or files a Claude Code session
already has on disk from **introspection**-mode source work — without
needing a live model conversation to drive `write_file`/`publish_app`.

`handleBuildManualPublish` (`PUT /api/build/:slug`, admin-gated,
`src/build-pub.js`) calls the exact same `publishBuild` the pipeline calls.
A manually published app is indistinguishable from a model-built one once
stored: same validation, same size caps, same `Content-Security-Policy:
sandbox allow-scripts …` opaque-origin serving at `/app/<slug>/`.

**Do not build a second storage/serving path for this.** If sdk-mode's caps
or file-type allowlist (`BUILD_FILE_EXTS`, `public/js/sdk-core.js`) are ever
too narrow for a real use case, widen THAT shared core — don't fork a
parallel one.

## Publishing — the CLI

```bash
scripts/publish-app ./my-app-dir counter-app --title "A tiny counter app"
# → Published: https://deepresearch.se/app/counter-app/

scripts/publish-app --delete counter-app   # unpublish
```

Same break-glass auth pattern as `scripts/chatlogs`/`scripts/features`
(`BASIC_AUTH_USER`/`BASIC_AUTH_PASS`). It walks the directory recursively,
keeps only files with an extension `build-pub.js` accepts (html, css,
js/mjs, json, svg, md, txt, csv, tsv, xml, webmanifest — others are skipped
with a warning), and requires an `index.html` at the bundle root (checked
locally so a bad publish fails fast instead of round-tripping). Re-running
against the same slug republishes in place (files dropped since the last
publish are pruned, same as the pipeline's own republish behavior).

**In-place republish over a CHAT-BUILT app (`keepOwner`):** the manual PUT
may target a slug that a user's chat conversation built — the fix lands at
the SAME `/app/<slug>/` URL and the build KEEPS its original owner, so the
user's chat can keep iterating on it afterwards (`publishBuild`'s
`keepOwner` flag, set only by the admin-gated manual path). This is the
feedback-loop maintenance path: fix a user's published app without moving
its URL. Before the flag existed (pre-2026-07-23) the ownership guard
minted a FRESH slug on such a publish — if you get a different slug back
than you asked for, you're on a deploy that predates it.

## Publishing — raw curl

```bash
curl -sS -X PUT "https://deepresearch.se/api/build/counter-app" \
  -u "$BASIC_AUTH_USER:$BASIC_AUTH_PASS" \
  -H "content-type: application/json" \
  --data '{"title":"A tiny counter app","files":[{"path":"index.html","content":"..."},{"path":"app.js","content":"..."}]}'
# → {"ok":true,"slug":"counter-app","url":"/app/counter-app/","files":2,"bytes":123}
```

`DELETE` (same auth) unpublishes — the same endpoint the pipeline's own
unpublish uses, unchanged by this addition.

## Bridging from the execution sandbox

The sandbox is offline and has no direct network path to this endpoint (see
the execution-sandbox skill) — there's no one-click "publish" button from
inside a sandboxed session. The practical flow:

1. Have the sandbox/agent build the app under a scratch directory, or use
   the `/workspace/outbox` convention and download the deliverables
   (execution-sandbox's OUTBOX section).
2. Get those files into a directory this Claude Code session can read (a
   local scratch dir is enough — the CLI only needs the resulting text
   files, not the sandbox itself).
3. `scripts/publish-app <dir> <slug>`.

For most "describe an app, get a link" requests, prefer just using SDK mode
directly in the chat dropdown — it drives the exact same publish call with
no manual step. This bridge exists for the specific case of output that was
already produced by another means (the sandbox, introspection-mode source
reading, a hand-authored file set) and just needs a URL.

## Verify live

```bash
curl -sS -o /dev/null -w "%{http_code}\n" https://deepresearch.se/app/<slug>/
curl -sSI https://deepresearch.se/app/<slug>/ | grep -i content-security   # "sandbox allow-scripts ..."
```

## Gotchas

- Ownership is the ADMIN identity (`identity.id`, `"admin"` for break-glass)
  — publishing/republishing/deleting all go through this one endpoint,
  admin-gated, same as the existing DELETE.
- There is no list/index endpoint for builds (unlike `pub.js`'s
  `GET /api/pub`) — build-pub.js never had one; this addition doesn't add
  one either. Track your own slugs.
- Files are TEXT only (`BUILD_FILE_EXTS`) — no binary upload path. Inline
  images as `data:` URIs in HTML/CSS.
