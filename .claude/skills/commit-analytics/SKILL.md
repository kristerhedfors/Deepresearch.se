---
name: commit-analytics
description: >-
  Load when updating the "Project pulse" page (the commit-analytics dashboard
  at deepresearch.se/pulse) with the latest commits — "update the pulse page",
  "refresh the commit dashboard", "add the new commits to the graphs" — or when
  touching scripts/build-pulse.mjs, public/pulse/ (index.html + data.json), or
  the /pulse allowlist entry in src/assets.js. Covers regenerating the dataset
  from git, the curate-summaries-and-feature-counts pass, how the three series
  (commits / lines / features) are counted, the day/week/month rollup, and
  committing + pushing so the deploy serves the fresh data.
---

# Updating Project pulse (the commit-analytics dashboard)

## What this is

`deepresearch.se/pulse` is a public page (both tiers link it) showing three
small-multiple bar charts over the repo's own git history — **commits per
period, lines changed per period, and new features per period** — with a
**Day / Week / Month** toggle and a per-period summary drawn from commit
messages. It is a static page fed by a committed JSON dataset:

| File | Role |
|---|---|
| `scripts/build-pulse.mjs` | Reads `git log --numstat`, aggregates per day, writes the dataset. `npm run pulse`. |
| `public/pulse/data.json` | The committed dataset (per-day commits/added/removed/features/summary + totals). |
| `public/pulse/index.html` | The self-contained page (inline CSS+JS). Fetches `data.json`, rolls days into week/month buckets client-side, draws the SVG charts. |
| `src/assets.js` | `/pulse/` is on the public (no-auth) allowlist so both tiers can open it. |

There is **no build step and no server code** for this feature — the page is a
static asset and the dataset is a committed file. Updating it = re-running the
script, refining the summaries, and pushing.

## How the three series are counted

- **Commits** — exact count of non-merge commits with that day's author date.
- **Lines changed** — `added + removed` from `git log --numstat`, EXCLUDING
  committed generated/vendored artifacts (`source-snapshot.json`,
  `source-rag.json`, `public/vendor/**`, `*.min.*`, lock files, and
  `pulse/data.json` itself — see `GENERATED` in the script), so the metric
  reflects human-written change rather than a `npm run bundle` rewrite. Binary
  files count as 0. Commit counts are never affected by this exclusion.
- **New features** — a keyword HEURISTIC over commit subjects
  (`classify()`): a commit is a "feature" only if its subject does not match
  the fix / refactor / docs / test / chore patterns first, then matches an
  add/new/introduce/implement/support pattern (English + Swedish). This is a
  DEFAULT you refine (see below) — the heuristic over-counts things like
  "feat(ui): tighten…" and misses features phrased as "X mode: …".

## The update workflow (what to do when invoked)

1. **Sync first** (the repo rule): make sure the working tree is at the latest
   `origin/main` so the git history is complete.
2. **Regenerate the dataset:**
   ```bash
   npm run pulse
   ```
   It prints how many days need review (`curated:false`). Curation is
   preserved: a day whose commit subjects are unchanged and was previously
   marked `curated:true` keeps its hand-written summary and feature count — only
   the exact git counts refresh. New or changed days get fresh heuristic
   defaults flagged `curated:false` (the page shows a "review pending" marker on
   those).
3. **Curate the days flagged `curated:false`.** For each such day in
   `public/pulse/data.json`, read that day's `subjects` and:
   - Rewrite `summary` into one or two concise, human sentences describing what
     actually shipped that day (not a raw subject dump). Keep it factual and
     specific — name the real features/areas.
   - Set `features` to the honest count of genuinely NEW capabilities that
     landed that day (use judgment; the heuristic is only a starting point).
   - Set `"curated": true` on that day so the next `npm run pulse` preserves it.
   Do not touch `commits`, `added`, `removed`, or `subjects` — those are exact
   from git and the script rewrites them anyway.
4. **Verify** the JSON is valid and the page renders:
   ```bash
   node -e "JSON.parse(require('fs').readFileSync('public/pulse/data.json'))"
   ```
   For a real render check, serve `public/` and open `/pulse/` in a browser
   (Chromium is pre-installed — see the pattern in the session that built this,
   or the live-verify skill). Confirm the Day/Week/Month toggle switches the
   bars, tooltips show, and the summaries list the right periods.
5. **Commit and push** to the branch the session is working on (per the repo's
   git workflow — normally straight to `main`):
   ```bash
   git add scripts/build-pulse.mjs public/pulse/ public/pulse/data.json
   git commit -m "pulse: refresh commit analytics through <date>"
   git push origin main
   ```
   The deploy is git-connected, so the fresh `data.json` goes live with the
   push. `data.json` is served `no-cache` (revalidate), so the new data appears
   on the next page load.

## Notes / gotchas

- **Adding new commits to an already-summarized day** changes that day's
  `subjects`, which resets it to `curated:false` — re-curate it (the summary may
  now be stale).
- The page rolls days into **week** (Monday-anchored ISO week) and **month**
  buckets entirely client-side; you only ever edit per-DAY records. Week/month
  summaries are the member days' summaries listed together, so good day
  summaries are all that's needed.
- Colours are the data-viz reference palette's categorical slots (commits =
  blue, lines = aqua, features = orange); each chart is its own single-series
  small multiple. If you change them, keep identity carried by the chart title
  too, never colour alone.
- Keep `/pulse/` on the `isPublicAsset` allowlist in `src/assets.js` — without
  it the page and dataset 401 and neither tier can open them.
