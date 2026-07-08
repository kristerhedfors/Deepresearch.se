---
name: deploy
description: >-
  Load when deploying to production, wondering whether a change is live,
  running `npx wrangler deploy`, debugging a deploy that "didn't take", or
  timing a deploy around an eval battery. Covers the push-to-main
  git-connected auto-deploy, direct wrangler deploy and the API token's
  route-update limitation, live verification probes, and the
  don't-deploy-mid-battery rule.
---

# Deployment

How code actually reaches production for deepresearch.se (a Cloudflare
Worker + static assets). Everything below was observed empirically
(2026-07-08 session), not assumed from docs.

## Two paths to production

1. **Push to `main` (the normal path).** The repo is git-connected to
   Cloudflare, so every push to `main` triggers an automatic build+deploy.
   No credentials needed beyond git push rights. Latency: a few minutes.
   This is why the repo convention is "commit and push straight to `main`"
   — pushing IS deploying.
2. **Direct `npx wrangler deploy` (when you need it now, or need to know
   it happened).** The session environment carries `CLOUDFLARE_API_TOKEN`
   and `CLOUDFLARE_ACCOUNT_ID`. Observed behavior of that token:
   - Worker script + assets upload **succeeds** ("Uploaded deepresearch-se"),
     bindings (D1, Vectorize, R2, assets) all resolve.
   - The follow-up call to update **zone routes**
     (`/zones/<id>/workers/routes`) **fails** with
     `Authentication error [code: 10000]` — the token lacks zone-level
     permission.
   - This is **harmless for a routine deploy**: the routes already exist
     from previous deploys and don't change; the freshly uploaded version
     serves on them. It would only matter if `wrangler.toml` route config
     itself changed — that would need a token with zone Workers Routes
     edit permission (or the dashboard).
   Sandbox note: wrangler works through the environment's HTTPS proxy
   (it prints a proxy warning — expected, not an error).

Deploying the SAME commit via both paths is redundant but safe (the
git-connected deploy just re-deploys identical code).

## Verify a deploy is actually live (don't trust the upload message)

There is no version endpoint on the site. Verify behaviorally: probe
`/api/chat` (break-glass Basic Auth env creds `BASIC_AUTH_USER`/`PASS` —
sent as an `Authorization: Basic` header, the Worker never challenges) with
a request whose SSE trace can only show the new behavior, and read the
status events. Worked example — verifying the triage-decomposition deploy:
send a clearly multi-hop question and check the `plan` `step_done` event
for the new `· multihop` label tag and `Sub-question:` detail lines. A
generic "it answered fine" is NOT verification — pick a marker that did not
exist before the change.

Wrangler tail / Workers Logs (see the **live-verify** skill) are the
fallback when the change has no client-visible marker.

## Interaction with the eval harnesses (critical)

**Never push to `main` (or wrangler-deploy) while an eval battery is
running** — the deploy truncates in-flight streamed requests and poisons
the results (this exact confusion burned a model-eval round). Corollaries:
- Finish or hold batteries before pushing ANY commit to `main`, even a
  docs-only one — the auto-deploy doesn't know it's docs-only.
- For a before/after A/B: run the baseline battery, THEN merge+deploy,
  verify the deploy is live (probe above), THEN run the after battery, and
  only push the ledger entry once the battery has finished.

## Plan status (context for deploy failures)

The account is on Workers **Paid** with `[limits] cpu_ms = 300_000` in
`wrangler.toml`. If the account is ever downgraded to Free, `wrangler
deploy` (and the git-connected deploy) will REJECT the config outright
(code 100328, "CPU limits are not supported for the Free plan") — remove
the `[limits]` section first. Full incident history in the
**pipeline-architecture** skill and `tests/MODEL-EVAL-FINDINGS.md`.

## Client assets: deploys × unversioned ES modules (2026-07-08 incident)

The app ships ~20 UNVERSIONED ES modules (no build step). A day of several
deploys that changed cross-module exports bricked a real device: browsers
had been heuristically caching modules (assets carried NO Cache-Control),
so the device linked a MIXED graph (fresh stream.js + stale activity.js)
→ module linking fails → app.js never runs → no submit handler → Send
falls through to a NATIVE form submit → page reloads to a blank chat
("no queries work"). Fresh-browser repros pass, which is exactly why it's
deceptive — the bug lives in returning devices' caches.

Standing fixes (keep them intact):
- `src/index.js` `serveAsset()` — every asset response carries an explicit
  policy: `no-cache` for js/css/html/md/webmanifest and extensionless HTML
  routes (etag revalidation = cheap 304, consistent graph every load),
  `max-age=3600` for icons/media.
- `public/index.html` inline boot guard + `window.__appReady` (set at the
  END of app.js) — until the module graph has linked, native submits are
  blocked and a "tap to reload" banner shows (PROACTIVELY ~4s after load,
  not only on a send attempt). Any future graph failure is LOUD instead of
  eating queries.
- The banner's "Tap to reload" REPAIRS the cache, it doesn't just reload
  (second wave of the same incident, later that day): devices that cached
  the module graph BEFORE the no-cache policy existed kept serving the
  stale mix heuristically — `location.reload()` does NOT bypass the HTTP
  cache, so those devices were wedged "every time" while a fresh client
  linked the same deploy cleanly (verified live with a Playwright boot +
  a full module-graph fetch/parse audit). The guard now walks the module
  graph with `fetch(url, {cache:"reload"})` — which bypasses AND
  overwrites each cached entry — then reloads into the repaired graph.

Debugging tip that found the second wave: fetch `/` with break-glass
auth, extract the module entrypoint, transitively fetch every imported
module, assert HTTP 200 + parseable + every named import exported by its
target — then boot the site in the sandbox Chromium (tests/ has the
proxy/TLS quirks) and check `window.__appReady === true`. If all that
passes but a device still fails, the problem is that device's cache, not
the deploy.

Cloudflare "Development Mode" is NOT part of this fix and doesn't cover
this class: it bypasses the zone EDGE cache (which was never the problem —
Workers static assets are content-addressed per deploy, and observed
2026-07-08: asset responses still showed cf-cache-status: HIT with dev
mode on), while the bug lived in BROWSER caches, which only the explicit
`no-cache` response headers control. Dev mode also auto-expires after 3h —
never rely on it being on.

Rules that follow: keep the guard inline and classic (never a module);
when renaming/adding cross-module exports remember old clients may hold
half-old graphs until their next revalidation — the guard is the net;
debug "works for me, broken for the user" client reports with header
inspection (curl -I: is cache-control still there?) and a REAL browser
repro via Playwright against live (tests/playwright.config.js has the
sandbox quirks), not just API probes.
