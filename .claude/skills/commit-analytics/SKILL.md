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
  committing + pushing so the deploy serves the fresh data. ALSO the sibling
  Feature focus timeline (/pulse/timeline.html + scripts/pulse-themes.mjs +
  build-pulse-timeline.mjs + timeline.json): the subject-taxonomy tagger, the
  multi-line / streamgraph of where feature-focus went over time, and its CURVE
  PICKER — "choose which curves are active/shown", "tap to pick subjects",
  "toggle series", "show only one theme" on that page. ALSO the
  "Code size" snapshot on the main pulse page (scripts/build-pulse-size.mjs +
  public/pulse/size.json): lines/chars per language, README size, and
  dependency counts — "update the size metrics", "refresh lines of code /
  language breakdown / dependency count".
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
| `scripts/pulse-time.mjs` | The CET/CEST (Europe/Stockholm) normalisation `toCetIso`/`cetOffsetMinutes`, shared by BOTH builders so the two pages can never bucket the same instant onto different calendar days (de-duped 2026-07-24; it was mirrored by hand before). Pure; unit-tested in `scripts/pulse-time.test.mjs`. |
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

**"Update the pulse" means all three datasets, not just `data.json`.** The page
has three independent sources and two pages; refreshing one and not the others
ships a dashboard that disagrees with itself. Run the whole list — it takes one
pass and about ten minutes, most of it the artifact re-embedding.

1. **Sync, and get the FULL history.** Be at the latest `origin/main`, then
   `git fetch --unshallow origin` — session clones are shallow and a shallow
   clone silently produces a dataset that starts a few days ago. Verify with
   `git log --oneline | wc -l` (four figures, not dozens).
2. **Regenerate all three datasets:**
   ```bash
   npm run pulse            # public/pulse/data.json      — commits / lines / features
   npm run pulse:timeline   # public/pulse/timeline.json  — subject-tagged focus over time
   npm run pulse:size       # public/pulse/size.json      — code-size snapshot
   ```
   `npm run pulse` prints how many days need review (`curated:false`). Curation
   is preserved: a day whose commit subjects are unchanged and was previously
   marked `curated:true` keeps its hand-written `summary` — only the exact git
   counts refresh. New or changed days get a fresh heuristic summary flagged
   `curated:false` (the page shows a "review pending" marker on those).
3. **Check the tagger's coverage** before curating anything:
   ```bash
   node scripts/build-pulse-timeline.mjs --audit
   ```
   Target untagged **< ~15 %**; the tail is genuinely theme-less chore commits.
   If a whole class of recent work has no subject at all (a new feature area
   shipped since the last refresh), add or widen a pattern in
   `scripts/pulse-themes.mjs` — Swedish forms alongside English — and re-run.
   Never hand-edit the emitted data.
