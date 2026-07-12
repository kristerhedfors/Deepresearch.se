---
name: cache-helper
description: >-
  Load when the live site serves STALE content — an old build after a
  deploy, a build stamp that won't advance (d-numbers on /cure, the h-
  handshake in app.css/app.js), mixed old/new module graphs, a republished
  /api/pub slug serving the old copy — or when deciding cache-control for
  a new asset/endpoint. Covers every cache layer this project has, the
  verify-before-theorizing rule, and the FIRST remedy to offer the user:
  turning on Cloudflare Development Mode in the dashboard.
---

# Cache helper — every layer, and what to do when the site serves stale

## The FIRST remedy: remind the user about Cloudflare Development Mode

When cache trouble bites on the live site (fresh deploy, stale bytes),
**REMIND THE USER to turn on Development Mode in the Cloudflare
dashboard**: dash.cloudflare.com → the deepresearch.se zone → Caching →
Configuration → **Development Mode ON**. It bypasses Cloudflare's edge
cache for the whole zone for **3 hours**, then switches itself back off
— purpose-built for exactly this iterate-and-verify situation.

The agent CANNOT toggle it from this environment: the API token fails
zone-level endpoints with `Authentication error [code: 10000]` (same
limitation as the wrangler route-sync step — observed 2026-07-10). Only
the user can flip it, so say so explicitly instead of fighting the edge.
The dashboard's **Purge Everything** (same Caching page) is the one-shot
alternative when 3 hours of bypass isn't wanted.

**When Development Mode is NOT enough (learned 2026-07-11).** Dev Mode bypasses
the standard zone cache, but it does NOT cover the layer that was serving stale
app JS/HTML in the bash-sandbox saga: the tell was **`cf-cache-status: HIT` on
a response marked `cache-control: no-store`** — impossible unless a **Cache
Rule / "Cache Everything"** is force-caching those paths and overriding the
origin headers, and such entries survive deploys per-PoP. The user enabled Dev
Mode + refreshed and it stayed stale; **Purge Everything** is what cleared it.
So: if you see `HIT` on a `no-store` asset, don't send them to Dev Mode — send
them to **Purge Everything**, and flag the underlying Cache Rule as the real
bug (it should not cache `/rver` or `/js/*`). Detect a client stuck on old code
without device access via the `client_diag`/build-stamp trick below.

## The cache layers (know which one you're fighting)

1. **Browser heuristic cache** — SOLVED by policy, don't regress it:
   `serveAsset` (src/assets.js) sends `cache-control: no-cache` for every
   js/css/html/md/webmanifest and extensionless route (revalidation is a
   cheap 304 via the strong asset etags), and a short real TTL only for
   icons/media. History: the 2026-07-08 mixed-module-graph incident —
   devices cached ~20 unversioned ES modules heuristically and linked a
   MIXED graph after multi-deploy days, killing the app silently.
2. **The CSS↔JS handshake** — app.js `CSS_VERSION` vs app.css
   `--css-version` (h-numbers): catches devices wedged on a stale
   stylesheet with fresh modules and force-reloads the link. Bump BOTH
   when they must move together (h22 as of 2026-07-10).
3. **Build stamps** — the visible truth about what a device runs:
   `d<N> · pwa|browser` on the DRC brand line (bump every DRC deploy),
   the `[hN …]` line in the history pane. No stamp = ancient build.
4. **Cloudflare edge cache** — assets are content-addressed per deploy
   (safe), but PROPAGATION LAGS: minutes after `wrangler deploy`
   reported success on 2026-07-10, /cure still served the previous
   build, and one PoP can be fresh while another is stale (a probe saw
   302 from an old worker and new content in the same minute). This is
   the layer Development Mode bypasses.
5. **`/api/pub` JSON** — served with `cache-control: public, max-age=60`
   (src/pub.js): a re-published slug can serve the old copy for up to a
   minute. Don't chase ghosts when verifying an update.
6. **Workers Cache API** (`src/edge-cache.js`) — server-side RESULT
   caching for Exa and Google Maps lookups. Not an asset cache; it makes
   repeat searches free. Fail-soft by design; don't confuse a cached Exa
   result with a stale page.
7. **PWA/standalone staleness** — an installed PWA can keep a page alive
   in the background for hours and pins `start_url`/status-bar behavior
   at launch; a "stale" report from the phone may just be a long-lived
   webview (see the on-device-trace skill).

## The discipline (learned the hard way, same day)

- **Verify what's live BEFORE theorizing about a bug report.** A "still
  broken" retest against an undeployed fix wasted an iteration on
  2026-07-10 (the git-connected auto-deploy had silently wedged). Probe
  for a sentinel unique to the new commit (the build stamp, a new
  string) — `git push` succeeding proves nothing about production.
- **Deploy verification pattern**: `until curl -sS <url> | grep -q
  <new-sentinel>; do sleep 10; done` in the background, then assert the
  full route/content matrix. Expect minutes, not seconds; two probes
  minutes apart can hit different PoPs mid-rollout.
- **When the auto-deploy is wedged**, `npx wrangler deploy` works from
  this environment (see the deploy skill); its route-sync error is
  harmless. If pushes to main keep not auto-deploying, tell the user the
  git-connect needs re-linking in the dashboard.
- **Bump the stamps with the change** (d-number for /cure, h-pair for
  app css/js): they are the only instrument that makes "which build is
  this device running" answerable from a screenshot.
- **Detect stale-code delivery from the server, without the device.**
  Have the client echo a build/feature marker on a request the server
  logs — the bash-sandbox `client_diag` (a field newer code attaches to
  every `/api/chat`) is the model: when it logs as **absent/null**, that
  browser is running a pre-fix bundle, which pins the problem to delivery
  (edge/PWA cache), NOT the code. A live `wrangler tail` (from the repo
  root, or pass the worker name) plus this marker is how the 2026-07-11
  stale-JS was proven without ever touching the user's phone. See the
  **execution-sandbox** skill's debugging playbook.
