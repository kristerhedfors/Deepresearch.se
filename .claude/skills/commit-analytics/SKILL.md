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
small-multiple bar charts over the repo's own git history — **commits, lines
changed, and new features**. The **Day / Week / Month** toggle is a ZOOM level,
not a whole-history rollup: it shows the sub-buckets WITHIN one period —

- **Day** → the **24 hours** of one day
- **Week** → the **7 days** of one week
- **Month** → the **weeks** of one month

— with a ‹ › navigator to page between periods, a per-period totals line, and a
per-day summary. It is a static page fed by a committed JSON dataset:

| File | Role |
|---|---|
| `scripts/build-pulse.mjs` | Reads `git log --numstat`, writes the dataset. `npm run pulse`. |
| `public/pulse/data.json` | The committed dataset: `commits[]` (one `{t,a,r,f}` per commit — the charting source) + `days[]` (per-day aggregates + a `summary`) + `totals`. |
| `public/pulse/index.html` | The self-contained page (inline CSS+JS). Fetches `data.json` and buckets the per-commit records by hour/day/week client-side, draws the SVG charts. |
| `src/assets.js` | `/pulse/` is on the public (no-auth) allowlist so both tiers can open it. |

There is **no build step and no server code** for this feature — the page is a
static asset and the dataset is a committed file. Updating it = re-running the
script, refining the summaries, and pushing.

## How the three series are counted

Each commit becomes one `commits[]` record `{ t, a, r, f }` — timestamp, lines
added, lines removed, feature flag. The page buckets those records by hour (day
view), day (week view) or week (month view), so all three series stay
consistent at every resolution.

- **Commits** — one per non-merge commit; the bucket count.
- **Lines changed (`a`/`r`)** — `added + removed` from `git log --numstat`,
  EXCLUDING committed generated/vendored artifacts (`source-snapshot.json`,
  `source-rag.json`, `public/vendor/**`, `*.min.*`, lock files, and
  `pulse/data.json` itself — see `GENERATED` in the script), so the metric
  reflects human-written change rather than a `npm run bundle` rewrite. Binary
  files count as 0; the commit itself still counts.
- **New features (`f`)** — a keyword HEURISTIC over the commit subject
  (`classify()`): `f=1` only if the subject does not match the
  fix / refactor / docs / test / chore patterns first, then matches an
  add/new/introduce/implement/support pattern (English + Swedish). It drives
  the features chart AND the "New features" total, so they always agree. It's a
  heuristic — it over-counts "feat(ui): tighten…" and misses features phrased
  as "X mode: …" — but it is NOT hand-curated (only the summaries are; see
  below). If the heuristic is systematically wrong, fix `classify()`.

## The update workflow (what to do when invoked)

1. **Sync first** (the repo rule): make sure the working tree is at the latest
   `origin/main` so the git history is complete.
2. **Regenerate the dataset:**
   ```bash
   npm run pulse
   ```
   It prints how many days need review (`curated:false`). Curation is
   preserved: a day whose commit subjects are unchanged and was previously
   marked `curated:true` keeps its hand-written `summary` — only the exact git
   counts refresh. New or changed days get a fresh heuristic summary flagged
   `curated:false` (the page shows a "review pending" marker on those).
3. **Curate the `summary` of days flagged `curated:false`.** The summary is the
   ONLY hand-edited field. For each such day in `public/pulse/data.json`, read
   its `subjects` and rewrite `summary` into one or two concise, factual
   sentences describing what actually shipped that day (not a raw subject
   dump) — name the real features/areas. Then set `"curated": true` so the next
   `npm run pulse` preserves it. Do NOT edit `commits`, `added`, `removed`,
   `features`, `subjects`, or the `commits[]` array — those are exact from git
   and the script rewrites them. (Feature COUNTS are heuristic, not curated — if
   they're systematically off, fix `classify()` in the script, not the data.)
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
- The charts are windowed: **Day** = 24 hourly buckets of one day, **Week** =
  the 7 days (Monday-anchored ISO week), **Month** = the weeks of one month; the
  ‹ › navigator pages between periods and defaults to the most recent day of
  activity. All bucketing is client-side from the `commits[]` records — you only
  ever hand-edit the per-day `summary` text.
- Colours are the data-viz reference palette's categorical slots (commits =
  blue, lines = aqua, features = orange); each chart is its own single-series
  small multiple. If you change them, keep identity carried by the chart title
  too, never colour alone.
- Keep `/pulse/` on the `isPublicAsset` allowlist in `src/assets.js` — without
  it the page and dataset 401 and neither tier can open them.
