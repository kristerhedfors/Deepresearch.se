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