4. **Curate the `summary` of days flagged `curated:false`.** The summary is the
   ONLY hand-edited field. For each such day in `public/pulse/data.json`, read
   its `subjects` and rewrite `summary` into one or two concise, factual
   sentences describing what actually shipped that day (not a raw subject
   dump) — name the real features/areas. Then set `"curated": true` so the next
   `npm run pulse` preserves it. Do NOT edit `commits`, `added`, `removed`,
   `features`, `subjects`, or the `commits[]` array — those are exact from git
   and the script rewrites them. (Feature COUNTS are heuristic, not curated — if
   they're systematically off, fix `classify()` in the script, not the data.)
   Finish with zero uncurated days:
   ```bash
   node -e "const d=require('./public/pulse/data.json');console.log(d.days.filter(x=>!x.curated).length)"
   ```
5. **Regenerate the introspection artifacts.** All three datasets are tracked
   files, so they ride in the source snapshot — skipping this fails `npm test`
   on "source snapshot artifact matches the working tree":
   ```bash
   npm run bundle && npm run bundle:rag
   ```
   (Add `npm run bundle:docs && npm run bundle:docs-rag` if the pass also
   touched a `docs/` file.) Never hand-edit an artifact.
6. **Gate:**
   ```bash
   npm test          # includes scripts/pulse-*.test.mjs + the artifact drift check
   npm run typecheck # needs a root `npm install` first — node_modules is not pre-seeded
   ```
7. **Verify in a real browser** — the two pages are inline-JS static assets, so
   nothing in the unit suite touches their rendering. Serve `public/` and drive
   them (Chromium is at `/opt/pw-browsers/chromium`; the pre-canned recipe is
   §"Verifying the pages in a browser" below). On `/pulse/` confirm the
   Day/Week/Month toggle switches the bars, tooltips show and the summaries
   list the right periods; on `/pulse/timeline.html` confirm the curve picker,
   both view modes, and zoom/pan. If the pass changed picker behaviour, run its
   own suite:
   ```bash
   cd tests && env -u HTTPS_PROXY BASIC_AUTH_USER=x BASIC_AUTH_PASS=y \
     BASE_URL=http://127.0.0.1:8788 npx playwright test --project=mocked pulse-timeline
   ```
8. **Commit and push** on a feature branch cut from the latest `origin/main`
   (per the repo git workflow), then merge or open a PR:
   ```bash
   git add public/pulse/ public/introspect/ scripts/ tests/
   git commit -m "pulse: refresh commit analytics, feature timeline, and code-size snapshot through <date>"
   git push -u origin <feature-branch>
   ```
   The deploy is git-connected, so the fresh datasets go live with the merge.
   They are served `no-cache` (revalidate), so new data appears on the next
   page load.

### Verifying the pages in a browser

No dev server is needed — both pages are static and fetch only their own JSON:

```bash
# 1. serve public/ (any static server; this one has no deps)
node -e "const h=require('http'),f=require('fs'),pa=require('path');const r=pa.join(process.cwd(),'public');
const t={'.html':'text/html','.json':'application/json','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.ico':'image/x-icon'};
h.createServer((q,s)=>{let u=decodeURIComponent(new URL(q.url,'http://x').pathname);if(u.endsWith('/'))u+='index.html';
const fp=pa.join(r,u);if(!fp.startsWith(r)||!f.existsSync(fp)||f.statSync(fp).isDirectory()){s.writeHead(404);return s.end()}
s.writeHead(200,{'content-type':t[pa.extname(fp)]||'application/octet-stream'});f.createReadStream(fp).pipe(s)}).listen(8788)" &

# 2. drive it — playwright lives in tests/, chromium at /opt/pw-browsers/chromium
cd tests && npm install     # once
```

Two traps, both cost real time:

- **The proxy kills a localhost run.** `tests/playwright.config.js` routes the
  browser through `HTTPS_PROXY` when it is set, and a request to
  `127.0.0.1:8788` then hangs with no output until the timeout. Run local
  checks with `env -u HTTPS_PROXY -u https_proxy …`.
- **The pinned Playwright expects a browser revision that isn't installed.**
  `npx playwright install` is blocked; pass
  `executablePath: "/opt/pw-browsers/chromium"` (the config already does — a
  standalone probe script must too).


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

## Sibling: the Feature focus timeline (`/pulse/timeline.html`)

A second page under `/pulse` charts *which feature sets* the commits were about
over time — subjects (Linux sandbox, Hugging Face, on-device inference, …)
rising, competing, and fading — so you can see where focus (and, by churn,
roughly where tokens) went. It is fed by its own committed dataset and is
independent of `data.json` (nothing here needs re-curation):

| File | Role |
|---|---|
| `scripts/pulse-themes.mjs` | The SUBJECT taxonomy (key/label/colour/blurb + a RegExp per subject) and `tagCommit(subject)` → **zero-to-many** subject keys. Pure; unit-tested. |
| `scripts/pulse-themes.test.mjs` | Runs in `npm test` (the glob now includes `scripts/*.test.mjs`). Guards distinct colours + representative subject-line → tag cases. |
| `scripts/build-pulse-timeline.mjs` | `npm run pulse:timeline`. Tags every commit, emits `timeline.json` (`subjects[]` registry + per-commit `{t,a,r,s}` + per-subject totals). `--audit` prints tag coverage, writes nothing. |
| `public/pulse/timeline.json` | The committed dataset (like `data.json`, it rides in the introspection source-snapshot, so re-run `npm run bundle`/`bundle:rag` after regenerating). |
| `public/pulse/timeline.html` | Self-contained page: multi-line **or** streamgraph, weigh by commits **or** lines, wheel/drag/brush zoom-and-pan, the **curve picker** (below), tooltip, table fallback. Light + dark. |
| `tests/e2e/pulse-timeline.spec.js` | The picker's regression guard, in Playwright's free `mocked` project (`/pulse/` is a public asset, so it needs no auth and no `/api/chat`). Eight cases: defaults, tap, hold-to-isolate, tap-a-curve, drag-never-selects, the bulk buttons, persistence, and the 44px touch target. |

To refresh it: `npm run pulse:timeline`, eyeball `--audit` coverage (target
untagged < ~15%; the tail is genuinely theme-less chore/meta commits), and if a
whole class of commits is mis-tagged, fix the **patterns** in `pulse-themes.mjs`
(add Swedish forms alongside English), never the emitted data. Colours are
entity-stable per subject (never rank-coloured); identity is always carried by
the legend + direct end-labels + the table view, so >8 simultaneously-visible
series stays legible (the page defaults to the busiest six). The shallow session
clone only sees recent days — `git fetch --unshallow origin` first for the full
range. Same `/pulse/` allowlist covers it.

### The curve picker (which curves are active)

Twenty-five subjects cannot be read at once, so **choosing** is the page's
primary interaction, not a refinement of it. The `Curves` block under the chart
is both the legend and the control — the full rule, and the reasoning, is
**UX-13** in the `ux-conventions` skill. What matters when editing this page:

| Gesture | Effect |
|---|---|
| Tap a chip | adds / removes that curve |
| Tap a curve **in the chart** | isolates that one subject (every series carries a paired transparent `.series-hit` path, ~22 viewBox units — a 2 px line is not a tap target) |
| Press-and-hold a chip or curve (~500 ms), or right-click | same isolation; hold again restores the previous set |
| Drag | pans. A press that moved never selects anything |
| Top 6 / All / None / Invert | reset the whole set |

Three things are load-bearing and easy to break:

1. **`buildLegend()` runs ONCE; `syncLegend()` patches in place.** The chips
   used to be re-`innerHTML`ed inside `redraw()`, which runs on every frame of
   a pan — so a chip was destroyed under the finger mid-gesture. Never move
   chip construction back into the redraw path.
2. **Window-level listeners are registered once**, outside `wirePlot()` /
   behind `brushWired`. Those functions re-run per render (the SVG element is
   replaced), and re-adding `mousemove`/`mouseup` there stacks one handler per
   frame. Element-local handlers on the fresh SVG are fine; window-level ones
   are not.
3. **Both long-press signals must stay wired.** Chrome/Android hijacks the
   touch at the threshold and fires `contextmenu` instead of letting the timer
   run; iOS suppresses `contextmenu` and rides the timer. And the release that
   ends a hold is also a `click`, so it has to be swallowed or the isolation
   toggles straight back off. Same trap as the composer knobs (UX-10).

State (`{ curves, metric, mode }`) persists to `localStorage` under
`dr.pulse.timeline.v1`, filtered against the live registry on load so a
renamed or removed subject cannot restore an empty chart. **Renaming or
dropping a subject key in `pulse-themes.mjs` silently drops it from every
returning visitor's saved selection** — that is the intended degradation, but
say so in the commit message.

## Sibling: the Code size snapshot (`/pulse` → "Code size" section)

A section on the main pulse page giving a point-in-time size snapshot of the
tree — NOT a time series, so it needs no history and no shallow-clone caveat:

| File | Role |
|---|---|
| `scripts/build-pulse-size.mjs` | `npm run pulse:size`. Runs `git ls-files`, counts lines/chars per language (merging extensions under one label — `.js`+`.mjs` → JavaScript), finds `README.md`'s own line/char/word count, and counts `dependencies`/`devDependencies` keys in `package.json` + `tests/package.json`. Writes `public/pulse/size.json`. |
| `public/pulse/size.json` | The committed dataset: `totals` (files/lines/chars/dependency counts), `languages[]` (one row per label, sorted by lines desc), `readme`, `dependencies` (root + tests breakdown). Rides in the introspection source-snapshot like the other two datasets — re-run `npm run bundle` after regenerating. |
| `public/pulse/index.html` | The "Code size" section (stat tiles + a plain horizontal proportion-bar list per language — no SVG axes needed for a snapshot). `renderSize()` in the inline script. |

Same exclusion list as `data.json`'s `GENERATED` (the two introspection
artifacts, vendored libs, minified/lock files, and the pulse datasets
themselves) so a `npm run bundle` regeneration doesn't inflate the JSON
language row. Binary/media extensions (images, `.wasm`, fonts, `.pdf`) count
as files but not lines. To refresh: `npm run pulse:size`, no curation step —
everything here is exact from the tree, nothing hand-written. Gotcha already
noted above applies here too if you also touch `data.json`/`timeline.json` in
the same session: `git fetch --unshallow origin` before `npm run pulse` (size
doesn't need history, but the sibling regenerations in the same commit do).
