// Run the OUTROSPECTION scan: fan the lens registry's searches out at Exa,
// diff the results against what the committed feed already knew, and write the
// new items back — highlighted.
//
//   EXA_API_KEY=… node scripts/outrospect-scan.mjs           # every lens
//   EXA_API_KEY=… node scripts/outrospect-scan.mjs --lens browser-models
//   EXA_API_KEY=… node scripts/outrospect-scan.mjs --dry     # show, don't write
//   npm run outrospect                                        # same, via package.json
//
// This is the OFFLINE half of the feed. The site's live half (POST
// /api/outrospect/refresh, src/outrospect.js) does the same thing on behalf of
// whoever is visiting, one lens at a time; this script does the whole registry
// in one pass and commits the result, so the feed is populated the moment the
// page loads and works with no database at all. Both halves share the ONE core
// (public/js/outrospect-core.js) — the lens queries, the item shape, the URL
// normalization, and the delta are the same code in both places, so a scan and
// a visit can never disagree about what counts as new.
//
// The delta IS the product. A scan that finds forty results and reports "3
// new" has done its job: the other thirty-seven were already on the page, and
// re-listing them would bury the three things that actually changed. Items
// keep their ORIGINAL first_seen across scans, so nothing re-flashes as new
// just because it was found again.
//
// Output: public/outrospect/feed.json — { generated, items: [...] }, sorted
// newest first. Committed, like the introspection snapshot and pulse datasets.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  OUTROSPECT_CAPS,
  OUTROSPECT_LENSES,
  deltaItems,
  feedItemFromSearch,
  formatFeedText,
  mergeFeed,
  normalizeLens,
} from "../public/js/outrospect-core.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = join(ROOT, "public", "outrospect");
const OUT = join(OUT_DIR, "feed.json");

const EXA_URL = "https://api.exa.ai/search";
// Same shallow depth the live refresh uses (src/outrospect.js REFRESH_DEPTH):
// a feed wants headlines across many queries, not a deep read of one.
const NUM_RESULTS = 8;
const TIMEOUT_MS = 20_000;

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const value = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : null;
};

const dryRun = flag("dry");
const onlyLens = value("lens");
if (onlyLens && !OUTROSPECT_LENSES.some((l) => l.id === onlyLens)) {
  console.error(`Unknown lens "${onlyLens}". Known: ${OUTROSPECT_LENSES.map((l) => l.id).join(", ")}`);
  process.exit(2);
}

// Checked once, up front: without a key there is nothing to scan, and the
// useful failure is one clear line before any work rather than a rejection
// seven queries in.
const EXA_KEY = process.env.EXA_API_KEY;
if (!EXA_KEY) {
  console.error(
    "EXA_API_KEY is not set — export it before running the scan.\n" +
      "Without it the committed feed stays as it is; the site's live half\n" +
      "(POST /api/outrospect/refresh) fills the page on its own.",
  );
  process.exit(2);
}

/** The committed feed as it stands, or an empty one on first run. */
function readExisting() {
  try {
    const parsed = JSON.parse(readFileSync(OUT, "utf8"));
    return Array.isArray(parsed?.items) ? parsed.items : [];
  } catch {
    return [];
  }
}

/**
 * One Exa search. Fail-soft in the same spirit as the Worker's exa.js: a dead
 * query costs its own results and nothing else, so one bad lens never aborts
 * the scan.
 * @param {string} query
 * @returns {Promise<{title?: string, url?: string, highlights?: string[]}[]>}
 */
async function search(query) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(EXA_URL, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": key },
      body: JSON.stringify({
        query,
        numResults: NUM_RESULTS,
        type: "auto",
        contents: { highlights: { numSentences: 2, highlightsPerUrl: 2 } },
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      console.warn(`  ! search failed (${res.status}) for: ${query}`);
      return [];
    }
    const json = await res.json();
    return Array.isArray(json?.results) ? json.results : [];
  } catch (err) {
    console.warn(`  ! search errored for "${query}": ${err.message}`);
    return [];
  } finally {
    clearTimeout(timer);
  }
}

const now = Date.now();
const existing = readExisting();
const lenses = OUTROSPECT_LENSES.filter((l) => !onlyLens || l.id === onlyLens);

console.log(`Outrospection scan — ${lenses.length} lens(es), ${existing.length} items already known\n`);

/** @type {any[]} */
const found = [];
for (const lens of lenses) {
  console.log(`${lens.id} — ${lens.title}`);
  for (const query of lens.queries) {
    const results = await search(query);
    let kept = 0;
    for (const r of results) {
      const item = feedItemFromSearch(normalizeLens(lens.id), r, { now, query });
      if (item) {
        found.push(item);
        kept++;
      }
    }
    console.log(`  ${String(kept).padStart(2)} usable  ←  ${query}`);
  }
}

// THE DELTA — everything the committed feed did not already hold.
const fresh = deltaItems(existing, found);

console.log(`\n${"═".repeat(70)}`);
console.log(`DELTA: ${fresh.length} new item(s) out of ${found.length} result(s) across ${lenses.length} lens(es)`);
console.log("═".repeat(70) + "\n");
for (const i of fresh) {
  console.log(`NEW [${i.lens}] ${i.title}`);
  console.log(`    ${i.url}`);
  if (i.teaser) console.log(`    ${i.teaser.slice(0, 200)}`);
  console.log("");
}
if (!fresh.length) console.log("Nothing new since the last scan.\n");

// Merge, keeping every item's ORIGINAL first_seen (mergeFeed's job), so a
// re-found article does not jump back to the top of the page.
const merged = mergeFeed([existing, fresh], { now, limit: OUTROSPECT_CAPS.items });

if (dryRun) {
  console.log("--dry: nothing written.");
  process.exit(0);
}

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(
  OUT,
  JSON.stringify(
    {
      generated: new Date(now).toISOString(),
      lenses: OUTROSPECT_LENSES.map((l) => l.id),
      // `fresh` is recomputed on read against the reader's clock, so it is not
      // stored — a committed `true` would go stale the moment it was written.
      items: merged.map(({ fresh: _fresh, ...rest }) => rest),
    },
    null,
    2,
  ) + "\n",
  "utf8",
);
console.log(`Wrote ${merged.length} items to ${OUT.replace(ROOT + "/", "")}`);
console.log("\n" + formatFeedText(merged.slice(0, 15), { title: "TOP OF FEED", now }));
